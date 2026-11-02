/* bricks.js —— 《打砖块》玩法模块（PRD-02 · P0）
 *
 * 接口契约（PRD-02 §12.2）：
 *   create(opts)          → g 状态对象
 *   update(g, dtMs, snap) → events[]（本册不播音，由页面播）
 *   render(g, ctx, fade)  → 画球场/砖阵/道具/挡板/球/HUD 中段
 *   result(g)             → { score, cleared, reachedLevel, extra[] }
 *
 * 【三条硬红线 · 违反即冻结语义失效】
 *   1. **禁止 Date.now() 与任何定时器**：全部计时基于 update(dtMs) 累加的
 *      g.t（F-BRK-82）。框架页在 B2/B3/B4 期间不调 update，g.t 自动停走
 *      —— 冻结与续算无需任何显式 freeze/resume。
 *   2. **禁止 import sfx / storage**：update 返回事件数组，播音与落盘全归
 *      页面（F-BRK-85）。本模块因此可在 node 下直接跑断言。
 *   3. **禁止自绘遮罩或自行降 alpha**：变暗一律由页面把 fade 传进来，走
 *      ring.js 的 fadeTo（F-BRK-83）。render 的第三参 fade 即为此设。
 *
 * 【映射形态】**锚定型·单轴 yaw 相机**（F-BRK-01 · 相机版 v1.26）：
 *   只消费 snap.x，snap.y 全程忽略。挡板**恒定在屏幕中心 x=240**，
 *   头动驱动【世界反向平移】——头左转，画面右滑，挡板在世界里向左走。
 *   语义与主页八向环、B2 二向菜单同族（SEM_FOLLOW·反向补偿），详见 input.js。
 *   相机每帧位移已由 InputEngine 内建 ≤12px 限幅，本册不得二次平滑（F-BRK-03）。
 *
 * 【为什么改】直控型下挡板随头在屏幕上移动，眼镜里画面对比参照物跟着头跑，
 *   前庭冲突导致眩晕。锚定型把「运动」还给世界、把「静止」留给注视点，
 *   与 PRD-04 滚球迷宫的相对位移模型同源。
 */

import { L, g as gcol } from './theme.js';
import { CENTER, VIEWPORT, BRICKS } from './layout.js';
import { SEM_FOLLOW } from './input.js';
import {
  clamp, text, fillRoundRect, strokeRoundRect, fillCircle,
  fillGlow, fillRipple, fadeBand,
} from './draw.js';
import { fadeTo } from './ring.js';

const COURT = BRICKS.COURT;
const PADDLE = BRICKS.PADDLE;
const BALL = BRICKS.BALL;
const BRK = BRICKS.BRICK;
const FLOOR = BRICKS.FLOOR;
const PROGRESS = BRICKS.PROGRESS;
const HUDX = BRICKS.HUDX;
const SERVE = BRICKS.SERVE;
const POWER = BRICKS.POWER;
const FX = BRICKS.FX;
const CAM = BRICKS.CAMERA;

const TOTAL = BRK.cols * BRK.rows;          // 6 × 7 = 42
const R = BALL.r;                           // 4（球 AABB 8×8，F-BRK-38）
const COURT_R = COURT.x + COURT.w;          // 416
const COURT_B = COURT.y + COURT.h;          // 308（落底判定线，F-BRK-14）
const CX = COURT.x + COURT.w / 2;           // 240
const CY = COURT.y + COURT.h / 2;           // 178
const PADDLE_TOP = PADDLE.cy - PADDLE.h / 2; // 294
const PADDLE_BOT = PADDLE.cy + PADDLE.h / 2; // 304

/* 视口（框架画边框与刻度的地方，本册不得在上面作画） */
const VX = VIEWPORT.x;                       // 16
const VXR = VIEWPORT.x + VIEWPORT.w;         // 464
const VY = VIEWPORT.y;                       // 44
const VYB = VIEWPORT.y + VIEWPORT.h;         // 340

/* 裁剪窗 = 球场 ± 墙厚：世界层只在这道窗里可见，越界部分直接消失 → 留白。
 * 宽度与 CAMERA 联立（见 layout.js COURT 注释），勿单独改。 */
const CLIP_L = COURT.x - CAM.wallBand;       // 56（v1.34：墙带由 3 加宽到 8）
const CLIP_R = COURT_R + CAM.wallBand;       // 424
const CLIP_W = CLIP_R - CLIP_L;              // 368
/* 边界墙（**世界层**）：立在球场边界的**外侧**，贴球场那一面就是球的反弹面。
 *   左墙：内侧面 x = 64（= COURT.x），带子向外（左）铺 wallBand 到 56
 *   右墙：内侧面 x = 416（= COURT_R），带子向外（右）铺 wallBand 到 424
 * 球缘最左 64 / 最右 416 —— 与内侧面紧贴不重叠（物理反弹面 ≡ 墙内侧面）。
 * 两墙随相机平移，滑出裁剪窗即被裁掉，故不再需要「是否压到框架边框」
 * 的判断（v1.26 的 edgeSkip 由此取消）。 */
/* 标准档行程半幅：球场中心 → 挡板能到达的最远处，由几何算出（勿硬编码） */
const TRAVEL = COURT.w / 2 - PADDLE.w / 2;   // 352/2 − 32 = 144

/* 世界 → 屏幕的横向绘制偏移。挡板恒钉 CENTER.x，故相机中心 == 挡板世界坐标。
 * dx > 0 表示世界整体右移（头左转）。范围 ±144。供 render 与断言共用。 */
export function camDx(g) {
  return CENTER.x - g.paddle.cx;
}

/* 固定子步（F-BRK-37）：1/120s，最多 12 步 —— 掉帧到 10fps（dt=100ms）时
 * 单次位移仍 ≤2px，远小于砖厚 12 与挡板厚 10，结构上不可能穿透（F-BRK-39）。 */
const SUB_MS = 1000 / 120;
const SUB_MAX = 12;

const SHARD_MAX = 16;   // 碎片池定长（§12.3 禁止每帧创建对象）

/* ── 离屏砖阵精灵（§12.3 性能预算）────────────────────────────────
 * 48 砖逐帧直绘 = 96 次 draw call；预绘后每帧仅 1 次 drawImage。
 * ⚠ new Canvas 属宿主 API，故全程 try/catch + typeof 守卫：拿不到就
 *   静默降级为逐砖直绘，绝不因为性能优化而把页面拖崩。
 * ⚠ fade > 0（B2/B3/B4 冻结帧）时不走精灵：精灵是原档亮度，无法随
 *   fade 收束。此时画面本就静止，直绘的开销不再重要。 */
const SP_W = BRK.pitchX * (BRK.cols - 1) + BRK.w; // 340
const SP_H = BRK.pitchY * (BRK.rows - 1) + BRK.h; // 102
let _sp = null, _spCtx = null, _spOwner = null, _spKey = -1;

/* 单砖：50×12 圆角 2。v1.39 由「一块素砖」补足砖面质感 —— 只靠 1px 描边
 * 在 480×352 上是一片模糊的长条，42 块连成阵看着像表格线而不是墙：
 *   ① 上棱亮线 @α×0.55（顶边受光，砖才有厚度）
 *   ② 两道竖缝 @α×0.34（把 50 宽切成 14/22/14，比例不等分才不呆板）
 *   ③ 下棱压痕 @α×0.30（底边背光，与上棱构成一厚一薄的两条边）
 * ⚠ 亮度按 b.alpha（行亮度）等比缩放 —— 行与行之间有亮度差是既有的可读性
 *   设计（ROW_ALPHA），细节不能"抹平"这个梯度。
 * ⚠ 竖缝 y 留 3px 上下边距、横条 x 留 3px 左右边距：不贴边，才不会和
 *   圆角描边糊在一起。 */
function paintBrick(ctx, col, x, y, alpha) {
  fillRoundRect(ctx, x, y, BRK.w, BRK.h, 2, col(L.P12));
  strokeRoundRect(ctx, x, y, BRK.w, BRK.h, 2, col(alpha), 1);
  ctx.fillStyle = col(alpha * 0.55);
  ctx.fillRect(x + 3, y + 2, BRK.w - 6, 1);
  ctx.fillStyle = col(alpha * 0.34);
  ctx.fillRect(x + 14, y + 3, 1, BRK.h - 6);
  ctx.fillRect(x + BRK.w - 15, y + 3, 1, BRK.h - 6);
  ctx.fillStyle = col(alpha * 0.30);
  ctx.fillRect(x + 3, y + BRK.h - 4, BRK.w - 6, 1);
}

function paintBricks(g, ctx, col, ox, oy) {
  for (let k = 0; k < g.bricks.length; k++) {
    const b = g.bricks[k];
    if (!b.alive) continue;
    paintBrick(ctx, col, b.x + ox, b.y + oy, b.alpha);
  }
}

function brickSprite(g) {
  if (typeof Canvas !== 'function') return null;
  if (_spOwner === g && _spKey === g.brickKey) return _sp;
  try {
    if (!_sp) {
      _sp = new Canvas(SP_W, SP_H);
      _spCtx = (typeof _sp.getContext === 'function') ? _sp.getContext('2d') : null;
    }
    if (!_spCtx) return null;
    _spCtx.clearRect(0, 0, SP_W, SP_H);
    paintBricks(g, _spCtx, gcol, -BRK.x0, -BRK.y0);
    _spOwner = g; _spKey = g.brickKey;
    return _sp;
  } catch (e) {
    return null;   // 离屏不可用 → 交给调用方直绘
  }
}

/* ─────────────────────────── 构建 ─────────────────────────── */

function buildBricks(g) {
  for (let r = 0; r < BRK.rows; r++) {
    for (let c = 0; c < BRK.cols; c++) {
      const i = r * BRK.cols + c;
      const b = g.bricks[i];
      b.row = r; b.col = c;
      b.x = BRK.x0 + c * BRK.pitchX;
      b.y = BRK.y0 + r * BRK.pitchY;
      b.score = BRICKS.ROW_SCORE[r];
      b.alpha = BRICKS.ROW_ALPHA[r];
      b.alive = true;
    }
  }
  g.alive = TOTAL;
  g.brickKey++;
}

function clampPaddle(g) {
  const half = g.paddle.w / 2;
  g.paddle.cx = clamp(g.paddle.cx, COURT.x + half, COURT_R - half);
}

/* 复位为吸附待发：球速回 160、挡板回 64、道具清空、连击清零（F-BRK-32/71） */
function resetServe(g) {
  g.speed = BALL.speed0;
  g.paddle.w = PADDLE.w;
  g.wideT0 = -1;
  g.power = null;
  g.combo = 0;
  g.breakthroughDone = false;
  clampPaddle(g);
  g.balls.length = 0;
  g.balls.push({ x: g.paddle.cx, y: SERVE.holdY, dx: 0, dy: -1 });
  g.serve.on = true;
  g.serve.t0 = g.t;
}

export function create(opts) {
  const o = opts || {};
  const g = {
    t: 0,                       // 游戏内时钟（毫秒），唯一时间源
    bricks: new Array(TOTAL),
    alive: 0,
    brickKey: 0,
    balls: [],
    paddle: { cx: CENTER.x, w: PADDLE.w },
    serve: { on: true, t0: 0 },
    speed: BALL.speed0,
    score: 0,
    lives: 3,
    combo: 0,
    maxCombo: 0,
    power: null,                // { kind:'wide'|'multi', x, y }
    wideT0: -1,                 // 加宽生效起点（g.t），-1 = 未生效
    breakthroughDone: false,    // 一条命内只触发一次（F-BRK-62）
    shards: new Array(SHARD_MAX),
    rippleT0: -1, rippleDur: FX.rippleMs, rippleTriple: false,
    imuDown: false,
    phase: 'play',              // 'play' | 'clearShow' | 'dead'
    phaseT: 0,
    finished: false,
    lastBrickT: 0,              // 挂机判定基准（F-BRK-86）
  };
  /* 定长预分配（§12.3 禁止每帧创建对象）：砖、碎片池一次性建好，后续只改字段 */
  for (let i = 0; i < TOTAL; i++) {
    g.bricks[i] = { row: 0, col: 0, x: 0, y: 0, score: 0, alpha: 0, alive: false };
  }
  for (let i = 0; i < SHARD_MAX; i++) {
    g.shards[i] = { on: false, x: 0, y: 0, dx: 0, dy: 0, t0: 0 };
  }
  buildBricks(g);
  resetServe(g);
  return g;
}

/* ─────────────────────────── 特效池 ─────────────────────────── */

function spawnShards(g, bx, by) {
  const dirs = [[-0.71, -0.71], [0.71, -0.71], [-0.71, 0.71], [0.71, 0.71]];
  let n = 0;
  for (let i = 0; i < SHARD_MAX && n < 4; i++) {
    const s = g.shards[i];
    if (s.on) continue;
    s.on = true;
    s.x = bx + BRK.w / 2;
    s.y = by + BRK.h / 2;
    s.dx = dirs[n][0]; s.dy = dirs[n][1];
    s.t0 = g.t;
    n++;
  }
}

function ripple(g, dur, triple) {
  g.rippleT0 = g.t;
  g.rippleDur = dur;
  g.rippleTriple = !!triple;
}

/* ─────────────────────────── 发球 ─────────────────────────── */

/* F-BRK-42：θ = clamp((240 − paddleCx) / TRAVEL, −1, 1) × 50°。
 * TRAVEL = COURT.w/2 − PADDLE.w/2 = 144，标准档相机行程半幅（由几何算出，
 * 不写死 —— v1.26 硬编码 192，球场宽度一改就全错）。
 * ⚠ 相机版取**反号**：挡板恒钉屏幕中心，玩家没有「挡板在哪」的视觉线索，
 *   原式（paddleCx − 240）在世界左侧时会把球打向左墙，落地即撞墙浪费一发。
 *   改为「朝向开阔侧」——相机贴左墙则球往右上飞，反之亦然；
 *   相机居中时 θ=0，仍由 F-BRK-43 兜底取 +25°。 */
export function serveDeg(g) {
  return clamp((CENTER.x - g.paddle.cx) / TRAVEL, -1, 1) * SERVE.maxDeg;
}

function launch(g, deg) {
  /* F-BRK-43 垂直兜底：|θ| < 8° 取 +25°，避免垂直对弹的枯燥来回 */
  const d = Math.abs(deg) < SERVE.minDeg ? SERVE.fallbackDeg : deg;
  const a = d * Math.PI / 180;
  const b = g.balls[0];
  if (!b) return;
  b.dx = Math.sin(a);
  b.dy = -Math.cos(a);
  g.serve.on = false;
}

/* ─────────────────────────── 事件 ─────────────────────────── */

function breakBrick(g, k, ev) {
  const b = g.bricks[k];
  b.alive = false;
  g.alive--;
  g.brickKey++;
  g.score += b.score;
  g.combo++;
  if (g.combo > g.maxCombo) g.maxCombo = g.combo;
  g.lastBrickT = g.t;

  /* F-BRK-31 球速衰减递增：越接近上限增量越小，硬顶 240 */
  g.speed = Math.min(BALL.speedMax, g.speed + BALL.gain * (1 - g.speed / BALL.speedMax));

  spawnShards(g, b.x, b.y);
  ev.push('brick');

  /* F-BRK-60~62 破墙：首次击碎顶行砖 → ×1.12 + 中心单次 r38 波纹。
   * 与上面的递增叠加后仍受 240 夹紧；一条命内只此一次。 */
  if (b.row === 0 && !g.breakthroughDone) {
    g.breakthroughDone = true;
    g.speed = Math.min(BALL.speedMax, g.speed * BRICKS.BREAKTHROUGH.factor);
    ripple(g, FX.rippleMs, false);
    ev.push('breakthrough');
  }

  /* F-BRK-56 掉落：8% 概率，同屏最多 1 个。
   * 已达 3 球上限时「多」不可用 → 生成阶段直接跳过（§10），
   * 绝不产出拾了也没反应的道具。 */
  if (!g.power && Math.random() < POWER.dropRate) {
    const kind = Math.random() < 0.5 ? 'wide' : 'multi';
    if (!(kind === 'multi' && g.balls.length >= POWER.maxBalls)) {
      g.power = { kind: kind, x: b.x + BRK.w / 2, y: b.y + BRK.h / 2 };
    }
  }

  /* 通关：清空 48 砖（F-BRK-74/75）→ 320ms 演出，物理停摆但画面继续渲染 */
  if (g.alive <= 0) {
    g.phase = 'clearShow';
    g.phaseT = g.t;
    ripple(g, FX.clearMs, true);
    ev.push('clear');
  }
}

function applyPower(g, kind, ev) {
  if (kind === 'wide') {
    g.paddle.w = PADDLE.wide;
    g.wideT0 = g.t;
    clampPaddle(g);                     // F-BRK-05：越界即夹紧
  } else if (g.balls.length < POWER.maxBalls && g.balls.length > 0) {
    /* F-BRK-55：复制任一存活球的速度并旋转 ±22°（新球不进吸附态） */
    const src = g.balls[0];
    const a = POWER.splitDeg * Math.PI / 180;
    const s = (Math.random() < 0.5 ? 1 : -1) * Math.sin(a);
    const c = Math.cos(a);
    const dx = src.dx * c - src.dy * s;
    const dy = src.dx * s + src.dy * c;
    g.balls.push({ x: src.x, y: src.y, dx: dx, dy: dy });
  }
  ev.push('power');
}

function loseLife(g, ev) {
  g.lives--;
  if (g.lives <= 0) {
    /* F-BRK-72：命尽直接结算，不在游戏内自动重开。
     * ⚠ 必须同时置 finished：否则 dead 分支会继续等满 320ms 演出时长
     *   再补发一次 finished（语义上命尽是没有演出的）。 */
    g.phase = 'dead';
    g.phaseT = g.t;
    g.finished = true;
    ev.push('over');
    ev.push('finished');
    return;
  }
  resetServe(g);
  ev.push('lose');
}

/* ─────────────────────────── 物理 ─────────────────────────── */

/* 防水平卡死（F-BRK-34）：|dy| < 0.25 时抬升到 0.25 并重整单位向量。
 * F-BRK-33 的 ±60° 扇形已保证 |dy| ≥ 0.5，此兜底只防数值异常。 */
function fixShallow(b) {
  const m = Math.sqrt(b.dx * b.dx + b.dy * b.dy) || 1;
  let ux = b.dx / m, uy = b.dy / m;
  if (Math.abs(uy) < 0.25) {
    uy = uy < 0 ? -0.25 : 0.25;
    const k = Math.sqrt(Math.max(0, 1 - uy * uy));
    ux = ux < 0 ? -k : k;
    b.dx = ux; b.dy = uy;
  }
}

function stepBall(g, b, h, ev) {
  b.x += b.dx * g.speed * h;
  b.y += b.dy * g.speed * h;

  /* 左右墙与顶墙按法向镜面反弹，速率不变（F-BRK-35） */
  if (b.x - R < COURT.x) { b.x = COURT.x + R; b.dx = -b.dx; }
  else if (b.x + R > COURT_R) { b.x = COURT_R - R; b.dx = -b.dx; }
  if (b.y - R < COURT.y) { b.y = COURT.y + R; b.dy = -b.dy; }

  /* 挡板（F-BRK-33）：命中点偏移决定反弹角，扇形 ±60°，速率不变。
   * 只在下行时判定；命中后强制 dy < 0，杜绝被挡板「推出」球场底部（§10）。 */
  if (b.dy > 0) {
    const half = g.paddle.w / 2;
    const pl = g.paddle.cx - half, pr = g.paddle.cx + half;
    if (b.y + R >= PADDLE_TOP && b.y - R <= PADDLE_BOT && b.x + R >= pl && b.x - R <= pr) {
      const ratio = clamp((b.x - g.paddle.cx) / half, -1, 1);
      const th = ratio * 60 * Math.PI / 180;
      b.dx = Math.sin(th);
      b.dy = -Math.cos(th);
      b.y = PADDLE_TOP - R;
      ev.push('bounce');
      return;
    }
  }

  /* 砖（F-BRK-38）：AABB 重叠 + 最小穿透轴决定反弹面；
   * 单子步只结算**最近**的一次命中（穿透最小者）。 */
  let hit = -1, minPen = Infinity, axis = 0;
  for (let k = 0; k < g.bricks.length; k++) {
    const br = g.bricks[k];
    if (!br.alive) continue;
    const ox = Math.min(b.x + R, br.x + BRK.w) - Math.max(b.x - R, br.x);
    if (ox <= 0) continue;
    const oy = Math.min(b.y + R, br.y + BRK.h) - Math.max(b.y - R, br.y);
    if (oy <= 0) continue;
    const pen = ox < oy ? ox : oy;
    if (pen < minPen) { minPen = pen; hit = k; axis = ox < oy ? 0 : 1; }
  }
  if (hit >= 0) {
    if (axis === 0) b.dx = -b.dx; else b.dy = -b.dy;
    fixShallow(b);
    breakBrick(g, hit, ev);
  }
}

/* ─────────────────────────── update ─────────────────────────── */

export function update(g, dtMs, snap) {
  const ev = [];
  const dt = clamp(dtMs || 0, 0, 100);

  /* IMU 异常降级（F-BRK-84）：停止物理推进，**且 g.t 不推进** ——
   * 冻结期本就不该计入净游玩时长（F-BRK-78）。恢复后自动续算。 */
  if (!snap || snap.ok === false) { g.imuDown = true; return ev; }
  g.imuDown = false;

  g.t += dt;

  /* 演出 / 命尽：物理停摆，但粒子与波纹继续推进（F-BRK-76 画面不冻结） */
  if (g.phase !== 'play') {
    if (!g.finished && g.t - g.phaseT >= FX.clearMs) {
      g.finished = true;
      ev.push('finished');
    }
    return ev;
  }

  /* 相机（== 挡板世界坐标）：锚定型 yaw。snap.x 已含死区/压扁/低通/限幅，
   * 本册不再平滑（F-BRK-03）。
   * ⚠ 符号为负（SEM_FOLLOW）：snap.x > 0 表示头向【左】转，相机要同向走，
   *   故头左转 → cx 减小 → dx = 240 − cx 增大 → 世界整体右滑（反向滑动）。
   *   2026-09-04 真机实测修正；语义的权威说明见 input.js。
   * 挡板在屏幕上恒钉 x=240（由 render 的 translate 抵消），这里变的是世界坐标。 */
  const half = g.paddle.w / 2;
  g.paddle.cx = clamp(CENTER.x + SEM_FOLLOW * (snap.x || 0), COURT.x + half, COURT_R - half);

  /* 加宽到期回落（F-BRK-54），并按新宽度夹紧（F-BRK-05） */
  if (g.wideT0 >= 0 && g.t - g.wideT0 >= POWER.wideMs) {
    g.paddle.w = PADDLE.w;
    g.wideT0 = -1;
    clampPaddle(g);
  }

  /* 吸附发球（F-BRK-40/41）：球随挡板同步平移，1.5s 后自动发射 */
  if (g.serve.on) {
    const b = g.balls[0];
    if (b) { b.x = g.paddle.cx; b.y = SERVE.holdY; }
    /* 吸附期不计入挂机（F-BRK-86） */
    g.lastBrickT = g.t;
    if (g.t - g.serve.t0 >= SERVE.ms) {
      launch(g, serveDeg(g));
      ev.push('serve');
    }
    return ev;
  }

  /* 固定子步推进（F-BRK-37） */
  let steps = Math.ceil(dt / SUB_MS);
  if (steps < 1) steps = 1;
  if (steps > SUB_MAX) steps = SUB_MAX;
  const h = dt / steps / 1000;

  for (let s = 0; s < steps; s++) {
    for (let i = 0; i < g.balls.length; i++) stepBall(g, g.balls[i], h, ev);

    /* 落底（F-BRK-14/73）：球心 y > 308 即出局；仅移除该球 */
    for (let i = g.balls.length - 1; i >= 0; i--) {
      if (g.balls[i].y > COURT_B) g.balls.splice(i, 1);
    }
    if (g.balls.length === 0) {
      loseLife(g, ev);
      return ev;
    }
  }

  /* 掉落物（F-BRK-56）：垂直下落 90px/s，被挡板接住即生效 */
  if (g.power) {
    g.power.y += POWER.fallV * dt / 1000;
    const ph = g.paddle.w / 2;
    const hitY = g.power.y + POWER.size / 2 >= PADDLE_TOP
      && g.power.y - POWER.size / 2 <= PADDLE_BOT;
    const hitX = Math.abs(g.power.x - g.paddle.cx) <= ph + POWER.size / 2;
    if (hitY && hitX) {
      applyPower(g, g.power.kind, ev);
      g.power = null;
    } else if (g.power.y - POWER.size / 2 > COURT_B) {
      g.power = null;
    }
  }

  /* 无输入挂机（F-BRK-86）：>5 分钟无击砖 → idle，由页面转入保护态 */
  if (g.t - g.lastBrickT > BRICKS.IDLE_MS) {
    g.lastBrickT = g.t;
    ev.push('idle');
  }

  return ev;
}

/* ─────────────────────────── result ─────────────────────────── */

/* 只负责 score / cleared / reachedLevel / extra（F-BRK-77）。
 * durationSec 由页面用 g.t 填（游戏内时钟，已排除冻结时长，F-BRK-78），
 * motion 由页面用 InputEngine.stats.toMotion() 填（F-BRK-93）。 */
export function result(g) {
  return {
    score: g.score,
    cleared: g.alive <= 0,
    reachedLevel: 1,
    extra: [
      { label: '最高连击', value: String(g.maxCombo) },
      { label: '剩余生命', value: String(Math.max(0, g.lives)) },
    ],
  };
}

/* ─────────────────────────── render ─────────────────────────── */

function drawShards(g, ctx, col) {
  for (let i = 0; i < SHARD_MAX; i++) {
    const s = g.shards[i];
    if (!s.on) continue;
    const k = (g.t - s.t0) / FX.shardMs;
    if (k >= 1) { s.on = false; continue; }
    const len = 6 + 6 * k;              // 6 → 12px（F-BRK-53）
    const a = 1 - k;                    // 100% → 0
    ctx.strokeStyle = col(a);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(s.x + s.dx * len, s.y + s.dy * len);
    ctx.stroke();
    fillCircle(ctx, s.x + s.dx * len * 0.6, s.y + s.dy * len * 0.6, 1, col(0.48 * a));
  }
}

function drawRipple(g, ctx) {
  if (g.rippleT0 < 0) return;
  const k = clamp((g.t - g.rippleT0) / g.rippleDur, 0, 1);
  const a = 1 - k;
  if (a <= 0.01) return;
  fillRipple(ctx, CX, CY, 38, 0.30, a);
  if (g.rippleTriple) {
    fillRipple(ctx, CX, CY, 50, 0.20, a);
    fillRipple(ctx, CX, CY, 62, 0.12, a);
  }
}

function drawPower(g, ctx, col) {
  const p = g.power;
  if (!p) return;
  const s = POWER.size, h = s / 2;
  fillRoundRect(ctx, p.x - h, p.y - h, s, s, POWER.r, col(L.P12));
  strokeRoundRect(ctx, p.x - h, p.y - h, s, s, POWER.r, col(L.P72), 1);
  /* 双通道编码（F-BRK-57）：图形容器 + 11px 单字中文 */
  text(ctx, p.kind === 'wide' ? '宽' : '多', p.x, p.y, {
    size: 11, weight: 500, color: col(L.P72),
  });
}

function drawServe(g, ctx, col) {
  if (!g.serve.on) return;
  /* 倒计时三格（F-BRK-41）：4×4 方块，间距 6，居中于挡板，每 0.5s 点亮一枚 */
  const size = SERVE.markSize, pitch = size + SERVE.markGap;
  const span = pitch * 3 - SERVE.markGap;              // 24
  const x0 = g.paddle.cx - span / 2;
  const lit = Math.floor((g.t - g.serve.t0) / 500);
  for (let i = 0; i < 3; i++) {
    fillRoundRect(ctx, x0 + i * pitch, SERVE.markY, size, size, 1,
      col(i < lit ? L.P72 : L.P24));
  }
  /* 方向预览线（F-BRK-42）：自球心画 24px @48% */
  const a = serveDeg(g) * Math.PI / 180;
  const bx = g.paddle.cx, by = SERVE.holdY;
  ctx.strokeStyle = col(L.P48);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(bx, by);
  ctx.lineTo(bx + Math.sin(a) * SERVE.previewLen, by - Math.cos(a) * SERVE.previewLen);
  ctx.stroke();
}

function drawHudMid(g, ctx, col) {
  /* 得分（F-BRK-17）：标签 11/500 @48% + 数值 mono 13/500 @72% */
  text(ctx, '得分', HUDX.scoreLabelX, HUDX.midY,
    { size: 11, weight: 500, color: col(L.P48), align: 'left' });
  text(ctx, String(g.score), HUDX.scoreValX, HUDX.midY,
    { size: 13, weight: 500, mono: true, color: col(L.P72), align: 'left' });

  /* 生命（F-BRK-18）：3 枚 5×5 方块（已剩 = 72% 实心 / 已失 = 24% 空心）
   * + 右侧 mono 数字 —— 双通道编码：图形数量 + 数字 */
  for (let i = 0; i < 3; i++) {
    const x = HUDX.lifeX0 + i * HUDX.lifeStep;
    if (i < g.lives) {
      ctx.fillStyle = col(L.P72);
      ctx.fillRect(x, HUDX.lifeY, HUDX.lifeSize, HUDX.lifeSize);
    } else {
      ctx.strokeStyle = col(L.P24);
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, HUDX.lifeY + 0.5, HUDX.lifeSize - 1, HUDX.lifeSize - 1);
    }
  }
  text(ctx, String(Math.max(0, g.lives)), HUDX.lifeNumX, HUDX.midY,
    { size: 13, weight: 500, mono: true, color: col(L.P72), align: 'left' });
}

function drawImuPanel(g, ctx, col) {
  const p = BRICKS.IMU_PANEL;
  fillRoundRect(ctx, p.x, p.y, p.w, p.h, 6, col(L.P12));
  strokeRoundRect(ctx, p.x, p.y, p.w, p.h, 6, col(L.P48), 1);
  text(ctx, 'IMU 状态异常', CENTER.x, p.titleY,
    { size: 13, weight: 500, color: col(L.P100) });
  text(ctx, '请调整佩戴后重试', CENTER.x, p.subY,
    { size: 11, weight: 500, color: col(L.P48) });
}

/* render(g, ctx, fade)
 *   fade = 框架的淡出进度 0~1（B1=0 / B2=1 / B3 沿 launchFade / B4=1）。
 *   本册绝不自行降 alpha，一律经 fadeTo 让框架统一收束到 6% 隐藏档（F-BRK-83）。
 * ⚠ 本册不画：视口虚线框 / 四角角标 / 四边刻度（C-FRM-05，页面画）、
 *             双胶囊与提示条（页面画）。 */
/* 边界墙（用户要求 · **世界层**）：球场左右边界各立一道竖墙，它**就是**
 * 球反弹的那面墙 —— 物理反弹面（球缘最远能到的位置）与墙内侧面严格重合。
 * v1.34：由「3px 底纹 + 内侧面 1px @72% 亮线」改为 **8px 羽化收边带** ——
 *   内侧面最亮（观感 ≈ 0.40），向屏幕外侧分 4 级逐级淡出。真机反馈原 72%
 *   单线过亮、且一根细线显得单薄，故降亮度 + 改风格（峰值约为原值 55%）。
 * ⚠ 必须在 ctx.translate(dx,0) **之后**调用（本函数按世界坐标作画）。
 *   v1.27 曾把墙钉成屏幕固定层，结果与球的反弹位置对不上 —— 平移后球会
 *   「在一堵纹丝不动的墙上弹开」，玩家一眼就觉得假。这是本轮要修的核心。
 *   墙外（裁剪窗 56~424 之外、视口 16~464 之内）什么都不画 → 空白。 */
function drawWalls(g, ctx, col) {
  const ext = { a: COURT.y, len: VYB - COURT.y };          // 48 ~ 340
  fadeBand(ctx, 'v', COURT.x, ext, CAM.wallBand, -1, CAM.wallSteps, col);   // 左：内侧面 64
  fadeBand(ctx, 'v', COURT_R, ext, CAM.wallBand, 1, CAM.wallSteps, col);    // 右：内侧面 416
}

/* 离屏球指示器（相机版补偿）：球场宽 == 视口宽，相机推到极限时另一侧
 * 最多 144px 的球场会滑出视口，球会看不见。在对应屏幕边画一枚朝外的
 * 三角，只标方向不标距离；同屏最多 3 球，按方向去重，只画两枚。 */
function drawEdgeMarks(g, ctx, col, dx) {
  if (g.serve.on) return;
  let l = false, r = false, ly = 0, ry = 0;
  for (let i = 0; i < g.balls.length; i++) {
    const sx = g.balls[i].x + dx;
    if (sx < CLIP_L - R) { l = true; ly = g.balls[i].y; }
    else if (sx > CLIP_R + R) { r = true; ry = g.balls[i].y; }
  }
  /* 贴在裁剪窗内侧（紧贴墙），不要画到墙外的空白里去 */
  if (l) edgeMark(ctx, col, CLIP_L + CAM.markGap, ly, -1);
  if (r) edgeMark(ctx, col, CLIP_R - CAM.markGap, ry, 1);
}

function edgeMark(ctx, col, x, y, dir) {
  const y0 = clamp(y, VY + CAM.markH, VYB - CAM.markH);
  ctx.fillStyle = col(L.P48);
  ctx.beginPath();
  ctx.moveTo(x, y0);
  ctx.lineTo(x - dir * CAM.markW, y0 - CAM.markH / 2);
  ctx.lineTo(x - dir * CAM.markW, y0 + CAM.markH / 2);
  ctx.closePath();
  ctx.fill();
}

export function render(g, ctx, fade) {
  const f = fade > 0 ? (fade > 1 ? 1 : fade) : 0;
  const col = function (a) { return gcol(fadeTo(a, f)); };

  const dx = camDx(g);

  /* ══ 屏幕固定层 ①：顶部进度条 ══════════════════════════════════
   * F-BRK-16 底 12% + 已完成 48%。它是 HUD 计量条而非世界几何，
   * 因此**不随相机平移**，恒与裁剪窗（= 游戏画面含两墙）左右对齐。
   * ⚠ y=40 落在 C-FRM-02 的禁放空档内，由 F-BRK-16 显式声明并复核。 */
  const done = CLIP_W * (TOTAL - g.alive) / TOTAL;
  ctx.fillStyle = col(L.P12);
  ctx.fillRect(CLIP_L, PROGRESS.y, CLIP_W, PROGRESS.h);
  if (done > 0) {
    ctx.fillStyle = col(L.P48);
    ctx.fillRect(CLIP_L, PROGRESS.y, done, PROGRESS.h);
  }

  /* ══ 世界层：裁剪到裁剪窗后整体平移 dx ═════════════════════════
   * 裁剪窗 = 球场 ± 墙厚（56~424）。相机居中时球场 64~416 居中，两道墙
   * 立在 61 / 416，外侧各 45px 纯空白；相机一推，一侧墙滑出窗被裁掉、
   * 另一侧滑进画面 —— 越出窗的部分直接消失，即「越界显示空白」。 */
  ctx.save();
  ctx.beginPath();
  ctx.rect(CLIP_L, VY, CLIP_R - CLIP_L, VYB - VY);
  ctx.clip();
  ctx.translate(dx, 0);

  /* 球场底板（设计补全 · 九屏统一）：判定线 + 12% 出界判区 + 6% 余晖过渡 */
  ctx.fillStyle = col(L.P12);
  ctx.fillRect(COURT.x, FLOOR.line, COURT.w, FLOOR.band1 - FLOOR.line);
  ctx.fillStyle = col(L.P06);
  ctx.fillRect(COURT.x, FLOOR.band1, COURT.w, FLOOR.band2 - FLOOR.band1);
  ctx.fillStyle = col(L.P24);
  ctx.fillRect(COURT.x, FLOOR.line, COURT.w, 1);

  /* 砖阵：优先走离屏精灵（原档亮度）；冻结帧或离屏不可用时直绘 */
  const sp = (f < 0.01) ? brickSprite(g) : null;
  let painted = false;
  if (sp && typeof ctx.drawImage === 'function') {
    try { ctx.drawImage(sp, BRK.x0, BRK.y0); painted = true; } catch (e) { painted = false; }
  }
  if (!painted) paintBricks(g, ctx, col, 0, 0);

  drawPower(g, ctx, col);

  /* 挡板：12% 底 + 描边。加宽生效期用 72% / 2px 表达激活态（设计稿 S4） */
  const half = g.paddle.w / 2;
  const wide = g.wideT0 >= 0;
  fillRoundRect(ctx, g.paddle.cx - half, PADDLE_TOP, g.paddle.w, PADDLE.h, 2, col(L.P12));
  strokeRoundRect(ctx, g.paddle.cx - half, PADDLE_TOP, g.paddle.w, PADDLE.h, 2,
    col(wide ? L.P72 : L.P48), wide ? 2 : 1);

  drawServe(g, ctx, col);

  /* 球（F-BRK-13）：2 段渐弱拖影 + r8 光晕 + r4 实心本体 */
  for (let i = 0; i < g.balls.length; i++) {
    const b = g.balls[i];
    if (g.serve.on) break;                       // 吸附态无拖影
    for (let k = 2; k >= 1; k--) {
      const d = k * 5;
      fillCircle(ctx, b.x - b.dx * d, b.y - b.dy * d, R, col(k === 1 ? L.P24 : L.P12));
    }
    fillGlow(ctx, b.x, b.y, BALL.glow, [[0, 0.24], [0.55, 0.08], [1, 0]], fadeTo(1, f));
    fillCircle(ctx, b.x, b.y, R, col(L.P100));
  }

  drawShards(g, ctx, col);
  drawRipple(g, ctx);
  /* 边界墙画在世界层——它就是球反弹的那面墙，必须跟着球场走 */
  drawWalls(g, ctx, col);

  ctx.restore();          // ← 世界层结束，坐标回到屏幕系

  /* ══ 屏幕固定层 ② ══════════════════════════════════════════════ */
  drawEdgeMarks(g, ctx, col, dx);   // 离屏球方向指示器（见函数注释）

  /* 通关演出（F-BRK-75）：波纹 + 「通关」淡入。
   * ⚠ 字级取 13 而非 PRD 的 14 —— 总章 §2.5.2「同屏 ≤3 字级」为只读基线，
   *   本屏已有 11（标签）/ 12（框架胶囊）/ 13（mono 数值）三级，14 会变四级。
   *   复用 data 级 13px，视觉层级不变但合规。 */
  if (g.phase === 'clearShow') {
    const k = clamp((g.t - g.phaseT) / FX.clearMs, 0, 1);
    text(ctx, '通关', CX, CY, { size: 13, weight: 500, color: gcol(k) });
  }

  drawHudMid(g, ctx, col);
  if (g.imuDown) drawImuPanel(g, ctx, col);
}
