/**
 * MAIN world 桥接层。
 *
 * 为什么需要这一层：评论组件把原始评论对象挂在元素上（`bili-comment-renderer.data`），
 * 但那是页面 JS 上下文里的属性，隔离世界（普通 content script）读不到。
 * DOM 属性（attribute）是两个世界共享的，所以这里把真正需要的一小撮字段
 * 序列化成 JSON，写到元素的 `data-bshc` 上，由 content.js 去读。
 *
 * 本文件不申请任何权限，也不改页面逻辑，只写一个 data-* 属性。
 */
(() => {
  'use strict';

  const ATTR = 'data-bshc';
  const HOST_TAG = 'bili-comments';
  const TICK_MS = 800;
  const FULL_REFRESH_EVERY = 8; // 约每 6.4s 全量刷新一次，顺带更新点赞数

  let tickCount = 0;

  /** 从组件实例上摘出我们要的字段，字段缺失一律降级为安全默认值。 */
  function pick(el) {
    let d;
    try {
      d = el.data;
    } catch {
      return null;
    }
    if (!d || d.rpid == null) return null;

    const member = d.member || {};
    const content = d.content || {};
    const text = String(content.message ?? '');

    return {
      rpid: String(d.rpid),
      oid: String(d.oid ?? ''),
      type: Number(d.type) || 1,
      root: String(d.root ?? '0'),
      parent: String(d.parent ?? '0'),
      ctime: Number(d.ctime) || 0,
      like: Number(d.like) || 0,
      text: text.length > 2000 ? text.slice(0, 2000) : text,
      uname: String(member.uname ?? ''),
      mid: String(member.mid ?? d.mid ?? ''),
      avatar: String(member.avatar ?? ''),
    };
  }

  function stamp(el, force) {
    const payload = pick(el);
    if (!payload) return false;
    const json = JSON.stringify(payload);
    if (!force && el.getAttribute(ATTR) === json) return true;
    try {
      el.setAttribute(ATTR, json);
    } catch {
      return false;
    }
    return true;
  }

  /** 枚举当前页面上所有评论节点（主评论 + 楼中楼）。 */
  function collect() {
    const out = [];
    const host = document.querySelector(HOST_TAG);
    const root = host && host.shadowRoot;
    if (!root) return out;

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

  function tick(force) {
    tickCount++;
    const full = force || tickCount % FULL_REFRESH_EVERY === 0;
    for (const el of collect()) stamp(el, full);
  }

  // 隔离世界在点击收藏等时机派发这个事件，要求立刻刷新一次，避免读到旧数据。
  document.addEventListener('bshc:refresh', () => tick(true), true);

  const start = () => {
    tick(true);
    setInterval(() => {
      if (document.hidden) return;
      tick(false);
    }, TICK_MS);
  };

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    start();
  } else {
    window.addEventListener('DOMContentLoaded', start, { once: true });
  }

  // 诊断用：在控制台执行 __BSHC_DUMP__() 可看到当前抓到的评论。
  window.__BSHC_DUMP__ = () => collect().map((el) => pick(el)).filter(Boolean);
  window.__BSHC_BRIDGE__ = true;
})();
