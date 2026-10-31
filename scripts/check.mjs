/**
 * 仓库自检：CI 和本地 `npm run check` 都会跑。
 *   1. manifest.json 能解析，且 version 与 package.json 一致
 *   2. manifest 引用的每个文件都真实存在
 *   3. src/ 下所有 JS 语法可解析
 *   4. 图标尺寸与声明相符
 */
import { execFile } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
const ok = (msg) => console.log(`  \u2713 ${msg}`);
const bad = (msg) => {
  failed++;
  console.error(`  \u2717 ${msg}`);
};

async function exists(rel) {
  try {
    await stat(path.join(root, rel));
    return true;
  } catch {
    return false;
  }
}

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/** 读 PNG 头，拿到宽高，确认图标不是占位空文件。 */
async function pngSize(file) {
  const buf = await readFile(path.join(root, file));
  if (buf.length < 24) return null;
  const isPng = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (!isPng) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

console.log('\n1. manifest 与版本');
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (manifest.manifest_version === 3) ok('manifest_version = 3');
else bad(`manifest_version 应为 3，实际 ${manifest.manifest_version}`);

if (manifest.version === pkg.version) ok(`版本一致：${manifest.version}`);
else bad(`manifest.version (${manifest.version}) 与 package.json (${pkg.version}) 不一致`);

for (const key of ['name', 'version', 'description', 'action', 'background', 'content_scripts']) {
  if (manifest[key]) ok(`包含 ${key}`);
  else bad(`缺少 ${key}`);
}

console.log('\n2. manifest 引用的文件');
const refs = [
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action?.default_icon || {}),
  manifest.action?.default_popup,
  manifest.options_page,
  manifest.background?.service_worker,
  ...manifest.content_scripts.flatMap((cs) => [...(cs.js || []), ...(cs.css || [])]),
].filter(Boolean);

for (const ref of [...new Set(refs)]) {
  if (await exists(ref)) ok(ref);
  else bad(`引用的文件不存在：${ref}`);
}

console.log('\n3. 图标尺寸');
for (const [declared, file] of Object.entries(manifest.icons || {})) {
  const size = await pngSize(file);
  if (!size) {
    bad(`${file} 不是有效 PNG`);
  } else if (size.w !== Number(declared)) {
    bad(`${file} 声明 ${declared}px，实际 ${size.w}x${size.h}`);
  } else {
    ok(`${file} ${size.w}x${size.h}`);
  }
}

console.log('\n4. 双浏览器兼容');
const bg = manifest.background || {};
if (bg.service_worker) ok('Chrome 入口：background.service_worker');
else bad('缺少 background.service_worker（Chrome 需要）');
if (Array.isArray(bg.scripts) && bg.scripts.length) ok('Firefox 入口：background.scripts');
else bad('缺少 background.scripts（Firefox 不支持 service_worker）');
if (bg.service_worker && Array.isArray(bg.scripts) && bg.scripts[0] !== bg.service_worker) {
  bad('background.scripts 与 service_worker 指向了不同文件');
}
// MV3 里同时写 background.scripts，Chrome 121 之前会直接拒绝加载
const minChrome = Number(manifest.minimum_chrome_version || 0);
if (minChrome >= 121) ok(`minimum_chrome_version = ${minChrome}（≥121 才会忽略 background.scripts）`);
else bad(`minimum_chrome_version 应 ≥121，当前 ${manifest.minimum_chrome_version || '未设置'}`);

const gecko = manifest.browser_specific_settings?.gecko || {};
if (gecko.id) ok(`Firefox 扩展 ID：${gecko.id}`);
else bad('缺少 browser_specific_settings.gecko.id（Firefox 安装/签名需要）');

// AMO 自 2025-11-03 起强制要求声明数据收集类型，缺了会直接校验失败
const dcp = gecko.data_collection_permissions;
if (dcp && Array.isArray(dcp.required) && dcp.required.length) {
  ok(`数据收集声明：required = [${dcp.required.join(', ')}]`);
} else {
  bad('缺少 browser_specific_settings.gecko.data_collection_permissions.required（AMO 会拒绝）');
}
if (Number(gecko.strict_min_version) < 140 && dcp) {
  bad(`data_collection_permissions 需要 Firefox 140+，当前 strict_min_version = ${gecko.strict_min_version}`);
}

const mainWorld = manifest.content_scripts.filter((cs) => cs.world === 'MAIN');
if (mainWorld.length) ok(`${mainWorld.length} 段 content script 声明了 world: MAIN`);
else bad('没有 world: MAIN 的 content script，bridge.js 将无法读取页面对象');

console.log('\n5. JS 语法');
const files = await walk(path.join(root, 'src'));
files.push(path.join(root, 'scripts', 'check.mjs'));
for (const file of files) {
  const rel = path.relative(root, file);
  try {
    await run(process.execPath, ['--check', file]);
    ok(rel);
  } catch (err) {
    bad(`${rel} 语法错误：${String(err.stderr || err.message).split('\n')[0]}`);
  }
}

console.log(failed ? `\n\u2717 ${failed} 项检查未通过\n` : '\n\u2713 全部检查通过\n');
process.exit(failed ? 1 : 0);
