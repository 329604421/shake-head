/* v1.16 可观测 wx mock：storage + 可控「落地」+ 可控 url 形态
 *
 * 官方契约（apis-wx.md Router methods）：navigateTo / redirectTo 只承诺
 * "requests page navigation"，success 是**无条件回调**（语义＝请求已发出）。
 * 真机实证：回调了 nav:ok，屏幕却仍停在主页。
 *
 * 因此 mock 必须能独立模拟几件事，否则测不出问题：
 *   1) success 回调（永远调，模拟契约行为）；
 *   2) 页面是否**真的**落地（写 __navProbe='landed'）；
 *   3) 落地只对**特定 url 形态**生效（__LAND_URL）——宿主路由可能做精确
 *      字符串匹配，只认「带斜杠」或「带 query」中的一种；
 *   4) storage 完全不可用（__STO_BROKEN）——同步 storage 会 throw
 *      （apis-wx.md Storage methods · Error behavior），此时落地握手
 *      会失去证据，必须验证代码不会把"其实跳成功了"误判成 dead。
 *
 * 注意：真实 storage 走 JSON 序列化（官方原文 "serializes data through
 * JSON before storing it"），所以数字 1 存进去读出来仍是数字 1。
 * mock 必须同样做 JSON 往返，否则 storageOk() 探测会失真。 */
export const log = { calls: [] };
export const store = new Map();
const landCount = {};

function mkCtxProxy() {
  const noop = function () {};
  return new Proxy({}, {
    get(t, k) {
      if (k === 'measureText') return function () { return { width: 10 }; };
      if (k in t) return t[k];
      return noop;
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}

function maybeLand(api, url) {
  /* storage 不可用时探针写不进去 —— 正是真机假阴性的成因 */
  if (globalThis.__STO_BROKEN) return false;
  const want = globalThis.__LAND_URL;
  if (want) {
    if (url !== want) return false;
  } else {
    const on = globalThis.__LAND_ON || 'never';
    if (on !== api) return false;
    landCount[api] = (landCount[api] || 0) + 1;
    if (landCount[api] < (globalThis.__LAND_NTH || 1)) return false;
  }
  store.set('__navProbe', 'landed');
  return true;
}

const wx = {
  createCanvasContext() { return mkCtxProxy(); },
  navigateTo(o) {
    const url = o && o.url;
    log.calls.push({ api: 'navigateTo', url });
    maybeLand('navigateTo', url);
    if (o && o.success) o.success({});   /* 无条件回调，符合契约 */
    if (o && o.complete) o.complete({});
  },
  redirectTo(o) {
    const url = o && o.url;
    log.calls.push({ api: 'redirectTo', url });
    maybeLand('redirectTo', url);
    if (o && o.success) o.success({});
    if (o && o.complete) o.complete({});
  },
  /* v1.50：记录实参——调用形态（是否带 delta / 三回调）是「宿主请求型 API」
   * 的成败关键，只记 api 名不足以作证（见 harness-records D2）。 */
  navigateBack(o) { log.calls.push({ api: 'navigateBack', args: o }); },
  exitMiniProgram(o) {
    log.calls.push({ api: 'exitMiniProgram' });
    if (globalThis.__EXIT_MODE === 'ok') { if (o && o.success) o.success({}); if (o && o.complete) o.complete({}); }
    else if (globalThis.__EXIT_MODE === 'fail') { if (o && o.fail) o.fail({ errMsg: 'mock fail' }); if (o && o.complete) o.complete({}); }
    /* silent：不回调 */
  },
  setBackgroundColor() {},
  onKeyDown() {}, onKeyUp() {},
  getSystemInfoSync() { return { windowWidth: 480, windowHeight: 352 }; },
  getStorageSync(k) {
    if (globalThis.__STO_BROKEN) throw new Error('storage unavailable');
    return store.has(k) ? store.get(k) : undefined;
  },
  setStorageSync(k, v) {
    if (globalThis.__STO_BROKEN) throw new Error('storage unavailable');
    store.set(k, JSON.parse(JSON.stringify(v)));
  },
};

export default wx;
