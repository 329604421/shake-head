/* pages/result/result.js —— 结算页（C3，PRD-01 §11）
 *
 * 多文件页面模式（SKILL.md §1.4 第二种）。详见 pages/index/index.js 头注。
 * 启动链与生命周期走 utils/pagebase.js（四个二级页共用）。
 *
 * 【v1.33】「再来一局」此前硬编码跳 `pages/game/game?gameId=…` —— 那是**框架
 * 占位页**，五款游戏全部落地后没有任何入口指向它，点下去看到的是占位框而不是
 * 游戏。现改为按 GameManifest 查真实页面（getEntry(gameId).page）。
 */

import wx from 'wx';
import { C } from '../../utils/theme.js';
import { clear, text, fillRoundRect, strokeRoundRect, flush } from '../../utils/draw.js';
import { bootStandard, lifecycle } from '../../utils/pagebase.js';
import { getEntry } from '../../utils/games.js';
import { takePendingResult, readTop } from '../../utils/storage.js';

export default Object.assign({
  data: {
    bootMsg: 'boot=init',
  },

  /* 生命周期统一收进 onLoad（AIUI 契约唯一确认的页面生命周期） */
  onLoad(query) {
    const self = this;
    bootStandard(this, 'result', {
      prepare: function () {
        const p = takePendingResult();
        self.r = (p && p.result) || {
          score: 0, cleared: false, reachedLevel: 0, durationSec: 0,
          motion: {}, extra: [],
        };
        self.gameId = (p && p.gameId) || (query && query.gameId) || 'plane';
        self.meta = getEntry(self.gameId);
        self.isRecord = !!(p && p.isRecord);
        const top = readTop(self.gameId);
        self.best = top.length ? top[0].score : 0;
        self.focus = 0;
      },
      gesture: {
        onTap: function () { self.onTap(); },
        onCancel: function () { /* 无语义 */ },
      },
    });
  },

  onTap() {
    if (this.focus === 0) {
      /* 再来一局：按清单查真实页面，取不到则退回主页（不跳已废弃的框架页） */
      const e = getEntry(this.gameId);
      wx.redirectTo({ url: (e && e.page) || 'pages/index/index' });
    } else {
      wx.navigateBack();
    }
  },

  tick() {
    const now = Date.now();
    const dt = Math.min(100, now - (this._last || now));
    this._last = now;
    const snap = this.engine.update(dt);
    if (this.gesture) this.gesture.tick(now);
    if (snap.ok) {
      if (snap.rawPitch > 3) this.focus = 1;
      else if (snap.rawPitch < -3) this.focus = 0;
    }
    this.render();
  },

  render() {
    const ctx = this.ctx;
    if (!ctx) return;
    clear(ctx);

    const r = this.r;
    const name = this.meta ? this.meta.name : '本局结果';
    text(ctx, name + ' · 本局结算', 240, 52, { size: 16, weight: 500, color: C.p72 });

    text(ctx, String(r.score), 240, 96, { size: 22, weight: 500, color: C.p100 });

    text(ctx, '历史最高 ' + this.best, 240, 128, { size: 12, weight: 400, color: C.p48 });
    if (this.isRecord) {
      const label = '新纪录';
      fillRoundRect(ctx, 196, 140, 88, 24, 4, C.p12);
      strokeRoundRect(ctx, 196, 140, 88, 24, 4, C.p100, 2);
      text(ctx, label, 240, 152, { size: 12, weight: 500, color: C.p100 });
    }

    const m = r.motion || {};
    const fields = [
      ['转向幅度', (m.yawAmpDeg || 0) + '°'],
      ['俯仰幅度', (m.pitchAmpDeg || 0) + '°'],
      ['偏航利用', Math.round((m.yawUtil || 0) * 100) + '%'],
      ['俯仰利用', Math.round((m.pitchUtil || 0) * 100) + '%'],
      ['单击次数', String(m.tapCount || 0)],
      ['平均延迟', (m.tapLatencyMs || 0) + 'ms'],
    ];
    for (let i = 0; i < fields.length; i++) {
      const col = i % 2, row = Math.floor(i / 2);
      const x = col === 0 ? 120 : 360;
      const y = 186 + row * 34;
      text(ctx, fields[i][0], x, y, { size: 11, weight: 500, color: C.p48 });
      text(ctx, fields[i][1], x, y + 14, { size: 13, weight: 500, color: C.p100, mono: true });
    }

    const ex = r.extra || [];
    for (let i = 0; i < Math.min(2, ex.length); i++) {
      const x = i === 0 ? 160 : 320;
      text(ctx, ex[i].label, x, 296, { size: 11, weight: 500, color: C.p48 });
      text(ctx, String(ex[i].value), x, 308, { size: 13, weight: 500, color: C.p100, mono: true });
    }

    const btns = ['再来一局', '返回主页'];
    for (let i = 0; i < 2; i++) {
      const bx = i === 0 ? 72 : 288;
      const sel = this.focus === i;
      if (sel) {
        fillRoundRect(ctx, bx, 318, 120, 26, 4, C.p12);
        strokeRoundRect(ctx, bx, 318, 120, 26, 4, C.p100, 2);
      } else {
        strokeRoundRect(ctx, bx, 318, 120, 26, 4, C.p48, 1);
      }
      text(ctx, btns[i], bx + 60, 331, { size: 14, weight: 500, color: sel ? C.p100 : C.p72 });
    }

    text(ctx, '抬头 / 低头切换按钮 · 单击确认', 240, 344, { size: 11, weight: 500, color: C.p48 });

    flush(ctx);
  },
}, lifecycle('result'));
