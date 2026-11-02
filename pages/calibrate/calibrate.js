/* pages/calibrate/calibrate.js —— 校准页（B1~B3 三屏）
 *
 * 多文件页面模式（SKILL.md §1.4 第二种）。详见 pages/index/index.js 头注。
 * 启动链与生命周期走 utils/pagebase.js（四个二级页共用）。
 *
 * 【v1.33】enterGame() 此前硬编码跳 `pages/game/game?gameId=…` —— 框架占位页。
 * 五款游戏全部落地后它没有任何入口，校准完直接掉进占位框。现按 GameManifest
 * 查真实页面；非游戏来源（设置页的「重新校准基准」）走 navigateBack 回到来处。
 */

import wx from 'wx';
import { C } from '../../utils/theme.js';
import { CENTER } from '../../utils/layout.js';
import {
  clear, text, fillRoundRect, strokeRoundRect, fillCircle, strokeCircle, strokeArc, ticks, flush,
} from '../../utils/draw.js';
import { CalibrationSession, CALIB_MS } from '../../utils/input.js';
import { bootStandard, lifecycle } from '../../utils/pagebase.js';
import { getEntry } from '../../utils/games.js';
import { markTutorialSeen, setGameBase } from '../../utils/storage.js';
import * as sfx from '../../utils/sfx.js';

const S = { GUIDE: 'GUIDE', SAMPLE: 'SAMPLE', FAIL: 'FAIL' };
const MAX_ATTEMPT = 3;
const GUIDE_R = 60;

export default Object.assign({
  data: {
    bootMsg: 'boot=init',
  },

  /* 生命周期统一收进 onLoad（AIUI 契约唯一确认的页面生命周期） */
  onLoad(query) {
    const self = this;
    this.gameId = (query && query.gameId) || 'plane';
    this.state = S.GUIDE;
    this._failOpt = 0;

    bootStandard(this, 'calibrate', {
      prepare: function (page) {
        /* engine 已由 bootStandard 按当前灵敏度建好，此处只挂校准会话 */
        page.session = new CalibrationSession(page.engine);
      },
      gesture: {
        onTap: function () { self.onTap(); },
        onCancel: function () { /* 模态：无语义 */ },
      },
    });
  },

  onTap() {
    if (this.state === S.GUIDE) {
      this.session.begin();
      this.state = S.SAMPLE;
      return;
    }
    if (this.state === S.FAIL) {
      if (this._failOpt === 0) {
        this.session.begin();
        this.state = S.SAMPLE;
      } else {
        this.useDefaultBase();
      }
    }
  },

  useDefaultBase() {
    if (this.engine.imuOk) this.engine.resetBase();
    setGameBase({ yaw0: this.engine.yaw0 || 0, pitch0: this.engine.pitch0 || 0, uncalibrated: true });
    this.enterGame();
  },

  /* 校准完成后的去向：
   *   游戏来源 → redirectTo 该游戏在清单里的真实页面（不再写死框架页）；
   *   非游戏来源（设置页的「重新校准基准」）→ navigateBack 回到来处，
   *     否则会在栈里再压一个设置页。
   * ⚠ 清单里查不到条目时退回主页，宁可到主页也不进已废弃的占位页。 */
  enterGame() {
    markTutorialSeen(this.gameId);
    const e = getEntry(this.gameId);
    if (e && e.kind === 'game' && e.page) {
      wx.redirectTo({ url: e.page });
      return;
    }
    wx.navigateBack();
  },

  tick() {
    const now = Date.now();
    const dt = Math.min(100, now - (this._last || now));
    this._last = now;
    const snap = this.engine.update(dt);
    if (this.gesture) this.gesture.tick(now);

    if (this.state === S.SAMPLE) {
      this.session.tick();
      if (this.session.done) {
        const v = this.session.verify();
        if (v.ok) {
          const base = this.session.commit();
          setGameBase(base);
          sfx.play('confirm');
          this.enterGame();
          return;
        }
        if (this.session.attempt >= MAX_ATTEMPT) {
          this.useDefaultBase();
          return;
        }
        this.state = S.FAIL;
        this._failOpt = 0;
      }
    }

    if (this.state === S.FAIL && snap.ok) {
      if (snap.rawPitch > 3) this._failOpt = 0;
      else if (snap.rawPitch < -3) this._failOpt = 1;
    }

    this.render(now);
  },

  render(now) {
    const ctx = this.ctx;
    if (!ctx) return;
    clear(ctx);

    if (this.state === S.GUIDE) {
      strokeCircle(ctx, CENTER.x, CENTER.y, GUIDE_R, C.p24, 1.5);
      strokeCircle(ctx, CENTER.x, CENTER.y, 18, C.p48, 1.5);
      fillCircle(ctx, CENTER.x, CENTER.y, 6, C.p72);
      text(ctx, '请保持自然平视，注视中央 2 秒', 240, 84, { size: 16, weight: 500, color: C.p72 });
      text(ctx, '单击开始校准', 240, 286, { size: 14, weight: 400, color: C.p72 });
      text(ctx, '校准期间请勿大幅转头', 240, 320, { size: 11, weight: 500, color: C.p48 });
    } else if (this.state === S.SAMPLE) {
      const p = this.session.progress;
      strokeCircle(ctx, CENTER.x, CENTER.y, GUIDE_R, C.p24, 1.5);
      strokeArc(ctx, CENTER.x, CENTER.y, GUIDE_R, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2, C.p72, 2);
      fillCircle(ctx, CENTER.x, CENTER.y, 18, C.p12);
      fillCircle(ctx, CENTER.x, CENTER.y, 6, C.p100);
      ticks(ctx, CENTER.x, CENTER.y, GUIDE_R + 6, GUIDE_R + 10, 12, 1, C.p24, 0);
      text(ctx, String(Math.max(1, Math.ceil(CALIB_MS * (1 - p) / 1000))), CENTER.x, CENTER.y + 42,
        { size: 13, weight: 500, color: C.p100, mono: true });
      text(ctx, '静息采样中，请保持静止', 240, 286, { size: 12, weight: 400, color: C.p48 });
    } else {
      strokeCircle(ctx, 240, 108, 14, C.p72, 1);
      ctx.fillStyle = C.p100;
      ctx.fillRect(238.5, 100, 3, 10);
      fillCircle(ctx, 240, 116, 1.8, C.p100);
      text(ctx, '未能获取稳定姿态', 240, 146, { size: 16, weight: 500, color: C.p72 });

      const n = this.session.attempt + 1;
      const rows = [
        '重试（第 ' + n + ' 次 / 共 ' + MAX_ATTEMPT + ' 次）',
        '使用默认基准并标记未校准',
      ];
      for (let i = 0; i < 2; i++) {
        const y = 188 + i * 44;
        const sel = this._failOpt === i;
        if (sel) {
          fillRoundRect(ctx, 96, y, 288, 34, 4, C.p12);
          strokeRoundRect(ctx, 96, y, 288, 34, 4, C.p100, 1.5);
          ctx.fillStyle = C.p100;
          ctx.fillRect(96, y + 6, 2, 22);
        } else {
          strokeRoundRect(ctx, 96, y, 288, 34, 4, C.p48, 1);
        }
        text(ctx, rows[i], 240, y + 17, { size: 14, weight: 400, color: sel ? C.p100 : C.p72 });
      }
      text(ctx, '抬头 / 低头切换选项，单击确认', 240, 320, { size: 11, weight: 500, color: C.p48 });
    }

    text(ctx, '校准', 16, 24, { size: 12, weight: 500, color: C.p100, align: 'left' });
    text(ctx, '第 ' + Math.max(1, this.session.attempt) + ' / ' + MAX_ATTEMPT + ' 次', 464, 24,
      { size: 12, weight: 500, color: C.p72, align: 'right' });
    text(ctx, this.engine.imuOk ? 'IMU状态正常' : 'IMU状态异常', 464, 40,
      { size: 11, weight: 500, color: this.engine.imuOk ? C.p48 : C.p100, align: 'right' });

    flush(ctx);
  },
}, lifecycle('calibrate'));
