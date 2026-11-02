/* 本地实证 v1.14：主页跳转「落地握手」+ 滑动手势进入选择态
 *
 * v1.13 部分：真机回调 nav:ok 但页面没跳转。官方契约里 router 的 success 是
 * 无条件回调（＝请求已发出），不能作为"页面已切换"的证据。
 *
 * v1.14 新增 F~J：滑动触控板进入选择态。依据 SKILL.md §4.2/§4.3，触控板
 * 滑动在框架层表现为方向键（ArrowUp/ArrowDown/…）。验证三件事：
 *   1) 手势层：一次滑动连发多个方向键脉冲只结算一次、keyUp 侧拦截宿主滚动；
 *   2) 页面层：待机滑动进选择态、待机单击无语义、滑动守卫吞掉伪单击；
 *   3) 提示条：三态文案 + 底框几何不越界。
 *
 * 运行：node build.mjs && node harness.mjs */
import fs from 'node:fs';
import { buildItems, layoutEntries, pickLit, drawLoadingCore, launchFade, coreFade, drawEntryLabel } from './utils/ring.js';
import { RING_ORDER, HINT, A6_MIN_MS, PULSE, LAUNCH_FADE, RING_R, RING_POS, GAME_MENU_R, GAME_MENU_IDLE, GLOW, CENTER, IDLE_CROSSHAIR, ACTIVE_CORE, LOADING_CORE, ENTRY_R, LABEL_GAP } from './utils/layout.js';
import { textWidth, fillGlow, fillRipple } from './utils/draw.js';
import { GestureTracker } from './utils/gesture.js';
import { getEntry } from './utils/games.js';
import wxmlMock, { log, store } from './wx-mock.mjs';
import page from './pages/index/index.mjs';

const S = { IDLE: 'IDLE', SELECT: 'SELECT', EXIT: 'EXIT', LAUNCH: 'LAUNCH', LOADING: 'LOADING' };

/* ── 假时钟：落地探测依赖时间推进（NAV_PROBE_MS = 700） ── */
let NOW = 1000000;
Date.now = function () { return NOW; };
function advance(ms) { NOW += ms; page._last = NOW; }

function ctxProxy() {
  const noop = function () {};
  return new Proxy({}, {
    get(t, k) {
      if (k === 'measureText') return () => ({ width: 10 });
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

function reset(extra) {
  page.items = buildItems(RING_ORDER, 0);
  page.engine = engineStub;
  page.gesture = gestureStub;
  page.ctx = ctxProxy();
  page.setData = function () {};
  page.state = S.LAUNCH;
  page._last = NOW;
  page._diagMsg = '';
  page._diagAt = 0;
  page._navTried = false; page._navCalled = false; page._navOk = false;
  page._navStep = 0; page._navStepAt = 0;
  page._exitTried = false; page._exitCalled = false; page._exitFailed = false;
  page._exitSentAt = 0; page._loopStopped = false;
  page._swipeGuard = 0; page._lit = null; page._enterSelectCalls = 0;
  page._hidden = false;   /* v1.16 第三落地通道的 evidence，逐轮清空 */
  page.loop = { stop() {} };
  Object.assign(page, extra || {});
  log.calls.length = 0;
  store.clear();
  for (const k of Object.keys(globalThis.landCountRef || {})) delete globalThis.landCountRef[k];
}

function seq() { return log.calls.map((c) => c.api).join(' → ') || '（无调用）'; }
function urls() { return log.calls.map((c) => c.url).join(' | ') || '-'; }

const R = [];
function check(name, cond, detail) {
  R.push({ name, ok: !!cond, detail: detail || '' });
  console.log('  [' + (cond ? 'PASS' : 'FAIL') + '] ' + name + (detail ? '  — ' + detail : ''));
}

/* 落地页面**一律从清单读取**，不要写死 'pages/game/game'。
 * 游戏逐个落地，写死路径会让每落地一款就误报一批「导航回归」——
 * 2026-09-05 missile 落地时就因为 K3 写死而误报 2 项（s5 → s6）。
 * K3 需要一个「与 bricks 不同页」的样本来避开 K1/K2 的档位干扰，
 * 用哪款都行，只要路径是动态取的。 */
const BRICK_PAGE = getEntry('bricks').page;
const MISSILE_PAGE = getEntry('missile').page;

console.log('\n=== A. 一次落地：navigateTo 首档即成功 ===');
globalThis.__LAND_ON = 'navigateTo'; globalThis.__LAND_NTH = 1;
reset({ launchAt: NOW - A6_MIN_MS - 16, target: getEntry('bricks') });
page.tick();
console.log('   第1帧 调用=' + seq() + '  url=' + urls());
advance(800); page.tick();
console.log('   +800ms 调用=' + seq() + '  state=' + page.state + '  diag=' + page._diagMsg);
check('只发 1 次请求（未重复重发）', log.calls.length === 1, seq());
check('url 为裸路径（不带 ?query）', log.calls[0] && log.calls[0].url === BRICK_PAGE, urls());
check('gameId 改走 storage 传递', store.get('__entryGameId') === 'bricks', '__entryGameId=' + store.get('__entryGameId'));
check('落地后暂停本页（state→IDLE）', page.state === S.IDLE, 'state=' + page.state);
check('诊断行为 nav:landed', /^nav:landed/.test(page._diagMsg), page._diagMsg);

console.log('\n=== B. 真机复现：success 回调了但页面从未落地 ===');
globalThis.__LAND_ON = 'never';
reset({ launchAt: NOW - A6_MIN_MS - 16, target: getEntry('missile') });
page.tick();
console.log('   第1帧 调用=' + seq());
advance(800); page.tick();
console.log('   +800ms 调用=' + seq());
advance(800); page.tick();
console.log('   +1600ms 调用=' + seq());
advance(800); page.tick();
console.log('   +3200ms 调用=' + seq());
advance(800); page.tick();
console.log('   +4000ms 调用=' + seq());
advance(800); page.tick();
console.log('   +4800ms 调用=' + seq());
advance(800); page.tick();   /* 第 7 帧：配额用尽判定 nav:dead */
console.log('   +5600ms 调用=' + seq() + '  state=' + page.state + '  diag=' + page._diagMsg);
/* v1.16：档位扩为 6 档（url 形态 × 方法），因此序列随之变化；
 * 最后一帧才轮到 nav:dead 判定（落地检查每帧先于换档分支执行）。 */
check('六档重试序列正确',
  seq() === 'navigateTo → navigateTo → redirectTo → redirectTo → navigateTo → redirectTo', seq());
check('配额用尽后复位待机', page.state === S.IDLE, 'state=' + page.state);
check('诊断行为 nav:dead', /^nav:dead/.test(page._diagMsg), page._diagMsg);

console.log('\n=== C. 第三档 redirectTo 才落地（v1.16：s3 = redirectTo bare）===');
globalThis.__LAND_ON = 'redirectTo'; globalThis.__LAND_NTH = 1;
reset({ launchAt: NOW - A6_MIN_MS - 16, target: getEntry('egg') });
page.tick();
console.log('   第1帧 调用=' + seq() + '  landed=' + (store.get('__navProbe') || '-'));
advance(800); page.tick();
console.log('   +800ms 调用=' + seq() + '  landed=' + (store.get('__navProbe') || '-'));
advance(800); page.tick();
console.log('   +1600ms 调用=' + seq() + '  landed=' + (store.get('__navProbe') || '-'));
advance(800); page.tick();
console.log('   +2400ms 调用=' + seq() + '  state=' + page.state + '  diag=' + page._diagMsg);
check('落地前换方式重试', log.calls.length === 3 && log.calls[2].api === 'redirectTo', seq());
check('落地后停止重试并暂停', page.state === S.IDLE && /^nav:landed s3/.test(page._diagMsg), page.state + ' / ' + page._diagMsg);

console.log('\n=== D. 落地后不再被按键事件误伤 ===');
globalThis.__LAND_ON = 'navigateTo';
reset({ launchAt: NOW - A6_MIN_MS - 16, target: getEntry('plane') });
page.tick(); advance(800); page.tick();
const before = log.calls.length;
page.onKeyUp({ code: 'GlobalHook', preventDefault() {} });
check('已落地时按键不补发请求', log.calls.length === before, '补发数=' + (log.calls.length - before));

console.log('\n=== E. 退出分支（回归） ===');
globalThis.__EXIT_MODE = 'ok';
page.state = S.EXIT; page._exitTried = false; page._exitFailed = false; page.exitAt = NOW - 3100;
log.calls.length = 0;
page.tick();
check('退出请求只发 1 次', log.calls.filter((c) => c.api === 'exitMiniProgram').length === 1, seq());
globalThis.__EXIT_MODE = 'silent';
page._exitTried = false; page._exitFailed = false; page._exitSentAt = 0;
page._exitCalled = false;   /* 上一段 exit:ok 会置真，必须一并重置否则判定分支被跳过 */
log.calls.length = 0;
page.tick(); page.tick();
check('静默时仍只发 1 次（_exitTried 保护）', log.calls.filter((c) => c.api === 'exitMiniProgram').length === 1, seq());
page._exitSentAt = NOW - 2100; page.tick();
check('2s 无响应判定失败并给出逃生口', page._exitFailed === true, '_exitFailed=' + page._exitFailed);

/* ══════════ v1.14 滑动手势（方向键通道）══════════ */

console.log('\n=== F. 手势层：一次滑动连发只结算一次 + keyUp 拦截宿主滚动 ===');
{
  let swipes = 0, lastDir = '';
  const g = new GestureTracker({ onSwipe(d) { swipes += 1; lastDir = d; } });
  g.onKeyDown({ code: 'ArrowDown' });
  g.onKeyDown({ code: 'ArrowDown' });   // 同一次滑动的第二个脉冲
  g.onKeyDown({ code: 'ArrowDown' });   // 第三个
  check('连发 3 个方向键只结算 1 次滑动', swipes === 1, 'swipes=' + swipes);

  let prevented = false;
  g.onKeyUp({ code: 'ArrowDown', preventDefault() { prevented = true; } });
  check('keyUp 侧拦截宿主默认（滚动根容器）', prevented === true, 'preventDefault=' + prevented);
  check('keyUp 不重复结算滑动', swipes === 1, 'swipes=' + swipes);

  advance(250);   // 越过 swipeDebounce(200ms)
  g.onKeyDown({ code: 'ArrowUp' });     // 反方向滑动同样应被识别
  check('消抖窗口过后、反向滑动可再次结算', swipes === 2 && lastDir === 'ArrowUp', swipes + ' / ' + lastDir);

  /* 宿主只派发 keyUp 的降级场景 */
  const g2 = new GestureTracker({ onSwipe(d) { swipes += 1; lastDir = d; } });
  g2.onKeyUp({ code: 'ArrowLeft', preventDefault() {} });
  check('仅 keyUp（无 keyDown）也能补结算滑动', swipes === 3 && lastDir === 'ArrowLeft', swipes + ' / ' + lastDir);

  /* 方向键不得误入单击通道 */
  let taps = 0;
  const g3 = new GestureTracker({ onTap() { taps += 1; }, onSwipe() {} });
  g3.onKeyDown({ code: 'ArrowUp' }); g3.onKeyUp({ code: 'ArrowUp', preventDefault() {} });
  check('方向键不触发单击语义', taps === 0, 'taps=' + taps);
}

console.log('\n=== G. 页面层：待机滑动进选择态 / 待机单击无语义 ===');
reset({ state: S.IDLE });
page.onSwipe('ArrowDown');
check('待机滑动 → 进入选择态', page.state === S.SELECT, 'state=' + page.state);
page.onSwipe('ArrowDown'); page.onSwipe('ArrowUp');
check('滑动幂等（重复滑动仍是选择态）', page.state === S.SELECT, 'state=' + page.state);
check('滑动取证写入诊断行', /^swipe:/.test(page._diagMsg), page._diagMsg);

reset({ state: S.IDLE });
page.onTap();
check('待机单击无语义（不再进选择态）', page.state === S.IDLE, 'state=' + page.state);

console.log('\n=== H. 滑动守卫：吞掉滑动附带的伪单击 ===');
reset({ state: S.IDLE });
page.onSwipe('ArrowDown');
page.onTap();   // 滑动后 300ms 内的伪单击
check('伪单击被守卫吞掉（未退回待机）', page.state === S.SELECT, 'state=' + page.state);
advance(400);
page.onTap();   // 守卫过期后的真实单击、且未点亮
check('守卫过期后单击正常退回待机', page.state === S.IDLE, 'state=' + page.state);

console.log('\n=== I. 选择态 / 退出态内的滑动被忽略 ===');
reset({ state: S.SELECT, selectAt: NOW });
page.onSwipe('ArrowDown');
check('选择态内滑动不改变状态', page.state === S.SELECT, 'state=' + page.state);
reset({ state: S.EXIT, exitAt: NOW });
page.onSwipe('ArrowDown');
check('退出确认态内滑动不改变状态', page.state === S.EXIT, 'state=' + page.state);

console.log('\n=== J. 提示条：六态文案 + 底框几何 ===');
const cases = [
  ['待机', S.IDLE, null, '滑动触控进入选择状态'],
  ['选择中（未点亮）', S.SELECT, null, '转头选择，单击触控返回待机'],
  ['已选中（点亮）', S.SELECT, { meta: {} }, '单击触控确认选择'],
  ['退出确认', S.EXIT, null, '单击触控取消退出'],
  ['A6 跳转脉冲', S.LAUNCH, null, '正在打开…'],
  ['A7 loading 等待', S.LOADING, null, '正在打开…'],
];
let hintOk = true, hintDetail = '';
for (const [label, st, lit, want] of cases) {
  page.state = st; page._lit = lit;
  const got = page._hintText();
  if (got !== want) { hintOk = false; hintDetail += label + ':' + got + ' '; }
}
check('六种状态的提示文案全部正确', hintOk, hintDetail || '全部匹配');

const geo = [];
for (const [, , , s] of cases) {
  const w = Math.ceil(textWidth(ctxProxy(), s, { size: HINT.size, weight: HINT.weight })) + HINT.padX * 2;
  geo.push({ s, w, right: HINT.x + w, bottom: HINT.y + HINT.h });
}
const maxRight = Math.max(...geo.map((g) => g.right));
check('提示条高度与 HUD 品牌胶囊一致（24）', HINT.h === 24, 'h=' + HINT.h);
check('提示条与 HUD 左缘对齐（x=16）', HINT.x === 16, 'x=' + HINT.x);
check('底框不越界（右缘 ≤ 480、底缘 ≤ 352）', maxRight <= 480 && HINT.y + HINT.h <= 352,
  'maxRight=' + maxRight + ' bottom=' + (HINT.y + HINT.h));
console.log('   底框宽度：' + geo.map((g) => g.s + '=' + g.w).join(' / '));

/* ── v1.16 K/L 组：url 形态轮换 + 第三条落地通道（onHide）──
 * 宿主路由可能只认某一种 url 形态（精确字符串匹配）。此前只押注 bare 一种，
 * 一旦押错就必然失败且无法定位。K 组验证 6 档序列正确、且任意单种形态
 * 被接受时都能命中；L 组验证 storage 探针失效时 onHide 仍能判定落地。 */
function resetK(extra) {
  reset(extra);
  page._hidden = false;
  globalThis.__LAND_URL = undefined;
  globalThis.__LAND_ON = 'never';
  globalThis.__LAND_NTH = 1;
}

console.log('\n=== K. v1.16 六档 url 形态轮换（storage 可用 → bare 优先）===');
globalThis.__STO_BROKEN = false;
resetK({ launchAt: NOW - A6_MIN_MS - 16, target: getEntry('bricks') });
page.tick();                       /* s1 */
for (let i = 0; i < 6; i++) { advance(600); page.tick(); }   /* s2..s6 + dead 判定 */
console.log('   六档序列：');
log.calls.forEach(function (c, i) { console.log('     s' + (i + 1) + ' ' + c.api + '  ' + c.url); });
check('共 6 档（未超发）', log.calls.length === 6, '实际 ' + log.calls.length + ' 档');
check('s1 = navigateTo bare', log.calls[0] && log.calls[0].api === 'navigateTo' && log.calls[0].url === BRICK_PAGE, log.calls[0] && log.calls[0].url);
check('s2 = navigateTo slash', log.calls[1] && log.calls[1].api === 'navigateTo' && log.calls[1].url === '/' + BRICK_PAGE, log.calls[1] && log.calls[1].url);
check('s3 = redirectTo bare', log.calls[2] && log.calls[2].api === 'redirectTo' && log.calls[2].url === BRICK_PAGE, log.calls[2] && log.calls[2].url);
check('s4 = redirectTo slash', log.calls[3] && log.calls[3].api === 'redirectTo' && log.calls[3].url === '/' + BRICK_PAGE, log.calls[3] && log.calls[3].url);
check('s5 = navigateTo 带 query', log.calls[4] && log.calls[4].api === 'navigateTo' && log.calls[4].url === BRICK_PAGE + '?gameId=bricks', log.calls[4] && log.calls[4].url);
check('s6 = redirectTo slash+query', log.calls[5] && log.calls[5].api === 'redirectTo' && log.calls[5].url === '/' + BRICK_PAGE + '?gameId=bricks', log.calls[5] && log.calls[5].url);
check('配额用尽后复位待机', page.state === S.IDLE, 'state=' + page.state);
check('全失败诊断含 nav:dead', /^nav:dead/.test(page._diagMsg), page._diagMsg);
check('storage 可用时不误报 sto:no', page._diagMsg.indexOf('sto:no') < 0, page._diagMsg);

console.log('\n=== K2. 宿主只认「带斜杠」形态 → s2 命中即停 ===');
resetK({ launchAt: NOW - A6_MIN_MS - 16, target: getEntry('bricks') });
globalThis.__LAND_URL = '/' + BRICK_PAGE;
page.tick(); advance(600); page.tick();
advance(600); page.tick();          /* 落地检查每帧先于换档，故需再一帧 */
console.log('   调用=' + seq() + '  diag=' + page._diagMsg);
check('s2 命中后不再继续（共 2 档）', log.calls.length === 2, seq());
check('诊断为 nav:landed s2', /^nav:landed s2/.test(page._diagMsg), page._diagMsg);
check('落地后暂停本页', page.state === S.IDLE, 'state=' + page.state);

console.log('\n=== K3. 宿主只认「带 query」形态 → s5 命中 ===');
resetK({ launchAt: NOW - A6_MIN_MS - 16, target: getEntry('missile') });
globalThis.__LAND_URL = MISSILE_PAGE + '?gameId=missile';
page.tick();
for (let i = 0; i < 5; i++) { advance(600); page.tick(); }   /* s2..s5 + landed 检测 */
console.log('   调用=' + seq() + '  diag=' + page._diagMsg);
check('走到 s5 才落地（共 5 档）', log.calls.length === 5, seq());
check('诊断为 nav:landed s5', /^nav:landed s5/.test(page._diagMsg), page._diagMsg);

console.log('\n=== L. 第三条落地通道：storage 探针失效，onHide 仍判定落地 ===');
resetK({ launchAt: NOW - A6_MIN_MS - 16, target: getEntry('bricks') });
page.tick();
console.log('   已发请求=' + seq() + '（探针未落地）');
page.onHide();                     /* 模拟宿主压栈回调 onHide */
advance(120); page.tick();
console.log('   onHide 后 state=' + page.state + '  diag=' + page._diagMsg);
check('onHide 命中即判定落地', /^nav:landed s1 \(hide\)/.test(page._diagMsg), page._diagMsg);
check('onHide 落地后暂停本页', page.state === S.IDLE, 'state=' + page.state);
check('未再继续发请求（共 1 档）', log.calls.length === 1, seq());

console.log('\n=== L2. onHide 标记不污染下一次跳转 ===');
resetK({ launchAt: NOW - A6_MIN_MS - 16, target: getEntry('bricks') });
page.tick();
page.onHide();
advance(120); page.tick();
check('本轮已落地', page.state === S.IDLE, 'state=' + page.state);
resetK({ launchAt: NOW - A6_MIN_MS - 16, target: getEntry('egg') });
check('reset 后 _hidden 已清空', page._hidden === false, '_hidden=' + page._hidden);
page.tick(); advance(600); page.tick();
check('新一轮正常进入第 2 档（未被上轮标记误判）', log.calls.length === 2, seq());

console.log('\n=== M. v1.17 A6 → A7 转移（中心不消失 + 脉冲 loading）===');
const T = { id: 'plane', name: '打飞机', iconId: 'plane', kind: 'game', page: 'pages/game/game' };
reset({ state: S.LAUNCH, launchAt: NOW, target: T });
page.tick();
check('A6 未到 A6_MIN_MS：维持脉冲初起、不发导航请求',
  page.state === S.LAUNCH && log.calls.length === 0,
  'state=' + page.state + ' calls=' + seq());
advance(A6_MIN_MS + 16);
page.tick();
check('到点转 A7 loading 并发出首档导航请求',
  page.state === S.LOADING && log.calls.length === 1,
  'state=' + page.state + ' calls=' + seq());
const laidDim = layoutEntries(page.items, 0, 0, true);
check('A7 入口整体收束至 6%（dim 生效、无点亮项）',
  laidDim.every((it) => !it.lit && it.frameA === 0.06),
  'lit=' + laidDim.filter((it) => it.lit).length + ' frameA=' + laidDim[0].frameA);
check('dim 态 pickLit 恒 null → A7 必须改用 target 取图标/标签',
  page._lit === null || page._lit === undefined, 'lit=' + page._lit);
let drawOk = true, drawErr = '';
try {
  drawLoadingCore(page.ctx, 240, 176, { iconId: T.iconId, label: T.name, t: 0.33, rings: 3 });
  drawLoadingCore(page.ctx, 240, 176, { iconId: T.iconId, t: 0.5, rings: 2, rMax: PULSE.r1 });
} catch (e) { drawOk = false; drawErr = e.message; }
check('drawLoadingCore 两态（A6 2 环 / A7 3 环）均不抛异常', drawOk, drawErr || 'ok');
check('脉冲几何：r0 < r1 < r2 且 A6 上限 = r1',
  PULSE.r0 < PULSE.r1 && PULSE.r1 < PULSE.r2 && PULSE.r1 === 50,
  'r0/r1/r2=' + PULSE.r0 + '/' + PULSE.r1 + '/' + PULSE.r2);

/* ══════════════════════════════════════════════════════════════════════
 * N. v1.18 确认 → loading 的连续性（淡出 + 全程位置锁定）
 *
 * 背景（用户反馈）：「选中功能点击确认后转到 loading 的效果不是很流畅，
 * 有点跳跃」。定位到三处同时发生的瞬变：
 *   ① 确认瞬间 engine.recenter() 把头控偏移清零 → 八个入口当帧跳回中心位
 *   ② A6 → A7 的切换帧把所有入口从分档亮度一帧打到 6%
 *   ③ 中心从「激活中心」硬切到「loading 核心」，脉冲环数 2→3、半径 50→62
 * v1.18 把三条曲线都改成沿同一条 fade 连续插值，本组逐条锁死。
 * ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== N. v1.18 确认 → loading 的连续性（淡出 + 位置锁定）===');
const T0 = NOW;

/* N1~N3 淡出节拍曲线 */
check('N1 节拍：delayMs 内保持原样（先让"已确认"可见）',
  launchFade(T0, T0) === 0 && launchFade(T0 + LAUNCH_FADE.delayMs - 1, T0) === 0,
  'f=' + launchFade(T0 + LAUNCH_FADE.delayMs - 1, T0));
check('N2 节拍：中点半开 ≈0.5',
  Math.abs(launchFade(T0 + LAUNCH_FADE.delayMs + LAUNCH_FADE.durMs / 2, T0) - 0.5) < 0.01,
  'f=' + launchFade(T0 + LAUNCH_FADE.delayMs + LAUNCH_FADE.durMs / 2, T0).toFixed(3));
check('N3 节拍：A6_MIN_MS 处恰好收束到 1（＝ delay + dur，单点真源）',
  launchFade(T0 + A6_MIN_MS, T0) === 1 && launchFade(T0 + A6_MIN_MS + 5000, T0) === 1
  && A6_MIN_MS === LAUNCH_FADE.delayMs + LAUNCH_FADE.durMs,
  'f=' + launchFade(T0 + A6_MIN_MS, T0) + ' A6_MIN_MS=' + A6_MIN_MS);

/* N4 跨态零跳变：A6 最后一帧 vs A7 第一帧 */
{
  const fEnd = launchFade(T0 + A6_MIN_MS - 1, T0);
  const fStart = launchFade(T0 + A6_MIN_MS, T0);
  check('N4 A6 末帧 → A7 首帧 fade 落差 < 0.01（跨态零跳变）',
    Math.abs(fStart - fEnd) < 0.01, 'Δ=' + Math.abs(fStart - fEnd).toFixed(4));
}

/* N5 亮度沿 fade 单调收束（含点亮项三通道，不是"全亮 or 全灭"） */
{
  const A = layoutEntries(page.items, 0, 130, 0);
  const B = layoutEntries(page.items, 0, 130, 0.5);
  const C = layoutEntries(page.items, 0, 130, 1);
  const i = A.findIndex((it) => it.lit);
  /* v1.19：装饰层（内衬环 + 四刻度）已删，decoA 通道随之移除；
   * 收束断言改为 frameA / iconA 两通道——它们才是入口可见性的全部来源。 */
  const ok = i >= 0
    && A[i].frameA > B[i].frameA && B[i].frameA > C[i].frameA
    && C.every((it) => it.frameA === 0.06 && it.iconA === 0.06 && it.decoA === undefined);
  check('N5 入口亮度沿 fade 单调收束至 6%（点亮项三通道同样渐隐）', ok,
    i >= 0 ? ('点亮项 ' + A[i].frameA + ' → ' + B[i].frameA + ' → ' + C[i].frameA)
      : '未构造出点亮项');
}

/* N6 语义与视觉解耦：fade=1 时视觉仍点亮（故是"渐隐"），语义已无选中 */
{
  const laid = layoutEntries(page.items, 0, 130, 1);
  const i = laid.findIndex((it) => it.lit);
  check('N6 fade=1：lit（视觉）仍 true、sel（语义）false → pickLit 恒 null',
    i >= 0 && laid[i].lit === true && laid[i].sel === false && pickLit(laid) === null,
    i >= 0 ? ('lit=' + laid[i].lit + ' sel=' + laid[i].sel + ' pickLit=' + pickLit(laid)) : 'n/a');
}

/* N7~N8 脉冲环数/半径沿 fade 插值，整条曲线绘制不抛异常 */
{
  const f = launchFade(T0 + A6_MIN_MS, T0);
  const rings = 2 + f;
  const rMax = PULSE.r1 + (PULSE.r2 - PULSE.r1) * f;
  check('N7 脉冲沿 fade 连续：起 2 环/r50 → A7 3 环/r62',
    launchFade(T0, T0) === 0 && rings === 3 && rMax === PULSE.r2,
    'rings=' + rings + ' rMax=' + rMax);
  let ok = true, err = '';
  try {
    for (let n = 0; n <= 10; n++) {
      const p = n / 10;
      drawLoadingCore(page.ctx, 240, 176, {
        iconId: T.iconId, label: T.name, t: p,
        rings: 2 + p,
        rMax: PULSE.r1 + (PULSE.r2 - PULSE.r1) * p,
        alpha: coreFade(T0 + p * LAUNCH_FADE.coreXMs, T0),
        labelA: p,
      });
    }
  } catch (e) { ok = false; err = e.message; }
  check('N8 整条淡出曲线 11 个采样点（含小数环数 2.0→3.0）绘制均不抛异常', ok, err || 'ok');
}

/* N9~N10 源码契约：确认路径不得回中；LOADING 必须继续消费头控偏移。
 * 动态行为由 N11/N12 实测，这两条是防"以后又被加回去"的静态锁。 */
{
  /* ⚠ 静态红线必须先剥注释再扫：v1.41 在注释里写了「start() 内含 recenter()」
   * 说明，裸扫会把注释当成第三处调用点（假失败）。剥注释只处理块注释与
   * 行注释，行注释前一位非 ':' 以避开 http:// 之类冒号后双斜杠。 */
  const rawSrc = fs.readFileSync(new URL('./pages/index/index.mjs', import.meta.url), 'utf8');
  const src = rawSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
  const recenterN = (src.match(/recenter\(\)/g) || []).length;
  const trackLine = (src.match(/const tracking = .*/) || [''])[0];
  check('N9 源码契约：recenter() 仅剩 EXIT + resetToIdle 两处（确认路径不回中）',
    recenterN === 2, 'count=' + recenterN);
  check('N10 源码契约：tracking 同时覆盖 LAUNCH 与 LOADING',
    /S\.LAUNCH/.test(trackLine) && /S\.LOADING/.test(trackLine), trackLine.trim());
  /* 【v1.51】诊断行下屏：render 里不得再有任何 text() 绘制（首页全部文字
   * 走 hud.js / ring.js / overlay.js 出口）。此前唯一一处就是品牌胶囊下方
   * y=48 的诊断行，会把跳转 url 与 IMU/音效自检暴露给用户。 */
  const drawTextN = (src.match(/[^A-Za-z_.]text\(/g) || []).length;
  check('N10b 源码契约：首页 render 不再上屏诊断行（无裸 text() 调用）',
    drawTextN === 0, 'count=' + drawTextN);
}

/* N11~N12 位置锁定实测：用可记录 ctx 抓第一个入口的真实绘制坐标。
 * ⚠ 探针随 v1.19 更新：原实现靠「第一个 ctx.arc」定位——那曾是入口装饰层的
 * 内衬环（v1.19 已删装饰层）。删掉后第一个 arc 来自**图标内部**的椭圆
 * （icons.js 的 ellipse helper，画在图标局部坐标系里），圆心是局部坐标，
 * 与入口位置无关，探针因此失效（误报 24/24）。
 * 现改抓 roundRect：入口圈本体恒由 strokeRoundRect/fillRoundRect 绘制，
 * 传入的是左上角 (it.x-24, it.y-24)，+24 即圆心——不依赖任何装饰层。 */
function recCtx(rec) {
  const noop = function () {};
  return new Proxy({}, {
    get(t, k) {
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'arc') return (x, y, r) => { rec.arcs.push({ x: x, y: y, r: r }); };
      if (k === 'roundRect') {
        return (x, y, w, h) => { rec.rects.push({ x: x, y: y, w: w, h: h }); };
      }
      return k in t ? t[k] : noop;
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}
{
  const SNAP = { x: 20, y: -15 };
  const p0 = page.items[0];
  const eng = {
    imuOk: true, running: true, recentered: 0,
    update() { return SNAP; }, snapshot() { return SNAP; },
    freezeDrift() {}, recenter() { this.recentered += 1; },
    stop() {}, start() {}, resetBase() {},
  };
  const rec = { arcs: [], rects: [] };
  page.engine = eng; page.ctx = recCtx(rec);
  page.state = S.LOADING; page.launchAt = NOW - A6_MIN_MS - 100; page.target = T;
  page.render(NOW);
  const a = rec.rects[0];
  check('N11 A7 loading 期间入口仍锚定头部（位置锁定，不回中）',
    !!a && Math.abs(a.x + 24 - (p0.baseX + SNAP.x)) < 0.01
      && Math.abs(a.y + 24 - (p0.baseY + SNAP.y)) < 0.01,
    a ? ('绘制圆心 ' + (a.x + 24).toFixed(1) + '/' + (a.y + 24).toFixed(1)
        + ' 期望 ' + (p0.baseX + SNAP.x) + '/' + (p0.baseY + SNAP.y))
      : '未捕获绘制');

  /* 对照：A5 退出确认下层应固定居中（不消费偏移） */
  const rec2 = { arcs: [], rects: [] };
  page.ctx = recCtx(rec2);
  page.state = S.EXIT; page.exitAt = NOW;
  page.render(NOW);
  const b = rec2.rects[0];
  check('N12 对照：A5 退出确认下层仍固定居中（未误改）',
    !!b && Math.abs(b.x + 24 - p0.baseX) < 0.01 && Math.abs(b.y + 24 - p0.baseY) < 0.01,
    b ? ('绘制圆心 ' + (b.x + 24).toFixed(1) + '/' + (b.y + 24).toFixed(1)
        + ' 期望 ' + p0.baseX + '/' + p0.baseY) : '未捕获绘制');
}

/* N13~N14 确认路径实测：点亮项单击后不得触发 recenter（这是"跳跃"的头号来源） */
{
  const eng = {
    imuOk: true, running: true, recentered: 0, snap: { x: 0, y: 130 },
    update() { return this.snap; }, snapshot() { return this.snap; },
    freezeDrift() {}, recenter() { this.recentered += 1; },
    stop() {}, start() {}, resetBase() {},
  };
  page.engine = eng; page.ctx = ctxProxy();
  page.state = S.SELECT; page.selectAt = NOW; page._swipeGuard = 0;
  page._navTried = false; page._navCalled = false; page._navStep = 0; page._navStepAt = 0;
  page.render(NOW);                       // 让 _lit 由真实布局算出
  if (page._lit && page._lit.meta.kind === 'exit') {
    /* 正下方是退出位：换个偏移，取一个游戏入口做主测 */
    eng.snap = { x: 0, y: -130 };
    page.render(NOW);
  }
  const kind = page._lit ? page._lit.meta.kind : 'null';
  eng.recentered = 0;
  page.onTap();
  check('N13 点亮项确认：不调用 recenter（入口不再当帧跳回中心）',
    eng.recentered === 0, 'kind=' + kind + ' recentered=' + eng.recentered);
  check('N14 点亮项确认：进入 A6 并记录目标与时间',
    page.state === S.LAUNCH && !!page.target && page.launchAt === NOW,
    'state=' + page.state + ' target=' + (page.target && page.target.name));

  /* 对照：退出位确认仍应回中（A5 下层固定居中）。
   * 退出位在正下方（down），需 oy = -130 把它挪到屏心；逐个偏移试，
   * 命中退出位才做真断言（避免"跳过"式假绿）。 */
  const eng2 = {
    imuOk: true, running: true, recentered: 0, snap: { x: 0, y: 0 },
    update() { return this.snap; }, snapshot() { return this.snap; },
    freezeDrift() {}, recenter() { this.recentered += 1; },
    stop() {}, start() {}, resetBase() {},
  };
  page.engine = eng2;
  let hitExit = false;
  for (const oy of [-130, 130, 92, -92]) {
    eng2.snap = { x: 0, y: oy };
    page.state = S.SELECT;
    page.render(NOW);
    if (page._lit && page._lit.meta.kind === 'exit') { hitExit = true; break; }
  }
  eng2.recentered = 0;
  page.onTap();
  check('N15 对照：退出位确认仍调用 recenter（A5 下层固定居中）',
    hitExit && page.state === S.EXIT && eng2.recentered === 1,
    'hitExit=' + hitExit + ' state=' + page.state + ' recentered=' + eng2.recentered);
}

/* ================= O. v1.19 设计稿同步（半径 / 光晕 / 中心倒计时） =================
 * 这一组是「设计稿 → 代码」的锁：任何一处几何或视觉语言回退都会在这里红。 */

console.log('\n=== O. v1.19 设计稿同步（半径 114 / 光晕面 / 中心倒计时）===');

/* O1~O2 半径 114：八向到屏心距离必须恒等，且与 GAME_MENU_IDLE 的 L/R 一致。
 * 110 是 frameAlpha 24%↔48% 的分档界，低于它会让对侧入口跨档变亮。 */
{
  const POS = ['LT', 'T', 'RT', 'R', 'RB', 'B', 'LB', 'L'];
  const ds = POS.map((p) => Math.round(Math.hypot(RING_POS[p].x - CENTER.x, RING_POS[p].y - CENTER.y)));
  check('O1 主页八向半径恒为 114（斜向 = 114/√2 取整后仍落在 ±1）',
    ds.every((d) => Math.abs(d - 114) <= 1), 'd=' + ds.join('/'));
  check('O2 B2 菜单待机位与主页 L/R 同半径（GAME_MENU_R = RING_R = 114）',
    GAME_MENU_R === RING_R
      && GAME_MENU_IDLE.L.x === RING_POS.L.x && GAME_MENU_IDLE.R.x === RING_POS.R.x
      && GAME_MENU_IDLE.L.y === RING_POS.L.y && GAME_MENU_IDLE.R.y === RING_POS.R.y,
    'menuR=' + GAME_MENU_R + ' L=' + GAME_MENU_IDLE.L.x + '/' + GAME_MENU_IDLE.L.y
      + ' R=' + GAME_MENU_IDLE.R.x + '/' + GAME_MENU_IDLE.R.y);
}

/* O3 光晕停点：v1.20 中心 core 峰值 24%（真机下调）、选中 lit 保持 30%、
 * 面板 panel 峰值 20%，三套都径向归零（禁大面实底）。 */
{
  const ck = (g) => g && g.length >= 2 && g[0][0] === 0 && g[g.length - 1][1] === 0
    && g.every((s, i) => i === 0 || s[0] > g[i - 1][0]);
  check('O3 光晕停点升序且边缘归零（core 24% / lit 30% / panel 20%）',
    ck(GLOW.core) && ck(GLOW.lit) && ck(GLOW.panel)
      && GLOW.core[0][1] === 0.24 && GLOW.lit[0][1] === 0.30 && GLOW.panel[0][1] === 0.20,
    'core=' + JSON.stringify(GLOW.core) + ' lit=' + JSON.stringify(GLOW.lit)
      + ' panel=' + JSON.stringify(GLOW.panel));
}

/* O3b 中心光晕半径（v1.20 收 10%）：待机 62 / 激活 70 / loading 80。 */
{
  check('O3b 中心光晕半径 62/70/80（原 70/80/90）',
    IDLE_CROSSHAIR.glowR === 62 && ACTIVE_CORE.glowR === 70 && LOADING_CORE.glowR === 80,
    IDLE_CROSSHAIR.glowR + '/' + ACTIVE_CORE.glowR + '/' + LOADING_CORE.glowR);
}

/* O3c 点亮标签按**近端**对齐圆环外缘：近端恒在 ENTRY_R + LABEL_GAP = 32，
 * 与名称字数无关（旧实现居中锚定，字数越多近端越往里缩、压住圆环与图标）。
 * 这里用 3 / 4 / 5 字三个用例验证近端位置一致。 */
{
  const near = (str) => {
    let best = null;
    const probe = {
      beginPath() {}, arc() {}, fill() {}, stroke() {}, moveTo() {}, lineTo() {},
      closePath() {}, fillRect() {}, strokeRect() {}, setLineDash() {},
      measureText() { return { width: 0 }; },
      fillText(s, x) { best = x; },
    };
    drawEntryLabel(probe, 276, 176, str, 1);
    return best; // 墨盒中心 x；近端 = 中心 − 估宽/2
  };
  const estOf = (s) => s.length * 11 * 0.99;
  const cases = ['打飞机', '重新游戏', '导弹指挥部'];
  const nears = cases.map((s) => near(s) - estOf(s) / 2);
  const spread = Math.max(...nears) - Math.min(...nears);
  check('O3c 点亮标签近端恒距圆环外缘 8px（3/4/5 字一致）',
    Math.abs(nears[0] - (276 + 24 + 8)) < 0.01 && spread < 0.01,
    'near=' + nears.map((n) => n.toFixed(1)).join('/') + ' 期望 308');
}

/* O4 光晕波纹 alpha：r38/r50/r62 三处恰好 0.30/0.20/0.12（设计稿三片同心光晕）。 */
{
  const rp = PULSE.ripple;
  const at = (r) => (r <= PULSE.r1
    ? rp[0] + (rp[1] - rp[0]) * ((r - PULSE.r0) / (PULSE.r1 - PULSE.r0))
    : rp[1] + (rp[2] - rp[1]) * ((r - PULSE.r1) / (PULSE.r2 - PULSE.r1)));
  check('O4 波纹 alpha 在 r38/r50/r62 = 0.30/0.20/0.12',
    Math.abs(at(PULSE.r0) - 0.30) < 1e-9 && Math.abs(at(PULSE.r1) - 0.20) < 1e-9
      && Math.abs(at(PULSE.r2) - 0.12) < 1e-9,
    at(PULSE.r0).toFixed(3) + '/' + at(PULSE.r1).toFixed(3) + '/' + at(PULSE.r2).toFixed(3));
}

/* O5 AIUI 红线：createRadialGradient 缺失时必须降级且**不抛异常**
 * （契约未承诺的宿主 API，缺失 ≠ 可崩）。这里直接构造一个没有该方法的 ctx。 */
{
  let ok = true, err = '';
  const bare = {
    beginPath() {}, arc() {}, fill() {}, stroke() {},
    moveTo() {}, lineTo() {}, closePath() {}, fillRect() {}, strokeRect() {},
    fillText() {}, measureText() { return { width: 10 }; }, setLineDash() {},
  };
  try {
    fillGlow(bare, 240, 176, 80, GLOW.core, 1);
    fillRipple(bare, 240, 176, 38, 0.30, 1);
  } catch (e) { ok = false; err = e.message; }
  check('O5 光晕在宿主无 createRadialGradient 时降级成功、不抛异常',
    ok && typeof bare.createRadialGradient !== 'function', err || 'ok');
}

/* O6 源码契约：v1.19 删除项不得复活（虚线圈 / 装饰层 / 放射线 / 强调环）。 */
{
  /* utils/ 是 build.mjs 从 ../../utils 原样拷贝（.js）；pages/ 只有 index 被
   * 改写进 navsim（.mjs），game 页未参与，故回落到工程源码 ../../pages。 */
  const files = ['utils/ring.js', 'utils/layout.js', 'utils/overlay.js',
    'pages/index/index.mjs', '../../pages/game/game.js'];
  function readSrc(rel) {
    try { return fs.readFileSync(new URL('./' + rel, import.meta.url), 'utf8'); } catch (e) {
      try { return fs.readFileSync(new URL('./' + rel.replace('../../', ''), import.meta.url), 'utf8'); } catch (e2) { return ''; }
    }
  }
  const banned = ['THRESHOLD_RING', 'ENTRY_DECO', 'LIT_RAYS', 'LIT_HALO', 'ACTIVE_TICKS'];
  const hits = [];
  for (let i = 0; i < files.length; i++) {
    /* 注释里允许出现（说明为何删除），但不得有**可执行**引用 */
    const src = readSrc(files[i]);
    if (!src) { hits.push(files[i] + ':READ-FAIL'); continue; }
    for (let j = 0; j < banned.length; j++) {
      const re = new RegExp('^\\s*(?!\\*|//).*\\b' + banned[j] + '\\b', 'gm');
      if (re.test(src)) hits.push(files[i] + ':' + banned[j]);
    }
  }
  check('O6 源码无 v1.19 删除项的可执行引用（虚线圈/装饰层/放射线/强调环）',
    hits.length === 0, hits.length ? hits.join(', ') : 'clean');
}

/* O7 中心倒计时：SELECT 态绘制、IDLE 态不绘制（仅选择中/已选中显示）。 */
{
  const eng = {
    imuOk: true, running: true, recentered: 0,
    update() { return { x: 0, y: 0 }; }, snapshot() { return { x: 0, y: 0 }; },
    freezeDrift() {}, recenter() { this.recentered += 1; },
    stop() {}, start() {}, resetBase() {},
  };
  const seen = [];
  page.engine = eng;
  page.ctx = new Proxy({}, {
    get(t, k) {
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'fillText') return (s, x, y) => { seen.push({ s: String(s), x: x, y: y }); };
      return k in t ? t[k] : function () {};
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  page.state = S.SELECT; page.selectAt = NOW - 8000;   // 已过 8s → 剩 7s
  page.render(NOW);
  const sel = seen.filter((o) => Math.abs(o.x - CENTER.x) < 0.01 && Math.abs(o.y - CENTER.y) < 0.01);
  check('O7 SELECT 态中心圈内绘制剩余秒数（15s − 8s = 7）',
    sel.length === 1 && sel[0].s === '7', sel.length ? ('绘制 ' + sel[0].s) : '未绘制');

  seen.length = 0;
  page.state = S.IDLE;
  page.render(NOW);
  const idle = seen.filter((o) => Math.abs(o.x - CENTER.x) < 0.01 && Math.abs(o.y - CENTER.y) < 0.01);
  check('O8 IDLE 态中心不绘制倒计时（仅选择中/已选中显示）',
    idle.length === 0, idle.length ? ('误绘制 ' + idle[0].s) : 'clean');
}

const pass = R.filter((r) => r.ok).length;
console.log('\n=== 结论 ===');
console.log('  ' + pass + '/' + R.length + ' 项通过');
R.filter((r) => !r.ok).forEach((r) => console.log('  ✗ ' + r.name + ' — ' + r.detail));
process.exit(pass === R.length ? 0 : 1);
