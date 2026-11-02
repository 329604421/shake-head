/* pages/brick/brick.js —— 《打砖块》游戏页（PRD-02 · P0）
 *
 * 【本页的组成】
 * 通用部分（onLoad 护栏链 / 生命周期 / B2 菜单 / B3 loading / B4 继续 /
 * 返回握手 / HUD 状态 / 结算落盘）由 `utils/gamepage.js` 的 gameBase() 提供，
 * 五款游戏逐字共用。本页只保留打砖块自己的差异：
 *   ① B1 每帧调 stepBricks() 并处理返回事件（播音 / 结算 / 挂机保护）；
 *   ② **不画左下提示条** —— 提示条是搭框架时的占位（y 316~340），
 *      真实游戏页不出现，该区间归球场底板（见设计稿九屏）；
 *   ③ 挂载 statusText() 钩子，把右上状态胶囊改写为本局状态（§2.7.2）；
 *   ④ B2 期游戏内容收束到 **1（6% 隐藏档）** —— 本册是五款中唯一用 1 的，
 *      其余四款用 0.55（次要层）。别顺手统一。
 *
 * 【两个 fade 必须分开】
 *   contentFade 给游戏内容：MENU 态 = 1（收束到 6% 隐藏档，PRD §2.7.4）；
 *   entryFade  给菜单入口：MENU 态 = 0（菜单自身必须恒亮）。
 *   框架页两者共用同一个 fade，是因为它的画面区只有占位框、无需区分；
 *   本页若共用，MENU 态会把菜单一起打到 6%，等于菜单不可见。
 *   ⚠ 这两个变量受 harness P5 源码契约锁保护，不得重构成共享实现。
 */

import {
  CENTER, TOUCH, CONFIRM_MS, PULSE, LOADING_MIN_MS, LAUNCH_FADE, AD,
} from '../../utils/layout.js';
import { clear, flush, clamp } from '../../utils/draw.js';
import {
  layoutEntries, pickLit, drawEntries, drawActiveCore, drawCoreCountdown,
  drawLoadingCore, launchFade, coreFade,
} from '../../utils/ring.js';
import { drawHud } from '../../utils/hud.js';
import { drawConfirm } from '../../utils/overlay.js';
import { gameBase, drawCourt, drawAdCards, S } from '../../utils/gamepage.js';
/* 玩法模块：update/render 与本页的 tick/render 同名，故一律别名导入，
 * 避免阅读时把「推进一帧」和「画一帧」搞混。 */
import {
  create as createBricks, update as stepBricks, render as drawBricks, result as brickResult,
  camDx as camDxBricks,
} from '../../utils/bricks.js';

/* 事件 → 音效映射（F-BRK-92：5 类，复用既有 key + 新增 bounce）。
 * 本页是**唯一**允许 import sfx 的地方（F-BRK-85：玩法模块不得 import）。 */
const SFX_OF = {
  serve: 'launch',
  breakthrough: 'launch',
  bounce: 'bounce',
  brick: 'boom',
  power: 'catch',
  lose: 'fail',
  over: 'fail',
  clear: 'clear',
};

/* 挂机保护（F-BRK-86）：5 分钟无击砖 → 玩法模块投递 'idle'，与 'finished'
 * 同样走结算出口，不无限挂下去。 */
const TERMINAL = ['idle'];

export default Object.assign({}, gameBase({
  tag: 'brick', gameId: 'bricks', field: 'bk',
  create: createBricks, result: brickResult, sfxOf: SFX_OF, terminal: TERMINAL,
}), {
  /* 右上状态胶囊钩子（§2.7.2）：把框架状态改写为本局状态。
   * 可用宽 ≈86px（CJK ≈7 字），故文案一律 ≤6 字。
   * ⚠ IMU 异常时**主动放弃覆盖**（返回空串），交还框架显示
   *   「IMU状态异常」+ 空心圆点 —— 那是设计的双通道降级提示（设计稿 S8）。 */
  statusText() {
    const k = this.bk;
    if (!k) return '';
    if (k.imuDown) return '';
    if (k.serve.on) return '准备发球';
    if (k.combo > 0) return '连击 ' + k.combo;
    return '剩余 ' + k.alive;
  },

  onTap(el) {
    this._tapIn(el);
    /* S.READY 游玩提示：单击 = 以当前姿态重建 IMU 基准 + 3s 倒计时（v1.52） */
    if (this.state === S.READY) { this._readyTap(); return; }
    /* B5 结束弹窗：未满 5 秒单击 → 立刻回主页（与倒计时同一出口） */
    if (this.state === S.OVER) { this._overHome(); return; }
    if (this.state === S.CONT) { this.backToPlay(); return; }
    if (this.state === S.PLAY) {
      /* IMU 异常时头控选择不可用 → 走逃生出口直接结算（F-BRK-84） */
      if (!this.engine.imuOk) { this.finishGame(); return; }
      this.enterMenu();
      return;
    }
    if (this.state === S.MENU) {
      const lit = this._lit;
      if (!lit) { this._beginCont(); return; }
      this.engine.freezeDrift(false);
      this._beginLoading(lit.meta.kind, lit.meta.iconId, lit.meta.name);
    }
  },

  tick() {
    const now = Date.now();
    const dt = Math.min(100, now - (this._last || now));
    this._last = now;
    const snap = this.engine.update(dt);
    this.gesture.tick(now);

    if (this.state === S.MENU) {
      if (!this.engine.imuOk) this.backToPlay();
      else if (now - this.menuAt > TOUCH.selectSuspend) this._beginCont();
    }
    if (this.state === S.LOADING && !this._loadingDone
        && now - this.loadingAt >= LOADING_MIN_MS) {
      this._loadingDone = true;
      if (this.loadingKind === 'home') this._requestBack();
      else this.initPlay();
    }
    if (this.state === S.LOADING && this._loadingDone && this.loadingKind === 'home'
        && this._backAt && !this._hidden && now - this._backAt >= 800) {
      this._backFailed();
    }
    if (this.state === S.CONT && now - this.contAt > CONFIRM_MS) this.backToPlay();
    /* B5 结束弹窗：满 5 秒 → 走 B3 握手回主页 */
    this._tickOver(now);
    /* S.READY 游玩提示：武装后满 3 秒 → 开跑（v1.52） */
    this._tickReady(now);

    /* B1 是**唯一**推进玩法的地方（F-BRK-81）：B2/B3/B4 只渲染最后一帧，
     * 于是 g.t 自动停走 —— 冻结与续算无需任何显式 freeze / resume。
     * ⚠ 休息关怀（F-Sys-09）**本册已取消**：原逻辑是「头在动的帧数 > 300
     * （约 10s）就永久挂出提示」，而打砖块全程都在转头，等于开局 10 秒后
     * 提示再也不消失。用户 2026-09-04 明确要求去掉。 */
    if (this.state === S.PLAY) {
      if (this.bk) this._handleEvents(stepBricks(this.bk, dt, snap));
    }

    this.render(now, snap);
  },

  render(now, snap) {
    const ctx = this.ctx;
    if (!ctx) return;
    clear(ctx);

    /* 两个 fade 分开：游戏内容在冻结态收束到 6%，菜单入口保持恒亮。
     * 本册 MENU 态用 1（6% 隐藏档），与其余四册的 0.55 不同 —— 别统一。 */
    const loadingFade = launchFade(now, this.loadingAt);
    const contentFade = (this.state === S.MENU || this.state === S.CONT) ? 1
      : this.state === S.LOADING ? loadingFade
      : this.state === S.READY ? 1    // S.READY 游玩提示：同隐藏档（v1.52）
      : this.state === S.OVER ? 1 : 0;   // B5 结束弹窗：其余元素退至 6% 隐藏档
    const entryFade = this.state === S.CONT ? 1
      : this.state === S.LOADING ? loadingFade : 0;

    drawCourt(ctx);
    /* 留白招租卡片：**钉在游戏世界上**，随相机一起滑动 —— 相机居中时
     * 它落在裁剪窗之外被 clip 掉（**看不见**），转头把画面推走后才滑进
     * 那一侧新露出的空白里（与边界墙「滑出窗即被裁」同一套机制）。 */
    drawAdCards(ctx, AD.cam, this.bk ? camDxBricks(this.bk) : 0, 0, 1 - contentFade);
    if (this.bk) drawBricks(this.bk, ctx, contentFade);

    if (this.state === S.MENU || this.state === S.LOADING || this.state === S.CONT) {
      const tracking = this.state === S.MENU || this.state === S.LOADING;
      const ox = tracking ? snap.x : 0;
      const oy = tracking ? snap.y : 0;
      const laid = layoutEntries(this.menuItems, ox, oy, entryFade);
      this._lit = pickLit(laid);
      drawEntries(ctx, laid);
      if (this.state === S.MENU) {
        drawActiveCore(ctx, CENTER.x, CENTER.y);
        const remain = TOUCH.selectSuspend - (now - this.menuAt);
        drawCoreCountdown(ctx, CENTER.x, CENTER.y, Math.max(1, Math.ceil(remain / 1000)));
      } else if (this.state === S.CONT) {
        drawConfirm(ctx, {
          kind: 'cont',
          title: '游戏继续',
          subtitle: '单击立即继续 / 3 秒后自动恢复',
          remainMs: CONFIRM_MS - (now - this.contAt),
          totalMs: CONFIRM_MS,
          sweepDeg: 270,
        });
      } else {
        const k = coreFade(now, this.loadingAt);
        const t = ((now - this.loadingAt) % PULSE.cycleMs) / PULSE.cycleMs;
        const lab = clamp((loadingFade - LAUNCH_FADE.labelFrom) / (LAUNCH_FADE.labelTo - LAUNCH_FADE.labelFrom), 0, 1);
        if (k < 1) drawActiveCore(ctx, CENTER.x, CENTER.y, 1 - k);
        drawLoadingCore(ctx, CENTER.x, CENTER.y, {
          iconId: this.loadingIcon, label: this.loadingLabel, t: t,
          rings: 3, alpha: k, labelA: lab,
        });
      }
    }

    /* 左上品牌胶囊恒为游戏名（框架写），右上状态胶囊经 statusText() 改写。
     * 模态弹窗期（B5 结束 / S.READY 游玩提示）HUD 降到 48%（_hudAlpha）。 */
    drawHud(ctx, this.meta.name, this._hudStatus(), this._hudAlpha());
    this.drawOver(ctx, now);     /* B5 结束弹窗 */
    this.drawReady(ctx, now);    /* S.READY 游玩提示（v1.52） */
    flush(ctx);
  },
});
