/**
 * 跨浏览器兼容层。
 *
 * Chrome 的 `chrome.*` 支持 Promise；Firefox 里 `chrome.*` 命名空间在部分版本
 * 只支持回调（只有 `browser.*` 保证有 Promise）。这里把 storage 的读写统一成
 * Promise，并且两种形式都兜住，避免在 Firefox 上 `await chrome.storage.local.get()`
 * 拿到 undefined 后静默失败。
 */

/** 回调 + Promise 双兼容的通用包装。 */
function callWithCallback(invoke) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      // 先走回调形式：Chrome 与 Firefox 都支持。
      const ret = invoke(done);
      // Chrome 在同时传回调时返回 Promise（MV3），也接一下以防回调不被调用。
      if (ret && typeof ret.then === 'function') {
        ret.then(done, () => done(undefined));
      }
      // 兜底：极端环境下回调一直不触发。
      setTimeout(() => done(undefined), 4000);
    } catch {
      try {
        const ret = invoke(undefined);
        ret && typeof ret.then === 'function' ? ret.then(done, () => done(undefined)) : done(undefined);
      } catch {
        done(undefined);
      }
    }
  });
}

export function storageGet(keys) {
  return callWithCallback((cb) => chrome.storage.local.get(keys, cb)).then((res) => res || {});
}

export function storageSet(items) {
  return callWithCallback((cb) => chrome.storage.local.set(items, cb)).then(() => true);
}
