/* 滚球迷宫玩法模块 + 页面接入断言（本地 node，无需宿主）
 * 运行：cd tests/navsim && node build.mjs && node harness-marble.mjs
 *
 * 覆盖：
 *   M1  几何：448×294 / 廊 65 / 墙 AABB 7 个 / 洞贴壁走廊 32 / 移动洞 11.5~27.5
 *   M2  相机：AIM 1:1 全显 / PLAY 球心锁定恒 (240,192) / 世界偏移与裁剪窗
 *   M3  棘轮：加深推进 / 回摆不回退 / 越中立反向 / 限幅 ±8 / 划船式净推进
 *   M4  碰撞：7 AABB 推出 / e=0 沿墙滑行 / 陷入外墙推回迷宫内 / 不误推
 *   M5  洞与吸入：阈值 R−2（静止 12 / 移动 14）/ 失误计数 / 回起点 0.6s
 *   M6  状态机：AIM 不计时 / LAUNCH 0.4s / 起跑后计时起算 / 超时重开
 *   M7  移动洞：匀速往返 ±16 / 端点不缓动 / 周期 6.4s / 中位封路端位让路
 *   M8  IMU 异常：整体冻结（不归零乱跑）
 *   M9  静态红线：无 wx/sfx/Date.now、不画框架资产
 *   M10 result 契约：计分公式与下限 0
 *   M11 方向语义锁：两轴各自乘 SEM，且 SEM 不取自 input.js 的 SIGN
 *   M12 冻结语义：不调 update 则 g.t 不推进
 *   P1  页面接入：B1 推进 / B2 冻结 / 四态 render 不抛错
 *   P2  提示条已撤 + 品牌胶囊仍在
 *   P3  statusText 三态（待校准 / 校准中 / 游戏中）+ IMU 回落
 *   P4  结算幂等 + 事件只播音不结算
 *   P5  源码契约：两个 fade 分开且 MENU_FADE = 0.55
 *   P6  **单击按 phase 分流**（AIM 就绪=开跑 / PLAY=唤菜单 / 过场=不响应）
 *   P7  **rel() 必须在 update() 之后调用**（PRD §4.3 硬顺序）
 */
import fs from 'node:fs';

const {
  create, update, render, result, camOf, w2s, aimCam, axisStep, sucked,
  resolveWall, resolveAll, tryLaunch, PH,
} = await import('./utils/marble.js');
const { MARBLE: M, VIEWPORT } = await import('./utils/layout.js');
const { SEM_FOLLOW } = await import('./utils/input.js');

const R = [];
function check(name, cond, detail) {
  R.push({ name: name, ok: !!cond, detail: detail || '' });
  console.log('  [' + (cond ? 'PASS' : 'FAIL') + '] ' + name + (detail ? '  — ' + detail : ''));
}
function near(a, b, e) { return Math.abs(a - b) <= (e === undefined ? 0.001 : e); }

/* 记录型 ctx。
 * ⚠ 两处与 harness-egg 不同（都是本作特性导致的，别照抄）：
 *   ① **双轴 translate**：本作相机是双轴的（球心锁定 x/y 都跟），egg/brick
 *      只有横轴。mock 若只累加 tx，纵向所有断言都会错。
 *   ② **fill() 与 stroke() 必须各自落记录**：只落 stroke 时，"只 fill 不
 *      stroke"的图形（如球 r7 实心）永远录不进来 —— 这个坑在 plane 上已经
 *      踩过一次（侦察机也是 3 顶点三角，顶点数不是可靠判别式）。 */
function makeCtx() {
  const texts = [], rects = [], fills = [], strokes = [], moves = [];
  let tx = 0, ty = 0;
  const stack = [];
  let pend = null;                       // 最近一次 arc（beginPath…fill/stroke）
  const ctx = new Proxy({}, {
    get(t, k) {
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'fillText') return (s, x, y) => { texts.push({ s: String(s), x: x, y: y }); };
      if (k === 'createRadialGradient') return undefined;   // 强制走同心圆降级
      if (k === 'save') return () => { stack.push([tx, ty]); };
      if (k === 'restore') return () => { const s = stack.length ? stack.pop() : [0, 0]; tx = s[0]; ty = s[1]; };
      if (k === 'translate') return (dx, dy) => { tx += dx || 0; ty += dy || 0; };
      if (k === 'arc') return (cx, cy, r) => { pend = { cx: cx + tx, cy: cy + ty, r: r }; };
      if (k === 'fill') return () => { if (pend) fills.push({ cx: pend.cx, cy: pend.cy, r: pend.r, style: t.fillStyle }); };
      if (k === 'stroke') return () => { if (pend) strokes.push({ cx: pend.cx, cy: pend.cy, r: pend.r, style: t.strokeStyle, lw: t.lineWidth }); };
      if (k === 'fillRect') return (x, y, w, h) => {
        rects.push({ x: x + tx, y: y + ty, w: w, h: h, style: t.fillStyle });
      };
      if (k === 'moveTo') return (x, y) => { moves.push({ x: x + tx, y: y + ty }); };
      return k in t ? t[k] : function () {};
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  return { ctx: ctx, texts: texts, rects: rects, fills: fills, strokes: strokes, moves: moves };
}

const OKS = { ok: true, x: 0, y: 0 };
const DOWN = { ok: false, x: 0, y: 0 };
function rel(x, y) { return { ok: true, x: x || 0, y: y || 0 }; }

/* 推进 n 帧（每帧 33ms）。
 * ⚠ snap / rel 一律**对象原样透传**，不允许包一层 snap()：
 *   包了会把 DOWN 整体当 x 传下去、ok 被强制置 true，IMU 异常分支永远进不去
 *   （这个坑让 plane 付出过 16 条假失败的代价）。 */
function run(g, frames, s, r) {
  const ev = [];
  const ss = s || OKS;
  const rr = r || rel(0, 0);
  for (let i = 0; i < frames; i++) {
    const e = update(g, 33, ss, rr);
    for (let j = 0; j < e.length; j++) ev.push(e[j]);
    if (g.over) break;
  }
  return ev;
}
function has(ev, k) { return ev.indexOf(k) >= 0; }

/* ───────────────────────── M1 几何 ───────────────────────── */
console.log('\n=== M1 几何（PRD §7.3 常量表） ===');
{
  const H = M.WO + M.LANE + M.WI + M.LANE + M.WI + M.LANE + M.WI + M.LANE + M.WO;
  check('M1a 竖向自洽 8+65+6+65+6+65+6+65+8 = 294', near(H, M.MAZE.h), H + ' vs ' + M.MAZE.h);
  check('M1b 迷宫 448×294', M.MAZE.w === 448 && M.MAZE.h === 294, M.MAZE.w + '×' + M.MAZE.h);
  check('M1c 墙 AABB 共 7 个', M.WALLS.length === 7, String(M.WALLS.length));
  check('M1d 廓净高 65 = 球直径的 4.6 倍', M.LANE === 65 && near(M.LANE / (M.R_BALL * 2), 4.64, 0.01),
    M.LANE + ' / ' + Math.round(M.LANE / (M.R_BALL * 2) * 100) / 100);
  check('M1e 转折口 64（440−376 与 72−8）',
    near(440 - 376, M.GAP) && near(72 - 8, M.GAP), (440 - 376) + '/' + (72 - 8));
  check('M1f W1/W3 缺口在右、W2 缺口在左（蛇形折返）',
    M.WALLS[4].x === 8 && M.WALLS[5].x === 72 && M.WALLS[6].x === 8,
    M.WALLS[4].x + '/' + M.WALLS[5].x + '/' + M.WALLS[6].x);
  check('M1g 隔墙厚 6 @48%、外墙厚 8 @72%', M.WI === 6 && M.WO === 8, M.WI + '/' + M.WO);

  /* 洞位贴壁：洞心距最近壁 = R */
  const top = [8, 79, 150, 221], bot = [73, 144, 215, 286];
  const side = ['top', 'bot', 'top', 'bot', 'bot', 'top'];
  const lane = [0, 0, 1, 1, 2, 3];
  let allWall = true, allCorr = true, allMid = true;
  const T = M.R_HOLE - M.SUCK_MARGIN;
  for (let i = 0; i < M.HOLES.length; i++) {
    const h = M.HOLES[i], L = lane[i];
    const d = side[i] === 'top' ? (h.y - top[L]) : (bot[L] - h.y);
    if (!near(d, h.r)) allWall = false;
    let lo, hi;
    if (side[i] === 'top') { lo = top[L] + h.r + T; hi = bot[L] - M.R_BALL; }
    else { lo = top[L] + M.R_BALL; hi = bot[L] - h.r - T; }
    if (!near(hi - lo, 32)) allCorr = false;
    const mid = (top[L] + bot[L]) / 2;
    if (!(mid >= lo - 0.001 && mid <= hi + 0.001)) allMid = false;
  }
  check('M1h 6 个静止洞一律贴壁（洞心距壁 = R）', allWall, 'R=' + M.R_HOLE);
  check('M1i 贴壁走廊一律 32px（> 球直径 14）', allCorr, '32px');
  check('M1j 每个洞让出的可走区都含所属廊中心线（恒有解）', allMid, '');

  /* 移动洞：中位封路、端位让路 */
  const Rm = M.MOVER.r, Tm = Rm - M.SUCK_MARGIN;
  const midCorr = (M.LANE / 2) - Tm - M.R_BALL;
  const endCorr = (286 - M.R_BALL) - ((M.MOVER.y - M.MOVER.amp) + Tm);
  check('M1k 移动洞中位走廊 11.5（< 球直径 → 必须等时机）',
    near(midCorr, 11.5) && midCorr < M.R_BALL * 2, String(midCorr));
  check('M1l 移动洞端位走廊 27.5（≥25 → 恒有解）',
    near(endCorr, 27.5) && endCorr >= 25, String(endCorr));
  check('M1m 移动洞行程 237.5~269.5 不越出 L4（221~286）',
    M.MOVER.y - M.MOVER.amp - Rm >= 221 && M.MOVER.y + M.MOVER.amp + Rm <= 286,
    (M.MOVER.y - M.MOVER.amp - Rm) + '~' + (M.MOVER.y + M.MOVER.amp + Rm));
  check('M1n 起点/终点均不落在任何洞的吸入圈内', (() => {
    for (const p of [M.START, M.END]) {
      for (const h of M.HOLES) if (Math.hypot(p.x - h.x, p.y - h.y) < h.r + 10) return false;
      if (Math.hypot(p.x - M.MOVER.x, p.y - M.MOVER.y) < Rm + 10) return false;
    }
    return true;
  })(), '起点↔H1 = 111.5，终点↔HM = 140');
  check('M1o 隧穿安全：STEP_MAX 8 << 漏检阈值 2·Rb+墙厚 = 20',
    M.STEP_MAX < 2 * M.R_BALL + M.WI, M.STEP_MAX + ' < ' + (2 * M.R_BALL + M.WI));
}

/* ───────────────────────── M2 相机 ───────────────────────── */
console.log('\n=== M2 相机（§5.1 F-LAB-12/13） ===');
{
  check('M2a 视口中心 = (240,192)',
    VIEWPORT.x + VIEWPORT.w / 2 === 240 && VIEWPORT.y + VIEWPORT.h / 2 === 192,
    (VIEWPORT.x + VIEWPORT.w / 2) + ',' + (VIEWPORT.y + VIEWPORT.h / 2));
  /* AIM：盘面 1:1 全显 */
  const g = create();
  run(g, 1, OKS, rel(0, 0));
  const tl = w2s(0, 0, g.cam), br = w2s(M.MAZE.w, M.MAZE.h, g.cam);
  check('M2b AIM 盘面左上角 = (16,45)', near(tl.x, 16) && near(tl.y, 45), tl.x + ',' + tl.y);
  check('M2c AIM 盘面右下角 (464,339) 落在视口内',
    br.x <= 464 && br.y <= 340, br.x + ',' + br.y);
  check('M2d AIM 垂直居中（上下各留 1px）', near(tl.y - 44, 1) && near(340 - br.y, 1),
    (tl.y - 44) + '/' + (340 - br.y));
  const bs = w2s(g.ball.x, g.ball.y, g.cam);
  check('M2e AIM 球屏幕位 = (76,85.5)（与 PRD §4.1.1 一致）',
    near(bs.x, 76) && near(bs.y, 85.5), bs.x + ',' + bs.y);
  check('M2f 初始中心距 195.5px（≈9.8° @20px/°）',
    near(Math.hypot(bs.x - 240, bs.y - 192), 195.5, 0.1),
    String(Math.round(Math.hypot(bs.x - 240, bs.y - 192) * 10) / 10));

  /* PLAY：球心锁定 —— 任意球位，屏幕坐标恒为 (240,192) */
  let allCenter = true;
  for (const p of [[60, 40.5], [224, 148], [400, 260], [30, 280], [420, 30]]) {
    const c = camOf(p[0], p[1]);
    const s = w2s(p[0], p[1], c);
    if (!near(s.x, 240) || !near(s.y, 192)) allCenter = false;
  }
  check('M2g 球心锁定：任意球位屏幕坐标恒 (240,192)', allCenter, '5 组坐标');

  /* AIM 就绪相机 == PLAY 开局相机（§4.1.3 无缝硬契约） */
  const need = camOf(M.START.x, M.START.y);
  check('M2h 就绪相机 = camOf(START) = (−164,−107.5)',
    near(need.x, -164) && near(need.y, -107.5), need.x + ',' + need.y);
  const aimReady = aimCam(8.2, 5.325);
  check('M2i AIM 转头 8.2°/5.325° 恰达就绪位（无缝，无推近跳变）',
    near(aimReady.x, need.x, 0.5) && near(aimReady.y, need.y, 0.5),
    Math.round(aimReady.x * 10) / 10 + ',' + Math.round(aimReady.y * 10) / 10);

  /* 限位：转头 30° 不得整屏空白，且限位覆盖就绪点 */
  const c30 = aimCam(30, 30);
  const visW = Math.max(0, Math.min(448, c30.x + 448) - Math.max(0, c30.x));
  check('M2j 转头 30° 迷宫仍可见（限位生效，不整屏空白）', visW > 0, visW + 'px 可见');
  check('M2k 限位范围包含就绪点（否则永远无法开局）',
    need.x >= M.AIM_CAM.x - M.AIM_CLAMP.x && need.x <= M.AIM_CAM.x + M.AIM_CLAMP.x
    && need.y >= M.AIM_CAM.y - M.AIM_CLAMP.y && need.y <= M.AIM_CAM.y + M.AIM_CLAMP.y,
    'x ' + (M.AIM_CAM.x - M.AIM_CLAMP.x) + '~' + (M.AIM_CAM.x + M.AIM_CLAMP.x));
}

/* ───────────────────────── M3 棘轮 ───────────────────────── */
console.log('\n=== M3 棘轮（F-LAB-01/04/06） ===');
{
  check('M3a 首帧无位移（只建基准）', axisStep(5, null, -1) === 0, String(axisStep(5, null, -1)));
  check('M3b 加深同号 → 推进（限幅 −8）', axisStep(15, 10, -1) === -8, String(axisStep(15, 10, -1)));
  check('M3c 回摆 → 不回退（0）', axisStep(12, 15, -1) === 0, String(axisStep(12, 15, -1)));
  check('M3d 回到中立 → 不动', axisStep(0, 12, -1) === 0, String(axisStep(0, 12, -1)));
  check('M3e 越过中立反向 → 反向推进（+8）', axisStep(-5, 0, -1) === 8, String(axisStep(-5, 0, -1)));
  check('M3f 限幅 ±8 生效（40° 也只走 8px）', axisStep(40, 0, -1) === -8, String(axisStep(40, 0, -1)));
  check('M3g 两轴符号独立（sem 按轴传）',
    axisStep(5, 0, 1) === 8 && axisStep(5, 0, -1) === -8,
    axisStep(5, 0, 1) + ' / ' + axisStep(5, 0, -1));
  /* 划船：来回摆动应持续产生净位移 */
  let total = 0, lv = 0, nlv;
  for (let i = 0; i < 6; i++) { nlv = Math.min(10, lv + 3); total += axisStep(nlv, lv, -1); lv = nlv; }
  const afterSwing = total;
  for (let i = 0; i < 8; i++) { nlv = Math.max(-10, lv - 3); total += axisStep(nlv, lv, -1); lv = nlv; }
  check('M3h 单向加深产生位移', afterSwing !== 0, String(afterSwing));
  check('M3i 反向摆动继续产生位移（划船式，可无限推进）', total !== afterSwing,
    afterSwing + ' → ' + total);
  /* 死区 1.5 由 input.rel 施加，模块只消费已过死区的值 */
  check('M3j 本册死区 1.5° 严于公共 3°（F-LAB-03）', M.DEAD_DEG < 3, String(M.DEAD_DEG));

  /* 端到端：头左转 → 球世界 x 减小 */
  const g = create();
  g.phase = PH.PLAY; g.lastRel = { x: 0, y: 0 };
  const x0 = g.ball.x;
  run(g, 1, OKS, rel(6, 0));
  check('M3k 头左转（rel.x>0）→ 球向世界左移', g.ball.x < x0, x0 + ' → ' + g.ball.x);
  check('M3l 单帧位移 ≤ STEP_MAX', x0 - g.ball.x <= M.STEP_MAX + 0.001,
    String(Math.round((x0 - g.ball.x) * 100) / 100));
  /* 头停 → 球停（无惯性拖尾） */
  const x1 = g.ball.x;
  run(g, 5, OKS, rel(6, 0));       // 保持同一 rel 不再加深
  check('M3m 头停（rel 不变）→ 球立即静止，无惯性拖尾', g.ball.x === x1,
    x1 + ' → ' + g.ball.x);
}

/* ───────────────────────── M4 碰撞 ───────────────────────── */
console.log('\n=== M4 碰撞（§6.2 / F-LAB-42/43） ===');
{
  /* 贴墙穿透 → 推出到接触位 */
  const b1 = { x: 12, y: 150 };
  resolveAll(b1, M.R_BALL);
  check('M4a 贴左外墙穿透 → 推出到 x = 15（8+7）', near(b1.x, 15), String(b1.x));

  /* 陷入外墙 → 必须推回迷宫内（不能推到迷宫外） */
  const b2 = { x: 4, y: 150 };
  resolveAll(b2, M.R_BALL);
  check('M4b 陷入左外墙中心 → 推回迷宫内（非 −7）', b2.x >= M.MAZE.w * 0 + M.R_BALL && near(b2.x, 15),
    String(b2.x));

  /* 未接触不误推。
   * ⚠ 选点必须落在廊**净空**内：L3 净空是 y ∈ (144+6+7, 215−7) = (157, 208)。
   *   取 y = 150 会正好压在 W2 隔墙下缘（W2 = y 144~150）上、被推出到 157
   *   —— 那样测到的是"碰撞推出"而非"不误推"，是**用例选点错误**不是模块缺陷。
   *   同理 x 也要避开 W2（x72~440）/ W3（x8~376）的端点 72 与 376。 */
  const b3 = { x: 200, y: 180 };
  resolveAll(b3, M.R_BALL);
  check('M4c 未接触不误推（位置不变）', b3.x === 200 && b3.y === 180, b3.x + ',' + b3.y);

  /* e=0 沿墙滑行：斜向撞上隔墙后，切向仍前进 */
  const b4 = { x: 200, y: 70 };         // 隔墙 W1 在 y 73~79
  resolveAll(b4, M.R_BALL);
  check('M4d 撞隔墙下方 → 推到 y = 66（73−7）', near(b4.y, 66), String(b4.y));
  check('M4e 撞墙后 x 保持不变（切向保留 = 滑行，法向归零）', b4.x === 200, String(b4.x));

  /* 连续推进撞墙不穿透 */
  const g = create();
  g.phase = PH.PLAY; g.lastRel = { x: 0, y: 0 };
  let inside = false;
  for (let i = 0; i < 60; i++) {
    run(g, 1, OKS, rel(10, 0));         // 一直向"左"推
    for (const w of M.WALLS) {
      if (g.ball.x > w.x && g.ball.x < w.x + w.w && g.ball.y > w.y && g.ball.y < w.y + w.h) inside = true;
    }
    if (g.ball.x < 0 || g.ball.x > M.MAZE.w) inside = true;
  }
  check('M4f 连续 60 帧推墙不穿透、不出迷宫', !inside,
    'ball = ' + Math.round(g.ball.x * 10) / 10 + ',' + Math.round(g.ball.y * 10) / 10);

  /* 球始终在迷宫内 */
  const g2 = create();
  g2.phase = PH.PLAY; g2.lastRel = { x: 0, y: 0 };
  let out = false;
  for (let i = 0; i < 200; i++) {
    const a = (i % 40) / 40 * Math.PI * 2;
    run(g2, 1, OKS, rel(Math.sin(a) * 10, Math.cos(a) * 10));
    if (g2.ball.x < 0 || g2.ball.x > M.MAZE.w || g2.ball.y < 0 || g2.ball.y > M.MAZE.h) out = true;
  }
  check('M4g 绕圈推 200 帧球始终在迷宫内', !out,
    Math.round(g2.ball.x * 10) / 10 + ',' + Math.round(g2.ball.y * 10) / 10);
}

/* ───────────────────── M5 洞与吸入 ───────────────────── */
console.log('\n=== M5 洞与吸入（F-LAB-50/52/55） ===');
{
  check('M5a 吸入阈值：静止 R−2 = 12', M.R_HOLE - M.SUCK_MARGIN === 12,
    String(M.R_HOLE - M.SUCK_MARGIN));
  check('M5b 吸入阈值：移动 Rm−2 = 14', M.MOVER.r - M.SUCK_MARGIN === 14,
    String(M.MOVER.r - M.SUCK_MARGIN));

  const g = create();
  g.phase = PH.PLAY;
  g.ball.x = M.HOLES[0].x; g.ball.y = M.HOLES[0].y;
  check('M5c 洞心 → 判定吸入', sucked(g) === true, '');
  g.ball.y = M.HOLES[0].y - 13;
  check('M5d 距洞心 13 > 12 → 不吸入', sucked(g) === false, '');
  g.ball.y = M.HOLES[0].y - 11;
  check('M5e 距洞心 11 < 12 → 吸入', sucked(g) === true, '');

  /* 端到端：吸入 → 失误 +1、进 RESPAWN、0.6s 后回起点 */
  const g2 = create();
  g2.phase = PH.PLAY; g2.lastRel = { x: 0, y: 0 };
  g2.ball.x = M.HOLES[0].x; g2.ball.y = M.HOLES[0].y - 5;   // 已在吸入圈内
  const ev = run(g2, 1, OKS, rel(0, 0));
  check('M5f 触发 suck 事件', has(ev, 'suck'), ev.join(','));
  check('M5g 失误计数 +1', g2.miss === 1, String(g2.miss));
  check('M5h 进入 RESPAWN 过场', g2.phase === PH.RESPAWN, g2.phase);
  const tBefore = g2.timeLeftMs;
  run(g2, 20, OKS, rel(0, 0));                               // 0.66s
  check('M5i 0.6s 后回到 PLAY', g2.phase === PH.PLAY, g2.phase);
  check('M5j 球回起点 (60,40.5)',
    near(g2.ball.x, M.START.x) && near(g2.ball.y, M.START.y),
    g2.ball.x + ',' + g2.ball.y);
  check('M5k 回起点期间**计时不暂停**（F-LAB-56）', g2.timeLeftMs < tBefore,
    tBefore + ' → ' + Math.round(g2.timeLeftMs));
  check('M5l RESPAWN 后棘轮基准重置（防回摆误判为反向推进）',
    g2.lastRel !== null, g2.lastRel ? 'ok' : 'null');
}

/* ───────────────────── M6 状态机 ───────────────────── */
console.log('\n=== M6 状态机（§4.1 / F-LAB-08/32） ===');
{
  const g = create();
  check('M6a 初始 AIM、未就绪', g.phase === PH.AIM && g.ready === false, g.phase + '/' + g.ready);
  check('M6b 未就绪时 tryLaunch 无效', tryLaunch(g) === false, String(tryLaunch(g)));

  /* ⚠ ready 事件只在「未就绪 → 就绪」的**那一帧**发一次，所以必须在对准循环里
   *   逐帧收集；等循环退出后再单独 run 一帧是拿不到的（那时 g.ready 已为 true，
   *   走的是迟滞分支）。这是**用例采集时机问题**，不是事件漏发。 */
  let guard = 0;
  const evAim = [];
  while (!g.ready && guard++ < 300) {
    for (const e of run(g, 1, OKS, rel(8.2, 5.325))) evAim.push(e);
  }
  check('M6c 对准后进入就绪', g.ready === true, String(g.ready));
  check('M6d AIM 阶段**不计时**（F-LAB-08）', g.timeLeftMs === 75000, String(g.timeLeftMs));
  check('M6e AIM 阶段不推进物理（球仍在起点）',
    near(g.ball.x, M.START.x) && near(g.ball.y, M.START.y), g.ball.x + ',' + g.ball.y);
  check('M6f 就绪瞬间发出 ready 事件（整段只发一次）',
    has(evAim, 'ready') && evAim.filter(e => e === 'ready').length === 1, evAim.join(','));

  check('M6g 就绪后 tryLaunch 成功 → LAUNCH', tryLaunch(g) === true && g.phase === PH.LAUNCH, g.phase);
  const bx = g.ball.x;
  run(g, 1, OKS, rel(25, 25));
  check('M6h LAUNCH 期物理不推进（缓冲期转头无效）', g.ball.x === bx, String(g.ball.x));
  check('M6i LAUNCH 期不计时', g.timeLeftMs === 75000, String(g.timeLeftMs));

  guard = 0;
  const evl = [];
  while (g.phase === PH.LAUNCH && guard++ < 100) {
    const e = update(g, 33, OKS, rel(8.2, 5.325));
    for (const x of e) evl.push(x);
  }
  check('M6j 0.4s 后进入 PLAY', g.phase === PH.PLAY, g.phase);
  check('M6k 起跑发出 launch 事件', has(evl, 'launch'), evl.join(','));

  const t0 = g.timeLeftMs;
  run(g, 5, OKS, rel(8.2, 5.325));
  check('M6l PLAY 起算计时', g.timeLeftMs < t0, t0 + ' → ' + Math.round(g.timeLeftMs));

  /* 超时 → TIMEOUT 过场 → 本关重开 */
  const g2 = create();
  g2.phase = PH.PLAY; g2.timeLeftMs = 20; g2.miss = 3; g2.lastRel = { x: 0, y: 0 };
  guard = 0;
  while (g2.phase === PH.PLAY && guard++ < 60) run(g2, 1, OKS, rel(0, 0));
  check('M6m 超时 → TIMEOUT 过场（不直接消失，有反馈）', g2.phase === PH.TIMEOUT, g2.phase);
  guard = 0;
  while (g2.phase === PH.TIMEOUT && guard++ < 100) run(g2, 1, OKS, rel(0, 0));
  check('M6n 过场完 → 回到 PLAY（本关重开，F-LAB-66）', g2.phase === PH.PLAY, g2.phase);
  check('M6o 计时重置 75s', g2.timeLeftMs === 75000, String(g2.timeLeftMs));
  check('M6p 失误清零', g2.miss === 0, String(g2.miss));
  check('M6q 球回起点', near(g2.ball.x, M.START.x) && near(g2.ball.y, M.START.y),
    g2.ball.x + ',' + g2.ball.y);
  check('M6r 无限重试：重开后不结束（无失败结局，F-LAB-72）', g2.over === false, String(g2.over));
}

/* ───────────────────── M7 移动洞 ───────────────────── */
console.log('\n=== M7 移动洞 HM（§7.3.6） ===');
{
  const g = create();
  g.phase = PH.PLAY; g.lastRel = { x: 0, y: 0 };
  const ys = [];
  for (let i = 0; i < 200; i++) { run(g, 1, OKS, rel(0, 0)); ys.push(g.moverY); }
  const lo = Math.min.apply(null, ys), hi = Math.max.apply(null, ys);
  check('M7a 行程下界 237.5', near(lo, 237.5, 0.5), String(Math.round(lo * 10) / 10));
  check('M7b 行程上界 269.5', near(hi, 269.5, 0.5), String(Math.round(hi * 10) / 10));
  /* 匀速：相邻帧位移恒定（端点除外） */
  let maxJump = 0;
  for (let i = 1; i < ys.length; i++) maxJump = Math.max(maxJump, Math.abs(ys[i] - ys[i - 1]));
  check('M7c 匀速 10px/s（单帧 33ms ≈ 0.33px）', maxJump < 0.5,
    String(Math.round(maxJump * 1000) / 1000) + 'px/帧');
  check('M7d 端点不缓动（到界即反向，无减速段）',
    near(lo, M.MOVER.y - M.MOVER.amp, 0.01) && near(hi, M.MOVER.y + M.MOVER.amp, 0.01),
    lo + '~' + hi);
  /* 中位封路：球走中心线必被吸（除非等时机） */
  const g2 = create();
  g2.phase = PH.PLAY;
  g2.ball.x = M.MOVER.x; g2.ball.y = M.MOVER.y; g2.moverY = M.MOVER.y;
  check('M7e 洞在中位、球走中心线 → 被吸入（逼玩家等时机）', sucked(g2) === true, '');
  g2.moverY = M.MOVER.y - M.MOVER.amp;                      // 洞到顶端
  g2.ball.y = M.MOVER.y + 27;                                // 走下方通道
  check('M7f 洞在端位、球走另一侧 → 安全通过（恒有解）', sucked(g2) === false, '');
  check('M7g 往返周期 6.4s', near(M.MOVER.amp * 4 / M.MOVER.speed, 6.4),
    String(M.MOVER.amp * 4 / M.MOVER.speed));
}

/* ───────────────────── M8 IMU 异常 ───────────────────── */
console.log('\n=== M8 IMU 异常（F-LAB-09） ===');
{
  const g = create();
  g.phase = PH.PLAY; g.lastRel = { x: 0, y: 0 };
  const x0 = g.ball.x, t0 = g.timeLeftMs;
  run(g, 3, DOWN, { ok: false, x: 0, y: 0 });
  check('M8a 球不动（不归零乱跑）', g.ball.x === x0, String(g.ball.x));
  check('M8b 计时冻结（不推进也不重置）', g.timeLeftMs === t0, String(g.timeLeftMs));
  check('M8c imuDown 置位（供 statusText 回落框架文案）', g.imuDown === true, String(g.imuDown));
  /* 恢复后正常推进 */
  run(g, 1, OKS, rel(6, 0));
  check('M8d IMU 恢复后可继续推进', g.ball.x < x0 && g.imuDown === false, String(g.ball.x));
  /* AIM 态异常不误触发就绪 */
  const g2 = create();
  run(g2, 5, DOWN, { ok: false, x: 0, y: 0 });
  check('M8e AIM 态异常不误判就绪', g2.ready === false && g2.phase === PH.AIM,
    g2.phase + '/' + g2.ready);
}

/* ───────────────── M9 静态红线（先剥注释） ───────────────── */
console.log('\n=== M9 静态红线（剥注释后扫描） ===');
{
  /* ⚠ 必须剥注释：头注释里就写着红线说明，裸扫一定误判 */
  const src = fs.readFileSync(new URL('../../utils/marble.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('M9a 不 import wx（纯模块）', !/from\s+'wx'/.test(src), '');
  check('M9b 不 import sfx（播音归页面）', !/from\s+'.*sfx/.test(src), '');
  check('M9c 不 import storage（落盘归页面）', !/from\s+'.*storage/.test(src), '');
  check('M9d 不出现 Date.now（时间源只有 g.t）', !/Date\.now/.test(src), '');
  check('M9e 不出现 setTimeout / setInterval（禁定时器）',
    !/setTimeout|setInterval/.test(src), '');
  check('M9f 不画视口框 / 四角角标（归框架 C-FRM-05）',
    !/outerCorners|VIEWPORT_TICK/.test(src), '');
  check('M9g 不画提示条（本册已取消）', !/drawHint|HINT/.test(src), '');
  check('M9h 迷宫几何只读 layout.MARBLE，不就地写死坐标',
    /from\s+'\.\/layout\.js'/.test(src) && !/448\s*,\s*294\s*;/.test(src), '');
}

/* ───────────────────── M10 result ───────────────────── */
console.log('\n=== M10 result 契约（§8） ===');
{
  const g = create();
  g.timeLeftMs = 30000; g.miss = 0; g.cleared = true;
  check('M10a 剩余 30s 通关 = 300 分', result(g).score === 300, String(result(g).score));
  g.miss = 2;
  check('M10b 扣失误 2×50 → 200 分', result(g).score === 200, String(result(g).score));
  g.timeLeftMs = 1000; g.miss = 9;
  check('M10c 下限 0（不出现负数，D-LAB-02）', result(g).score === 0, String(result(g).score));
  check('M10d cleared 透传', result(g).cleared === true, String(result(g).cleared));
  check('M10e reachedLevel 恒为 1（单关，F-LAB-63）', result(g).reachedLevel === 1,
    String(result(g).reachedLevel));
  check('M10f extra 含用时与失误两项', result(g).extra.length === 2,
    JSON.stringify(result(g).extra));
}

/* ───────────────── M11 方向语义锁 ───────────────── */
console.log('\n=== M11 方向语义锁 ===');
{
  const src = fs.readFileSync(new URL('../../utils/marble.js', import.meta.url), 'utf8');
  check('M11a 源码走 MARBLE.SEM（不直连 input.js 的 SIGN）',
    /M\.SEM\.x/.test(src) && /M\.SEM\.y/.test(src), '');
  check('M11b AIM 相机与 PLAY 位移**同乘 SEM**（方向语义一致）',
    /M\.SEM\.x \* M\.AIM_GAIN/.test(src) && /s \* M\.PLAY_GAIN/.test(src), '');
  check('M11c 未直接引用 SIGN（改它会连主页菜单一起反转）',
    !/\bSIGN\b/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), '');
  check('M11d SEM 与 input.SEM_FOLLOW 同向（真机锚定一致）',
    M.SEM.x === SEM_FOLLOW, M.SEM.x + ' vs ' + SEM_FOLLOW);
  check('M11e 轴步进按轴传 sem，未写死为 x',
    /axisStep\(rx,[\s\S]{0,60}M\.SEM\.x/.test(src) && /axisStep\(ry,[\s\S]{0,60}M\.SEM\.y/.test(src), '');
}

/* ───────────────────── M12 冻结语义 ───────────────────── */
console.log('\n=== M12 冻结语义（B2/B3/B4 靠此自动冻结） ===');
{
  const g = create();
  g.phase = PH.PLAY; g.lastRel = { x: 0, y: 0 };
  run(g, 3, OKS, rel(0, 0));
  const t = g.t;
  /* 不调 update */
  check('M12a 不调 update 则 g.t 不推进', g.t === t, String(g.t));
  update(g, 33, OKS, rel(0, 0));
  check('M12b 调一次即推进 33ms', g.t === t + 33, String(g.t));
  check('M12c update 只依赖传入 dt，不读系统时钟', (() => {
    const g2 = create(); g2.phase = PH.PLAY; g2.lastRel = { x: 0, y: 0 };
    update(g2, 10, OKS, rel(0, 0));
    return g2.t === 10;
  })(), 'dt=10 → t=10');
}

/* ══════════════════ 页面级断言 ══════════════════ */
console.log('\n=== P1 页面接入（B1 推进 / 冻结契约） ===');
{
  const { default: page } = await import('./pages/marble/marble.mjs');
  const { makeItem } = await import('./utils/ring.js');
  const { GAME_MENU_IDLE } = await import('./utils/layout.js');
  const c = makeCtx();

  let redirected = 0;
  const wxMod = await import('./wx-mock.mjs');
  const wxd = wxMod.default;
  wxd.redirectTo = function (o) { redirected++; if (o && o.success) o.success({}); };

  function setup() {
    page.engine = {
      imuOk: true, running: true,
      update() { return { ok: true, x: 0, y: 0 }; },
      rel() { return { ok: true, x: 0, y: 0 }; },
      snapshot() { return { x: 0, y: 0 }; },
      freezeDrift() {}, recenter() {}, stop() {}, start() {}, resetBase() {},
      stats: { toMotion() { return {}; } },
    };
    page.gesture = { tick() {}, onKeyDown() {}, onKeyUp() {}, cancel() {} };
    page.meta = { id: 'marble', name: '滚球迷宫', kind: 'game', iconId: 'marble' };
    page.gameId = 'marble';
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
  check('P1a initPlay 建出玩法状态（AIM / 0 失误 / 75s）',
    !!page.mb && page.mb.phase === PH.AIM && page.mb.miss === 0 && page.mb.timeLeftMs === 75000,
    page.mb ? (page.mb.phase + ' miss=' + page.mb.miss + ' t=' + page.mb.timeLeftMs) : 'no mb');

  const t0 = page.mb.t;
  page._last = 1000000;
  page.tick();
  check('P1b B1 推进玩法（g.t 随帧累加）', page.mb.t > t0, 't ' + t0 + ' → ' + page.mb.t);

  page.state = 'MENU';
  page.menuAt = 1000000;
  const t1 = page.mb.t;
  page.tick();
  check('P1c B2 菜单态不推进玩法（画面冻结，冻结契约）',
    page.mb.t === t1, 't ' + t1 + ' → ' + page.mb.t);

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

  console.log('\n=== P2 提示条已撤 + 品牌胶囊仍在（差异③） ===');
  setup();
  page.state = 'PLAY';
  c.texts.length = 0;
  page.render(1000000, { ok: true, x: 0, y: 0 });
  const HINTS = ['单击触控唤出菜单', '单击触控确认选择', '转头选择，单击返回游戏',
    '单击触控立即继续', '正在打开…'];
  const leaked = HINTS.filter((h) => c.texts.some((t) => t.s === h));
  check('P2a 画面不含提示条五态文案中的任何一条', leaked.length === 0, leaked.join('|'));
  const brand = c.texts.find((t) => t.s === '滚球迷宫');
  check('P2b 左上品牌胶囊仍由框架写入游戏名', !!brand, brand ? 'ok' : '缺品牌名');

  console.log('\n=== P3 statusText 三态（差异④ / F-LAB-18） ===');
  setup();
  check('P3a AIM 未转头 → 「状态：待校准」', page.statusText() === '状态：待校准', page.statusText());
  page.mb.cam = { x: -10, y: -1 };                       // 已转头但未就绪
  check('P3b AIM 对准中 → 「状态：校准中」', page.statusText() === '状态：校准中', page.statusText());
  page.mb.ready = true;
  check('P3c AIM 就绪 → 仍为「状态：校准中」', page.statusText() === '状态：校准中', page.statusText());
  page.mb.phase = PH.LAUNCH;
  check('P3d 起跑缓冲起 → 「状态：游戏中」', page.statusText() === '状态：游戏中', page.statusText());
  page.mb.phase = PH.PLAY;
  check('P3e PLAY → 「状态：游戏中」', page.statusText() === '状态：游戏中', page.statusText());
  page.mb.imuDown = true;
  check('P3f IMU 异常 → 返回空串（交还框架显示「IMU状态异常」）',
    page.statusText() === '', JSON.stringify(page.statusText()));
  page.mb.imuDown = false;
  check('P3g 状态文案一律 ≤6 字（胶囊可用宽 ≈7 字）',
    ['状态：待校准', '状态：校准中', '状态：游戏中'].every((s) => s.length <= 6), '6 字');
  check('P3h _hudStatus 走 statusText 分支（优先级最高）',
    page._hudStatus().text === '状态：游戏中', page._hudStatus().text);

  console.log('\n=== P4 结算幂等 + 事件只播音不结算 ===');
  setup();
  redirected = 0;
  page._handleEvents(['finished']);
  page._handleEvents(['finished']);
  page._handleEvents(['finished']);
  /* v1.40：finished 不再直接 redirectTo 结算页 —— 先落成绩，再进本页的通用
   * 结束弹窗（B5 通关 / GAME OVER），由弹窗的 5s 倒计时 / 单击统一回主页。 */
  check('P4a finished 连续投递三次 → 只结算一次（幂等，落在结束弹窗）',
    page.state === 'OVER' && page._done === true && redirected === 0,
    'state=' + page.state + ' redirected=' + redirected);
  const { OVER: OVER_MB } = await import('./utils/layout.js');
  check('P4g OVER 态 render 不抛错（含 drawOver + HUD 降级分支）', (() => {
    try { page.render(Date.now(), { ok: true, x: 0, y: 0 }); return true; }
    catch (e) { return false; }
  })(), '');
  page.overAt = Date.now() - OVER_MB.ms - 1;
  page.tick();
  check('P4e 满 5 秒 → 自动进 B3 loading（kind=home）',
    page.state === 'LOADING' && page.loadingKind === 'home',
    'state=' + page.state + ' kind=' + page.loadingKind);
  setup();
  page._handleEvents(['finished']);
  page.onTap();
  check('P4f 未满 5 秒单击 → 提前回主页（与倒计时同一出口）',
    page.state === 'LOADING' && page.loadingKind === 'home',
    'state=' + page.state + ' kind=' + page.loadingKind);
  setup();
  redirected = 0;
  page._handleEvents(['ready', 'launch', 'suck', 'goal', 'timeout', 'restart']);
  check('P4b 六类玩法事件只播音、不结算', redirected === 0, 'redirected=' + redirected);
  check('P4c buildResult 含 motion 六字段', (() => {
    const r = page.buildResult();
    return r.motion && 'yawUtil' in r.motion && 'pitchUtil' in r.motion
      && 'yawAmpDeg' in r.motion && 'pitchAmpDeg' in r.motion
      && 'tapCount' in r.motion && 'tapLatencyMs' in r.motion;
  })(), '');
  check('P4d durationSec 用游戏内时钟 g.t（AIM 不计入时长）',
    typeof page.buildResult().durationSec === 'number', String(page.buildResult().durationSec));

  console.log('\n=== P5 源码契约（两个 fade 分开 + MENU_FADE=0.55） ===');
  {
    const src = fs.readFileSync(new URL('../../pages/marble/marble.js', import.meta.url), 'utf8');
    check('P5a 定义 MENU_FADE = 0.55（非 1，B2 只是暂停快选）',
      /const MENU_FADE = 0\.55/.test(src), '');
    check('P5b contentFade 与 entryFade 是两个变量（菜单不随内容一起变暗）',
      /const contentFade =/.test(src) && /const entryFade =/.test(src), '');
    /* ⚠ 源码里 MENU 态**不是**写成 `S.MENU ? 0`，而是走三元链末尾的 `: 0` 兜底：
     *     entryFade = CONT ? 1 : LOADING ? loadingFade : 0
     *   语义上 MENU 态 === 0（菜单恒亮），但按字面找 "MENU ? 0" 必然匹配不上。
     *   故断言**整条三元链的字面结构**，同时也顺带钉死了 CONT = 1。 */
    check('P5c entryFade 在 MENU 态为 0（菜单恒亮 · 走三元末尾 : 0 兜底）',
      /const entryFade = this\.state === S\.CONT \? 1\s*: this\.state === S\.LOADING \? loadingFade : 0;/
        .test(src), '');
    check('P5d 不画提示条（无 drawHint 调用）', !/drawHint/.test(src), '');
    check('P5e 页面 import 了 rel 通道（本作特有，差异⑤）',
      /engine\.rel\(/.test(src), '');
  }

  console.log('\n=== P6 单击按 phase 分流（PRD §4.1 · 本作特有） ===');
  setup();
  check('P6a AIM 未就绪时单击 → 不生效（防误触开跑）', (() => {
    page.onTap();
    return page.mb.phase === PH.AIM;
  })(), page.mb.phase);
  page.mb.ready = true;
  check('P6b AIM 就绪时单击 → 起跑缓冲（不是唤菜单）', (() => {
    page.onTap();
    return page.mb.phase === PH.LAUNCH && page.state === 'PLAY';
  })(), page.mb.phase + '/' + page.state);
  setup();
  page.mb.phase = PH.PLAY;
  check('P6c PLAY 态单击 → 唤出 B2 菜单', (() => {
    page.onTap();
    return page.state === 'MENU';
  })(), page.state);
  setup();
  page.mb.phase = PH.LAUNCH;
  check('P6d LAUNCH 过场中单击 → 不响应（不打断缓冲）', (() => {
    page.onTap();
    return page.state === 'PLAY' && page.mb.phase === PH.LAUNCH;
  })(), page.state + '/' + page.mb.phase);
  setup();
  page.mb.phase = PH.RESPAWN;
  check('P6e RESPAWN 过场中单击 → 不响应', (() => {
    page.onTap();
    return page.state === 'PLAY';
  })(), page.state);
  setup();
  page.mb.phase = PH.PLAY;
  page.engine.imuOk = false;
  redirected = 0;
  check('P6f PLAY 态 + IMU 异常 → 单击直接结束游戏（§10）', (() => {
    page.onTap();
    return redirected === 1;
  })(), 'redirected=' + redirected);
  setup();
  page.mb.phase = PH.AIM;
  page.engine.imuOk = false;
  redirected = 0;
  check('P6g AIM 态 + IMU 异常 → 单击不结束（画面停在等待恢复）', (() => {
    page.onTap();
    return redirected === 0 && page.mb.phase === PH.AIM;
  })(), 'redirected=' + redirected);

  console.log('\n=== P7 rel() 必须在 update() 之后（PRD §4.3 硬顺序） ===');
  {
    const src = fs.readFileSync(new URL('../../pages/marble/marble.js', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const iUpd = src.indexOf('this.engine.update(');
    const iRel = src.indexOf('this.engine.rel(');
    check('P7a 源码中 update() 出现在 rel() 之前',
      iUpd > 0 && iRel > iUpd, 'update@' + iUpd + ' rel@' + iRel);
    check('P7b rel() 传入本册死区 DEAD_DEG（1.5°，非公共 3°）',
      /rel\(MARBLE\.DEAD_DEG\)/.test(src), '');
    /* 行为验证：engine 记录调用顺序 */
    setup();
    const order = [];
    page.engine.update = function () { order.push('update'); return { ok: true, x: 0, y: 0 }; };
    page.engine.rel = function () { order.push('rel'); return { ok: true, x: 0, y: 0 }; };
    page._last = 1000000;
    page.tick();
    check('P7c 运行时调用顺序为 update → rel',
      order[0] === 'update' && order[1] === 'rel', order.join(' → '));
  }

  console.log('\n=== P8 渲染层：球恒在屏幕中心 + 迷宫外留白 ===');
  {
    setup();
    page.mb.phase = PH.PLAY;
    page.mb.ball.x = 300; page.mb.ball.y = 200;
    page.mb.cam = camOf(page.mb.ball.x, page.mb.ball.y);
    c.fills.length = 0;
    page.render(1000000, { ok: true, x: 0, y: 0 });
    /* 球是唯一 r7 的实心圆，且必须落在 (240,192) */
    const ball = c.fills.filter((f) => Math.abs(f.r - M.R_BALL) < 0.001);
    check('P8a 画出的球（r7 实心）存在', ball.length >= 1, String(ball.length));
    check('P8b 球恒画在视口中心 (240,192)',
      ball.length > 0 && ball.every((f) => near(f.cx, 240) && near(f.cy, 192)),
      ball.length ? (ball[0].cx + ',' + ball[0].cy) : 'n/a');
    /* 世界层：墙的 x 应随相机平移，而非钉死 */
    const walls = c.rects.filter((r) => r.h === M.WO || r.h === M.WI || r.w === M.WO);
    check('P8c 世界层墙体已随相机平移（x 不等于世界坐标 0）',
      walls.length > 0 && walls.some((r) => !near(r.x, 0)),
      walls.length ? String(Math.round(walls[0].x * 10) / 10) : 'n/a');
    /* 洞描边环（r14）应存在，且已换算到屏幕系 */
    const holes = c.strokes.filter((s) => Math.abs(s.r - M.R_HOLE) < 0.001);
    check('P8d 静止洞描边环 r14 已绘制', holes.length >= 1, String(holes.length));
    check('P8e 洞也随相机平移（屏幕系坐标 ≠ 世界坐标 170）',
      holes.length > 0 && holes.some((h) => !near(h.cx, 170)),
      holes.length ? String(Math.round(holes[0].cx * 10) / 10) : 'n/a');
  }
}

console.log('\n=== M13 起点环只在 AIM / LAUNCH（v1.38 回归） ===');
{
  /* 背景：起跑后起点环仍留在场上，被误读成「又一个洞 / 要回到这里」。
   * 终点环是目标，恒显示；起点环只在 AIM / LAUNCH 出现。 */
  const hasStart = (g, c) => c.strokes.some(
    (o) => near(o.r, M.R_PORT) && near(o.cx, M.START.x + (16 - g.cam.x))
      && near(o.cy, M.START.y + (44 - g.cam.y)));
  const g = create();
  const c1 = makeCtx();
  render(g, c1.ctx, 1);
  check('M13a AIM 阶段起点环显示（准星对准用）', hasStart(g, c1), 'phase=' + g.phase);

  const c2 = makeCtx();
  g.phase = 'PLAY';
  render(g, c2.ctx, 1);
  check('M13b PLAY 阶段起点环隐藏（起跑后不再出现）', !hasStart(g, c2), 'phase=' + g.phase);

  const c3 = makeCtx();
  g.phase = 'RESPAWN';
  render(g, c3.ctx, 1);
  check('M13c RESPAWN 回起点时同样不画（球是被动送回，无需再对准）',
    !hasStart(g, c3), 'phase=' + g.phase);

  const c4 = makeCtx();
  render(g, c4.ctx, 1);
  const hasEnd = c4.strokes.some(
    (o) => near(o.r, M.R_PORT) && near(o.cx, M.END.x + (16 - g.cam.x)));
  check('M13d 终点环恒显示（它是目标，全程可见）', hasEnd, '');
}

/* ───────────────────────── 汇总 ───────────────────────── */
const pass = R.filter((r) => r.ok).length;
const fail = R.length - pass;
console.log('\n' + '='.repeat(56));
console.log('harness-marble：' + pass + ' 通过 / ' + fail + ' 失败 / 共 ' + R.length + ' 项');

if (fail) {
  console.log('\n失败项：');
  R.filter((r) => !r.ok).forEach((r) => console.log('  ✗ ' + r.name + '  — ' + r.detail));
}
console.log('='.repeat(56));
process.exit(fail ? 1 : 0);
