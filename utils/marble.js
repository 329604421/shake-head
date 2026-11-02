/* marble.js —— 《滚球迷宫》玩法模块（PRD-04 V1.0-r6 · 设计稿 722090993915783）
 *
 * 【纯模块红线】禁 import wx / sfx，禁 Date.now() —— 时间源只有 g.t 与 dtMs。
 *   音效以事件数组回传，由页面层映射（与 bricks / eggcatch / plane 同规）。
 *   本文件**不得**画框架资产（视口框 / 四角角标 / 四边刻度 / 提示条），
 *   那些归 C-FRM-05、由 pages/marble/marble.js 的 drawCourt() 绘制。
 *
 * 【映射形态】**双轴球心锁定相机 + 增量位移棘轮**（PRD-04 r6 本版重写）。
 *   与 BRICKS / EGG / PLANE 的「锚定型 yaw 直控相机」**不是同一套**，勿互抄：
 *     那三款  头动 → 直接给出**相机位置**（绝对映射，元素恒钉屏幕中心）
 *     本作    头动 → 只给球的**位移增量**（相对映射，棘轮累加，可无限推进）
 *   PLAY 阶段相机 = 球位 − 视口半幅，故球恒在 (240,192) —— 硬契约，相机滞后
 *   会让球偏离中心，故 F-LAB-12 明确要求**每帧直接赋值、不做 lerp**。
 *
 * 【为什么不是惯性模型】r4 的「倾角 → 加速度 → 速度」要求玩家持续保持静态
 *   偏转才能维持球速，而头部做不到（2026-09-04 用户真机推演）。改为增量式
 *   后：头转即动、头停即停、回摆不回退，像「划船」——全程无需维持偏转。
 *   代价是取消 ACC_MAX / DAMP / RESTITUTION / WALL_FRICTION 四个惯性参数。
 */

import { L, g as gcol } from './theme.js';
import { VIEWPORT, MARBLE } from './layout.js';
import {
  clamp, text, fillCircle, strokeCircle, roundRectPath, fadeBand,
} from './draw.js';
import { fadeTo } from './ring.js';

const M = MARBLE;

/* 视口与相机偏移（§5.1 F-LAB-12，均由 VIEWPORT 现算，不硬编码） */
const VX = VIEWPORT.x, VY = VIEWPORT.y;          // 16, 44
const CAM_HALF = { x: VIEWPORT.w / 2, y: VIEWPORT.h / 2 };  // 224, 148
const SCR_C = { x: VX + CAM_HALF.x, y: VY + CAM_HALF.y };   // 240, 192 视口中心

/* 阶段：AIM 对准 → LAUNCH 起跑缓冲 → PLAY 游戏中 →（RESPAWN 回起点 / TIMEOUT 超时）→ OVER */
export const PH = {
  AIM: 'AIM', LAUNCH: 'LAUNCH', PLAY: 'PLAY',
  RESPAWN: 'RESPAWN', TIMEOUT: 'TIMEOUT', OVER: 'OVER',
};

const T_LIMIT_MS = M.TIME_LIMIT_S * 1000;        // 75000

/* ───────────────────────── 状态构建 ───────────────────────── */

export function create() {
  const g = {
    t: 0,                       // 游戏内时钟（ms），唯一时间源
    phase: PH.AIM,
    phaseT: 0,                  // 本阶段起点（g.t 基准）

    ball: { x: M.START.x, y: M.START.y },   // 世界坐标
    cam: { x: M.AIM_CAM.x, y: M.AIM_CAM.y },

    /* AIM 就绪（F-LAB-07 带迟滞：进 <24 锁定、退 >32 解锁） */
    ready: false,

    /* 棘轮（F-LAB-06）：上一帧的 rel（度）。null = 尚未建立，首帧不产生位移 */
    lastRel: null,

    /* 计时与失误：只有 PLAY / RESPAWN / TIMEOUT 推进（F-LAB-08/56） */
    timeLeftMs: T_LIMIT_MS,
    miss: 0,

    /* 移动洞 HM（§7.3.6）：匀速垂直往返，端点不缓动 */
    moverY: M.MOVER.y,
    moverDir: 1,

    /* 回起点过场（F-LAB-55）：0.6s，计时不暂停 */
    respawnT: -1,

    imuDown: false,
    idleMs: 0,
    over: false,
    cleared: false,
  };
  return g;
}

/* ─────────────────────── 相机 / 坐标换算 ───────────────────────
 * 全部导出，供 harness 断言直接调用（与本模块的绘制路径同一套公式）。 */

/* PLAY 相机：视口中心恒等于球心（F-LAB-12） */
export function camOf(bx, by) {
  return { x: bx - CAM_HALF.x, y: by - CAM_HALF.y };
}

/* 世界 → 屏幕（§5.1）：scr = world − cam + (16,44) */
export function w2s(wx, wy, cam) {
  return { x: wx - cam.x + VX, y: wy - cam.y + VY };
}

/* 世界层在屏幕上的绘制偏移（= 裁剪窗左上角）。
 * 越出迷宫矩形的部分**不绘制** → 墙外留白（F-LAB-13，用户的原始诉求）。 */
export function worldOffset(cam) {
  return { x: VX - cam.x, y: VY - cam.y };
}

/* AIM 相机：cam = AIM_CAM + SEM × AIM_GAIN × rel（§4.1.1），并做限位。
 * rel 为度；SEM.x = −1 使「头左转（rel.x>0）→ cam 减小 → 画面右滑」。
 * ⚠ 限位（AIM_CLAMP）是本模块**唯一**的设计补全：不限位则转头 30° 会让
 *   视口与迷宫完全不重叠 → 整屏空白。限位范围含就绪点，故不阻断对准。 */
export function aimCam(relX, relY) {
  return {
    x: clamp(M.AIM_CAM.x + M.SEM.x * M.AIM_GAIN * relX,
      M.AIM_CAM.x - M.AIM_CLAMP.x, M.AIM_CAM.x + M.AIM_CLAMP.x),
    y: clamp(M.AIM_CAM.y + M.SEM.y * M.AIM_GAIN * relY,
      M.AIM_CAM.y - M.AIM_CLAMP.y, M.AIM_CAM.y + M.AIM_CLAMP.y),
  };
}

/* 球在 AIM 阶段的屏幕位与准星（视口中心）的距离 */
export function ballScreen(g) {
  return w2s(g.ball.x, g.ball.y, g.cam);
}
export function readyDist(g) {
  const p = ballScreen(g);
  return Math.hypot(p.x - SCR_C.x, p.y - SCR_C.y);
}

/* ─────────────────────────── 棘轮 ───────────────────────────
 * F-LAB-06：仅当 |rel| 增大且符号不变时累加位移；回摆与抖动一律不产生位移。
 * 分轴独立（F-LAB-01），斜向转头自然合成。
 *
 * 逐帧推演（PLAY_GAIN=12、STEP_MAX=8）：
 *   +10 → +15  加深同号  → step = 12×5 = 60  → 限幅 +8   ✅ 继续前进
 *   +15 → +12  回摆      → |rel| 减小       → 0          ✅ 不回退
 *   +12 → 0    回到中立  → 不累加           → 0
 *    0  → −5   越过中立  → lastRel=0 放行   → 12×(−5)    → 限幅 −8  ✅ 反向可行
 * 于是用户可以「划船式」来回摆动无限推进，全程无需维持静态偏转。
 *
 * ⚠ sem 必须按轴传（SEM.x / SEM.y）：两轴的真机方向语义是**分别标定**的，
 *   pitch 尚未标定（见 layout SEM 注释），写死 X 会让将来翻转 pitch 时漏改。 */
export function axisStep(rel, lastRel, sem) {
  if (lastRel === null) return 0;                       // 首帧只建立基准
  const deeper = Math.abs(rel) > Math.abs(lastRel);
  /* 符号判定：0 视为「无符号」，故从中立位(0)起步或回到中立位都放行——
   * 否则从死区出来（lastRel=0）会被判成符号不同而永远推不动。 */
  const sameSign = lastRel === 0 || rel === 0 || (rel > 0) === (lastRel > 0);
  if (!deeper || !sameSign) return 0;
  const s = sem === undefined ? M.SEM.x : sem;
  return clamp(s * M.PLAY_GAIN * (rel - lastRel), -M.STEP_MAX, M.STEP_MAX);
}

/* ─────────────────────── 碰撞：Circle vs AABB ───────────────────────
 * §3.2 借鉴代码的第 1~3 步（最近点 → 判定 → 位置推出）；第 4、5 步的
 * 法向 / 切向冲量在位移驱动下**不使用**（e = 0 纯滑行，F-LAB-43）。
 *
 * ⚠ 为什么「先推进后推出」就等价于滑行：穿透被推出后，法向位移归零、切向
 *   位移保留 —— 与「把 step 分解到法向/切向、只应用切向」数学等价，但不需要
 *   真的去分解向量。位移驱动下没有速度概念，故不存在"法向速度归零"这一步。 */
export function resolveWall(ball, w, r) {
  const rx = w.x, ry = w.y, rw = w.x + w.w, rh = w.y + w.h;
  const cx = clamp(ball.x, rx, rw);
  const cy = clamp(ball.y, ry, rh);
  const dx = ball.x - cx, dy = ball.y - cy;
  const d2 = dx * dx + dy * dy;

  if (d2 > 1e-9) {
    if (d2 >= r * r) return false;                 // 未接触
    const d = Math.sqrt(d2);
    ball.x = cx + (dx / d) * r;                    // 沿法向推出到刚好接触
    ball.y = cy + (dy / d) * r;
    return true;
  }

  /* 球心已落在矩形内部（异常穿入）：沿最近的一条边推出。
   * 正常参数下不会触发（STEP_MAX 8px << 漏检阈值 2·Rb+墙厚 = 20px），保留作防御。
   *
   * ⚠ 不能简单取「最近边」就完事：球心陷入**外墙**时，最近边往往是迷宫外侧
   *   那一面，会把球推到迷宫外面去（实测把球放在左外墙心会被推到 x = −7）。
   *   故候选方向按距离排序后，**优先取推出位置仍落在迷宫内的那个** ——
   *   玩家永远是从迷宫内部撞过来的，推出结果必须还在迷宫里。 */
  const cand = [
    { d: ball.x - rx, x: rx - r, y: ball.y },
    { d: rw - ball.x, x: rw + r, y: ball.y },
    { d: ball.y - ry, x: ball.x, y: ry - r },
    { d: rh - ball.y, x: ball.x, y: rh + r },
  ];
  cand.sort(function (a, b) { return a.d - b.d; });
  let pick = cand[0];
  for (let i = 0; i < cand.length; i++) {
    const c = cand[i];
    if (c.x >= r && c.x <= M.MAZE.w - r && c.y >= r && c.y <= M.MAZE.h - r) { pick = c; break; }
  }
  ball.x = pick.x;
  ball.y = pick.y;
  return true;
}

/* 全量求解 7 个 AABB。返回是否发生过接触（供断言观察滑行行为）。 */
export function resolveAll(ball, r) {
  let hit = false;
  for (let i = 0; i < M.WALLS.length; i++) {
    if (resolveWall(ball, M.WALLS[i], r)) hit = true;
  }
  return hit;
}

/* 把一段位移安全落到世界里（§6.2）：子步拆分 + 每子步碰撞求解 */
function moveBall(ball, sx, sy, r) {
  const len = Math.hypot(sx, sy);
  /* 子步（F-LAB-44）：单帧 8px 远小于漏检阈值 2·Rb+墙厚 = 20px，正常永不触发，
   * 保留只为防御「未来调大 STEP_MAX」的回归。 */
  let n = 1;
  if (len > M.SUBSTEP_PX) n = Math.min(M.SUBSTEP_MAX, Math.ceil(len / M.SUBSTEP_PX));
  const ux = sx / n, uy = sy / n;
  for (let i = 0; i < n; i++) {
    ball.x += ux;
    ball.y += uy;
    resolveAll(ball, r);
  }
}

/* ─────────────────────────── 更新 ─────────────────────────── */

/* update(g, dtMs, snap, rel)
 *   snap：InputEngine.update() 的像素快照（本册只取 ok 位，用于 IMU 判定）
 *   rel ：InputEngine.rel() 的角度快照（度，**本册真正的输入源**）
 * ⚠ 页面循环必须**先 update(dt) 再 rel()**，rel 依赖 update 维护的 relYaw。 */
export function update(g, dtMs, snap, rel) {
  const ev = [];
  if (g.over) return ev;

  /* 掉帧钳制（F-LAB-41）：单帧 >100ms 只推进 1 步，避免"补 10 步"瞬移穿墙 */
  const dt = dtMs > 100 ? 100 : (dtMs < 0 ? 0 : dtMs);
  g.t += dt;

  /* IMU 不可用（F-LAB-09）：**整体冻结** —— 既不推进也不回退。
   * ⚠ 严禁把 rel 当 0 去驱动：那会把回摆误判成反向推进，球会自己乱跑。
   *   AIM 态不计时（本来就不计），PLAY 态自然进入「已暂停」保护。 */
  if (!snap || snap.ok === false || !rel || rel.ok === false) {
    g.imuDown = true;
    return ev;
  }
  g.imuDown = false;

  const rx = rel.x || 0, ry = rel.y || 0;

  /* 无输入挂机（§10）：5 分钟零输入 → 结束本局 */
  if (rx !== 0 || ry !== 0) g.idleMs = 0;
  else g.idleMs += dt;
  if (g.idleMs >= M.IDLE_MS) {
    g.over = true;
    g.cleared = false;
    ev.push('finished');
    return ev;
  }

  /* ── AIM：准星不动，盘面反向滚（§4.1.1） ─────────────────── */
  if (g.phase === PH.AIM) {
    g.cam = aimCam(rx, ry);
    const d = readyDist(g);
    /* 迟滞（F-LAB-07）：进 <24 锁定、退 >32 解锁，防边界抖动 */
    if (!g.ready && d < M.READY_D) { g.ready = true; ev.push('ready'); }
    else if (g.ready && d > M.READY_HYST) { g.ready = false; }
    return ev;                                   // 不计时、不推进物理、不判定吸入
  }

  /* ── LAUNCH：起跑缓冲 0.4s（§4.1.3） ──────────────────────
   * 画面不变、物理不推进、计时未起算。相机已等于 camOf(START)，与 AIM 就绪
   * 态无缝（两阶段 1:1，不存在"推近"过渡）。 */
  if (g.phase === PH.LAUNCH) {
    if (g.t - g.phaseT >= M.LAUNCH_MS) {
      g.phase = PH.PLAY;
      g.phaseT = g.t;
      /* 起跑瞬间以当前 rel 重建棘轮基准（F-LAB-55 同一手法）：
       * 否则缓冲期转的头会在开局第一帧被算成一次大位移。 */
      g.lastRel = { x: rx, y: ry };
      ev.push('launch');
    }
    return ev;
  }

  /* ── RESPAWN：回起点过场 0.6s（F-LAB-55/56） ────────────────
   * 计时**不暂停不重置**；过场结束把球放回起点、速度清零、棘轮基准重置。 */
  if (g.phase === PH.RESPAWN) {
    g.timeLeftMs -= dt;                          // 计时继续走（双重惩罚）
    stepMover(g, dt);
    if (g.t - g.phaseT >= M.RESPAWN_MS) {
      g.ball.x = M.START.x;
      g.ball.y = M.START.y;
      g.phase = PH.PLAY;
      g.phaseT = g.t;
      g.lastRel = { x: rx, y: ry };              // 防回摆被误判为反向推进
    }
    g.cam = camOf(g.ball.x, g.ball.y);
    return ev;
  }

  /* ── TIMEOUT：超时过场 1.2s（设计补全，见 layout TIMEOUT_MS） ──
   * F-LAB-66 只写「超时 → 本关重开」，若无过场则计时归零瞬间画面毫无变化，
   * 玩家不知道发生了什么。过场结束重置计时 / 失误 / 球回起点。 */
  if (g.phase === PH.TIMEOUT) {
    if (g.t - g.phaseT >= M.TIMEOUT_MS) {
      restartLevel(g);
      ev.push('restart');
    }
    return ev;
  }

  /* ── PLAY：增量式位移（§4.1.2） ─────────────────────────── */
  g.timeLeftMs -= dt;
  stepMover(g, dt);

  const sx = axisStep(rx, g.lastRel ? g.lastRel.x : null, M.SEM.x);
  const sy = axisStep(ry, g.lastRel ? g.lastRel.y : null, M.SEM.y);
  g.lastRel = { x: rx, y: ry };   // 无论是否产生位移，基准**每帧都要推进**

  if (sx !== 0 || sy !== 0) moveBall(g.ball, sx, sy, M.R_BALL);

  /* 判定：吸入 → 失误；终点 → 通关；超时 → 过场重开 */
  if (sucked(g)) {
    g.miss += 1;
    g.phase = PH.RESPAWN;
    g.phaseT = g.t;
    g.cam = camOf(g.ball.x, g.ball.y);
    ev.push('suck');
    return ev;
  }
  if (Math.hypot(g.ball.x - M.END.x, g.ball.y - M.END.y) < M.GOAL_DIST) {
    g.cleared = true;
    g.over = true;
    g.cam = camOf(g.ball.x, g.ball.y);
    ev.push('goal');
    ev.push('finished');
    return ev;
  }
  if (g.timeLeftMs <= 0) {
    g.timeLeftMs = 0;
    g.phase = PH.TIMEOUT;
    g.phaseT = g.t;
    g.cam = camOf(g.ball.x, g.ball.y);
    ev.push('timeout');
    return ev;
  }

  /* 相机每帧直接赋值（F-LAB-12）：**不做 lerp**，球在屏幕中心是硬契约 */
  g.cam = camOf(g.ball.x, g.ball.y);
  return ev;
}

/* 移动洞：匀速垂直往返，端点反向不缓动（§7.3.6） */
function stepMover(g, dt) {
  g.moverY += g.moverDir * M.MOVER.speed * (dt / 1000);
  const hi = M.MOVER.y + M.MOVER.amp, lo = M.MOVER.y - M.MOVER.amp;
  if (g.moverY >= hi) { g.moverY = hi; g.moverDir = -1; }
  else if (g.moverY <= lo) { g.moverY = lo; g.moverDir = 1; }
}

/* 吸入判定（F-LAB-50）：球心距洞心 < R − 2（静止 12 / 移动 14） */
export function sucked(g) {
  const bx = g.ball.x, by = g.ball.y;
  for (let i = 0; i < M.HOLES.length; i++) {
    const h = M.HOLES[i];
    if (Math.hypot(bx - h.x, by - h.y) < h.r - M.SUCK_MARGIN) return true;
  }
  if (Math.hypot(bx - M.MOVER.x, by - g.moverY) < M.MOVER.r - M.SUCK_MARGIN) return true;
  return false;
}

/* 本关重开（F-LAB-66）：计时归零、失误清零、球回起点、移动洞归位 */
function restartLevel(g) {
  g.timeLeftMs = T_LIMIT_MS;
  g.miss = 0;
  g.ball.x = M.START.x;
  g.ball.y = M.START.y;
  g.moverY = M.MOVER.y;
  g.moverDir = 1;
  g.phase = PH.PLAY;
  g.phaseT = g.t;
  g.lastRel = null;                    // 下一帧重建基准，避免开局被甩一段
  g.cam = camOf(g.ball.x, g.ball.y);
}

/* 就绪后单击 → 起跑缓冲（F-LAB-32：仅就绪态生效） */
export function tryLaunch(g) {
  if (g.phase !== PH.AIM || !g.ready) return false;
  g.phase = PH.LAUNCH;
  g.phaseT = g.t;
  return true;
}

/* ─────────────────────────── 渲染 ─────────────────────────── */

export function render(g, ctx, fade) {
  const f = fade > 0 ? (fade > 1 ? 1 : fade) : 0;
  const col = function (a) { return gcol(fadeTo(a, f)); };

  /* ① 屏幕固定层：HUD 双胶囊（不随相机平移） */
  drawHudMid(g, ctx, col);

  /* ② 世界层：裁剪到迷宫矩形后整体平移。
   *    ⚠ 本作**外墙在迷宫矩形内部**（AABB 表前 4 项），故裁剪窗 == 迷宫本身
   *       [0,448]×[0,294]；与另三款「墙在球场外侧、裁剪窗 = 球场 ± wallBand」
   *       不同，照抄会把墙裁掉一半。
   *    越出裁剪窗的内容直接消失 → 迷宫外留白（F-LAB-13，用户的原始诉求）。 */
  const off = worldOffset(g.cam);
  ctx.save();
  ctx.beginPath();
  ctx.rect(off.x, off.y, M.MAZE.w, M.MAZE.h);
  ctx.clip();
  ctx.translate(off.x, off.y);
  drawWalls(ctx, col);
  drawPorts(g, ctx, col);
  drawHoles(g, ctx, col);
  ctx.restore();

  /* ③ 屏幕固定层：球恒在视口中心 + AIM 准星 + 过场提示 */
  drawBall(g, ctx, col);
  if (g.phase === PH.AIM) drawCrosshair(g, ctx, col);
  if (g.phase === PH.LAUNCH) drawLaunchRing(g, ctx, col);
  if (g.phase === PH.TIMEOUT) {
    text(ctx, '时间到 · 本关重来', SCR_C.x, SCR_C.y + 40,
      { size: 12, weight: 500, color: col(L.P72) });
  }
  if (g.imuDown) {
    text(ctx, M.IMU_TEXT, SCR_C.x, SCR_C.y + 40,
      { size: 12, weight: 500, color: col(L.P72) });
  }
}

/* 边界墙（世界层）：4 面外墙 **羽化收边带** + 3 道隔墙 6px @48% 实心。
 * ⚠ 全部 7 个 AABB 都要画 —— 外墙是视口滚出迷宫时**唯一的边界标识**，
 *   加粗到 8px 是刻意设计（F-LAB-20），别为了"省事"只画内墙。
 *
 * v1.34 外墙改版：8px 实心 @72% → 8px **羽化收边带**，与另四款同款语言 ——
 *   贴迷宫内壁那一面（= 球的物理反弹面）最亮（观感 ≈ 0.40），向屏幕外侧
 *   分 4 级（每级 2px）逐级淡出。真机反馈原 72% 实心边框过亮、且显粗糙。
 * ⚠ 隔墙 WI 是**玩法障碍**不是边框，保持实心 48% 不变（要能一眼看清缺口）。 */
function drawWalls(ctx, col) {
  const W = M.MAZE.w, H = M.MAZE.h, O = M.WO;
  const inner = M.MAZE.h - 2 * O;                    // 左右外墙的纵向长度 278
  /* 上：内侧面 y = 8（向下是迷宫），带子向上铺到 0 */
  fadeBand(ctx, 'h', O, { a: 0, len: W }, O, -1, M.WALL_STEPS, col);
  /* 下：内侧面 y = 286，带子向下铺到 294 */
  fadeBand(ctx, 'h', H - O, { a: 0, len: W }, O, 1, M.WALL_STEPS, col);
  /* 左：内侧面 x = 8，带子向左铺到 0 */
  fadeBand(ctx, 'v', O, { a: O, len: inner }, O, -1, M.WALL_STEPS, col);
  /* 右：内侧面 x = 440，带子向右铺到 448 */
  fadeBand(ctx, 'v', W - O, { a: O, len: inner }, O, 1, M.WALL_STEPS, col);

  ctx.fillStyle = col(L.P48);
  for (let i = 4; i < M.WALLS.length; i += 1) {
    const w = M.WALLS[i];
    ctx.fillRect(w.x, w.y, w.w, w.h);
  }
}

/* 起 / 终点孔（世界层）：均 r10 空心圆环 72% 2px；
 * 终点额外加四角焦点标记 2px @100%，与起点构成**形状 + 线型双通道**区分（F-LAB-24）。
 *
 * 【v1.38 用户反馈：起跑后起点圈还留在那儿，看着像"这里还有个东西"】
 *   起点环只在 **AIM / LAUNCH** 显示 —— 它的唯一职责是"把准星对到这里"；
 *   球一旦离开（PLAY 起），留着只会被误读成「又一个洞」或「要回到这里」。
 *   RESPAWN 回起点时同样不画（球是被动送回的，不需要玩家再对准）。
 *   终点环恒显示 —— 它是目标，全程都要看得见。 */
function drawPorts(g, ctx, col) {
  if (g.phase === 'AIM' || g.phase === 'LAUNCH') {
    strokeCircle(ctx, M.START.x, M.START.y, M.R_PORT, col(L.P72), 2);
  }
  strokeCircle(ctx, M.END.x, M.END.y, M.R_PORT, col(L.P72), 2);
  const k = M.R_PORT + 4, len = 4;
  ctx.strokeStyle = col(L.P100);
  ctx.lineWidth = 2;
  const cx = M.END.x, cy = M.END.y;
  ctx.beginPath();
  ctx.moveTo(cx - k + len, cy - k); ctx.lineTo(cx - k, cy - k); ctx.lineTo(cx - k, cy - k + len);
  ctx.moveTo(cx + k - len, cy - k); ctx.lineTo(cx + k, cy - k); ctx.lineTo(cx + k, cy - k + len);
  ctx.moveTo(cx - k + len, cy + k); ctx.lineTo(cx - k, cy + k); ctx.lineTo(cx - k, cy + k - len);
  ctx.moveTo(cx + k - len, cy + k); ctx.lineTo(cx + k, cy + k); ctx.lineTo(cx + k, cy + k - len);
  ctx.stroke();
}

/* 洞（世界层）：12% 底纹 + 72% 描边环 2px。
 * ⚠ 不画 100% 实心黑 —— D-LAB-03 裁决：7 个实心洞会违反「大面积填充 ≤12%」。 */
function drawHoles(g, ctx, col) {
  for (let i = 0; i < M.HOLES.length; i++) {
    const h = M.HOLES[i];
    fillCircle(ctx, h.x, h.y, h.r, col(L.P12));
    strokeCircle(ctx, h.x, h.y, h.r, col(L.P72), 2);
  }
  fillCircle(ctx, M.MOVER.x, g.moverY, M.MOVER.r, col(L.P12));
  strokeCircle(ctx, M.MOVER.x, g.moverY, M.MOVER.r, col(L.P72), 2);
}

/* 球：r7 @100% 实心，恒在视口中心 (240,192)（本作唯一主动焦点，F-LAB-25）
 * RESPAWN 过场按 F-LAB-55「球缩小消失」：前 0.3s 缩到 0，后 0.3s 保持消失，
 * 过完瞬移回起点（画面跳变被"先消失再出现"掩盖，不会看成球瞬移）。 */
function drawBall(g, ctx, col) {
  let r = M.R_BALL;
  if (g.phase === PH.RESPAWN) {
    const k = clamp((g.t - g.phaseT) / (M.RESPAWN_MS / 2), 0, 1);
    r = M.R_BALL * (1 - k);
    if (r <= 0.5) return;
  }
  fillCircle(ctx, SCR_C.x, SCR_C.y, r, col(L.P100));
}

/* AIM 准星：**恒钉屏幕中心**，三态只改亮度与环数（设计稿 S1/S2/S3）
 *   待开始 48% 四角 ｜ 搜索 72% 环 r24 ｜ 锁定 100% 双环 + 光晕
 * ⚠ 不要画成"准星在盘面上移动" —— 屏幕中心之外无法被稳定注视。 */
function drawCrosshair(g, ctx, col) {
  const a = g.ready ? L.P100 : L.P72;
  if (g.ready) {
    fillCircle(ctx, SCR_C.x, SCR_C.y, 12, col(L.P12));
    strokeCircle(ctx, SCR_C.x, SCR_C.y, 16, col(a), 2);
    strokeCircle(ctx, SCR_C.x, SCR_C.y, 24, col(a), 2);
    /* 四角焦点标记（100%）—— 与终点孔同一语言，表示"已锁定" */
    ctx.strokeStyle = col(a);
    ctx.lineWidth = 2;
    const k = 22, len = 7;
    ctx.beginPath();
    ctx.moveTo(SCR_C.x - k + len, SCR_C.y - k); ctx.lineTo(SCR_C.x - k, SCR_C.y - k);
    ctx.lineTo(SCR_C.x - k, SCR_C.y - k + len);
    ctx.moveTo(SCR_C.x + k - len, SCR_C.y - k); ctx.lineTo(SCR_C.x + k, SCR_C.y - k);
    ctx.lineTo(SCR_C.x + k, SCR_C.y - k + len);
    ctx.moveTo(SCR_C.x - k + len, SCR_C.y + k); ctx.lineTo(SCR_C.x - k, SCR_C.y + k);
    ctx.lineTo(SCR_C.x - k, SCR_C.y + k - len);
    ctx.moveTo(SCR_C.x + k - len, SCR_C.y + k); ctx.lineTo(SCR_C.x + k, SCR_C.y + k);
    ctx.lineTo(SCR_C.x + k, SCR_C.y + k - len);
    ctx.stroke();
  } else {
    strokeCircle(ctx, SCR_C.x, SCR_C.y, 24, col(a), 1.5);
    /* 十字短线（48%） */
    ctx.fillStyle = col(L.P48);
    ctx.fillRect(SCR_C.x - 9, SCR_C.y - 0.5, 18, 1);
    ctx.fillRect(SCR_C.x - 0.5, SCR_C.y - 9, 1, 18);
  }
}

/* 起跑缓冲倒计时环（§4.1.3）：r34 @48% + r22 @100%，随 0.4s 收束 */
function drawLaunchRing(g, ctx, col) {
  const k = clamp((g.t - g.phaseT) / M.LAUNCH_MS, 0, 1);
  strokeCircle(ctx, SCR_C.x, SCR_C.y, 34 - 12 * k, col(L.P48), 1);
  strokeCircle(ctx, SCR_C.x, SCR_C.y, 22 - 8 * k, col(L.P100), 2);
}

/* HUD 双胶囊（§5.2）：落在系统 HUD 中段空档 x 92~352，不占画面区。
 * AIM 阶段整体置灰 24%（F-LAB-19），表示"未起算"。 */
function drawHudMid(g, ctx, col) {
  const H = M.HUDX;
  const greyed = (g.phase === PH.AIM);
  const labelA = greyed ? L.P24 : L.P48;
  const sec = Math.max(0, Math.ceil(g.timeLeftMs / 1000));

  /* 时间胶囊 */
  roundRectPath(ctx, H.timeX, H.capY, H.timeW, H.capH, H.capR);
  ctx.fillStyle = col(L.P06);
  ctx.fill();
  ctx.strokeStyle = col(L.P24);
  ctx.lineWidth = 1;
  ctx.stroke();
  text(ctx, '时间', H.timeLabelX, H.midY,
    { size: H.labelSize, weight: 500, color: col(labelA), align: 'left' });
  /* 低时告警（F-LAB-16）：≤10s 提亮 100% 并每 500ms 闪一次，不加第二个主动效 */
  let va = greyed ? L.P24 : L.P72;
  if (!greyed && sec <= H.lowAt) va = ((g.t % H.lowFlashMs) < H.lowFlashMs / 2) ? L.P100 : L.P24;
  text(ctx, String(sec), H.timeValRight, H.midY,
    { size: H.valSize, weight: 500, mono: true, color: col(va), align: 'right' });

  /* 失误胶囊 */
  roundRectPath(ctx, H.missX, H.capY, H.missW, H.capH, H.capR);
  ctx.fillStyle = col(L.P06);
  ctx.fill();
  ctx.strokeStyle = col(L.P24);
  ctx.lineWidth = 1;
  ctx.stroke();
  text(ctx, '失误', H.missLabelX, H.midY,
    { size: H.labelSize, weight: 500, color: col(labelA), align: 'left' });
  text(ctx, String(g.miss), H.missValRight, H.midY,
    { size: H.valSize, weight: 500, mono: true, color: col(va === L.P100 ? L.P72 : (greyed ? L.P24 : L.P72)), align: 'right' });
}

/* ─────────────────────────── 结算 ───────────────────────────
 * §8：得分 = max(0, 剩余秒数 × 10 − 失误 × 50)，下限 0（D-LAB-02 裁决，不出现负数） */
export function result(g) {
  const sec = Math.max(0, Math.ceil(g.timeLeftMs / 1000));
  const score = Math.max(0, sec * M.SCORE_PER_SEC - g.miss * M.MISS_PENALTY);
  return {
    score: score,
    cleared: !!g.cleared,
    reachedLevel: 1,                    // 单关（F-LAB-63）
    extra: [
      { label: '用时', value: (M.TIME_LIMIT_S - sec) + 's' },
      { label: '失误', value: g.miss + ' 次' },
    ],
  };
}
