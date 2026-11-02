/* pages/marble/marble.js —— 《滚球迷宫》游戏页（PRD-04 V1.0-r6 · 设计稿 722090993915783）
 *
 * 【本页的组成】
 * 通用部分（onLoad 护栏链 / 生命周期 / B2 菜单 / B3 loading / B4 继续 /
 * 返回握手 / HUD 状态 / 结算落盘）由 `utils/gamepage.js` 的 gameBase() 提供。
 * 本页只保留滚球迷宫自己的差异：
 *   ① B1 每帧推进 marble 并处理返回事件（播音 / 结算）；
 *   ② **不画左下提示条** —— 提示条是搭框架时的占位（y 316~340），
 *      真实游戏页不出现（PRD-04 §2.7.1 用户裁定）；
 *   ③ 挂载 statusText() 钩子，把右上状态胶囊改写为本局状态（F-LAB-18）；
 *   ④ **输入源多一路 rel()** —— 本作是五款中唯一采用「相对位移输入」的
 *      一款，除 snap（像素，只取 ok 位）外还需 engine.rel() 的角度通道。
 *
 * 【单击分流（本作特有）】PRD §4.1：AIM 阶段单击 = **开始游戏**（仅就绪态，
 * F-LAB-32）；PLAY 阶段单击 = **唤出 B2 二向菜单**（F-LAB-34）。
 *   ⚠ 这与 eggcatch / brick 的「PLAY 态单击一律唤菜单」不同 —— 本作在
 *     PLAY state 下还要按玩法 phase 再分流一次，别照抄。
 *
 * 【两个 fade 必须分开，且 B2 不用 6%】
 *   contentFade 给游戏内容：MENU 态 = **0.55**（退至次要层，PRD-04 §2.6.4）；
 *   entryFade  给菜单入口：MENU 态 = 0（菜单自身必须恒亮）。
 *   取 0.55 而非 1（6% 隐藏档）的理由见下方 MENU_FADE 注释。
 *   ⚠ 这两个变量受 harness P5 源码契约锁保护，不得重构成共享实现。
 */

import {
  CENTER, TOUCH, CONFIRM_MS, PULSE, LOADING_MIN_MS, LAUNCH_FADE, MARBLE, AD,
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
  create as createMarble, update as stepMarble, render as drawMarble,
  result as marbleResult, tryLaunch, PH,
  worldOffset,
} from '../../utils/marble.js';

/* B2 菜单期**游戏内容**的淡出档（PRD-04 §2.6.4，与另三款同口径）：
 * 0.55 → 球 100%→48%、洞描边 72%→36%、内填充 12%→9%。
 *   **不用 1（6% 隐藏档）** 的三条理由：① 6% 语义是「本局即将离场」（B3 导航
 *   / B4 恢复），而 B2 只是**暂停快选**，玩家要看着盘面决定继续还是重开；
 *   ② 与菜单的 100% 落差过大，回场时会有突兀的亮度跳变；③ 0.55 下菜单与本册
 *   约 2:1 对比，主次已经足够清晰。
 * 框架资产（视口框 / 四角角标 / 四边刻度）与菜单元素**不参与**本收束，
 * 否则画面边框会散架、失去区域界定（B3/B4 整体退场时才与本册同步降到 6%）。 */
const MENU_FADE = 0.55;

/* 事件 → 音效映射（全部复用既有 key，**不新增**）。
 * 播音由 gameBase 的事件处理器代劳，玩法模块不得 import sfx。 */
const SFX_OF = {
  ready: 'select',    // 准星与球重合，进入就绪
  launch: 'launch',   // 起跑缓冲结束，计时起算
  suck: 'fail',       // 被黑洞吸入
  goal: 'clear',      // 抵达终点，通关
  timeout: 'fail',    // 时间耗尽
  restart: 'clear',   // 本关重开
};

export default Object.assign({}, gameBase({
  tag: 'marble', gameId: 'marble', field: 'mb',
  create: createMarble, result: marbleResult, sfxOf: SFX_OF,
}), {
  /* 右上状态胶囊钩子（F-LAB-18）：把框架状态改写为本局状态。
   *   AIM 未转头 → 「状态：待校准」｜ AIM 对准中/就绪 → 「状态：校准中」
   *   起跑缓冲起（含 PLAY / B2 / B4）→ 「状态：游戏中」
   * ⚠ IMU 异常时**主动放弃覆盖**（返回空串），交还框架显示
   *   「IMU状态异常」+ 空心圆点 —— 那是设计的双通道降级提示（设计稿 S12）。
   * ⚠ 本函数是可选钩子，框架用 typeof 守卫调用；**render() 内抛错会导致
   *   整帧卡死**（真机取证，见 AIUI-红线.md），故一律做空值防御。 */
  statusText() {
    const k = this.mb;
    if (!k) return '';
    if (k.imuDown) return '';
    if (k.phase === PH.AIM) {
      const moved = (k.cam.x !== MARBLE.AIM_CAM.x || k.cam.y !== MARBLE.AIM_CAM.y);
      return moved ? '状态：校准中' : '状态：待校准';
    }
    return '状态：游戏中';
  },

  /* 单击分流（PRD §4.1）：
   *   AIM 就绪   → 起跑缓冲（F-LAB-32，仅就绪态生效）
   *   AIM 非就绪 → 不响应（避免误触在未对准时开跑）
   *   PLAY 等    → 唤出 B2 二向菜单（F-LAB-34）
   *   IMU 异常   → 直接结束游戏（§10，优先级最高） */
  onTap(el) {
    this._tapIn(el);
    /* S.READY 游玩提示：单击 = 以当前姿态重建 IMU 基准 + 3s 倒计时（v1.52） */
    if (this.state === S.READY) { this._readyTap(); return; }
    /* B5 结束弹窗：未满 5 秒单击 → 立刻回主页（与倒计时同一出口） */
    if (this.state === S.OVER) { this._overHome(); return; }
    if (this.state === S.CONT) { this.backToPlay(); return; }

    if (this.state === S.PLAY) {
      const k = this.mb;
      /* AIM 阶段：单击 = 开始游戏。IMU 异常时不响应（无法对准，
       * 且 AIM 不计时、无伤害，D-LAB-13 让画面停留在「等待恢复」提示上）。 */
      if (k && k.phase === PH.AIM) {
        if (!this.engine.imuOk) return;
        if (tryLaunch(k)) this._play('confirm');
        return;
      }
      /* 起跑缓冲 / 回起点 / 超时过场期间不响应单击，避免打断过场 */
      if (k && (k.phase === PH.LAUNCH || k.phase === PH.RESPAWN || k.phase === PH.TIMEOUT)) return;

      /* PLAY 阶段：IMU 异常 → 单击直接结束游戏（§10） */
      if (!this.engine.imuOk) { this.finishGame(); return; }
      /* 单击**不承担任何游戏职能**，只唤出 B2 菜单（F-LAB-34） */
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

    /* ⚠ 两路输入有**严格顺序**：rel() 依赖 update() 维护的 relYaw / relPitch，
     *   必须先 update 再 rel（PRD §4.3 明确要求）。 */
    const snap = this.engine.update(dt);
    const rel = this.engine.rel(MARBLE.DEAD_DEG);
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

    /* B1 是**唯一**推进玩法的地方（冻结契约）：B2/B3/B4 只渲染最后一帧，
     * 于是 g.t 自动停走 —— 冻结与续算无需任何显式 freeze / resume。 */
    if (this.state === S.PLAY) {
      if (this.mb) this._handleEvents(stepMarble(this.mb, dt, snap, rel));
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
    /* 留白品牌墙：**双轴都钉在迷宫上**，随相机滑动 —— 墙落在迷宫矩形之外
     * 的世界坐标，迷宫铺满视口时它在视口外（**看不见**），相机把迷宫推走后
     * 它才跟着滑进那侧留白里。纵向同理钉世界（v1.54：本作相机双轴跟球，
     * 屏幕固定会上下穿帮），墙顶与迷宫顶外墙平齐（world y=0），见 layout.js
     * 的 AD.maze 注释。 */
    const adOff = this.mb ? worldOffset(this.mb.cam) : { x: 0, y: 0 };
    drawAdCards(ctx, AD.maze, adOff.x, adOff.y, 1 - contentFade);
    if (this.mb) drawMarble(this.mb, ctx, contentFade);

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
