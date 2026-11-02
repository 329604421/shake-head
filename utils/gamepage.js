/* gamepage.js —— 游戏页共享底座（B1 骨架 / B2 菜单 / B3 loading / B4 继续 / B5 结束弹窗）
 *
 * 【为什么有这个文件】
 * 五款游戏各自复制了框架页 90% 的代码（onLoad 护栏链、生命周期、B2/B3/B4 状态机、
 * 返回握手、HUD 状态、结算落盘），累计约 1100 行逐字重复。任何一处框架改动都要
 * 改五遍，漏改一处就是「某一款游戏的菜单退不出去」这类只在真机才暴露的差异。
 * 本文件把这些**零差异**的部分收敛为 `gameBase(cfg)`，各页只保留自己的差异。
 *
 * 【为什么 tick / render / onTap / statusText 不在这里】
 * harness 的「源码契约锁」（P5 / P7 / P8 组）会直接扫页面源码，锁死各分册的
 * 差异点：两个 fade 必须分开、MENU_FADE 的取值、update() 必须在 rel() 之前、
 * 无 grantGrace 等。这些锁是**刻意**设计的防漂移机制，重构不得绕过它们。
 * 故本底座只收「无任何分册差异」的部分，差异代码一律留在页面里。
 *
 * 【页面接入方式】
 *   export default Object.assign({}, gameBase({ ...cfg }), {
 *     statusText() { ... },      // 右上状态胶囊钩子（可选）
 *     onTap(el)   { ... },       // 单击分流（各册不同）
 *     tick()      { ... },       // 推进 + 渲染调度
 *     render(now, snap) { ... }, // 画面（含双 fade，受源码锁保护）
 *   });
 * ⚠ 用 Object.assign 而非对象展开 `...`：展开是 ES2018 语法，Craft 打包器
 *   不保证支持；Object.assign 是 ES2015 运行时 API，与项目现有语法同级。
 */

import wx from 'wx';
import { C, FRAME_MS, g } from './theme.js';
import { VIEWPORT, VIEWPORT_TICK, GAME_MENU_IDLE, AD, OVER, READY } from './layout.js';
import { dashRect, outerCorners, clamp } from './draw.js';
import { drawBrandWall } from './brandwall.js';
import { drawTerminal, makeConfetti, drawReady as drawReadyBox } from './overlay.js';
import { makeItem } from './ring.js';
import { startLoop, useSensorClock, stopLoop, mark, guard } from './boot.js';
import { InputEngine } from './input.js';
import { GestureTracker } from './gesture.js';
import { getEntry } from './games.js';
import {
  readSettings, pushScore, setPendingResult, markNavLanded, takeEntryGameId,
} from './storage.js';
import * as sfx from './sfx.js';
/* v1.48：音效默认生效。v1.47 真机证实 `import 'audio'` 可解析（进设置页后
 * 全程有声），故把注入从 settings 页下放到**游戏底座**——五款游戏页无需
 * 先进设置页即可出声。settings 页仍保留同一注入（它还要承载音效诊断）。 */
import host from './audio-host.js';

/* 游戏页六态（各册同名同值，harness 大量断言 page.state 字符串，勿改）
 * 【v1.40 · 新增 OVER】玩法结束（通关 / 失败）先落在本页的通用结束弹窗上
 * （撒花 / GAME OVER + 5s 倒计时），再离开；此前 finished 直接 redirectTo
 * 结算页，玩家看不到"这局赢了还是输了"。
 * 【v1.52 · 新增 READY】开局 / 重开先落的**游玩提示**弹窗（说明 + 操作 +
 * 「调整好头部位置，单击触控开始」）。此前进页即起采即开跑，而用户往往
 * 还保持着上一屏选游戏时的头部姿态 ⇒ 开局就偏。本态**只渲染不推进玩法**，
 * 且**不自动关闭**——单击才以当前姿态重建 IMU 基准 + 3s 倒计时 → PLAY。 */
export const S = {
  PLAY: 'PLAY', MENU: 'MENU', CONT: 'CONT', LOADING: 'LOADING',
  OVER: 'OVER', READY: 'READY',
};

/* 模态弹窗期 HUD 的降级亮度（OVER / READY 共用：弹窗是模态的，其余元素
 * 退居次要层）。常量名保留 OVER_ 前缀以免改坏既有引用点。 */
export const OVER_HUD_ALPHA = 0.48;

/* B3 返回主页重试上限（宿主请求型 API 红线，同 index.js 的导航握手思路）：
 * navigateBack 只承诺「发出请求」，success 是无条件回调，不能当成功证据。
 * 落地判定用 onHide；最多重试 3 次，用尽则回 PLAY（绝不卡死在 loading 态）。 */
export const BACK_MAX_TRY = 3;
export const BACK_PROBE_MS = 800;

/* 画面区边框（C-FRM-05：由页面绘制，玩法模块不得重绘）。
 * 五款游戏此函数**逐字相同**，故收敛至此。相对框架页 drawPlayfield 的差别：
 * 不画占位文案，且恒为常亮 —— 框架资产在 B2 冻结期保持正常亮度。
 * ⚠ 玩法模块内部另有**世界层**的边界墙（随相机滑动），与本框是两回事：
 *   本框界定「画面区」，世界墙界定「战场」。两者不可互相替代。 */
export function drawCourt(ctx) {
  const v = VIEWPORT;
  dashRect(ctx, v.x, v.y, v.w, v.h, C.p24, 1, [4, 4]);
  outerCorners(ctx, v.x, v.y, v.w, v.h, 12, C.p48, 1.5);
  const m = VIEWPORT_TICK;
  const my = v.y + v.h / 2;
  ctx.fillStyle = C.p24;
  ctx.fillRect(240 - m / 2, v.y, m, 3);
  ctx.fillRect(240 - m / 2, v.y + v.h - 3, m, 3);
  ctx.fillRect(v.x, my - m / 2, 3, m);
  ctx.fillRect(v.x + v.w - 3, my - m / 2, 3, m);
}

/* 留白区品牌广告墙（v1.35 引入 · **v1.36 改为钉在世界层** · v1.53 改为品牌墙）
 *
 * ⚠ 墙**不是屏幕固定层**：它用世界坐标作画，随相机一起滑动。相机居中时
 *   它落在 cfg.clipL~clipR 之外被 clip 掉（**看不见**），转头把画面推走后
 *   才滑进视野 —— 这正是用户要的"刚进游戏看不见，转头才看得到"。
 *
 * 参数：
 *   cfg   AD.cam（四款相机版）/ AD.maze（滚球迷宫）—— 含 clip 区与世界坐标
 *   dx/dy 世界 → 屏幕的绘制偏移：四款 = camDx(g)（仅横轴）；
 *         滚球迷宫 = worldOffset(g.cam)（双轴）
 *   fade  可见度（1 = 全亮）。各页传 `1 − contentFade`，让墙与世界层
 *         同进同退（B2 菜单期世界内容淡出，墙也跟着淡出）。
 *
 * 实现要点：自己 save → clip → translate → 画 → restore，不侵入玩法模块的
 * 世界层变换，五个页面各接一行即可。
 * ⚠ **可见区间要减 dx**：clip 在 translate 之前生效（屏幕坐标），translate
 *   之后画图用的是世界坐标，故本地可见区间 = [clipL − dx, clipR − dx]。
 */
export function drawAdCards(ctx, cfg, dx, dy, fade) {
  const a = clamp(fade === undefined ? 1 : fade, 0, 1);
  if (a <= 0) return;
  const col = function (base) { return g(base * a); };
  const offX = dx || 0;
  const o = {
    cols: AD.cols, rows: AD.rows, cellW: AD.cellW, cellH: AD.cellH,
    logoD: AD.logo, boxW: AD.box, r: AD.r,
    fill: col(AD.logoA), stroke: col(AD.strokeA),
    visL: cfg.clipL - offX, visR: cfg.clipR - offX,
  };
  ctx.save();
  ctx.beginPath();
  ctx.rect(cfg.clipL, VIEWPORT.y, cfg.clipR - cfg.clipL, VIEWPORT.h);
  ctx.clip();
  ctx.translate(offX, dy || 0);
  /* 右墙整体循环移位 +2：避免左右墙同相位看起来像镜像 */
  drawBrandWall(ctx, cfg.xL, cfg.y, o);
  o.shift = 2;
  drawBrandWall(ctx, cfg.xR, cfg.y, o);
  ctx.restore();
}

/* cfg 字段：
 *   tag      页面日志/诊断标识（'brick' / 'egg' / …）
 *   gameId   本页默认 gameId（url query 与 storage 都取不到时的兜底）
 *   field    玩法状态对象挂在页面上的属性名（'bk' / 'eg' / 'mb' / 'ms' / 'pl'）
 *   create   玩法模块 create
 *   result   玩法模块 result
 *   sfxOf    玩法事件 → 音效 key 映射
 *   terminal 除 'finished' 外**同样触发结算**的事件（打砖块的挂机保护 'idle'）
 *   tapRole  'fire' 时把滑动通道注册给菜单（单击留给游戏动作）
 *   onTapCb  额外的 gesture 回调（如不需要可缺省）
 */
export function gameBase(cfg) {
  const F = cfg.field;

  return {
    data: { bootMsg: 'boot=init' },

    onLoad(query) {
      const self = this;
      mark(this, cfg.tag, 'onLoad');
      /* v1.13 落地握手：本页 onLoad 一旦执行就写下 landed，主页据此判定
       * 跳转真的发生（router 的 success 是无条件回调，不能当证据）。 */
      markNavLanded();
      /* gameId 优先取 url query，取不到则读 storage（主页改走 storage 传递，
       * url 保持裸路径以避免宿主路由匹配带 query 的路径失败）。 */
      this.gameId = (query && query.gameId) || takeEntryGameId() || cfg.gameId;
      this.meta = getEntry(this.gameId) || getEntry(cfg.gameId);
      this.first = !!(query && query.first === '1');

      if (this.first) {
        guard(this, cfg.tag, 'tut', function () {
          wx.redirectTo({ url: 'pages/calibrate/calibrate?gameId=' + self.gameId });
        });
        return;
      }

      const settings = guard(this, cfg.tag, 'cfg', function () {
        /* v1.48：先注入宿主音频构造器，再读设置——音效无需先进设置页 */
        try {
          if (host && (host.Sound || host.AudioPlayer)) sfx.injectAudio(host);
        } catch (e) { /* 注入失败保持静默降级 */ }
        const s = readSettings();
        sfx.applySettings(s);
        return s;
      }) || { sensitivity: 'standard', sfxOn: true };

      this.engine = guard(this, cfg.tag, 'engine', function () {
        return new InputEngine({ freq: 60, sensitivity: settings.sensitivity });
      });

      this.menuItems = guard(this, cfg.tag, 'menu', function () {
        return [
          makeItem('L', GAME_MENU_IDLE.L, { id: 'home', name: '退回主页面', iconId: 'home', kind: 'home' }, 0),
          makeItem('R', GAME_MENU_IDLE.R, { id: 'restart', name: '重新游戏', iconId: 'refresh', kind: 'restart' }, 0),
        ];
      }) || [];

      this.gesture = guard(this, cfg.tag, 'gest', function () {
        const cb = {
          onTap: function (el) { self.onTap(el); },
          onCancel: function () { self.backToPlay(); },
        };
        /* tapRole='fire'：单击给游戏动作，B2 菜单改由**滑动**唤出 */
        if (cfg.tapRole === 'fire') cb.onSwipe = function () { self.onSwipe(); };
        return new GestureTracker(cb);
      });

      guard(this, cfg.tag, 'initPlay', function () { self.initPlay(); });

      guard(this, cfg.tag, 'ctx', function () {
        self.ctx = wx.createCanvasContext('stage');
        if (!self.ctx) throw new Error('createCanvasContext returned null');
      });

      guard(this, cfg.tag, 'sensor', function () {
        if (self.engine) self.engine.start();
      });

      guard(this, cfg.tag, 'loop', function () {
        self.loop = startLoop(self, cfg.tag, FRAME_MS);
        if (!self.loop) useSensorClock(self, self.engine, cfg.tag);
      });
    },

    /* 保留空实现防重复初始化（宿主若支持 onReady，调用它不会造成副作用） */
    onReady() { mark(this, cfg.tag, 'onReady'); },

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
      /* v1.58：dispose 而非 stop —— 五款游戏各一个传感器实例，玩过的每一款
       * 都会留一份句柄；真机上表现为「玩一两个游戏之后头控变迟钝」 */
      if (this.engine) this.engine.dispose();
    },

    /* 输入通道统一入口：guard 失败时 gesture / engine 可能为 undefined，
     * 裸调会抛 ReferenceError 打断宿主事件链，故一律加存在性守卫。 */
    onKeyDown(event) { if (this.gesture) this.gesture.onKeyDown(event); },
    onKeyUp(event) { if (this.gesture) this.gesture.onKeyUp(event); },

    /* 音效播放出口。各分册页面一律经本方法播音，不必各自 import sfx
     * （F-BRK-85 等：玩法模块不得 import sfx，页面内直连同样没必要）。 */
    _play(key) { sfx.play(key); },

    /* 单击统计入口（F-Sys-07）：各页 onTap 首行调用。
     * 此前 stats.tap() 从未被接线 —— 结算页的「单击次数 / 平均延迟」恒为 0。
     * ⚠ typeof 守卫不可省：harness 的 mock engine 只提供 stats.toMotion()。 */
    _tapIn(elapsed) {
      const st = this.engine && this.engine.stats;
      if (st && typeof st.tap === 'function') st.tap(elapsed);
    },

    /* 开局 / 重开：重建玩法状态对象。
     * ⚠ B3 的 restart 分支也走这里，故必须整体重建，且 _done 一并复位
     *   （否则重开后第一帧就会被结算判定拦下、直接跳走）。
     * ⚠ _last 显式种为开局时刻：dt = now − _last，不种则第二局首帧会吃到
     *   上一局最后一帧的陈旧基准。 */
    initPlay() {
      this.state = S.PLAY;
      this._done = false;
      this._swipeAt = 0;
      this._last = Date.now();
      this[F] = cfg.create();
      /* v1.52：建局即落**游玩提示**（本方法是开局与重开的唯一出口，故
       * 「每次进入游戏 / 重新开始都弹」由这一行保证）。放在最后：上面的
       * 建状态对象若抛错，留下的是上一个 state，比半个 READY 好排查。 */
      this._beginReady();
    },

    /* ─────────── S.READY 游玩提示（v1.52） ───────────
     * 三不：不推进玩法（state≠PLAY，各册 tick 的玩法推进自然落空）、
     *      不自动关闭（无超时，只有单击能武装倒计时）、
     *      不消费头控（freezeDrift + recenter，摆头不会喂进玩法）。
     * ⚠ 传感器**保持起采**：① 宿主可能没有定时器，渲染时钟由传感器读数
     *   驱动（utils/boot.js useSensorClock），停采 = 画面静止 = 弹窗永不动；
     *   ② 弹窗期正好把融合跑热，单击时 resetBase 拿到的已是稳定读数。
     *   「启动 IMU 监控」的语义因此落在 **resetBase（以当前姿态建基准）**，
     *   而不是 stop()→start()（那会直接把真机变成静止画面）。
     *   【2026-09-08 用户确认】此方案定稿，勿改成 stop/start。 */
    _beginReady() {
      this.state = S.READY;
      this.readyAt = Date.now();
      this.armAt = 0;
      if (this.engine) { this.engine.freezeDrift(true); this.engine.recenter(); }
    },

    /* 单击 → 武装 3s 倒计时。返回 true 表示本次单击被弹窗消费。
     * ⚠ 重复单击直接吞掉（armed 后不再重置倒计时）：倒计时期间用户若
     *   习惯性连点，不应把 3 秒无限拉长。 */
    _readyTap() {
      if (this.state !== S.READY || this.armAt) return false;
      this.armAt = Date.now();
      if (this.engine) {
        if (!this.engine.running) this.engine.start();
        this.engine.freezeDrift(false);
        this.engine.resetBase();   // ← 当前头部姿态 = 中位（真正的"开始监控"）
        this.engine.recenter();
      }
      sfx.play('confirm');
      return true;
    },

    /* 倒计时到点 → 开跑。各页 tick 与 _tickOver 并列调一行即可。
     * ⚠ _last 显式重种：READY 可能停留十几秒，不重种则首帧 dt 会很大
     *   （各册虽已 Math.min(100, dt) 限幅，但这里顺手做对更省心）。 */
    _tickReady(now) {
      if (this.state !== S.READY) return;
      if (!this.armAt) return;
      if (now - this.armAt < READY.ms) return;
      this.state = S.PLAY;
      this._last = now;
      if (this.engine) { this.engine.freezeDrift(false); this.engine.recenter(); }
    },

    /* 弹窗绘制（画在 HUD 之后 = 最上层）。各页 render 末尾调用。
     * 返回 true 表示已画（页面据此把 HUD 压暗）。 */
    drawReady(ctx, now) {
      if (this.state !== S.READY) return false;
      const t = Math.max(0, now - this.readyAt);
      drawReadyBox(ctx, {
        brief: (this.meta || {}).brief || '',
        ops: (this.meta || {}).ops || [],
        armed: !!this.armAt,
        remainMs: this.armAt ? Math.max(0, READY.ms - (now - this.armAt)) : 0,
        alpha: clamp(t / READY.fadeMs, 0, 1),
      });
      return true;
    },

    /* HUD 亮度：模态弹窗期（OVER / READY）降到 48%，其余恒亮。
     * v1.52 抽出来的原因：新增 READY 后五个页面各写一遍三元表达式，
     * 漏一页就是「那一款的 HUD 在弹窗上太抢眼」。 */
    _hudAlpha() {
      return (this.state === S.OVER || this.state === S.READY) ? OVER_HUD_ALPHA : 1;
    },

    /* 滑动 → 唤出 B2 二向菜单（tapRole='fire' 的分册专用）。
     * 记下时刻供 300ms 单击抑制使用（防"滑动 + 手指残留误触"点亮菜单项）。 */
    onSwipe() {
      this._swipeAt = Date.now();
      if (this.state !== S.PLAY) return;
      if (!this.engine.imuOk) return;
      this.enterMenu();
    },

    /* 进入 B2 菜单：重校准会话基准 + 冻结漂移纠正 + 记时起点 */
    enterMenu() {
      this.engine.resetBase();
      this.engine.freezeDrift(true);
      this.state = S.MENU;
      this.menuAt = Date.now();
      sfx.play('select');
    },

    /* B3 loading 等待（与主页 A6/A7 同模式）：确认已被接受，中心不消失并
     * 承载「已确认」；最短显示 LOADING_MIN_MS 后才执行真正的目标动作：
     *   home    → navigateBack()（宿主请求型 API，需落地握手 + 有限重试）
     *   restart → initPlay()（本页内重置，无需握手） */
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
     * loading 态（逃生口：宿主「双击触控板 = 退出程序」恒可用）。 */
    _backFailed() {
      if ((this._backTried || 0) >= BACK_MAX_TRY) {
        this._backAt = 0;
        this.initPlay();
        return;
      }
      this._requestBack();
    },

    /* 回到游戏的**统一出口**：解冻头控漂移 + recenter + state 归 PLAY。
     * ⚠ state 白名单**必须含 CONT**：漏掉它就是死锁点——B4 既超时不掉、
     *   单击也不走（v1.21 的教训）。有回场保护的分册（打飞机的无敌 1s）
     *   在页面里覆写本方法。 */
    backToPlay() {
      if (this.engine) { this.engine.freezeDrift(false); this.engine.recenter(); }
      if (this.state === S.MENU || this.state === S.CONT) this.state = S.PLAY;
    },

    /* B4 继续提示：哪儿也不去，只告诉玩家游戏要接着跑。
     * 与 B3 的区别：不播 confirm 音、不做导航、不改 freezeDrift（沿用菜单的
     * 冻结态，入口位置保持锁定）。 */
    _beginCont() {
      this.state = S.CONT;
      this.contAt = Date.now();
    },

    /* 右上状态胶囊（交互 v1.22 预留点）。
     * 优先级：① 页面挂载的 statusText() → ② B3 loading「状态：打开中」
     *   → ③ IMU 健康状态。
     * ⚠ statusText 必须是**可选**钩子：未挂载时不得抛错——AIUI 单线程下
     *   render 抛错 = 整帧绘制中断、画面直接卡住。故用 typeof 守卫 + 空串回落。 */
    _hudStatus() {
      if (typeof this.statusText === 'function') {
        const t = this.statusText();
        if (t) return { text: t, dot: this.engine ? this.engine.imuOk : true };
      }
      if (this.state === S.LOADING) return { text: '状态：打开中', dot: true };
      const ok = this.engine ? this.engine.imuOk : false;
      return { text: ok ? 'IMU状态正常' : 'IMU状态异常', dot: ok };
    },

    /* 玩法事件 → 播音 / 结算。
     * ⚠ _finish 必须幂等：一局内 finished 可能被后续帧重复投递，
     *   redirectTo 发两次会让结算页被压栈两遍。 */
    _handleEvents(events) {
      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        if (e === 'finished') { this._finish(); continue; }
        if (cfg.terminal && cfg.terminal.indexOf(e) >= 0) { this._finish(); continue; }
        const key = cfg.sfxOf ? cfg.sfxOf[e] : null;
        if (key) sfx.play(key);
      }
    },

    _finish() {
      if (this._done) return;
      this._done = true;
      /* v1.40：不再直接跳结算页 —— 先落成绩，再进通用结束弹窗 */
      this._beginOver(this._record().cleared);
    },

    /* 通关 / 失败弹窗（S.OVER）入口。
     * ⚠ 不播音：'clear' / 'over' / 'fail' 等音效已由玩法事件在结束前的那一帧
     *   投出，这里再补一声会连成两响。
     * ⚠ 撒花粒子在**此刻**一次性生成（不是每帧随机，见 overlay.makeConfetti）。 */
    _beginOver(cleared) {
      this.overAt = Date.now();
      this.overCleared = !!cleared;
      this.confetti = cleared ? makeConfetti() : null;
      this.state = S.OVER;
    },

    /* OVER 态推进：到点自动回主页（走 B3 返回握手，与 B2 菜单的 home 同路径）。
     * 各页 tick 在 CONT 判定之后调用一行即可。 */
    _tickOver(now) {
      if (this.state !== S.OVER) return;
      if (now - this.overAt >= OVER.ms) this._overHome();
    },

    /* 未过 5 秒单击 → 立刻回主页（与倒计时同一出口，避免两条离开路径）。 */
    _overHome() {
      this._beginLoading('home', 'home', '返回主页');
    },

    /* 结束弹窗绘制（画在 HUD 之后 = 最上层）。各页 render 末尾调用。
     * 返回 true 表示已画（页面据此把 HUD 压暗）。 */
    drawOver(ctx, now) {
      if (this.state !== S.OVER) return false;
      const t = Math.max(0, now - this.overAt);
      drawTerminal(ctx, {
        cleared: this.overCleared,
        confetti: this.confetti,
        t: t,
        remainMs: OVER.ms - t,
        totalMs: OVER.ms,
        alpha: clamp(t / OVER.fadeMs, 0, 1),
      });
      return true;
    },

    /* GameResult 契约：motion 由引擎填、durationSec 用**游戏内时钟** g.t
     * （已排除 B2/B3/B4 冻结时长），其余由玩法模块产出。 */
    buildResult() {
      const g = this[F];
      const m = this.engine ? this.engine.stats.toMotion() : {};
      const r = g ? cfg.result(g) : { score: 0, cleared: false, reachedLevel: 1, extra: [] };
      return {
        score: r.score,
        cleared: !!r.cleared,
        reachedLevel: r.reachedLevel || 1,
        durationSec: Math.round((g ? g.t : 0) / 1000),
        motion: {
          yawUtil: m.yawUtil || 0,
          pitchUtil: m.pitchUtil || 0,
          yawAmpDeg: m.yawAmpDeg || 0,
          pitchAmpDeg: m.pitchAmpDeg || 0,
          tapCount: m.tapCount || 0,
          tapLatencyMs: m.tapLatencyMs || 0,
        },
        extra: r.extra || [],
      };
    },

    /* 成绩落盘（记录页数据源 + 结算页数据源）。返回 result 供调用方取 cleared。
     * ⚠ meta 可能缺失（harness 之外的异常路径），故用 (this.meta || {}) 兜底。 */
    _record() {
      const result = this.buildResult();
      const isRecord = pushScore(this.gameId, result);
      setPendingResult({
        gameId: this.gameId,
        name: (this.meta || {}).name,
        isRecord: isRecord,
        result: result,
      });
      return result;
    },

    /* 逃生出口（IMU 异常时的「结束游戏」）：直接进结算页，不走结束弹窗。
     * 理由：它不是通关也不是失败，显示「GAME OVER」不准确。 */
    finishGame() {
      this._record();
      wx.redirectTo({ url: 'pages/result/result' });
    },
  };
}
