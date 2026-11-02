/* pages/records/records.js —— 战绩页（C2，PRD-01 §7.2）
 *
 * 多文件页面模式（SKILL.md §1.4 第二种）。启动链与生命周期走
 * utils/pagebase.js（四个二级页共用）。
 *
 * 【v1.33】本页此前**不可达**：games.js 里 records / settings 两个入口的
 * page 字段仍指向框架页 pages/game/game（占位），而框架页对 kind='system'
 * 只画占位框，于是主页选中"战绩"永远进不到这里。现改为指向本页。
 *
 * 【v1.50 精简】原「五款游戏 × 各自 Top3（含日期/用时）滚动列表」→
 * **只展示每款游戏最近一局，五款五行，一屏放下、无滚动**：
 *   ① 数据源由 `readTop`（Top3）改为 **`readLast`**（最近一局，独立落盘
 *      `last_{gameId}`）——⚠ 不能从 hi_ 推导：hi_ 按分数降序截断 Top3，
 *      **最近一局若没进前三会被丢掉**。
 *   ② 去掉 `ScrollList` 与抬头/低头滚动（本页纯只读，没有可翻的内容）。
 *   ③ HUD 左上角标题由应用名改「战绩」；左下角提示
 *      `单击触控回到主页`——本页唯一交互就是单击返回。
 *      【v1.51】右上角由「状态：只读」改「最近一局成绩」（dot:null 不画状态灯），
 *      列表上方的同名小标题「最近一局」删除，列表整体上移留白（REC.y 64 → 84）。
 *   ④ 返回走**对象形态 navigateBack + 落地判定 + 有限重试**（v1.49 定案：
 *      裸 `wx.navigateBack()` 是宿主请求型 API，真机表现为「点了没反应」）。
 *   ⑤ 无需头控 ⇒ 进页即停采（省电，且避免二级页冷启动漂移干扰）。
 */

import wx from 'wx';
import { g } from '../../utils/theme.js';
import { REC } from '../../utils/layout.js';
import { clear, text, fillRoundRect, strokeRoundRect, flush } from '../../utils/draw.js';
import { drawHud, drawHint } from '../../utils/hud.js';
import { drawIcon } from '../../utils/icons.js';
import { bootStandard, lifecycle } from '../../utils/pagebase.js';
import { GAME_IDS, getEntry } from '../../utils/games.js';
import { readLast } from '../../utils/storage.js';
import * as sfx from '../../utils/sfx.js';

/* 返回落地判定（与 utils/gamepage.js / pages/settings 同口径，常量不跨模块
 * 引用的原因：gamepage 带整套游戏状态机，二级页不该为两个常量引入它）。
 * navigateBack 是**宿主请求型 API**：success 是无条件回调，不能当成功证据，
 * 成败只能靠落地判定——返回成功后本页被出栈，宿主会回调 onHide。 */
const BACK_PROBE_MS = 800;
const BACK_MAX_TRY = 3;

export default Object.assign({}, lifecycle('records'), {
  data: {
    bootMsg: 'boot=init',
  },

  onLoad() {
    const self = this;
    this.settings = bootStandard(this, 'records', {
      prepare: function (page, settings) {
        /* ⚠ 必须在这里落定：boot.js 的 startLoop 会**同步**跑一帧「保底首帧」，
         * 那一帧的 render 发生在 `this.settings = bootStandard(...)` 赋值之前。 */
        page.settings = settings;
        page.rows = self._buildRows();
        return settings;
      },
      gesture: {
        onTap: function () { self.onTap(); },
        onCancel: function () { /* 只读页：无语义 */ },
      },
    }) || { sensitivity: 'standard', sfxOn: true };

    /* ⑤ 本页无头控交互（无滚动、无选择态）⇒ 进页即停采。
     * 与设置页相反：那边需要起采跑 PRIME_MS 预热，这边完全用不到 IMU。 */
    this._hidden = false;
    if (this.engine) this.engine.stop();
  },

  onShow() {
    this._hidden = false;
    this._backAt = 0;
  },

  /* 覆盖 pagebase 的 onHide：除停采外，还要置落地标记——它是 navigateBack
   * 唯一可信的成功证据（见 BACK_PROBE_MS 处注释）。 */
  onHide() {
    this._hidden = true;
    if (this.gesture) this.gesture.cancel();
    if (this.engine) this.engine.stop();
  },

  /* 每款游戏一行：名称 + 最近一局得分；从未玩过则显示「暂无记录」。 */
  _buildRows() {
    const rows = [];
    for (let i = 0; i < GAME_IDS.length; i += 1) {
      const gm = getEntry(GAME_IDS[i]);
      const last = readLast(GAME_IDS[i]);
      rows.push({
        id: GAME_IDS[i],
        name: gm ? gm.name : GAME_IDS[i],
        iconId: gm ? gm.iconId : 'ranking',
        score: (last && typeof last.score === 'number') ? last.score : null,
      });
    }
    return rows;
  },

  /* 单击 = 返回主页（本页唯一交互） */
  onTap() {
    if (this._backAt) return;                 /* 返回请求在途：不再受理 */
    sfx.play('confirm');
    this._backTried = 0;
    this._requestBack();
  },

  _requestBack() {
    if (typeof wx.navigateBack !== 'function') { this._backFailed(); return; }
    try {
      wx.navigateBack({
        delta: 1,
        success: function () { /* 仅"已发出"，不作成功证据 */ },
        fail: function () { /* 无 fail 路径，保留以兼容宿主差异 */ },
        complete: function () { /* noop */ },
      });
    } catch (e) {
      this._backFailed();
      return;
    }
    this._backTried = (this._backTried || 0) + 1;
    this._backAt = Date.now();
  },

  /* 配额内继续重试；用尽则清在途标记——绝不让用户卡在"无反应" */
  _backFailed() {
    if ((this._backTried || 0) >= BACK_MAX_TRY) {
      this._backAt = 0;
      return;
    }
    this._requestBack();
  },

  tick() {
    const now = Date.now();
    this._last = now;
    if (this.gesture) this.gesture.tick(now);

    /* 返回落地判定：请求发出后 BACK_PROBE_MS 内没等到 onHide ⇒ 未受理 */
    if (this._backAt && !this._hidden && now - this._backAt > BACK_PROBE_MS) {
      this._backFailed();
    }

    this.render();
  },

  render() {
    const ctx = this.ctx;
    if (!ctx) return;
    clear(ctx);

    const rows = this.rows || [];

    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const y = REC.y + i * REC.rowH;
      const cy = y + REC.boxH / 2;
      fillRoundRect(ctx, REC.x, y, REC.w, REC.boxH, 4, g(0.12));
      strokeRoundRect(ctx, REC.x, y, REC.w, REC.boxH, 4, g(0.24), 1);

      drawIcon(ctx, row.iconId, REC.x + 24, cy, g(0.72), 22);
      text(ctx, row.name, REC.x + 48, cy, { size: 14, weight: 500, color: g(1), align: 'left' });

      if (row.score === null) {
        text(ctx, '暂无记录', REC.x + REC.w - 12, cy,
          { size: 12, weight: 400, color: g(0.48), align: 'right' });
      } else {
        text(ctx, String(row.score), REC.x + REC.w - 12, cy,
          { size: 16, weight: 500, color: g(1), align: 'right', mono: true });
      }
    }

    /* v1.51：右上胶囊由「状态：只读」改为「最近一局成绩」——本页唯一需要说明的
     * 口径就是右侧那列数字是什么；「只读」不是用户关心的信息。
     * dot:null = 不画状态圆点（圆点是状态灯，与文案语义冲突）。
     * 列表上方原本还有一行同名小标题，既然胶囊已承担该语义，小标题删除，
     * 腾出的纵向空间补给「列表 ↔ HUD」留白（REC.y 64 → 84）。 */
    drawHud(ctx, '战绩', { text: '最近一局成绩', dot: null });
    drawHint(ctx, '单击触控回到主页');
    flush(ctx);
  },
});
