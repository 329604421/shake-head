/* plane.js —— 《打飞机》玩法模块（PRD-06 · 相机版 v1.30）
 *
 * 接口契约（PRD-03/06 同源，见 PRD-06 附录）：
 *   create()              → g 状态对象
 *   update(g, dtMs, snap) → events[]（本册不播音，由页面播）
 *   render(g, ctx, fade)  → 画战场/编队/机体/HUD 中段
 *   result(g)             → { score, cleared, reachedLevel, extra[] }
 *
 * 【三条硬红线 · 违反即冻结语义失效】
 *   1. **禁止 Date.now() 与任何定时器**：全部计时基于 update(dtMs) 累加的
 *      g.t。框架页在 B2/B3/B4 期间不调 update，g.t 自动停走 —— 冻结与续算
 *      无需任何显式 freeze / resume（F-PLN-60/61）。
 *   2. **禁止 import sfx / storage**：update 返回事件数组，播音与落盘全归
 *      页面。本模块因此可在 node 下直接跑断言。
 *   3. **禁止自绘遮罩或自行降 alpha**：变暗一律由页面把 fade 传进来，走
 *      ring.js 的 fadeTo。render 的第三参 fade 即为此设。
 *
 * 【映射形态】**锚定型 yaw 相机 + pitch 直控**（2026-09-05 用户指定改造，
 * 推翻 PRD-06 r6 的速度型双轴；与 PRD-02 打砖块 v1.28 / PRD-03 接鸡蛋
 * v1.29 **同一个模型**，几何定义见 layout.js 的 PLANE 块）：
 *
 *   横向（yaw）：机体**恒钉屏幕中心 x=240**，头动驱动【世界反向平移】。
 *     机体的**世界坐标 == 相机中心 camCx**，绘制偏移 dx = 240 − camCx。
 *   纵向（pitch）：机体 y **保持直控**，行程收窄至 ±40（原 260px 太大，
 *     随头上下跑同样是眩晕源）。
 *
 *   用户原话：「头部移动以后眼镜里的碗也在移动，这就让用户很头晕 / 挡板
 *   一直处于屏幕中心，随着头部的左右转动，游戏画面进行反向滑动 / 游戏画面
 *   左右要增加个边界，超出边界的区域显示空白」。三条分别对应：锚定、反向
 *   滑动、裁剪窗留白 —— 与打砖块 v1.28、接鸡蛋 v1.29 完全同构。
 *
 * 【⚠ 相机化带来的两处重算】
 *   ① **列距 56 → 40**：r6 的列距是给 424px 横移轨道定的，相机化后战场
 *      只有 352px，列距 56 会让单程行程只剩 32px、30s 必失守。联立重解
 *      见 layout.js 的 PLANE.FORM 注释。
 *   ② **轰炸机 50 → 32px/s**：50px/s 下只有 4.5s 压到防线，而打掉它最少
 *      要 2s（5 血 × 0.4s）加对齐时间。改 32px/s → 6.9s。
 */

import { L, g as gcol } from './theme.js';
import { CENTER, VIEWPORT, PLANE } from './layout.js';
import { SEM_FOLLOW } from './input.js';
import { clamp, text, fillCircle, strokeCircle, fadeBand } from './draw.js';
import { fadeTo } from './ring.js';

const COURT = PLANE.COURT;
const PY = PLANE.PLANE_Y;
const FORM = PLANE.FORM;
const TYPE = PLANE.TYPE;
const SHOT = PLANE.SHOT;
const EB = PLANE.EBULLET;
const BOMB = PLANE.BOMB;
const BOMBER = PLANE.BOMBER;
const DIVE = PLANE.DIVE;
const PHASE = PLANE.PHASE;
const LIFE = PLANE.LIFE;
const HUDX = PLANE.HUDX;
const FX = PLANE.FX;
const CAM = PLANE.CAMERA;

const COURT_R = COURT.x + COURT.w;      // 416
const COURT_B = COURT.y + COURT.h;      // 336
const CX = COURT.x + COURT.w / 2;       // 240
const VY = VIEWPORT.y;                  // 44
const VYB = VIEWPORT.y + VIEWPORT.h;    // 340

/* 裁剪窗 = 战场 ± 墙厚：世界层只在这道窗里可见，越界部分直接消失 → 留白。
 * 这正是用户要的「左右两侧超出边界的区域显示空白」。 */
const CLIP_L = COURT.x - CAM.wallBand;  // 56（v1.34：墙带由 3 加宽到 8）
const CLIP_R = COURT_R + CAM.wallBand;  // 424
const CLIP_W = CLIP_R - CLIP_L;         // 368

/* 行程半幅：战场中心 → 机体世界坐标能到达的最远处，由几何算出（**勿硬编码**）。
 * TRAVEL = 352/2 − 24/2 = 176 − 12 = 164 → camCx ∈ [76, 404]。 */
export const TRAVEL = COURT.w / 2 - PLANE.BODY / 2;

/* 编队包围盒与横移轨道（同样由几何算出，改列距/战场宽会自动跟着变） */
export const FORM_W = (FORM.cols - 1) * FORM.pitchX + PLANE.E_BODY_W;  // 5×40+24 = 224
const FORM_HALF = FORM_W / 2;                                          // 112
const TRACK_L = COURT.x + FORM.margin + FORM_HALF;   // 64+8+112 = 184
const TRACK_R = COURT_R - FORM.margin - FORM_HALF;   // 416−8−112 = 296
export const FORM_TRAVEL = TRACK_R - TRACK_L;        // 112

const ROW_TOP = (FORM.cols - 1) / 2;                 // 2.5
const E_HH = PLANE.E_BODY_H / 2;                     // 10

/* 机型轮廓（相对中心；F-PLN-20 形状双通道：侦察=小三角 / 攻击=蟹形双翼 /
 * 轰炸=宽体）。纯多边形，不依赖任何图元扩展。 */
const SHAPE = {
  SCOUT: [[-11, -10], [11, -10], [0, 10]],
  ATTACK: [[-12, -10], [-4, -10], [-4, -3], [4, -3], [4, -10], [12, -10],
    [12, 0], [6, 10], [-6, 10], [-12, 0]],
  BOMBER: [[-20, -9], [20, -9], [20, 0], [10, 9], [-10, 9], [-20, 0]],
  /* 己方机体：机头朝上的战斗机剪影（24 宽 × 22 高） */
  PLANE: [[0, -12], [3, -4], [12, 4], [12, 8], [3, 6], [3, 10],
    [-3, 10], [-3, 6], [-12, 8], [-12, 4], [-3, -4]],
};

/* 机体内部构造线（v1.39）：[[x0,y0],[x1,y1],亮度]，相对机体中心。
 * 存在的理由：单绿剪影只靠外轮廓，22~24px 的机体在 480×352 上是一团模糊
 * 的多边形 —— 分不清侦察机/攻击机/轰炸机，也分不清机头朝哪。补 3~4 条
 * 内部线后，一架飞机读起来是「有座舱、有翼根、有尾喷口」的飞行器。
 * ⚠ 全部是 **2 顶点线段**：harness A15a 用「11 顶点的 poly」定位己方机体，
 *   内部细节不得凑巧也是 11 顶点（会顶掉 find 的结果）。 */
const DETAIL = {
  /* 侦察机：中轴 + 座舱横杠（48%），两道翼根缝（24%） */
  SCOUT: [
    [[0, -5], [0, 6], L.P48], [[-3, 0], [3, 0], L.P48],
    [[-8, -6], [-3, -6], L.P24], [[8, -6], [3, -6], L.P24],
  ],
  /* 攻击机：机身中轴 + 机头尖（48%），两道外翼缝（24%） */
  ATTACK: [
    [[0, -8], [0, 4], L.P48], [[0, 5], [0, 9], L.P48],
    [[-9, -7], [-5, -7], L.P24], [[9, -7], [5, -7], L.P24],
  ],
  /* 轰炸机：机身中轴 + 座舱横杠（48%），两道长翼缝（24%） */
  BOMBER: [
    [[0, -6], [0, 6], L.P48], [[-4, -5], [4, -5], L.P48],
    [[-16, -4], [-9, -4], L.P24], [[16, -4], [9, -4], L.P24],
  ],
  /* 己方：座舱中轴（48%）、两道机翼前缘（24%）、尾喷口横杠（48%） */
  PLANE: [
    [[0, -6], [0, 1], L.P48],
    [[-9, 4], [-3, 4], L.P24], [[9, 4], [3, 4], L.P24],
    [[-2, 9], [2, 9], L.P48],
  ],
};

/* 内部构造线：统一 1px，亮度按 alpha 整体缩放（入场淡入 / 无敌期同进同退）。 */
function craftDetail(ctx, key, cx, cy, col, a) {
  const seg = DETAIL[key];
  if (!seg || a <= 0.01) return;
  ctx.lineWidth = 1;
  for (let i = 0; i < seg.length; i += 1) {
    const s = seg[i];
    ctx.strokeStyle = col(s[2] * a);
    ctx.beginPath();
    ctx.moveTo(cx + s[0][0], cy + s[0][1]);
    ctx.lineTo(cx + s[1][0], cy + s[1][1]);
    ctx.stroke();
  }
}

/* ── 状态构造 ───────────────────────────────────────────────────── */

export function create() {
  const g = {
    t: 0,                  // 游戏内时钟（ms），唯一时间源
    phase: 'intro',        // intro | p2 | p3 | over
    phaseT: 0,

    camCx: CX,             // 相机中心 == 机体世界坐标（锚定型）
    planeY: PY.home,       // 机体屏幕 y（pitch 直控）

    form: { cx: CX, dir: 1, drop: 0 },
    kills: 0,
    score: 0,
    lives: LIFE.max,
    bombs: BOMB.count,
    bombsUsed: 0,
    invT: -1,              // 无敌剩余 ms，-1 = 无

    enemies: [],           // 定长 18
    bomber: { on: false, x: CX, y: VY, hp: 0 },
    shots: [],             // 己方子弹池
    ebullets: [],          // 敌弹池
    bomb: { on: false, x: 0, y: 0 },
    wave: { on: false, x: 0, y: 0, t0: 0 },

    shotT: 0, eShotT: 0, diveT: 0,
    shakeT: -1,
    rings: [],
    shards: [],
    idleMs: 0,

    imuDown: false,
    over: false,
    cleared: false,
  };

  for (let r = 0; r < FORM.rows; r++) {
    for (let c = 0; c < FORM.cols; c++) {
      g.enemies.push({
        on: true, col: c, row: r,
        type: (r === 0) ? 'ATTACK' : 'SCOUT',
        hp: (r === 0) ? TYPE.ATTACK.hp : TYPE.SCOUT.hp,
        diving: false, returning: false, x: 0, y: 0,
      });
    }
  }
  for (let i = 0; i < SHOT.max; i++) g.shots.push({ on: false, x: 0, y: 0 });
  for (let i = 0; i < EB.max; i++) g.ebullets.push({ on: false, x: 0, y: 0 });
  for (let i = 0; i < 8; i++) g.rings.push({ on: false, x: 0, y: 0, t0: 0 });
  for (let i = 0; i < 10; i++) g.shards.push({ on: false, x: 0, y: 0, t0: 0 });
  return g;
}

/* 世界 → 屏幕的横向绘制偏移。机体恒钉 CENTER.x，故相机中心 == 机体世界坐标。
 * dx > 0 表示世界整体右移（头左转）。范围 ±TRAVEL(164)。 */
export function camDx(g) { return CENTER.x - g.camCx; }

/* 编队步进速度（F-PLN-41）：按存活击落数实时计算，封顶 speedMax。
 * 轨道固定不重算 —— 否则击落后编队变窄、行程反向变大，会抵消"越打越快"。 */
export function formSpeed(g) {
  const v = FORM.speed0 * Math.pow(1 + FORM.gainPerKill, g.kills);
  return Math.min(FORM.speedMax, v);
}

/* 敌弹节奏（F-PLN-42）：每击落 3 架间隔 −0.15s，下限 0.8s */
export function eGapMs(g) {
  const cut = Math.floor(g.kills / EB.killsPerStep) * EB.gapStep;
  return Math.max(EB.gapMin, EB.gapMs - cut);
}

/* 敌弹速度（F-PLN-42）：每击落 5 架 +10px/s，封顶 160 */
export function eSpeed(g) {
  const add = Math.floor(g.kills / EB.killsPerSpeed) * EB.speedStep;
  return Math.min(EB.speedMax, EB.speed0 + add);
}

/* 存活敌机数（含俯冲中：俯冲机仍可被击落，仍计入"剩余 N"） */
export function aliveCount(g) {
  let n = 0;
  for (let i = 0; i < g.enemies.length; i++) if (g.enemies[i].on) n++;
  return n;
}

/* 编队（**不含俯冲中**）最底缘的世界 y；无编队机时返回 -Infinity */
export function formationBottom(g) {
  let b = -Infinity;
  for (let i = 0; i < g.enemies.length; i++) {
    const e = g.enemies[i];
    if (!e.on || e.diving) continue;
    const y = FORM.rowY[e.row] + g.form.drop + E_HH;
    if (y > b) b = y;
  }
  return b;
}

function slotX(g, e) { return g.form.cx + (e.col - ROW_TOP) * FORM.pitchX; }
function slotY(g, e) { return FORM.rowY[e.row] + g.form.drop; }

/* ── 更新 ───────────────────────────────────────────────────────── */

export function update(g, dtMs, snap) {
  const ev = [];
  if (g.over) return ev;

  /* dt 一律钳到 0~100ms（切后台/卡顿一帧巨跳会让子弹穿透判定） */
  const dt = dtMs > 100 ? 100 : (dtMs < 0 ? 0 : dtMs);
  g.t += dt;

  /* IMU 不可用（§10）：不推进任何玩法，机体锁中立位。
   * 禁止在无输入状态下继续推进段落（NFR-05）。 */
  if (!snap || snap.ok === false) {
    g.imuDown = true;
    g.camCx = CX;
    g.planeY = PY.home;
    return ev;
  }
  g.imuDown = false;

  /* 两轴独立、无耦合项（F-PLN-23 相机版）：
   * 横向锚定型：camCx = 240 + SEM_FOLLOW × snap.x
   *   snap.x > 0（头左转）→ camCx 减小 → dx 增大 → 世界右滑。
   * 纵向直控：抬头 = 机体 y 减小 = 上升（PRD F-PLN-03 公式）。
   *   ⚠ snap.y 的符号**尚未真机标定**（与 PRD-03/04/05 同一待办）。若真机
   *     上下反向，改 layout.js 的 PLANE_Y 或在此处取反，**不要动
   *     input.js 的 SIGN**（会连主页菜单一起反转）。 */
  g.camCx = clamp(CENTER.x + SEM_FOLLOW * (snap.x || 0),
    COURT.x + PLANE.HALF, COURT_R - PLANE.HALF);              // [76, 404]
  /* v1.38：上 / 下行程不等（80 / 40），故**分别标定**，见 layout.PLANE_Y。
   * 抬头（snap.y > 0）→ 上升最多 80；低头 → 下降最多 40。 */
  const raw = snap.y || 0;
  const dy = raw >= 0
    ? Math.min(raw * PY.upScale, PY.up)
    : -Math.min(-raw * PY.downScale, PY.down);
  g.planeY = clamp(PY.home - dy, PY.min, PY.max);             // [202, 322]

  /* 短动效计时（所有阶段都要走，否则冻结期恢复会残留） */
  if (g.shakeT >= 0) { g.shakeT -= dt; if (g.shakeT < 0) g.shakeT = -1; }
  if (g.invT >= 0) { g.invT -= dt; if (g.invT < 0) g.invT = -1; }
  expireFx(g);

  /* 无输入挂机（§10）：5 分钟零输入 → 停止并进结算 */
  if (snap.x !== 0 || snap.y !== 0) g.idleMs = 0;
  else g.idleMs += dt;
  if (g.idleMs >= PLANE.IDLE_MS) { lose(g, ev); return ev; }

  /* P1 入场（MVP：淡入就位，§6.5 ②） */
  if (g.phase === 'intro') {
    if (g.t - g.phaseT >= PHASE.introMs) { g.phase = 'p2'; g.phaseT = g.t; }
    return ev;
  }

  /* 编队横移步进（F-PLN-41）：intro 结束后每帧推进 */
  stepFormation(g, dt);

  /* 失守判定（F-PLN-52）：编队（不含俯冲中）下缘触及防线 */
  if (formationBottom(g) >= PLANE.DEFENSE_Y) { lose(g, ev); return ev; }

  /* P2 → P3：编队剩 ≤6 架时压轴轰炸机入场（F-PLN-43） */
  if (g.phase === 'p2' && aliveCount(g) <= PHASE.p3At) {
    g.phase = 'p3';
    g.phaseT = g.t;
    g.bomber.on = true;
    g.bomber.x = CX;
    g.bomber.y = VY;
    g.bomber.hp = TYPE.BOMBER.hp;
    ev.push('wave');
  }

  /* 自动射击（F-PLN-24/31）：玩家零操作 */
  g.shotT += dt;
  if (g.shotT >= SHOT.intervalMs) { g.shotT -= SHOT.intervalMs; fireOwn(g); }

  /* 敌弹（F-PLN-42）：最底列随机一架 */
  g.eShotT += dt;
  if (g.eShotT >= eGapMs(g)) { g.eShotT = 0; fireEnemy(g); }

  /* P3：俯冲 + 轰炸机下压 */
  if (g.phase === 'p3') {
    stepDive(g, dt);
    stepBomber(g, dt, ev);
    if (g.over) return ev;
  }

  stepShots(g, dt, ev);
  if (g.over) return ev;
  stepEBullets(g, dt, ev);
  if (g.over) return ev;
  stepBomb(g, dt, ev);
  stepWave(g, dt, ev);
  collidePlane(g, ev);
  if (g.over) return ev;

  /* 通关（F-PLN-46）：编队 18 架 + 轰炸机全灭 */
  if (aliveCount(g) === 0 && !g.bomber.on) win(g, ev);
  return ev;
}

/* 编队步进：触侧边 → 整体下移 stepDown 并反向（F-PLN-41） */
function stepFormation(g, dt) {
  if (aliveCount(g) === 0) return;
  g.form.cx += g.form.dir * formSpeed(g) * dt / 1000;
  if (g.form.cx >= TRACK_R) {
    g.form.cx = TRACK_R; g.form.dir = -1; g.form.drop += FORM.stepDown;
  } else if (g.form.cx <= TRACK_L) {
    g.form.cx = TRACK_L; g.form.dir = 1; g.form.drop += FORM.stepDown;
  }
}

/* 己方开火：从机头（屏幕上端）发出，世界坐标 = 机体世界坐标 */
function fireOwn(g) {
  for (let i = 0; i < g.shots.length; i++) {
    const s = g.shots[i];
    if (s.on) continue;
    s.on = true;
    s.x = g.camCx;
    s.y = g.planeY - PLANE.HALF;
    return;
  }
}

/* 敌弹：每列取最底一架，再随机挑一列（F-PLN-42 经典规则） */
function fireEnemy(g) {
  const cand = [];
  for (let c = 0; c < FORM.cols; c++) {
    let best = null;
    for (let i = 0; i < g.enemies.length; i++) {
      const e = g.enemies[i];
      if (!e.on || e.diving || e.col !== c) continue;
      if (!best || e.row > best.row) best = e;
    }
    if (best) cand.push(best);
  }
  if (!cand.length) return;
  const e = cand[Math.floor(Math.random() * cand.length)];
  const ex = e.diving ? e.x : slotX(g, e);
  const ey = e.diving ? e.y : slotY(g, e);
  for (let i = 0; i < g.ebullets.length; i++) {
    const b = g.ebullets[i];
    if (b.on) continue;
    b.on = true;
    b.x = ex;
    b.y = ey + E_HH;
    return;
  }
}

/* 俯冲（F-PLN-43 · MVP 直线下压，出屏底后从屏顶回归空位，§6.5 ②） */
function stepDive(g, dt) {
  let diving = 0;
  for (let i = 0; i < g.enemies.length; i++) if (g.enemies[i].on && g.enemies[i].diving) diving++;

  g.diveT += dt;
  const interval = DIVE.baseMs / (1 + aliveCount(g) * 0.1);
  if (diving < DIVE.maxOnScreen && g.diveT >= interval) {
    g.diveT = 0;
    const pool = [];
    for (let i = 0; i < g.enemies.length; i++) {
      if (g.enemies[i].on && !g.enemies[i].diving) pool.push(g.enemies[i]);
    }
    if (pool.length) {
      const e = pool[Math.floor(Math.random() * pool.length)];
      e.diving = true;
      e.returning = false;
      e.x = slotX(g, e);
      e.y = slotY(g, e);
    }
  }

  const step = DIVE.speed * dt / 1000;
  for (let i = 0; i < g.enemies.length; i++) {
    const e = g.enemies[i];
    if (!e.on || !e.diving) continue;
    if (e.returning) {
      /* 回归：横向跟随编队空位，纵向自上而下落回排位 */
      const ty = slotY(g, e);
      e.x = slotX(g, e);
      e.y += step;
      if (e.y >= ty) { e.y = ty; e.diving = false; e.returning = false; }
    } else {
      e.y += step;
      if (e.y - E_HH > VYB) { e.returning = true; e.y = DIVE.returnY - E_HH; }
    }
  }
}

/* 轰炸机（F-PLN-22）：缓慢直线下压，抵达防线即失守 */
function stepBomber(g, dt, ev) {
  const b = g.bomber;
  if (!b.on) return;
  b.y += BOMBER.speed * dt / 1000;
  if (b.y + BOMBER.bodyH / 2 >= PLANE.DEFENSE_Y) lose(g, ev);
}

/* 己方子弹：上行 → 出画面顶回收；命中敌机 / 轰炸机 */
function stepShots(g, dt, ev) {
  const step = SHOT.speed * dt / 1000;
  for (let i = 0; i < g.shots.length; i++) {
    const s = g.shots[i];
    if (!s.on) continue;
    s.y -= step;
    if (s.y < VY - SHOT.r) { s.on = false; continue; }

    /* 命中轰炸机优先（它是失守压力源，判定盒 40×18） */
    if (g.bomber.on
      && hitBox(s.x, s.y, SHOT.r * 2, SHOT.r * 2,
        g.bomber.x, g.bomber.y, BOMBER.bodyW, BOMBER.bodyH)) {
      s.on = false;
      hitBomber(g, SHOT.dmg, ev);
      continue;
    }
    for (let k = 0; k < g.enemies.length; k++) {
      const e = g.enemies[k];
      if (!e.on) continue;
      const ex = e.diving ? e.x : slotX(g, e);
      const ey = e.diving ? e.y : slotY(g, e);
      if (!hitBox(s.x, s.y, SHOT.r * 2, SHOT.r * 2,
        ex, ey, PLANE.E_HIT_W, PLANE.E_HIT_H)) continue;
      s.on = false;
      hitEnemy(g, e, ex, ey, SHOT.dmg, ev);
      break;
    }
  }
}

/* 敌弹（F-PLN-42）：垂直下落 → 出画面底回收；命中机体 */
function stepEBullets(g, dt, ev) {
  const step = eSpeed(g) * dt / 1000;
  for (let i = 0; i < g.ebullets.length; i++) {
    const b = g.ebullets[i];
    if (!b.on) continue;
    b.y += step;
    if (b.y - EB.r > VYB) { b.on = false; continue; }
    if (g.invT >= 0) continue;
    if (hitBox(b.x, b.y, EB.r * 2, EB.r * 2,
      g.camCx, g.planeY, PLANE.HIT, PLANE.HIT)) {
      b.on = false;
      hurt(g, 1, ev);
      if (g.over) return;
    }
  }
}

/* 投弹（F-PLN-25）：机头前方向上飞，触敌即引爆，或到引爆线 y=144 自动引爆 */
function stepBomb(g, dt, ev) {
  const b = g.bomb;
  if (!b.on) return;
  b.y -= BOMB.speed * dt / 1000;

  if (b.y <= BOMB.detonateY) { b.y = BOMB.detonateY; detonate(g, ev); return; }

  /* 触敌即爆：命中轰炸机或任意敌机 */
  if (g.bomber.on
    && hitBox(b.x, b.y, BOMB.r * 2, BOMB.r * 2,
      g.bomber.x, g.bomber.y, BOMBER.bodyW, BOMBER.bodyH)) {
    detonate(g, ev); return;
  }
  for (let i = 0; i < g.enemies.length; i++) {
    const e = g.enemies[i];
    if (!e.on) continue;
    const ex = e.diving ? e.x : slotX(g, e);
    const ey = e.diving ? e.y : slotY(g, e);
    if (hitBox(b.x, b.y, BOMB.r * 2, BOMB.r * 2, ex, ey, PLANE.E_HIT_W, PLANE.E_HIT_H)) {
      detonate(g, ev); return;
    }
  }
}

/* 扩散波（F-PLN-33）：12 → 90 → 0，扫过即毁。
 * 已毁实体 on=false，天然不会被重复结算，无需额外命中集合。 */
function stepWave(g, dt, ev) {
  const w = g.wave;
  if (!w.on) return;
  const k = clamp((g.t - w.t0) / BOMB.waveMs, 0, 1);
  const r = waveRadius(k);
  if (k >= 1) { w.on = false; return; }

  /* 每帧按当前半径扫一次（半径单调增 → 等价于"扫过即毁"） */
  if (g.bomber.on && dist2(w.x, w.y, g.bomber.x, g.bomber.y) <= r * r) {
    killBomber(g, ev);
  }
  for (let i = 0; i < g.enemies.length; i++) {
    const e = g.enemies[i];
    if (!e.on) continue;
    const ex = e.diving ? e.x : slotX(g, e);
    const ey = e.diving ? e.y : slotY(g, e);
    if (dist2(w.x, w.y, ex, ey) <= r * r) killEnemy(g, e, ex, ey, ev);
  }
  for (let i = 0; i < g.ebullets.length; i++) {
    const b = g.ebullets[i];
    if (b.on && dist2(w.x, w.y, b.x, b.y) <= r * r) b.on = false;
  }
}

/* 波前半径：0→0.5 段 12→90 扩张，0.5→1 段 90→0 收束 */
export function waveRadius(k) {
  if (k < 0.5) return BOMB.waveR0 + (BOMB.waveR1 - BOMB.waveR0) * (k / 0.5);
  return BOMB.waveR1 * (1 - (k - 0.5) / 0.5);
}

function detonate(g, ev) {
  g.bomb.on = false;
  g.wave.on = true;
  g.wave.x = g.bomb.x;
  g.wave.y = g.bomb.y;
  g.wave.t0 = g.t;
  g.shakeT = 200;
  ev.push('blast');
}

/* 机体与敌机 / 轰炸机的碰撞（F-PLN-51） */
function collidePlane(g, ev) {
  if (g.invT >= 0) return;
  for (let i = 0; i < g.enemies.length; i++) {
    const e = g.enemies[i];
    if (!e.on) continue;
    const ex = e.diving ? e.x : slotX(g, e);
    const ey = e.diving ? e.y : slotY(g, e);
    if (!hitBox(g.camCx, g.planeY, PLANE.HIT, PLANE.HIT,
      ex, ey, PLANE.E_HIT_W, PLANE.E_HIT_H)) continue;
    killEnemy(g, e, ex, ey, ev);
    hurt(g, 1, ev);
    return;
  }
  if (g.bomber.on
    && hitBox(g.camCx, g.planeY, PLANE.HIT, PLANE.HIT,
      g.bomber.x, g.bomber.y, BOMBER.bodyW, BOMBER.bodyH)) {
    hurt(g, BOMBER.crashLives, ev);
  }
}

/* 恢复保护（F-PLN-65）：从 B2/B4 回到 PLAY 时给 1 秒无敌，防止恢复瞬间
 * 被弹幕击中造成无谓损失。取 max 而非覆盖 —— 不缩短本就存在的受击无敌。 */
export function grantGrace(g, ms) {
  if (g.over) return;
  g.invT = Math.max(g.invT, ms || 0);
}

/* 供页面调用：投弹（F-PLN-25）。同屏 ≤1 枚，余量 0 时无效。 */
export function bomb(g) {
  if (g.over || g.phase === 'intro') return false;
  if (g.bombs <= 0 || g.bomb.on) return false;
  g.bombs -= 1;
  g.bombsUsed += 1;
  g.bomb.on = true;
  g.bomb.x = g.camCx;
  g.bomb.y = g.planeY - PLANE.HALF;
  return true;
}

/* ── 结算与伤害 ─────────────────────────────────────────────────── */

function hitEnemy(g, e, ex, ey, dmg, ev) {
  e.hp -= dmg;
  if (e.hp > 0) { pushRing(g, ex, ey); return; }
  killEnemy(g, e, ex, ey, ev);
}

function killEnemy(g, e, ex, ey, ev) {
  e.on = false;
  e.diving = false;
  e.returning = false;
  g.kills += 1;
  g.score += TYPE[e.type].score;
  pushShard(g, ex, ey);
  ev.push('kill');
}

function hitBomber(g, dmg, ev) {
  g.bomber.hp -= dmg;
  if (g.bomber.hp > 0) { pushRing(g, g.bomber.x, g.bomber.y); return; }
  killBomber(g, ev);
}

function killBomber(g, ev) {
  g.bomber.on = false;
  g.kills += 1;
  g.score += TYPE.BOMBER.score;
  pushShard(g, g.bomber.x, g.bomber.y);
  ev.push('bomberkill');
}

function hurt(g, n, ev) {
  g.lives -= n;
  g.invT = LIFE.invincibleMs;
  g.shakeT = 200;
  ev.push('hurt');
  if (g.lives <= 0) { g.lives = 0; lose(g, ev); }
}

function lose(g, ev) {
  g.over = true;
  g.cleared = false;
  ev.push('finished');
}

function win(g, ev) {
  g.over = true;
  g.cleared = true;
  ev.push('clear');
  ev.push('finished');
}

/* ── 短动效池 ───────────────────────────────────────────────────── */

function pushRing(g, wx, wy) {
  for (let i = 0; i < g.rings.length; i++) {
    if (!g.rings[i].on) {
      g.rings[i].on = true;
      g.rings[i].x = wx + camDx(g);   // 记**屏幕坐标**（机体恒钉 240）
      g.rings[i].y = wy;
      g.rings[i].t0 = g.t;
      return;
    }
  }
}

function pushShard(g, wx, wy) {
  for (let i = 0; i < g.shards.length; i++) {
    if (!g.shards[i].on) {
      g.shards[i].on = true;
      g.shards[i].x = wx;             // 世界坐标（世界层绘制）
      g.shards[i].y = wy;
      g.shards[i].t0 = g.t;
      return;
    }
  }
}

function expireFx(g) {
  for (let i = 0; i < g.rings.length; i++) {
    if (g.rings[i].on && g.t - g.rings[i].t0 >= FX.ringMs) g.rings[i].on = false;
  }
  for (let i = 0; i < g.shards.length; i++) {
    if (g.shards[i].on && g.t - g.shards[i].t0 >= FX.shardMs) g.shards[i].on = false;
  }
}

/* 震屏（≤4px、200ms、平方衰减；相位用 g.t —— 确定性便于断言）
 * ⚠ 用坐标偏移实现，不用 ctx.translate 单独做震屏（F-EGG-3B 同口径）。 */
function shakeOf(g) {
  if (g.shakeT < 0) return { x: 0, y: 0 };
  const k = g.shakeT / 200;
  const a = 4 * k * k;
  const ph = g.t / 22;
  return { x: Math.round(Math.sin(ph) * a), y: Math.round(Math.cos(ph * 1.3) * a) };
}

/* ── 绘制 ───────────────────────────────────────────────────────── */

function poly(ctx, pts, ox, oy) {
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const x = ox + pts[i][0], y = oy + pts[i][1];
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function hitBox(ax, ay, aw, ah, bx, by, bw, bh) {
  return Math.abs(ax - bx) * 2 < (aw + bw) && Math.abs(ay - by) * 2 < (ah + bh);
}

function dist2(x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  return dx * dx + dy * dy;
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
   * ⚠ 打砖块已验证 AIUI 宿主支持 save/clip/translate/restore。 */
  ctx.save();
  ctx.beginPath();
  ctx.rect(CLIP_L, VY, CLIP_W, VYB - VY);
  ctx.clip();
  ctx.translate(dx + sh.x, sh.y);

  drawField(g, ctx, col);        // 底线 + 防线（世界层横线）
  drawWalls(g, ctx, col);        // 边界墙（世界层：战场到此为止）
  drawShards(g, ctx, col);
  drawEnemies(g, ctx, col, dx);
  drawBomberObj(g, ctx, col);
  drawEBullets(g, ctx, col);
  drawShots(g, ctx, col);
  drawBombObj(g, ctx, col);
  drawWaveObj(g, ctx, col);

  ctx.restore();                 // ← 世界层结束，坐标回到屏幕系

  /* ══ 屏幕固定层 ② ══════════════════════════════════════════════ */
  drawPlane(g, ctx, col, sh);
  drawRings(g, ctx, col, sh);
  drawBomberMark(g, ctx, col, dx);
  if (g.phase === 'intro') drawIntro(g, ctx, col);
  if (g.imuDown) {
    text(ctx, PLANE.IMU_TEXT, CENTER.x, 176, { size: 14, weight: 400, color: col(L.P72) });
  }
}

/* 场地横线（世界层）：底线 336 @6%；防线 276（F-PLN-53）。
 * 防线是**失守判定线**（编队 / 轰炸机越过即失败），**不是**机体的高度上限
 * —— 机体纵向是 [202, 322]，会穿过这条线，别再被误读成"飞行上限"。
 *
 * 【v1.38 换样式】原 [7,5] 虚线 → **1px 实线 @48% + 两端 10px 竖刻度 @72%**：
 *   ① 单绿 1px 下虚线会碎成点阵、边缘发脏；
 *   ② 虚线已被「被毁城市的残影轮廓」占用，同线型语义撞车；
 *   ③ 实线 + 端点刻度读作"门槛 / 判定线"，且两端明确"战场到这儿为止"。 */
function drawField(g, ctx, col) {
  ctx.fillStyle = col(L.P06);
  ctx.fillRect(COURT.x, COURT_B, COURT.w, 1);

  const y = PLANE.DEFENSE_Y + 0.5;
  ctx.strokeStyle = col(L.P48);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(COURT.x, y);
  ctx.lineTo(COURT_R, y);
  ctx.stroke();

  /* 两端「门柱」刻度：跨线上下各 5px，100% → 72% */
  ctx.strokeStyle = col(L.P72);
  ctx.beginPath();
  ctx.moveTo(COURT.x + 0.5, PLANE.DEFENSE_Y - 5);
  ctx.lineTo(COURT.x + 0.5, PLANE.DEFENSE_Y + 5);
  ctx.moveTo(COURT_R - 0.5, PLANE.DEFENSE_Y - 5);
  ctx.lineTo(COURT_R - 0.5, PLANE.DEFENSE_Y + 5);
  ctx.stroke();
}

/* 边界墙（世界层）：立在战场边界**外侧**，贴战场那一面就是机体的活动边界。
 * v1.34：3px 单线 @72% → 8px **羽化收边带**（内侧面最亮 ≈0.40，向外 4 级淡出）。
 *   左墙：内侧面 x = 64，带子向外（左）铺到 56
 *   右墙：内侧面 x = 416，带子向外（右）铺到 424
 * 两墙随相机平移，滑出裁剪窗即被裁掉 —— 这正是"墙外显示空白"的实现。 */
function drawWalls(g, ctx, col) {
  const ext = { a: COURT.y, len: COURT_B - COURT.y };
  fadeBand(ctx, 'v', COURT.x, ext, CAM.wallBand, -1, CAM.wallSteps, col);
  fadeBand(ctx, 'v', COURT_R, ext, CAM.wallBand, 1, CAM.wallSteps, col);
}

function drawEnemies(g, ctx, col, dx) {
  /* P1 入场淡入（§6.5 ②） */
  const intro = (g.phase === 'intro') ? clamp((g.t - g.phaseT) / 320, 0, 1) : 1;
  for (let i = 0; i < g.enemies.length; i++) {
    const e = g.enemies[i];
    if (!e.on) continue;
    const pts = SHAPE[e.type];
    if (!pts) continue;
    const ex = e.diving ? e.x : slotX(g, e);
    const ey = e.diving ? e.y : slotY(g, e);
    const a = (e.type === 'ATTACK') ? L.P100 : L.P72;
    poly(ctx, pts, ex, ey);
    ctx.fillStyle = col(L.P12 * intro);
    ctx.fill();
    ctx.strokeStyle = col(a * intro);
    ctx.lineWidth = 1.5;
    ctx.stroke();
    craftDetail(ctx, e.type, ex, ey, col, a * intro);
  }
}

function drawBomberObj(g, ctx, col) {
  const b = g.bomber;
  if (!b.on) return;
  poly(ctx, SHAPE.BOMBER, b.x, b.y);
  ctx.fillStyle = col(L.P12);
  ctx.fill();
  ctx.strokeStyle = col(L.P100);
  ctx.lineWidth = 1.5;
  ctx.stroke();
  /* 双 engine 标记（形状双通道：轰炸机比攻击机更宽且有两个短舱） */
  ctx.fillStyle = col(L.P48);
  ctx.fillRect(b.x - 14, b.y - 2, 6, 4);
  ctx.fillRect(b.x + 8, b.y - 2, 6, 4);
  craftDetail(ctx, 'BOMBER', b.x, b.y, col, 1);
}

function drawEBullets(g, ctx, col) {
  ctx.fillStyle = col(L.P100);
  for (let i = 0; i < g.ebullets.length; i++) {
    const b = g.ebullets[i];
    if (!b.on) continue;
    fillCircle(ctx, b.x, b.y, EB.r, col(L.P72));
    /* 1px 短拖尾（F-PLN-13：视觉略小于判定，符合"子弹判定点"惯例） */
    ctx.fillRect(b.x - 0.5, b.y - EB.r - 4, 1, 4);
  }
}

function drawShots(g, ctx, col) {
  for (let i = 0; i < g.shots.length; i++) {
    const s = g.shots[i];
    if (!s.on) continue;
    fillCircle(ctx, s.x, s.y, SHOT.r, col(L.P100));
  }
}

function drawBombObj(g, ctx, col) {
  const b = g.bomb;
  if (!b.on) return;
  fillCircle(ctx, b.x, b.y, BOMB.r, col(L.P12));
  strokeCircle(ctx, b.x, b.y, BOMB.r, col(L.P100), 1.5);
}

/* 扩散波（F-PLN-33）：描边 100% + 内部 ≤12% 填充，随半径增大描边 alpha 递减 */
function drawWaveObj(g, ctx, col) {
  const w = g.wave;
  if (!w.on) return;
  const k = clamp((g.t - w.t0) / BOMB.waveMs, 0, 1);
  const r = waveRadius(k);
  if (r <= 0.5) return;
  fillCircle(ctx, w.x, w.y, r, col(L.P12 * (1 - k)));
  strokeCircle(ctx, w.x, w.y, r, col(L.P100 * (1 - k)), 1.5);
}

/* 击落碎屑（世界层）：十字裂纹，200ms */
function drawShards(g, ctx, col) {
  for (let i = 0; i < g.shards.length; i++) {
    const s = g.shards[i];
    if (!s.on) continue;
    const k = clamp((g.t - s.t0) / FX.shardMs, 0, 1);
    const a = 0.72 * (1 - k);
    if (a <= 0.02) continue;
    ctx.strokeStyle = col(a);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let n = -1; n <= 1; n++) {
      const len = 7 + (n === 0 ? 3 : 0);
      ctx.moveTo(s.x + n * 3, s.y - len);
      ctx.lineTo(s.x + n * 3 + n * 0.8, s.y + len);
    }
    ctx.stroke();
  }
}

/* 机体（**屏幕固定层**：恒钉 CENTER.x —— 锚定型的核心承诺）。
 * 无敌期（F-PLN-51）MVP 定档 48% 常显（§6.5 ③）；震屏以坐标偏移叠加。 */
function drawPlane(g, ctx, col, sh) {
  const cx = CENTER.x + sh.x;
  const cy = g.planeY + sh.y;
  const a = (g.invT >= 0) ? L.P48 : L.P100;
  poly(ctx, SHAPE.PLANE, cx, cy);
  ctx.fillStyle = col(L.P12);
  ctx.fill();
  ctx.strokeStyle = col(a);
  ctx.lineWidth = 1.5;
  ctx.stroke();
  /* a 恰是归一化系数（P100=1 / P48=0.48），内部构造线随机体同进同退 */
  craftDetail(ctx, 'PLANE', cx, cy, col, a);
}

/* 命中/击落扩散圆（屏幕坐标）：r 4→16、α 100%→0、160ms */
function drawRings(g, ctx, col, sh) {
  for (let i = 0; i < g.rings.length; i++) {
    const r = g.rings[i];
    if (!r.on) continue;
    const k = clamp((g.t - r.t0) / FX.ringMs, 0, 1);
    strokeCircle(ctx, r.x + sh.x, r.y + sh.y, 4 + 12 * k, col(L.P100 * (1 - k)), 1);
  }
}

/* 离屏轰炸机指示器（相机化的补偿）：轰炸机是失守压力源，滑出裁剪窗时
 * 必须在对应屏幕边给出方向提示，否则玩家会"看不见就输"。只标方向不标距离。 */
function drawBomberMark(g, ctx, col, dx) {
  const b = g.bomber;
  if (!b.on) return;
  const sx = b.x + dx;
  if (sx >= CLIP_L && sx <= CLIP_R) return;
  const left = sx < CLIP_L;
  const x = left ? CLIP_L + CAM.markGap : CLIP_R - CAM.markGap;
  const dir = left ? -1 : 1;
  const y0 = clamp(b.y, VY + CAM.markH, VYB - CAM.markH);
  ctx.fillStyle = col(L.P72);
  ctx.beginPath();
  ctx.moveTo(x, y0);
  ctx.lineTo(x - dir * CAM.markW, y0 - CAM.markH / 2);
  ctx.lineTo(x - dir * CAM.markW, y0 + CAM.markH / 2);
  ctx.closePath();
  ctx.fill();
}

/* P1 入场卡（§6.5 ② 淡入就位时的提示） */
function drawIntro(g, ctx, col) {
  text(ctx, '编队歼灭战', CENTER.x, 170, { size: 16, weight: 500, color: col(L.P72) });
  text(ctx, '自动开火 · 转头平移画面 · 单击投弹', CENTER.x, 194,
    { size: 11, weight: 400, color: col(L.P48) });
}

/* HUD 中段（F-PLN-11/14/15）：墨中心 y=24，三段全部落在空档 x ∈ [92, 352]。
 * 投弹余量 ≤1 时提亮至 100%（F-PLN-15）。 */
function drawHudMid(g, ctx, col) {
  text(ctx, '得分', HUDX.scoreLabelX, HUDX.midY,
    { size: 11, weight: 500, color: col(L.P48), align: 'left' });
  text(ctx, String(g.score), HUDX.scoreValX, HUDX.midY,
    { size: 13, weight: 500, mono: true, color: col(L.P100), align: 'left' });

  /* 生命：小机形图标 ×3 + 数字（双通道编码，F-PLN-14） */
  const ly = HUDX.midY;
  for (let i = 0; i < LIFE.max; i++) {
    const x = HUDX.lifeX0 + i * HUDX.lifeStep;
    const on = i < g.lives;
    ctx.beginPath();
    ctx.moveTo(x, ly - HUDX.lifeSize / 2);
    ctx.lineTo(x + HUDX.lifeSize, ly);
    ctx.lineTo(x, ly + HUDX.lifeSize / 2);
    ctx.lineTo(x + HUDX.lifeSize * 0.35, ly);
    ctx.closePath();
    if (on) { ctx.fillStyle = col(L.P72); ctx.fill(); }
    else { ctx.strokeStyle = col(L.P24); ctx.lineWidth = 1; ctx.stroke(); }
  }
  text(ctx, String(g.lives), HUDX.lifeNumX, HUDX.midY,
    { size: 12, weight: 500, mono: true, color: col(L.P72), align: 'left' });

  text(ctx, '投弹', HUDX.bombLabelX, HUDX.midY,
    { size: 11, weight: 500, color: col(g.bombs <= 1 ? L.P100 : L.P48), align: 'left' });
  const bx = HUDX.bombIconX;
  if (g.bombs > 0) {
    ctx.fillStyle = col(g.bombs <= 1 ? L.P100 : L.P72);
    ctx.fillRect(bx, HUDX.midY - 5, 10, 10);
  } else {
    ctx.strokeStyle = col(L.P24);
    ctx.lineWidth = 1;
    ctx.strokeRect(bx + 0.5, HUDX.midY - 4.5, 9, 9);
  }
  text(ctx, String(g.bombs), HUDX.bombNumX, HUDX.midY,
    { size: 13, weight: 500, mono: true, color: col(g.bombs <= 1 ? L.P100 : L.P72), align: 'left' });
}

/* ── 结算 ───────────────────────────────────────────────────────── */

/* GameResult 契约（§7.1）：motion 由页面的引擎填充，本模块只产出玩法字段。
 * extra 最多 2 项、label ≤4 字。 */
export function result(g) {
  return {
    score: g.score,
    cleared: !!g.cleared,
    reachedLevel: 1,
    extra: [
      { label: '击落', value: String(g.kills) },
      { label: '投弹', value: g.bombsUsed + '/' + BOMB.count },
    ],
  };
}

/* 状态胶囊文案（F-PLN-17）：剩余 N = 编队存活 + 轰炸机存活（0~19） */
export function statusText(g) {
  return '剩余 ' + (aliveCount(g) + (g.bomber.on ? 1 : 0));
}
