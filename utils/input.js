/* input.js —— 头控输入引擎（PRD-01 §05 七级流水线 + §06 校准）
 * 实机调参入口：SWAP_AXES（轴通道互换，实机实测已开）、
 * SIGN.yaw / SIGN.pitch（某方向整体反向时改符号）。
 *
 * 流水线（v1.54 · 交互 v1.23 重写响应段，调参一律走 layout.js 的 HEAD）：
 *   采样(绝对姿态 60Hz + 陀螺快通道) → 解算(四元数→视轴角 / 陀螺→角速度)
 *   → 互补融合(陀螺出动态、绝对姿态只管直流与漂移)
 *   → 死区(≤1.6°，软启动至 5°，边界值与斜率双连续)
 *   → 滤波(时间常数低通 45ms + 抖动抑制 + 角速度前馈)
 *   → 映射(coef px/°) → 限速(px/s，与帧率解耦) → 快照
 *
 * 【v1.54 为什么重写】v1.53 的「按帧」参数在低帧率下会自动放大延迟，且
 *   12px/帧 的限幅把相机全行程拖到 420ms —— 表现为「转头迟钝 / 跟不上」。
 *   现全部改为按时间量；并接入官方已确认的 Gyroscope（apis-device.md）
 *   做互补融合，把融合自身的 40~80ms 滞后从响应路径上拿掉。
 *   回归：tests/navsim/harness-imu-latency.mjs（阶跃响应硬门槛）。
 */

/* ─────────────── 方向语义（真机锚定，改前先读） ───────────────
 * 2026-09-04 真机实测（PRD-02 打砖块首次上真机）：
 *   **snap.x > 0  ⇔  头部向【左】转**（与"右为正"的直觉相反）
 *   snap.y 的符号约定**尚未做真机标定**——凡消费 pitch 的分册
 *   （接鸡蛋 / 滚球迷宫 / 导弹指挥部）落地前必须补测一次。
 *
 * 同一个 snap.x 有**两种相反且都正确**的消费语义，别互相抄：
 *
 *   ① 反向补偿（主页八向环 / B2 二向菜单）→ 直接用 +snap.x
 *      头向左转 → 内容向右移 → 注视方向上的那一项滑进屏幕中心被点亮。
 *      主页与框架页菜单走这条，真机已验过多轮，勿动。
 *
 *   ② 直控跟随（挡板 / 光标跟手）→ 用 -snap.x
 *      头向左转 → 元素向左移，与头同向。PRD-02 打砖块走这条。
 *
 * ⚠ 陷阱：SWAP_AXES=true 时 yaw 输出源自 pitchRaw，因此改左右方向要动
 *   `SIGN.pitch` 而不是 `SIGN.yaw`（见 quatToAngles）。但**不要动 SIGN**——
 *   它同时作用于主页与菜单，改了会把已经验过的①一起反转。要反转只在本册
 *   乘 SEM_FOLLOW。
 * ──────────────────────────────────────────────────────────── */
import { HEAD } from './layout.js';

export const SIGN = { yaw: 1, pitch: 1 };

export const SEM_COMPENSATE = 1;   // ① 反向补偿：内容反着走（菜单选择）
export const SEM_FOLLOW = -1;      // ② 直控跟随：元素跟着头走（本册直控）

/* 轴通道互换（交互 v1.5，实机实测）：设备四元数轴系与标准假设差 90°——
 * 头部上下动被解算到 yaw 通道（画面左右）、头部左右动被解算到 pitch 通道
 * （画面上下），正好互换。SWAP_AXES=true 交换 yaw/pitch 输出通道；
 * 交换后语义：yaw 恒为水平通道（左右转头）、pitch 恒为垂直通道（抬头低头）。
 * 若交换后某方向整体反向，调 SIGN 对应符号。 */
export const SWAP_AXES = true;

/* 视轴：设备坐标系中"用户视线"所指的方向（AIUI 契约 quaternion 为 [x,y,z,w]）。
 * 默认 { x:0, y:0, z:1 }（视线沿设备 +Z，屏幕朝外标定）。 */
export const VIEW_AXIS = { x: 0, y: 0, z: 1 };

/* v1.54：响应调参**不再自留副本**，全部取自 layout.js 的 HEAD（唯一来源）。 */
const DEAD_DEG = HEAD.deadDeg, SOFT_DEG = HEAD.softDeg;
const JITTER_W = HEAD.jitterW, JITTER_A = HEAD.jitterA;
const DRIFT_ACTIVE = HEAD.driftActive, DRIFT_REST = HEAD.driftRest;
const DRIFT_BAND = HEAD.driftBand;
/* v1.58 漂移解耦常量 */
const DECOUPLE = HEAD.decouple, DRIFT_DEC = HEAD.driftDecouple;
const BIAS_STILL_W = HEAD.biasStillW, BIAS_MS = HEAD.biasMs, BIAS_MIN_MS = HEAD.biasMinMs;
const BIAS_WARM_MS = HEAD.biasWarmMs;
const BIAS_RES = HEAD.biasRes;
const STALE_MS = 3000;              // 读数过期阈值
/* 互补滤波校正时间常数：**自适应**（v1.55）。
 * 一阶互补滤波在恒定角速度偏差下的稳态解是
 *     稳态偏离 = 零偏(°/s) × τ(s)
 * 消费级 MEMS 陀螺零偏常在 1~5°/s，取固定 τ=2.5s ⇒ 稳态偏离 2.5~12.5°
 * ⇒ 画面恒漂 20~100px。真机现象就是「进选择态后头没动、画面却自己上下飘」。
 * 解法：τ 随角速度自适应 —— 静止时 τ=0.3s（稳态偏离压到 0.3×bias ≤1.5°，
 * 落进 1.6° 死区，肉眼完全看不到），运动时回到 2.5s 保住陀螺的相位领先。
 * 两档之间线性插值，避免 τ 突变让画面抖。 */
export function fuseTau(w) {
  const a = Math.abs(w);
  if (a <= HEAD.fuseRestW) return HEAD.fuseRestMs;
  if (a >= HEAD.fuseMovW) return HEAD.fuseMs;
  const u = (a - HEAD.fuseRestW) / (HEAD.fuseMovW - HEAD.fuseRestW);
  return HEAD.fuseRestMs + (HEAD.fuseMs - HEAD.fuseRestMs) * u;
}
const GYRO_MAX_DIV = HEAD.gyroMaxDiv;
const GYRO_SAT_MS = HEAD.gyroSatMs;
const GYRO_NEAR = HEAD.gyroNear;      // v1.56 饱和判据：偏离 ≥ 上限×此值 即计入饱和
const FEED_S = HEAD.feedS, FEED_MAX = HEAD.feedMaxDeg;

/* 陀螺单位：W3C Generic Sensor 的 Gyroscope 为 **rad/s**（官方 apis-device.md
 * 未改写该语义，按标准取 rad/s）。若真机表现为「转头时画面幅度大一整档
 * （约 57 倍）」，把本开关置 false 即按 deg/s 解释。 */
const GYRO_RAD = true;
const GYRO_R2D = 180 / Math.PI;

/* 陀螺通道总开关（逃生口）：置 false 即回落到 v1.53 的纯绝对姿态口径，
 * 无需回滚代码。health() 会显示 gy=0/1/arm/bad 便于真机定性。 */
const GYRO_ENABLE = true;

/* 陀螺准入的**设备级**结论（模块单例，全 App 共用）：
 * 轴方向是设备属性，与页面无关。首次转头在任一页面完成 220ms 同向判定后，
 * 之后所有页面（每个页面各有自己的 InputEngine，都是冷启动）**开局即准入**，
 * 第一次转头就能吃到陀螺的领先，不必每次重新攒。
 * ⚠ 只持久化"已准入"，不持久化"已判定不可用"——后端本就永不积分（见
 *   _tryArm），重判一次的代价是每会话 ~220ms 内不使用陀螺，无副作用。 */
const GYRO_CAL = { armed: false };

/* ── v1.42 冷启动基准收敛（取代 v1.41 的「硬清零预热」） ────────────────
 * 官方契约（apis-device.md · AbsoluteOrientationSensor Behavior notes）：
 *   · fresh instance → activated=false / hasReading=false，quaternion 为 null；
 *   · 首个成功读数把二者翻 true（只保证"有读数"，**不保证已收敛**）；
 *   · stop() 把 activated 打回 false 但**保留上次读数缓存**；
 *   · frequency 只是 best-effort hint（真机实际采样率可能远低于 60）。
 *
 * v1.41 的教训（真机实测）：预热期内把输出**硬清零** + 用「窗口极差」判收敛
 * ⇒ 用户一转头极差就超阈值，预热必吃满上限 1.2s，期间输出恒 0。真机表现
 * 就是「转头基本都不识别」——比原来的恒偏移更糟。**预热绝不能牺牲跟手性。**
 *
 * v1.42 三原则：
 *   ① **限速追赶**（不是硬清零）：预热期把基线以 WARM_RATE(°/s) 向最新读数
 *      追。融合收敛（几 °/s）被完全吸收 ⇒ 恒偏移消失；主动转头（几十 °/s）
 *      超出追赶速率的部分**立刻**出现在输出里 ⇒ 全程跟手。
 *   ② **丢弃每会话首个读数**：契约里 quaternion 在首个成功读数前为 null，
 *      宿主可能先回吐一个未初始化值（单位四元数/全零），拿它建基准会造出
 *      几十度、且被 freezeDrift 锁死的恒偏移。
 *   ③ **传感器实例全局复用**：契约只描述单实例语义，start/stop 反复 new
 *      在真机上会出现「新实例永不派发 reading」⇒ 彻底失灵。改为只 new 一次。
 * 预热窗口 = 纯时间盒 WARM_MAX_MS（start 后固定时长，不做任何"是否收敛"的
 * 判据）。v1.41 用「窗口内极差 < 2°」判收敛，结果用户一转头极差就超阈值、
 * 预热必吃满上限，且会在"追上/没追上"之间反复横跳 —— 行为完全不可预测。
 * 时间盒 + 限速追赶的组合是确定的：融合收敛峰值约 40°/s 且**前重后轻**，
 * 30°/s 的追赶能从 ~90ms 起就完整吸收它，到 500ms 窗口结束时残余误差已落
 * 进公共 3° 死区（⇒ 输出恒 0，用户完全看不到偏移）。 */
/* ⚠ 500 → 900（v1.55）：500ms 是按**旧 3° 死区**定的——残余收敛误差 <3°
 * 时被死区整段吞掉，用户看不到。v1.54 把死区收到 1.6° 后，1.6~3° 这一段
 * 残余会直接显形为「刚进选择态画面就有几十 px 偏移」。
 * 延长预热**不损跟手性**：预热期是限速追赶（30°/s），主动转头超出部分立刻
 * 进输出；且用户刚进选择态（滑动手势）尚未开始头控，窗口内几乎无冲突。
 * ⚠ 红线（v1.41 事故）：预热只许**追赶**基准，绝不清零/削弱输出。 */
export const WARM_MAX_MS = 900;   // 预热窗口（到点无条件锁定，跟手性不受更久影响）
const WARM_RATE = 30;      // 预热期基线追赶速率（°/s）：高于收敛速率、低于转头速率
/* v1.57 追赶门控：见 _warmGain 的注释（幅度被追赶吃掉的实测数据在那儿） */
const WARM_G0 = HEAD.warmG0, WARM_G1 = HEAD.warmG1;
const WARM_LOCK_MS = HEAD.warmLockMs, WARM_HARD_MS = HEAD.warmHardMs;
const WARM_GYRO_STALE = 300;   // 陀螺读数超过此时长没来 ⇒ 门控退回绝对姿态差分
/* v1.55：预热窗口的**下限**——至少要攒够这么多个读数才允许收口。
 * 纯时间盒的漏洞：宿主 start() 后若读数迟到（真机 stop→start 之间存在
 * 不派发 reading 的窗口期，见看门狗注释），500ms 到点时可能一个读数都没到
 * ⇒ 预热空跑，基准直接建在第一个未收敛的读数上（v1.40 的恒偏移现象）。
 * ⚠ 只数**读数个数**，绝不判"是否收敛" —— v1.41 事故：任何依赖"用户不动"
 * 的判据都会与"用户正在操作"互斥，把转头判死。 */
export const WARM_MIN_READS = 6;
/* 自愈看门狗：运行期长时间收不到读数 → 重新 start()；连续两次无效则重建
 * 实例一次。真机出现过「stop() 后重建的实例永不派发 reading」，无这层兜底
 * 只能重启应用。 */
const RESTART_MS = 800;
export const CALIB_MS = 2000;       // 校准静息时长
export const CALIB_VAR_MAX = 1.2;   // 方差阈值（度²），实机可调

/* 灵敏度三档（F-Sys-08）：作用于 coef 与 RANGE */
export const SENSITIVITY = {
  low:      { factor: 0.75, coef: 6.0,  rangeYaw: 40, rangePitch: 26.7 },
  standard: { factor: 1.0,  coef: 8.0,  rangeYaw: 30, rangePitch: 20 },
  high:     { factor: 1.3,  coef: 10.4, rangeYaw: 23, rangePitch: 15.4 },
};

function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function wrapDeg(a) { return a - 360 * Math.round(a / 360); }

/* 硬死区（PRD-04 §4.3 的 deadzone）：|v| ≤ deg 归零，超出部分**减去**死区宽
 * 度再返回 —— 相减而非原样返回，是为了让死区边界两侧连续（否则一越过死区
 * 就跳一个 deg 的台阶，棘轮会误判成一次突然的推进）。 */
export function deadzone(v, deg) {
  const a = Math.abs(v);
  if (a <= deg) return 0;
  return v > 0 ? a - deg : -(a - deg);
}

/* 死区(≤1.6° 归零) → 软启动(1.6~5°) → 线性(>5°)
 *
 * 【v1.54 为什么改】旧曲线在死区边界是**硬跳**：|θ|=2.99° 输出 0、|θ|=3.01°
 * 输出 3°（≈24px），即「先纹丝不动，再啪一下窜出去」——这是"迟钝感"里最
 * 刺眼的一段；且 3~8° 的压扁段增益只有 0.4，中小幅度被压掉六成。
 * 新曲线 f(u)=2u²−u³（u=(a−d)/(S−d)）同时满足：
 *   f(0)=0、f'(0)=0（死区边界**值与斜率双连续**，无突跳）
 *   f(1)=1、f'(1)=1（与线性段 a−d 无缝衔接）
 * 净效果：≥5° 后比旧口径**更**灵敏（20°：18.4° vs 旧 17°），只是把边界
 * 那一下突跳抹平了。 */
export function shapeAngle(v) {
  const a = Math.abs(v);
  if (a <= DEAD_DEG) return 0;
  if (a >= SOFT_DEG) return v > 0 ? a - DEAD_DEG : -(a - DEAD_DEG);
  const span = SOFT_DEG - DEAD_DEG;
  const u = (a - DEAD_DEG) / span;
  const s = span * (2 * u * u - u * u * u);
  return v > 0 ? s : -s;
}

/* 视轴法：四元数 [x,y,z,w] 把 VIEW_AXIS 旋转到世界系，再取水平角/垂直角。
 * 相比欧拉 XYZ 分解：左右转头 → yaw（绕世界竖直轴）、抬头低头 → pitch
 * （绕世界水平轴）的映射与设备安装轴无关，且无万向锁、无 ±180° 跳变。
 * 实机调参只动 SWAP_AXES / SIGN，勿改此处数学。 */
export function quatToAngles(q) {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  const vx = VIEW_AXIS.x, vy = VIEW_AXIS.y, vz = VIEW_AXIS.z;
  /* v' = v + w·t + qv×t，其中 t = 2·(qv×v)（罗德里格斯旋转） */
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  const rx = vx + w * tx + (y * tz - z * ty);
  const ry = vy + w * ty + (z * tx - x * tz);
  const rz = vz + w * tz + (x * ty - y * tx);
  const yawRaw = Math.atan2(rx, rz) * 180 / Math.PI;
  const pitchRaw = Math.atan2(ry, Math.sqrt(rx * rx + rz * rz)) * 180 / Math.PI;
  /* 轴通道互换（v1.5）：设备轴系差 90°，交换输出通道使
   * yaw 恒为水平、pitch 恒为垂直；SIGN 语义保持不变 */
  if (SWAP_AXES) return { yaw: pitchRaw * SIGN.pitch, pitch: yawRaw * SIGN.yaw };
  return { yaw: yawRaw * SIGN.yaw, pitch: pitchRaw * SIGN.pitch };
}

/* 兼容旧名：内部解算已升级为视轴法 */
export function quatToEuler(q) { return quatToAngles(q); }

/* 陀螺角速度 → 视轴角速度（°/s），与 quatToAngles 共用同一套轴约定
 * （SWAP_AXES / SIGN），故**不需要重新标定轴方向**：
 *   绕设备 X 轴转 θ ⇒ pitchRaw = −θ；绕设备 Y 轴转 φ ⇒ yawRaw = +φ。
 *   SWAP_AXES=true 时 yaw 取自 pitchRaw ⇒ ωYaw = −ωx·SIGN.pitch；
 *   反之 yaw 取自 yawRaw ⇒ ωYaw = +ωy·SIGN.yaw（pitch 通道对称）。
 * ⚠ 这是小角近似：真实关系随当前俯仰略有变化（±30° 内误差 <15%），
 *   由互补滤波的绝对姿态校正持续吸收，不会累积。 */
export function gyroToRates(g) {
  if (!g) return { yaw: 0, pitch: 0 };
  const k = GYRO_RAD ? GYRO_R2D : 1;
  const wx = (g.x || 0) * k, wy = (g.y || 0) * k;
  if (SWAP_AXES) return { yaw: -wx * SIGN.pitch, pitch: wy * SIGN.yaw };
  return { yaw: wy * SIGN.yaw, pitch: -wx * SIGN.pitch };
}

/* 体感统计（F-Sys-07）：随 GameResult 输出六字段 */
export class MotionStats {
  constructor() { this.reset(); }
  reset() {
    this.frames = 0; this.moved = 0;
    this.yawSum = 0; this.pitchSum = 0;
    this.yawMax = 0; this.pitchMax = 0;
    this.tapCount = 0; this.tapLatSum = 0;
  }
  sample(yawDeg, pitchDeg, ox, oy, sens) {
    this.frames++;
    if (ox !== 0 || oy !== 0) this.moved++;
    this.yawSum += Math.min(1, Math.abs(yawDeg) / sens.rangeYaw);
    this.pitchSum += Math.min(1, Math.abs(pitchDeg) / sens.rangePitch);
    const ay = Math.abs(yawDeg), ap = Math.abs(pitchDeg);
    if (ay > this.yawMax) this.yawMax = ay;
    if (ap > this.pitchMax) this.pitchMax = ap;
  }
  tap(latencyMs) { this.tapCount++; this.tapLatSum += latencyMs || 0; }
  toMotion() {
    return {
      yawUtil: this.frames ? this.yawSum / this.frames : 0,
      pitchUtil: this.frames ? this.pitchSum / this.frames : 0,
      yawAmpDeg: Math.round(this.yawMax * 10) / 10,
      pitchAmpDeg: Math.round(this.pitchMax * 10) / 10,
      tapCount: this.tapCount,
      tapLatencyMs: this.tapCount ? Math.round(this.tapLatSum / this.tapCount) : 0,
    };
  }
}

/* 输入引擎：传感器订阅 + 七级流水线 + 两级基准 */
export class InputEngine {
  constructor(opts) {
    const o = opts || {};
    this.freq = o.freq || 60;
    this.sens = SENSITIVITY[o.sensitivity] || SENSITIVITY.standard;
    this.sensor = null;
    this._started = false;
    this._err = false;
    this.lastYaw = null; this.lastPitch = null; this.lastTs = 0;
    /* 会话基准：由本会话**第 2 个**读数建立（首读数可能是未初始化值，见
     * _onReading），再经预热期限速追赶吃掉残余收敛误差；无需用户静息。 */
    this.yaw0 = null; this.pitch0 = null;
    this._prevRawYaw = null; this._prevRawPitch = null;
    /* 增量角度通道（PRD-04 §4.3 · 滚球迷宫专用）：低通后的**原始**相对偏角
     * （度）。与 outX/outY 并行维护且互不干扰 —— 后者是给直控型分册准备的
     * 像素位移，已套公共 3° 死区与 coef 缩放，不能被增量位移型复用。 */
    this.relYaw = 0; this.relPitch = 0;
    this.frozen = false;                         // 漂移纠正冻结（选择/点亮/暂停）
    this.outX = 0; this.outY = 0;               // 低通后角度
    this._px = 0; this._py = 0;                 // 限速后像素
    /* v1.54 融合角：陀螺出动态、绝对姿态出直流。无陀螺时恒等于绝对姿态，
     * 行为与 v1.53 逐帧一致（见 _onReading）。 */
    this._fInit = false; this._fYaw = 0; this._fPitch = 0;
    this._prevAbsYaw = null; this._prevAbsPitch = null; this._absTs = 0;
    /* v1.54 角速度估计（只喂前馈，不进位置） */
    this._rateYaw = 0; this._ratePitch = 0; this._rateTs = 0;
    this._fps = 0;                               // 渲染节拍估计（诊断用）
    /* v1.54 陀螺快通道：实例复用 + 准入判定 + 偏离钳制（三重降级） */
    this.gyro = null; this._gyroOn = false; this._gyroArmed = false; this._gyroBad = false;
    this._gYaw = 0; this._gPitch = 0; this._gyroTs = 0; this._gyroReads = 0;
    this._armAcc = 0; this._satMs = 0;
    this.stats = new MotionStats();
    this._hasData = false;
    /* v1.42 预热状态：_warmAt=0 表示未处于预热（未 start 或已 stop） */
    this._warmAt = 0; this._warmN = 0;
    /* v1.57 追赶门控状态：_lock* 一旦置位，本会话该轴不再追赶；_mvAcc* 是
     * "持续头动"的累积时长（ms），达 WARM_LOCK_MS 即锁定。 */
    this._lockYaw = false; this._lockPitch = false;
    this._mvAccY = 0; this._mvAccP = 0;
    /* v1.58 漂移解耦：陀螺积分累计（两次 update 之间）+ 零偏估计 */
    this._gIntY = 0; this._gIntP = 0; this._gIntMs = 0;   // 本帧陀螺积分（度 / ms）
    this._biasY = 0; this._biasP = 0; this._biasMs = 0;   // 零偏 EMA 及其静止样本时长
    this._biasResY = 99; this._biasResP = 99;             // 零偏收敛度：|读数−估计| 的 EMA
    this._wAbsYaw = 0; this._wAbsPitch = 0;               // 绝对姿态差分速率（零偏的静止判据）
    this._pfYaw = null; this._pfPitch = null;             // 上一帧融合角（算 Δfuse）
    this._sessAt = 0;        // 本会话开始时刻
    this._reads = 0;         // 本会话读数计数（诊断用）
    this._retries = 0; this._retryAt = 0; this._recreated = false;  // 看门狗
  }

  /* v1.42：传感器实例**只创建一次**并全局复用（官方契约只描述单实例语义，
   * 反复 new + stop 在真机上会出现新实例永不派发 reading 的死局）。 */
  _ensureSensor() {
    if (this.sensor) return this.sensor;
    const Ctor = globalThis.AbsoluteOrientationSensor;
    if (!Ctor) { this._err = true; return null; }
    try {
      const s = new Ctor({ frequency: this.freq });
      const self = this;
      s.addEventListener('reading', function (e) { self._onReading(e); });
      s.addEventListener('error', function () { self._err = true; });
      this.sensor = s;
      return s;
    } catch (e) { this._err = true; return null; }
  }

  /* v1.54 陀螺实例：与绝对姿态**同一套**生命周期与复用规则（契约只描述单
   * 实例语义，反复 new + stop 会在真机上出现新实例永不派发 reading）。
   * 拿不到构造器 / 构造失败 ⇒ 静默回落纯绝对姿态口径（_gyroOn=false），
   * Craft 模拟器与旧真机包都不受影响。 */
  _ensureGyro() {
    if (!GYRO_ENABLE || this._gyroBad) return null;
    if (this.gyro) return this.gyro;
    const Ctor = globalThis.Gyroscope;
    if (!Ctor) return null;
    try {
      const s = new Ctor({ frequency: this.freq });
      const self = this;
      s.addEventListener('reading', function (e) { self._onGyro(e); });
      s.addEventListener('error', function () { self._gyroBad = true; self._gyroArmed = false; });
      this.gyro = s;
      this._gyroOn = true;
      this._gyroArmed = GYRO_CAL.armed;   // 设备级结论：后续页面开局即准入
      return s;
    } catch (e) { return null; }
  }

  /* 陀螺读数 → 积分进融合角；同时刷新角速度估计。
   * ⚠ 只在**已准入**后才积分：准入前融合角恒等于绝对姿态，故开启瞬间无跳变。 */
  _onGyro(e) {
    const g = (e && e.x !== undefined && e.x !== null) ? e : this.gyro;
    if (!g || g.x === undefined || g.x === null) return;
    const now = Date.now();
    const dtMs = clamp(now - (this._gyroTs || now - 16), 1, 100);
    this._gyroTs = now;
    const r = gyroToRates(g);
    this._gYaw = r.yaw; this._gPitch = r.pitch;
    /* ⚠ 未准入前不得喂速率：① 轴系尚未验证，喂进去就是把没验证的方向当
     *   真；② 未准入时 _onReading 也在用绝对姿态喂同一条通道，两边都喂会
     *   把角速度估成 2 倍（前馈直接翻倍）。准入后绝对姿态侧主动让位。 */
    if (this._gyroArmed && !this.warming) this._pushRate(r.yaw, r.pitch, dtMs);
    this._gyroReads++;
    /* 预热期不积分：见 _onReading 的 v1.56 注释（融合角须紧跟绝对姿态） */
    if (this._gyroArmed && this._fInit && !this.warming) {
      const dy = r.yaw * dtMs / 1000, dp = r.pitch * dtMs / 1000;
      this._fYaw = wrapDeg(this._fYaw + dy);
      this._fPitch = wrapDeg(this._fPitch + dp);
      this._gIntY += dy; this._gIntP += dp; this._gIntMs += dtMs;   // v1.58 解耦用
    }
    /* v1.58 零偏估计：**头部静止**时陀螺读数 ≈ 零偏。
     * 静止判据用**绝对姿态差分速率**（而不是陀螺自己）—— 陀螺读数里就有零偏，
     * 拿它判自己会永远判成"在动"。慢漂时绝对姿态差分也极小 ⇒ 正确地判为静止
     * ⇒ 零偏照样估得出来；主动转头时它很大 ⇒ 不污染估计。 */
    if (this._gyroArmed
      && Math.abs(this._wAbsYaw) < BIAS_STILL_W
      && Math.abs(this._wAbsPitch) < BIAS_STILL_W) {
      /* 预热期用快时间常数：解耦能吸收的只有"非用户分量"，零偏若没估准就
       * 会在开局把误差**永久**固化进 rel（rel 之后只由 user 驱动，不再回中）。
       * 实测：τ=2.5s 时预热 900ms 只收敛 40% ⇒ 零偏 3°/s 残留约 26px 且不再消退。 */
      /* 首次静止读数**直接作为初值**：EMA 从 0 起步要爬 τ×ln(bias/残差门)，
       * 3°/s 的零偏得爬 4s，这段时间慢漂照常累积且**永久**固化。取首个样本
       * 作初值后残差立刻 ≈0，预热期一结束就能启用解耦。 */
      if (this._biasMs === 0) {
        this._biasY = r.yaw; this._biasP = r.pitch;
        /* 残差初值 99 要靠 EMA 衰减到阈值以下（≈2s），期间解耦一直不启用、
         * 慢漂照常累积。首个样本同时把残差归零 —— 此时 bias 刚被赋成读数，
         * 残差本来就该是 0。 */
        this._biasResY = 0; this._biasResP = 0;
      }
      const ab = 1 - Math.exp(-dtMs / (this.warming ? BIAS_WARM_MS : BIAS_MS));
      this._biasY += (r.yaw - this._biasY) * ab;
      this._biasP += (r.pitch - this._biasP) * ab;
      /* 收敛度：估计值与当前读数的偏离。未收敛时它很大（零偏 3°/s、估计才
       * 0.7 ⇒ 残差 2.3），收敛后只剩噪声。**按时长启用是不够的** —— 时长只
       * 证明"采了多久"，不证明"估准了没有"。 */
      this._biasResY += (Math.abs(r.yaw - this._biasY) - this._biasResY) * ab;
      this._biasResP += (Math.abs(r.pitch - this._biasP) - this._biasResP) * ab;
      this._biasMs += dtMs;
    }
  }

  /* ── v1.58 漂移解耦 ─────────────────────────────────────────────────
   * 【问题】基准回中同时要满足两件事：吸收融合慢漂、又不碰用户转头的幅度。
   * 而**绝对姿态无法区分这两者**（慢漂与转头都表现为"读数在变"）。v1.54 用
   * "把回中速率降到 0.1°/s"来兼顾，结果掉进**双稳态陷阱**：
   *     rel < 1.5×死区 ⇒ 按 0.35°/s 回中（压得住 0.3°/s 慢漂）
   *     rel 一旦被顶过分界 ⇒ 切到 0.1°/s ⇒ 净漂移 0.5°/s，再也收不回来
   * dbg-cum 实测（慢漂 0.6°/s，跑 60s）：游戏态漂 **217px**，而且越用越明显
   * —— 这就是"刚开机正常、用一会之后才漂"的由来。选择态 frozen=true 更彻底：
   * 完全不纠正，慢漂 0.3°/s 跑 60s 就是 **136px**。
   *
   * 【解法】把融合角的变化拆成两笔账，基准只跟随**后者**：
   *     Δfuse = 用户头动（陀螺实测，扣零偏）  +  融合漂移（校正量 / 跳变）
   * 用户转头时第二项 ≈ 0 ⇒ 幅度完整保留；慢漂时第一项 = 0 ⇒ 全被吸收。
   * 两个诉求因此**同时**成立，不必在回中速率上做取舍。
   *
   * 【零偏】陀螺零偏会混进"用户头动"里（零偏 3°/s ⇒ rel 以 3°/s 增长），
   * 必须估计并扣除。静止判据用**绝对姿态差分速率**（见 _onGyro）：慢漂时它
   * 同样极小 ⇒ 判为静止 ⇒ 零偏照样估得出来；主动转头时它很大 ⇒ 不污染。
   *
   * 【降级】陀螺不可用 / 未准入 / 零偏样本不足 ⇒ 返回 false，回落到 rel 门控。 */
  _decDrift(dt, fYaw, fPitch, pfY, pfP) {
    if (!DECOUPLE || !this._gyroArmed || !this._gyroOn) return false;
    if (this._biasMs < BIAS_MIN_MS) {
      this._gIntY = 0; this._gIntP = 0; this._gIntMs = 0;   // 未启用：不堆积
      return false;
    }
    if (this._gIntMs <= 0) return false;
    /* 两轴都要估准：只准一轴就解耦，另一轴会把零偏残差整段吃进 rel */
    if (this._biasResY > BIAS_RES || this._biasResP > BIAS_RES) {
      this._gIntY = 0; this._gIntP = 0; this._gIntMs = 0;
      return false;
    }
    if (pfY === null || pfP === null) return false;
    const T = this._gIntMs / 1000;
    const userY = this._gIntY - this._biasY * T;      // 本帧用户造成的角度变化
    const userP = this._gIntP - this._biasP * T;
    this._gIntY = 0; this._gIntP = 0; this._gIntMs = 0;   // 用掉即清零
    const driftY = wrapDeg(fYaw - pfY) - userY;
    const driftP = wrapDeg(fPitch - pfP) - userP;
    /* 吸收限速：正常慢漂远低于此，限速只为防异常跳变把基准一把带跑 */
    const lim = DRIFT_DEC * dt;
    this.yaw0 = wrapDeg(this.yaw0 + clamp(driftY, -lim, lim));
    this.pitch0 = wrapDeg(this.pitch0 + clamp(driftP, -lim, lim));
    return true;
  }

  /* 角速度估计：任何一路读数都可以喂，按时间常数平滑（与帧率解耦）。
   * 只为前馈提供相位提前量，**不参与位置**，故噪声不会累积成漂移。 */
  _pushRate(wy, wp, dtMs) {
    const a = 1 - Math.exp(-clamp(dtMs, 1, 200) / HEAD.rateTauMs);
    this._rateYaw += (wy - this._rateYaw) * a;
    this._ratePitch += (wp - this._ratePitch) * a;
  }

  /* 陀螺准入（arming）：用**绝对姿态自己算出的角速度**给陀螺定方向。
   * 净同向 armMs ⇒ 准；净反向 armMs ⇒ 判定轴系标错，本会话永久关闭。
   * 目的：真机轴约定未经实测（SWAP_AXES 是四元数通道的实测结果，陀螺是另一
   * 路读数），宁可第一次转头不用陀螺，也不能把方向搞反了发出去。 */
  _tryArm(dtMs, wAbsYaw) {
    if (this._gyroArmed || !this._gyroOn || this._gyroBad) return;
    if (Math.abs(wAbsYaw) < HEAD.armAbsW || Math.abs(this._gYaw) < HEAD.armGyroW) return;
    this._armAcc += (this._gYaw * wAbsYaw > 0) ? clamp(dtMs, 1, 200) : -clamp(dtMs, 1, 200);
    if (this._armAcc >= HEAD.armMs) { this._gyroArmed = true; GYRO_CAL.armed = true; return; }
    if (this._armAcc <= -HEAD.armMs) { this._gyroBad = true; this._gyroArmed = false; }
  }

  /* 融合角对绝对姿态的偏离钳制：即使轴系判错也只错 GYRO_MAX_DIV 度，
   * 且持续顶到上限 GYRO_SAT_MS 就关掉陀螺并立刻回落到绝对姿态。 */
  _clampFuse(absYaw, absPitch, dtMs) {
    let sat = false;
    const dy = wrapDeg(this._fYaw - absYaw);
    if (dy > GYRO_MAX_DIV) { this._fYaw = wrapDeg(absYaw + GYRO_MAX_DIV); sat = true; }
    else if (dy < -GYRO_MAX_DIV) { this._fYaw = wrapDeg(absYaw - GYRO_MAX_DIV); sat = true; }
    const dp = wrapDeg(this._fPitch - absPitch);
    if (dp > GYRO_MAX_DIV) { this._fPitch = wrapDeg(absPitch + GYRO_MAX_DIV); sat = true; }
    else if (dp < -GYRO_MAX_DIV) { this._fPitch = wrapDeg(absPitch - GYRO_MAX_DIV); sat = true; }
    /* v1.56：饱和判据用"接近上限"而非"恰好顶到上限"。
     * 钳制是每帧硬夹到 ±GYRO_MAX_DIV，下一帧校正又会把它拉回一点 ⇒ 偏离
     * 在上限**下方振荡**（实测 11~15° 之间），"严格顶到"几乎从不成立，
     * 饱和计数器涨一下又减一下，自动关闭永远触发不了（旧代码形同虚设）。
     * 改判 >=85% 上限即计入饱和；正常场景偏离 < 1.6°，绝不会误伤。 */
    const near = Math.abs(dy) >= GYRO_MAX_DIV * GYRO_NEAR
      || Math.abs(dp) >= GYRO_MAX_DIV * GYRO_NEAR;
    if (sat || near) {
      this._satMs += clamp(dtMs, 1, 200);
      if (this._satMs >= GYRO_SAT_MS) {
        this._gyroBad = true; this._gyroArmed = false;
        this._fYaw = absYaw; this._fPitch = absPitch;
      }
    } else if (this._satMs > 0) {
      this._satMs = Math.max(0, this._satMs - clamp(dtMs, 1, 200) * 0.5);
    }
  }

  /* 开启一次新的采样会话：整体复位会话状态，复用已有传感器实例。
   * 注意 **不** stop 旧实例再新建 —— 见 _ensureSensor。 */
  start() {
    this._err = false;
    this._hasData = false;
    this.lastYaw = null; this.lastPitch = null; this.lastTs = 0;
    this.yaw0 = null; this.pitch0 = null;
    this._prevRawYaw = null; this._prevRawPitch = null;
    this.relYaw = 0; this.relPitch = 0;
    this.outX = 0; this.outY = 0; this._px = 0; this._py = 0;
    this.frozen = false;
    this._sessAt = Date.now(); this._warmAt = this._sessAt; this._warmN = 0;
    this._lockYaw = false; this._lockPitch = false; this._mvAccY = 0; this._mvAccP = 0;
    this._reads = 0;
    this._retries = 0; this._retryAt = 0; this._recreated = false;
    /* v1.54 融合/前馈会话态复位（陀螺**实例**保留，只清积分与速率） */
    this._fInit = false; this._fYaw = 0; this._fPitch = 0;
    this._prevAbsYaw = null; this._prevAbsPitch = null; this._absTs = 0;
    this._rateYaw = 0; this._ratePitch = 0; this._rateTs = 0;
    this._gyroTs = 0; this._gYaw = 0; this._gPitch = 0; this._satMs = 0;
    /* v1.58：_armAcc 必须清零 —— 它是"净同向时长"的累加器，跨会话残留会让
     * 新会话用上一次的样本量直接判定准入（或反过来迟迟无法准入），是典型
     * 的跨会话累积。_gyroBad 是设备级结论（轴系判错），跨会话保留才对。 */
    this._armAcc = 0;
    /* v1.58 漂移解耦会话态：零偏与积分累计一并作废（换会话 = 换基准） */
    this._gIntY = 0; this._gIntP = 0; this._gIntMs = 0;
    this._biasY = 0; this._biasP = 0; this._biasMs = 0;
    this._biasResY = 99; this._biasResP = 99;
    this._wAbsYaw = 0; this._wAbsPitch = 0;
    this._pfYaw = null; this._pfPitch = null;
    const s = this._ensureSensor();
    if (!s) { this._warmAt = 0; return; }
    try { s.start(); this._started = true; } catch (e) { this._err = true; }
    /* 陀螺随绝对姿态一起起停（同一会话语义）；失败不影响主通道 */
    const g = this._ensureGyro();
    if (g) { try { g.start(); } catch (e) { this._gyroOn = false; } }
  }

  stop() {
    if (this.sensor) { try { this.sensor.stop(); } catch (e) { /* 忽略 */ } }
    if (this.gyro) { try { this.gyro.stop(); } catch (e) { /* 忽略 */ } }
    this._started = false;
    this._warmAt = 0;   /* 停采即退出预热（下次 start 重新开始收敛） */
  }

  /* v1.58 页面销毁时**释放传感器实例**（onUnload 专用，运行期不得调用）。
   * 每个页面各有自己的 InputEngine ⇒ 各有自己的 AbsoluteOrientationSensor /
   * Gyroscope 实例（v1.42：契约只描述单实例语义）。若 onUnload 只 stop()，
   * 玩过的每个游戏都会留下一份实例句柄，真机上就表现为「刚开机正常、玩一
   * 两个游戏之后头控开始变迟钝 / 读数变脏」—— 这类劣化在 navsim 里测不到。
   * ⚠ 只在页面销毁时调用：v1.42 的坑是「stop→new 的实例不派发 reading」，
   *   那只在**同一实例复用**的路径上会踩到；页面都销毁了就不会再起采。
   *   即便被误调，_ensureSensor 也会重建一个，行为与首次一致，不会崩。 */
  dispose() {
    this.stop();
    this.sensor = null;
    this.gyro = null;
    this._gyroOn = false;
    this._started = false;
  }

  /* v1.42 自愈看门狗：已 start 却长时间收不到读数 ⇒ 先重发 start()；
   * 连续两次仍无读数 ⇒ 丢弃并重建传感器实例（仅一次，避免打转）。
   * 真机背景：宿主融合层在 stop→start 之间存在不派发 reading 的窗口期，
   * 表现就是「转头完全没反应」且无法自恢复，只能重启应用。 */
  _recreate() {
    if (this.sensor) { try { this.sensor.stop(); } catch (e) { /* 忽略 */ } }
    this.sensor = null;
    this._hasData = false;
    const s = this._ensureSensor();
    if (!s) return;
    try { s.start(); } catch (e) { this._err = true; }
    /* 重建后重新收敛基准：restart 预热窗口，避免用新实例的旧姿态建基准。
     * ⚠ v1.56：基准必须**一并作废**（置 null 让第 2 个读数重建）—— 新传感器
     * 实例会重新走一遍融合收敛，其输出与旧基准可能差几十度，而预热期追赶
     * 只有 30°/s（900ms 最多追 27°），追不完的部分就是一次「突然漂移」。 */
    this._warmAt = Date.now(); this._warmN = 0;
    this.yaw0 = null; this.pitch0 = null;
    /* 陀螺侧的积分同样作废：它的基准是绝对姿态，重建期间读数不可信 */
    this._fInit = false; this._satMs = 0;
  }

  _watchdog() {
    if (!this._started || this._err || !this.sensor) return;
    const now = Date.now();
    const since = now - (this.lastTs || this._sessAt || now);
    if (since < RESTART_MS) return;
    if (now - this._retryAt < RESTART_MS) return;
    this._retryAt = now;
    this._retries++;
    if (this._retries >= 2 && !this._recreated) {
      this._recreated = true;
      this._recreate();
      return;
    }
    try { this.sensor.start(); this._hasData = false; } catch (e) { /* 忽略 */ }
    /* 陀螺若也在静默（读数停止）⇒ 重发一次 start；它不参与 imuOk 判定 */
    if (this._gyroOn && this._gyroTs && now - this._gyroTs > RESTART_MS * 3) {
      try { this.gyro.start(); } catch (e) { /* 忽略 */ }
    }
  }

  /* v1.42：是否仍处于冷启动收敛窗口（基准正以 WARM_RATE 追赶最新读数）。
   * 纯时间盒，不含任何"是否已收敛"判据 —— 见 WARM_MAX_MS 处注释。
   * ⚠ 预热**不会**清零输出，只影响基线追赶速率，故不会拖死跟手性。 */
  get warming() {
    if (!this._warmAt) return false;
    if (this._warmN < WARM_MIN_READS) return true;   // v1.55：读数没攒够不算收敛
    return (Date.now() - this._warmAt) < WARM_MAX_MS;
  }

  /* ── v1.57 预热追赶门控 ─────────────────────────────────────────────
   * 【实测问题】v1.42 的限速追赶是**无差别**的：它把 rel 往 0 拉，既吸收
   * 融合收敛，也把用户的转头量一并吃掉。选择态 frozen=true 之后不再纠正
   * ⇒ 被吃掉的幅度**永久丢失**。dbg-amp 实测（转头 25°@25°/s，coef=8）：
   *     预热跑完再转头 → 188px（94%）      进选择态立刻转 → 25px（12%）
   *     慢速 12°/s → 109px（55%）          快速 60°/s   → 0px（全被追回）
   * 用户观感即"很大幅转头却只有很小移动"，且"有时正常"——取决于有没有撞上
   * 那 900ms 预热窗口（主页 _enterSelect 每次都 start()）。
   *
   * 【为什么必须用陀螺区分】绝对姿态**无法**区分「读数自己在收敛」与
   * 「用户在转头」：冷启动收敛的变化率可达 80°/s，与主动转头同量级；
   * 而"是否已收敛"的判据一旦依赖"用户不动"就与操作互斥（v1.41 红线）。
   * 陀螺测的是**真实头动**，读数自己收敛时它恒为 0 —— 唯一干净的区分信号。
   *
   * 【三重行为】
   *   头部静止（|ω| ≤ G0）      → 追赶全速，照旧吸收收敛与漂移
   *   中间段（G0 < |ω| < G1）   → 追赶按线性衰减，窗口同步慢速推进
   *   持续头动（|ω| ≥ G1 满 100ms）→ **锁定该轴基准**，本会话不再追赶
   * 陀螺拿不到时退化为绝对姿态差分速率，并用「追赶被抑制 ⇒ 窗口暂停推进」
   * 补偿，保证冷启动残差仍来得及吸收；WARM_HARD_MS 兜底防预热永不结束。 */
  _warmRate(ax) {
    /* 陀螺新鲜 ⇒ 用它（能区分真实头动；未准入时方向未验证，但门控只取绝对值） */
    if (this._gyroOn && (Date.now() - this._gyroTs) < WARM_GYRO_STALE) {
      return ax === 0 ? this._gYaw : this._gPitch;
    }
    return ax === 0 ? this._rateYaw : this._ratePitch;   // 退化：绝对姿态差分
  }

  _warmGain(ax) {
    if (ax === 0 ? this._lockYaw : this._lockPitch) return 0;
    const a = Math.abs(this._warmRate(ax));
    if (a <= WARM_G0) return 1;
    if (a >= WARM_G1) return 0;
    return 1 - (a - WARM_G0) / (WARM_G1 - WARM_G0);
  }

  /* 持续头动 ⇒ 锁定：转头结束后追赶若恢复，会把转头量慢慢拉回 0（实测
   * 60°/s 快转稳态回到 0px），故必须**终止**而不只是暂停。逐轴判定，
   * 只转 pitch 时不误伤 yaw 的收敛吸收。 */
  _warmLock(ms) {
    if (!this._gyroOn || (Date.now() - this._gyroTs) >= WARM_GYRO_STALE) return;
    const wY = Math.abs(this._gYaw), wP = Math.abs(this._gPitch);
    this._mvAccY = wY >= WARM_G1 ? this._mvAccY + ms : Math.max(0, this._mvAccY - ms * 0.5);
    this._mvAccP = wP >= WARM_G1 ? this._mvAccP + ms : Math.max(0, this._mvAccP - ms * 0.5);
    if (this._mvAccY >= WARM_LOCK_MS) this._lockYaw = true;
    if (this._mvAccP >= WARM_LOCK_MS) this._lockPitch = true;
    /* 锁定 ⇒ **结束预热**：warming 为 true 时陀螺不积分（v1.56），若只冻结
     * 窗口而不结束，用户转头期间陀螺会一直被挡在门外，跟手性退回 v1.53。
     * 基准已锁定，继续预热已无意义 —— 让陀螺立刻接管。 */
    if (this._lockYaw || this._lockPitch) this._warmAt = 0;
  }

  get running() { return this._started; }

  /* IMU 可用性：只认**自己收到的读数**及其新鲜度。
   * v1.42：不再依赖 sensor.activated / hasReading —— 契约里 stop() 会把它
   * 们打回 false 却保留读数缓存，用宿主标志位判定会把「其实在出数」的
   * 会话判成掉线；反之也可能用缓存值冒充新鲜数据。一律以 lastTs 为准。 */
  get imuOk() {
    if (this._err || !this.sensor || !this._hasData || !this.lastTs) return false;
    return (Date.now() - this.lastTs) < STALE_MS;
  }

  /* 诊断快照：真机定位「转头不识别」时直接读这一行即可定性。 */
  health() {
    const el = Math.max(1, Date.now() - (this._warmAt || this._sessAt || Date.now()));
    const sess = Math.max(1, Date.now() - (this._sessAt || Date.now()));
    return 'reads=' + this._reads
      + ' hz=' + Math.round(this._reads * 1000 / sess)
      + ' warm=' + (this.warming ? 1 : 0)
      + ' act=' + (this.sensor && this.sensor.activated ? 1 : 0)
      + ' err=' + (this._err ? 1 : 0)
      /* v1.54：fps=渲染节拍（宿主无定时器时它≈传感器频率，直接决定跟手性）；
       * gy=0 无陀螺 / 1 待准入 / arm 已接入 / bad 已判定不可用。真机"还是迟钝"
       * 时先看这两段：fps 过低是渲染问题，gy=1 迟迟不变 arm 说明轴系没对上。 */
      + ' fps=' + (this._fps ? Math.round(this._fps) : 0)
      + ' gy=' + (!this._gyroOn ? 0 : (this._gyroBad ? 'bad' : (this._gyroArmed ? 'arm' : 1)))
      + ' ms=' + Math.round(el);
  }

  _onReading(e) {
    const q = (e && e.quaternion) || (this.sensor && this.sensor.quaternion);
    if (!q || q.length < 4) return;
    const eu = quatToAngles(q);
    const now = Date.now();
    this.lastYaw = eu.yaw; this.lastPitch = eu.pitch;
    this.lastTs = now;

    /* ── v1.54 互补融合 ──────────────────────────────────────────
     * 绝对姿态自带 40~80ms 融合滞后（且 frequency 只是 hint，真机可能远低于
     * 60Hz），它是"迟钝"的第一环。陀螺零滞后但会漂，经典解是互补滤波：
     *   融合角 = 陀螺积分（动态）＋ 绝对姿态按 FUSE_MS 缓慢拉回（直流/漂移）
     * ⚠ FUSE_MS 必须**长**（2.5s）：一阶互补滤波在恒定角速度下的稳态解就是
     *   绝对姿态本身，校正越强、陀螺的领先被吃得越快；取 2.5s 才能在真实的
     *   转头时长内把融合滞后完整抵消（转头很少持续 2.5s 以上）。
     * 无陀螺 / 未准入 / 已判定不可用 ⇒ 融合角恒等于绝对姿态（与 v1.53 同口径）。 */
    const dtAbs = this._absTs ? clamp(now - this._absTs, 1, 200) : 0;
    if (dtAbs && this._prevAbsYaw !== null) {
      const sec = dtAbs / 1000;
      const wAbsYaw = wrapDeg(eu.yaw - this._prevAbsYaw) / sec;
      const wAbsPitch = wrapDeg(eu.pitch - this._prevAbsPitch) / sec;
      this._wAbsYaw = wAbsYaw; this._wAbsPitch = wAbsPitch;   // v1.58 零偏的静止判据
      /* 无陀螺 / 未准入 / **预热期**时，角速度只能由绝对姿态差分得到
       * （前馈的兜底来源）。预热期不采信陀螺角速度：它含零偏，会让抖动
       * 抑制判据（|ω|<6°/s）误判成"静止"而吞掉用户真实的慢速转头。 */
      if (this.warming || !this._gyroOn || !this._gyroArmed) this._pushRate(wAbsYaw, wAbsPitch, dtAbs);
      this._tryArm(dtAbs, wAbsYaw);
    }
    this._prevAbsYaw = eu.yaw; this._prevAbsPitch = eu.pitch; this._absTs = now;

    /* v1.56：预热期融合角**直接等于绝对姿态** —— 不积分陀螺、不做互补。
     * 【为什么】预热期唯一的任务是让会话基准追上真值。而带陀螺的融合角在
     * 冷启动收敛期会**滞后于**绝对姿态：一阶滞后对斜坡输入的稳态误差
     *   = τ × 变化率 = 0.3s × 收敛峰值 40°/s ≈ 12°
     * 预热一到点基准就冻在这段残差上，之后融合角把残差走完 ⇒ 全部变成
     * 可见偏移。实测：收口瞬间 rel 只有 −0.13°，2 秒后涨到 −1.49°（12px）
     * —— 这就是真机「一进选择态画面就自己飘、慢慢飘到位停住」的主因。
     * 【代价】预热期的跟手性回落到纯绝对姿态口径（= v1.53），仅 900ms；
     * 且预热期是限速追赶（30°/s），主动转头超出部分照样立刻进输出。
     * 【收益】预热结束时起点已与绝对姿态对齐，之后静止 τ=300ms 把陀螺
     * 零偏压在 0.63°（< 1.6° 死区）⇒ 全程不可见。 */
    if (!this._fInit || this.warming) {
      this._fYaw = eu.yaw; this._fPitch = eu.pitch; this._fInit = true;
    } else if (this._gyroOn && this._gyroArmed) {
      /* v1.55：τ **逐轴**自适应。逐轴而非取模的理由：转头时 yaw 在动、
       * pitch 静止 ⇒ pitch 该用短 τ 快速压住零偏，yaw 该用长 τ 保住领先。
       * 判据取平滑后的角速度估计（rateTauMs），抗单帧噪声；无陀螺时它由
       * 绝对姿态差分喂进来，同样可用。 */
      const tY = fuseTau(this._rateYaw), tP = fuseTau(this._ratePitch);
      const bY = dtAbs ? 1 - Math.exp(-dtAbs / tY) : 1;
      const bP = dtAbs ? 1 - Math.exp(-dtAbs / tP) : 1;
      this._fYaw = wrapDeg(this._fYaw + wrapDeg(eu.yaw - this._fYaw) * bY);
      this._fPitch = wrapDeg(this._fPitch + wrapDeg(eu.pitch - this._fPitch) * bP);
      this._clampFuse(eu.yaw, eu.pitch, dtAbs || 16);
    } else { this._fYaw = eu.yaw; this._fPitch = eu.pitch; }
    /* 会话基准：**跳过本会话首个读数** —— 契约里 quaternion 在首个成功读数
     * 前为 null，宿主可能先回吐未初始化值（单位四元数/全零/上次缓存），拿它
     * 建基准会造出几十度、且被 freezeDrift 锁死的恒偏移（v1.40 真机现象）。
     * 第 2 个读数起才建基准，配合预热期的限速追赶彻底吃掉残余收敛误差。 */
    if (this._warmN >= 1 && this.yaw0 === null) {
      this.yaw0 = this._fYaw; this.pitch0 = this._fPitch;   // 基准也走融合角
    }
    if (this._warmAt) this._warmN++;
    this._reads++;
    this._hasData = true;
    /* 宿主无定时器时的降级渲染时钟（见 utils/boot.js useSensorClock） */
    if (typeof this.onReading === 'function') {
      try { this.onReading(); } catch (err) { /* 渲染异常不影响采样 */ }
    }
  }

  setBase(yaw, pitch) { this.yaw0 = yaw; this.pitch0 = pitch; }
  /* 以**当前融合角**重建中位（v1.54：陀螺已准入时它是滤波后的姿态，比裸
   * 绝对姿态更贴近"头现在在哪"）。 */
  resetBase() {
    if (this.lastYaw === null) return;
    this.setBase(this._fInit ? this._fYaw : this.lastYaw,
      this._fInit ? this._fPitch : this.lastPitch);
  }
  freezeDrift(frozen) { this.frozen = !!frozen; }
  setSensitivity(key) { this.sens = SENSITIVITY[key] || this.sens; }

  /* 每帧推进：返回意图快照 { ok, x, y, rawYaw, rawPitch } */
  update(dtMs) {
    this._watchdog();
    if (!this.imuOk) { this.outX = 0; this.outY = 0; return { ok: false, x: 0, y: 0, rawYaw: 0, rawPitch: 0 }; }
    /* dt 一律先夹到 [1,100]ms：掉帧时既不补一大步，也不会让 dt=0 把滤波冻住 */
    const ms = clamp(dtMs || 33, 1, 100);
    const dt = ms / 1000;
    /* 【v1.42 冷启动收敛】预热期内把基线以 WARM_RATE 向最新读数**限速追赶**：
     * 融合收敛（几 °/s）被完全吸收 ⇒ 恒偏移消失；主动转头（几十 °/s）超出
     * 追赶速率的部分立刻进入 relYaw ⇒ 全程跟手。
     * ⚠ 绝不在此清零输出（v1.41 就是这么把「转头」判死 1.2s 的），也绝不
     *   返回 ok:false —— 游戏分册把 snap.ok===false 判为 IMU 掉线并置
     *   g.imuDown，预热期误报会把开局变成假掉线。 */
    const warm = this.warming;
    /* 相对角 wrap 到 ±180：防大幅转头跨 ±180° 边界时差值瞬间跳 360° */
    const hasBase = this.yaw0 !== null;
    /* v1.54：消费**融合角**（陀螺已准入 ⇒ 已抵消融合滞后；否则 = 绝对姿态） */
    const fYaw = this._fInit ? this._fYaw : this.lastYaw;
    const fPitch = this._fInit ? this._fPitch : this.lastPitch;
    const relYaw = hasBase ? wrapDeg(fYaw - this.yaw0) : 0;
    const relPitch = hasBase ? wrapDeg(fPitch - this.pitch0) : 0;
    /* v1.58：融合角的帧间增量（Δfuse）供漂移解耦使用。**每帧都要**更新，
     * 否则预热/解耦切换的那一帧会吃到累积多帧的巨大增量。 */
    const pfY = this._pfYaw, pfP = this._pfPitch;
    this._pfYaw = fYaw; this._pfPitch = fPitch;

    // 基线更新：预热期限速追赶 → 常态漂移纠正（选择/点亮/暂停冻结）
    if (!hasBase) {
      /* 尚未建基准（只收到 1 个读数）：本帧不产生位移，等第 2 个读数 */
    } else if (!warm && this._decDrift(dt, fYaw, fPitch, pfY, pfP)) {
      /* v1.58 漂移解耦已处理基准（不受 frozen 影响：它只吸收非用户分量） */
    } else if (warm) {
      /* v1.57：追赶速率按「头部是否在动」门控（详见 _warmGain 注释）。
       * 静止 ⇒ 行为与 v1.42 完全一致；转头 ⇒ 追赶让路，幅度完整保留。 */
      this._warmLock(ms);
      const gY = this._warmGain(0), gP = this._warmGain(1);
      const stepY = WARM_RATE * gY * dt, stepP = WARM_RATE * gP * dt;
      this.yaw0 = wrapDeg(this.yaw0 + clamp(relYaw, -stepY, stepY));
      this.pitch0 = wrapDeg(this.pitch0 + clamp(relPitch, -stepP, stepP));
      /* 追赶被抑制的时间**不计入**预热窗口（否则冷启动残差来不及吸收）。
       * ⚠ 只有**陀螺**判定的头动才冻结窗口：退化路径（无 Gyroscope）用的是
       * 绝对姿态差分，而冷启动收敛的变化率与转头同量级（可达 80°/s），拿它
       * 冻结窗口会让预热永不结束（v1.42 的纯时间盒语义被破坏）。无陀螺时
       * 窗口照常按墙钟推进，只让门控负责"不吃转头幅度"。 */
      if (this._gyroOn && (Date.now() - this._gyroTs) < WARM_GYRO_STALE) {
        this._warmAt += ms * (1 - Math.min(gY, gP));
        if (this._sessAt && (Date.now() - this._sessAt) > WARM_HARD_MS) this._warmAt = 0;
      }
    } else if (!this.frozen) {
      /* v1.54 两档漂移：旧口径恒为 0.5°/s ⇒ "保持转头"时画面以 4px/s 慢慢
       * 溜回中位（跟住了又松掉）。现明显偏离时几乎不回中（0.1°/s），
       * 只有停在死区附近才按 driftRest 吸收融合自身的慢漂。
       * v1.58：分界由 1.5×死区 放宽到 driftBand×死区 —— 旧分界太窄，慢漂
       * 一旦顶过去就切到 0.1°/s 的慢档，再也回不来（双稳态陷阱）。 */
      const rY = Math.abs(relYaw) < DEAD_DEG * DRIFT_BAND ? DRIFT_REST : DRIFT_ACTIVE;
      const rP = Math.abs(relPitch) < DEAD_DEG * DRIFT_BAND ? DRIFT_REST : DRIFT_ACTIVE;
      this.yaw0 = wrapDeg(this.yaw0 + clamp(relYaw, -rY * dt, rY * dt));
      this.pitch0 = wrapDeg(this.pitch0 + clamp(relPitch, -rP * dt, rP * dt));
    } else {
      /* v1.58：frozen（选择/点亮/暂停）也吸收**死区内**的慢漂。
       * 此处 rel 落在死区内 ⇒ 输出本就恒为 0，回中不会把选中项拉走；
       * 但能压住"进选择态后画面自己飘"—— 旧代码 frozen 时完全不纠正，
       * 慢漂 0.3°/s 跑 60s 就是 18° ≈ 136px（dbg-cum 实测）。 */
      const rY = Math.abs(relYaw) < DEAD_DEG ? DRIFT_REST : 0;
      const rP = Math.abs(relPitch) < DEAD_DEG ? DRIFT_REST : 0;
      this.yaw0 = wrapDeg(this.yaw0 + clamp(relYaw, -rY * dt, rY * dt));
      this.pitch0 = wrapDeg(this.pitch0 + clamp(relPitch, -rP * dt, rP * dt));
    }

    // 抖动抑制：|ω|<6°/s 且偏角<1.8° → 本帧无位移（旧门 10°/s + 4°，会吃掉慢速微调）
    let ox = shapeAngle(relYaw), oy = shapeAngle(relPitch);
    if (Math.abs(this._rateYaw) < JITTER_W && Math.abs(relYaw) < JITTER_A) ox = 0;
    if (Math.abs(this._ratePitch) < JITTER_W && Math.abs(relPitch) < JITTER_A) oy = 0;

    /* 低通**按时间常数**（v1.54）：旧写法 α=0.35 是"每帧"系数，30fps 时
     * τ≈94ms、掉到 15fps 时 τ≈190ms —— 越卡越迟钝。现 α 由 dt 算出，
     * 任意帧率下 τ 恒为 HEAD.tauMs。 */
    const a = 1 - Math.exp(-ms / HEAD.tauMs);
    this.outX += (ox - this.outX) * a;
    this.outY += (oy - this.outY) * a;
    /* 增量角度通道：对**未经 shapeAngle** 的原始相对角做同一条低通。
     * 不走 shapeAngle 的理由（PRD-04 F-LAB-03）：公共死区会把「小幅转头」
     * 整体吞掉，在增量式棘轮下表现为「完全无响应」的迟滞感；本册改用
     * 更严的 ±1.5° 死区，故此处必须保留原始角。 */
    this.relYaw += (relYaw - this.relYaw) * a;
    this.relPitch += (relPitch - this.relPitch) * a;

    /* 角速度前馈：把低通的相位滞后补回来（近似"把输出提前 FEED_S 秒"）。
     * ⚠ 只在已越过死区时生效 —— 否则前馈会捅穿死区，菜单静止时自己漂。
     * ⚠ 只作用于**像素通道**：增量通道是棘轮式累积，前馈衰减时会产生
     *   反向位移 ⇒ 滚球迷宫会把回摆误判成推进（F-LAB-09 同族坑）。 */
    let dx = this.outX, dy = this.outY;
    if (Math.abs(relYaw) > DEAD_DEG) dx += clamp(FEED_S * this._rateYaw, -FEED_MAX, FEED_MAX);
    if (Math.abs(relPitch) > DEAD_DEG) dy += clamp(FEED_S * this._ratePitch, -FEED_MAX, FEED_MAX);

    const tx = this.sens.coef * dx;
    const ty = this.sens.coef * dy;
    /* 限速**按时间**（px/s）：v1.53 的 12px/帧 在 30fps 下只有 360px/s，
     * 相机全行程（±152px）单程就要 420ms —— 这是"迟钝"的最大单一来源。
     * 选择/菜单态（frozen）走保守档，防甩头误选。 */
    const rate = (this.frozen ? HEAD.menuPxPerSec : HEAD.maxPxPerSec) * dt;
    this._px = clamp(tx, this._px - rate, this._px + rate);
    this._py = clamp(ty, this._py - rate, this._py + rate);
    /* 渲染节拍 EMA（只供 health() 取证，不参与任何控制） */
    this._fps = this._fps ? this._fps + (1000 / ms - this._fps) * 0.1 : 1000 / ms;

    this.stats.sample(relYaw, relPitch, ox, oy, this.sens);
    return { ok: true, x: this._px, y: this._py, rawYaw: relYaw, rawPitch: relPitch };
  }

  /* 增量角度通道（PRD-04 §4.3 · 滚球迷宫专用，其余分册不得依赖）
   * 返回**度**（不是像素）：低通后的原始相对偏角，再由调用方套本册死区。
   *   deadDeg 默认 1.5（F-LAB-03；v1.54 起公共基线已收窄到 1.6°，本册仍自管）
   * ⚠ 必须**先调 update(dt)** 再调本方法 —— relYaw / relPitch 由 update 维护。
   * ⚠ IMU 不可用时返回 ok:false 且 x/y 为 0，但**调用方须整体冻结**（既不
   *   推进也不回退），不得把 0 当成「角度回中」去驱动棘轮 —— 那会把回摆
   *   误判成反向推进（F-LAB-09）。 */
  rel(deadDeg) {
    const d = deadDeg === undefined ? 1.5 : deadDeg;
    if (!this.imuOk) return { ok: false, x: 0, y: 0 };
    return { ok: true, x: deadzone(this.relYaw, d), y: deadzone(this.relPitch, d) };
  }

  /* 速度型映射（游戏分册用）：归一化 -1~1 */
  velocity() {
    const fy = this._fInit ? this._fYaw : this.lastYaw;
    const fp = this._fInit ? this._fPitch : this.lastPitch;
    return {
      x: clamp(wrapDeg(fy - this.yaw0) / this.sens.rangeYaw, -1, 1),
      y: clamp(wrapDeg(fp - this.pitch0) / this.sens.rangePitch, -1, 1),
    };
  }

  /* 融合角读出口（校准会话与诊断用）：未初始化时回落绝对姿态。 */
  fusedYaw() { return this._fInit ? this._fYaw : this.lastYaw; }
  fusedPitch() { return this._fInit ? this._fPitch : this.lastPitch; }

  snapshot() { return { x: this._px, y: this._py }; }
  /* recenter 连角速度一起清：否则上一次转头残留的前馈会在状态切换后
   * 继续推动输出（菜单刚打开就被"甩"一下）。 */
  recenter() {
    this.outX = 0; this.outY = 0; this._px = 0; this._py = 0;
    this._rateYaw = 0; this._ratePitch = 0;
  }
}

/* 正式校准会话（§06）：2s 静息 + 方差校验，最多 3 次 */
export class CalibrationSession {
  constructor(engine) {
    this.engine = engine;
    this.attempt = 0;
    this.samples = [];
    this.t0 = 0;
  }
  begin() {
    this.attempt++;
    this.t0 = Date.now();
    this.samples = [];
  }
  get progress() { return Math.min(1, (Date.now() - this.t0) / CALIB_MS); }
  get done() { return this.progress >= 1; }
  /* v1.54：采样**融合角**（陀螺已准入时它比裸绝对姿态更贴近"头现在在哪"）；
   * 未初始化时回落到绝对姿态，行为与旧版一致。 */
  tick() {
    if (!this.engine.imuOk) return;
    this.samples.push([this.engine.fusedYaw(), this.engine.fusedPitch()]);
  }
  /* 方差校验：pitch / yaw 序列方差低于阈值判稳定 */
  verify() {
    const n = this.samples.length;
    if (n < 60) return { ok: false, varYaw: 0, varPitch: 0 };
    let sy = 0, sp = 0;
    for (let i = 0; i < n; i++) { sy += this.samples[i][0]; sp += this.samples[i][1]; }
    const my = sy / n, mp = sp / n;
    let vy = 0, vp = 0;
    for (let i = 0; i < n; i++) {
      const dy = this.samples[i][0] - my, dp = this.samples[i][1] - mp;
      vy += dy * dy; vp += dp * dp;
    }
    vy /= n; vp /= n;
    return { ok: vy < CALIB_VAR_MAX && vp < CALIB_VAR_MAX, varYaw: vy, varPitch: vp };
  }
  /* 写入基准（游戏基准）：以当前姿态为 0 点 */
  commit() {
    if (this.engine.imuOk) this.engine.setBase(this.engine.fusedYaw(), this.engine.fusedPitch());
    return { yaw0: this.engine.yaw0, pitch0: this.engine.pitch0 };
  }
}
