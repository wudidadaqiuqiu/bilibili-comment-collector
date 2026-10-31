/**
 * Service worker：收藏数据的唯一写入方。
 * 所有变更串行排队，避免多标签页同时收藏时互相覆盖（storage 读改写竞态）。
 */
import { STORAGE_KEY, makeId, normalizeItem } from './shared/model.js';

/* ------------------------------- 串行写入队列 ------------------------------- */

let queue = Promise.resolve();

function mutate(fn) {
  const run = queue.then(fn, fn);
  // 上一个任务失败不应阻塞后续任务。
  queue = run.catch(() => {});
  return run;
}

async function readAll() {
  const bag = await chrome.storage.local.get(STORAGE_KEY);
  const list = bag[STORAGE_KEY];
  return Array.isArray(list) ? list : [];
}

async function writeAll(items) {
  await chrome.storage.local.set({ [STORAGE_KEY]: items });
}

/* --------------------------------- 角标 --------------------------------- */

let badgeTimer = null;

function scheduleBadge() {
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(async () => {
    const items = await readAll();
    const text = items.length ? (items.length > 999 ? '999+' : String(items.length)) : '';
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color: '#FB7299' });
  }, 120);
}

/* -------------------------------- 操作实现 -------------------------------- */

async function addItem(raw) {
  const item = normalizeItem(raw);
  if (!item) return { ok: false, error: '数据不完整，缺少评论 rpid' };

  return mutate(async () => {
    const items = await readAll();
    const exist = items.find((x) => x.id === item.id);
    if (exist) return { ok: true, duplicated: true, item: exist, count: items.length };
    items.unshift(item);
    await writeAll(items);
    return { ok: true, duplicated: false, item, count: items.length };
  });
}

async function removeItem(id) {
  return mutate(async () => {
    const items = await readAll();
    const next = items.filter((x) => x.id !== id);
    await writeAll(next);
    return { ok: true, removed: items.length - next.length, count: next.length };
  });
}

async function updateItem(id, patch) {
  return mutate(async () => {
    const items = await readAll();
    const idx = items.findIndex((x) => x.id === id);
    if (idx < 0) return { ok: false, error: '未找到该收藏' };
    const base = items[idx];
    const next = normalizeItem({
      ...base,
      ...patch,
      // 结构字段不允许被 patch 改坏。
      rpid: base.rpid,
      oid: base.oid,
      type: base.type,
      root: base.root,
      parent: base.parent,
      id: base.id,
      jumpUrl: base.jumpUrl,
      source: base.source,
      createdAt: base.createdAt,
    });
    items[idx] = next;
    await writeAll(items);
    return { ok: true, item: next };
  });
}

async function importItems(payload) {
  const list = Array.isArray(payload) ? payload : payload && Array.isArray(payload.items) ? payload.items : null;
  if (!list) return { ok: false, error: '导入内容不是有效的收藏数据' };

  return mutate(async () => {
    const items = await readAll();
    const seen = new Set(items.map((x) => x.id));
    let added = 0;
    let skipped = 0;
    for (const raw of list) {
      const item = normalizeItem(raw);
      if (!item || seen.has(item.id)) {
        skipped++;
        continue;
      }
      seen.add(item.id);
      items.push(item);
      added++;
    }
    items.sort((a, b) => b.createdAt - a.createdAt);
    await writeAll(items);
    return { ok: true, added, skipped, count: items.length };
  });
}

async function listIds() {
  const items = await readAll();
  return { ids: items.map((x) => x.id) };
}

/* -------------------------------- 消息路由 -------------------------------- */

const handlers = {
  'bshc:add': (msg) => addItem(msg.item),
  'bshc:remove': (msg) => removeItem(msg.id),
  'bshc:update': (msg) => updateItem(msg.id, msg.patch || {}),
  'bshc:import': (msg) => importItems(msg.payload),
  'bshc:listIds': () => listIds(),
  'bshc:count': async () => ({ count: (await readAll()).length }),
  'bshc:openManager': async () => {
    await chrome.tabs.create({ url: chrome.runtime.getURL('src/manager/manager.html') });
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const key = msg && msg.type;
  const handler = handlers[key];
  if (!handler) return false;

  Promise.resolve()
    .then(() => handler(msg))
    .then((res) => {
      if (key !== 'bshc:listIds' && key !== 'bshc:count') scheduleBadge();
      sendResponse(res);
    })
    .catch((err) => {
      console.error('[B站评论收藏夹]', key, err);
      sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
    });

  return true; // 异步 sendResponse
});

chrome.runtime.onInstalled.addListener(() => {
  scheduleBadge();
});

// SW 被回收后重新启动时补一次角标。
scheduleBadge();

// 供调试：确认 id 规则一致。
export { makeId };
