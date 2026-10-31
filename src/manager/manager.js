import {
  STORAGE_KEY,
  EXPORTERS,
  exportFilename,
  formatTime,
  matchItem,
  relativeTime,
} from '../shared/model.js';

const $ = (id) => document.getElementById(id);
const els = {
  stat: $('stat'),
  q: $('q'),
  sort: $('sort'),
  list: $('list'),
  empty: $('empty'),
  more: $('more'),
  moreBtn: $('moreBtn'),
  tagbar: $('tagbar'),
  exportBtn: $('exportBtn'),
  exportPanel: $('exportPanel'),
  importBtn: $('importBtn'),
  file: $('file'),
  toast: $('toast'),
};

const state = {
  items: [],
  query: '',
  tag: '',
  sort: 'createdAt-desc',
  limit: 60,
};

/* --------------------------------- 基础设施 -------------------------------- */

function send(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        void chrome.runtime.lastError;
        resolve(res || null);
      });
    } catch {
      resolve(null);
    }
  });
}

let toastTimer = 0;
function toast(text) {
  els.toast.textContent = text;
  els.toast.dataset.show = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.dataset.show = '0';
  }, 2200);
}

async function loadItems() {
  const bag = await chrome.storage.local.get(STORAGE_KEY);
  const list = bag[STORAGE_KEY];
  state.items = Array.isArray(list) ? list : [];
}

/* --------------------------------- 数据操作 -------------------------------- */

async function updateItem(id, patch) {
  const res = await send({ type: 'bshc:update', id, patch });
  if (!res || !res.ok) {
    toast('保存失败：' + ((res && res.error) || '后台无响应'));
    return null;
  }
  const idx = state.items.findIndex((x) => x.id === id);
  if (idx >= 0) state.items[idx] = res.item;
  return res.item;
}

async function removeItem(id) {
  if (!window.confirm('删除这条收藏？此操作不可撤销。')) return;
  const res = await send({ type: 'bshc:remove', id });
  if (!res || !res.ok) {
    toast('删除失败：' + ((res && res.error) || '后台无响应'));
    return;
  }
  state.items = state.items.filter((x) => x.id !== id);
  render();
  toast('已删除');
}

/* --------------------------------- 筛选排序 -------------------------------- */

function visibleItems() {
  let list = state.items.filter((it) => matchItem(it, state.query));
  if (state.tag) list = list.filter((it) => (it.tags || []).includes(state.tag));

  const [field, dir] = state.sort.split('-');
  const sign = dir === 'asc' ? 1 : -1;
  list = list.slice().sort((a, b) => {
    if (field === 'like') return (a.like - b.like) * sign;
    if (field === 'source') return String(a.source?.title || '').localeCompare(String(b.source?.title || ''), 'zh');
    return (a.createdAt - b.createdAt) * sign;
  });
  return list;
}

/* ----------------------------------- 渲染 ---------------------------------- */

function renderStat() {
  const weekAgo = Date.now() - 7 * 864e5;
  const week = state.items.filter((x) => x.createdAt >= weekAgo).length;
  const tags = new Set();
  for (const it of state.items) for (const t of it.tags || []) tags.add(t);
  els.stat.textContent = `${state.items.length} 条收藏 · 近 7 天 +${week} · ${tags.size} 个标签`;
}

function renderTagbar() {
  const counts = new Map();
  for (const it of state.items) {
    for (const t of it.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
  }
  els.tagbar.textContent = '';
  if (!counts.size) return;

  const all = document.createElement('button');
  all.type = 'button';
  all.className = 'chip';
  all.dataset.active = state.tag ? '0' : '1';
  all.textContent = '全部';
  all.addEventListener('click', () => {
    state.tag = '';
    render();
  });
  els.tagbar.append(all);

  for (const [tag, n] of [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.dataset.active = state.tag === tag ? '1' : '0';
    chip.append(document.createTextNode(tag));
    const small = document.createElement('small');
    small.textContent = String(n);
    chip.append(small);
    chip.addEventListener('click', () => {
      state.tag = state.tag === tag ? '' : tag;
      render();
    });
    els.tagbar.append(chip);
  }
}

function renderTags(item, container) {
  container.textContent = '';

  for (const tag of item.tags || []) {
    const chip = document.createElement('span');
    chip.className = 'tag';
    chip.append(document.createTextNode(tag));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = '移除标签';
    remove.addEventListener('click', async () => {
      const next = (item.tags || []).filter((t) => t !== tag);
      const saved = await updateItem(item.id, { tags: next });
      if (saved) {
        item.tags = saved.tags;
        renderTags(item, container);
        renderTagbar();
      }
    });

    chip.append(remove);
    container.append(chip);
  }

  const input = document.createElement('input');
  input.className = 'tag-input';
  input.type = 'text';
  input.placeholder = '＋ 标签';
  input.addEventListener('keydown', async (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ',') return;
    ev.preventDefault();
    const value = input.value.trim().replace(/^#/, '');
    if (!value) return;
    if ((item.tags || []).includes(value)) {
      input.value = '';
      return;
    }
    input.value = '';
    const saved = await updateItem(item.id, { tags: [...(item.tags || []), value] });
    if (saved) {
      item.tags = saved.tags;
      renderTags(item, container);
      renderTagbar();
    }
  });
  input.addEventListener('blur', () => {
    if (input.value.trim()) input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
  });
  container.append(input);
}

function buildCard(item) {
  const card = document.createElement('article');
  card.className = 'card';

  /* 头部：作者 / 类型 / 时间 / 来源 */
  const head = document.createElement('div');
  head.className = 'card-head';

  const author = document.createElement('span');
  author.className = 'author';
  author.textContent = item.author?.name || '匿名用户';
  head.append(author);

  if (item.isReply) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = '楼中楼';
    head.append(badge);
  }

  const when = document.createElement('span');
  when.textContent = relativeTime(item.createdAt);
  when.title = formatTime(item.createdAt);
  head.append(when);

  if (item.source?.url) {
    const src = document.createElement('a');
    src.className = 'src';
    src.href = item.source.url;
    src.target = '_blank';
    src.rel = 'noreferrer';
    src.textContent = item.source.title || item.source.bvid || item.source.url;
    src.title = item.source.title || item.source.url;
    head.append(src);
  }

  card.append(head);

  /* 正文 */
  const text = document.createElement('p');
  text.className = 'text';
  text.textContent = item.text || '（正文为空）';
  text.title = '点击展开 / 收起';
  text.addEventListener('click', () => {
    text.dataset.open = text.dataset.open === '1' ? '0' : '1';
  });
  card.append(text);

  /* 标签 */
  const tags = document.createElement('div');
  tags.className = 'tags';
  renderTags(item, tags);
  card.append(tags);

  /* 备注 */
  const note = document.createElement('textarea');
  note.className = 'note';
  note.rows = 1;
  note.placeholder = '写点备注，自动保存…';
  note.value = item.note || '';

  let noteTimer = 0;
  note.addEventListener('input', () => {
    clearTimeout(noteTimer);
    noteTimer = setTimeout(async () => {
      const value = note.value;
      if (value === (item.note || '')) return;
      const saved = await updateItem(item.id, { note: value });
      if (saved) item.note = saved.note;
    }, 600);
  });
  card.append(note);

  /* 操作 */
  const actions = document.createElement('div');
  actions.className = 'actions';

  const jump = document.createElement('button');
  jump.type = 'button';
  jump.textContent = '跳回原楼层';
  jump.disabled = !item.jumpUrl;
  jump.addEventListener('click', () => {
    if (item.jumpUrl) chrome.tabs.create({ url: item.jumpUrl });
  });
  actions.append(jump);

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = '复制正文';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(item.text || '');
      toast('正文已复制');
    } catch {
      toast('复制失败，浏览器拒绝了剪贴板写入');
    }
  });
  actions.append(copy);

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'danger';
  del.textContent = '删除';
  del.addEventListener('click', () => removeItem(item.id));
  actions.append(del);

  const like = document.createElement('span');
  like.className = 'like';
  like.textContent = item.like ? `赞 ${item.like}` : '';
  actions.append(like);

  card.append(actions);
  return card;
}

function render() {
  const list = visibleItems();

  els.list.textContent = '';
  for (const item of list.slice(0, state.limit)) {
    els.list.append(buildCard(item));
  }

  els.empty.hidden = list.length > 0;
  els.more.hidden = list.length <= state.limit;

  renderStat();
  renderTagbar();
}

/* ----------------------------------- 导出 ---------------------------------- */

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function doExport(format) {
  const exporter = EXPORTERS[format];
  if (!exporter) return;
  // 导出的就是当前筛选结果，所见即所得。
  const list = visibleItems();
  if (!list.length) {
    toast('当前没有可导出的收藏');
    return;
  }
  download(exportFilename(format, list.length), exporter.build(list), exporter.mime);
  toast(`已导出 ${list.length} 条为 ${exporter.label}`);
}

/* ----------------------------------- 导入 ---------------------------------- */

async function doImport(file) {
  let payload;
  try {
    const text = await file.text();
    payload = JSON.parse(text);
  } catch {
    toast('不是有效的 JSON 文件');
    return;
  }
  const res = await send({ type: 'bshc:import', payload });
  if (!res || !res.ok) {
    toast('导入失败：' + ((res && res.error) || '后台无响应'));
    return;
  }
  await loadItems();
  render();
  toast(`导入完成：新增 ${res.added} 条，跳过 ${res.skipped} 条`);
}

/* --------------------------------- 事件绑定 -------------------------------- */

function bindEvents() {
  let searchTimer = 0;
  els.q.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = els.q.value.trim();
      state.limit = 60;
      render();
    }, 140);
  });

  els.sort.addEventListener('change', () => {
    state.sort = els.sort.value;
    render();
  });

  els.exportBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const open = els.exportPanel.hidden;
    els.exportPanel.hidden = !open;
    els.exportBtn.setAttribute('aria-expanded', String(open));
  });

  els.exportPanel.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-format]');
    if (!btn) return;
    els.exportPanel.hidden = true;
    els.exportBtn.setAttribute('aria-expanded', 'false');
    doExport(btn.dataset.format);
  });

  document.addEventListener('click', () => {
    if (!els.exportPanel.hidden) {
      els.exportPanel.hidden = true;
      els.exportBtn.setAttribute('aria-expanded', 'false');
    }
  });

  els.importBtn.addEventListener('click', () => els.file.click());
  els.file.addEventListener('change', async () => {
    const file = els.file.files && els.file.files[0];
    els.file.value = '';
    if (file) await doImport(file);
  });

  els.moreBtn.addEventListener('click', () => {
    state.limit += 60;
    render();
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === '/' && document.activeElement !== els.q) {
      ev.preventDefault();
      els.q.focus();
    }
    if (ev.key === 'Escape' && document.activeElement === els.q) {
      els.q.value = '';
      state.query = '';
      render();
      els.q.blur();
    }
  });
}

/* ---------------------------------- 启动 ---------------------------------- */

async function boot() {
  const params = new URLSearchParams(location.search);
  const q = params.get('q') || '';
  els.q.value = q;
  state.query = q.trim();

  await loadItems();
  render();
  bindEvents();

  // 其他标签页收藏了新评论时同步刷新。
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (!Object.keys(changes).some((k) => k.startsWith('bshc:'))) return;
    loadItems().then(render);
  });
}

boot();
