/* boot.js —— 页面启动护栏 + 契约安全渲染驱动
 *
 * 【为什么不能用 setInterval】（黑屏四轮排查定案）
 * AIUI 官方 apis.md 的 Confirmed API Scope 里 **没有** setInterval /
 * setTimeout / requestAnimationFrame 中的任何一个，且作者规则明确要求
 * "只生成本文件或链接文档中明确列出的 API 用法"。定时器属宿主 Web API，
 * 不保证存在于 AIUI 运行时。若 setInterval 缺失：
 *   onReady → startLoop → setInterval(...) → ReferenceError
 *   → 生命周期中断 → 页面只剩 .root 背景色 #080A09（近黑）→ 黑屏。
 * 这解释了为什么前三轮围绕 import 的修复全部无效。
 *
 * 因此本模块提供**降级驱动链**，并把「保底首帧」作为硬要求：
 *   1. 无论能否拿到驱动，onReady 内立即渲染一帧 —— 最坏情况是
 *      「静态画面」而不是「黑屏」；
 *   2. 按可用性依次尝试：setInterval → requestAnimationFrame →
 *      setTimeout → 传感器 reading 事件（契约确认，60Hz）→ 无驱动；
 *   3. 每帧护栏：异常只打印一次堆栈，不中断循环。
 *
 * 【可视诊断】mark() 把启动进度写进页面 data，模板用 <text> 渲染。
 * 不依赖画布 —— 即使 canvas 拿不到，也能在屏幕上看到 JS 走到了哪一步。
 */

import wx from 'wx';

/* 写入一条启动进度：控制台 + 屏幕（后者仅用于诊断，可整行删除模板文本） */
function mark(page, tag, text) {
  console.log('[' + tag + '] ' + text);
  try {
    if (page && typeof page.setData === 'function') {
      page._bootLog = page._bootLog ? page._bootLog + ' | ' + text : text;
      page.setData({ bootMsg: page._bootLog });
    }
  } catch (e) { /* setData 失败不影响主流程 */ }
}
export { mark };

/* 异常摘要：只取 message，避免长堆栈把屏幕挤爆 */
export function errMsg(e) {
  if (!e) return 'null';
  const m = e.message || (typeof e === 'string' ? e : String(e));
  const s = String(m).replace(/\s+/g, ' ');
  return s.length > 40 ? s.slice(0, 40) : s;
}

/* 生命周期分段护栏：一步一 mark，任何一步炸了都不阻断后续，
 * 且屏幕上能直接读出断点（黑屏六轮排查定案）。 */
export function guard(page, tag, name, fn) {
  try {
    const r = fn();
    mark(page, tag, name + '=OK');
    return r;
  } catch (e) {
    mark(page, tag, name + 'ERR:' + errMsg(e));
    console.error('[' + tag + '] ' + name + ' 堆栈:', e && (e.stack || e));
    return undefined;
  }
}

/* 创建画布上下文。返回 ctx（可能为 null）。
 * 契约：wx.createCanvasContext 找不到节点时返回 null（不是抛错）。 */
export function bootCanvas(page, tag) {
  try {
    page.ctx = wx.createCanvasContext('stage');
  } catch (e) {
    page.ctx = null;
    console.error('[' + tag + '] createCanvasContext 异常:', e && (e.message || e));
  }
  mark(page, tag, 'ctx=' + (page.ctx ? 'OK' : 'NULL')
    + ' sensor=' + (globalThis.AbsoluteOrientationSensor ? 'yes' : 'no'));
  return page.ctx;
}

/* 单帧执行器：带重入保护 + 异常只报一次（避免刷屏拖垮帧率）。 */
export function safeTick(page, tag) {
  if (!page || page._ticking) return;
  page._ticking = true;
  try {
    if (typeof page.tick === 'function') page.tick();
  } catch (e) {
    if (!page._errOnce) {
      page._errOnce = true;
      mark(page, tag, 'tick异常:' + (e && (e.message || e)));
      console.error('[' + tag + '] tick 堆栈:', e && (e.stack || e));
    }
  } finally {
    page._ticking = false;
  }
}

/* 启动渲染循环。
 * 返回 { driver, stop } —— driver 为 'setInterval' / 'raf' / 'setTimeout'；
 * 无任何定时器可用时返回 null（此时页面应退化为传感器读数驱动，见 README）。 */
export function startLoop(page, tag, frameMs) {
  const ms = (typeof frameMs === 'number' && frameMs > 0) ? frameMs : 33;
  const run = function () { safeTick(page, tag); };

  /* 保底首帧：即使后续一个驱动都拿不到，画面也不至于全黑 */
  safeTick(page, tag);

  if (typeof setInterval === 'function') {
    const h = setInterval(run, ms);
    mark(page, tag, 'loop=setInterval');
    return {
      driver: 'setInterval',
      stop: function () { if (typeof clearInterval === 'function') clearInterval(h); },
    };
  }
  if (typeof requestAnimationFrame === 'function') {
    let alive = true;
    (function frame() { if (!alive) return; run(); requestAnimationFrame(frame); })();
    mark(page, tag, 'loop=raf');
    return { driver: 'raf', stop: function () { alive = false; } };
  }
  if (typeof setTimeout === 'function') {
    let alive = true;
    (function frame() { if (!alive) return; run(); setTimeout(frame, ms); })();
    mark(page, tag, 'loop=setTimeout');
    return { driver: 'setTimeout', stop: function () { alive = false; } };
  }
  mark(page, tag, 'loop=NONE');
  return null;
}

/* 无定时器时的兜底：把传感器 reading 事件（契约确认 60Hz）当渲染时钟。
 * 调用方在 startLoop 返回 null 时使用。 */
export function useSensorClock(page, engine, tag) {
  if (!engine || typeof engine !== 'object') return false;
  engine.onReading = function () { safeTick(page, tag); };
  mark(page, tag, 'loop=sensor');
  return true;
}

/* 停止渲染循环 + 断开传感器时钟。onUnload 统一调用。 */
export function stopLoop(page) {
  if (page && page.loop && typeof page.loop.stop === 'function') page.loop.stop();
  if (page && page.engine) page.engine.onReading = null;
}
