/* missile.js —— 《导弹指挥部》玩法模块（PRD-05 · 相机版 v1.32）
 *
 * 接口契约（与 brick / eggcatch / plane / marble 同源）：
 *   create()              → g 状态对象
 *   update(g, dtMs, snap) → events[]（本册不播音，由页面播）
 *   render(g, ctx, fade)  → 画战场/城市/弹头/爆炸/光标/HUD 中段
 *   result(g)             → { score, cleared, reachedLevel, extra[] }
 *   fire(g)               → bool（单击引爆，供页面 tapRole='fire' 调用）
 *
 * 【三条硬红线 · 违反即冻结语义失效】
 *   1. **禁止 Date.now() 与任何定时器**：全部计时基于 update(dtMs) 累加的
 *      g.t。框架页在 B2/B3/B4 期间不调 update，g.t 自动停走 —— 冻结与续算
 *      无需任何显式 freeze / resume（F-MSL-70/71）。
 *   2. **禁止 import sfx / storage**：update 返回事件数组，播音与落盘全归
 *      页面。本模块因此可在 node 下直接跑断言。
 *   3. **禁止自绘遮罩或自行降 alpha**：变暗一律由页面把 fade 传进来，走
 *      ring.js 的 fadeTo。render 的第三参 fade 即为此设。
 *
 * 【映射形态】**锚定型 yaw 相机 + pitch 直控**（2026-09-05 用户指定改造，
 * 推翻 PRD-05 r5 的双轴 1:1 直控；与 PRD-02 打砖块 v1.28 / PRD-03 接鸡蛋
 * v1.29 / PRD-06 打飞机 v1.30 **同一个模型**，几何定义见 layout.js 的 MSL 块）：
 *
 *   横向（yaw）：十字光标**恒钉屏幕中心 x=240**，头动驱动【世界反向平移】。
 *     光标的**世界坐标 == 相机中心 camCx**，绘制偏移 dx = 240 − camCx。
 *   纵向（pitch）：光标 y **保持直控**，行程 ±80（r5 的 ±160 太大）。
 *
 *   ⚠ 这次改造**零玩法损失**：r5 直控的「光标世界坐标」与相机版的
 *     「camCx」是同一个表达式 `240 + snap.x`，瞄准精度完全不变。
 *
 * ⚠ 纵向**不相机化**：弹头本就在下落，画面再纵向滑动会让玩家分不清
 *   「是弹头在落」还是「是画面在动」（与接鸡蛋 EGG 块同一条理由）。
 */

import { L, g as gcol } from './theme.js';
import { CENTER, VIEWPORT, MSL } from './layout.js';
import { SEM_FOLLOW } from './input.js';
import { clamp, easeOut, text, fillCircle, strokeCircle, fadeBand } from './draw.js';
import { fadeTo } from './ring.js';

const COURT = MSL.COURT;
const CITY = MSL.CITY;
const BAT = MSL.BATTERY;
const CUR = MSL.CURSOR;
const WH = MSL.WARHEAD;
const BOOM = MSL.BOOM;
const CAM = MSL.CAMERA;
const SCORE = MSL.SCORE;
const HUDX = MSL.HUDX;
const FX = MSL.FX;

const COURT_R = COURT.x + COURT.w;        // 416
const COURT_B = COURT.y + COURT.h;        // 332 == HORIZON_Y
const CX = COURT.x + COURT.w / 2;         // 240
const VY = VIEWPORT.y;                    // 44
const VYB = VIEWPORT.y + VIEWPORT.h;      // 340

const CITY_TOP = MSL.HORIZON_Y - CITY.h;  // 316（城市顶边）
const BAT_CX = BAT.x0 + BAT.w / 2;        // 240

/* 裁剪窗 = 战场 ± 墙厚：世界层只在这道窗里可见，越界部分直接消失 → 留白。
 * 这正是用户要的「左右两侧超出边界的区域显示空白」。 */
const CLIP_L = COURT.x - CAM.wallBand;    // 56（v1.34：墙带由 3 加宽到 8）
const CLIP_R = COURT_R + CAM.wallBand;    // 424
const CLIP_W = CLIP_R - CLIP_L;           // 368

/* 行程半幅：战场中心 → 光标世界坐标能到达的最远处，由几何算出（**勿硬编码**）。
 * TRAVEL = 352/2 − 16 = 176 − 16 = 160 → camCx ∈ [80, 400]。 */
export const TRAVEL = COURT.w / 2 - CUR.r;
export const CAM_MIN = CX - TRAVEL;       // 80
export const CAM_MAX = CX + TRAVEL;       // 400

const POOL_W = 24;    // 弹头池（W3 三发齐落 + 分叉，16 上限留余量）
const POOL_D = 8;     // 扬尘池
const POOL_L = 4;     // 发射连线池

/* 波次结束判定用的「本波弹头总数」：W3 因分叉会超出 missiles，故以
 * g.waveSpawned 与在场数联合判定（见 stepWave）。 */
const WAVE_N = MSL.WAVES.length;

/* ── 状态构造 ───────────────────────────────────────────────────── */

export function create() {
  const g = {
    t: 0,                  // 游戏内时钟（ms），唯一时间源
    phase: 'gap',          // gap | wave | over
    phaseT: 0,

    waveIdx: 0,            // 0..2（对应 W1~W3）
    waveSpawned: 0,        // 本波已生成发数
    spawnT: 0,             // 距下一组的累计时间

    camCx: CX,             // 相机中心 == 光标世界坐标（锚定型）
    cursorY: CUR.home,     // 光标屏幕 y（pitch 直控）；纵向不经相机 → 世界 y 同值

    cities: [],            // 6 座
    batteryAlive: true,
    ammo: MSL.WAVES[0].ammo,
    score: 0,

    warheads: [],          // 弹头池
    booms: [],             // 爆炸池（≤3 同屏）
    dusts: [],             // 落地扬尘池
    links: [],             // 发射连线池

    denyT: -1,             // 单击被拒反馈（空仓 / 同屏爆炸满）
    stats: { total: 0, intercepted: 0 },

    over: false,
    cleared: false,
    finished: false,
    overT: -1,             // 失败提示 0.6s 倒计时
    imuDown: false,
    idleMs: 0,
  };

  for (let i = 0; i < CITY.xs.length; i++) g.cities.push({ alive: true });
  for (let i = 0; i < POOL_W; i++) {
    g.warheads.push({ on: false, x: 0, y: 0, dx: 0, dy: 0, speed: 0,
      target: null, mirv: false, split: false, t0: 0 });
  }
  /* rPrev：上一帧的半径，用于「扫掠判定」（见 stepBooms） */
  for (let i = 0; i < BOOM.max; i++) g.booms.push({ on: false, x: 0, y: 0, t0: 0, rPrev: 0 });
  for (let i = 0; i < POOL_D; i++) g.dusts.push({ on: false, x: 0, y: 0, t0: 0 });
  for (let i = 0; i < POOL_L; i++) g.links.push({ on: false, x0: 0, y0: 0, x1: 0, y1: 0, t0: 0 });
  return g;
}

/* 世界 → 屏幕的横向绘制偏移。光标恒钉 CENTER.x，故相机中心 == 光标世界坐标。
 * dx > 0 表示世界整体右移（头左转）。范围 ±TRAVEL(160)。 */
export function camDx(g) { return CENTER.x - g.camCx; }

/* ── 目标与几何 ─────────────────────────────────────────────────── */

export function aliveCities(g) {
  let n = 0;
  for (let i = 0; i < g.cities.length; i++) if (g.cities[i].alive) n++;
  return n;
}

/* 目标矩形（世界坐标）；目标已毁返回 null（F-MSL-45：落地扬尘无害） */
export function targetRect(g, tgt) {
  if (!tgt) return null;
  if (tgt.kind === 'battery') {
    if (!g.batteryAlive) return null;
    return { x0: BAT.x0, x1: BAT.x0 + BAT.w, y0: CITY_TOP, y1: MSL.HORIZON_Y };
  }
  const c = g.cities[tgt.idx];
  if (!c || !c.alive) return null;
  const cx = CITY.xs[tgt.idx];
  return { x0: cx - CITY.w / 2, x1: cx + CITY.w / 2, y0: CITY_TOP, y1: MSL.HORIZON_Y };
}

/* 目标池（F-MSL-41）：W1 仅城市；W2 起加入炮台，权重 城市4 : 炮台1。
 * 被毁目标不再入池（后续新弹不会瞄它）。 */
function pickTarget(g) {
  const pool = [];
  let sum = 0;
  for (let i = 0; i < g.cities.length; i++) {
    if (!g.cities[i].alive) continue;
    pool.push({ kind: 'city', idx: i, w: MSL.TARGET_W.city });
    sum += MSL.TARGET_W.city;
  }
  if (g.waveIdx > 0 && g.batteryAlive) {
    pool.push({ kind: 'battery', idx: -1, w: MSL.TARGET_W.battery });
    sum += MSL.TARGET_W.battery;
  }
  if (!pool.length) return null;
  let r = Math.random() * sum;
  for (let i = 0; i < pool.length; i++) {
    r -= pool[i].w;
    if (r <= 0) return { kind: pool[i].kind, idx: pool[i].idx };
  }
  return { kind: pool[0].kind, idx: pool[0].idx };
}

/* ── 更新 ───────────────────────────────────────────────────────── */

export function update(g, dtMs, snap) {
  const ev = [];
  if (g.over && g.finished) return ev;

  /* dt 一律钳到 0~100ms（切后台/卡顿一帧巨跳会让弹头穿透判定带） */
  const dt = dtMs > 100 ? 100 : (dtMs < 0 ? 0 : dtMs);
  g.t += dt;

  /* IMU 不可用（§10）：不推进任何玩法，光标锁中立位。
   * 禁止在无输入状态下继续推进波次（NFR-05）。 */
  if (!snap || snap.ok === false) {
    g.imuDown = true;
    g.camCx = CX;
    g.cursorY = CUR.home;
    return ev;
  }
  g.imuDown = false;

  /* 两轴独立、无耦合项（F-MSL-03 相机版）：
   * 横向锚定型：camCx = 240 + SEM_FOLLOW × snap.x
   *   snap.x > 0（头左转）→ camCx 减小 → dx 增大 → 世界右滑。
   * 纵向直控：抬头 = 光标 y 减小 = 上升（F-MSL-01/02 公式，行程收窄 ±80）。
   *   ⚠ snap.y 的符号**尚未真机标定**（与 PRD-03/04/06 同一待办）。若真机
   *     上下反向，改 layout.js 的 CURSOR 或在此处取反，**不要动
   *     input.js 的 SIGN**（会连主页菜单一起反转）。 */
  g.camCx = clamp(CENTER.x + SEM_FOLLOW * (snap.x || 0), CAM_MIN, CAM_MAX);
  g.cursorY = clamp(CUR.home - clamp((snap.y || 0) * CUR.vscale, -CUR.half, CUR.half),
    CUR.home - CUR.half, CUR.home + CUR.half);

  /* 短动效计时（所有阶段都要走，否则冻结期恢复会残留） */
  if (g.denyT >= 0) { g.denyT -= dt; if (g.denyT < 0) g.denyT = -1; }
  expireFx(g);

  /* 无输入挂机（§10）：5 分钟零输入 → 停止并进结算 */
  if (snap.x !== 0 || snap.y !== 0) g.idleMs = 0;
  else g.idleMs += dt;
  if (g.idleMs >= MSL.IDLE_MS) { lose(g, ev); return ev; }

  /* 失败提示 0.6s（F-MSL-64）：画面冻结，只走倒计时 */
  if (g.phase === 'over') {
    if (g.overT >= 0) {
      g.overT -= dt;
      if (g.overT <= 0 && !g.finished) { g.finished = true; ev.push('finished'); }
    }
    return ev;
  }

  /* 波次过场（F-MSL-50/51）：1.2s，清场 + 停生成，光标保持可控 */
  if (g.phase === 'gap') {
    if (g.t - g.phaseT >= MSL.GAP_MS) {
      g.phase = 'wave';
      g.phaseT = g.t;
      g.spawnT = 0;
      ev.push('wave');
    }
    return ev;
  }

  stepSpawn(g, dt);
  stepWarheads(g, dt, ev);
  if (g.phase === 'over') return ev;
  stepBooms(g, dt, ev);
  return ev;
}

/* 生成（F-MSL-40/42/43）：按波次表每 gapMs 生成一组 perEvent 发。
 * W3 的第 2、4 组各安排 1 发分叉弹（mirv）。 */
function stepSpawn(g, dt) {
  const cfg = MSL.WAVES[g.waveIdx];
  if (g.waveSpawned >= cfg.missiles) return;
  g.spawnT += dt;
  if (g.spawnT < cfg.gapMs) return;
  g.spawnT -= cfg.gapMs;

  const groupIdx = Math.floor(g.waveSpawned / cfg.perEvent);
  const mirvHere = cfg.mirv > 0 && (groupIdx === 1 || groupIdx === 3);
  const n = Math.min(cfg.perEvent, cfg.missiles - g.waveSpawned);
  for (let i = 0; i < n; i++) {
    spawnWarhead(g, cfg.speed, i === 0 && mirvHere);
    g.waveSpawned += 1;
  }
}

function spawnWarhead(g, speed, mirv, wx, wy) {
  for (let i = 0; i < g.warheads.length; i++) {
    const w = g.warheads[i];
    if (w.on) continue;
    const tgt = pickTarget(g);
    if (!tgt) return null;                       // 无存活目标 → 不生成
    const sx = (wx === undefined)
      ? MSL.SPAWN_X.min + Math.random() * (MSL.SPAWN_X.max - MSL.SPAWN_X.min)
      : wx;
    const sy = (wy === undefined) ? MSL.SPAWN_Y : wy;
    const r = targetRect(g, tgt);
    if (!r) return null;
    const tx = (r.x0 + r.x1) / 2;
    const ty = (r.y0 + r.y1) / 2;
    const vx = tx - sx, vy = ty - sy;
    const len = Math.sqrt(vx * vx + vy * vy) || 1;
    w.on = true;
    w.x = sx; w.y = sy;
    w.dx = vx / len; w.dy = vy / len;
    w.speed = speed;
    w.target = tgt;
    w.mirv = !!mirv;
    w.split = false;
    w.t0 = g.t;
    g.stats.total += 1;
    return w;
  }
  return null;
}

/* 弹头推进（F-MSL-40/43/44/45） */
function stepWarheads(g, dt, ev) {
  for (let i = 0; i < g.warheads.length; i++) {
    const w = g.warheads[i];
    if (!w.on) continue;
    const step = w.speed * dt / 1000;
    w.x += w.dx * step;
    w.y += w.dy * step;

    /* 空中分叉（F-MSL-43）：仅 W3，y ≥ 176 时裂为 2~3 弹头，
     * 各弹头从**当前存活**目标池重选（分叉是"新生成"事件，适用 F-MSL-41）。 */
    if (w.mirv && !w.split && w.y >= MSL.MIRV_Y) {
      w.split = true;
      splitWarhead(g, w, ev);
      continue;
    }

    /* 命中判定（F-MSL-44）：进入目标矩形外扩 HIT_INSET → 目标被毁 */
    const r = targetRect(g, w.target);
    const ins = MSL.HIT_INSET;
    if (r && w.x >= r.x0 - ins && w.x <= r.x1 + ins
        && w.y >= r.y0 - ins && w.y <= r.y1 + ins) {
      w.on = false;
      destroyTarget(g, w.target, w.x, ev);
      if (g.phase === 'over') return;
      continue;
    }

    /* 落地（F-MSL-45）：目标已毁（r == null）或飞过地平线 → 仅扬尘无害 */
    if (w.y >= MSL.HORIZON_Y + ins) {
      w.on = false;
      pushDust(g, w.x);
      continue;
    }
  }
  checkWaveEnd(g, ev);
}

function splitWarhead(g, w, ev) {
  const n = MSL.MIRV_N[Math.floor(Math.random() * MSL.MIRV_N.length)];
  const sx = w.x, sy = w.y, speed = w.speed;
  w.on = false;
  for (let k = 0; k < n; k++) {
    spawnWarhead(g, speed, false, sx, sy);
  }
}

/* 目标被毁（F-MSL-44/63）：城市当局内不可恢复；炮台被毁即失败 */
function destroyTarget(g, tgt, wx, ev) {
  if (tgt.kind === 'battery') {
    g.batteryAlive = false;
    pushDust(g, wx);
    ev.push('citydown');
    lose(g, ev);
    return;
  }
  const c = g.cities[tgt.idx];
  if (!c || !c.alive) return;
  c.alive = false;
  pushDust(g, CITY.xs[tgt.idx]);
  ev.push('citydown');
  /* F-MSL-63：6 座全毁 → 立即失败（不等弹道落地） */
  if (aliveCities(g) === 0) lose(g, ev);
}

/* 爆炸（F-MSL-30~33）：扩张 → 收缩；每帧按当前半径扫一次弹头。
 * 弹头被拦截即 off，天然只结算一次（F-MSL-31）。 */
function stepBooms(g, dt, ev) {
  for (let i = 0; i < g.booms.length; i++) {
    const b = g.booms[i];
    if (!b.on) continue;
    const k = (g.t - b.t0) / BOOM.ms;
    if (k >= 1) { b.on = false; continue; }
    const r = boomRadius(k);
    /* **扫掠判定**（v1.38）：冲击波在两帧之间扫过的是 max(rPrev, r) 这一圈，
     * 只判当前半径会在外圈留下一条「看得见却打不掉」的窄带 —— 半径越大
     * 帧间隔越容易整段跨过某个距离。取两帧较大值 = 正确的扫掠体。 */
    const rTest = Math.max(r, b.rPrev || 0);
    b.rPrev = r;
    for (let n = 0; n < g.warheads.length; n++) {
      const w = g.warheads[n];
      if (!w.on) continue;
      const dx = w.x - b.x, dy = w.y - b.y;
      if (dx * dx + dy * dy > rTest * rTest) continue;
      w.on = false;
      g.score += SCORE.perWarhead;
      g.stats.intercepted += 1;
      ev.push('boom');
    }
  }
  checkWaveEnd(g, ev);
}

/* 波结束（§6.2）：本波发数已发完 + 在场弹头清空 → 波末结算 */
function checkWaveEnd(g, ev) {
  if (g.phase !== 'wave' || g.over) return;
  const cfg = MSL.WAVES[g.waveIdx];
  if (g.waveSpawned < cfg.missiles) return;
  for (let i = 0; i < g.warheads.length; i++) if (g.warheads[i].on) return;

  /* 波末奖励（F-MSL-61）：存活城市 ×100 + 剩余雷 ×5（通关波照常结算） */
  g.score += aliveCities(g) * SCORE.cityBonus + g.ammo * SCORE.ammoBonus;

  if (g.waveIdx >= WAVE_N - 1) { win(g, ev); return; }
  g.waveIdx += 1;
  g.waveSpawned = 0;
  g.spawnT = 0;
  g.ammo = MSL.WAVES[g.waveIdx].ammo;   // 每波独立补给，上波剩余清零
  /* 清场（F-MSL-50）：爆炸与扬尘在过场开始时一并清掉 */
  for (let i = 0; i < g.booms.length; i++) g.booms[i].on = false;
  g.phase = 'gap';
  g.phaseT = g.t;
  ev.push('clear');
}

/* ── 单击引爆（F-MSL-21/30/32/34/35） ───────────────────────────── */

/* 供页面调用（tapRole='fire'）。返回 true 表示已引爆。
 * 失败两种：① 余量 0；② 同屏爆炸已达 3 枚 —— 两者都**不消耗**拦截雷，
 * 并置 denyT 给 120ms 闪烁反馈（F-MSL-32/34：不静默吞输入）。 */
export function fire(g) {
  if (g.over || g.phase === 'over' || g.phase === 'gap') return false;
  if (g.ammo <= 0) { g.denyT = FX.denyMs; return false; }
  let slot = -1;
  for (let i = 0; i < g.booms.length; i++) {
    if (!g.booms[i].on) { slot = i; break; }
  }
  if (slot < 0) { g.denyT = FX.denyMs; return false; }

  g.ammo -= 1;
  const b = g.booms[slot];
  b.on = true;
  b.x = g.camCx;          // 爆炸是**世界坐标**（空间中的一点，不随相机移动）
  b.y = g.cursorY;        // 纵向不经相机 → 世界 y == 屏幕 y
  b.t0 = g.t;
  b.rPrev = BOOM.r0;      // 扫掠判定起点（见 stepBooms）
  pushLink(g);
  return true;
}

/* 发射连线（F-MSL-35）：炮台顶 (240,316) → 爆炸点，120ms 渐隐，纯视觉 */
function pushLink(g) {
  for (let i = 0; i < g.links.length; i++) {
    const l = g.links[i];
    if (l.on) continue;
    l.on = true;
    l.x0 = BAT_CX;
    l.y0 = CITY_TOP;
    l.x1 = g.camCx;
    l.y1 = g.cursorY;
    l.t0 = g.t;
    return;
  }
}

/* ── 短动效池 ───────────────────────────────────────────────────── */

function pushDust(g, wx) {
  for (let i = 0; i < g.dusts.length; i++) {
    if (!g.dusts[i].on) {
      g.dusts[i].on = true;
      g.dusts[i].x = wx;
      g.dusts[i].y = MSL.HORIZON_Y;
      g.dusts[i].t0 = g.t;
      return;
    }
  }
}

function expireFx(g) {
  for (let i = 0; i < g.dusts.length; i++) {
    if (g.dusts[i].on && g.t - g.dusts[i].t0 >= FX.dustMs) g.dusts[i].on = false;
  }
  for (let i = 0; i < g.links.length; i++) {
    if (g.links[i].on && g.t - g.links[i].t0 >= FX.linkMs) g.links[i].on = false;
  }
}

/* 爆炸半径（F-MSL-30）：前 0.3s r0→rMax ease-out 扩张，后 0.3s 收缩归零 */
export function boomRadius(k) {
  if (k <= 0) return BOOM.r0;
  if (k >= 1) return 0;
  if (k < 0.5) return BOOM.r0 + (BOOM.rMax - BOOM.r0) * easeOut(k / 0.5);
  return BOOM.rMax * (1 - (k - 0.5) / 0.5);
}

/* ── 结算 ───────────────────────────────────────────────────────── */

function lose(g, ev) {
  if (g.over) return;
  g.over = true;
  g.cleared = false;
  g.phase = 'over';
  g.overT = 600;            // F-MSL-64：0.6s「防线失守」提示
  ev.push('fail');
}

function win(g, ev) {
  if (g.over) return;
  g.over = true;
  g.cleared = true;
  g.phase = 'over';
  g.overT = 600;
  ev.push('clear');
}

/* GameResult 契约（§7.1）：motion 由页面的引擎填充，本模块只产出玩法字段。
 * extra 最多 2 项、label ≤4 字。 */
export function result(g) {
  const rate = g.stats.total
    ? Math.round(g.stats.intercepted / g.stats.total * 100) : 0;
  return {
    score: g.score,
    cleared: !!g.cleared,
    reachedLevel: g.waveIdx + 1,
    extra: [
      { label: '拦截率', value: rate + '%' },
      { label: '幸免城市', value: aliveCities(g) + '/' + CITY.xs.length },
    ],
  };
}

/* 状态胶囊文案（F-MSL-18 §2.6.2）：存活城市数 —— 本作的"生命条"就是城市 */
export function statusText(g) {
  return '城市 ' + aliveCities(g) + '/' + CITY.xs.length;
}

/* ── 绘制 ───────────────────────────────────────────────────────── */

export function render(g, ctx, fade) {
  const f = fade > 0 ? (fade > 1 ? 1 : fade) : 0;
  const col = function (a) { return gcol(fadeTo(a, f)); };
  const dx = camDx(g);

  /* ══ 屏幕固定层 ①：HUD 中段条（不随相机平移） ═══════════════ */
  drawHudMid(g, ctx, col);

  /* ══ 世界层：裁剪到裁剪窗后整体平移 dx ═══════════════════════
   * 越出窗的部分直接消失 → 墙外留白（用户的原始诉求）。
   * ⚠ 打砖块已验证 AIUI 宿主支持 save/clip/translate/restore。 */
  ctx.save();
  ctx.beginPath();
  ctx.rect(CLIP_L, VY, CLIP_W, VYB - VY);
  ctx.clip();
  ctx.translate(dx, 0);

  drawWalls(g, ctx, col);
  drawHorizon(g, ctx, col);
  drawCities(g, ctx, col);
  drawLinks(g, ctx, col);
  drawDusts(g, ctx, col);
  drawWarheads(g, ctx, col, dx);
  drawBooms(g, ctx, col);

  ctx.restore();                 // ← 世界层结束，坐标回到屏幕系

  /* ══ 屏幕固定层 ② ══════════════════════════════════════════════ */
  drawOffscreenMarks(g, ctx, col, dx);
  drawCursor(g, ctx, col);
  if (g.phase === 'gap') drawGapCard(g, ctx, col);
  if (g.phase === 'over') drawOverCard(g, ctx, col);
  if (g.imuDown) {
    text(ctx, MSL.IMU_TEXT, CENTER.x, 176, { size: 14, weight: 400, color: col(L.P72) });
  }
}

/* 边界墙（世界层）：立在战场边界**外侧**，贴战场那一面就是光标的活动边界。
 * v1.34：3px 单线 @72% → 8px **羽化收边带**（内侧面最亮 ≈0.40，向外 4 级淡出）。
 *   左墙：内侧面 x = 64，带子向外（左）铺到 56
 *   右墙：内侧面 x = 416，带子向外（右）铺到 424
 * 两墙随相机平移，滑出裁剪窗即被裁掉 —— 这正是"墙外显示空白"的实现。 */
function drawWalls(g, ctx, col) {
  const ext = { a: COURT.y, len: COURT_B - COURT.y };
  fadeBand(ctx, 'v', COURT.x, ext, CAM.wallBand, -1, CAM.wallSteps, col);
  fadeBand(ctx, 'v', COURT_R, ext, CAM.wallBand, 1, CAM.wallSteps, col);
}

/* 地平线（F-MSL-14）：1px / 24%，横穿整个战场宽度（世界层，跟着滑） */
function drawHorizon(g, ctx, col) {
  ctx.fillStyle = col(L.P24);
  ctx.fillRect(COURT.x, MSL.HORIZON_Y - 0.5, COURT.w, 1);
}

/* 城市与炮台（F-MSL-11/13）：
 * 完好 = 72% 实线描边 + 12% 底纹；被毁 = 24% **虚线**残影轮廓
 * （**亮度 + 线型双通道**，F-MSL-11）。 */
/* 城市楼群（v1.39）：24×16 的框里此前只有 3 根竖线，远看就是个带条纹的
 * 方块 —— 认不出是「城市」。改成 **3 栋高低错落的楼**组成的天际线：
 *   TOWERS = [左偏dx, 宽, 顶相对 CITY_TOP 的下沉量]
 *   左楼 8 宽贴顶（最高） / 中楼 6 宽下沉 6（最矮） / 右楼 8 宽下沉 4
 * 每栋加一列 **2×1 横向窗带** @48%（行距 4、首行距楼顶 4），最高那栋再立
 * 一根 3px 天线 —— 有了窗和天线，小方块才读作「楼房」。
 * ⚠ 尺寸**严格锁在 24×16**：harness A1f 断言 w/h/顶/两端距墙各 16px，
 *   楼群只许在框内做切分，不许改外框。 */
const TOWERS = [[-12, 8, 0], [-3, 6, 6], [4, 8, 4]];

function drawCityBlock(ctx, col, cx) {
  const base = MSL.HORIZON_Y;                 // 332
  for (let i = 0; i < TOWERS.length; i += 1) {
    const t = TOWERS[i];
    const x = cx + t[0], w = t[1], top = CITY_TOP + t[2];
    fillRectPath(ctx, x, top, w, base - top, col(L.P12));
    strokeRectPath(ctx, x, top, w, base - top, col(L.P72), 1);
    /* 窗带：单列居中 2px 宽，纵向行距 4，距底至少留 1px */
    ctx.fillStyle = col(L.P48);
    const wx = x + ((w - 2) >> 1);
    for (let r = top + 4; r + 1 < base - 1; r += 4) ctx.fillRect(wx, r, 2, 1);
  }
  /* 最高那栋立天线（双通道：天际线不只是高低差，还有一根竖起的塔尖） */
  ctx.fillStyle = col(L.P48);
  ctx.fillRect(cx - 9, CITY_TOP - 3, 1, 3);
}

function drawCities(g, ctx, col) {
  for (let i = 0; i < CITY.xs.length; i++) {
    const cx = CITY.xs[i];
    if (g.cities[i].alive) {
      drawCityBlock(ctx, col, cx);
    } else {
      dashRectPath(ctx, cx - CITY.w / 2, CITY_TOP, CITY.w, CITY.h, col(L.P24), 1, [3, 3]);
    }
  }
  /* 炮台：梯形（下宽上窄）+ 底座 + 双联装高炮 */
  ctx.beginPath();
  ctx.moveTo(BAT.x0, MSL.HORIZON_Y);
  ctx.lineTo(BAT.x0 + 6, CITY_TOP);
  ctx.lineTo(BAT.x0 + BAT.w - 6, CITY_TOP);
  ctx.lineTo(BAT.x0 + BAT.w, MSL.HORIZON_Y);
  ctx.closePath();
  if (g.batteryAlive) {
    ctx.fillStyle = col(L.P12);
    ctx.fill();
    ctx.strokeStyle = col(L.P72);
    ctx.lineWidth = 1;
    ctx.stroke();

    /* 底座：y 329~332 的 28 宽横带（贴着梯形斜边内缩，不会溢出轮廓） */
    ctx.fillStyle = col(L.P24);
    ctx.fillRect(BAT.x0 + 2, MSL.HORIZON_Y - 3, BAT.w - 4, 3);

    /* 双联装高炮：两根 2px 炮管自顶面向斜上方张开，管端 2×2 炮口 @100%。
     * 有炮管才读得出「这是能打导弹的炮台」，否则就是个梯形盒子。 */
    const bcx = BAT.x0 + BAT.w / 2;                 // 240
    ctx.strokeStyle = col(L.P72);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(bcx - 3, CITY_TOP + 3);
    ctx.lineTo(bcx - 7, CITY_TOP - 6);
    ctx.moveTo(bcx + 3, CITY_TOP + 3);
    ctx.lineTo(bcx + 7, CITY_TOP - 6);
    ctx.stroke();
    ctx.fillStyle = col(L.P100);
    ctx.fillRect(bcx - 8, CITY_TOP - 8, 2, 2);
    ctx.fillRect(bcx + 6, CITY_TOP - 8, 2, 2);
  } else {
    dashStroke(ctx, col(L.P24), 1, [3, 3]);
  }
}

/* 弹头（F-MSL-16/17）：1px 拖尾 + r2 圆点，48%；
 * 弹道段距光标 < hintDist(20px) 时该段 48% → 72% 微加亮（**只做视觉辅助，
 * 无自动吸附**）。加亮判定用**屏幕坐标**（光标恒钉 240）。
 *
 * ⚠ v1.38 修 bug：本函数在**世界层**（render 已 translate(dx)）内作画，
 *   绘制坐标必须是**世界坐标**。此前写成 `w.x + dx`（屏幕系）——
 *   叠加 translate 后实际落在 w.x + 2·dx，转头时弹头被画偏 dx（最多 ±160px）。
 *   后果正是用户报的「导弹明明在爆炸圈里却打不掉」：圈画在正确位置（世界
 *   camCx → 屏幕 240），弹头却画在旁边，而**引爆判定用世界坐标**是对的，
 *   于是看的与打的对不上。dx=0 时不可见 → harness 全绿也抓不到。 */
function drawWarheads(g, ctx, col, dx) {
  const csx = CENTER.x, csy = g.cursorY;
  for (let i = 0; i < g.warheads.length; i++) {
    const w = g.warheads[i];
    if (!w.on) continue;
    const ex = w.x - w.dx * WH.trail;          // 世界坐标
    const ey = w.y - w.dy * WH.trail;
    /* 只有「距光标加亮」要换算到屏幕系（光标恒钉 240） */
    const near = segDist(csx, csy, ex + dx, ey, w.x + dx, w.y) < WH.hintDist;
    const a = near ? L.P72 : L.P48;
    ctx.strokeStyle = col(a);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(w.x, w.y);
    ctx.stroke();
    fillCircle(ctx, w.x, w.y, WH.r, col(a));
    /* 分叉弹：在分裂前加一个 24% 的分叉预告环（W3 的"防空警报时刻"） */
    if (w.mirv && !w.split) strokeCircle(ctx, w.x, w.y, WH.r + 4, col(L.P24), 1);
  }
}

/* 爆炸（F-MSL-33）：圆环描边 100% + 内部填充 ≤12%，描边 α 随半径递减。
 * ⚠ **禁止实心大圆** —— r60 直径 120px 是违规大面。 */
function drawBooms(g, ctx, col) {
  for (let i = 0; i < g.booms.length; i++) {
    const b = g.booms[i];
    if (!b.on) continue;
    const k = clamp((g.t - b.t0) / BOOM.ms, 0, 1);
    const r = boomRadius(k);
    if (r <= 0.5) continue;
    const keep = 1 - k;                      // 消散感：α 随半径增大而递减
    fillCircle(ctx, b.x, b.y, r, col(L.P12 * keep));
    strokeCircle(ctx, b.x, b.y, r, col(L.P100 * keep), r > 30 ? 1 : 1.5);
  }
}

/* 落地扬尘（F-MSL-45）：三条虚线弧，0.3s，无害无扣分 */
function drawDusts(g, ctx, col) {
  for (let i = 0; i < g.dusts.length; i++) {
    const d = g.dusts[i];
    if (!d.on) continue;
    const k = clamp((g.t - d.t0) / FX.dustMs, 0, 1);
    const a = 0.24 * (1 - k);
    if (a <= 0.02) continue;
    ctx.strokeStyle = col(a);
    ctx.lineWidth = 1;
    for (let n = 1; n <= 3; n++) {
      const rr = 5 + n * 4 * (0.5 + k);
      ctx.beginPath();
      ctx.arc(d.x, d.y, rr, Math.PI, Math.PI * 2);
      ctx.stroke();
    }
  }
}

/* 发射连线（F-MSL-35）：炮台顶 → 爆炸点，120ms 快反馈档渐隐 */
function drawLinks(g, ctx, col) {
  for (let i = 0; i < g.links.length; i++) {
    const l = g.links[i];
    if (!l.on) continue;
    const k = clamp((g.t - l.t0) / FX.linkMs, 0, 1);
    ctx.strokeStyle = col(L.P48 * (1 - k));
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(l.x0, l.y0);
    ctx.lineTo(l.x1, l.y1);
    ctx.stroke();
  }
}

/* 十字光标（F-MSL-15）：32px = 外圈 r16 + 中心十字，100% —— 本作唯一主动焦点。
 * **屏幕固定层**：恒钉 CENTER.x（锚定型的核心承诺），y 由 pitch 直控。
 * 单击被拒（空仓 / 同屏爆炸满）时 120ms 闪烁（F-MSL-32/34）。 */
function drawCursor(g, ctx, col) {
  const flick = g.denyT >= 0 && (Math.floor(g.t / 60) % 2 === 0);
  const a = flick ? L.P24 : L.P100;
  const cx = CENTER.x, cy = g.cursorY;
  strokeCircle(ctx, cx, cy, CUR.r, col(a), 1);
  ctx.strokeStyle = col(a);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx - 10, cy); ctx.lineTo(cx - 3, cy);
  ctx.moveTo(cx + 3, cy); ctx.lineTo(cx + 10, cy);
  ctx.moveTo(cx, cy - 10); ctx.lineTo(cx, cy - 3);
  ctx.moveTo(cx, cy + 3); ctx.lineTo(cx, cy + 10);
  ctx.stroke();
  fillCircle(ctx, cx, cy, 1.5, col(a));
}

/* 离屏弹头指示器（相机化的补偿）：弹头滑出裁剪窗时必须在对应屏幕边给出
 * 方向提示，否则玩家会"看不见就挨打"。只标方向不标距离。
 * 用户 2026-09-05 裁定：只做弹头指示器，不加城市告警（与既有三款一致）。 */
function drawOffscreenMarks(g, ctx, col, dx) {
  for (let i = 0; i < g.warheads.length; i++) {
    const w = g.warheads[i];
    if (!w.on) continue;
    const sx = w.x + dx;
    if (sx >= CLIP_L && sx <= CLIP_R) continue;
    const left = sx < CLIP_L;
    const x = left ? CLIP_L + CAM.markGap : CLIP_R - CAM.markGap;
    const dir = left ? -1 : 1;
    const y0 = clamp(w.y, VY + CAM.markH, VYB - CAM.markH);
    ctx.fillStyle = col(L.P48);
    ctx.beginPath();
    ctx.moveTo(x, y0);
    ctx.lineTo(x - dir * CAM.markW, y0 - CAM.markH / 2);
    ctx.lineTo(x - dir * CAM.markW, y0 + CAM.markH / 2);
    ctx.closePath();
    ctx.fill();
  }
}

/* 波次过场卡（F-MSL-51）：主行「第 N 波」14/500/72% + 副行 12/400/48% */
function drawGapCard(g, ctx, col) {
  text(ctx, '第 ' + (g.waveIdx + 1) + ' 波', CENTER.x, 170,
    { size: 14, weight: 500, color: col(L.P72) });
  text(ctx, MSL.WAVE_SUB[g.waveIdx] || '', CENTER.x, 192,
    { size: 12, weight: 400, color: col(L.P48) });
}

/* 失败 / 通关提示（F-MSL-64）：0.6s 中央提示 */
function drawOverCard(g, ctx, col) {
  const s = g.cleared ? '防线守住了' : '防线失守';
  text(ctx, s, CENTER.x, 176, { size: 16, weight: 500, color: col(L.P72) });
}

/* HUD 中段条（F-MSL-18 / §4.3）：墨中心 y=24，三段落在空档 x ∈ [92, 352]。
 * 雷余量 ≤3 提亮 100%；=0 时 120ms 方波闪烁（100% ↔ 24%，全场同相位）。 */
function drawHudMid(g, ctx, col) {
  text(ctx, String(g.score), HUDX.scoreX, HUDX.midY,
    { size: 13, weight: 500, mono: true, color: col(L.P100), align: 'left' });

  text(ctx, 'W' + (g.waveIdx + 1) + '/' + WAVE_N, HUDX.waveX, HUDX.midY,
    { size: 12, weight: 500, mono: true, color: col(L.P72), align: 'left' });

  const empty = g.ammo <= 0;
  const low = g.ammo <= HUDX.ammoWarn;
  let aAmmo = L.P72;
  if (empty) aAmmo = (Math.floor(g.t / HUDX.flashMs) % 2 === 0) ? L.P100 : L.P24;
  else if (low) aAmmo = L.P100;
  text(ctx, '雷', HUDX.ammoLabelX, HUDX.midY,
    { size: 11, weight: 500, color: col(empty ? aAmmo : L.P48), align: 'left' });
  text(ctx, String(g.ammo), HUDX.ammoX, HUDX.midY,
    { size: 13, weight: 500, mono: true, color: col(aAmmo), align: 'left' });
}

/* ── 图元小工具（不依赖未确认的 ctx API） ───────────────────────── */

function fillRectPath(ctx, x, y, w, h, color) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

function strokeRectPath(ctx, x, y, w, h, color, lw) {
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
}

/* 虚线矩形 / 虚线描边：setLineDash 在打砖块已验证可用；不可用时降级实线 */
function dashRectPath(ctx, x, y, w, h, color, lw, dash) {
  if (typeof ctx.setLineDash === 'function') ctx.setLineDash(dash);
  strokeRectPath(ctx, x, y, w, h, color, lw);
  if (typeof ctx.setLineDash === 'function') ctx.setLineDash([]);
}

function dashStroke(ctx, color, lw, dash) {
  if (typeof ctx.setLineDash === 'function') ctx.setLineDash(dash);
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.stroke();
  if (typeof ctx.setLineDash === 'function') ctx.setLineDash([]);
}

/* 点到线段距离的平方（用于弹道接近加亮；开方前比较，省一次 sqrt） */
function segDist(px, py, x1, y1, x2, y2) {
  const vx = x2 - x1, vy = y2 - y1;
  const wx = px - x1, wy = py - y1;
  const len2 = vx * vx + vy * vy;
  let tt = len2 > 0 ? (wx * vx + wy * vy) / len2 : 0;
  tt = tt < 0 ? 0 : (tt > 1 ? 1 : tt);
  const qx = px - (x1 + vx * tt), qy = py - (y1 + vy * tt);
  return Math.sqrt(qx * qx + qy * qy);
}
