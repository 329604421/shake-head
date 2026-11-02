/* pagebase.js —— 通用页面底座（非游戏页共用）
 *
 * 【为什么有这个文件】
 * 战绩 / 教学·校准·设置 / 结算 / 校准四个二级页各有一套逐字相同的启动链
 * （读设置 → 建引擎 → 建手势 → 建画布 → 起传感器 → 起渲染循环）与生命周期
 * （onReady / onHide / onUnload / onKeyDown / onKeyUp），每页约 70 行重复。
 * 游戏页的同一层逻辑在 `utils/gamepage.js`（差异更多，单独一套）。
 *
 * 【与 gamepage.js 的分工】
 *   gamepage.js  → 有 B1/B2/B3/B4 状态机、菜单、结算落盘的游戏页；
 *   pagebase.js  → 列表 / 只读 / 一次性流程页，只有引擎 + 手势 + 渲染循环。
 * 两者不互相引用，避免二级页被游戏状态机拖累。
 */

import wx from 'wx';
import { FRAME_MS } from './theme.js';
import { startLoop, useSensorClock, stopLoop, mark, guard } from './boot.js';
import { InputEngine } from './input.js';
import { GestureTracker } from './gesture.js';
import { readSettings } from './storage.js';
import * as sfx from './sfx.js';

/* 启动链：opts = { prepare(page, settings), gesture: { onTap, onCancel } }
 * 逐步 guard，任一步失败都不阻断后续（黑屏排查定案：最坏是静态画面）。
 * 返回最终生效的 settings（页面自行决定是否留存）。 */
export function bootStandard(page, tag, opts) {
  const o = opts || {};
  const settings = guard(page, tag, 'cfg', function () {
    const s = readSettings();
    sfx.applySettings(s);
    return s;
  }) || { sensitivity: 'standard', sfxOn: true };

  guard(page, tag, 'engine', function () {
    page.engine = new InputEngine({ freq: 60, sensitivity: settings.sensitivity });
  });

  /* 数据准备（列表行 / 结算数据 / 校准会话）：建在引擎之后、手势之前，
   * 保证 prepare 里能拿到 page.engine。 */
  if (typeof o.prepare === 'function') {
    guard(page, tag, 'data', function () { o.prepare(page, settings); });
  }

  guard(page, tag, 'gest', function () {
    page.gesture = new GestureTracker(o.gesture || {});
  });

  guard(page, tag, 'ctx', function () {
    page.ctx = wx.createCanvasContext('stage');
    if (!page.ctx) throw new Error('createCanvasContext returned null');
  });

  guard(page, tag, 'sensor', function () {
    if (page.engine) page.engine.start();
  });

  guard(page, tag, 'loop', function () {
    page.loop = startLoop(page, tag, FRAME_MS);
    if (!page.loop) useSensorClock(page, page.engine, tag);
  });

  return settings;
}

/* 生命周期五件套。与 bootStandard 配套，展开进页面对象即可。
 * ⚠ 输入通道一律加存在性守卫：guard 失败时 gesture 可能为 undefined，
 *   裸调会在宿主事件回调里抛 ReferenceError。 */
export function lifecycle(tag) {
  return {
    onReady() { mark(this, tag, 'onReady'); },
    onHide() { if (this.engine) this.engine.stop(); },
    onUnload() {
      stopLoop(this);
      if (this.gesture) this.gesture.cancel();
      /* v1.58：dispose 而非 stop —— 释放传感器实例，避免每进一个页面
       * 就多留一份句柄（详见 InputEngine.dispose 的注释） */
      if (this.engine) this.engine.dispose();
    },
    onKeyDown(event) { if (this.gesture) this.gesture.onKeyDown(event); },
    onKeyUp(event) { if (this.gesture) this.gesture.onKeyUp(event); },
  };
}
