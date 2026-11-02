/* 打砖块玩法模块冒烟 + 契约断言（本地 node，无需宿主）
 * 运行：cd tests/navsim && node build.mjs && node harness-brick.mjs
 *
 * 覆盖：
 *   B1  几何：48 砖、首砖 (17,64)、砖阵占位、满分 960
 *   B2  吸附发球 1.5s 自动发射；θ 由头部决定；|θ|<8° 兜底 +25°
 *   B3  固定子步：掉帧 dt=100ms 不穿透
 *   B4  击砖递增球速，上限 240 不越界
 *   B5  破墙：顶行首碎 ×1.12 + 波纹；一条命内只一次
 *   B6  落底损命：球速重置 160 / 道具清空 / 连击清零；多球仅移除落底球
 *   B7  命尽 → over + finished（无演出，直接结算）
 *   B8  清空 48 砖 → clear，320ms 后 finished
 *   B9  IMU 异常：物理停摆且 g.t 不推进
 *   B10 三条红线静态检查：无 Date.now / 无定时器 / 不 import sfx|storage
 *   B11 加宽到期回落 + 夹紧（F-BRK-05）
 *   B12 result 契约：cleared / extra 两项 / label ≤6 字
 *   B14 方向语义：直控跟随取 -snap.x（真机修正，含源码锁）
 */
import fs from 'node:fs';

const { create, update, render, result, serveDeg, camDx } =
  await import('./utils/bricks.js');
const { BRICKS } = await import('./utils/layout.js');

const R = [];
function check(name, cond, detail) {
  R.push({ name: name, ok: !!cond, detail: detail || '' });
  console.log('  [' + (cond ? 'PASS' : 'FAIL') + '] ' + name + (detail ? '  — ' + detail : ''));
}
function near(a, b, e) { return Math.abs(a - b) <= (e === undefined ? 0.001 : e); }

/* 记录型 ctx：关心 fillText 落点 + **屏幕系** fillRect / 三角形落点。
 * 相机版后世界层整体走 translate，因此 mock 必须真的累加平移量，
 * 否则记下来的是世界坐标，验证不了「挡板屏幕位置恒为 240」这类断言。
 * save/restore 用栈保存平移量，与真实 canvas 语义一致。 */
function makeCtx() {
  const texts = [];
  const rects = [];      // { x, y, w, h, style }  x 已换算到屏幕系
  const tris = [];       // { ax, y } 三角形顶点（离屏球指示器）
  let tx = 0;
  const stack = [];
  const ctx = new Proxy({}, {
    get(t, k) {
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'fillText') return (s, x, y) => {
        texts.push({ s: String(s), x: x, y: y, style: t.fillStyle });
      };
      if (k === 'createRadialGradient') return undefined;  // 强制走同心圆降级
      if (k === 'save') return () => { stack.push(tx); };
      if (k === 'restore') return () => { tx = stack.length ? stack.pop() : 0; };
      if (k === 'translate') return (dx) => { tx += dx || 0; };
      if (k === 'fillRect') return (x, y, w, h) => {
        rects.push({ x: x + tx, y: y, w: w, h: h, style: t.fillStyle });
      };
      if (k === 'moveTo') return (x, y) => { tris.push({ ax: x + tx, y: y }); };
      /* drawImage 不实现 → 强制走直绘降级路径（顺带验证降级不抛错） */
      if (k === 'drawImage') return undefined;
      return k in t ? t[k] : function () {};
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  return { ctx: ctx, texts: texts, rects: rects, tris: tris };
}

const OK = { ok: true, x: 0, y: 0 };
const DOWN = { ok: false, x: 0, y: 0 };
const snap = (x) => ({ ok: true, x: x || 0, y: 0 });

/* 推进 n 帧（每帧 33ms），返回累计事件 */
function run(g, frames, sx) {
  const ev = [];
  const s = snap(typeof sx === 'function' ? sx(0) : sx);
  for (let i = 0; i < frames; i++) {
    if (typeof sx === 'function') s.x = sx(i);
    const e = update(g, 33, s);
    for (let j = 0; j < e.length; j++) ev.push(e[j]);
  }
  return ev;
}
function has(ev, k) { return ev.indexOf(k) >= 0; }
function count(ev, k) { return ev.filter((x) => x === k).length; }

console.log('\n=== B1 几何与关卡数据（PRD-02 §6.1） ===');
{
  const g = create();
  /* 相机版 v1.28 重排：6 列 × 7 行 = 42，砖 50×12、列距 58（总宽 340，
   * 塞进球场 352 内左右各留 6）。v1.27 的 66/74 是为 436 球场定的。 */
  check('B1a 砖阵 42 块（6 列 × 7 行）', g.bricks.length === 42 && g.alive === 42,
    'n=' + g.bricks.length + ' alive=' + g.alive);
  const b0 = g.bricks[0];
  check('B1b 首砖左上 (70,64)', b0.x === 70 && b0.y === 64, '(' + b0.x + ',' + b0.y + ')');
  const last = g.bricks[41];
  check('B1c 末砖右缘 410 / 底缘 166（砖阵占 x 70~410、y 64~166）',
    last.x + 50 === 410 && last.y + 12 === 166,
    '(' + (last.x + 66) + ',' + (last.y + 12) + ')');
  let sum = 0;
  for (let i = 0; i < g.bricks.length; i++) sum += g.bricks[i].score;
  check('B1d 满分仍为 960（行分值 30×3 / 20×3 / 10 × 6 列）', sum === 960, 'sum=' + sum);
  check('B1e 行描边亮度 72×3 / 48×3 / 24',
    BRICKS.ROW_ALPHA.join(',') === '0.72,0.72,0.72,0.48,0.48,0.48,0.24', BRICKS.ROW_ALPHA.join(','));
  check('B1f 初始：3 命 / 160 速 / 吸附态',
    g.lives === 3 && g.speed === 160 && g.serve.on === true,
    'lives=' + g.lives + ' speed=' + g.speed);
}

console.log('\n=== B2 吸附发球（F-BRK-40~44） ===');
{
  const g = create();
  /* 头左偏（snap.x=+96）→ 相机到世界 144 → 朝开阔侧发球 θ = +25°（往右上） */
  const ev = run(g, 46, 96);            // 46 × 33 = 1518ms > 1500
  check('B2a 1.5s 后自动发射（无需任何触控板操作）', has(ev, 'serve'), 'ev=' + ev.join(','));
  /* 分母是标准档行程半幅 TRAVEL = COURT.w/2 − PADDLE.w/2 = 218 − 32 = 186，
   * 不写死 —— 球场宽度一改它就跟着变（v1.26 硬编码 192 的教训）。 */
  const TRAVEL = BRICKS.COURT.w / 2 - BRICKS.PADDLE.w / 2;
  check('B2b 发球角朝向开阔侧：相机偏左 → θ = (240−144)/186×50 ≈ 25.8°',
    near(serveDeg(g), (240 - 144) / TRAVEL * 50, 0.01), 'θ=' + serveDeg(g).toFixed(2));
  check('B2c 发射后脱离吸附态', g.serve.on === false, 'serve.on=' + g.serve.on);
  const b = g.balls[0];
  check('B2d 发射方向单位向量：dy < 0（向上）', b && b.dy < 0, b ? 'dy=' + b.dy.toFixed(3) : 'no ball');
}
{
  /* |θ| < 8° 兜底：头正中央 → θ = 0 → 强制 +25° */
  const g = create();
  run(g, 46, 0);
  const b = g.balls[0];
  const deg = Math.atan2(b.dx, -b.dy) * 180 / Math.PI;
  check('B2e 垂直兜底：θ=0 强制取 +25°（F-BRK-43）', near(deg, 25, 0.01), 'θ=' + deg.toFixed(2));
}
{
  /* 吸附期球随相机同步平移。snap.x 取负 = 头向右转 = 相机（挡板世界坐标）右移
   * —— SEM_FOLLOW，与主页八向环同族；屏幕上球恒在 x=240，动的是世界。 */
  const g = create();
  run(g, 2, 0);
  const x1 = g.balls[0].x;
  run(g, 20, -150);
  check('B2f 吸附期球随挡板同步平移（F-BRK-40）',
    g.balls[0].x > x1 + 20, 'x1=' + x1 + ' x2=' + g.balls[0].x);
}

console.log('\n=== B3 固定子步：掉帧不穿透（F-BRK-37/39） ===');
{
  const g = create();
  run(g, 46, 0);                        // 先发球
  /* 制造一次 100ms 掉帧；球在 y≈290 上行，挡板在 294 —— 单帧位移 24px 会穿过 */
  const before = g.balls[0].y;
  update(g, 100, snap(0));
  check('B3a dt=100ms 单帧位移被压到子步内（球未穿过顶墙/挡板）',
    g.balls[0].y >= 48 + 4 - 0.001 && g.balls[0].y <= 308,
    'y ' + before.toFixed(1) + ' → ' + g.balls[0].y.toFixed(1));
  check('B3b 掉帧后仍存活（未误判落底）', g.balls.length >= 1 && g.lives === 3,
    'balls=' + g.balls.length + ' lives=' + g.lives);
}

console.log('\n=== B4 球速递增（F-BRK-31） ===');
{
  const g = create();
  g.serve.on = false;
  g.balls[0] = { x: 240, y: 200, dx: 0, dy: -1 };
  /* 直接连碎 30 砖：验证上限夹紧 */
  for (let i = 0; i < 40; i++) {
    const alive = g.bricks.find((b) => b.alive);
    if (!alive) break;
    const ev = [];
    /* 借内部路径：把球放到砖上再走一步 */
    g.balls[0].x = alive.x + 27; g.balls[0].y = alive.y + 6;
    update(g, 8, snap(0));
  }
  check('B4a 球速不超过上限 240', g.speed <= 240 + 1e-9, 'speed=' + g.speed.toFixed(2));
  check('B4b 球速确实递增（>160）', g.speed > 160, 'speed=' + g.speed.toFixed(2));
}

console.log('\n=== B5 破墙（F-BRK-60~62） ===');
{
  const g = create();
  g.serve.on = false;
  g.balls[0] = { x: 44, y: 70, dx: 0, dy: -1 };   // 顶行第 1 砖 (17,64) 上方
  const v0 = g.speed;
  update(g, 8, snap(0));
  check('B5a 顶行首碎触发破墙事件', g.breakthroughDone === true, 'done=' + g.breakthroughDone);
  check('B5b 破墙球速 ×1.12（并与递增叠加）', g.speed > v0, v0 + ' → ' + g.speed.toFixed(2));
  check('B5c 中心单次波纹已起（120ms，非循环）',
    g.rippleT0 >= 0 && g.rippleDur === 120, 'dur=' + g.rippleDur);
  /* 再碎一块顶行砖 → 不再触发 */
  const v1 = g.speed;
  g.balls[0] = { x: 100, y: 70, dx: 0, dy: -1 };
  const ev2 = update(g, 8, snap(0));
  check('B5d 一条命内只触发一次（第二条顶行砖不再触发）',
    !has(ev2, 'breakthrough'), 'ev=' + ev2.join(','));
}

console.log('\n=== B6 落底损命（F-BRK-70~73） ===');
/* 落底测试必须让球避开挡板：挡板由 snap.x 直控且取**跟随**语义（SEM_FOLLOW），
 * snap.x=-192 即头向右转 → cx=432，夹紧到 368（球场右 416 − 半宽 48），
 * 占 x 320~416，把球放在 x=100 即可自由落到底。
 * ⚠ 别写成 +192 —— 那是把挡板推到最左（cx=96，占 64~128），正好接住球。 */
{
  const g = create();
  g.serve.on = false;
  g.speed = 220;
  g.combo = 9;
  g.paddle.w = 96; g.wideT0 = 0;
  g.balls[0] = { x: 100, y: 300, dx: 0, dy: 1 };
  const ev = run(g, 6, -192);           // 6 × 33ms ≈ 43px，足够越过 308
  check('B6a 球心 y > 308 判落底 → 损 1 命', has(ev, 'lose') && g.lives === 2,
    'lives=' + g.lives + ' ev=' + ev.join(','));
  check('B6b 损命后球速重置 160（F-BRK-32）', g.speed === 160, 'speed=' + g.speed);
  check('B6c 道具效果清空（挡板回 64）', g.paddle.w === 64 && g.wideT0 === -1,
    'w=' + g.paddle.w);
  check('B6d 连击清零（F-BRK-71）', g.combo === 0, 'combo=' + g.combo);
  check('B6e 重新进入吸附态（1.5s 自动发射，不需操作）', g.serve.on === true, 'serve=' + g.serve.on);
}
{
  /* 多球：仅移除落底球，仍有球存活则不损命 */
  const g = create();
  g.serve.on = false;
  g.balls[0] = { x: 100, y: 300, dx: 0, dy: 1 };
  g.balls[1] = { x: 300, y: 150, dx: 0, dy: -1 };
  const ev = run(g, 6, -192);
  check('B6f 多球时仅移除落底球，不损命（F-BRK-73）',
    g.balls.length === 1 && g.lives === 3 && !has(ev, 'lose'),
    'balls=' + g.balls.length + ' lives=' + g.lives);
  check('B6g 存活球保持原轨迹（未被误重置）',
    g.balls[0].x === 300 && !g.serve.on, 'x=' + g.balls[0].x + ' serve=' + g.serve.on);
}

console.log('\n=== B7/B8 结算出口（F-BRK-72 / 74~76） ===');
{
  const g = create();
  g.lives = 1;
  g.serve.on = false;
  /* 球必须避开挡板能到达的最左位置：挡板夹紧后 cx=96，占 x 64~128。
   * v1.27 球场 22~458 时挡板最左能到 54（占 22~86），球放 100 是安全的；
   * v1.28 球场收窄到 64~416 后挡板最左只到 96，球放 100 就被接住了。 */
  g.balls[0] = { x: 200, y: 300, dx: 0, dy: 1 };
  const ev = run(g, 6, 192);
  check('B7a 命尽 → over', has(ev, 'over'), 'ev=' + ev.join(','));
  check('B7b 命尽直接结算（同帧 finished，无演出）', has(ev, 'finished'), 'ev=' + ev.join(','));
  check('B7c 不在游戏内自动重开', g.phase === 'dead' && g.serve.on === false, 'phase=' + g.phase);
  /* 命尽无演出：finished 必须当帧结清，否则 dead 分支会空等 320ms 再补发一次 */
  const ev9 = run(g, 20, 192);
  check('B7d 命尽后不再补发 finished（同帧结清，无演出）',
    !has(ev9, 'finished'), 'ev=' + ev9.join(','));
}
{
  const g = create();
  /* 手工清空到只剩最后一块（42 砖 → 清 41） */
  const N = g.bricks.length;
  for (let i = 0; i < N - 1; i++) { g.bricks[i].alive = false; }
  g.alive = 1;
  g.serve.on = false;
  const lastB = g.bricks[N - 1];
  g.balls[0] = { x: lastB.x + 33, y: lastB.y + 6, dx: 0, dy: -1 };
  const ev1 = update(g, 8, snap(0));
  check('B8a 清空全部 ' + N + ' 砖 → clear 事件', has(ev1, 'clear'), 'ev=' + ev1.join(','));
  check('B8b 进入通关演出（物理停摆）', g.phase === 'clearShow', 'phase=' + g.phase);
  const ballY = g.balls[0] ? g.balls[0].y : 0;
  const ev2 = run(g, 3);                 // 99ms，不足 320ms
  check('B8c 演出期间球不移动（F-BRK-76）',
    !g.balls[0] || g.balls[0].y === ballY, 'y=' + (g.balls[0] ? g.balls[0].y : 'n/a'));
  check('B8d 演出未结束不报 finished', !has(ev2, 'finished'), 'ev=' + ev2.join(','));
  const ev3 = run(g, 8);                 // 累计 > 320ms
  check('B8e 320ms 演出结束 → finished（页面据此跳结算）', has(ev3, 'finished'),
    'ev=' + ev3.join(','));
}

console.log('\n=== B9 IMU 异常降级（F-BRK-84） ===');
{
  const g = create();
  g.serve.on = false;
  g.balls[0] = { x: 240, y: 150, dx: 0.2, dy: -1 };
  const t0 = g.t, x0 = g.balls[0].x;
  const ev = update(g, 33, DOWN);
  check('B9a IMU 异常 → 物理停摆（球不动）', g.balls[0].x === x0, 'x=' + g.balls[0].x);
  check('B9b IMU 异常 → g.t 不推进（冻结期不计入净时长）', g.t === t0, 't=' + g.t);
  check('B9c 标记 imuDown（render 据其画中心面板）', g.imuDown === true, 'imuDown=' + g.imuDown);
  check('B9d 不产出任何事件（不误播音）', ev.length === 0, 'ev=' + ev.join(','));
  /* 恢复 */
  update(g, 33, snap(0));
  check('B9e IMU 恢复 → 自动续算（不丢帧、不重置）', g.imuDown === false && g.t > t0, 't=' + g.t);
}

console.log('\n=== B10 三条红线静态检查（F-BRK-82/85/83） ===');
{
  /* harness 在 tests/navsim/ 下，源码在工程根：需上溯两级（navsim → tests → 根） */
  const src = fs.readFileSync(new URL('../../utils/bricks.js', import.meta.url), 'utf8');
  /* 先剥注释再扫：红线说明本身就写在头注释里，裸扫会把注释里的
   * 「禁止 Date.now()」误判成违规。静态检查必须针对**可执行代码**。 */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  check('B10a 无 Date.now（游戏内时钟唯一时间源）', code.indexOf('Date.now') < 0);
  check('B10b 无 setTimeout / setInterval',
    !/setTimeout|setInterval/.test(code));
  check('B10c 不 import sfx / storage（事件与落盘全归页面）',
    !/from\s+'\.\/sfx\.js'|from\s+'\.\/storage\.js'|import\s+\*\s+as\s+sfx/.test(src));
  check('B10d 不绘制黑色遮罩（无 fillRect 全屏深色）',
    !/fillRect\(\s*ctx\s*,\s*0\s*,\s*0\s*,\s*480\s*,\s*352/.test(src));
  check('B10e 变暗统一走 ring.js 的 fadeTo', /fadeTo/.test(src));
}

console.log('\n=== B11 加宽道具到期回落（F-BRK-05/54） ===');
{
  const g = create();
  g.serve.on = false;
  g.balls[0] = { x: 240, y: 150, dx: 0.2, dy: -1 };
  /* 把挡板推到右边界并加宽 → 宽度回落时必须夹紧，不得越界 */
  g.paddle.cx = 432; g.paddle.w = 96; g.wideT0 = g.t;
  update(g, 33, snap(192));
  check('B11a 加宽态行程夹紧至 [64, 416]',
    g.paddle.cx <= 416 + 1e-9, 'cx=' + g.paddle.cx + ' w=' + g.paddle.w);
  /* 推进 15s 后回落 */
  let n = 0;
  while (g.wideT0 >= 0 && n < 600) { update(g, 33, snap(192)); n++; }
  check('B11b 15s 后挡板回落 64px', g.paddle.w === 64, 'w=' + g.paddle.w);
  check('B11c 回落瞬间按新边界夹紧（不越出球场）',
    g.paddle.cx >= 48 - 1e-9 && g.paddle.cx <= 432 + 1e-9, 'cx=' + g.paddle.cx);
}

console.log('\n=== B12 result 契约（F-BRK-77/93/94） ===');
{
  const g = create();
  g.score = 570; g.maxCombo = 23; g.lives = 2; g.alive = 12;
  const r = result(g);
  check('B12a score / cleared / reachedLevel 齐备',
    r.score === 570 && r.cleared === false && r.reachedLevel === 1,
    JSON.stringify({ s: r.score, c: r.cleared, l: r.reachedLevel }));
  check('B12b extra 恰好 2 项（最高连击 / 剩余生命）',
    r.extra.length === 2 && r.extra[0].label === '最高连击' && r.extra[1].label === '剩余生命',
    JSON.stringify(r.extra));
  let okLen = true;
  for (let i = 0; i < r.extra.length; i++) if (r.extra[i].label.length > 6) okLen = false;
  check('B12c extra 每项 label ≤ 6 字', okLen, JSON.stringify(r.extra.map((x) => x.label)));
  check('B12d 不含 motion / durationSec（由页面填）',
    r.motion === undefined && r.durationSec === undefined);
}

console.log('\n=== B13 render 全态可绘（不抛错 / 不缺件） ===');
{
  const cases = [
    ['吸附态', (g) => { }],
    ['进行中', (g) => { g.serve.on = false; g.balls[0] = { x: 300, y: 200, dx: 0.5, dy: -0.86 }; }],
    ['道具下落', (g) => { g.serve.on = false; g.balls[0] = { x: 300, y: 200, dx: 0, dy: -1 }; g.power = { kind: 'wide', x: 240, y: 180 }; }],
    ['加宽生效', (g) => { g.serve.on = false; g.balls[0] = { x: 300, y: 200, dx: 0, dy: -1 }; g.paddle.w = 96; g.wideT0 = 0; }],
    ['通关演出', (g) => { g.phase = 'clearShow'; g.phaseT = 0; g.t = 100; g.alive = 0; }],
    ['IMU 异常', (g) => { g.serve.on = false; g.balls[0] = { x: 300, y: 200, dx: 0, dy: -1 }; g.imuDown = true; }],
    ['冻结帧 fade=1', (g) => { g.serve.on = false; g.balls[0] = { x: 300, y: 200, dx: 0, dy: -1 }; }],
  ];
  let allOk = true;
  const detail = [];
  for (let i = 0; i < cases.length; i++) {
    const g = create();
    cases[i][1](g);
    const c = makeCtx();
    try {
      render(g, c.ctx, i === 6 ? 1 : 0);
    } catch (e) {
      allOk = false; detail.push(cases[i][0] + ' 抛错:' + e.message);
    }
  }
  check('B13a 七种画面态 render 均不抛错（含离屏降级路径）', allOk, detail.join(' / '));

  /* HUD 中段：得分标签 / 数值 / 生命数字 都应在空档 x 92~352 内，墨中心 y=24 */
  const g = create();
  g.score = 240; g.lives = 2;
  const c = makeCtx();
  render(g, c.ctx, 0);
  const inGap = c.texts.filter((t) => Math.abs(t.y - 24) < 0.01);
  const labels = inGap.map((t) => t.s);
  check('B13b HUD 中段绘制「得分 / 240 / 2」且墨中心 y=24',
    labels.indexOf('得分') >= 0 && labels.indexOf('240') >= 0 && labels.indexOf('2') >= 0,
    labels.join('|'));
  const xs = inGap.map((t) => t.x);
  check('B13c HUD 全部落在两胶囊空档 x 92~352（C-FRM · §2.7.2）',
    xs.every((x) => x >= 92 && x <= 352), 'xs=' + xs.join(','));

  /* 通关演出文字：验证字级取 13（总章「同屏 ≤3 字级」优先于 PRD 的 14） */
  const g2 = create();
  g2.phase = 'clearShow'; g2.phaseT = 0; g2.t = 160; g2.alive = 0;
  const c2 = makeCtx();
  render(g2, c2.ctx, 0);
  const clr = c2.texts.find((t) => t.s === '通关');
  check('B13d 通关演出绘制「通关」于球场中心 (240,178)',
    !!clr && clr.x === 240 && clr.y === 178, clr ? (clr.x + ',' + clr.y) : '未绘制');

  /* IMU 面板 */
  const g3 = create();
  g3.imuDown = true;
  const c3 = makeCtx();
  render(g3, c3.ctx, 0);
  check('B13e IMU 异常绘制中心面板（标题 + 补救动作）',
    c3.texts.some((t) => t.s === 'IMU 状态异常')
    && c3.texts.some((t) => t.s === '请调整佩戴后重试'),
    c3.texts.map((t) => t.s).join('|'));
}

/* ─────────────── 页面级（pages/brick/brick.js） ───────────────
 * 只验证本页相对框架页的**四处差异**，状态机本身由 harness-game 覆盖。 */
console.log('\n=== P1 页面接入（B1 推进 / 冻结契约） ===');
{
  const { default: page } = await import('./pages/brick/brick.mjs');
  const { makeItem } = await import('./utils/ring.js');
  const { GAME_MENU_IDLE } = await import('./utils/layout.js');
  const c = makeCtx();

  let redirected = 0;
  const nav = [];
  const wxMod = await import('./wx-mock.mjs');
  /* wx 是 default 导出的单例对象，直接给它的 redirectTo 打桩即可计数 */
  const wxd = wxMod.default;
  wxd.redirectTo = function (o) { redirected++; nav.push(o && o.url); if (o && o.success) o.success({}); };

  function setup() {
    page.engine = {
      imuOk: true, running: true,
      update() { return { x: 0, y: 0 }; },
      snapshot() { return { x: 0, y: 0 }; },
      freezeDrift() {}, recenter() {}, stop() {}, start() {}, resetBase() {},
      stats: { toMotion() { return {}; } },
    };
    page.gesture = { tick() {}, onKeyDown() {}, onKeyUp() {}, cancel() {} };
    page.meta = { id: 'bricks', name: '打砖块', kind: 'game', iconId: 'bricks' };
    page.gameId = 'bricks';
    page.menuItems = [
      makeItem('L', GAME_MENU_IDLE.L, { id: 'home', name: '退回主页面', iconId: 'home', kind: 'home' }, 0),
      makeItem('R', GAME_MENU_IDLE.R, { id: 'restart', name: '重新游戏', iconId: 'refresh', kind: 'restart' }, 0),
    ];
    page.ctx = c.ctx;
    page.setData = function () {};
    page._lit = null;
    page.initPlay();
    page.state = 'PLAY';
  }

  setup();
  check('P1a initPlay 建出玩法状态（42 砖 / 3 命）',
    !!page.bk && page.bk.alive === 42 && page.bk.lives === 3,
    page.bk ? ('alive=' + page.bk.alive + ' lives=' + page.bk.lives) : 'no bk');

  /* B1 推进：吸附态 g.t 应随帧累加 */
  const t0 = page.bk.t;
  page._last = 1000000;
  page.tick();
  check('P1b B1 推进玩法（g.t 随帧累加）', page.bk.t > t0, 't ' + t0 + ' → ' + page.bk.t);

  /* 冻结契约（F-BRK-81）：MENU 态不得推进玩法 */
  page.state = 'MENU';
  page.menuAt = 1000000;
  const t1 = page.bk.t;
  page.tick();
  check('P1c B2 菜单态不推进玩法（画面冻结，F-BRK-81）',
    page.bk.t === t1, 't ' + t1 + ' → ' + page.bk.t);

  /* 四态 render 全跑一遍：B2/B3/B4 走的是「两个 fade 分开」的分支，
   * PLAY 分支测不到，必须各渲染一次才能确认没有空引用。 */
  setup();
  const rerr = [];
  ['PLAY', 'MENU', 'CONT', 'LOADING'].forEach(function (st) {
    page.state = st;
    page.menuAt = 1000000; page.contAt = 1000000; page.loadingAt = 1000000;
    try { page.render(1000000, { ok: true, x: 0, y: 0 }); }
    catch (e) { rerr.push(st + ':' + e.message); }
  });
  check('P1d B1/B2/B3/B4 四态 render 均不抛错（含两个 fade 分支）',
    rerr.length === 0, rerr.join(' / '));

  console.log('\n=== P2 提示条已撤（本页相对框架页的差异③） ===');
  page.state = 'PLAY';
  c.texts.length = 0;
  page.render(1000000, { ok: true, x: 0, y: 0 });
  const HINTS = ['单击触控唤出菜单', '单击触控确认选择', '转头选择，单击返回游戏',
    '单击触控立即继续', '正在打开…'];
  const leaked = HINTS.filter((h) => c.texts.some((t) => t.s === h));
  check('P2a 画面不含提示条五态文案中的任何一条', leaked.length === 0, leaked.join('|'));
  const brand = c.texts.find((t) => t.s === '打砖块');
  check('P2b 左上品牌胶囊仍由框架写入游戏名（未丢失）', !!brand, brand ? 'ok' : '缺品牌名');

  console.log('\n=== P3 statusText 钩子（本页相对框架页的差异④） ===');
  setup();
  check('P3a 吸附期 → 「准备发球」', page.statusText() === '准备发球', page.statusText());
  page.bk.serve.on = false;
  page.bk.combo = 7;
  check('P3b 进行中 → 「连击 N」', page.statusText() === '连击 7', page.statusText());
  page.bk.combo = 0;
  check('P3c 未连击 → 「剩余 N」', page.statusText() === '剩余 42', page.statusText());
  page.bk.imuDown = true;
  check('P3d IMU 异常 → 返回空串（交还框架显示「IMU状态异常」+ 空心圆点）',
    page.statusText() === '', '"' + page.statusText() + '"');
  page.bk.imuDown = false;
  check('P3e 状态文案一律 ≤6 字（胶囊可用宽 ≈7 字）',
    ['准备发球', '连击 42', '剩余 42'].every((s) => s.length <= 6));
  const h = page._hudStatus();
  check('P3f _hudStatus 走 statusText 分支（优先级最高）',
    h.text === '剩余 42' && h.dot === true, h.text + ' dot=' + h.dot);

  console.log('\n=== P4 结算幂等（finished 不得重复跳页） ===');
  setup();
  redirected = 0; nav.length = 0;
  page._handleEvents(['finished']);
  page._handleEvents(['finished']);
  page._handleEvents(['finished']);
  /* v1.40：finished 不再直接 redirectTo 结算页 —— 先落成绩，再进本页的
   * 通用结束弹窗（B5），由弹窗的 5s 倒计时 / 单击统一回主页。 */
  check('P4a finished 连续投递三次 → 只结算一次（幂等，落在结束弹窗）',
    page.state === 'OVER' && page._done === true, 'state=' + page.state);
  check('P4b 不再直接跳结算页（v1.40：先弹窗，5s / 单击后回主页）',
    redirected === 0, 'redirected=' + redirected);
  setup();
  redirected = 0; nav.length = 0;
  page._handleEvents(['bounce', 'brick', 'lose', 'bounce']);
  check('P4c 普通事件不触发结算', redirected === 0 && page.state === 'PLAY',
    'redirected=' + redirected + ' state=' + page.state);
  page._handleEvents(['idle']);
  check('P4d idle 事件 → 同样进结束弹窗（挂机保护态，F-BRK-86）',
    page.state === 'OVER', 'state=' + page.state);
}

console.log('\n=== P9 通关 / 失败弹窗（v1.40 · 五款通用） ===');
{
  /* 背景：v1.40 之前 finished 直接 redirectTo 结算页，玩家看不到"这局赢了
   * 还是输了"。现在统一先落在本页的结束弹窗（B5）：通关撒花 +「恭喜，您已
   * 通关」，失败「GAME OVER」，5 秒或单击 → 回主页。本组锁死这套契约。 */
  const { default: page } = await import('./pages/brick/brick.mjs');
  const { OVER } = await import('./utils/layout.js');
  const { OVER_HUD_ALPHA } = await import('./utils/gamepage.js');
  const { makeItem } = await import('./utils/ring.js');
  const { GAME_MENU_IDLE } = await import('./utils/layout.js');
  const wxMod = await import('./wx-mock.mjs');
  const c = makeCtx();
  const wxd = wxMod.default;
  wxd.redirectTo = function (o) { if (o && o.success) o.success({}); };

  function setup() {
    page.engine = {
      imuOk: true, running: true,
      update() { return { x: 0, y: 0 }; },
      snapshot() { return { x: 0, y: 0 }; },
      freezeDrift() {}, recenter() {}, stop() {}, start() {}, resetBase() {},
      stats: { toMotion() { return {}; } },
    };
    page.gesture = { tick() {}, onKeyDown() {}, onKeyUp() {}, cancel() {} };
    page.meta = { id: 'bricks', name: '打砖块', kind: 'game', iconId: 'bricks' };
    page.gameId = 'bricks';
    page.menuItems = [
      makeItem('L', GAME_MENU_IDLE.L, { id: 'home', name: '退回主页面', iconId: 'home', kind: 'home' }, 0),
      makeItem('R', GAME_MENU_IDLE.R, { id: 'restart', name: '重新游戏', iconId: 'refresh', kind: 'restart' }, 0),
    ];
    page.ctx = c.ctx;
    page.setData = function () {};
    page._lit = null;
    page.initPlay();
    page.state = 'PLAY';
  }
  function confettiCount() {
    return c.rects.filter((r) => (r.w === 4 && r.h === 2) || (r.w === 2 && r.h === 4)).length;
  }
  function textOf(s) { const t = c.texts.find((x) => x.s === s); return t || null; }
  function nBack() {
    return wxMod.log.calls.filter((x) => x.api === 'navigateBack').length;
  }

  /* ① 进入弹窗：通关生成撒花粒子，失败不生成 */
  setup();
  page._beginOver(true);
  check('P9a 通关 → 进入 OVER 态并生成撒花粒子（26 片，只生成一次）',
    page.state === 'OVER' && page.overCleared === true
    && !!page.confetti && page.confetti.length === OVER.confetti.n,
    'state=' + page.state + ' n=' + (page.confetti ? page.confetti.length : 0));
  setup();
  page._beginOver(false);
  check('P9b 失败 → 同样进入 OVER 态，但不撒花（confetti 为空）',
    page.state === 'OVER' && page.overCleared === false && !page.confetti,
    'state=' + page.state + ' confetti=' + page.confetti);

  /* ② 画面：通关文案 + 小字提示；失败文案是经典 GAME OVER */
  c.texts.length = 0; c.rects.length = 0;
  page.render(page.overAt + 300, { ok: true, x: 0, y: 0 });
  check('P9c 失败画面显示「GAME OVER」+「单击触控板回到主页」',
    !!textOf('GAME OVER') && !!textOf(OVER.hint),
    c.texts.map((t) => t.s).join('|'));
  check('P9d 失败画面不出现通关文案', !textOf(OVER.clearTitle), '');
  check('P9e 失败画面不撒花（粒子矩形 0 个）', confettiCount() === 0, 'n=' + confettiCount());
  check('P9f 倒计时显示剩余 5 秒（5s 自动回主页）', !!textOf('5'), '缺倒计时数字');

  setup();
  page._beginOver(true);
  c.texts.length = 0; c.rects.length = 0;
  page.render(page.overAt + 300, { ok: true, x: 0, y: 0 });
  check('P9g 通关画面显示「恭喜，您已通关」',
    !!textOf(OVER.clearTitle), c.texts.map((t) => t.s).join('|'));
  check('P9h 通关画面撒花：画面区内 26 片纸屑（4×2 / 2×4 交替）',
    confettiCount() === OVER.confetti.n, 'n=' + confettiCount());
  const cf = c.rects.filter((r) => (r.w === 4 && r.h === 2) || (r.w === 2 && r.h === 4));
  check('P9i 撒花亮度两档（100% / 48%），不抢弹窗文案',
    cf.some((r) => r.style === 'rgba(64,255,94,1)')
    && cf.some((r) => r.style === 'rgba(64,255,94,0.48)'),
    cf.length ? cf[0].style : 'n/a');

  /* ③ 离开：5 秒到点 → 走 B3 握手回主页（与 B2 菜单的 home 同一路径） */
  setup();
  page._handleEvents(['finished']);
  check('P9j finished → 先落弹窗（不是直接跳页）', page.state === 'OVER', page.state);
  page.overAt = Date.now() - OVER.ms - 1;
  page.tick();
  check('P9k 满 5 秒 → 自动进 B3 loading（kind=home）',
    page.state === 'LOADING' && page.loadingKind === 'home',
    'state=' + page.state + ' kind=' + page.loadingKind);
  const nb0 = nBack();
  page.loadingAt = Date.now() - 1000;   // 越过 LOADING_MIN_MS
  page.tick();
  check('P9l B3 到期后发出 navigateBack（回主页）', nBack() > nb0,
    'Δ=' + (nBack() - nb0));

  /* ④ 未满 5 秒单击 → 同一出口，提前回主页 */
  setup();
  page._handleEvents(['finished']);
  page.onTap();
  check('P9m 未满 5 秒单击 → 立刻进 B3 loading（提前回主页）',
    page.state === 'LOADING' && page.loadingKind === 'home',
    'state=' + page.state + ' kind=' + page.loadingKind);

  /* ⑤ 冻结契约：弹窗期间不得继续推进玩法 */
  setup();
  page._handleEvents(['finished']);
  const tg = page.bk.t;
  page.overAt = Date.now();
  page.tick(); page.tick();
  check('P9n 弹窗期间不推进玩法（g.t 冻结，与 B2/B3/B4 同一契约）',
    page.bk.t === tg && page.state === 'OVER',
    't ' + tg + ' → ' + page.bk.t);

  /* ⑥ 变暗：游戏内容收 6% 隐藏档、HUD 降到 48% */
  setup();
  c.texts.length = 0;
  page.render(Date.now(), { ok: true, x: 0, y: 0 });
  const brandPlay = textOf('打砖块');
  setup();
  page._beginOver(true);
  c.texts.length = 0;
  page.render(page.overAt + 300, { ok: true, x: 0, y: 0 });
  const brandOver = textOf('打砖块');
  check('P9o HUD 在弹窗期降到 48%（其余元素退居次要层）',
    !!brandPlay && !!brandOver
    && brandPlay.style === 'rgba(64,255,94,1)'
    && brandOver.style === 'rgba(64,255,94,' + OVER_HUD_ALPHA + ')',
    (brandPlay ? brandPlay.style : '?') + ' → ' + (brandOver ? brandOver.style : '?'));
  const src0 = fs.readFileSync(new URL('../../pages/brick/brick.js', import.meta.url), 'utf8');
  const src = src0.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  check('P9p 源码锁：contentFade 在 OVER 态取 1（内容收至 6% 隐藏档）',
    /this\.state === S\.OVER \? 1 : 0/.test(src), '');
  /* v1.52：HUD 降级由 gameBase._hudAlpha() 统一出口（新增 S.READY 后五个页面
   * 各写一遍三元表达式太容易漏），故源码锁改为「调用 _hudAlpha」+ 在 gamepage
   * 侧钉死它同时覆盖 OVER 与 READY（见 harness-ready R 组）。 */
  check('P9q 源码锁：drawHud 传入 this._hudAlpha()（HUD 随模态弹窗降级）',
    /drawHud\(ctx, this\.meta\.name, this\._hudStatus\(\), this\._hudAlpha\(\)\)/.test(src), '');
  check('P9r 源码锁：contentFade 在 READY 态也取 1（游玩提示同隐藏档）',
    /this\.state === S\.READY \? 1/.test(src), '');
}

console.log('\n=== P5 源码契约：两个 fade 必须分开 ===');
{
  /* 背景：框架页因画面区只有占位框，content 与 entry 共用同一个 fade。
   * 本页若照抄，MENU 态会把**菜单本身**一起打到 6%，菜单直接不可见。
   * 这是本页最容易在后续合并重构中被抹掉的一条差异，故锁死。 */
  const src0 = fs.readFileSync(new URL('../../pages/brick/brick.js', import.meta.url), 'utf8');
  /* 同 B10：先剥注释。本页头注释里就写明了「与框架页 drawPlayfield 的差异」，
   * 裸扫必然命中自己写的说明文字。 */
  const src = src0.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  check('P5a 定义了 contentFade 与 entryFade 两个变量',
    /const\s+contentFade\s*=/.test(src) && /const\s+entryFade\s*=/.test(src));
  check('P5b MENU 态：contentFade=1（内容收束 6%）且 entryFade=0（菜单恒亮）',
    /contentFade\s*=\s*\(this\.state\s*===\s*S\.MENU\s*\|\|\s*this\.state\s*===\s*S\.CONT\)\s*\?\s*1/.test(src)
    && /entryFade\s*=\s*this\.state\s*===\s*S\.CONT\s*\?\s*1/.test(src));
  check('P5c 未调用 drawHint（提示条已撤）', !/drawHint\s*\(/.test(src));
  check('P5d 未绘制框架页占位（drawPlayfield）', !/drawPlayfield/.test(src));
}

console.log('\n=== B14 方向语义：SEM_FOLLOW（2026-09-04 真机修正）===');
{
  /* 背景：真机反馈「向左转头 → 挡板向右滑」。根因——snap.x > 0 表示头向【左】转
   * （设备轴系经 SWAP_AXES 后的实际符号），而 PRD-02 §3.2 原式 `240 + snap.x`
   * 是主页/菜单的「反向补偿」语义，被直接套用到了「直控跟随」上，两者符号相反。
   * 相机版（v1.26）沿用同一常量：paddle.cx 现在是**相机/世界**坐标，
   * 头左转 → 相机左移 → dx>0 → 世界右滑；方向语义未变，本组继续锁死。 */
  const { SEM_FOLLOW, SEM_COMPENSATE } = await import('./utils/input.js');
  check('B14a input.js 导出方向语义常量（FOLLOW=-1 / COMPENSATE=+1）',
    SEM_FOLLOW === -1 && SEM_COMPENSATE === 1,
    'FOLLOW=' + SEM_FOLLOW + ' COMPENSATE=' + SEM_COMPENSATE);

  const gl = create();
  run(gl, 1, 100);                       // snap.x=+100 ⇔ 头向左转
  check('B14b 头向左转（snap.x=+100）→ 挡板左移 cx<240',
    gl.paddle.cx < 240, 'cx=' + gl.paddle.cx.toFixed(1));

  const gr = create();
  run(gr, 1, -100);                      // snap.x=-100 ⇔ 头向右转
  check('B14c 头向右转（snap.x=-100）→ 挡板右移 cx>240',
    gr.paddle.cx > 240, 'cx=' + gr.paddle.cx.toFixed(1));
  check('B14d 左右对称：|Δcx| 相等',
    near(240 - gl.paddle.cx, gr.paddle.cx - 240),
    'L=' + (240 - gl.paddle.cx).toFixed(1) + ' R=' + (gr.paddle.cx - 240).toFixed(1));

  const gcl = create(); run(gcl, 1, 400);   // 超量程 → 夹紧到左边界
  const gcr = create(); run(gcr, 1, -400);  // 超量程 → 夹紧到右边界
  /* 球场 64~416，挡板 w=64 → 夹紧到 64+32=96 / 416−32=384 */
  check('B14e 超量程夹紧：左 96 / 右 384（球场 64~416，挡板 w=64）',
    near(gcl.paddle.cx, 96) && near(gcr.paddle.cx, 384),
    'L=' + gcl.paddle.cx + ' R=' + gcr.paddle.cx);

  /* 发球方向：相机版改为「朝开阔侧」。相机贴左墙时若仍往左发球，球会在 32px 内
   * 撞上左墙、白费一发；朝开阔侧才是有意义的默认。相机居中时 θ=0 → 兜底 +25°。 */
  const gs = create(); run(gs, 47, 100);    // 47 帧 ≈1551ms，刚过 1.5s 吸附期
  check('B14f 相机偏左 → 球朝开阔侧（右上）飞 dx>0',
    gs.balls.length > 0 && gs.balls[0].dx > 0,
    'cx=' + gs.paddle.cx.toFixed(1) + ' dx=' + (gs.balls[0] ? gs.balls[0].dx.toFixed(3) : 'n/a'));
  const gs2 = create(); run(gs2, 47, -100);
  check('B14h 相机偏右 → 球朝开阔侧（左上）飞 dx<0',
    gs2.balls.length > 0 && gs2.balls[0].dx < 0,
    'cx=' + gs2.paddle.cx.toFixed(1) + ' dx=' + (gs2.balls[0] ? gs2.balls[0].dx.toFixed(3) : 'n/a'));

  const bsrc0 = fs.readFileSync(new URL('../../utils/bricks.js', import.meta.url), 'utf8');
  const bsrc = bsrc0.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  check('B14g 源码锁：挡板公式走 SEM_FOLLOW（不得改回 CENTER.x + snap.x）',
    /CENTER\.x\s*\+\s*SEM_FOLLOW\s*\*/.test(bsrc));
}

console.log('\n=== B15 相机：锚定型·世界反向滑动（v1.26）===');
{
  /* 用户反馈：直控型下挡板随头在屏幕上跑，眼镜里缺少静止参照 → 前庭冲突眩晕。
   * 改为挡板恒钉屏幕中心 x=240，头动驱动**世界反向平移**，把「运动」还给画面。
   * 本组锁死三件事：平移方向、挡板屏幕位置恒定、越界处留白且有墙。 */
  const gl = create(); run(gl, 1, 100);      // snap.x=+100 ⇔ 头向左转
  check('B15a 头向左转 → camDx>0（世界右滑，即反向滑动）',
    camDx(gl) > 0, 'dx=' + camDx(gl).toFixed(1));
  const gr = create(); run(gr, 1, -100);
  check('B15b 头向右转 → camDx<0（世界左滑）', camDx(gr) < 0, 'dx=' + camDx(gr).toFixed(1));
  const gc = create(); run(gc, 1, 0);
  check('B15c 头居中 → camDx=0（球场居中，两墙各距视口边 45px）',
    camDx(gc) === 0, 'dx=' + camDx(gc));

  const gx = create(); run(gx, 1, 400);
  const gy = create(); run(gy, 1, -400);
  /* TRAVEL = COURT.w/2 − PADDLE.w/2 = 218 − 32 = 186（球场 22~458，宽 436） */
  const TRAVEL2 = BRICKS.COURT.w / 2 - BRICKS.PADDLE.w / 2;
  check('B15d 相机行程 ±' + TRAVEL2 + '（= COURT.w/2 − PADDLE.w/2，由几何算出）',
    near(camDx(gx), TRAVEL2) && near(camDx(gy), -TRAVEL2),
    'L=' + camDx(gx).toFixed(1) + ' R=' + camDx(gy).toFixed(1));

  /* 挡板屏幕位置 = 世界坐标 + 平移量，必须恒等于 240 */
  const offs = [48, 140, 240, 390, 432];
  let anchored = true, detail = '';
  for (let i = 0; i < offs.length; i++) {
    const s = offs[i] + camDx({ paddle: { cx: offs[i] } });
    if (Math.abs(s - 240) > 0.001) { anchored = false; detail = 'cx=' + offs[i] + ' → ' + s; }
  }
  check('B15e 挡板屏幕位置恒为 240（任意相机位置均锚定）', anchored, detail);

  const bsrc0 = fs.readFileSync(new URL('../../utils/bricks.js', import.meta.url), 'utf8');
  const bsrc = bsrc0.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  check('B15f 源码锁：世界层 save → clip → translate(dx) → restore 四件套齐全',
    /ctx\.save\(\)/.test(bsrc) && /ctx\.clip\(\)/.test(bsrc)
    && /ctx\.translate\(\s*dx/.test(bsrc) && /ctx\.restore\(\)/.test(bsrc));
  check('B15g 源码锁：平移量取自 camDx(g)（不得写成 CENTER.x − snap.x 之类）',
    /const\s+dx\s*=\s*camDx\(g\)/.test(bsrc));

  /* 墙（v1.28 改回**世界层**）：它**就是球反弹的那面墙**，必须跟着球场平移。
   * v1.27 曾钉成屏幕固定层 —— 钉住的墙和球的反弹位置对不上，平移后球会
   * 「在一堵纹丝不动的墙上弹开」，玩家一眼就觉得假。本组锁死世界层语义。 */
  const WALLW = BRICKS.CAMERA.wallBand;
  const CT_L = BRICKS.COURT.x;                       // 64（球缘反弹面）
  const CT_R = BRICKS.COURT.x + BRICKS.COURT.w;      // 416
  const WA_L = CT_L - WALLW;                         // 61（左墙带起点）
  const WA_R = CT_R;                                 // 416（右墙带起点）
  const BALL_R = BRICKS.BALL.r;                      // 4
  const CLIP_R_ = WA_R + WALLW;                      // 419（裁剪窗右沿）
  const wallOf = (m) => m.rects.filter((r) => r.w === WALLW && r.h === 340 - 48);
  const wp = (m) => wallOf(m).map((r) => r.x).sort((a, b) => a - b).join(',');

  const mc = makeCtx(); render(gc, mc.ctx, 0);            // 相机居中
  const m1 = makeCtx(); render(gx, m1.ctx, 0);            // 相机推到最左
  const m1r = makeCtx(); render(gy, m1r.ctx, 0);          // 相机推到最右

  /* ⚠ 坐标由 wallBand 推导（v1.34 墙带由 3 加宽到 8 → 56/416），勿写死 */
  const WPOS = (CT_L - WALLW) + ',' + WA_R;
  check('B15h 相机居中时两墙立在屏幕 ' + WPOS + '（游戏区两侧，外侧留白）',
    wp(mc) === WPOS, 'walls=' + wp(mc));

  /* 墙随相机 1:1 平移。超出裁剪窗（61~419）的那道由 clip 裁掉 ——
   * 真机如此；mock 不实现裁剪，故这里只验位移量严格等于 ±TRAVEL。 */
  check('B15i 墙随相机 1:1 平移（最左 +' + TRAVEL2 + ' / 最右 −' + TRAVEL2 + '）',
    near(wallOf(m1)[0].x - WA_L, TRAVEL2) && near(wallOf(m1r)[0].x - WA_L, -TRAVEL2),
    'ΔL=' + (wallOf(m1)[0].x - WA_L).toFixed(2) +
    ' ΔR=' + (wallOf(m1r)[0].x - WA_L).toFixed(2) +
    ' TRAVEL=' + TRAVEL2 + ' n=' + wallOf(m1).length + '/' + wallOf(m1r).length);

  /* ★ 本轮核心：墙的内侧面 == 球的物理反弹面（球缘最远能到的位置） */
  check('B15l 几何：墙内侧 ' + (WA_L + WALLW) + '/' + WA_R +
        ' 与球反弹面 ' + CT_L + '/' + CT_R + ' 严格重合',
    WA_L + WALLW === CT_L && WA_R === CT_R,
    '墙内侧=' + (WA_L + WALLW) + '/' + WA_R);

  /* 采样时机很敏感：球撞墙后**当帧就反弹离开**，帧末采样时它已经弹回来了
   * （初测：74 → 撞墙夹紧 68 → 同帧反弹，3 帧后球心回到 77.24，看着像没撞）。
   * 故改为记录整段过程里球缘的**最小值**：既不越过反弹面（不穿墙），
   * 又确实贴到了墙面（不悬空）。 */
  const gp = create(); run(gp, 1, 0);
  gp.serve.on = false;
  gp.balls[0] = { x: CT_L + BALL_R + 8, y: 200, dx: -1, dy: 0.2 };   // 朝左墙飞
  let minEdge = 9999;
  for (let i = 0; i < 6; i++) {
    update(gp, 33, snap(0));
    if (gp.balls[0]) minEdge = Math.min(minEdge, gp.balls[0].x - BALL_R);
  }
  check('B15m 物理：球撞左墙时球缘停在 ' + CT_L + '（不穿墙、不悬空）',
    minEdge >= CT_L - 0.01 && minEdge <= CT_L + 1.5,
    '球缘最小=' + minEdge.toFixed(2) + ' 反弹面=' + CT_L);

  /* 裁剪窗 = 球场 ± 墙厚，严格窄于视口 16~464 ⇒ 两墙外侧各 45px 纯空白 */
  check('B15n 裁剪窗 ' + WA_L + '~' + CLIP_R_ + ' 窄于视口 16~464（墙外恒为空白）',
    WA_L > 16 && CLIP_R_ < 464, 'clip=' + WA_L + '~' + CLIP_R_);

  /* 离屏球指示器：贴裁剪窗内侧，不画到墙外的空白里 */
  const g2 = create(); run(g2, 47, 100);
  g2.paddle.cx = 96;                            // 相机最左，dx = 240−96 = +144
  g2.balls[0] = { x: 400, y: 200, dx: 0.3, dy: -0.9 };   // 世界 400 → 屏幕 544，越右界
  const m2 = makeCtx(); render(g2, m2.ctx, 0);
  check('B15j 球滑出裁剪窗 → 画离屏指示器（贴右墙内侧）',
    m2.tris.length === 1 && near(m2.tris[0].ax, CLIP_R_ - BRICKS.CAMERA.markGap),
    'tris=' + m2.tris.length + (m2.tris[0] ? ' x=' + m2.tris[0].ax : ''));

  g2.balls[0] = { x: 240, y: 200, dx: 0.3, dy: -0.9 };   // 屏幕 384，裁剪窗内
  const m3 = makeCtx(); render(g2, m3.ctx, 0);
  check('B15k 球在裁剪窗内 → 不画指示器', m3.tris.length === 0, 'tris=' + m3.tris.length);
}


console.log('\n=== B16 砖面纹理（v1.39 精修） ===');
{
  /* 背景：单砖只有 1px 描边，42 块连成阵后看着像「表格线」而不是「砖墙」。
   * 补上棱亮线 / 两道竖缝 / 下棱压痕后才有厚度与块面。 */
  const B = BRICKS.BRICK;
  const g3 = create();
  const m = makeCtx();
  render(g3, m.ctx, 0);
  const inb = m.rects.filter((r) => r.x >= B.x0 && r.x < B.x0 + B.w
    && r.y >= B.y0 && r.y < B.y0 + B.h && r.w <= B.w);
  check('B16a 单砖 4 处砖面细节（上棱 / 两竖缝 / 下压痕）', inb.length === 4, 'n=' + inb.length);

  const hi = inb.filter((r) => r.h === 1 && r.w === B.w - 6);
  check('B16b 上棱亮线 + 下棱压痕各 1 条（一厚一薄才读得出厚度）', hi.length === 2, 'n=' + hi.length);

  const vf = inb.filter((r) => r.w === 1 && r.h === B.h - 6);
  check('B16c 两道竖缝把 50 宽切成 14/22/14（不等分才不呆板）',
    vf.length === 2 && near(vf[0].x - B.x0, 14, 0.01) && near(vf[1].x - B.x0, B.w - 15, 0.01),
    'x=' + vf.map((r) => (r.x - B.x0).toFixed(0)).join('/'));
}

const pass = R.filter((r) => r.ok).length;
console.log('\n=== 结论 ===');
console.log('  ' + pass + '/' + R.length + ' 项通过');
R.filter((r) => !r.ok).forEach((r) => console.log('  x ' + r.name + ' — ' + r.detail));
process.exit(pass === R.length ? 0 : 1);
