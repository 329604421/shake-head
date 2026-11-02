/* 本地实证 v1.16 · storage 完全不可用场景（**必须独立进程跑**）
 *
 * 官方契约（apis-wx.md Storage methods · Error behavior）原文：
 *   "Sync storage methods throw when storage support is unavailable
 *    in the current context."
 *
 * 而 utils/storage.js 的 safeGet / safeSet 为「绝不强崩」（NFR-06）把异常
 * 全部 try/catch 吞掉，于是出现**静默假阴性**：storage 不可用时写入无效、
 * 读取恒为 fallback，落地握手永远判定"未跳转"——即使页面真的跳过去了，
 * 也会被误报成 nav:dead，把排查引向完全错误的方向。
 *
 * 本脚本验证三件事：
 *   1) storage 不可用时代码不崩溃（safeGet/safeSet 静默兜底）；
 *   2) 档位顺序自动切到「query 优先」，否则 gameId 会丢失；
 *   3) nav:dead 诊断带上 sto:no，让真机能区分「没跳」与「跳了但没证据」。
 *
 * ⚠️ storageOk() 会缓存探测结果，因此 __STO_BROKEN 必须在 import 页面模块
 *    **之前**置位，且不能与主 harness 共用进程——故独立成文件。
 *
 * 运行：node build.mjs && node harness-nosto.mjs */
globalThis.__STO_BROKEN = true;

const { buildItems } = await import('./utils/ring.js');
const { RING_ORDER, A6_MIN_MS } = await import('./utils/layout.js');
const { getEntry } = await import('./utils/games.js');
const { storageOk, armNavProbe, navLanded } = await import('./utils/storage.js');
const wxm = await import('./wx-mock.mjs');
const { default: page } = await import('./pages/index/index.mjs');

const log = wxm.log;
const S = { IDLE: 'IDLE', SELECT: 'SELECT', EXIT: 'EXIT', LAUNCH: 'LAUNCH' };

/* 假时钟：落地探测与换档都依赖时间推进（NAV_PROBE_MS = 500） */
let NOW = 1000000;
Date.now = function () { return NOW; };
function advance(ms) { NOW += ms; page._last = NOW; }

function ctxProxy() {
  const noop = function () {};
  return new Proxy({}, {
    get(t, k) {
      if (k === 'measureText') return function () { return { width: 10 }; };
      return k in t ? t[k] : noop;
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}
const engineStub = {
  imuOk: true, running: true,
  update() { return { x: 0, y: 0 }; },
  snapshot() { return { x: 0, y: 0 }; },
  freezeDrift() {}, recenter() {}, stop() {}, start() {}, resetBase() {},
};
const gestureStub = { tick() {}, onKeyDown() {}, onKeyUp() {}, cancel() {} };

function resetLaunch() {
  page.items = buildItems(RING_ORDER, 0);
  page.engine = engineStub;
  page.gesture = gestureStub;
  page.ctx = ctxProxy();
  page.setData = function () {};
  page.loop = { stop() {} };
  page._last = NOW;
  page.state = S.LAUNCH;
  page.launchAt = NOW - A6_MIN_MS - 16;
  page.target = getEntry('bricks');
  page._navTried = false; page._navCalled = false; page._navOk = false;
  page._navStep = 0; page._navStepAt = 0; page._hidden = false;
  page._diagMsg = ''; page._diagAt = 0;
  page._lit = null;
  log.calls.length = 0;
}

const R = [];
function check(name, cond, detail) {
  R.push({ name, ok: !!cond, detail: detail || '' });
  console.log('  [' + (cond ? 'PASS' : 'FAIL') + '] ' + name + (detail ? '  — ' + detail : ''));
}

/* 同 harness.mjs：打砖块的落地页面从清单读取，不写死路径 */
const BRICK_PAGE = getEntry('bricks').page;

console.log('\n=== N. storage 完全不可用 ===');
check('storageOk() 探测为 false', storageOk() === false, 'storageOk=' + storageOk());
check('safeSet 失败但不抛（NFR-06 静默兜底）', armNavProbe() === false, '返回 false');
check('navLanded() 读不到证据时返回 false', navLanded() === false, 'navLanded=false');

resetLaunch();
page.tick();
console.log('   s1 = ' + log.calls[0].api + '  ' + log.calls[0].url);
check('s1 切到带 query（gameId 不能走 storage，否则丢失）',
  log.calls[0].url === BRICK_PAGE + '?gameId=bricks', log.calls[0].url);

for (let i = 0; i < 6; i++) { advance(600); page.tick(); }
console.log('   六档序列：');
log.calls.forEach(function (c, i) { console.log('     s' + (i + 1) + ' ' + c.api + '  ' + c.url); });
check('s2 = slash + query', log.calls[1] && log.calls[1].url === '/' + BRICK_PAGE + '?gameId=bricks', log.calls[1] && log.calls[1].url);
check('s5 才回到裸路径', log.calls[4] && log.calls[4].url === BRICK_PAGE, log.calls[4] && log.calls[4].url);
check('配额用尽后复位待机', page.state === S.IDLE, 'state=' + page.state);
check('诊断带 sto:no（区分「没跳」与「跳了但没证据」）', /sto:no/.test(page._diagMsg), page._diagMsg);

const pass = R.filter((r) => r.ok).length;
console.log('\n=== 结论 ===');
console.log('  ' + pass + '/' + R.length + ' 项通过');
R.filter((r) => !r.ok).forEach((r) => console.log('  ✗ ' + r.name + ' — ' + r.detail));
process.exit(pass === R.length ? 0 : 1);
