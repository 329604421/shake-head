/* harness-imu-latency.mjs —— 头控**响应延迟**回归（v1.54 · 交互 v1.23）
 *
 * 【为什么要有这份夹具】
 * v1.53 的「转头迟钝」不是玄学，是四个按帧参数叠加出来的：
 *   低通 α=0.35/帧（30fps ⇒ τ≈94ms，掉到 15fps ⇒ τ≈190ms）
 *   限幅 12px/帧（30fps ⇒ 360px/s，相机全行程单程 420ms）
 *   死区 3° 硬门（边界处输出从 0 **跳**到 3° ≈ 24px）
 *   漂移 0.5°/s 全程生效（保持转头时画面以 4px/s 慢慢溜回中位）
 * 此前这些数字没有任何断言保护，改一个就悄悄退化。本夹具把「转头 20° 之后
 * 画面多久到位」变成可回归的硬门槛，并给每条主断言配**旧口径对照组**。
 *
 * 【锁的五件事】
 *  A. 阶跃响应：起步要快（首帧位移）、到位要快（N 帧达 90%）、不许过冲。
 *  B. 与帧率解耦：15 / 30 / 60fps 下"到位时间"的墙钟差 < 80ms。
 *  C. 死区软启动：值与斜率双连续，边界**无突跳**；≥5° 比旧口径更灵敏。
 *  D. 限速按时间：px/s 语义成立；选择/菜单态（frozen）走更保守的一档。
 *  E. 陀螺快通道：轴系正确 ⇒ 抵消融合滞后；轴系反号 ⇒ 永不准入 / 自动关闭，
 *     偏离被钳制、绝不发散；长时间静止后融合角回到绝对姿态（不漂）。
 *
 * ⚠ 虚拟时钟：input.js 的计时走 Date.now()，构造引擎前替换（模块内无
 *   模块级 Date.now() 调用）。
 * ⚠ 夹具内**顺序敏感**：陀螺准入结论 GYRO_CAL 是模块级单例（设备属性），
 *   故「轴系反号 ⇒ 永不准入」必须跑在任何一次成功准入**之前**。
 */

import { InputEngine, shapeAngle, SENSITIVITY, SWAP_AXES, SIGN, gyroToRates, fuseTau,
  WARM_MAX_MS, WARM_MIN_READS } from './utils/input.js';
import { HEAD } from './utils/layout.js';

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; fails.push(name + (extra ? '  → ' + extra : '')); }
}

/* ── 虚拟时钟 ───────────────────────────────────────────────── */
const REAL_NOW = Date.now;
let VNOW = 1700000000000;
Date.now = function () { return Math.round(VNOW); };

/* ── 伪造 AbsoluteOrientationSensor ─────────────────────────── */
function FakeSensor() {
  this.activated = false; this.hasReading = false; this.quaternion = null;
  this._h = {}; this._stopped = false;
}
FakeSensor.prototype.addEventListener = function (n, fn) { (this._h[n] = this._h[n] || []).push(fn); };
FakeSensor.prototype.start = function () { this.activated = true; this._stopped = false; };
FakeSensor.prototype.stop = function () { this.activated = false; this._stopped = true; };
FakeSensor.prototype.emit = function (q) {
  if (this._stopped) return false;
  this.quaternion = q; this.hasReading = true;
  const hs = this._h.reading || [];
  for (let i = 0; i < hs.length; i++) hs[i]({ quaternion: q });
  return true;
};
globalThis.AbsoluteOrientationSensor = FakeSensor;

/* ── 伪造 Gyroscope（契约：x/y/z，标准语义 rad/s） ───────────── */
function FakeGyro() {
  this.x = null; this.y = null; this.z = 0;
  this.activated = false; this._h = {}; this._n = 0;
}
FakeGyro.prototype.addEventListener = function (n, fn) { (this._h[n] = this._h[n] || []).push(fn); };
FakeGyro.prototype.start = function () { this.activated = true; };
FakeGyro.prototype.stop = function () { this.activated = false; };
FakeGyro.prototype.emit = function (x, y) {
  this.x = x; this.y = y; this._n++;
  const hs = this._h.reading || [];
  for (let i = 0; i < hs.length; i++) hs[i]({ x: x, y: y, z: 0 });
};
/* 由「期望的视轴 yaw 角速度（°/s）」反推陀螺原始读数，与 gyroToRates 互逆：
 *   SWAP_AXES ⇒ ωYaw = −ωx·SIGN.pitch；否则 ωYaw = +ωy·SIGN.yaw */
function gyroVecForYawRate(wDeg) {
  const r = wDeg * Math.PI / 180;
  if (SWAP_AXES) return { x: -r / (SIGN.pitch || 1), y: 0 };
  return { x: 0, y: r / (SIGN.yaw || 1) };
}

/* 绕设备 X 轴转 θ ⇒ pitchRaw = −θ ⇒（SWAP_AXES）yaw 输出 = −θ */
function quatForYawOut(deg) {
  const th = -deg * Math.PI / 180;
  return [Math.sin(th / 2), 0, 0, Math.cos(th / 2)];
}

const COEF = SENSITIVITY.standard.coef;
const FRAME = 33;

/* 预热：喂稳定读数直到 WARM_MAX_MS(500ms) 收口且基准已建立 */
function warmUp(eng, frameMs, deg) {
  const n = Math.ceil((WARM_MAX_MS + 60) / (frameMs || FRAME)) + 2;   // 覆盖整个预热窗口
  for (let i = 0; i < n; i++) {
    VNOW += (frameMs || FRAME);
    eng.sensor.emit(quatForYawOut(deg || 0));
    eng.update(frameMs || FRAME);
  }
}
/* 推进一帧：先陀螺（积分）后绝对姿态（校正），与真机到达顺序一致。
 * ⚠ 拆成两层：`tick` 推进虚拟时钟，`stepNoClock` 不推进 —— 同时驱动两个
 *   引擎做对照时必须后者（否则一帧内时钟被推进两次，两边 dt 全错，
 *   对照组就变成了假对照）。 */
function stepNoClock(eng, absDeg, wDeg, frameMs) {
  if (wDeg !== undefined && eng.gyro) {
    const v = gyroVecForYawRate(wDeg);
    eng.gyro.emit(v.x, v.y);
  }
  eng.sensor.emit(quatForYawOut(absDeg));
  return eng.update(frameMs || FRAME);
}
function tick(eng, absDeg, wDeg, frameMs) {
  VNOW += (frameMs || FRAME);
  return stepNoClock(eng, absDeg, wDeg, frameMs);
}

/* ═══════════ A 组：阶跃响应（20° 阶跃，30fps，无陀螺） ═══════════ */
const TARGET20 = COEF * shapeAngle(20);
{
  const eng = new InputEngine({ sensitivity: 'standard' });
  eng.start();
  warmUp(eng, FRAME, 0);
  const xs = [];
  for (let i = 0; i < 14; i++) xs.push(tick(eng, 20).x);

  check('A1 阶跃首帧就有位移（>8px）：起步延迟只有一帧',
    xs[0] > 8, 'x1=' + xs[0].toFixed(1));
  check('A2 首帧位移 ≥ 旧口径（12px/帧）的 2 倍：限速从 360px/s 提到 1200px/s',
    xs[0] >= 24, 'x1=' + xs[0].toFixed(1) + ' 旧=12');
  let f90 = -1;
  for (let i = 0; i < xs.length; i++) { if (xs[i] >= TARGET20 * 0.9) { f90 = i + 1; break; } }
  check('A3 【硬门槛】5 帧（165ms）内达 90% 目标（v1.53 需 11 帧 / 363ms）',
    f90 > 0 && f90 <= 5, 'f90=' + f90 + ' 目标=' + TARGET20.toFixed(1) + 'px');
  const tail = xs[xs.length - 1];
  check('A4 稳态不过冲：末帧与目标差 < 6px（前馈上限 2° = 16px，实测远小于此）',
    Math.abs(tail - TARGET20) < 6, 'x=' + tail.toFixed(1) + ' 目标=' + TARGET20.toFixed(1));
  check('A5 到位时间从 v1.53 的 ~400ms 降到 <200ms',
    f90 > 0 && f90 * FRAME < 200, 't=' + (f90 * FRAME) + 'ms');

  /* 对照组：v1.53 口径（死区3 + 压扁 + LP0.35/帧 + 12px/帧）逐帧复算 */
  const clampTo = function (v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); };
  let oX = 0, oPx = 0;
  const aOld = 20 - 3;                       // 旧 shapeAngle(20°)：>8° 段 = a−3
  for (let i = 0; i < 6; i++) {
    oX = 0.35 * aOld + 0.65 * oX;            // 旧低通：按帧系数
    oPx = clampTo(8 * oX, oPx - 12, oPx + 12);   // 旧限幅：12px/**帧**
  }
  check('A6 对照组：旧口径第 6 帧只到 <55% 目标（证明 A3 不是空转）',
    oPx < TARGET20 * 0.55, 'old6=' + oPx.toFixed(1) + ' 目标=' + TARGET20.toFixed(1));
}

/* ═══════════ B 组：与帧率解耦（掉帧不再放大延迟） ═══════════ */
function timeTo90(frameMs, deg) {
  const eng = new InputEngine({ sensitivity: 'standard' });
  eng.start();
  warmUp(eng, frameMs, 0);
  const target = COEF * shapeAngle(deg);
  let t = 0;
  for (let i = 0; i < 240; i++) {
    t += frameMs;
    const s = tick(eng, deg, undefined, frameMs);
    if (Math.abs(s.x) >= target * 0.9) return t;
  }
  return Infinity;
}
{
  const t30 = timeTo90(33, 20), t60 = timeTo90(1000 / 60, 20), t15 = timeTo90(1000 / 15, 20);
  check('B1 30fps 到位 < 220ms', t30 < 220, 't30=' + t30 + 'ms');
  check('B2 【帧率解耦】15fps 与 30fps 的到位时间差 < 80ms（v1.53 会差 2 倍以上）',
    Math.abs(t15 - t30) < 80, 't15=' + t15 + ' t30=' + t30);
  check('B3 【帧率解耦】60fps 与 30fps 的到位时间差 < 80ms',
    Math.abs(t60 - t30) < 80, 't60=' + t60 + ' t30=' + t30);
  check('B4 三种帧率都能到位（无 Infinity）',
    isFinite(t15) && isFinite(t30) && isFinite(t60), t15 + '/' + t30 + '/' + t60);
}

/* ═══════════ C 组：死区软启动（无突跳 + 更灵敏） ═══════════ */
{
  const d = HEAD.deadDeg, S = HEAD.softDeg;
  check('C1 死区内恒为 0',
    shapeAngle(0) === 0 && shapeAngle(d) === 0 && shapeAngle(-d) === 0);
  check('C2 【无突跳】死区边界两侧差值 < 0.02°（v1.53 在此从 0 跳到 3° ≈ 24px）',
    Math.abs(shapeAngle(d + 0.01) - shapeAngle(d - 0.01)) < 0.02,
    'Δ=' + Math.abs(shapeAngle(d + 0.01) - shapeAngle(d - 0.01)).toFixed(5));
  check('C3 软启动终点两侧连续（值与斜率都与线性段吻合）',
    Math.abs(shapeAngle(S + 0.001) - shapeAngle(S - 0.001)) < 0.01);
  let mono = true, prev = -1;
  for (let a = 0; a <= 30; a += 0.05) { const v = shapeAngle(a); if (v < prev - 1e-9) mono = false; prev = v; }
  check('C4 0~30° 单调不减', mono);
  check('C5 奇对称', Math.abs(shapeAngle(-12) + shapeAngle(12)) < 1e-9);
  const oldShape = function (v) {
    const a = Math.abs(v);
    if (a <= 3) return 0;
    if (a <= 8) return 3 + 0.08 * (a - 3) * (a - 3);
    return a - 3;
  };
  check('C6 ≥5° 比旧口径更灵敏（20°：' + shapeAngle(20).toFixed(2) + '° vs 旧 '
    + oldShape(20).toFixed(2) + '°）', shapeAngle(20) > oldShape(20));
  check('C7 死区比旧口径更小（' + d + '° < 3°）⇒ 微转头不再被整段吞掉', d < 3);
}

/* ═══════════ D 组：限速按时间（px/s） ═══════════ */
function firstFrameX(frameMs, deg, frozen) {
  const eng = new InputEngine({ sensitivity: 'standard' });
  eng.start();
  warmUp(eng, frameMs, 0);
  if (frozen) eng.freezeDrift(true);
  return tick(eng, deg, undefined, frameMs).x;
}
{
  const x30 = firstFrameX(33, 20), x60 = firstFrameX(1000 / 60, 20);
  check('D1 【px/s 语义】30fps 单帧位移 ≈ 60fps 的 2 倍（±10%）',
    x30 / x60 > 1.8 && x30 / x60 < 2.2, 'ratio=' + (x30 / x60).toFixed(3));
  const lim = HEAD.maxPxPerSec * 0.033;
  check('D2 极高速甩头（90° 阶跃）单帧不超 1200px/s × dt',
    firstFrameX(33, 90) <= lim + 0.001, 'x=' + firstFrameX(33, 90).toFixed(1) + ' lim=' + lim.toFixed(1));
  const xf = firstFrameX(33, 20, true);
  check('D3 选择/菜单态（frozen）限速更保守：620px/s 档生效',
    xf > 0 && xf < x30 * 0.7, 'frozen=' + xf.toFixed(1) + ' play=' + x30.toFixed(1));
  check('D4 限速常量已从 12px/帧（360px/s）提到 ≥1000px/s',
    HEAD.maxPxPerSec >= 1000 && HEAD.menuPxPerSec < HEAD.maxPxPerSec);
}

/* ═══════════ E 组：陀螺快通道（三态：正确 / 反号 / 饱和自愈） ═══════════ */
/* E0：默认无陀螺（本组第一条，保证 GYRO_CAL 仍是初始态） */
{
  const eng = new InputEngine({ sensitivity: 'standard' });
  eng.start();
  check('E0 宿主无 Gyroscope 时静默回落纯绝对姿态口径（_gyroOn=false，不抛错）',
    eng._gyroOn === false && eng.gyro === null);
}

/* E1~E3：轴系**反号** ⇒ 永不准入（必须跑在任何一次成功准入之前） */
{
  globalThis.Gyroscope = FakeGyro;
  const eng = new InputEngine({ sensitivity: 'standard' });
  eng.start();
  check('E1 有 Gyroscope 时创建并起采陀螺实例',
    !!eng.gyro && eng.gyro.activated === true && eng._gyroOn === true);
  check('E2 初始为**待准入**（未经验证不得积分）', eng._gyroArmed === false);
  /* 以 60°/s 转头，但陀螺读数反号 */
  for (let i = 0; i < 30; i++) tick(eng, i * 60 * FRAME / 1000, -60);
  check('E3 【安全网】轴系反号 ⇒ 永不准入且判定不可用（积分从未启动，输出不受污染）',
    eng._gyroArmed === false && eng._gyroBad === true, 'armed=' + eng._gyroArmed + ' bad=' + eng._gyroBad);
  const div = Math.abs(eng._fYaw - eng.lastYaw);
  check('E4 反号期间融合角恒等于绝对姿态（偏离 < 0.001°）', div < 0.001, 'div=' + div.toFixed(6));
}

/* E5~E9：轴系正确 ⇒ 准入 + 抵消融合滞后 + 静止后收敛不漂 */
const LAG = 60;                                   // 伪造宿主的融合滞后（ms）
const RATE = 60;                                  // 转头角速度（°/s）
function truthYaw(t) { return t <= 0 ? 0 : RATE * t / 1000; }
function laggedYaw(t) { return truthYaw(t - LAG); }
{
  const arm = new InputEngine({ sensitivity: 'standard' });
  arm.start();
  let armed = false, t = 0;
  for (let i = 0; i < 40 && !armed; i++) {
    t += FRAME;
    tick(arm, truthYaw(t), RATE);
    armed = arm._gyroArmed;
  }
  check('E5 轴系正确 ⇒ 220ms 内完成准入（净同向累计达标）',
    armed === true && t >= HEAD.armMs && t < 600, 'armedAt=' + t + 'ms');

  /* 设备级结论已持久化 ⇒ 新引擎（新页面）开局即准入 */
  const g = new InputEngine({ sensitivity: 'standard' });
  g.start();
  check('E6 准入结论是**设备级**的：后续页面开局即准入（不必每页重新攒 220ms）',
    g._gyroArmed === true);

  /* 对照组：同一滞后模型下关掉陀螺 */
  const Saved = globalThis.Gyroscope;
  globalThis.Gyroscope = undefined;
  const a = new InputEngine({ sensitivity: 'standard' });
  a.start();
  globalThis.Gyroscope = Saved;

  warmUp(g, FRAME, 0); warmUp(a, FRAME, 0);
  let tg = 0, xg100 = 0, xa100 = 0, maxDiv = 0, t60g = -1, t60a = -1;
  for (let i = 0; i < 40; i++) {
    tg += FRAME;
    VNOW += FRAME;                                   // 两个引擎共用同一帧
    const xg = stepNoClock(g, laggedYaw(tg), RATE).x;
    const xa = stepNoClock(a, laggedYaw(tg), undefined).x;
    if (t60g < 0 && Math.abs(xg) >= 60) t60g = tg;
    if (t60a < 0 && Math.abs(xa) >= 60) t60a = tg;
    const dv = Math.abs(g._fYaw - g.lastYaw);
    if (dv > maxDiv) maxDiv = dv;
    if (tg <= 100) { xg100 = xg; xa100 = xa; }
  }
  /* 直接量**延迟**：画面走到 60px 各用了多久（差 ≈ 被抵消的融合滞后） */
  check('E7 【治本项】带陀螺时画面走到 60px 比纯绝对姿态早 ≥30ms（'
    + t60g + 'ms vs ' + t60a + 'ms）',
    t60g > 0 && t60a > 0 && t60g <= t60a - 30, 'Δ=' + (t60a - t60g) + 'ms');
  check('E8 转头 100ms 时带陀螺的位移 > 纯绝对姿态的 1.8 倍',
    xg100 > xa100 * 1.8, 'gyro=' + xg100.toFixed(1) + 'px abs=' + xa100.toFixed(1) + 'px');
  check('E9 融合角对绝对姿态的领先被滞后本身限死（≤ ω×LAG + 0.5°）',
    maxDiv <= RATE * LAG / 1000 + 0.5, 'maxDiv=' + maxDiv.toFixed(2) + '°');

  /* 停止转头后长时间保持：融合角必须收敛回绝对姿态（陀螺零偏不累积） */
  const hold = laggedYaw(tg);
  for (let i = 0; i < 260; i++) tick(g, hold, 0);
  check('E10 静止 8s 后融合角回到绝对姿态（|Δ| < 0.3°）：陀螺零偏不累积成漂移',
    Math.abs(g._fYaw - g.lastYaw) < 0.3, 'Δ=' + Math.abs(g._fYaw - g.lastYaw).toFixed(4) + '°');
}

/* E11~E13：已被设备级判定准入、但本页读数反号 ⇒ 钳制 + 自动关闭 */
{
  const eng = new InputEngine({ sensitivity: 'standard' });
  eng.start();
  check('E11 复用设备级准入（构造即 armed）', eng._gyroArmed === true);
  let maxDiv = 0, t = 0;
  for (let i = 0; i < 60; i++) {                    // ≈2s 反向转头
    t += FRAME;
    tick(eng, RATE * t / 1000, -RATE);
    const dv = Math.abs(eng._fYaw - eng.lastYaw);
    if (dv > maxDiv) maxDiv = dv;
  }
  check('E12 【不发散】反向期间偏离被钳制在 gyroMaxDiv 内',
    maxDiv <= HEAD.gyroMaxDiv + 0.01, 'maxDiv=' + maxDiv.toFixed(2) + ' 上限=' + HEAD.gyroMaxDiv);
  check('E13 持续顶到上限 ⇒ 自动关闭陀螺并回落到绝对姿态口径',
    eng._gyroBad === true && eng._gyroArmed === false
    && Math.abs(eng._fYaw - eng.lastYaw) < 0.001,
    'bad=' + eng._gyroBad + ' Δ=' + Math.abs(eng._fYaw - eng.lastYaw).toFixed(4));
  globalThis.Gyroscope = undefined;
}

/* ═══════════ F 组：漂移回中（保持转头不再"溜回中位"） ═══════════ */
{
  const eng = new InputEngine({ sensitivity: 'standard' });
  eng.start();
  warmUp(eng, FRAME, 0);
  for (let i = 0; i < 14; i++) tick(eng, 20);
  const x0 = Math.abs(eng._px);
  for (let i = 0; i < 300; i++) tick(eng, 20);       // 保持 10s
  const x1 = Math.abs(eng._px);
  check('F1 保持转头 10s 后仍 ≥ 目标的 90%（v1.53 的 0.5°/s 会掉到 ~73%）',
    x1 >= TARGET20 * 0.9, 'x=' + x1.toFixed(1) + ' 目标=' + TARGET20.toFixed(1));
  check('F2 明显偏离时漂移速率已降到 ≤0.1°/s（v1.53 为 0.5°/s）',
    HEAD.driftActive <= 0.1 && HEAD.driftRest > HEAD.driftActive,
    'active=' + HEAD.driftActive + ' rest=' + HEAD.driftRest);
  check('F3 静止在死区附近时仍按 rest 档吸收融合慢漂', (function () {
    const e2 = new InputEngine({ sensitivity: 'standard' });
    e2.start();
    warmUp(e2, FRAME, 0);
    for (let i = 0; i < 10; i++) tick(e2, 1.0);      // rel=1°（死区内）
    const before = Math.abs(e2.yaw0 - 1.0);
    for (let i = 0; i < 90; i++) tick(e2, 1.0);      // 3s
    const after = Math.abs(e2.yaw0 - 1.0);
    return after < before - 0.5;
  })());
  check('F4 输出方向正确（头左转 snap.x>0 ⇒ 相机同向）', x0 > 0, 'x0=' + x0.toFixed(1));
}

/* ═══════════ G 组：角速度前馈（相位提前，不捅穿死区） ═══════════ */
{
  /* 差分对照：两台引擎走**完全相同**的读数序列，只在最后一帧给其中一台
   * 注入大角速度。前馈只应影响像素通道，rel（增量通道）必须逐位相同。 */
  function settle() {
    const e = new InputEngine({ sensitivity: 'standard' });
    e.start();
    warmUp(e, FRAME, 0);
    for (let i = 0; i < 14; i++) tick(e, 20);
    return e;
  }
  const eng = settle(), ref = settle();
  /* 各补一帧让两台引擎的 lastTs 都贴到当前虚拟时刻：否则 update() 里的
   * 看门狗（800ms 无读数）会把它们判成掉线，测的就不是前馈了。 */
  VNOW += FRAME; stepNoClock(eng, 20); stepNoClock(ref, 20);
  eng._rateYaw = 500; ref._rateYaw = 0;                // 人为注入一个大角速度
  const s = eng.update(FRAME), sr = ref.update(FRAME);
  check('G1 前馈生效：大角速度下输出被提前（> 同序列无前馈者）',
    s.x > sr.x + 1, 'x=' + s.x.toFixed(1) + ' 无前馈=' + sr.x.toFixed(1));
  /* 上界含低通残差（前馈是叠在低通输出之上的，不是取而代之） */
  check('G2 前馈有上限（增量 ≤ feedMaxDeg × coef = '
    + (HEAD.feedMaxDeg * COEF).toFixed(0) + 'px + 低通残差）',
    s.x - sr.x <= HEAD.feedMaxDeg * COEF + 1.5, 'Δ=' + (s.x - sr.x).toFixed(2));
  check('G3 【不污染增量通道】前馈只作用于像素通道：rel 与无前馈者逐位相同'
    + '（rel 是棘轮，前馈衰减会造成反向推进）',
    eng.rel(0).x === ref.rel(0).x,
    'rel=' + eng.rel(0).x.toFixed(6) + ' ref=' + ref.rel(0).x.toFixed(6));
  /* 死区内不得被前馈捅穿 */
  const e2 = new InputEngine({ sensitivity: 'standard' });
  e2.start();
  warmUp(e2, FRAME, 0);
  e2._rateYaw = 500;
  let allZero = true;
  for (let i = 0; i < 10; i++) { if (tick(e2, 0).x !== 0) allZero = false; }
  check('G4 【死区不被捅穿】静止在中位且残留大角速度 ⇒ 输出恒 0', allZero);
}

/* ═══════════ H 组：诊断通道 ═══════════ */
{
  const eng = new InputEngine({ sensitivity: 'standard' });
  eng.start();
  warmUp(eng, FRAME, 0);
  const h = eng.health();
  check('H1 health() 含 fps= 与 gy=（真机"还是迟钝"时先读这两段定性）',
    /fps=/.test(h) && /gy=/.test(h), h);
  check('H2 fps 估计接近真实节拍（30fps ± 3）',
    Math.abs(eng._fps - 30) < 3, 'fps=' + (eng._fps || 0).toFixed(1));
  check('H3 health() 仍含旧的五段（reads/hz/warm/act/err），不破坏既有取证',
    /reads=/.test(h) && /hz=/.test(h) && /warm=/.test(h) && /act=/.test(h) && /err=/.test(h));
}

/* ═══════════ I 组：无传感器 / 掉线兼容（v1.42 红线不回退） ═══════════ */
{
  const SavedA = globalThis.AbsoluteOrientationSensor;
  const SavedG = globalThis.Gyroscope;
  globalThis.AbsoluteOrientationSensor = undefined;
  globalThis.Gyroscope = undefined;
  let threw = false, eng = null;
  try { eng = new InputEngine({}); eng.start(); } catch (e) { threw = true; }
  check('I1 无传感器时 start() 不抛异常', !threw);
  check('I2 无传感器时 warming=false / imuOk=false / _gyroOn=false',
    !!eng && eng.warming === false && eng.imuOk === false && eng._gyroOn === false);
  const s = eng.update(FRAME);
  check('I3 掉线时 update 返回 ok:false 且位移为 0（分册据此置 g.imuDown）',
    s.ok === false && s.x === 0 && s.y === 0);
  check('I4 掉线时 rel() 返回 ok:false（滚球迷宫据此整体冻结）',
    eng.rel().ok === false);
  globalThis.AbsoluteOrientationSensor = SavedA;
  globalThis.Gyroscope = SavedG;
}

/* ── 陀螺读数反解（模块级，J / K 组共用） ──────────────────────────────
 * 求原始读数使 gyroToRates 恰好产出 (wYaw, wPitch)，不依赖 SWAP_AXES / SIGN /
 * GYRO_RAD 的具体取值 —— 手推轴映射极易出错（SWAP_AXES 下 pitch 来自 y 通道）。 */
const u1 = gyroToRates({ x: 1, y: 0 }), u2 = gyroToRates({ x: 0, y: 1 });
const DETG = u1.yaw * u2.pitch - u2.yaw * u1.pitch;
function gyroVec(wYaw, wPitch) {
  return {
    x: (wYaw * u2.pitch - wPitch * u2.yaw) / DETG,
    y: (wPitch * u1.yaw - wYaw * u1.pitch) / DETG,
  };
}

/* ═══════════ J 组：静止零漂（v1.55 · 真机「进选择态画面自己飘」硬回归） ═══════════
 *
 * 【真机现象】v1.54 引入陀螺互补融合后，进主页选择态、头部完全不动，画面却
 * 持续向上/向下飘几十 px，只能单击退回待机终止；重进有时正常。
 * 【根因】一阶互补滤波在**恒定角速度偏差**下的稳态解是
 *         偏离(°) = 零偏(°/s) × τ(s)
 *   消费级 MEMS 陀螺零偏常在 1~5°/s，τ 固定 2.5s ⇒ 稳态 2.5~12.5°
 *   ⇒ 画面恒漂 20~100px，时间常数 2.5s（用户观感：「刚进选择态就自己飘」）。
 *   「有时正常」= 陀螺尚未准入（首次转头前），或已顶到偏离上限被判 bad。
 * 【修复】τ 自适应：静止 0.3s / 运动 2.5s，逐轴按角速度插值。
 * ⚠ 顺序敏感：本组依赖陀螺已准入，必须跑在 E 组（成功准入）之后。 */
{
  /* ⚠ 前面的「无陀螺对照组」（E 组的 A/B 对照）把 globalThis.Gyroscope 置
   * 空后未恢复，本组必须自己装回来，否则测的是空转。 */
  globalThis.Gyroscope = FakeGyro;

  /* 完整重放真机场景：转头准入 → 退出 → 重进选择态（start + freezeDrift）
   * → 头部完全静止、陀螺带 bias 零偏 → 观察 8 秒内的画面位移 */
  function driftRun(bias) {
    const e = new InputEngine({ sensitivity: 'standard' });
    e.start();
    let t = 0;
    for (let i = 0; i < 60 && !e._gyroArmed; i++) {
      VNOW += FRAME; t += FRAME;
      const v = gyroVec(90, 0);
      e.gyro.emit(v.x, v.y);
      e.sensor.emit(quatForYawOut(90 * t / 1000));
      e.update(FRAME);
    }
    if (!e._gyroArmed) return null;
    e.start();                    // 重进选择态
    e.freezeDrift(true);
    let peak = 0, last = 0;
    for (let i = 0; i < 250; i++) {
      VNOW += FRAME;
      const v = gyroVec(0, bias);
      e.gyro.emit(v.x, v.y);
      e.sensor.emit(quatForYawOut(0));       // 绝对姿态恒定：头确实没动
      last = e.update(FRAME).y;
      if (Math.abs(last) > Math.abs(peak)) peak = last;
    }
    return { peak: peak, last: last, rel: e._fPitch - e.pitch0 };
  }

  const r3 = driftRun(3), r8 = driftRun(8);
  check('J1 场景可复现：陀螺已准入（否则本组测的是空转）', !!r3 && !!r8);
  check('J2 【核心】零偏 3°/s 静止 8s：画面位移 < 5px（修复前 46px）',
    !!r3 && Math.abs(r3.last) < 5, r3 ? 'last=' + r3.last.toFixed(2) + 'px' : 'n/a');
  check('J3 零偏 3°/s：过程峰值也 < 6px（不许"先漂出去再拉回"）',
    !!r3 && Math.abs(r3.peak) < 6, r3 ? 'peak=' + r3.peak.toFixed(2) + 'px' : 'n/a');
  check('J4 零偏 8°/s（恶劣）：位移 < 10px（修复前会顶到 15° 钳制 = 120px）',
    !!r8 && Math.abs(r8.last) < 10, r8 ? 'last=' + r8.last.toFixed(2) + 'px' : 'n/a');
  /* 对照：固定 τ=2.5s 的旧行为 = bias × 2.5s × coef */
  check('J5 与旧口径对照：偏离 < 固定 τ 理论值的 15%（证明自适应 τ 生效）',
    !!r3 && Math.abs(r3.rel) < 3 * (HEAD.fuseMs / 1000) * 0.15,
    r3 ? 'new=' + Math.abs(r3.rel).toFixed(2) + '° 旧理论='
      + (3 * HEAD.fuseMs / 1000).toFixed(1) + '°' : 'n/a');
  check('J6 静止时融合角紧跟绝对姿态：|fused − abs| < 1°',
    !!r3 && Math.abs(r3.rel) < 1, r3 ? 'rel=' + r3.rel.toFixed(3) + '°' : 'n/a');

  /* τ 曲线本身：静止短、运动长、中间单调连续 */
  check('J7 静止（ω=0）走短 τ = fuseRestMs', fuseTau(0) === HEAD.fuseRestMs);
  check('J8 运动（ω≥fuseMovW）走长 τ = fuseMs（保住陀螺的相位领先）',
    fuseTau(HEAD.fuseMovW) === HEAD.fuseMs && fuseTau(200) === HEAD.fuseMs);
  let mono = true, prev = -1;
  for (let w = 0; w <= 120; w += 2) { const v = fuseTau(w); if (v < prev) mono = false; prev = v; }
  check('J9 τ 随角速度单调不减且连续（无跳变 ⇒ 画面不会抖）', mono);
  check('J10 τ 上下界正确：静止档 < 运动档，且静止档 × 5°/s 零偏 < 死区',
    HEAD.fuseRestMs < HEAD.fuseMs && (5 * HEAD.fuseRestMs / 1000) < HEAD.deadDeg,
    '静止稳态=' + (5 * HEAD.fuseRestMs / 1000).toFixed(2) + '° 死区=' + HEAD.deadDeg + '°');

  /* v1.55：预热窗口补读数下限 —— 读数迟到时时间盒不能空跑 */
  const w = new InputEngine({ sensitivity: 'standard' });
  w.start();
  VNOW += FRAME; w.sensor.emit(quatForYawOut(0)); w.update(FRAME);
  VNOW += 600;
  check('J11 【v1.55】预热有读数下限：只收到 1 个读数时，过了 600ms 仍 warming'
    + '（防宿主读数迟到 ⇒ 基准建在未收敛值上）',
    w.warming === true, '_warmN=' + w._warmN);
  for (let i = 0; i < Math.ceil((WARM_MAX_MS + 200) / FRAME); i++) {
    VNOW += FRAME; w.sensor.emit(quatForYawOut(0)); w.update(FRAME);
  }
  check('J12 攒够读数（≥' + WARM_MIN_READS + '）且过了时间盒后收口（warming=false，不会永远预热）',
    w.warming === false, '_warmN=' + w._warmN);
}

/* ═══════════ K 组：冷启动收敛（v1.56 · 「一进选择态就飘」的最后一环） ═══════════
 *
 * 【为什么 J 组不够】J 组治的是**稳态**零偏漂移（bias × τ），但真机还有一条
 * 独立路径：传感器冷启动时绝对姿态自带收敛误差 E0·exp(−t/τc)。带陀螺的融合角
 * 会**滞后于**绝对姿态（一阶滞后对斜坡的稳态误差 = τ × 变化率 ≈ 0.3s×40°/s
 * = 12°），预热一到点基准就冻在这段残差上，之后融合角把残差走完 ⇒ 全部变成
 * 可见偏移。实测：预热收口瞬间 rel 只有 −0.13°，2 秒后涨到 −1.49°（12px）。
 * 【修复】预热期融合角直接等于绝对姿态（不积分陀螺），收口时起点已对齐。
 * ⚠ 本组依赖陀螺已准入，必须跑在 E 组之后。 */
{
  globalThis.Gyroscope = FakeGyro;

  /* 冷启动重放：绝对姿态 = E0·exp(−t/τc)，头部静止（真值 0），陀螺带零偏 */
  function coldRun(E0, tc, bias) {
    const e = new InputEngine({ sensitivity: 'standard' });
    e.start();
    e.freezeDrift(true);                       // 选择态：冻结漂移纠正
    let t = 0, warmEnd = -1;
    for (let i = 0; i < Math.ceil((WARM_MAX_MS + 120) / FRAME); i++) {
      VNOW += FRAME; t += FRAME;
      const v = gyroVec(bias, 0);              // 静止，只有零偏
      e.gyro.emit(v.x, v.y);
      e.sensor.emit(quatForYawOut(E0 * Math.exp(-t / tc)));
      e.update(FRAME);
      if (warmEnd < 0 && !e.warming) warmEnd = t;
    }
    /* 收口之后再跑 2s，取这段时间的**峰值**像素位移 —— 用户看到的就是它 */
    let peak = 0, relMax = 0;
    for (let i = 0; i < 60; i++) {
      VNOW += FRAME; t += FRAME;
      const v = gyroVec(bias, 0);
      e.gyro.emit(v.x, v.y);
      e.sensor.emit(quatForYawOut(E0 * Math.exp(-t / tc)));
      const s = e.update(FRAME);
      const rel = e._fYaw - e.yaw0;
      if (Math.abs(s.x) > Math.abs(peak)) peak = s.x;
      if (Math.abs(rel) > Math.abs(relMax)) relMax = rel;
    }
    return { warmEnd: warmEnd, peak: peak, rel: relMax, relNow: e._fYaw - e.yaw0 };
  }

  const c1 = coldRun(10, 250, 2), c2 = coldRun(20, 300, 4), c3 = coldRun(6, 200, 1);
  check('K1 【核心】冷启动 E0=10°/bias=2°/s：收口后峰值位移 < 3px（修复前 12px）',
    Math.abs(c1.peak) < 3, 'peak=' + c1.peak.toFixed(2) + 'px');
  check('K2 同上：|rel| 峰值 < 0.5°（落进 1.6° 死区，肉眼不可见）',
    Math.abs(c1.rel) < 0.5, 'rel=' + c1.rel.toFixed(3) + '°');
  check('K3 恶劣冷启动 E0=20°/τc=300ms/bias=4°/s：峰值位移 < 3px',
    Math.abs(c2.peak) < 3, 'peak=' + c2.peak.toFixed(2) + 'px');
  check('K4 轻微冷启动 E0=6°/bias=1°/s：峰值位移 < 3px',
    Math.abs(c3.peak) < 3, 'peak=' + c3.peak.toFixed(2) + 'px');
  check('K5 三种参数下 rel 都 < 0.5°（收敛快慢与零偏大小都不再影响起点）',
    Math.abs(c1.rel) < 0.5 && Math.abs(c2.rel) < 0.5 && Math.abs(c3.rel) < 0.5,
    [c1.rel, c2.rel, c3.rel].map(function (v) { return v.toFixed(3); }).join(' / '));

  /* 预热期不得积分陀螺：融合角必须恒等于绝对姿态（否则残差会被冻进基准） */
  const e = new InputEngine({ sensitivity: 'standard' });
  e.start();
  for (let i = 0; i < 4; i++) {
    VNOW += FRAME;
    const v = gyroVec(300, 0);                 // 预热期猛推陀螺
    e.gyro.emit(v.x, v.y);
    e.sensor.emit(quatForYawOut(0));
    e.update(FRAME);
  }
  check('K6 预热期不积分陀螺：融合角恒等于绝对姿态（残差不进基准）',
    e.warming === true && Math.abs(e._fYaw - e.lastYaw) < 1e-9,
    'warming=' + e.warming + ' Δ=' + (e._fYaw - e.lastYaw).toFixed(6));
  check('K7 预热期角速度取绝对姿态差分（不采信含零偏的陀螺速率）',
    Math.abs(e._rateYaw) < 1, 'rate=' + e._rateYaw.toFixed(3));

  /* 传感器实例重建 ⇒ 基准一并作废（新实例重新收敛，旧基准会造出几十度偏移） */
  const r = new InputEngine({ sensitivity: 'standard' });
  r.start();
  warmUp(r, FRAME, 0);
  check('K8 重建前基准已建立', r.yaw0 !== null);
  r._recreate();
  check('K9 【v1.56】实例重建后基准作废（yaw0=null），不会用旧世界的基准',
    r.yaw0 === null && r.pitch0 === null && r.warming === true);
}

/* ═══════════════ L 组：转头**幅度**必须完整保留（v1.57）═══════════════
 * 【背景】v1.42 的预热限速追赶是**无差别**的：把 rel 往 0 拉，既吸收融合
 * 收敛，也把用户的转头量一并吃掉。而主页 _enterSelect() 每次都 start()
 * ⇒ 每次进选择态都重跑 900ms 预热；选择态 frozen=true 之后不再纠正 ⇒
 * 被吃掉的幅度**永久丢失**。用户观感："很大幅转头却只有很小移动"，且
 * "有时正常" —— 取决于有没有撞上预热窗口。
 * 【修复】用**陀螺**区分「头部真的在动」与「读数自己在收敛」（绝对姿态
 * 无法区分，冷启动收敛变化率与转头同量级）：头动 ⇒ 追赶停止并锁定基准。
 * 【本组锁的】任何时刻开始转头，最终幅度都必须接近"预热跑完再转"的水平。 */
{
  const AMP = 25;                                  // 转头幅度（度）
  const EXPECT = AMP * COEF;                       // 200px
  function turnRun(delayMs, rate, useGyro, amp) {
    const A = amp === undefined ? AMP : amp;
    const e = new InputEngine({ sensitivity: 'standard' });
    e.start(); e.freezeDrift(true);                // 主页选择态
    const dur = rate > 0 ? A / rate * 1000 : 0;
    let t = 0, peak = 0, last = 0;
    const total = Math.ceil((delayMs + dur + 800) / FRAME);
    for (let i = 0; i < total; i++) {
      VNOW += FRAME; t += FRAME;
      const moved = t <= delayMs ? 0 : Math.min(A, rate * (t - delayMs) / 1000);
      const w = (t > delayMs && t <= delayMs + dur) ? rate : 0;
      if (useGyro && e.gyro) { const v = gyroVec(w, 0); e.gyro.emit(v.x, v.y); }
      e.sensor.emit(quatForYawOut(moved));
      const s = e.update(FRAME);
      if (Math.abs(s.x) > Math.abs(peak)) peak = s.x;
      last = s.x;
    }
    const rel = (e._fInit ? e._fYaw : e.lastYaw) - e.yaw0;
    return { peak: peak, last: last, rel: rel, eaten: A - Math.abs(rel), warm: e.warming };
  }
  const pct = v => Math.abs(v) / EXPECT * 100;

  globalThis.Gyroscope = FakeGyro;
  const base = turnRun(2000, 25, true);            // 对照组：预热早已跑完
  check('L1 对照组（静止 2s 后转头）：幅度达成 ≥85%',
    pct(base.last) >= 85, pct(base.last).toFixed(0) + '% = ' + base.last.toFixed(0) + 'px');

  const b = turnRun(80, 25, true);
  check('L2 【核心】一进选择态就转头：幅度达成 ≥85%（修复前仅 12%）',
    pct(b.last) >= 85, pct(b.last).toFixed(0) + '% = ' + b.last.toFixed(0) + 'px');
  check('L3 同上：基线吃掉的量 < 1°（修复前吃掉 20.3°）',
    Math.abs(b.eaten) < 1, 'eaten=' + b.eaten.toFixed(2) + '°');

  const c = turnRun(80, 12, true);
  check('L4 慢速大幅 12°/s：幅度达成 ≥80%（修复前 55%）',
    pct(c.last) >= 80, pct(c.last).toFixed(0) + '% = ' + c.last.toFixed(0) + 'px');

  const d = turnRun(80, 60, true);
  check('L5 快速 60°/s：稳态不回零（修复前稳态 0px —— 被追赶全部追回）',
    pct(d.last) >= 85, pct(d.last).toFixed(0) + '% = ' + d.last.toFixed(0) + 'px');
  check('L6 转头结束后 warming 已关闭 ⇒ 陀螺接管（不会退回 v1.53 跟手性）',
    d.warm === false, 'warming=' + d.warm);

  /* 无 Gyroscope 的旧设备：门控退化为绝对姿态差分速率，仍须保住大部分幅度 */
  globalThis.Gyroscope = undefined;
  const e1 = turnRun(80, 25, false);
  check('L7 无陀螺降级路径：幅度达成 ≥75%（修复前 12%）',
    pct(e1.last) >= 75, pct(e1.last).toFixed(0) + '% = ' + e1.last.toFixed(0) + 'px');
  const e2 = turnRun(80, 12, false);
  check('L8 无陀螺 + 慢速 12°/s：幅度达成 ≥75%',
    pct(e2.last) >= 75, pct(e2.last).toFixed(0) + '% = ' + e2.last.toFixed(0) + 'px');
  globalThis.Gyroscope = FakeGyro;

  /* 反向保障：静止进选择态时追赶仍须全速（门控不得误伤漂移吸收） */
  const s1 = turnRun(80, 0, true, 0);      // 幅度 0 ⇒ 全程静止
  check('L9 全程静止：无输出（门控未误伤，追赶照旧吸收）',
    Math.abs(s1.last) < 1, 'x=' + s1.last.toFixed(2) + 'px');
}

/* ═══════════ M 组：长时间静止 + 融合慢漂（v1.58 漂移解耦） ═══════════
 * 真机现象：刚开机正常，"用一会（1 分钟）或玩一两个游戏之后"主页进选择态
 * 又开始漂；游戏里不动时画面自发缓慢滑动。
 * 根因：**绝对姿态自身会慢漂**（AHRS 融合误差随时间累积），而基准回中
 * 无法区分"融合在漂"和"你在转头" —— v1.54 用"降速回中"折中，掉进双稳态
 * 陷阱（rel 一旦爬出 1.5×死区 就切到 0.1°/s，再也收不回来）；选择态
 * frozen 更彻底，慢漂 100% 变成输出。v1.58 用陀螺把 Δfuse 拆成
 * 「用户头动」与「融合漂移」两笔账，基准只跟随后者。 */
console.log('\n【M 组：融合慢漂 · 静止 60s（v1.58 漂移解耦）】');
{
  globalThis.Gyroscope = FakeGyro;      // E13 的对照组把它置空后未恢复
  const DEAD = HEAD.deadDeg, BIAS = 3;  // 陀螺零偏 3°/s（yaw 通道）

  /* 头部完全不动，绝对姿态以 driftDeg °/s 单向慢漂 */
  function driftRun(driftDeg, frozen, secs) {
    const e = new InputEngine({ sensitivity: 'standard' });
    e.start();
    e.freezeDrift(frozen);
    const n = Math.round(secs * 1000 / FRAME);
    let peak = 0;
    for (let i = 0; i < n; i++) {
      VNOW += FRAME;
      const v = gyroVec(BIAS, 0);
      if (e.gyro) e.gyro.emit(v.x, v.y);
      e.sensor.emit(quatForYawOut(driftDeg * i * FRAME / 1000));
      const s = e.update(FRAME);
      if (Math.abs(s.x) > Math.abs(peak)) peak = s.x;
    }
    return { peak: peak, rel: e._fYaw - e.yaw0, eng: e };
  }
  for (const dr of [0.3, 1.0, 2.0]) {
    for (const fz of [true, false]) {
      const tag = 'M·慢漂' + dr + '°/s·' + (fz ? '选择态' : '游戏态');
      const r = driftRun(dr, fz, 60);
      check(tag + ' 静止 60s：|rel| 仍落进死区（v1.57 会漂到 18°+）',
        Math.abs(r.rel) < DEAD, 'rel=' + r.rel.toFixed(3) + '° 死区=' + DEAD);
      check(tag + ' 静止 60s：像素输出恒为 0（画面纹丝不动）',
        Math.abs(r.peak) < 0.01, 'peak=' + r.peak.toFixed(2) + 'px');
    }
  }

  /* 慢漂**叠加**主动转头：解耦不得把转头量当成漂吸收掉 */
  function driftTurn(driftDeg, turnDeg, rate) {
    const e = new InputEngine({ sensitivity: 'standard' });
    e.start(); e.freezeDrift(true);
    let t = 0, abs = 0;
    const feed = (w, a) => {
      const v = gyroVec(w, 0);
      if (e.gyro) e.gyro.emit(v.x, v.y);
      e.sensor.emit(quatForYawOut(a));
      e.update(FRAME);
    };
    for (let i = 0; i < Math.round(2000 / FRAME); i++) {   // 静止 2s（慢漂累积）
      VNOW += FRAME; t += FRAME; abs = driftDeg * t / 1000;
      feed(BIAS, abs);
    }
    const abs0 = abs, dur = turnDeg / rate * 1000, t0 = t;
    for (let i = 0; i < Math.ceil(dur / FRAME) + 1; i++) {  // 转头
      VNOW += FRAME; t += FRAME;
      const moved = Math.min(turnDeg, rate * (t - t0) / 1000);
      feed(BIAS + rate, abs0 + moved + driftDeg * (t - t0) / 1000);
    }
    const t1 = t, abs1 = abs0 + turnDeg + driftDeg * (t1 - t0) / 1000;
    for (let i = 0; i < Math.round(1500 / FRAME); i++) {    // 转完静止 1.5s
      VNOW += FRAME; t += FRAME;
      feed(BIAS, abs1 + driftDeg * (t - t1) / 1000);
    }
    return e._fYaw - e.yaw0;
  }
  const dt1 = driftTurn(1.0, 20, 25);
  check('M7 慢漂 1°/s 下转头 20°：幅度仍保留 ≥85%（解耦不吃转头）',
    Math.abs(dt1) >= 20 * 0.85, 'rel=' + dt1.toFixed(2) + '° / 20°');
  const dt2 = driftTurn(1.0, 20, 12);
  check('M8 慢漂 1°/s 下慢速转头 12°/s：幅度仍保留 ≥80%',
    Math.abs(dt2) >= 20 * 0.80, 'rel=' + dt2.toFixed(2) + '° / 20°');

  /* 零偏估计：静止 8s 后应收敛到真值 */
  {
    const e = new InputEngine({ sensitivity: 'standard' });
    e.start(); e.freezeDrift(true);
    for (let i = 0; i < Math.round(8000 / FRAME); i++) {
      VNOW += FRAME;
      const v = gyroVec(BIAS, 0);
      if (e.gyro) e.gyro.emit(v.x, v.y);
      e.sensor.emit(quatForYawOut(0));
      e.update(FRAME);
    }
    check('M9 陀螺零偏估计收敛到真值 ±0.5°/s（解耦的前提）',
      Math.abs(e._biasY - BIAS) < 0.5, 'biasY=' + e._biasY.toFixed(3) + ' 真值=' + BIAS);
    check('M10 零偏收敛后解耦确实在跑（积分每帧被消费，不堆积）',
      e._gIntMs === 0 && e._biasMs > 0, 'gIntMs=' + e._gIntMs + ' biasMs=' + e._biasMs);
  }

  /* 跨会话累积：_armAcc 是"净同向时长"累加器，必须随 start() 清零 */
  {
    const e = new InputEngine({ sensitivity: 'standard' });
    e.start(); e._armAcc = 200; e.stop(); e.start();
    check('M11 start() 会清零 _armAcc（跨会话累积会让准入判定失真）',
      e._armAcc === 0, '_armAcc=' + e._armAcc);
  }

  /* 无陀螺退化路径：解耦用不了，兜底的 driftRest 必须压住慢漂 */
  {
    const Saved = globalThis.Gyroscope;
    globalThis.Gyroscope = undefined;
    const e = new InputEngine({ sensitivity: 'standard' });
    e.start(); e.freezeDrift(true);
    let peak = 0;
    for (let i = 0; i < Math.round(60000 / FRAME); i++) {
      VNOW += FRAME;
      e.sensor.emit(quatForYawOut(1.0 * i * FRAME / 1000));
      const s = e.update(FRAME);
      if (Math.abs(s.x) > Math.abs(peak)) peak = s.x;
    }
    const rel = e.lastYaw - e.yaw0;
    check('M12 无陀螺（旧设备）慢漂 1°/s 静止 60s：rel 仍被压在分界内（不失控）',
      Math.abs(rel) < DEAD * HEAD.driftBand,
      'rel=' + rel.toFixed(2) + '° 分界=' + (DEAD * HEAD.driftBand).toFixed(2) + '°');
    globalThis.Gyroscope = Saved;
  }
}

/* ═══════════════ 结论 ═══════════════ */
Date.now = REAL_NOW;
console.log('');
console.log('=== harness-imu-latency：' + pass + ' 通过 / ' + fail + ' 失败 / 共 ' + (pass + fail) + ' 项 ===');
if (fails.length) {
  console.log('--- 失败明细 ---');
  for (let i = 0; i < fails.length; i++) console.log('  ✗ ' + fails[i]);
}
console.log('================================================================');
process.exit(fail ? 1 : 0);
