/**
 * 打包脚本（零依赖，CI 和本地都用同一份）。
 *
 *   node scripts/build.mjs
 *
 * 产出两个包到 dist/：
 *   1. bilibili-comment-collector-<version>.zip
 *      通用包，Chrome / Edge 用。manifest 同时带 service_worker 与 scripts。
 *   2. bilibili-comment-collector-<version>-firefox.xpi
 *      AMO 上传用。去掉 Chrome 专用字段（background.service_worker、
 *      minimum_chrome_version），避免 AMO 校验器报 warning/error。
 */
import { deflateRawSync } from 'node:zlib';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'dist');

/* --------------------------------- 收集文件 -------------------------------- */

async function walk(dir, base = '') {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, rel)));
    else if (!entry.name.endsWith('.zip') && !entry.name.endsWith('.xpi')) out.push(rel);
  }
  return out;
}

/* --------------------------------- CRC32 --------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ------------------------- 最小 zip writer（deflate） ------------------------ */

function dosDateTime(date = new Date()) {
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() / 2)) & 0xffff;
  const day = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  return { time, day };
}

function makeZip(entries) {
  const { time, day } = dosDateTime();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // local file header signature
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0x0800, 6);       // flags: UTF-8 文件名
    local.writeUInt16LE(8, 8);            // method: deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory signature
    central.writeUInt16LE(0x0314, 4);     // version made by (unix, 2.0)
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);         // extra length
    central.writeUInt16LE(0, 32);         // comment length
    central.writeUInt16LE(0, 34);         // disk start
    central.writeUInt16LE(0, 36);         // internal attrs
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attrs: 普通文件
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, ...centrals, eocd]);
}

/* ---------------------------------- 主流程 --------------------------------- */

const manifestRaw = await readFile(path.join(root, 'manifest.json'), 'utf8');
const manifest = JSON.parse(manifestRaw);
const version = manifest.version;

const files = ['manifest.json', ...(await walk(path.join(root, 'src'), 'src')), 'LICENSE', 'README.md'];

const readAll = async (list) =>
  Promise.all(list.map(async (rel) => ({ name: rel, data: await readFile(path.join(root, rel)) })));

await mkdir(distDir, { recursive: true });

// 1. 通用包（Chrome / Edge）
const universal = await readAll(files);
const zipPath = path.join(distDir, `bilibili-comment-collector-${version}.zip`);
await writeFile(zipPath, makeZip(universal));
console.log(`✓ ${path.relative(root, zipPath)}  (${universal.length} 个文件)`);

// 2. Firefox / AMO 包：剥掉 Chrome 专用字段
const ffManifest = structuredClone(manifest);
delete ffManifest.minimum_chrome_version;
if (ffManifest.background) delete ffManifest.background.service_worker;

const ffFiles = [
  { name: 'manifest.json', data: Buffer.from(JSON.stringify(ffManifest, null, 2) + '\n', 'utf8') },
  ...universal.filter((f) => f.name !== 'manifest.json'),
];
const xpiPath = path.join(distDir, `bilibili-comment-collector-${version}-firefox.xpi`);
await writeFile(xpiPath, makeZip(ffFiles));
console.log(`✓ ${path.relative(root, xpiPath)}  (${ffFiles.length} 个文件，已移除 Chrome 专用字段)`);
