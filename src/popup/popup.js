import { STORAGE_KEY, relativeTime } from '../shared/model.js';

const MANAGER_URL = chrome.runtime.getURL('src/manager/manager.html');

const $count = document.getElementById('count');
const $recent = document.getElementById('recent');
const $empty = document.getElementById('empty');
const $q = document.getElementById('q');
const $open = document.getElementById('open');

function openManager(query) {
  const url = query ? `${MANAGER_URL}?q=${encodeURIComponent(query)}` : MANAGER_URL;
  chrome.tabs.create({ url });
  window.close();
}

async function loadItems() {
  const bag = await chrome.storage.local.get(STORAGE_KEY);
  const items = bag[STORAGE_KEY];
  return Array.isArray(items) ? items : [];
}

function renderRecent(items) {
  $recent.textContent = '';
  const top = items.slice(0, 6);

  for (const item of top) {
    const li = document.createElement('li');
    li.title = '点击跳回原楼层';

    const meta = document.createElement('div');
    meta.className = 'meta';

    const author = document.createElement('span');
    author.className = 'author';
    author.textContent = item.author?.name || '匿名';

    const time = document.createElement('span');
    time.textContent = relativeTime(item.createdAt);

    meta.append(author, time);

    const text = document.createElement('div');
    text.className = 'text';
    text.textContent = item.text || '（无正文）';

    const src = document.createElement('div');
    src.className = 'src';
    src.textContent = item.source?.title || item.source?.bvid || item.source?.url || '';

    li.append(meta, text, src);
    li.addEventListener('click', () => {
      if (!item.jumpUrl) return;
      chrome.tabs.create({ url: item.jumpUrl });
      window.close();
    });
    $recent.append(li);
  }
}

async function boot() {
  const items = await loadItems();
  $count.textContent = String(items.length);
  $empty.hidden = items.length > 0;
  renderRecent(items);

  $open.addEventListener('click', () => openManager(''));

  $q.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    openManager($q.value.trim());
  });
}

boot();
