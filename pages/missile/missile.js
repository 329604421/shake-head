/* pages/missile/missile.js —— 《导弹指挥部》游戏页（PRD-05 · 相机版 v1.32）
 *
 * 【本页的组成】
 * 通用部分（onLoad 护栏链 / 生命周期 / B2 菜单 / B3 loading / B4 继续 /
 * 返回握手 / HUD 状态 / 结算落盘）由 `utils/gamepage.js` 的 gameBase() 提供。
 * 本页只保留导弹指挥部自己的差异：
 *   ① B1 每帧推进 missile 并处理返回事件（播音 / 结算）；
 *   ② **不画左下提示条** —— 提示条是搭框架时的占位（y 316~340），
 *      真实游戏页不出现（v1.22 起五册统一取消）；
 *   ③ 挂载 statusText() 钩子，把右上状态胶囊改写为「城市 N/6」；
 *   ④ **tapRole = 'fire'**（F-MSL-72/73）：单击 = 引爆拦截雷（不是唤菜单），
 *      B2 菜单改由**滑动**唤出。与 pages/plane 同一套触控语义。
 *
 * 【本作相对打飞机的两处差异】
 *   ① **无 grantGrace**：本作没有"生命/无敌"概念，失败条件是城市全毁或
 *      炮台被毁，回场无敌保护无对应语义；
 *   ② **IMU 异常时单击 = 结束游戏**（F-MSL-75）：打飞机是静默忽略（投弹
 *      打不到无意义），本作必须给逃生出口 —— 玩法模块在 IMU 异常时全面
 *      冻结（不推进波次），若无出口玩家会被永久卡在画面上。
 *
 * 【两个 fade 必须分开，且 B2 不用 6%】
 *   contentFade 给游戏内容：MENU 态 = **0.55**（退至次要层）；
 *   entryFade  给菜单入口：MENU 态 = 0（菜单自身必须恒亮）。
 *   取 0.55 而非 1（6% 隐藏档）的三条理由见下方 MENU_FADE 注释。
 *   ⚠ 这两个变量受 harness P8 源码契约锁保护，不得重构成共享实现。
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
/* 玩法模块：update/render 与本页的 tick/render 同名，故一律别名导入。 */
import {
  create as createMissile, update as stepMissile, render as drawMissileField,
  result as missileResult, fire as missileFire, statusText as missileStatus,
  camDx as camDxMissile,
} from '../../utils/missile.js';

/* 借鉴声明（PRD-05 附录 A）：本册的「missiles[] / explosions[] 双数组 +
 * 倒序 splice 实体管理」「波次表驱动」「拦截 → 爆炸扩散 → 距离判定」三段式，
 * 参考 CC0 许可的 straker/Basic Missile Command 与 MIT 许可的
 * enzocage/Missile-Command 的**逻辑结构**，未复制其精灵图与音效资产。 */

/* B2 菜单期**游戏内容**的淡出档（与 plane / eggcatch 同口径）：
 * 0.55 → 城市描边 72%→36%、弹头 48%→24%、内填充 12%→9%。
 *   **不用 1（6% 隐藏档）** 的三条理由：① 6% 语义是「本局即将离场」（B3 导航
 *   / B4 恢复），而 B2 只是**暂停快选**，玩家要看着场上局势决定继续还是重开；
 *   ② 与菜单的 100% 落差过大，回场时会有突兀的亮度跳变；③ 0.55 下菜单与本册
 *   约 2:1 对比，主次已经足够清晰。
 * 框架资产（视口框 / 四角角标 / 四边刻度）与菜单元素**不参与**本收束，
 * 否则画面边框会散架、失去区域界定（B3/B4 整体退场时才与本册同步降到 6%）。 */
const MENU_FADE = 0.55;

/* 事件 → 音效映射（F-MSL-82：全部复用既有 key，**不新增**）。
 * 播音由 gameBase 的事件处理器代劳，玩法模块不得 import sfx。
 *   'wave'（过场开始）不播音 —— 波末的 'clear' 已经提示过一次，
 *   再响一次会连成两声。 */
const SFX_OF = {
  boom: 'boom',           // 弹头被拦截
  citydown: 'fail',       // 城市 / 炮台被毁
  fail: 'fail',           // 防线失守
  clear: 'clear',         // 过波 / 通关
};

export default Object.assign({}, gameBase({
  tag: 'missile', gameId: 'missile', field: 'ms', tapRole: 'fire',
  create: createMissile, result: missileResult, sfxOf: SFX_OF,
}), {
  /* 滑动 → 唤出 B2 二向菜单（F-MSL-22/72）。
   * 记下时刻供 F-MSL-73 的 300ms 单击抑制使用。 */
  onSwipe() {
    this._swipeAt = Date.now();
    if (this.state !== S.PLAY) return;
    if (!this.engine.imuOk) return;
    this.enterMenu();
  },

  onTap(el) {
    this._tapIn(el);
    /* S.READY 游玩提示：单击 = 以当前姿态重建 IMU 基准 + 3s 倒计时（v1.52）。
     * 刻意排在滑动抑制**之前**：弹窗期没有滑动语义，单击必须次次有响应。 */
    if (this.state === S.READY) { this._readyTap(); return; }
    const now = Date.now();
    /* F-MSL-73：滑动唤出菜单后的 300ms 内单击忽略 —— 防"滑动 + 手指残留
     * 误触"直接点亮菜单项（滑动的语义已经用掉了这一次按压）。 */
    if (now - (this._swipeAt || 0) < TOUCH.swipeSuppress) return;
    /* B5 结束弹窗：未满 5 秒单击 → 立刻回主页（与倒计时同一出口） */
    if (this.state === S.OVER) { this._overHome(); return; }

    if (this.state === S.CONT) { this.backToPlay(); return; }

    if (this.state === S.PLAY) {
      /* F-MSL-75：IMU 异常时单击 = **结束游戏**（逃生出口）。
       * 与打飞机的「静默忽略」不同：本作玩法在 IMU 异常时全面冻结
       * （不推进波次），若单击无出口，玩家会被永久卡在画面上。 */
      if (!this.engine.imuOk) { this.finishGame(); return; }
      if (this.ms && missileFire(this.ms)) this._play('launch');
      return;
    }

    if (this.state === S.MENU) {
      const lit = this._lit;
      if (!lit) { this._beginCont(); return; }
      this.engine.freezeDrift(false);
      this._beginLoading(lit.meta.kind, lit.meta.iconId, lit.meta.name);
    }
  },

  /* 右上状态胶囊钩子（§2.6.2）：把框架状态改写为「城市 N/6」——
   * 本作的"生命条"就是城市，这是玩家最该盯着的数字。
   * ⚠ 必须保留 typeof 守卫 —— render 期抛错会导致整帧卡死。
   * ⚠ IMU 异常时**主动放弃覆盖**（返回空串），交还框架显示
   *   「IMU状态异常」+ 空心圆点 —— 那是设计的双通道降级提示。 */
  statusText() {
    if (!this.ms) return '';
    if (this.ms.imuDown) return '';
    return missileStatus(this.ms);
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

    /* B1 是**唯一**推进玩法的地方（§2.6.4）：B2/B3/B4 只渲染最后一帧，
     * 于是 g.t 自动停走 —— 冻结与续算无需任何显式 freeze / resume（F-MSL-70/71）。 */
    if (this.state === S.PLAY) {
      if (this.ms) this._handleEvents(stepMissile(this.ms, dt, snap));
    }

    this.render(now, snap);
  },

  render(now, snap) {
    const ctx = this.ctx;
    if (!ctx) return;
    clear(ctx);

    /* 两个 fade 分开：游戏内容在 B2 退至次要层（0.55），菜单入口保持恒亮 */
    const loadingFade = launchFade(now, this.loadingAt);
    const contentFade = this.state === S.CONT ? 1
      : this.state === S.MENU ? MENU_FADE
      : this.state === S.LOADING ? loadingFade
      : this.state === S.READY ? 1    // S.READY 游玩提示：同隐藏档（v1.52）
      : this.state === S.OVER ? 1 : 0;   // B5 结束弹窗：其余元素退至 6% 隐藏档
    const entryFade = this.state === S.CONT ? 1
      : this.state === S.LOADING ? loadingFade : 0;

    drawCourt(ctx);
    /* 留白招租卡片：**钉在游戏世界上**，随相机一起滑动 —— 相机居中时
     * 它落在裁剪窗之外被 clip 掉（**看不见**），转头把画面推走后才滑进
     * 那一侧新露出的空白里（与边界墙「滑出窗即被裁」同一套机制）。 */
    drawAdCards(ctx, AD.cam, this.ms ? camDxMissile(this.ms) : 0, 0, 1 - contentFade);
    if (this.ms) drawMissileField(this.ms, ctx, contentFade);

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
     * B5 结束弹窗期间 HUD 降到 48%（弹窗是模态的，其余元素退居次要层）。 */
    drawHud(ctx, this.meta.name, this._hudStatus(), this._hudAlpha());
    this.drawOver(ctx, now);     /* B5 结束弹窗 */
    this.drawReady(ctx, now);    /* S.READY 游玩提示（v1.52） */
    flush(ctx);
  },
});
