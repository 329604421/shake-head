/* 本地实证 v1.21：game 页状态机（B2 菜单 → B4 继续提示 → B1 游戏）
 *
 * 背景：harness.mjs 只测 pages/index（主页 A 系列）。game 页（B 系列）**零测试
 * 覆盖**，于是「S.CONT 只有读取、没有写入」这个缺陷从 v1.2 一直藏到 v1.20：
 * B4 的面板、倒计时、提示条、画布稿全部就位，唯独缺一条入边，而没有任何断言
 * 会因此失败。
 *
 * 本 harness 锁死 B4 的两条入边与两条出边，外加防死锁回归：
 *   G1 MENU 未点亮单击  → CONT（v1.2~v1.20 此处是直接回 PLAY）
 *   G2 MENU 挂起 15s    → CONT
 *   G3 CONT 单击        → PLAY
 *   G4 CONT 3s 超时     → PLAY
 *   ⚠ G3/G4 是防死锁点：backToPlay 的 state 白名单若不含 CONT，B4 进去就出不来
 *   G5 CONT 绘制面板三行文案，且屏心不画中心倒计时（B4 属浮层态）
 *   G6 CONT 下层入口回到待机位 (126/354) 且降至 6% 隐藏档
 *   G7 源码契约：backToPlay 白名单必须含 CONT（防回归）
 *   G8 MENU 态 IMU 异常 → 直接 PLAY，不经 B4（故障逃生不加缓冲）
 *   G9 面板高度补偿：B4(h152) 副标题墨中心 y = 159.5，与 A5(h140) 同心一致
 *
 * 运行：node build.mjs && node harness-game.mjs
 */
import fs from 'node:fs';

let NOW = 1000000;
Date.now = function () { return NOW; };

const { default: page } = await import('./pages/game/game.mjs');
const { makeItem, layoutEntries } = await import('./utils/ring.js');
const { GAME_MENU_IDLE, TOUCH, CONFIRM_MS, CENTER } = await import('./utils/layout.js');

const S = { PLAY: 'PLAY', MENU: 'MENU', CONT: 'CONT', LOADING: 'LOADING' };

/* ── 记录型 ctx：只关心 fillText 的落点（墨中心），其余一律 noop ── */
const texts = [];
const ctx = new Proxy({}, {
  get(t, k) {
    if (k === 'measureText') return () => ({ width: 10 });
    if (k === 'fillText') return (s, x, y) => { texts.push({ s: String(s), x: x, y: y }); };
    /* 故意不提供 createRadialGradient：顺带验证 O5 的降级路径在 game 页也成立 */
    if (k === 'createRadialGradient') return undefined;
    return k in t ? t[k] : function () {};
  },
  set(t, k, v) { t[k] = v; return true; },
});

const R = [];
function check(name, cond, detail) {
  R.push({ name: name, ok: !!cond, detail: detail || '' });
  console.log('  [' + (cond ? 'PASS' : 'FAIL') + '] ' + name + (detail ? '  — ' + detail : ''));
}

function reset(extra) {
  page.engine = {
    imuOk: true, running: true, recentered: 0,
    update() { return { x: 0, y: 0 }; },
    snapshot() { return { x: 0, y: 0 }; },
    freezeDrift() {}, recenter() { this.recentered += 1; },
    stop() {}, start() {}, resetBase() {}, stats: {},
  };
  page.gesture = { tick() {}, onKeyDown() {}, onKeyUp() {}, cancel() {} };
  page.meta = { id: 'plane', name: '打飞机', kind: 'game', iconId: 'plane' };
  page.menuItems = [
    makeItem('L', GAME_MENU_IDLE.L, { id: 'home', name: '退回主页面', iconId: 'home', kind: 'home' }, 0),
    makeItem('R', GAME_MENU_IDLE.R, { id: 'restart', name: '重新游戏', iconId: 'refresh', kind: 'restart' }, 0),
  ];
  page.ctx = ctx;
  page.setData = function () {};
  page._last = NOW;
  page._lit = null;
  page.state = S.PLAY;
  texts.length = 0;
  Object.assign(page, extra || {});
}

console.log('\n=== B4 继续提示 · 入边（v1.21 复活） ===');

/* G1 MENU 未点亮单击 → CONT */
reset({ state: S.MENU, menuAt: NOW, _lit: null });
page.onTap();
check('G1 MENU 未点亮单击 → 落 B4（CONT），不再直接回 PLAY',
  page.state === S.CONT && page.contAt === NOW,
  'state=' + page.state + ' contAt=' + page.contAt);

/* G2 MENU 挂起 15s 超时 → CONT */
reset({ state: S.MENU, menuAt: NOW - (TOUCH.selectSuspend + 1), _lit: null });
page.tick();
check('G2 MENU 挂起 15s 超时 → 落 B4（CONT）',
  page.state === S.CONT,
  'state=' + page.state);

console.log('\n=== B4 出边（防死锁：backToPlay 白名单必须含 CONT） ===');

/* G3 CONT 单击 → PLAY */
reset({ state: S.CONT, contAt: NOW });
page.onTap();
check('G3 B4 单击 → 立即恢复本局（PLAY）',
  page.state === S.PLAY, 'state=' + page.state);

/* G4 CONT 3s 超时 → PLAY */
reset({ state: S.CONT, contAt: NOW - (CONFIRM_MS + 1) });
page.tick();
check('G4 B4 3s 倒计时归零 → 自动恢复本局（PLAY）',
  page.state === S.PLAY, 'state=' + page.state);

console.log('\n=== B4 画面内容 ===');

/* G5 面板三行文案；屏心不画中心倒计时 */
reset({ state: S.CONT, contAt: NOW });
page.render(NOW);
const has = (s) => texts.some((o) => o.s === s);
const sub = texts.find((o) => o.s.indexOf('单击立即继续') === 0);
const num = texts.find((o) => o.s === '3');
const core = texts.filter((o) => Math.abs(o.x - CENTER.x) < 0.01 && Math.abs(o.y - CENTER.y) < 0.01);
check('G5a B4 绘制面板标题「游戏继续」+ 副标题 + 倒计时数字「3」',
  has('游戏继续') && !!sub && !!num,
  (has('游戏继续') ? '' : '缺标题 ') + (sub ? '' : '缺副标题 ') + (num ? '' : '缺数字'));
check('G5b B4 屏心不画中心倒计时（浮层态，倒计时只在面板里）',
  core.length === 0, core.length ? ('误绘制 ' + core[0].s) : 'clean');

/* G6 下层入口回待机位 + 6% 隐藏档（与 render 的 CONT 分支同参数） */
{
  const laid = layoutEntries(page.menuItems, 0, 0, 1);
  const lx = laid[0] && laid[0].x, rx = laid[1] && laid[1].x;
  const fa = laid[0] ? laid[0].frameA : -1;
  /* GAME_MENU_IDLE 是 { x, y } 对象（不是数组），按属性取值 */
  const okPos = lx === GAME_MENU_IDLE.L.x && rx === GAME_MENU_IDLE.R.x;
  check('G6 B4 下层入口回待机位 126 / 354 且降至 6% 隐藏档',
    okPos && Math.abs(fa - 0.06) < 0.005,
    'L.x=' + lx + ' R.x=' + rx + ' frameA=' + (Math.round(fa * 1000) / 1000));
}

/* G7 源码契约：backToPlay 白名单含 CONT（G3/G4 会跟着挂，但这条指出病灶位置） */
{
  /* harness 在 tests/navsim/ 下，源码在工程根：需上溯两级（navsim → tests → 工程根） */
  const src = fs.readFileSync(new URL('../../pages/game/game.js', import.meta.url), 'utf8');
  /* 取定义处向后 400 字符（勿用 \{[\s\S]*?\} 非贪婪——会停在 recenter() 的内层 }） */
  const i = src.indexOf('backToPlay() {');
  const body = i >= 0 ? src.slice(i, i + 400) : '';
  check('G7 源码契约：backToPlay 的 state 白名单含 CONT（漏掉即 B4 死锁）',
    i >= 0 && body.indexOf('S.CONT') >= 0 && body.indexOf('S.MENU') >= 0,
    i >= 0 ? 'matched' : '未找到 backToPlay 定义');
}

console.log('\n=== 逃生路径不经过 B4 ===');

/* G8 IMU 异常 → 直接回 PLAY（故障逃生不加 3s 缓冲） */
reset({ state: S.MENU, menuAt: NOW - (TOUCH.selectSuspend + 1), _lit: null });
page.engine.imuOk = false;
page.tick();
check('G8 MENU 态 IMU 异常 → 直接回 PLAY（不经 B4）',
  page.state === S.PLAY, 'state=' + page.state);

console.log('\n=== 面板高度补偿（v1.21） ===');

/* G9 A5(h140) 与 B4(h152) 面板同心于 (240,176)，内容绝对 y 必须一致 */
{
  const src = fs.readFileSync(new URL('../../utils/overlay.js', import.meta.url), 'utf8');
  check('G9a overlay.js 存在面板高度补偿项（h − 140）/ 2',
    /PANEL_BASE_H/.test(src) && /\(p\.h\s*-\s*PANEL_BASE_H\)\s*\/\s*2/.test(src),
    /PANEL_BASE_H/.test(src) ? 'ok' : '缺 PANEL_BASE_H');
  check('G9b B4 副标题墨中心 y = 159.5（与 A5 同心，未因面板变高而下移）',
    !!sub && Math.abs(sub.y - 159.5) < 0.01,
    sub ? ('y=' + sub.y) : '未绘制副标题');
}

console.log('\n=== 顶部标题栏状态预留（v1.22 · statusText 钩子） ===');

/* G10 状态胶囊的三级回落：本册 statusText > B3「状态：打开中」> IMU 状态。
 * ⚠ 关键在"可选"：statusText 未挂载时必须逐字回落到 v1.21 行为，且不得抛错
 * ——AIUI 单线程下 render 抛错 = 整帧绘制中断、画面卡死。 */
{
  const src = fs.readFileSync(new URL('../../pages/game/game.js', import.meta.url), 'utf8');
  check('G10a 源码契约：_hudStatus 以 typeof 守卫 statusText（未挂载不得抛错）',
    /typeof\s+this\.statusText\s*===\s*'function'/.test(src),
    /typeof\s+this\.statusText/.test(src) ? 'ok' : '缺 typeof 守卫');

  reset({ state: S.PLAY });
  delete page.statusText;
  page.engine.imuOk = true;
  let h = page._hudStatus();
  check('G10b 未挂载 statusText → 回落「IMU状态正常」+ 实心圆点',
    h.text === 'IMU状态正常' && h.dot === true, h.text + ' / dot=' + h.dot);

  page.engine.imuOk = false;
  h = page._hudStatus();
  check('G10c IMU 异常 → 文案切换 + 圆点转空心',
    h.text === 'IMU状态异常' && h.dot === false, h.text + ' / dot=' + h.dot);

  page.state = S.LOADING;
  h = page._hudStatus();
  check('G10d B3 loading → 「状态：打开中」+ 实心圆点（优先级高于 IMU）',
    h.text === '状态：打开中' && h.dot === true, h.text + ' / dot=' + h.dot);

  page.statusText = function () { return '第 2 波 · 剩 6'; };
  h = page._hudStatus();
  check('G10e 挂载 statusText → 覆盖框架状态文案（优先级最高）',
    h.text === '第 2 波 · 剩 6', h.text);

  /* 返回空串 = 本册主动放弃覆盖，应继续回落而不是显示空白胶囊 */
  page.statusText = function () { return ''; };
  h = page._hudStatus();
  check('G10f statusText 返回空串 → 回落「状态：打开中」（不得显示空白胶囊）',
    h.text === '状态：打开中', h.text);

  delete page.statusText;
}

/* ── BW 系列：品牌广告墙（v1.53）—— 静态契约 + 列剔除行为 ── */
console.log('\n=== BW 品牌广告墙（v1.53） ===');
const bwMod = await import('./utils/brandwall.js');
const { BRANDS, BRAND_POLY, drawBrandWall } = bwMod;
const bwLayout = await import('./utils/layout.js');
const bwPage = await import('./utils/gamepage.js');
const bwDrawAdCards = bwPage.drawAdCards;
const BWAD = bwLayout.AD;
const bwSrc = fs.readFileSync(new URL('./utils/brandwall.js', import.meta.url), 'utf8');

check('BW1 四家品牌齐全且顺序钉死（改顺序必须连带改本断言）',
  JSON.stringify(BRANDS) === JSON.stringify(['rokid', 'workbuddy', 'zhipu', 'deepseek']),
  BRANDS.join(','));
check('BW2 每家都有折线数据（≥1 条子路径）',
  BRANDS.every(function (b) { return Array.isArray(BRAND_POLY[b]) && BRAND_POLY[b].length >= 1; }));
check('BW3 数据框 22×22：所有点落在 ±11 内（防归一化回归）',
  BRANDS.every(function (b) {
    return BRAND_POLY[b].every(function (sub) {
      for (let i = 0; i < sub.length; i += 2) {
        if (Math.abs(sub[i]) > 11.01 || Math.abs(sub[i + 1]) > 11.01) return false;
      }
      return true;
    });
  }));
check('BW4 brandwall.js 不写死色值（亮度档只出自 layout.AD）',
  !/#[0-9A-Fa-f]{3,8}/.test(bwSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')));
check('BW5 brandwall.js 禁 import audio（黑屏红线）',
  !/from\s+'audio'/.test(bwSrc) && !/import\(/.test(bwSrc));
check('BW6 几何：128×256、4 列 × 8 行、logo 22、格框 21',
  BWAD.w === 128 && BWAD.h === 256 && BWAD.cols === 4 && BWAD.rows === 8 &&
  BWAD.logo === 22 && BWAD.box === 21);
check('BW7 亮度不得高于原文字卡：logo 24% / 描边 12%（用户硬要求）',
  BWAD.logoA === 0.24 && BWAD.strokeA === 0.12,
  'logoA=' + BWAD.logoA + ' strokeA=' + BWAD.strokeA);
check('BW8 相机版锚点：xL=-80 / xR=432 / y=48（转到底 136px 完整露出）',
  BWAD.cam.xL === -80 && BWAD.cam.xR === 432 && BWAD.cam.y === 48);
check('BW9 迷宫版锚点：xL=-136 / xR=456 / y=0（v1.54 纵向钉世界，墙顶平齐迷宫顶外墙）',
  BWAD.maze.xL === -136 && BWAD.maze.xR === 456 && BWAD.maze.y === 0);
check('BW10 相机版墙纵向落在视口内且不压提示条（48~304 ⊂ 44~316）',
  BWAD.cam.y >= 44 && BWAD.cam.y + BWAD.h <= 308,
  BWAD.cam.y + '~' + (BWAD.cam.y + BWAD.h));

/* 动态：列剔除行为。记录型 ctx 数 moveTo（每个子路径/格框 1 次）+ fill/stroke 次数 */
function bwRecord() {
  const rec = { mv: 0, fill: 0, stroke: 0 };
  return {
    rec: rec,
    ctx: {
      beginPath() {}, closePath() {}, moveTo() { rec.mv += 1; },
      lineTo() {}, quadraticCurveTo() {},
      fill() { rec.fill += 1; }, stroke() { rec.stroke += 1; },
      set fillStyle(v) {}, set strokeStyle(v) {}, set lineWidth(v) {},
      save() {}, restore() {}, clip() {}, rect() {}, translate() {},
    },
  };
}
/* 相机居中 dx=0：两墙全在裁剪窗外 → 0 次 moveTo（89% 时间的常态）。
 * fill/stroke 各 2 次（两墙各 1 次、路径为空的无害空转），性能关键是 moveTo=0 */
const bw0 = bwRecord();
bwDrawAdCards(bw0.ctx, BWAD.cam, 0, 0, 1);
check('BW11 相机居中 dx=0 → 整墙剔除（moveTo=0，白画两整墙即回归）',
  bw0.rec.mv === 0, 'mv=' + bw0.rec.mv);
/* 转到底 dx=136：左墙 4 列全可见（32 格），右墙全剔；
 * 子路径数 = 8 行×4 列 每家 8 次 ×(rokid2+wb3+zhipu3+ds4)=96，格框 32 → 128 */
const bwFull = bwRecord();
bwDrawAdCards(bwFull.ctx, BWAD.cam, 136, 0, 1);
check('BW12 转到底 dx=136 → 左墙 32 格全画（moveTo=128）、右墙全剔',
  bwFull.rec.mv === 128, 'mv=' + bwFull.rec.mv);
check('BW13 同色图元合并：每面墙 fill=1 / stroke=1，两墙共 2/2（性能硬约束）',
  bwFull.rec.fill === 2 && bwFull.rec.stroke === 2,
  'fill=' + bwFull.rec.fill + ' stroke=' + bwFull.rec.stroke);
/* 中段 dx=100：左墙第 1 列(-80~-48)被 visL=-44 剔掉 → 3 列 24 格
 * moveTos = 格框 24 + 24 格×(8/32 行列均匀)×12子路径 = 24+72 = 96 */
const bwMid = bwRecord();
bwDrawAdCards(bwMid.ctx, BWAD.cam, 100, 0, 1);
check('BW14 中段 dx=100 → 仅左墙 3 列可见（moveTo=96，逐列剔除）',
  bwMid.rec.mv === 96, 'mv=' + bwMid.rec.mv);
/* fade=0 → 直接返回不画 */
const bwFade = bwRecord();
bwDrawAdCards(bwFade.ctx, BWAD.cam, 136, 0, 0);
check('BW15 fade=0 → 不绘制（B2 菜单期与世界层同步淡出）',
  bwFade.rec.mv === 0, 'mv=' + bwFade.rec.mv);

/* v1.54：迷宫墙纵向钉世界 —— marble 必须传 worldOffset(cam).y 作 dy（禁屏固 0） */
const bwMarbleSrc = fs.readFileSync(new URL('../../pages/marble/marble.js', import.meta.url), 'utf8')
  .replace(/\s+/g, ' ');
check('BW16 marble 传 adOff.y 作 dy（迷宫相机双轴跟球，墙纵向必须钉世界）',
  /drawAdCards\(ctx, AD\.maze, adOff\.x, adOff\.y,/.test(bwMarbleSrc));
check('BW17 迷宫墙世界纵向跨度落在迷宫内（0~256 ⊂ 0~294）',
  BWAD.maze.y >= 0 && BWAD.maze.y + BWAD.h <= 294,
  BWAD.maze.y + '~' + (BWAD.maze.y + BWAD.h));

const pass = R.filter((r) => r.ok).length;
console.log('\n=== 结论 ===');
console.log('  ' + pass + '/' + R.length + ' 项通过');
R.filter((r) => !r.ok).forEach((r) => console.log('  ✗ ' + r.name + ' — ' + r.detail));
process.exit(pass === R.length ? 0 : 1);
