/* gesture.js —— 触控板手势判定器：单击 + 滑动（PRD-01 §04 · 交互 v1.14）
 *
 * 【交互 v1.14 变更】进入选择态的操作由「单击」改为「滑动触控板」：
 *   滑动（前/后/左/右任意方向）→ 进入选择状态；
 *   选择态下未点亮时单击 → 退回待机；点亮态单击 → 确认选择。
 * 依据：SKILL.md §4.2 —— 宿主对 ArrowUp / ArrowDown 的默认行为是滚动根
 * 容器，§4.3 明确方向键属于 Rokid 常见 event.code。即触控板滑动在框架层
 * 表现为方向键序列，可独立成一条手势通道（不占用单击语义）。
 * 注意：默认行为只在 onKeyUp 阶段可拦截，故滑动必须在 keyUp 里
 * preventDefault，否则宿主会把页面滚走。
 * 【交互 v1.2 变更】宿主默认「双击触控板 = 退出程序」无法拦截
 * （onKeyUp preventDefault 实测拦不住宿主双击退出），双击语义整体弃用。
 * 全部交互收敛为单击：
 *   主页待机单击 → 进入选择态；点亮态单击 → 确认；未点亮单击 → 取消。
 *   游戏中单击 → 唤出菜单；点亮态单击 → 确认；未点亮单击 → 继续游戏。
 *
 * 【即时派发】v1.1 的「未决单击 + 300ms 双击窗口」随双击语义一并移除，
 * 单击在 keyUp 即刻派发（顺带消除了 v1.1 每次单击固定延迟 300ms 的问题）。
 *
 * 【真机取证 · 双键码序列（交互 v1.7，决定性）】一次物理按压的事件形态：
 *   D:GlobalHook U:GlobalHook（间隔 ~6ms）→ 约 483ms 后 → D:Enter U:Enter
 * 即 GlobalHook 对 + Enter 对是**同一次按压的两个通道**。处理：
 *   1) GlobalHook 抬起后 600ms（enterSuppress）内的 Enter 对整体吞掉
 *      ——不产生第二次单击（否则单击进选择态会被第二次单击打回待机）；
 *      纯 Enter 物理键（无近期 GlobalHook）仍按独立单击处理。
 *   2) tapDebounce 150ms 同键码消抖：防长按期间多对 GlobalHook 重复结算。
 * 两次独立单击的间隔由用户控制（>150ms），互不干扰。
 *
 * 【无定时器设计】本判定器不依赖任何宿主定时器 API（setTimeout 红线，
 * 见 utils/boot.js 文件头）。tick() 保留为空实现：页面循环统一调用点
 * 不变，避免六页 tick 各自删行引入无谓改动。
 *
 * 【防连发】down 状态自守：未抬起前忽略重复 keyDown（auto-repeat）。
 */

import { TOUCH } from './layout.js';

export const TOUCH_CODES = { Enter: 1, GlobalHook: 1, Touch: 1, Select: 1 };
/* 触控板滑动通道（交互 v1.14）：Rokid 把触控板前/后滑动派发为方向键序列。
 * 官方 SKILL.md §4.2 —— "Scrolling the current root container when the user
 * presses ArrowUp or ArrowDown"；§4.3 明确方向键属于 Rokid 常见 event.code。
 * 因此滑动 = 方向键；四个方向都算（用户侧语义均为"滑一下"）。 */
export const SWIPE_CODES = { ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1 };
export const GESTURE = { TAP: 'tap', CANCEL: 'cancel', SWIPE: 'swipe' };

/* cb: { onTap(elapsed), onCancel() } */
export function GestureTracker(cb) {
  this.cb = cb || {};
  this.down = false;
  this.downAt = 0;
  this.lastUp = 0;
  this.settleAt = 0;     // 同键码消抖截止时刻
  this.lastGhUp = -1e9;  // 最近 GlobalHook 抬起时刻（v1.7 Enter 抑制基准；
                         // 初始取大负数，避免首次纯 Enter 物理键被误抑制）
  this.swipeSettleAt = 0; // v1.14 滑动消抖截止时刻（一次滑动连发多个方向键）
}

GestureTracker.prototype.isTouch = function (e) {
  return !!(e && TOUCH_CODES[e.code]);
};

/* 触控板滑动 = 方向键（v1.14，依据见文件头 SWIPE_CODES 注释） */
GestureTracker.prototype.isSwipe = function (e) {
  return !!(e && SWIPE_CODES[e.code]);
};

GestureTracker.prototype._emit = function (name, arg) {
  if (typeof this.cb[name] === 'function') this.cb[name](arg);
};

/* Enter 抑制（v1.7）：GlobalHook 抬起后 enterSuppress 内的 Enter 对
 * 视为同一按压的语义通道，整体吞掉、不进状态机、不污染 down 状态 */
GestureTracker.prototype._suppressEnter = function (e) {
  return !!(e && e.code === 'Enter' && Date.now() - this.lastGhUp < TOUCH.enterSuppress);
};

GestureTracker.prototype.onKeyDown = function (e) {
  /* v1.14 滑动通道优先：方向键不属于按压语义，走独立结算路径 */
  if (this.isSwipe(e)) {
    const n = Date.now();
    /* 一次物理滑动会连发多个方向键脉冲：窗口内只结算第一次（语义幂等） */
    if (n < this.swipeSettleAt) return true;
    this.swipeSettleAt = n + TOUCH.swipeDebounce;
    this._emit('onSwipe', e.code);
    return true;
  }
  if (!this.isTouch(e)) return false;
  if (this._suppressEnter(e)) return true;
  const now = Date.now();
  /* 同键码消抖：长按期间多对 GlobalHook 只结算一次 */
  if (now < this.settleAt) return true;
  /* 宿主异常连发守卫：已按下时忽略重复 keyDown，保持真实按压起点 */
  if (this.down) return true;
  this.down = true;
  this.downAt = now;
  return true;
};

GestureTracker.prototype.onKeyUp = function (e) {
  /* v1.14 滑动通道：宿主默认动作（滚动根容器）在 keyUp 阶段判定 —— 必须
   * 在此拦截，否则页面会被宿主滚走（SKILL.md §4.2）。语义已在 keyDown 结算，
   * 这里只做拦截；若宿主只派发 keyUp 而未派发 keyDown，则补结算一次。 */
  if (this.isSwipe(e)) {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    const n = Date.now();
    if (n >= this.swipeSettleAt) {   // keyDown 侧未结算过（宿主仅派发 keyUp）
      this.swipeSettleAt = n + TOUCH.swipeDebounce;
      this._emit('onSwipe', e.code);
    }
    return true;
  }
  if (!this.isTouch(e)) return false;
  /* 契约（SKILL.md §4.3）：仅 onKeyUp 的 preventDefault 能拦截宿主默认行为。
   * 实测拦不住宿主「双击退出」（v1.2 前提），但对单击类默认行为仍保留拦截，
   * 属于尽力而为，语义上不依赖它。 */
  if (e && typeof e.preventDefault === 'function') e.preventDefault();
  if (this._suppressEnter(e)) return true;
  const now = Date.now();
  if (now < this.settleAt) return true;
  if (e.code === 'GlobalHook') this.lastGhUp = now;
  const el = now - this.downAt;
  this.down = false;
  this.lastUp = now;
  this.settleAt = now + TOUCH.tapDebounce;  // 进入同键码消抖窗口
  this._emit('onTap', el);   // 单击即时派发，无窗口等待
  return true;
};

/* 保留空实现：页面循环统一调用点不变（见文件头说明） */
GestureTracker.prototype.tick = function () {};

GestureTracker.prototype.cancel = function () {
  if (this.down) {
    this.down = false;
    this._emit('onCancel');
  }
};

GestureTracker.prototype.reset = function () {
  this.cancel();
};
