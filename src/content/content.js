/**
 * 隔离世界的 UI 层：
 *  - 在每条评论的操作栏里插一个「收藏」按钮（含楼中楼）
 *  - 点击后把评论存进本地（经 background 串行写入）
 *  - 通过 #reply<rpid> 深链回到页面时高亮并滚动到目标楼层
 *
 * 评论数据来自 bridge.js 写在元素上的 data-bshc 属性（见该文件注释）。
 */
(() => {
  'use strict';

  const ATTR = 'data-bshc';
  const BTN = 'bshc-save';
  const OPEN = 'bshc-open';
  const TICK_MS = 900;

  const SHADOW_CSS = `
    .${BTN}, .${OPEN} {
      all: unset;
      box-sizing: border-box;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 7px;
      border-radius: 5px;
      cursor: pointer;
      font-size: 12px;
      line-height: 18px;
      font-family: inherit;
      color: var(--text3, #9499a0);
      transition: color .15s ease, background-color .15s ease;
      vertical-align: middle;
      white-space: nowrap;
    }
    .${BTN} { margin-left: 6px; }
    .${BTN}:hover, .${OPEN}:hover { color: #fb7299; background: rgba(251, 114, 153, .12); }
    .${BTN}[data-saved="1"] { color: #fb7299; font-weight: 600; }
    .${BTN}[data-busy="1"] { opacity: .55; pointer-events: none; }
    .${BTN} .bshc-ico, .${OPEN} .bshc-ico { font-size: 13px; line-height: 1; }
    .${OPEN} { margin-left: 10px; }
  `;

  /* ------------------------------- 样式注入 ------------------------------- */

  let sheet;
  let sheetTried = false;

  function getSheet() {
    if (sheetTried) return sheet;
    sheetTried = true;
    try {
      sheet = new CSSStyleSheet();
      sheet.replaceSync(SHADOW_CSS);
    } catch {
      sheet = null;
    }
    return sheet;
  }

  /** shadow root 内的样式不会继承页面 CSS，构造式样式表可复用到所有 shadow root。 */
  function applyStyle(root) {
    const s = getSheet();
    if (s) {
      if (!root.adoptedStyleSheets.includes(s)) {
        try {
          root.adoptedStyleSheets = [...root.adoptedStyleSheets, s];
        } catch {
          /* 个别环境下不可写，降级到 <style> */
          injectStyleTag(root);
        }
      }
      return true;
    }
    injectStyleTag(root);
    return true;
  }

  function injectStyleTag(root) {
    if (root.querySelector('style[data-bshc]')) return;
    const tag = document.createElement('style');
    tag.setAttribute('data-bshc', '1');
    tag.textContent = SHADOW_CSS;
    root.appendChild(tag);
  }

  /* -------------------------------- 基础设施 ------------------------------- */

  const saved = new Set();
  let ready = false;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  function idOf(p) {
    return `${p.type}:${p.oid}:${p.rpid}`;
  }

  function payloadOf(el) {
    const raw = el.getAttribute(ATTR);
    if (!raw) return null;
    try {
      const p = JSON.parse(raw);
      return p && p.rpid ? p : null;
    } catch {
      return null;
    }
  }

  /* --------------------------------- 吐司 --------------------------------- */

  let toastEl = null;
  let toastTimer = 0;

  function toast(msg) {
    if (!document.body) return;
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'bshc-toast';
      toastEl.setAttribute('role', 'status');
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add('bshc-toast--show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('bshc-toast--show'), 2400);
  }

  /* -------------------------------- 页面信息 ------------------------------- */

  let pageCache = null;
  let pageCacheHref = '';

  function pageInfo() {
    if (pageCache && pageCacheHref === location.href) return pageCache;

    const host = document.querySelector('bili-comments');
    const params = (host && host.getAttribute('data-params')) || '';
    const [typeRaw, oidRaw] = params.split(',');

    const h1 = document.querySelector('h1.video-title, h1');
    const docTitle = (document.title || '').replace(/_哔哩哔哩.*$/, '');
    const title = ((h1 && h1.textContent) || docTitle || '').trim().slice(0, 300);
    const bvidMatch = location.pathname.match(/\/video\/(BV[0-9A-Za-z]{10})/);

    pageCache = {
      type: Number(typeRaw) || 1,
      oid: String(oidRaw || '').trim(),
      url: location.origin + location.pathname,
      title,
      bvid: bvidMatch ? bvidMatch[1] : '',
      kind: bvidMatch ? 'video' : location.hostname.startsWith('t.') ? 'dynamic' : 'page',
    };
    pageCacheHref = location.href;
    return pageCache;
  }

  function buildItem(p) {
    const source = pageInfo();
    const jumpUrl = source.url ? `${source.url}#reply${p.rpid}` : '';
    return {
      rpid: p.rpid,
      oid: p.oid || source.oid,
      type: p.type || source.type,
      root: p.root,
      parent: p.parent,
      text: String(p.text || '').trim(),
      author: { mid: p.mid || '', name: p.uname || '', avatar: p.avatar || '' },
      ctime: p.ctime || 0,
      like: p.like || 0,
      source,
      jumpUrl,
      tags: [],
      note: '',
      createdAt: Date.now(),
    };
  }

  /* -------------------------------- 按钮注入 ------------------------------- */

  function collect() {
    const host = document.querySelector('bili-comments');
    const root = host && host.shadowRoot;
    if (!root) return [];

    const out = [];
    for (const thread of root.querySelectorAll('bili-comment-thread-renderer')) {
      const tsr = thread.shadowRoot;
      if (!tsr) continue;

      const main = tsr.querySelector('bili-comment-renderer');
      if (main) out.push(main);

      const replies = tsr.querySelector('bili-comment-replies-renderer');
      if (replies && replies.shadowRoot) {
        for (const reply of replies.shadowRoot.querySelectorAll('bili-comment-reply-renderer')) {
          out.push(reply);
        }
      }
    }
    return out;
  }

  function syncButton(btn, el) {
    const p = payloadOf(el);
    const on = !!(p && saved.has(idOf(p)));
    const want = on ? '1' : '0';
    if (btn.dataset.saved === want) return;
    btn.dataset.saved = want;
    const ico = btn.querySelector('.bshc-ico');
    const lbl = btn.querySelector('.bshc-lbl');
    if (ico) ico.textContent = on ? '★' : '☆';
    if (lbl) lbl.textContent = on ? '已收藏' : '收藏';
  }

  function onSaveClick(el, btn) {
    return async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (btn.dataset.busy === '1') return;
      btn.dataset.busy = '1';
      try {
        // 让桥接层立刻刷新一次，避免读到刚进页面时的旧快照。
        document.dispatchEvent(new CustomEvent('bshc:refresh'));
        await sleep(80);

        const p = payloadOf(el);
        if (!p) {
          toast('这条评论还没加载完，稍后再点一次');
          return;
        }
        const id = idOf(p);
        if (saved.has(id)) {
          toast('已经在收藏夹里了');
          return;
        }

        const res = await send({ type: 'bshc:add', item: buildItem(p) });
        if (res && res.ok) {
          saved.add(id);
          syncButton(btn, el);
          toast(res.duplicated ? '这条评论已经收藏过了' : '已收藏 ✓ 点工具栏图标查看');
        } else if (res === null) {
          toast('后台没有响应，请刷新页面后再试');
        } else {
          toast('收藏失败：' + (res.error || '未知错误'));
        }
      } finally {
        btn.dataset.busy = '0';
      }
    };
  }

  function decorate(el) {
    const sr = el.shadowRoot;
    if (!sr) return;
    const bar = sr.querySelector('bili-comment-action-buttons-renderer');
    const barRoot = bar && bar.shadowRoot;
    if (!barRoot) return;

    applyStyle(barRoot);

    let btn = barRoot.querySelector('.' + BTN);
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = BTN;
      btn.dataset.saved = '0';
      btn.innerHTML = '<span class="bshc-ico">☆</span><span class="bshc-lbl">收藏</span>';
      btn.title = '收藏这条评论（只保存在本地）';
      btn.addEventListener('click', onSaveClick(el, btn));

      const more = barRoot.querySelector('#more');
      if (more && more.parentNode) more.parentNode.insertBefore(btn, more);
      else barRoot.appendChild(btn);
    }
    syncButton(btn, el);
  }

  /** 评论区标题旁加一个入口，免得每次去点工具栏。 */
  function decorateHeader() {
    const host = document.querySelector('bili-comments');
    const root = host && host.shadowRoot;
    const header = root && root.querySelector('bili-comments-header-renderer');
    const hs = header && header.shadowRoot;
    if (!hs) return;
    if (hs.querySelector('.' + OPEN)) return;

    const title = hs.querySelector('#title');
    if (!title) return;

    applyStyle(hs);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = OPEN;
    btn.innerHTML = '<span class="bshc-ico">★</span><span>我的评论收藏</span>';
    btn.title = '打开评论收藏夹';
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      send({ type: 'bshc:openManager' });
    });
    title.insertAdjacentElement('afterend', btn);
  }

  /* ------------------------------- 深链定位 -------------------------------- */

  let locatedRpid = '';

  function locateFromHash() {
    const m = location.hash.match(/^#reply(\d+)/);
    if (!m) {
      locatedRpid = '';
      return;
    }
    const want = m[1];
    if (locatedRpid === want) return;

    for (const el of collect()) {
      const p = payloadOf(el);
      if (!p || p.rpid !== want) continue;
      locatedRpid = want;
      markLocated(el);
      return;
    }
  }

  function markLocated(el) {
    el.style.borderLeft = '3px solid #FB7299';
    el.style.paddingLeft = '8px';
    el.style.borderRadius = '4px';
    el.style.background = 'rgba(251, 114, 153, .07)';
    try {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch {
      el.scrollIntoView();
    }
    toast('已定位到你收藏的那条评论');
  }

  /* --------------------------------- 主循环 -------------------------------- */

  function tick() {
    if (document.hidden) return;
    const host = document.querySelector('bili-comments');
    if (!host || !host.shadowRoot) return;

    for (const el of collect()) decorate(el);
    decorateHeader();
    if (ready) locateFromHash();
  }

  async function loadSaved() {
    const res = await send({ type: 'bshc:listIds' });
    saved.clear();
    for (const id of (res && res.ids) || []) saved.add(id);
    ready = true;
  }

  async function boot() {
    await loadSaved();
    tick();
    setInterval(tick, TICK_MS);

    // 在别处（收藏夹页面）删除或修改后，页面上的按钮状态同步更新。
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        const touched = Object.keys(changes).some((k) => k.startsWith('bshc:'));
        if (!touched) return;
        loadSaved().then(tick);
      });
    } catch {
      /* 忽略 */
    }

    window.addEventListener('hashchange', () => tick(), false);
  }

  boot();
})();
