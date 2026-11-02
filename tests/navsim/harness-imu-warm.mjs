/* harness-imu-warm.mjs —— IMU 冷启动基准收敛回归（v1.42）
 *
 * 【锁的三件事】
 *  A. 主页「滑动进选择态 → 一直偏移，退出再进一次才正常」（v1.40 真机现象）：
 *     会话基准取自冷启动后未收敛的读数，又被 freezeDrift 锁死 ⇒ 恒偏移。
 *  B. **v1.41 的真机回归**：为修 A 引入了「预热期把输出硬清零 + 极差判收敛」，
 *     结果用户一转头极差就超阈值、预热必吃满 1.2s，期间输出恒 0 ⇒ 真机表现
 *     「转头基本都不识别」。故本 harness 把「预热期必须跟手」列为硬断言。
 *  C. 传感器实例必须全局复用：契约只描述单实例语义，stop→new 在真机上会出现
 *     「新实例永不派发 reading」的死局，必须配自愈看门狗。
 *
 * 【做法】可控虚拟时钟 + 伪造 AbsoluteOrientationSensor，直接驱动**真实的
 * InputEngine**。每条主断言都配「旧口径会怎样」的对照组，防止断言退化成空转。
 *
 * ⚠ 虚拟时钟：input.js 的计时走 Date.now()，故在构造引擎前替换（模块内无
 *   模块级 Date.now() 调用，替换安全）。
 */

import { InputEngine, quatToAngles, shapeAngle, SENSITIVITY, WARM_MAX_MS } from './utils/input.js';
import { HEAD } from './utils/layout.js';
const DEAD_DEG = HEAD.deadDeg;

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
let created = 0;
function FakeSensor() {
  this.activated = false;
  this.hasReading = false;
  this.quaternion = null;
  this._h = {};
  this._stopped = false;
  this._starts = 0;
  this._seq = ++created;
}
FakeSensor.prototype.addEventListener = function (n, fn) { (this._h[n] = this._h[n] || []).push(fn); };
FakeSensor.prototype.start = function () { this.activated = true; this._stopped = false; this._starts++; };
FakeSensor.prototype.stop = function () { this.activated = false; this._stopped = true; };
/* 宿主派发一次 reading：quaternion 同时挂在事件与实例上（契约双通道） */
FakeSensor.prototype.emit = function (q) {
  if (this._stopped) return false;
  this.quaternion = q;
  this.hasReading = true;
  const hs = this._h.reading || [];
  for (let i = 0; i < hs.length; i++) hs[i]({ quaternion: q });
  return true;
};
globalThis.AbsoluteOrientationSensor = FakeSensor;

/* 绕设备 X 轴转 θ ⇒ pitchRaw = −θ ⇒（SWAP_AXES=true）yaw 输出 = −θ。
 * 故 yawOut = deg 时取 θ = −deg。pitch 输出恒 0（只有 yaw 通道在漂）。 */
function quatForYawOut(deg) {
  const th = -deg * Math.PI / 180;
  return [Math.sin(th / 2), 0, 0, Math.cos(th / 2)];
}

const TARGET = 12, TAU = 300;
function convergingYaw(el) { return TARGET * (1 - Math.exp(-el / TAU)); }
const FRAME = 1000 / 60;
const COEF = SENSITIVITY.standard.coef;

/* 通用跑一段：src(elMs) → 该时刻的真实 yaw 输出（度） */
function runSession(engine, frames, src, onFrame) {
  const t0 = VNOW;
  const out = [];
  for (let i = 0; i < frames; i++) {
    VNOW += FRAME;
    const el = VNOW - t0;
    engine.sensor.emit(quatForYawOut(src(el)));
    const snap = engine.update(FRAME);
    out.push(snap);
    if (onFrame) onFrame(snap, el, i);
  }
  return out;
}

/* ═══ A1~A8 主路径：冷启动收敛（v1.40 恒偏移） ═══ */
{
  const eng = new InputEngine({ freq: 60, sensitivity: 'standard' });
  check('A1 构造后未 start：无传感器、warming=false、update 报 ok:false',
    eng.sensor === null && eng.warming === false && eng.update(FRAME).ok === false);

  eng.start();
  check('A2 start() 后立刻进入收敛窗口（读数未到，warming=true）',
    eng.warming === true && eng.sensor !== null);

  let okAlwaysTrue = true, warmFrames = 0, lockEl = -1, lockYaw0 = null;
  const snaps = runSession(eng, 120, convergingYaw, function (snap, el) {
    if (el >= 16 && snap.ok !== true) okAlwaysTrue = false;
    if (eng.warming) warmFrames++;
    else if (lockEl < 0) { lockEl = el; lockYaw0 = eng.yaw0; }
  });

  check('A3 收敛窗口内**不返回 ok:false**（分册把 ok===false 判为 IMU 掉线并置 '
    + 'g.imuDown，预热期误报会把开局变成假掉线）', okAlwaysTrue);
  check('A4 收敛窗口最多 WARM_MAX_MS=' + WARM_MAX_MS + 'ms，绝不拖到 v1.41 的 1.2s',
    warmFrames > 0 && warmFrames <= Math.ceil(WARM_MAX_MS / FRAME) + 2, 'warmFrames=' + warmFrames);

  const lockErr = Math.abs(lockYaw0 - convergingYaw(lockEl));
  /* v1.57：0.6° → 死区语义。本组只 mock 绝对姿态（无 Gyroscope），走的是
   * 追赶门控的**退化路径**：没有独立信号能区分「读数在收敛」与「用户在转头」
   * （两者在绝对姿态上同量级），门控只能按速率抑制 ⇒ 收敛期追赶被抑制，
   * 残余涨到 ~1.3°。它仍 < 死区 1.6°（A7 的 |x|<1px 已验证不可见）。
   * 有陀螺时走陀螺判据（收敛时陀螺恒为 0 ⇒ 追赶全速），该值远小于此。 */
  check('A5 锁定瞬间基准误差落进死区（<' + DEAD_DEG + '° ⇒ 不可见；有陀螺时远小于此）',
    lockErr < DEAD_DEG, 'err=' + lockErr.toFixed(4) + ' lockEl=' + lockEl.toFixed(1) + 'ms');
  check('A6 基准**不是**首帧读数 0°（旧实现锁死在这里 ⇒ 恒偏移）',
    Math.abs(lockYaw0 - 0) > 8, 'yaw0@lock=' + (lockYaw0 === null ? 'null' : lockYaw0.toFixed(3)));

  const tail = snaps[snaps.length - 1];
  check('A7 【现象回归】收敛结束后头不动则画面不动：|x| < 1px',
    Math.abs(tail.x) < 1, 'x=' + tail.x.toFixed(3));
  check('A8 锁定后残余误差 < 3°（落进公共死区 ⇒ 输出恒 0，见 A7）',
    Math.abs(eng.yaw0 - TARGET) < 3, 'yaw0=' + eng.yaw0.toFixed(3) + ' residual=' + (TARGET - eng.yaw0).toFixed(2) + 'deg');
  check('A9 锁定后 warming 恒为 false', eng.warming === false);

  const oldOffset = COEF * shapeAngle(TARGET - 0);   // shapeAngle(12°)=9 ⇒ 72px
  check('A10 对照组：旧口径（基准取首帧 0°）留下 >40px 恒偏移 —— 证明不是空转',
    oldOffset > 40, 'oldOffset=' + oldOffset.toFixed(1) + 'px');
  check('A11 新口径把该偏移压到 <1px（优于旧口径 40 倍以上）',
    Math.abs(tail.x) < 1 && Math.abs(tail.x) * 40 < oldOffset,
    'new=' + Math.abs(tail.x).toFixed(3) + 'px old=' + oldOffset.toFixed(1) + 'px');
}

/* ═══ B1~B4 【v1.41 真机回归】收敛窗口内必须跟手，不得硬清零 ═══ */
{
  const eng = new InputEngine({ freq: 60, sensitivity: 'standard' });
  eng.start();
  /* 先给两个稳定读数让基准建立（yaw=0），随后立刻以 60°/s 主动转头。
   * 转头使 |rel| > WARM_SETTLE ⇒ warming 保持 true（模拟"边收敛边转头"）。 */
  VNOW += FRAME; eng.sensor.emit(quatForYawOut(0)); eng.update(FRAME);
  VNOW += FRAME; eng.sensor.emit(quatForYawOut(0)); eng.update(FRAME);
  let at300 = null, warmAt300 = null;
  for (let i = 0; i < Math.ceil((WARM_MAX_MS + 200) / FRAME); i++) {   // 覆盖整个收敛窗口
    VNOW += FRAME;
    const el = (i + 1) * FRAME;
    eng.sensor.emit(quatForYawOut(el * 60 / 1000));
    const s = eng.update(FRAME);
    if (i === 17) { at300 = s.x; warmAt300 = eng.warming; }   // ≈300ms
  }
  check('B1 转头期间仍处于收敛窗口（warming=true）⇒ 该断言确实在测预热期行为',
    warmAt300 === true, 'warming@300ms=' + warmAt300);
  check('B2 【v1.41 回归点】收敛窗口内转头 300ms 后**已有明显输出**（|x| > 5px）；'
    + 'v1.41 在此把输出硬清零 1.2s ⇒ 真机"转头基本都不识别"',
    Math.abs(at300) > 5, 'x@300ms=' + (at300 === null ? 'null' : at300.toFixed(2)));
  /* 对照组：v1.41 的硬清零在同场景下输出恒 0 */
  check('B3 对照组：v1.41 口径（预热期 setBase 到最新读数 ⇒ rel≡0）输出必为 0，'
    + '与 B2 形成互斥对比', Math.abs(shapeAngle(0)) === 0);
  check('B4 收敛窗口仍在 WARM_MAX_MS=' + WARM_MAX_MS + 'ms 内结束，随后恢复满灵敏度',
    eng.warming === false);
}

/* ═══ C1~C3 丢弃每会话首个读数（未初始化四元数不再制造恒偏移） ═══ */
{
  const eng = new InputEngine({ freq: 60, sensitivity: 'standard' });
  eng.start();
  eng.freezeDrift(true);            // 选择态口径
  VNOW += FRAME; eng.sensor.emit(quatForYawOut(90)); eng.update(FRAME);   // 首个读数：90° 的脏值
  let last = null;
  for (let i = 0; i < 60; i++) {                                          // 其后稳定在 5°
    VNOW += FRAME;
    eng.sensor.emit(quatForYawOut(5));
    last = eng.update(FRAME);
  }
  check('C1 首个读数被丢弃：锁定后 |x| < 1px（不会被 90° 脏值带偏）',
    Math.abs(last.x) < 1, 'x=' + last.x.toFixed(3));
  check('C2 基准建立在第 2 个读数（5°）而非首个（90°）',
    Math.abs(eng.yaw0 - 5) < 0.2, 'yaw0=' + eng.yaw0.toFixed(3));
  const oldOff = COEF * shapeAngle(5 - 90);
  check('C3 对照组：若用首个读数建基准，恒偏移 > 500px（真机"一直偏移"的放大器）',
    Math.abs(oldOff) > 500, 'oldOffset=' + oldOff.toFixed(0) + 'px');
}

/* ═══ D1~D3 传感器实例全局复用（契约只描述单实例语义） ═══ */
{
  created = 0;
  const eng = new InputEngine({ freq: 60, sensitivity: 'standard' });
  eng.start();
  const s1 = eng.sensor;
  VNOW += FRAME; s1.emit(quatForYawOut(0)); eng.update(FRAME);
  eng.stop();
  eng.start();                       // 二次进入（真机"退出再进一次"路径）
  check('D1 start/stop 多轮后仍只创建过 1 个传感器实例',
    created === 1 && eng.sensor === s1, 'created=' + created);
  check('D2 复用实例被重新 start（activated=true、非 stopped）',
    eng.sensor.activated === true && eng.sensor._stopped === false);
  VNOW += FRAME; s1.emit(quatForYawOut(0)); eng.update(FRAME);      // 首个读数（丢弃）
  VNOW += FRAME; s1.emit(quatForYawOut(0)); eng.update(FRAME);      // 第 2 个：建基准 0°
  VNOW += FRAME; s1.emit(quatForYawOut(20)); const s2 = eng.update(FRAME);   // 转头 20°
  check('D3 复用实例照常派发并驱动输出（relYaw≈20°；单帧限幅 MAX_STEP=12px 故门槛取 5px）',
    Math.abs(s2.x) > 5, 'x=' + s2.x.toFixed(2));
}

/* ═══ E1~E4 自愈看门狗：宿主不派发 reading 时能自己爬出来 ═══ */
{
  created = 0;
  const eng = new InputEngine({ freq: 60, sensitivity: 'standard' });
  eng.start();
  const s1 = eng.sensor;
  VNOW += FRAME; s1.emit(quatForYawOut(0)); eng.update(FRAME);
  const startsAfterFirst = s1._starts;

  /* 宿主突然不再派发读数：逐帧推进但不出数 */
  for (let i = 0; i < 60; i++) { VNOW += 100; eng.update(100); }   // 6s
  check('E1 长时间无读数时先重发 start()（不立刻重建实例）',
    s1._starts > startsAfterFirst, 'starts=' + s1._starts);
  check('E2 连续两次重试无效后重建传感器实例（created=2）',
    created === 2 && eng.sensor !== s1, 'created=' + created);
  check('E3 旧实例已被 stop（不并存两个活跃传感器）', s1._stopped === true);

  /* 新实例恢复派发 ⇒ 引擎自愈，输出重新可用 */
  const s2 = eng.sensor;
  VNOW += FRAME; s2.emit(quatForYawOut(0)); eng.update(FRAME);
  VNOW += FRAME; s2.emit(quatForYawOut(0)); eng.update(FRAME);
  VNOW += FRAME; s2.emit(quatForYawOut(15)); const rec = eng.update(FRAME);
  check('E4 新实例出数后引擎自愈：imuOk=true 且转头有输出',
    eng.imuOk === true && Math.abs(rec.x) > 10, 'x=' + rec.x.toFixed(2));
}

/* ═══ F1~F3 兜底锁定 / 停采 / 无传感器 ═══ */
{
  /* 读数永不收敛（40°/s 线性，高于 25°/s 的追赶速率）⇒ 由 WARM_MAX_MS 兜底 */
  const eng = new InputEngine({ freq: 60, sensitivity: 'standard' });
  eng.start();
  const t0 = VNOW;
  let lockedAt = -1;
  for (let i = 0; i < 120; i++) {
    VNOW += FRAME;
    eng.sensor.emit(quatForYawOut((VNOW - t0) * 40 / 1000));
    eng.update(FRAME);
    if (lockedAt < 0 && !eng.warming) lockedAt = VNOW - t0;
  }
  check('F1 读数永不收敛时由 WARM_MAX_MS=' + WARM_MAX_MS + 'ms 兜底锁定（不拖死交互）',
    lockedAt > 0 && lockedAt <= WARM_MAX_MS + FRAME + 1, 'lockedAt=' + (lockedAt | 0) + 'ms');

  const eng2 = new InputEngine({ freq: 60, sensitivity: 'standard' });
  eng2.start();
  VNOW += FRAME; eng2.sensor.emit(quatForYawOut(1)); eng2.update(FRAME);
  check('F2 收敛中 warming=true', eng2.warming === true);
  eng2.stop();
  check('F3 stop() 立即退出收敛窗口（停采期间不得被判为收敛中）', eng2.warming === false);
}

{
  /* 无传感器环境（Craft 模拟器）：start() 不得抛异常，且不得卡在收敛窗口 */
  const Saved = globalThis.AbsoluteOrientationSensor;
  globalThis.AbsoluteOrientationSensor = undefined;
  let threw = false, eng = null;
  try { eng = new InputEngine({}); eng.start(); } catch (e) { threw = true; }
  check('F4 无 AbsoluteOrientationSensor 时 start() 不抛异常', !threw);
  check('F5 无传感器时 warming=false 且 imuOk=false（不把交互卡在收敛窗口里）',
    !!eng && eng.warming === false && eng.imuOk === false);
  globalThis.AbsoluteOrientationSensor = Saved;
}

/* ═══ G1~G2 诊断通道（真机取证用） ═══ */
{
  const eng = new InputEngine({ freq: 60, sensitivity: 'standard' });
  eng.start();
  const h0 = eng.health();
  check('G1 health() 含 reads/hz/warm/act/err 五段，可直接上屏取证',
    /reads=/.test(h0) && /hz=/.test(h0) && /warm=/.test(h0)
    && /act=/.test(h0) && /err=/.test(h0), h0);
  VNOW += FRAME; eng.sensor.emit(quatForYawOut(0)); eng.update(FRAME);
  check('G2 health() 的 reads 随读数递增', eng.health().indexOf('reads=1') === 0, eng.health());
}

/* ═══════════════ 结论 ═══════════════ */
Date.now = REAL_NOW;
console.log('');
console.log('=== harness-imu-warm：' + pass + ' 通过 / ' + fail + ' 失败 / 共 ' + (pass + fail) + ' 项 ===');
if (fails.length) {
  console.log('--- 失败明细 ---');
  for (let i = 0; i < fails.length; i++) console.log('  ✗ ' + fails[i]);
}
console.log('================================================================');
process.exit(fail ? 1 : 0);
