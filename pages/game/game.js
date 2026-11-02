/* pages/game/game.js —— 游戏框架页（B1 骨架 / B2 菜单 / B3 loading / B4 继续）
 *
 * 多文件页面模式（SKILL.md §1.4 第二种）。详见 pages/index/index.js 头注。
 *
 * ⚠【v1.33 · 现状】五款游戏已全部落地各自页面，GameManifest 里再无任何入口
 * 指向本页；战绩 / 教学设置也已改指自己的二级页。**当前本页是纯模板**：
 * 落地新游戏时以它为蓝本复制四件套（或直接用 utils/gamepage.js 的 gameBase），
 * 完成后在 games.js 里把该条目的 page 指到新页面。
 * 本页保留完整可运行（含占位画面区与提示条），但不要往里加新功能 —— 改动
 * 它不会反映到任何一款已上线的游戏上。
 *
 * 【交互 v1.17】屏幕编号独立为 B 系列（原 A7~A9），与主页 A 系列互不混淆。
 * B2 菜单确认后新增 B3 loading 等待：中心不消失、显示所选功能图标（home /
 * refresh）+ 功能名标签 + 三环脉冲循环，最短显示 LOADING_MIN_MS(200ms) 后
 * 才真正执行 navigateBack / initPlay。与主页 A7 共用 utils/ring.js 的
 * drawLoadingCore，两处 loading 视觉严格对称。
 *
 * 【交互 v1.21 · B4 复活】B4 继续提示此前是一具「装好内脏、没有开关」的躯壳：
 * S.CONT 有 4 处读取（onTap / tick / render×2）、PANEL.cont 与 drawConfirm
 * 齐备、提示条文案就位，但**没有任何一处给 state 赋过 S.CONT**，contAt 也从未
 * 赋值（真机算出来是 NaN）。根因是交互 v1.2 把「菜单未点亮单击」改成直接继续
 * 游戏后，B4 的**入边被删**，从此成为孤儿状态（PRD §03 曾记「保留规格但不再
 * 触发」）。v1.21 恢复入边，且**两条出口都经 B4**：
 *   ① MENU 未点亮单击（原 v1.2 前的路径）
 *   ② MENU 挂起 15s 超时（游戏被菜单挂起了 15 秒，回场前需要缓冲）
 * 由 B4 的 3s 倒计时归零或单击 → backToPlay 统一出口回 PLAY。
 * ⚠ backToPlay 的 state 白名单必须含 CONT，否则 B4 永远退不出去。
 */

import wx from 'wx';
import { C, L, g, FRAME_MS, DUR } from '../../utils/theme.js';
import {
  CENTER, TOUCH, CONFIRM_MS, VIEWPORT, VIEWPORT_TICK, GAME_MENU_IDLE,
  HINT, PULSE, LOADING_MIN_MS, LAUNCH_FADE,
} from '../../utils/layout.js';
import {
  clear, text, textWidth, dashRect, outerCorners, flush, ticks, clamp,
  fillRoundRect, strokeRoundRect,
} from '../../utils/draw.js';
import { makeItem, layoutEntries, pickLit, drawEntries, drawActiveCore, drawCoreCountdown, drawLoadingCore, fadeTo, launchFade, coreFade } from '../../utils/ring.js';
import { drawHud } from '../../utils/hud.js';
import { startLoop, useSensorClock, stopLoop, mark, guard } from '../../utils/boot.js';
import { drawConfirm, drawRestHint } from '../../utils/overlay.js';
import { InputEngine } from '../../utils/input.js';
import { GestureTracker } from '../../utils/gesture.js';
import { getEntry } from '../../utils/games.js';
import {
  readSettings, pushScore, setPendingResult,
  markNavLanded, takeEntryGameId,
} from '../../utils/storage.js';
import * as sfx from '../../utils/sfx.js';


const S = { PLAY: 'PLAY', MENU: 'MENU', CONT: 'CONT', LOADING: 'LOADING' };

/* B3 返回主页重试上限（宿主请求型 API 红线，同 index.js 的导航握手思路）：
 * navigateBack 只承诺「发出请求」，success 是无条件回调，不能当成功证据。
 * 落地判定用 onHide（返回成功后本页被出栈，宿主可能回调）；最多重试 3 次，
 * 用尽则回 PLAY（绝不卡死在 loading 态）。 */
const BACK_MAX_TRY = 3;
const BACK_PROBE_MS = 800;

/* 画面区占位（v1.9）：7 个功能统一进框架页，占位标题显示当前功能名。
 * 【v1.18】fade 为 0~1 的淡出进度（原布尔 dim 的推广，true=1 / false=0）：
 * B3 期间画面区与入口同步渐隐到 6%，不让大框单独"啪"地掉档。 */
function drawPlayfield(ctx, fade, name) {
  const f = fade > 0 ? (fade > 1 ? 1 : fade) : 0;
  const v = VIEWPORT;
  const cFrame = g(fadeTo(L.P24, f));
  const cCorner = g(fadeTo(L.P48, f));
  const cTick = g(fadeTo(L.P24, f));
  dashRect(ctx, v.x, v.y, v.w, v.h, cFrame, 1, [4, 4]);
  outerCorners(ctx, v.x, v.y, v.w, v.h, 12, cCorner, 1.5);
  const m = VIEWPORT_TICK;
  const my = v.y + v.h / 2;
  ctx.fillStyle = cTick;
  ctx.fillRect(240 - m / 2, v.y, m, 3);
  ctx.fillRect(240 - m / 2, v.y + v.h - 3, m, 3);
  ctx.fillRect(v.x, my - m / 2, 3, m);
  ctx.fillRect(v.x + v.w - 3, my - m / 2, 3, m);
  const a48 = fadeTo(L.P48, f), a24 = fadeTo(L.P24, f);
  if (a48 > 0.02) {
    text(ctx, name || '功能框架', 240, 148, { size: 14, weight: 400, color: g(a48) });
  }
  if (a24 > 0.02) {
    text(ctx, '功能框架占位 · 分册实现后覆盖', 240, 174, { size: 12, weight: 400, color: g(a24) });
  }
}

/* 左下角操作提示条（交互 v1.14）：与主页同一规格（HUD 品牌胶囊同高 24 /
 * 同圆角 4，左缘 x=16，底部边距 12），取代原画面中央 y=312 的裸文字行。
 * 游戏内仍是单击语义（v1.14 只改主页待机进入方式）。 */
function drawHint(ctx, s) {
  const opt = { size: HINT.size, weight: HINT.weight };
  const w = Math.ceil(textWidth(ctx, s, opt)) + HINT.padX * 2;
  fillRoundRect(ctx, HINT.x, HINT.y, w, HINT.h, HINT.r, C.p12);
  strokeRoundRect(ctx, HINT.x, HINT.y, w, HINT.h, HINT.r, C.p24, 1);
  text(ctx, s, HINT.x + HINT.padX, HINT.y + HINT.h / 2, {
    size: HINT.size, weight: HINT.weight, color: C.p72, align: 'left',
  });
}

export default {
  data: {
    bootMsg: 'boot=init',
  },

  /* 生命周期统一收进 onLoad（AIUI 契约唯一确认的页面生命周期），
   * guard 逐步护栏，断点直接显示在屏幕 bootMsg 上。 */
  onLoad(query) {
    mark(this, 'game', 'onLoad');
    const self = this;
    /* v1.13 落地握手：本页 onLoad 一旦执行就写下 landed，主页据此判定
     * 跳转真的发生（router 的 success 是无条件回调，不能当证据）。 */
    markNavLanded();
    /* gameId 优先取 url query，取不到则读 storage（v1.13 起主页改走
     * storage 传递，url 保持裸路径以避免宿主路由匹配带 query 的路径失败）。 */
    this.gameId = (query && query.gameId) || takeEntryGameId() || 'plane';
    this.meta = getEntry(this.gameId) || getEntry('plane');
    this.first = !!(query && query.first === '1');

    if (this.first) {
      guard(this, 'game', 'tut', function () {
        wx.redirectTo({ url: 'pages/calibrate/calibrate?gameId=' + self.gameId });
      });
      return;
    }

    const settings = guard(this, 'game', 'cfg', function () {
      const s = readSettings();
      sfx.applySettings(s);
      return s;
    }) || { sensitivity: 'standard', sfxOn: true };

    this.engine = guard(this, 'game', 'engine', function () {
      return new InputEngine({ freq: 60, sensitivity: settings.sensitivity });
    });

    this.menuItems = guard(this, 'game', 'menu', function () {
      /* v1.9：菜单标签按功能类型——游戏类「重新游戏」，战绩/教学设置类「重新进入」 */
      const restartName = self.meta.kind === 'system' ? '重新进入' : '重新游戏';
      return [
        makeItem('L', GAME_MENU_IDLE.L, { id: 'home', name: '退回主页面', iconId: 'home', kind: 'home' }, 0),
        makeItem('R', GAME_MENU_IDLE.R, { id: 'restart', name: restartName, iconId: 'refresh', kind: 'restart' }, 0),
      ];
    }) || [];

    /* ⚠ 本函数开头已有 `const self = this;`（第 76 行）。此处曾重复声明，
     * 同一函数作用域内 const 重名 = SyntaxError，整个 game.js 模块解析失败
     * ——页面根本加载不起来（真机表现为"跳过去却是空的/直接回退"）。
     * 该 bug 是 v1.13~v1.16「框架页进不去」排查被带偏的隐藏放大器之一：
     * 导航握手再正确，目标页模块若解析失败同样看不到内容。
     * 现已修正；改动本文件时务必重跑 tests/navsim 的页面级回归。 */
    this.gesture = guard(this, 'game', 'gest', function () {
      return new GestureTracker({
        onTap: function () { self.onTap(); },
        onCancel: function () { self.backToPlay(); },
      });
    });

    guard(this, 'game', 'initPlay', function () { self.initPlay(); });

    guard(this, 'game', 'ctx', function () {
      self.ctx = wx.createCanvasContext('stage');
      if (!self.ctx) throw new Error('createCanvasContext returned null');
    });

    guard(this, 'game', 'sensor', function () {
      if (self.engine) self.engine.start();
    });

    guard(this, 'game', 'loop', function () {
      self.loop = startLoop(self, 'game', FRAME_MS);
      if (!self.loop) useSensorClock(self, self.engine, 'game');
    });
  },

  /* 保留空实现防重复初始化 */
  onReady() {
    mark(this, 'game', 'onReady');
  },
  onShow() {
    this._hidden = false;
    if (this.first) return;
    if (this.engine && !this.engine.running) this.engine.start();
    this.backToPlay();
  },
  onHide() {
    /* B3 返回落地判定的补充证据：navigateBack 成功后本页被出栈，
     * 宿主可能回调 onHide（契约只确认 onLoad，按「有则调、无则跳」处理）。 */
    this._hidden = true;
    if (this.gesture) this.gesture.cancel();
    if (this.engine) this.engine.stop();
  },
  onUnload() {
    stopLoop(this);
    if (this.gesture) this.gesture.cancel();
    if (this.engine) this.engine.stop();
  },

  initPlay() {
    this.state = S.PLAY;
    this.restFrames = 0;
    this.restShown = false;
    this.demoT = 0;
  },

  onKeyDown(event) { this.gesture.onKeyDown(event); },
  onKeyUp(event) { this.gesture.onKeyUp(event); },

  /* ── 交互 v1.2（宿主双击退出不可拦截，全单击语义）──
   * 游戏中单击 = 唤出菜单（IMU 异常时头控选择不可用：
   *   游戏类走「结束游戏」逃生出口；战绩/教学设置类直接返回主页）；
   * 菜单态：点亮单击 = 确认；未点亮单击 = 继续游戏；15s 无操作自动复位。 */
  onTap() {
    /* B4 单击 = 立即恢复本局。走 backToPlay 统一出口（解冻漂移 + recenter），
     * 不要裸写 this.state —— 否则头控偏移不解冻、入口位置不回中。 */
    if (this.state === S.CONT) { this.backToPlay(); return; }
    if (this.state === S.PLAY) {
      if (!this.engine.imuOk) {
        /* v1.9：system 类（战绩/教学设置）无游戏结束语义，IMU 异常直接回主页 */
        if (this.meta.kind === 'system') {
          wx.navigateBack();
          return;
        }
        this.finishGame(this.buildResult(false));
        return;
      }
      this.engine.resetBase();
      this.engine.freezeDrift(true);
      this.state = S.MENU;
      this.menuAt = Date.now();
      sfx.play('select');
      return;
    }
    /* 菜单态单击（交互 v1.17）：点亮项 = 确认并进入 B3 loading；
     * 未点亮 = 继续游戏。loading 态单击无语义（无操作空间）。 */
    if (this.state === S.MENU) {
      const lit = this._lit;
      /* v1.21：未点亮单击 = 取消菜单 → 先落 B4 继续提示（3s 倒计时 / 单击
       * 立即恢复），不再直接回 PLAY。这是 B4 的第一条触发路径；v1.2~v1.20
       * 期间此处是 backToPlay()，B4 因此没有入边。 */
      if (!lit) { this._beginCont(); return; }
      /* v1.18：确认后**不再 recenter**（与主页 A4 → A6 同处理）。旧实现把
       * 头控偏移清零，两个菜单项当帧跳回待机位；现在 B3 全程持续消费 IMU，
       * 菜单项位置锁定在头部坐标系，只做亮度渐隐。 */
      this.engine.freezeDrift(false);
      this._beginLoading(lit.meta.kind, lit.meta.iconId, lit.meta.name);
      return;
    }
  },

  /* B3 loading 等待（交互 v1.17，与主页 A6/A7 同模式）：确认已被接受，
   * 中心不消失并承载「已确认」——r19 底圆 + r26 强调环 + 所选功能图标
   * （home 退回主页面 / refresh 重新游戏）+ 中心下方功能名标签 + 三环脉冲
   * 循环扩散；最短显示 LOADING_MIN_MS 后才执行真正的目标动作：
   *   home    → navigateBack()（宿主请求型 API，需落地握手 + 有限重试）
   *   restart → initPlay()（本页内重置，无需握手）
   * 与主页对称：A4 → A6 → A7 → B1，B2 → B3 → 目标。 */
  _beginLoading(kind, iconId, label) {
    this.loadingKind = kind;
    this.loadingIcon = iconId;
    this.loadingLabel = label;
    this.loadingAt = Date.now();
    this._loadingDone = false;
    this._backTried = 0;
    this._backAt = 0;
    this.state = S.LOADING;
    sfx.play('confirm');
  },

  /* 宿主请求型 API 红线：navigateBack 的 success 是无条件回调（官方契约只
   * 承诺发出请求），故成败靠落地判定——返回成功后本页被出栈，宿主可能回调
   * onHide（_hidden 置位）。未命中则每 BACK_PROBE_MS 重试，最多 3 次。 */
  _requestBack() {
    const self = this;
    if (typeof wx.navigateBack !== 'function') { this._backFailed(); return; }
    try {
      wx.navigateBack({
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

  /* 返回未被受理：配额内继续重试；用尽则回 PLAY 并停手——绝不让用户卡在
   * loading 态（逃生口：宿主「双击触控板 = 退出程序」恒可用，见交互 v1.2）。 */
  _backFailed() {
    if ((this._backTried || 0) >= BACK_MAX_TRY) {
      this._backAt = 0;
      this.initPlay();
      return;
    }
    this._requestBack();
  },

  /* 回到游戏的**统一出口**（v1.21 明确）：解冻头控漂移 + recenter + state 归 PLAY。
   * 调用方分两类——
   *   不经 B4 的即时回场：onShow / onCancel / MENU 态 IMU 异常 / B3 重试用尽；
   *   经 B4 后的回场：B4 单击 与 B4 3s 超时（见 onTap / tick）。
   * ⚠ state 白名单**必须含 CONT**：v1.21 前 CONT 没有入边、永远进不去，所以
   *   这里漏掉 CONT 不会有任何症状；一旦 B4 可触发，漏它就是死锁点——B4 既
   *   超时不掉、单击也不走。 */
  backToPlay() {
    if (this.engine) { this.engine.freezeDrift(false); this.engine.recenter(); }
    if (this.state === S.MENU || this.state === S.CONT) this.state = S.PLAY;
  },

  /* B4 继续提示（交互 v1.21 · 复活）。
   * 与 B3 loading 的区别：B3 是「已确认、正在去某处」（要导航 / 重置），
   * B4 是「哪儿也不去，只是告诉你游戏要接着跑」。故 B4 不播 confirm 音、
   * 不做导航、不改 freezeDrift（沿用菜单的冻结态，入口位置保持锁定）。
   * 只需落 state + 计时起点，其余交给 render 的现有分支。 */
  _beginCont() {
    this.state = S.CONT;
    this.contAt = Date.now();
  },

  /* 顶部标题栏 · 右上状态胶囊文案（交互 v1.22 预留点）。
   * 优先级：① 本册挂载的 statusText() → ② B3 loading「状态：打开中」
   * → ③ IMU 健康状态（v1.21 及以前的唯一来源）。
   * 圆点沿用 hud.js 语义：实心 = 正常 / 进行中，空心 = 异常。
   * ⚠ statusText 必须是**可选**钩子：未挂载时行为与 v1.21 逐字一致，且不得
   *   因为它未定义而抛错——AIUI 单线程下 render 抛错 = 整帧绘制中断、画面
   *   直接卡住。故用 typeof 守卫 + 空串回落。 */
  _hudStatus() {
    if (typeof this.statusText === 'function') {
      const t = this.statusText();
      if (t) return { text: t, dot: this.engine ? this.engine.imuOk : true };
    }
    if (this.state === S.LOADING) return { text: '状态：打开中', dot: true };
    const ok = this.engine ? this.engine.imuOk : false;
    return { text: ok ? 'IMU状态正常' : 'IMU状态异常', dot: ok };
  },

  tick() {
    const now = Date.now();
    const dt = Math.min(100, now - (this._last || now));
    this._last = now;
    const snap = this.engine.update(dt);
    this.gesture.tick(now);

    if (this.state === S.MENU) {
      if (!this.engine.imuOk) this.backToPlay();
      else if (now - this.menuAt > TOUCH.selectSuspend) {
        /* 菜单态 15s 无确认自动复位（PRD §06 挂起分支，交互 v1.1）。
         * v1.21：复位前先落 B4 继续提示——游戏已被菜单挂起整整 15s，直接
         * 砸回画面会很突兀，"要继续了"需要一个缓冲。第二条触发路径。 */
        this._beginCont();
      }
    }
    /* B3 loading：最短显示期结束后才执行目标动作（补足节拍，避免"点了没反应"） */
    if (this.state === S.LOADING && !this._loadingDone
        && now - this.loadingAt >= LOADING_MIN_MS) {
      this._loadingDone = true;
      if (this.loadingKind === 'home') this._requestBack();
      else this.initPlay();
    }
    /* 返回落地判定：onHide 命中即成功；否则每 BACK_PROBE_MS 重试，配额用尽回 PLAY */
    if (this.state === S.LOADING && this._loadingDone && this.loadingKind === 'home'
        && this._backAt && !this._hidden && now - this._backAt >= BACK_PROBE_MS) {
      this._backFailed();
    }
    /* B4 3s 倒计时归零 → 自动恢复本局（v1.21：走 backToPlay 统一出口） */
    if (this.state === S.CONT && now - this.contAt > CONFIRM_MS) this.backToPlay();

    if (this.state === S.PLAY) {
      if (snap.ok && (snap.x !== 0 || snap.y !== 0)) this.restFrames++;
      if (this.restFrames > 300 && !this.restShown) this.restShown = true;
      this.demoT += dt / DUR.struct;
    }

    this.render(now, snap);
  },

  render(now, snap) {
    const ctx = this.ctx;
    if (!ctx) return;
    clear(ctx);
    /* B3 loading 与 B4 继续提示：画面区与入口统一降至 6% 隐藏（同 A5 下层） */
    /* v1.18：B3 的淡出进度（0 = 菜单按分档可见，1 = 收束至 6% 隐藏档）。
     * B4 继续提示沿用瞬时收束（浮层出现本身就是瞬时的）；B3 与主页 A6/A7
     * 共用同一条节拍曲线（launchFade），两处节奏严格一致。 */
    const fade = this.state === S.CONT ? 1
      : this.state === S.LOADING ? launchFade(now, this.loadingAt) : 0;
    drawPlayfield(ctx, fade, this.meta.name);

    if (this.state === S.MENU || this.state === S.LOADING || this.state === S.CONT) {
      /* v1.18：LOADING 同样消费头控偏移 —— 淡出期间待选项位置锁定，不回中 */
      const tracking = this.state === S.MENU || this.state === S.LOADING;
      const ox = tracking ? snap.x : 0;
      const oy = tracking ? snap.y : 0;
      const laid = layoutEntries(this.menuItems, ox, oy, fade);
      this._lit = pickLit(laid);
      drawEntries(ctx, laid);
      if (this.state === S.MENU) {
        /* v1.19：与主页 A3 同一规格——单圈 + 光晕，圈内显示菜单态剩余秒数
         * （15s 无确认自动回游戏）。判定虚线圈已删。 */
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
        /* B3 菜单确认 loading：激活中心以 (1-k) 淡出、loading 核心以 k 淡入
         * （与主页 A6 同一套交叉淡入，coreXMs 内两者同场）；三环脉冲自始
         * 就是满配（B2 → B3 没有 A6 那种「脉冲初起」阶段），功能名沿淡出
         * 进度渐入。与主页 A7 共用 drawLoadingCore，视觉严格对称。
         * 注意用 this.loadingIcon 而非 _lit：淡出过半后 pickLit 恒为 null。 */
        const k = coreFade(now, this.loadingAt);
        const t = ((now - this.loadingAt) % PULSE.cycleMs) / PULSE.cycleMs;
        const lab = clamp((fade - LAUNCH_FADE.labelFrom) / (LAUNCH_FADE.labelTo - LAUNCH_FADE.labelFrom), 0, 1);
        if (k < 1) drawActiveCore(ctx, CENTER.x, CENTER.y, 1 - k);
        drawLoadingCore(ctx, CENTER.x, CENTER.y, {
          iconId: this.loadingIcon, label: this.loadingLabel, t: t,
          rings: 3, alpha: k, labelA: lab,
        });
      }
    } else {
      if (this.restShown) drawRestHint(ctx);
    }

    /* hud.js v1.4 新签名：游戏页保留 IMU 健康显示语义；
     * 交互 v1.17：B3 loading 态改显示「状态：打开中」，与主页 A7 一致。
     * 【交互 v1.22 · 标题栏状态预留】右上状态胶囊默认承载**框架自身状态**；
     * 游戏模块挂载 statusText() 后即改写为**本局状态信息**（波次 / 剩余目标
     * / 弹药等）。这是游戏逻辑**唯一**允许改写 HUD 的入口——左上品牌胶囊
     * 恒为游戏名、中段空档归本册自由排布，两者都不提供覆写。 */
    drawHud(ctx, this.meta.name, this._hudStatus());
    /* 交互 v1.14/1.17：左下角常驻操作提示（与主页同规格） */
    const hint = (this.state === S.MENU)
      ? (this._lit ? '单击触控确认选择' : '转头选择，单击返回游戏')
      : (this.state === S.CONT ? '单击触控立即继续'
        : (this.state === S.LOADING ? '正在打开…' : '单击触控唤出菜单'));
    drawHint(ctx, hint);
    flush(ctx);
  },

  buildResult(cleared) {
    const m = this.engine ? this.engine.stats.toMotion() : {};
    return {
      score: 0,
      cleared: !!cleared,
      reachedLevel: 1,
      durationSec: Math.round((Date.now() - (this._startAt || Date.now())) / 1000),
      motion: {
        yawUtil: m.yawUtil || 0,
        pitchUtil: m.pitchUtil || 0,
        yawAmpDeg: m.yawAmpDeg || 0,
        pitchAmpDeg: m.pitchAmpDeg || 0,
        tapCount: m.tapCount || 0,
        tapLatencyMs: m.tapLatencyMs || 0,
      },
      extra: [],
    };
  },

  finishGame(result) {
    const isRecord = pushScore(this.gameId, result);
    setPendingResult({
      gameId: this.gameId,
      name: this.meta.name,
      isRecord: isRecord,
      result: result,
    });
    wx.redirectTo({ url: 'pages/result/result' });
  },
};