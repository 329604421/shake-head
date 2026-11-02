/* eggcatch.js —— 《接鸡蛋》玩法模块（PRD-03 · 相机版 v1.29）
 *
 * 接口契约（PRD-03 附录 A.3）：
 *   create()              → g 状态对象
 *   update(g, dtMs, snap) → events[]（本册不播音，由页面播）
 *   render(g, ctx, fade)  → 画场地/落物/蛋篮/HUD 中段
 *   result(g)             → { score, cleared, reachedLevel, extra[] }
 *
 * 【三条硬红线 · 违反即冻结语义失效】
 *   1. **禁止 Date.now() 与任何定时器**：全部计时基于 update(dtMs) 累加的
 *      g.t。框架页在 B2/B3/B4 期间不调 update，g.t 自动停走 —— 冻结与续算
 *      无需任何显式 freeze / resume（F-EGG-60/61）。
 *   2. **禁止 import sfx / storage**：update 返回事件数组，播音与落盘全归
 *      页面。本模块因此可在 node 下直接跑断言。
 *   3. **禁止自绘遮罩或自行降 alpha**：变暗一律由页面把 fade 传进来，走
 *      ring.js 的 fadeTo。render 的第三参 fade 即为此设。
 *
 * 【映射形态】**锚定型 yaw 相机 + pitch 直控**（2026-09-04 用户改造指定，
 * 推翻 PRD-03 r6 的双轴直控；几何定义见 layout.js 的 EGG 块）：
 *
 *   横向（yaw）：蛋篮**恒钉屏幕中心 x=240**，头动驱动【世界反向平移】。
 *     篮子的**世界坐标 == 相机中心 camCx**，绘制偏移 dx = 240 − camCx。
 *     语义与 PRD-02 打砖块 v1.28 同源（SEM_FOLLOW），详见 input.js。
 *   纵向（pitch）：篮口 y **保持直控**，是接取高度倍率的玩法落点。
 *
 *   **为什么只改横向**：用户的原话是「头部移动以后眼镜里的碗也在移动，
 *   这就让用户很头晕」—— 症状只出现在横轴。纵轴行程仅 ±40px、且不是持续
 *   偏转，不构成眩晕源；更重要的是落物本来就纵向运动，若画面再纵向滑动，
 *   玩家无法分辨「是蛋在落」还是「是画面在动」，反而更难瞄。
 *
 * 【⚠ 相机化带来的新约束：生成必须可见】
 *   相机推到极限位时，远端轨道会滑出裁剪窗。若在那里生成落物，玩家根本
 *   看不见、必然漏接 —— 这在「漏 3 个就结算」的规则下是致命的不公平。
 *   故生成器**只从当前可见的轨道中选**（可见半幅 VIS_HALF，见下方推导）。
 *   已生成的落物若因玩家转头而滑出屏幕，由**离屏指示器**在屏幕边缘提示
 *   方向（照搬打砖块的 drawEdgeMarks，只标方向不标距离）。
 */

import { L, g as gcol } from './theme.js';
import { CENTER, VIEWPORT, EGG } from './layout.js';
import { SEM_FOLLOW } from './input.js';
import { clamp, text, fillCircle, strokeCircle, fadeBand } from './draw.js';
import { fadeTo } from './ring.js';

const COURT = EGG.COURT;
const BASKET = EGG.BASKET;
const DROP = EGG.DROP;
const BAND = EGG.BAND;
const CAM = EGG.CAMERA;
const WAVES = EGG.WAVES;
const FX = EGG.FX;
const HUDX = EGG.HUDX;
const LABEL = EGG.LABEL;
const SCORE = EGG.SCORE;

const COURT_R = COURT.x + COURT.w;      // 416
const COURT_B = COURT.y + COURT.h;      // 332（与地面线齐平：两墙 + 地面 = U 形场地）
const CX = COURT.x + COURT.w / 2;       // 240
const VY = VIEWPORT.y;                  // 44
const VYB = VIEWPORT.y + VIEWPORT.h;    // 340

/* 裁剪窗 = 球场 ± 墙厚：世界层只在这道窗里可见，越界部分直接消失 → 留白。
 * 这正是用户要的「左右两侧超出边界的区域显示空白」。 */
const CLIP_L = COURT.x - CAM.wallBand;  // 56（v1.34：墙带由 3 加宽到 8）
const CLIP_R = COURT_R + CAM.wallBand;  // 424
const CLIP_W = CLIP_R - CLIP_L;         // 368

const HALF = BASKET.w / 2;              // 24（篮口半宽）
/* 行程半幅：球场中心 → 篮子能到达的最远处，由几何算出（**勿硬编码**）。
 * TRAVEL = 352/2 − 48/2 = 176 − 24 = 152。 */
export const TRAVEL = COURT.w / 2 - BASKET.w / 2;

/* 可见轨道半幅（生成器用）：世界坐标 x 落在 [camCx − VIS_HALF, camCx + VIS_HALF]
 * 的落物才在裁剪窗内。推导：
 *     CLIP_L ≤ x + dx ≤ CLIP_R，dx = 240 − camCx
 *   → camCx − 184 ≤ x ≤ camCx + 184   （v1.34：裁剪窗随墙带加宽到 56~424）
 * 再内缩 8（≈落物半宽 7~9），避免落物半个身子卡在窗边被裁。 */
const VIS_HALF = (CLIP_R - CENTER.x) - 8;   // 424 − 240 − 8 = 176

const NEED_TOTAL = 48;                  // 四波 × 12 枚（HUD 进度分母）
const KIND = { EGG: 0, GOLD: 1, BOMB: 2 };

/* 落物纵向行程（供断言与注释核对，不参与逻辑）：
 *   蛋：中心 58+9=67 → 底边触 332 时中心 323，行程 **256px**
 * ⚠ PRD-03 附录 B 写「264px / W1 2.40s / W4 1.77s」是**笔误** ——
 *   264 = 332 − 58 − 10，但蛋高是 2×ry = 18 而非 10。正确值 256px：
 *   W1 = 256/110 = 2.33s、W4 = 256/149 = 1.72s。本模块按正确几何实现。 */
export const FALL_PX = EGG.GROUND - DROP.spawnTop - DROP.eggRy * 2;   // 256

/* ── 状态构造 ───────────────────────────────────────────────────── */

export function create() {
  const g = {
    t: 0,                 // 游戏内时钟（ms），唯一时间源
    phase: 'intro',       // intro | wave | gap | over
    phaseT: 0,            // 本阶段起点（g.t 基准）
    waveIdx: 0,           // 0..3
    waveSpawned: 0,       // 本波已生成的**有效**枚数（蛋+金蛋，炸弹不计）
    caught: 0,            // 全局已接有效枚数（HUD 进度分子）
    miss: 0,              // 失误槽 0..3
    score: 0,
    goldCaught: 0,
    bombDodged: 0,
    imuDown: false,

    camCx: CX,            // 相机中心 == 篮子世界坐标（锚定型）
    mouthY: BASKET.mouthHome,   // 篮口 y（pitch 直控）

    drops: [],            // 落物池（定长 DROP.maxOnScreen）
    spawnT: 0,            // 本波生成计时
    lastLane: -1,         // 上一次生成的轨道（F-EGG-3A 相邻不同轨）

    shakeT: -1,           // 震屏剩余 ms，-1 = 无
    flashT: -1,           // 接住加粗剩余 ms
    rings: [],            // 接住扩散圆池
    shards: [],           // 落地碎裂池
    idleMs: 0,            // 无有效输入累计

    over: false,
    cleared: false,
  };

  /* 定长池（§12.3：禁止每帧创建对象） */
  for (let i = 0; i < DROP.maxOnScreen; i++) {
    g.drops.push({ on: false, x: 0, y: 0, kind: KIND.EGG, vy: 0 });
  }
  for (let i = 0; i < 6; i++) g.rings.push({ on: false, x: 0, y: 0, t0: 0 });
  for (let i = 0; i < 8; i++) g.shards.push({ on: false, x: 0, y: 0, t0: 0 });
  return g;
}

/* 世界 → 屏幕的横向绘制偏移。篮子恒钉 CENTER.x，故相机中心 == 篮子世界坐标。
 * dx > 0 表示世界整体右移（头左转）。范围 ±TRAVEL(152)。供 render 与断言共用。 */
export function camDx(g) { return CENTER.x - g.camCx; }

/* ── 更新 ───────────────────────────────────────────────────────── */

export function update(g, dtMs, snap) {
  const ev = [];
  if (g.over) return ev;

  /* dt 一律钳到 0~100ms（§10：切后台/卡顿一帧巨跳会让落物穿透判定带） */
  const dt = dtMs > 100 ? 100 : (dtMs < 0 ? 0 : dtMs);
  g.t += dt;

  /* IMU 不可用（§10）：不生成、清空在场落物、篮子锁中立位。
   * 禁止在无输入状态下继续落蛋（NFR-05）。 */
  if (!snap || snap.ok === false) {
    g.imuDown = true;
    for (let i = 0; i < g.drops.length; i++) g.drops[i].on = false;
    g.camCx = CX;
    g.mouthY = BASKET.mouthHome;
    return ev;
  }
  g.imuDown = false;

  /* 两轴独立、无耦合项（F-EGG-04）：左右转头不改变篮口 y，抬头低头不改变 camCx。
   * 横向锚定型：camCx = 240 + SEM_FOLLOW × snap.x
   *   snap.x > 0（头左转）→ camCx 减小 → dx = 240 − camCx 增大 → 世界右滑。
   * 纵向直控：抬头 = 篮口 y 减小 = 篮子上升（PRD F-EGG-03 公式）。
   *   ⚠ snap.y 的符号**尚未真机标定**（与 PRD-04/05/06 同一待办）。若真机
   *     上下反向，改 layout.js 的 BASKET 或直接在此处取反，**不要动
   *     input.js 的 SIGN**（会连主页菜单一起反转）。 */
  g.camCx = clamp(CENTER.x + SEM_FOLLOW * (snap.x || 0),
    COURT.x + HALF, COURT_R - HALF);                      // [88, 392]
  g.mouthY = clamp(BASKET.mouthHome - clamp((snap.y || 0) * BASKET.vscale, -40, 40),
    BASKET.mouthMin, BASKET.mouthMax);                    // [218, 298]

  /* 短动效计时（所有阶段都要走，否则冻结期恢复会残留） */
  if (g.shakeT >= 0) { g.shakeT -= dt; if (g.shakeT < 0) g.shakeT = -1; }
  if (g.flashT >= 0) { g.flashT -= dt; if (g.flashT < 0) g.flashT = -1; }
  expireFx(g);

  /* 无输入挂机（§10）：5 分钟无有效输入 → 停止并进入保护态结算。
   * ⚠ 本作允许「站着不动接中间轨道」，故只有真的连续 5 分钟零输入才触发。 */
  if (snap.x !== 0 || snap.y !== 0) g.idleMs = 0;
  else g.idleMs += dt;
  if (g.idleMs >= EGG.IDLE_MS) {
    g.over = true;
    g.cleared = false;
    ev.push('finished');
    return ev;
  }

  if (g.phase === 'intro' || g.phase === 'gap') {
    /* 过场 1.2s：清空落物 + 停止生成（F-EGG-40），篮子仍可控（F-EGG-42） */
    if (g.t - g.phaseT >= EGG.GAP_MS) {
      g.phase = 'wave';
      g.phaseT = g.t;
      g.waveSpawned = 0;
      g.spawnT = 0;
      g.lastLane = -1;
    }
    return ev;
  }

  /* ── wave 阶段 ─────────────────────────────────────────────── */
  const wv = WAVES[g.waveIdx];
  const dx = camDx(g);

  /* 生成：按时间累加而非按帧（Kaboom 借鉴点②），同屏上限由池长保证 */
  g.spawnT += dt;
  if (g.waveSpawned < wv.need && g.spawnT >= wv.gapMs) {
    g.spawnT -= wv.gapMs;
    spawnOne(g, wv);
  }

  /* 判定：**炸弹优先**（§10）—— 同帧多枚接触篮子时先结罚，防玩家"蒙混"得分 */
  for (let i = g.drops.length - 1; i >= 0; i--) {
    const d = g.drops[i];
    if (d.on && d.kind === KIND.BOMB) stepDrop(g, d, dt, dx, ev);
  }
  for (let i = g.drops.length - 1; i >= 0; i--) {
    const d = g.drops[i];
    if (d.on && d.kind !== KIND.BOMB) stepDrop(g, d, dt, dx, ev);
  }
  if (g.over) return ev;

  /* 本波有效枚数生成完毕 → 等在场落物自然处理完 → 再进过场。
   * ⚠ 与 PRD §6.4 状态机的一处**有意偏差**：PRD 写「本波有效枚数达 12」即
   *   切 Gap 并清空落物，但那样第 12 枚可能刚生成就被清掉、玩家没机会接，
   *   等于凭空损失分数。改为「生成满 12 → 停止生成 → 等在场落物全部落地或
   *   接住 → 切 Gap」，最长多等一个落地时长（W1 2.33s / W4 1.72s），
   *   单局净时长由 ≈60s 增至 ≈66s。F-EGG-40 的清空逻辑保留为防御性收尾。 */
  if (g.waveSpawned >= wv.need) {
    let alive = 0;
    for (let i = 0; i < g.drops.length; i++) if (g.drops[i].on) alive++;
    if (alive === 0) {
      if (g.waveIdx >= WAVES.length - 1) {
        g.cleared = true;
        g.over = true;
        ev.push('clear');
        ev.push('finished');
      } else {
        /* ⚠ waveIdx 必须在这里推进（漏了这句会永远停在 W1、无限接蛋）。
         * 推进后 gap 的过场文案直接用 waveIdx 取下一波（见 drawWaveCard）。 */
        g.waveIdx += 1;
        g.phase = 'gap';
        g.phaseT = g.t;
        ev.push('wave');
      }
    }
  }
  return ev;
}

/* 单枚落物：下落 → 接住 / 落地 判定 */
function stepDrop(g, d, dt, dx, ev) {
  d.y += d.vy * dt / 1000;
  const bot = d.y + (d.kind === KIND.BOMB ? DROP.bombR : DROP.eggRy);

  /* 接住（F-EGG-34）：水平中心落在篮口内缩 4px 的区间，且底边进入篮口~篮底。
   * 判定在**世界坐标**下进行 —— 篮子的世界 x 就是 camCx。 */
  const inX = d.x >= g.camCx - HALF + EGG.CATCH_INSET
    && d.x <= g.camCx + HALF - EGG.CATCH_INSET;
  const inY = bot >= g.mouthY && bot <= g.mouthY + BASKET.h;
  if (inX && inY) { d.on = false; onCatch(g, d, dx, ev); return; }

  /* 落地（F-EGG-35）：底边 ≥ 地面线 */
  if (bot >= EGG.GROUND) { d.on = false; onLand(g, d, ev); }
}

function onCatch(g, d, dx, ev) {
  if (d.kind === KIND.BOMB) {
    /* 接到炸弹：填 1 格 + 震屏 0.3s，0 分（F-EGG-32） */
    g.miss++;
    g.shakeT = FX.shakeMs;
    ev.push('boom');
    if (g.miss >= EGG.MISS_MAX) { g.over = true; g.cleared = false; ev.push('finished'); }
    return;
  }
  const mult = multOf(g.mouthY);
  g.score += Math.round((d.kind === KIND.GOLD ? SCORE.gold : SCORE.egg) * mult);
  g.caught++;
  if (d.kind === KIND.GOLD) { g.goldCaught++; ev.push('gold'); }
  else ev.push('catch');
  g.flashT = FX.flashMs;
  /* 接住扩散圆记**屏幕坐标**（F-EGG-3C）：篮子恒钉 240，故落物屏幕 x = 世界 x + dx */
  pushRing(g, d.x + dx, g.mouthY + BASKET.h / 2);
}

function onLand(g, d, ev) {
  if (d.kind === KIND.BOMB) {
    /* 炸弹落地：无事发生，记「躲开炸弹」（F-EGG-37）—— 主动躲开是正确对策 */
    g.bombDodged++;
    return;
  }
  g.miss++;
  pushShard(g, d.x, EGG.GROUND);
  ev.push('fail');
  if (g.miss >= EGG.MISS_MAX) { g.over = true; g.cleared = false; ev.push('finished'); }
}

/* 接取高度倍率（F-EGG-18 + §5.4）：篮口越高倍率越高，但水平对准窗口越短 */
export function multOf(mouthY) {
  if (mouthY <= BAND.hi) return SCORE.multHi;      // ≤244 → ×2.0
  if (mouthY <= BAND.mid) return SCORE.multMid;    // 244~271 → ×1.5
  return SCORE.multLow;                            // >271 → ×1.0
}

/* ── 生成器 ─────────────────────────────────────────────────────── */

/* 当前可见的轨道（相机化后新增的公平性保证，见文件头注释）。
 * 返回的数组每次新建，但生成频率仅 0.8~1.3s 一次，不构成每帧分配压力。 */
export function visibleLanes(camCx) {
  const out = [];
  const lo = camCx - VIS_HALF, hi = camCx + VIS_HALF;
  for (let i = 0; i < EGG.LANES.length; i++) {
    const x = EGG.LANES[i];
    if (x >= lo && x <= hi) out.push(x);
  }
  return out;
}

function spawnOne(g, wv) {
  const lanes = visibleLanes(g.camCx);
  if (!lanes.length) return;

  /* 相邻两次不得同轨（F-EGG-3A）：否则可能生成物理不可解的必漏死局 */
  let idx = Math.floor(Math.random() * lanes.length);
  if (lanes.length > 1 && lanes[idx] === g.lastLane) idx = (idx + 1) % lanes.length;
  const laneX = lanes[idx];

  const kind = pickKind(wv.w);
  let slot = -1;
  for (let i = 0; i < g.drops.length; i++) if (!g.drops[i].on) { slot = i; break; }
  if (slot < 0) return;                 // 同屏已满（F-EGG-39，池长即上限）

  const d = g.drops[slot];
  d.on = true;
  d.x = laneX;
  d.kind = kind;
  if (kind === KIND.BOMB) {
    d.y = DROP.spawnTop + DROP.bombR;
    d.vy = wv.speed;                             // 炸弹 = 本波速度
  } else {
    d.y = DROP.spawnTop + DROP.eggRy;
    d.vy = (kind === KIND.GOLD) ? wv.speed * EGG.GOLD_SPEED_K : wv.speed;
  }
  g.lastLane = laneX;
  if (kind !== KIND.BOMB) g.waveSpawned++;       // 炸弹不计入 48 枚（D-EGG-02）
}

function pickKind(w) {
  const total = w.egg + w.gold + w.bomb;
  let r = Math.random() * total;
  if ((r -= w.egg) < 0) return KIND.EGG;
  if ((r -= w.gold) < 0) return KIND.GOLD;
  return KIND.BOMB;
}

/* ── 短动效池 ───────────────────────────────────────────────────── */

function pushRing(g, x, y) {
  for (let i = 0; i < g.rings.length; i++) {
    if (!g.rings[i].on) {
      g.rings[i].on = true; g.rings[i].x = x; g.rings[i].y = y; g.rings[i].t0 = g.t;
      return;
    }
  }
}

function pushShard(g, x, y) {
  for (let i = 0; i < g.shards.length; i++) {
    if (!g.shards[i].on) {
      g.shards[i].on = true; g.shards[i].x = x; g.shards[i].y = y; g.shards[i].t0 = g.t;
      return;
    }
  }
}

function expireFx(g) {
  for (let i = 0; i < g.rings.length; i++) {
    if (g.rings[i].on && g.t - g.rings[i].t0 >= FX.catchRingMs) g.rings[i].on = false;
  }
  for (let i = 0; i < g.shards.length; i++) {
    if (g.shards[i].on && g.t - g.shards[i].t0 >= FX.shardMs) g.shards[i].on = false;
  }
}

/* 震屏偏移（F-EGG-3B）：≤4px、0.3s、**指数衰减**。
 * 相位用 g.t 而非 Math.random —— 确定性便于断言，且避免每帧乱跳成噪点。 */
function shakeOf(g) {
  if (g.shakeT < 0) return { x: 0, y: 0 };
  const k = g.shakeT / FX.shakeMs;          // 1 → 0
  const a = FX.shakeAmp * k * k;            // 平方 ≈ 指数衰减的前段
  const ph = g.t / 22;
  return { x: Math.round(Math.sin(ph) * a), y: Math.round(Math.cos(ph * 1.3) * a) };
}

/* ── 绘制 ───────────────────────────────────────────────────────── */

/* 椭圆路径（AIUI 未确认 ctx.ellipse，故用 16 段折线近似；rx7/ry9 下肉眼无差） */
function ellipsePath(ctx, cx, cy, rx, ry) {
  ctx.beginPath();
  for (let i = 0; i <= 16; i++) {
    const a = i * Math.PI * 2 / 16;
    const x = cx + Math.cos(a) * rx;
    const y = cy + Math.sin(a) * ry;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

export function render(g, ctx, fade) {
  const f = fade > 0 ? (fade > 1 ? 1 : fade) : 0;
  const col = function (a) { return gcol(fadeTo(a, f)); };
  const dx = camDx(g);
  const sh = shakeOf(g);

  /* ══ 屏幕固定层 ①：HUD 中段条（不随相机平移） ═══════════════ */
  drawHudMid(g, ctx, col);

  /* ══ 世界层：裁剪到裁剪窗后整体平移 dx ═══════════════════════
   * 越出窗的部分直接消失 → 墙外留白（用户的原始诉求）。
   * ⚠ 打砖块已验证 AIUI 宿主支持 save/clip/translate/restore。
   *   震屏以 translate 附加量实现（等价"所有元素加同一偏移"，符合 F-EGG-3B
   *   的禁止项是指**单独**用 translate 做震屏、且避免 save/restore 用于判定）。 */
  ctx.save();
  ctx.beginPath();
  ctx.rect(CLIP_L, VY, CLIP_W, VYB - VY);
  ctx.clip();
  ctx.translate(dx + sh.x, sh.y);

  drawField(g, ctx, col);     // 地面线 + 倍率分界线 + 投放口刻度
  drawWalls(g, ctx, col);     // 边界墙（世界层：它就是"场地到此为止"的边界）
  drawShards(g, ctx, col);
  drawDrops(g, ctx, col);

  ctx.restore();              // ← 世界层结束，坐标回到屏幕系

  /* ══ 屏幕固定层 ② ══════════════════════════════════════════════ */
  drawBasket(g, ctx, col, sh);
  drawLabel(g, ctx, col, sh);
  drawRings(g, ctx, col, sh);
  drawEdgeMarks(g, ctx, col, dx);
  if (g.phase === 'intro' || g.phase === 'gap') drawWaveCard(g, ctx, col);
  if (g.imuDown) {
    text(ctx, EGG.IMU_TEXT, CENTER.x, 176, { size: 14, weight: 400, color: col(L.P72) });
  }
}

/* 场地横线（世界层）：地面线 332、高/中区界 244、中/低区界 271 —— 均 6% */
function drawField(g, ctx, col) {
  ctx.fillStyle = col(L.P06);
  ctx.fillRect(COURT.x, BAND.hi, COURT.w, 1);
  ctx.fillRect(COURT.x, BAND.mid, COURT.w, 1);
  ctx.fillRect(COURT.x, EGG.GROUND, COURT.w, 1);
  /* 投放口刻度（F-EGG-15）：每条轨道在画面区上沿 12px 竖条，表达"蛋从这里落下" */
  for (let i = 0; i < EGG.LANES.length; i++) {
    ctx.fillRect(EGG.LANES[i] - 0.5, VY, 1, 12);
  }
}

/* 边界墙（世界层）：立在球场边界**外侧**，贴球场那一面就是落物的反弹面。
 * v1.34：3px 单线 @72% → 8px **羽化收边带**（内侧面最亮 ≈0.40，向外 4 级淡出）。
 *   左墙：内侧面 x = 64，带子向外（左）铺到 56
 *   右墙：内侧面 x = 416，带子向外（右）铺到 424
 * 两墙随相机平移，滑出裁剪窗即被裁掉 —— 这正是"墙外显示空白"的实现。 */
function drawWalls(g, ctx, col) {
  const ext = { a: COURT.y, len: COURT_B - COURT.y };  // 44 ~ 332
  fadeBand(ctx, 'v', COURT.x, ext, CAM.wallBand, -1, CAM.wallSteps, col);
  fadeBand(ctx, 'v', COURT_R, ext, CAM.wallBand, 1, CAM.wallSteps, col);
}

function drawDrops(g, ctx, col) {
  for (let i = 0; i < g.drops.length; i++) {
    const d = g.drops[i];
    if (!d.on) continue;
    if (d.kind === KIND.BOMB) {
      /* 炸弹：圆 r8 + 顶部引线 6px（F-EGG-32），与蛋形明确区分 */
      fillCircle(ctx, d.x, d.y, DROP.bombR, col(L.P12));
      strokeCircle(ctx, d.x, d.y, DROP.bombR, col(L.P100), 1);
      ctx.fillStyle = col(L.P100);
      ctx.fillRect(d.x - 0.5, d.y - DROP.bombR - DROP.bombFuse, 1, DROP.bombFuse);
    } else {
      const gold = (d.kind === KIND.GOLD);
      let a = L.P72;
      if (gold) {
        /* 金蛋闪烁：**全场同相位**（按全局 g.t，不按各自生成时刻），
         * 多个金蛋同时闪烁视为单一动效（§2.5 同屏只允许一个主导脉冲） */
        const ph = (g.t % FX.goldFlashMs) / FX.goldFlashMs;
        a = (ph < 0.5) ? L.P100 : L.P24;
      }
      ellipsePath(ctx, d.x, d.y, DROP.eggRx, DROP.eggRy);
      ctx.fillStyle = col(L.P12);
      ctx.fill();
      ctx.strokeStyle = col(a);
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
}

/* 蛋篮（**屏幕固定层**：恒钉 CENTER.x，锚定型的核心承诺）。
 * 48×18 下窄梯形。v1.39 由「光秃秃的梯形轮廓」补足三处结构，让它读起来是
 * **一只柳条篮**而不是一个梯形：
 *   ① 篮口卷边 —— 比篮口两侧各出挑 1px、2px 高的横条 @72%（编织篮的收口沿）
 *   ② 编织格 —— 3 竖 2 横 @24%，横线半宽按梯形线性插值（跟随收窄的斜边）
 *   ③ 篮底板 —— 底部 2px @48%（有底才接得住东西，视觉上有"兜"的体量）
 * 接住后 120ms 内描边加粗到 2px（F-EGG-3C）。震屏以坐标偏移叠加。
 *
 * ⚠ ① 必须**先于**细节绘制，且首个 moveTo 保持 (cx − HALF, my) ——
 *   harness E2f 断言「篮子屏幕 x 恒钉 240」就是读这个首点（240 − 24 = 216）。 */
function drawBasket(g, ctx, col, sh) {
  const cx = CENTER.x + sh.x;
  const my = g.mouthY + sh.y;
  const hbw = BASKET.bottomW / 2;
  const by = my + BASKET.h;

  /* ① 篮身梯形 */
  ctx.beginPath();
  ctx.moveTo(cx - HALF, my);
  ctx.lineTo(cx + HALF, my);
  ctx.lineTo(cx + hbw, by);
  ctx.lineTo(cx - hbw, by);
  ctx.closePath();
  ctx.fillStyle = col(L.P12);
  ctx.fill();
  ctx.strokeStyle = col(L.P100);
  ctx.lineWidth = g.flashT >= 0 ? 2 : 1;
  ctx.stroke();

  /* ② 篮口卷边：比篮口各外挑 1px，2px 高 */
  ctx.fillStyle = col(L.P72);
  ctx.fillRect(cx - HALF - 1, my, HALF * 2 + 2, 2);

  /* ③ 编织格：3 条竖柳条（y my+4 ~ by−3）+ 2 道横箍（半宽按梯形插值） */
  ctx.fillStyle = col(L.P24);
  for (let i = -1; i <= 1; i += 1) ctx.fillRect(cx + i * 13, my + 4, 1, BASKET.h - 7);
  for (let k = 1; k <= 2; k += 1) {
    const t = k / 3;                                  // 0.333 / 0.667
    const hw = HALF + (hbw - HALF) * t;               // 24 → 16 线性收窄
    ctx.fillRect(cx - hw, my + BASKET.h * t, hw * 2, 1);
  }

  /* ④ 篮底板 */
  ctx.fillStyle = col(L.P48);
  ctx.fillRect(cx - hbw, by - 2, BASKET.bottomW, 2);
}

/* 倍率标签（F-EGG-18）：低区不显示。
 * ⚠ r6 的「basketCx > 400 翻到左侧」规则在锚定型下**永远不触发**（篮子不出
 *   屏幕中心），故不实现翻转分支——留着只会误导后续维护者。 */
function drawLabel(g, ctx, col, sh) {
  const m = multOf(g.mouthY);
  if (m <= SCORE.multLow) return;
  const s = '×' + m.toFixed(1);
  text(ctx, s, CENTER.x + LABEL.gap + sh.x, g.mouthY + LABEL.dy + sh.y, {
    size: LABEL.size, weight: 500,
    color: col(m >= SCORE.multHi ? L.P100 : L.P72),
    align: 'left',
  });
}

/* 接住扩散圆（F-EGG-3C）：r 6→18、α 100%→0、120ms。屏幕坐标。 */
function drawRings(g, ctx, col, sh) {
  for (let i = 0; i < g.rings.length; i++) {
    const r = g.rings[i];
    if (!r.on) continue;
    const k = clamp((g.t - r.t0) / FX.catchRingMs, 0, 1);
    const rad = 6 + (18 - 6) * k;
    strokeCircle(ctx, r.x + sh.x, r.y + sh.y, rad, col(L.P100 * (1 - k)), 1);
  }
}

/* 落地碎裂：地面线上方几道短裂纹（48%），300ms 后消失 */
function drawShards(g, ctx, col) {
  for (let i = 0; i < g.shards.length; i++) {
    const s = g.shards[i];
    if (!s.on) continue;
    const k = clamp((g.t - s.t0) / FX.shardMs, 0, 1);
    const a = 0.48 * (1 - k);
    if (a <= 0.02) continue;
    ctx.strokeStyle = col(a);
    ctx.lineWidth = 1;
    ctx.beginPath();
    /* 5 道放射状裂纹（微斜，纯竖线在 Ardot 会被判退化几何，此处同防） */
    for (let n = -2; n <= 2; n++) {
      const x0 = s.x + n * 4;
      const len = 6 + (n % 2 === 0 ? 3 : 0);
      ctx.moveTo(x0, EGG.GROUND);
      ctx.lineTo(x0 + n * 0.6, EGG.GROUND - len);
    }
    ctx.stroke();
  }
}

/* 离屏落物指示器（相机化的补偿）：落物滑出裁剪窗时在对应屏幕边画一枚朝外
 * 三角，只标方向不标距离；同屏最多 3 枚，按方向去重后至多画两枚。
 * 贴在裁剪窗内侧（紧贴墙），不要画到墙外的空白里去。 */
function drawEdgeMarks(g, ctx, col, dx) {
  let l = false, r = false, ly = 0, ry = 0;
  for (let i = 0; i < g.drops.length; i++) {
    const d = g.drops[i];
    if (!d.on) continue;
    const sx = d.x + dx;
    if (sx < CLIP_L) { l = true; ly = d.y; }
    else if (sx > CLIP_R) { r = true; ry = d.y; }
  }
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

/* HUD 中段条（F-EGG-13/§4.3）：墨中心 y=24，占 x ∈ [92, 354]。
 * 双通道编码：失误数同时由「文字标签」与「实心方块数」表达。 */
function drawHudMid(g, ctx, col) {
  text(ctx, String(g.score), HUDX.scoreX, HUDX.midY,
    { size: 13, weight: 500, mono: true, color: col(L.P100), align: 'left' });
  text(ctx, g.caught + '/' + NEED_TOTAL, HUDX.progX, HUDX.midY,
    { size: 12, weight: 400, mono: true, color: col(L.P72) });
  text(ctx, '失误', HUDX.missTextX, HUDX.midY,
    { size: 11, weight: 500, color: col(L.P48), align: 'left' });
  for (let i = 0; i < EGG.MISS_MAX; i++) {
    const x = HUDX.slotX + i * (HUDX.slotSize + HUDX.slotGap);
    if (i < g.miss) {
      ctx.fillStyle = col(L.P72);
      ctx.fillRect(x, HUDX.midY - HUDX.slotSize / 2, HUDX.slotSize, HUDX.slotSize);
    } else {
      ctx.strokeStyle = col(L.P24);
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, HUDX.midY - HUDX.slotSize / 2 + 0.5,
        HUDX.slotSize - 1, HUDX.slotSize - 1);
    }
  }
}

/* 波次过场卡（F-EGG-41）：14/500/72% 主行 + 12/400/48% 副行 */
function drawWaveCard(g, ctx, col) {
  /* intro 时 waveIdx=0 → 「第 1 波」；gap 时 waveIdx **已经**推进到下一波
   * （见 update 的波次完成分支），故直接用 waveIdx 即可 —— 过场文案本就是
   * 预告下一波。写成 waveIdx + 1 会跳一波。 */
  const idx = (g.phase === 'intro') ? 0 : g.waveIdx;
  if (idx < 0 || idx >= WAVES.length) return;
  text(ctx, '第 ' + (idx + 1) + ' 波', CENTER.x, 176,
    { size: 14, weight: 500, color: col(L.P72) });
  text(ctx, EGG.WAVE_SUB[idx], CENTER.x, 198,
    { size: 12, weight: 400, color: col(L.P48) });
}

/* ── 结算 ───────────────────────────────────────────────────────── */

/* GameResult 契约（§7.1）：motion 由页面的引擎填充，本模块只产出玩法字段。
 * extra 最多 2 项、label ≤4 字。 */
export function result(g) {
  return {
    score: g.score,
    cleared: !!g.cleared,
    reachedLevel: clamp(g.waveIdx + 1, 1, WAVES.length),
    extra: [
      { label: '金蛋接取', value: String(g.goldCaught) },
      { label: '躲开炸弹', value: String(g.bombDodged) },
    ],
  };
}
