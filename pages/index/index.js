/* pages/index/index.js —— 主页（A1、A3~A7 状态机，PRD-01 §03）
 *
 * 多文件页面模式（SKILL.md §1.4 第二种）：.json + .js + .wxml + .wxss
 * （Craft 预览器对单文件 .ink SFC 的模板解析静默失败，故采用四件套）
 *
 * 【交互 v1.2】宿主「双击触控板 = 退出程序」不可拦截，双击语义弃用。
 * 全单击语义：待机单击进入选择态；点亮单击确认；未点亮单击回待机。
 * 原 A2 提示屏（HINT 态）取消，操作提示并入选择态底部常驻行。
 *
 * 【交互 v1.3】待机态真·停采：IMU 传感器仅在选择态（及其后续）运行，
 * 待机 / 回待机一律 stop()（转头无效果 + 关闭监听，降功耗发热）。
 * 单击待机 → start() + 以当前姿态重立会话基准 + 进入选择态。
 *
 * 【交互 v1.4】IMU 异常不再劫持单击：待机单击**一律**进入选择态
 * （Craft 模拟器无 AbsoluteOrientationSensor 也能走查 UI）；IMU 不可用时
 * 头控输入恒为 0，选择态提示行改为「IMU 不可用 · 双击触控板退出」
 * （宿主双击=退出程序，即逃生口）。右上角 HUD 由 IMU 健康改为页面状态：
 * 待机中（空心点）/ 选择中 / 已选中。
 *
 * 【交互 v1.14】进入选择态的操作由「单击触控板」改为「滑动触控板」：
 * 待机态滑动（前/后/左/右任意方向）进入选择态；待机态单击无语义；
 * 选择态未点亮单击退回待机、点亮单击确认。滑动在框架层表现为方向键
 * （ArrowUp / ArrowDown / …），见 utils/gesture.js 文件头与 SKILL.md §4.2。
 * 操作提示条由「画面中央 288×36」移至左下角，与 HUD 品牌胶囊同高 24。
 *
 * 【交互 v1.17】A6 与 A7 拆分，动作连续性补齐（设计稿 §14.5）：
 * A4 点亮 → 单击确认 → A6 跳转脉冲（≥250ms，入口仍可见、中心出现 r19 底圆
 * + r26 强调环 + 选中功能图标 + 2 环脉冲初起）→ A7 loading 等待（入口收束
 * 至 6% 隐藏，中心保留底圆/强调环/功能图标并浮出功能名，3 环脉冲循环扩散，
 * 直到 B1 游戏框架页打开）。中心点全程不消失，承载「已确认」语义。
 * 游戏页 B2 菜单确认后走同模式的 B3 loading（utils/ring.js 共用
 * drawLoadingCore），主页 A4→A6→A7 与游戏页 B2→B3→目标严格对称。
 *
 * 生命周期：AIUI 契约唯一确认 onLoad —— 一切初始化在此完成，
 * onReady 仅保留空实现防宿主差异导致重复初始化。
 * data.bootMsg 是保留的诊断通道：boot.js 的 guard/mark 会写入，
 * 页面模板不引用；需要屏幕诊断时把 <text>{{ bootMsg }}</text> 挂回即可。
 */

import wx from 'wx';
import { FRAME_MS } from '../../utils/theme.js';
import {
  CENTER, TOUCH, CONFIRM_MS, A6_MIN_MS, RING_ORDER, HINT, PULSE, LAUNCH_FADE,
  PRIME_MS,
} from '../../utils/layout.js';
import {
  clear, textWidth, fillRoundRect, strokeRoundRect, flush, clamp,
} from '../../utils/draw.js';
import { buildItems, layoutEntries, pickLit, drawEntries, drawIdleCrosshair, drawActiveCore, drawCoreCountdown, drawLoadingCore, launchFade, coreFade } from '../../utils/ring.js';
import { drawHud, drawHint } from '../../utils/hud.js';
import { drawConfirm } from '../../utils/overlay.js';
import { InputEngine } from '../../utils/input.js';
import { GestureTracker } from '../../utils/gesture.js';
import {
  readSettings,
  armNavProbe, navLanded, setEntryGameId, storageOk,
} from '../../utils/storage.js';
import { startLoop, useSensorClock, stopLoop, mark, guard } from '../../utils/boot.js';
import * as sfx from '../../utils/sfx.js';
/* v1.47：import 'audio' 的**唯一入口**（详见 utils/audio-host.js 头注）。
 * v1.48：真机证实可解析 ⇒ 主页 onLoad 即注入，音效**开机默认生效**，
 * 无需先进设置页（此前只有 settings 页注入，故"进过设置才有声"）。 */
import host from '../../utils/audio-host.js';


const S = { IDLE: 'IDLE', SELECT: 'SELECT', EXIT: 'EXIT', LAUNCH: 'LAUNCH', LOADING: 'LOADING' };

/* v1.13 导航落地判定：router API 的 success 是无条件回调（官方契约只承诺
 * "requests"），必须靠「目标页 onLoad 写下的落地标记」判定。每发一次请求
 * 等 NAV_PROBE_MS 再验；未落地就换一档重试，最多 NAV_MAX_STEP 档。
 * v1.16：档位 = url 形态（带/不带前导斜杠 × 带/不带 ?query）× 方法
 * （navigateTo / redirectTo），共 6 档，约 3s 走完。 */
const NAV_PROBE_MS = 500;
const NAV_MAX_STEP = 6;

/* 冷启动预热时长（v1.49 上提为共享常量，见 utils/layout.js 的 PRIME_MS）。
 * 设置页同样需要它——二级页各有自己的传感器实例，永远是一次冷启动。 */

export default {
  data: {
    /* boot=init 是静态初值：若屏幕上停在这一行，说明 onLoad 从未执行
     * 或 setData 从未生效；若变成一长串 '|' 分隔的进度，即为诊断证据。 */
    bootMsg: 'boot=init',
  },

  /* 【黑屏六轮排查 · 根因】AIUI 官方文档全文只确认了 onLoad 这一个页面
   * 生命周期（SKILL.md §2.1 / §4），onReady 从未出现在任何契约文档中。
   * 此前画布初始化 + 渲染循环全放在 onReady —— 框架若不调用它，
   * ctx 永远为 null、循环永远不启动、bootMsg 永远为空，画面只剩背景色。
   * 现全部迁入 onLoad，并用 guard 逐步护栏。 */
  onLoad() {
    mark(this, 'index', 'onLoad');
    this.state = S.IDLE;
    this._last = Date.now();

    /* v1.48：开机即注入宿主音频构造器（唯一 import 'audio' 的位置），
     * 音效默认生效——不依赖用户先进设置页。 */
    guard(this, 'index', 'audio', function () {
      if (host && (host.Sound || host.AudioPlayer)) sfx.injectAudio(host);
    });

    const settings = guard(this, 'index', 'cfg', function () {
      const s = readSettings();
      sfx.applySettings(s);
      return s;
    }) || { sensitivity: 'standard', sfxOn: true };

    this.items = guard(this, 'index', 'items', function () {
      return buildItems(RING_ORDER, 0);
    }) || [];

    this.engine = guard(this, 'index', 'engine', function () {
      return new InputEngine({ freq: 60, sensitivity: settings.sensitivity });
    });

    const self = this;
    this.gesture = guard(this, 'index', 'gest', function () {
      return new GestureTracker({
        onTap: function () { self.onTap(); },
        /* 交互 v1.14：滑动触控板进入选择态（方向键通道，见 gesture.js 文件头） */
        onSwipe: function (code) { self.onSwipe(code); },
        onCancel: function () { self.resetToIdle(); },
      });
    });

    /* 画布上下文：契约确认 wx.createCanvasContext(id)，取不到返回 null */
    guard(this, 'index', 'ctx', function () {
      self.ctx = wx.createCanvasContext('stage');
      if (!self.ctx) throw new Error('createCanvasContext returned null');
    });

    /* v1.42 冷启动预热：onLoad 立刻起采，PRIME_MS 后若仍在待机则停采。
     * 这样用户第一次滑动进入选择态时，融合已完成收敛（见 PRIME_MS 注释）。
     * 失败（Craft 无传感器）不影响任何流程，照常走后续 ready 路径。 */
    guard(this, 'index', 'prime', function () {
      self._primeUntil = Date.now() + PRIME_MS;
      self.engine.start();
    });

    /* 交互 v1.3：待机态不启动传感器（真·停采），进选择态时才 start() */
    guard(this, 'index', 'loop', function () {
      self.loop = startLoop(self, 'index', FRAME_MS);
      if (!self.loop) useSensorClock(self, self.engine, 'index');
    });
  },

  /* 保留空实现：若宿主确实支持 onReady，调用它不会造成重复初始化 */
  onReady() {
    mark(this, 'index', 'onReady');
  },
  onShow() {
    this._hidden = false;
    /* v1.12：从子页返回时（navigateBack）恢复被 _pause 停掉的渲染循环 */
    if (this._loopStopped) {
      this._loopStopped = false;
      this.loop = startLoop(this, 'index', FRAME_MS);
      if (!this.loop) useSensorClock(this, this.engine, 'index');
    }
    /* v1.3：回前台一律复位到待机待采态（不主动 start 传感器） */
    this.resetToIdle();
  },
  onHide() {
    /* v1.16 第三落地通道：navigateTo 成功后主页被压栈，宿主可能回调 onHide。
     * 契约只确认 onLoad，onShow/onHide 一律按「有则调、无则跳」处理
     * （同 onReady 红线），不承载关键路径，仅作落地判定的补充证据——
     * 用于在 storage 不可用时避免把"其实跳成功了"误判成 nav:dead。 */
    this._hidden = true;
    if (this.gesture) this.gesture.cancel();
    if (this.engine) this.engine.stop();
  },
  onUnload() {
    stopLoop(this);
    if (this.gesture) this.gesture.cancel();
    /* v1.58：dispose 而非 stop（释放传感器实例，见 InputEngine.dispose） */
    if (this.engine) this.engine.dispose();
  },

  onKeyDown(event) {
    this.gesture.onKeyDown(event);
  },
  onKeyUp(event) {
    /* v1.13：宿主请求型 API 在渲染循环上下文里可能不被受理。若仍在跳转态
     * 且尚未落地，借按键事件这个宿主认可的调用栈补发一次（限流 250ms，
     * 且一旦 navLanded() 命中立即停手，避免打断已跳转的页面）。 */
    if ((this.state === S.LAUNCH || this.state === S.LOADING) && this._navStep > 0 && !this._navOk
        && !navLanded() && !this._hidden && this.target && this.target.page
        && Date.now() - this._navStepAt >= 250) {
      const p = this._navPlan(this._navStep);
      this._requestNav(p.url, p.how);
    }
    this.gesture.onKeyUp(event);
  },

  /* ── v1.13 宿主「请求型」Router API：落地握手 + 多方式重试 ──
   * 官方契约（apis-wx.md Router methods）：navigateTo / redirectTo 只
   * "requests page navigation"，且只回调 success() / complete()（无 fail）。
   * 即 success 是**无条件回调**，语义是"请求已发出"而非"页面已切换"。
   * 真机实证：回调 nav:ok，屏幕却仍停在主页 —— 完全吻合该契约。
   * 因此成败判定改为**落地握手**：主页跳转前 armNavProbe() 置 req →
   * 目标页 onLoad markNavLanded() 置 landed → 主页 tick 轮询 navLanded()，
   * 命中才算真的跳过去了；未落地则换方式重试（navigateTo→redirectTo→
   * navigateTo），每档等 NAV_PROBE_MS，全部失败才复位并取证。
   * 关键修复：v1.12 把 _pause() 挂在 success 里 —— 回调一到就停渲染循环，
   * 画面当场定格在主页，后续重试与取证全部失效，这正是"一直看到主界面"
   * 的放大器。现改为**仅在确认落地后**才暂停。 */
  /* 跳转成功后暂停本页（navigateTo 是压栈，主页并未卸载）：停渲染循环 +
   * 停 IMU，省电且避免与新页面争抢渲染；返回时由 onShow 恢复。 */
  _pause() {
    if (this.state === S.LAUNCH || this.state === S.LOADING) this.state = S.IDLE;
    stopLoop(this);
    if (this.engine) this.engine.stop();
    this._loopStopped = true;
  },

  _diag(msg) {
    console.log('[index] ' + msg);
    this._diagMsg = msg;
    this._diagAt = Date.now();
  },

  /* ── v1.16 跳转档位表：url 形态 × 方法，全组合轮换，命中即停 ──
   * 官方 apis-wx.md 只写 "navigateTo(options) requires options.url"，
   * **没有给出任何 url 格式示例**。而跨端惯例里至少存在四种形态：
   *   bare  `pages/game/game`        slash `/pages/game/game`
   *   query `pages/game/game?gameId=…`  slashQuery `/pages/game/game?gameId=…`
   * 宿主路由若做精确字符串匹配，任何一种都可能是**唯一**可用解；此前仅押注
   * bare 一种，因此一直失败却无法定位。现改为按档轮换，命中即停。
   * 顺序随 storage 可用性调整：storage 可用时优先 bare（gameId 走 storage，
   * 最干净）；不可用时优先 query（否则 gameId 会丢失）。 */
  _navPlan(step) {
    const t = this.target || {};
    const base = String(t.page || '');
    const q = base + '?gameId=' + encodeURIComponent(String(t.id || ''));
    const P = [base, '/' + base, q, '/' + q];
    const order = storageOk() ? [0, 1, 2, 3] : [2, 3, 0, 1];
    const i = (step | 0) - 1;
    const ui = [0, 1, 0, 1, 2, 3][i < 0 ? 0 : (i > 5 ? 5 : i)];
    const hi = [0, 0, 1, 1, 0, 1][i < 0 ? 0 : (i > 5 ? 5 : i)];
    return { url: P[order[ui]], how: hi === 1 ? 'redirectTo' : 'navigateTo' };
  },

  _requestNav(url, how) {
    const self = this;
    const fn = (how === 'redirectTo') ? wx.redirectTo : wx.navigateTo;
    if (typeof fn !== 'function') {
      this._diag('nav:no-api ' + how);
      return false;
    }
    try {
      fn({
        url: url,
        success: function () {
          /* 只登记"已发出"；成败交给 navLanded() 落地探针 —— 不再据此 _pause()。
           * v1.16：取证带上完整 url，真机可一眼看出是哪一档、什么形态。 */
          self._navCalled = true;
          self._diag('s' + self._navStep + ' ' + url);
        },
        fail: function (e) {
          self._navCalled = true;
          self._diag('nav:fail ' + ((e && (e.errMsg || e.message)) || '?'));
        },
        complete: function () { self._navCalled = true; },
      });
      return true;
    } catch (e) {
      this._diag('nav:throw ' + ((e && e.message) || ''));
      return false;
    }
  },

  _requestExit() {
    const self = this;
    if (this._exitTried) return;
    this._exitTried = true;
    if (typeof wx.exitMiniProgram !== 'function') {
      this._diag('exit:no-api');
      this._exitFailed = true;
      return;
    }
    try {
      wx.exitMiniProgram({
        success: function () { self._diag('exit:ok'); },
        fail: function (e) {
          self._diag('exit:fail ' + ((e && (e.errMsg || e.message)) || '?'));
          self._exitFailed = true;
        },
        complete: function () { self._exitCalled = true; },
      });
    } catch (e) {
      this._diag('exit:throw ' + ((e && e.message) || ''));
      this._exitFailed = true;
    }
    /* 兜底：宿主若不处理该请求，2s 后仍未退出则认可失败并给出指引
     * （眼镜端宿主「双击触控板 = 退出程序」恒可用，见交互 v1.2）。 */
    this._exitSentAt = Date.now();
  },

  /* ── 交互 v1.4（待机停采 + 全单击语义 + IMU 异常不劫持）
   *    交互 v1.14（滑动进选择态，取代待机单击）
   * 待机：滑动触控板 = 启动 IMU 并进入选择态；单击在待机态无语义（不响应）
   * 选择态：点亮单击 = 确认；未点亮单击 = 停采回待机；15s 无操作复位
   * 退出确认：单击取消 / 3s 超时退出 ── */
  onTap() {
    /* v1.14 滑动守卫：滑动若被宿主同时派发为 GlobalHook 单击通道，这条守卫
     * 吞掉紧随的伪单击（否则"滑进选择态"会被马上打回待机）。窗口很短
     * （swipeSuppress 300ms），不影响滑动后正常确认。 */
    if (Date.now() < (this._swipeGuard || 0)) return;
    if (this.state === S.EXIT) { this.resetToIdle(); return; }
    if (this.state === S.SELECT) {
      const lit = this._lit;
      if (!lit) { this.resetToIdle(); return; }
      this.engine.freezeDrift(false);
      if (lit.meta.kind === 'exit') {
        /* 退出确认（A5）：下层入口固定居中，此处才需要回中 */
        this.engine.recenter();
        this.state = S.EXIT;
        this.exitAt = Date.now();
        /* v1.12：每次进入退出确认都重置退出请求标记，保证可重复触发 */
        this._exitTried = false;
        this._exitCalled = false;
        this._exitFailed = false;
        this._exitSentAt = 0;
        return;
      }
      /* v1.18：确认后**不再 recenter**。旧实现在确认瞬间把头控偏移清零，
       * 八个入口当帧从当前锚定位「啪」地跳回中心对称位 —— 这是「跳跃感」
       * 最大的单一来源。现在 A6/A7 全程持续消费 IMU（位置锁定），入口只
       * 做亮度渐隐，位置一动不动（相对头部）。 */
      this.state = S.LAUNCH;
      this.launchAt = Date.now();
      this.target = lit.meta;
      /* v1.12：重置跳转请求标记，保证每次确认都能真实发起一次导航 */
      this._navTried = false;
      this._navCalled = false;
      this._navOk = false;
      this._navStep = 0;
      this._navStepAt = 0;
      sfx.play('confirm');
      return;
    }
    /* IDLE（v1.14）：待机单击**无语义**，进入选择态改由滑动触发。
     * 保留空分支是刻意的——待机时误触不该静默改变页面状态。 */
  },

  /* 交互 v1.14：滑动触控板 → 进入选择态（方向键通道）。
   * 仅在待机态生效；选择态/跳转态/退出确认态内的滑动一律忽略，
   * 避免误滑打断正在进行的确认流程（这些状态的退出口是单击）。 */
  onSwipe(code) {
    /* 取证：滑动通道是否真被宿主派发、派发的是哪个方向键。
     * 定稿后与 _diag 一并删除。 */
    this._diag('swipe:' + code);
    if (this.state !== S.IDLE) return;
    this._enterSelect();
  },

  /* 进入选择态（v1.3 待机停采 → 此处才 start；v1.14 由滑动触发）
   * v1.4：start() 失败（如 Craft 无传感器）不再劫持为退出确认，照常进入
   * 选择态——IMU 不可用时头控恒 0，退出仍可走宿主双击。 */
  _enterSelect() {
    /* 【v1.41 修复：冷启动恒偏移】旧实现只把 yaw0/pitch0 置 null，基准由
     * 冷启动后的**首个读数**建立 —— 而该读数恰是融合未收敛的数据（官方
     * 契约只保证"有读数"、不保证已收敛），又被下面这行 freezeDrift(true)
     * 锁死 ⇒ 首次滑进选择态恒偏移、且随融合继续收敛表现为"一直在漂"；
     * 第二次进入时系统级融合已热，首帧即可信 ⇒ 表现正常。
     * 现由 engine.start() 统一复位会话并进入预热：预热期内基准持续跟随
     * 最新读数（见 utils/input.js 的 warming），锁定后误差≈0。
     * start() 内含 recenter()，与 resetToIdle() 的复位口径对称。 */
    this.engine.start();
    this.engine.freezeDrift(true);
    this.state = S.SELECT;
    this.selectAt = Date.now();
    /* 吞掉滑动可能附带的伪单击（见 onTap 的滑动守卫） */
    this._swipeGuard = Date.now() + TOUCH.swipeSuppress;
    /* 退出确认态的退出请求标记复位，保证下一轮可重复触发 */
    this._exitTried = false;
    this._exitCalled = false;
    this._exitFailed = false;
    this._exitSentAt = 0;
    sfx.play('select');
  },

  resetToIdle() {
    this.state = S.IDLE;
    this._hidden = false;   /* v1.16：落地证据作废，避免污染下一次跳转判定 */
    if (this.engine) {
      this.engine.freezeDrift(false);
      this.engine.recenter();
      /* v1.42：预热窗口内不 stop —— 否则回前台/复位会把预热打断，
       * 冷启动收敛又得从头计。预热到期由 tick 统一收口。 */
      if (!this._primeUntil) this.engine.stop();   /* v1.3：待机态关闭 IMU 监听 */
    }
  },

  tick() {
    const now = Date.now();
    const dt = Math.min(100, now - (this._last || now));
    this._last = now;
    this.engine.update(dt);
    this.gesture.tick(now);

    /* v1.42 冷启动预热到期：仍在待机 ⇒ 停采（回到交互 v1.3 的省电口径）；
     * 已进入选择态 ⇒ 预热使命完成，直接作废（不再干预后续 start/stop）。 */
    if (this._primeUntil && (this.state !== S.IDLE || now >= this._primeUntil)) {
      this._primeUntil = 0;
      if (this.state === S.IDLE) this.engine.stop();
    }

    if (this.state === S.SELECT) {
      /* v1.42 兜底：选择态必须活在 IMU 上。任何路径（手势 cancel、复位与
       * 生命周期时序竞争）把引擎停掉，用户看到的就是「转头完全没反应」且
       * 无法自恢复。这里每 500ms 兜一次底，把停采的引擎重新拉起。 */
      if (!this.engine.running && now - (this._restartAt || 0) > 500) {
        this._restartAt = now;
        this.engine.start();
      }
      /* v1.4：IMU 异常/未就绪不再自动踢出（Craft 无传感器可走查 UI），
       * 仅保留 15s 无确认自动复位待机（停采）。 */
      if (now - this.selectAt > TOUCH.selectSuspend) {
        /* 选择态 15s 无确认自动复位（PRD §06 挂起分支） */
        this.resetToIdle();
      }
      /* v1.42 真机取证：进选择态后 6s 内在诊断行实时显示 IMU 健康
       * （读数个数 / 实测采样率 / 是否收敛中 / 是否激活 / 是否报错）。
       * 「转头不识别」时一眼定性：reads 不涨=宿主没派发 reading；hz 过低=
       * frequency 只是 hint；warm 恒 1=收敛窗口卡住。定稿后可删本段。
       * v1.44：并排追加音效自检——首次进入时先 probe() 逐个构造实例，
       * 之后每次刷新显示 `ready/8 x 已播放次数`；NO-CTOR=拿不到宿主 Sound。
       * 【v1.51】该行**已不再上屏**（诊断行按用户要求移除），此处只继续写
       * `_diagMsg` 供 Craft 控制台 / 调试取值，不影响任何交互。 */
      if (now - this.selectAt < 6000 && now - (this._healthAt || 0) > 400) {
        this._healthAt = now;
        if (!this._sfxProbed) { this._sfxProbed = true; sfx.probe(); }
        this._diagMsg = 'imu ' + this.engine.health()
          + ' | sfx ' + sfx.brief();
        this._diagAt = now;
      }
    }

    /* v1.12：倒计时归零后发出退出请求（只发一次），不再 return —— 保留渲染
     * 以便把结果/兜底提示显示出来（原实现 return 后画面定格，看不到任何反馈）。 */
    if (this.state === S.EXIT && now - this.exitAt > CONFIRM_MS) {
      this._requestExit();
      if (this._exitSentAt && !this._exitCalled && now - this._exitSentAt > 2000) {
        this._exitFailed = true;
      }
    }

    /* A6 → A7（交互 v1.17）：确认后先维持最少 A6_MIN_MS 的「脉冲初起」过渡
     * （入口按分档可见、选中项保持点亮、中心已承载「已确认」），到点后转入
     * A7 loading 等待——入口整体收束至 6% 隐藏，只剩屏心核心 + 三环脉冲
     * 循环扩散，直到 B1 打开。导航请求在过渡结束的同一帧首次发出，
     * A6 / A7 两态共用同一套落地握手与六档轮换。 */
    if (this.state === S.LAUNCH && now - this.launchAt >= A6_MIN_MS) {
      this.state = S.LOADING;
    }

    if (this.state === S.LOADING) {
      const t = this.target;
      if (!t || !t.page) {
        /* 无目标页面（如退出位）：直接复位，避免永久停留在跳转态 */
        this.state = S.IDLE;
      } else if (!this._navTried) {
        /* 首次请求：gameId 改走 storage（url 不再拼 ?query，避免宿主路由
         * 精确字符串匹配失败），并把落地探针重置为 req。
         * 主页框架阶段（v1.9）关闭「首次进入强制校准」跳转链 —— game 页
         * 一旦 redirectTo calibrate，用户看到的就不是框架页，且每多一层
         * 宿主请求型跳转就多一个失败点。正式功能阶段再恢复：
         *   const first = t.kind === 'game' && !tutorialSeen(t.id); */
        this._navTried = true;
        this._navStep = 1;
        this._navStepAt = now;
        setEntryGameId(t.id);
        armNavProbe();
        const p1 = this._navPlan(1);
        this._requestNav(p1.url, p1.how);
      } else if (navLanded() || this._hidden) {
        /* 目标页 onLoad 已执行（storage / 内存探针命中），或主页已被压栈
         * （onHide 回调）→ 才认定真的跳转过去了，此时才暂停本页 */
        this._diag('nav:landed s' + this._navStep + (this._hidden ? ' (hide)' : ''));
        this._navOk = true;
        this._pause();
      } else if (now - this._navStepAt >= NAV_PROBE_MS) {
        /* 本档等待期结束仍未落地 → 换方式重试；配额用尽则判定宿主不受理 */
        if (this._navStep >= NAV_MAX_STEP) {
          /* v1.16：配额用尽时同时报告 storage 可用性——storage 不可用会让
           * 落地握手失去证据，从而把"其实跳成功了"误判成失败。 */
          this._diag('nav:dead ' + t.page + (storageOk() ? '' : ' sto:no'));
          /* v1.41：走 resetToIdle 而非裸置 IDLE —— 原路径既不停采（引擎继续
           * 跑、frozen 仍为 false）也不 recenter，_px 会带着上一会话的偏移
           * 进入下一次选择态；且下一轮 _enterSelect 会再 start() 一个传感器，
           * 与这个仍在跑的实例并存，两个 reading 事件源交替写 lastYaw
           * ⇒ 读数抖动/漂移。 */
          this.resetToIdle();
        } else {
          this._navStep += 1;
          this._navStepAt = now;
          const p = this._navPlan(this._navStep);
          this._requestNav(p.url, p.how);
        }
      }
    }

    this.render(now);
  },

  render(now) {
    const ctx = this.ctx;
    if (!ctx) return;
    clear(ctx);
    const snap = this.engine.snapshot();
    /* v1.18：入口淡出进度（0 = 按分档可见，1 = 收束至 6% 隐藏档）。
     * A5 退出确认沿用瞬时收束（浮层自身的出现就是瞬时的，且下层需固定居中）；
     * A6 走节拍曲线，A6 末帧 == A7 首帧（fade 恰好到 1），切换点零跳变。 */
    const fade = this.state === S.EXIT ? 1
      : (this.state === S.LAUNCH || this.state === S.LOADING) ? launchFade(now, this.launchAt)
        : 0;
    /* PRD-01 §03（交互 v1.2 / v1.18）：入口菜单仅在选择态（SELECT）及其后续
     * （LAUNCH、LOADING）消费头控偏移（世界锚定）；待机 / 退出确认固定居中。
     * 【v1.18】LOADING 也纳入 tracking —— 淡出期间必须持续监控 IMU 把待选
     * 按键位置锁定在头部坐标系上，中途不得回中（旧实现在此回中 = 跳跃）。 */
    const tracking = this.state === S.SELECT || this.state === S.LAUNCH || this.state === S.LOADING;
    const laid = layoutEntries(this.items, tracking ? snap.x : 0, tracking ? snap.y : 0, fade);
    this._lit = pickLit(laid);
    drawEntries(ctx, laid);

    if (this.state === S.SELECT) {
      /* v1.19：中心 = 单圈 r18 @100% + r80 光晕；圈内显示选择态剩余秒数
       * （15s 无确认自动回待机，PRD §06 挂起分支）。此前这个倒计时没有任何
       * 视觉出口——用户只能"突然回到待机"，倒计时上屏后才可预期。
       * 判定虚线圈（48px 阈值可视化）已删：属调试期辅助线，与入口圈抢视觉。 */
      drawActiveCore(ctx, CENTER.x, CENTER.y);
      const remain = TOUCH.selectSuspend - (now - this.selectAt);
      drawCoreCountdown(ctx, CENTER.x, CENTER.y, Math.max(1, Math.ceil(remain / 1000)));
    } else if (this.state === S.IDLE) {
      drawIdleCrosshair(ctx, CENTER.x, CENTER.y);
    } else if ((this.state === S.LAUNCH || this.state === S.LOADING) && this.target) {
      /* A6 → A7（交互 v1.18）：两态合并为**一条连续曲线**，不再有切换点。
       *   中心：激活中心以 (1-k) 淡出、loading 核心以 k 淡入（coreXMs 内交叉）
       *   脉冲：环数 2 → 3（末环按小数渐入）、上限 r50 → r62，均沿 fade 插值
       *   标签：fade 过 labelFrom 后渐入（A6 前期只有图标，后期浮出功能名）
       *   入口：沿 fade 收束至 6%，位置持续锚定（见上方 tracking）
       * 故 A6 的最后一帧与 A7 的第一帧逐像素相同 —— 用户看到的是一气呵成
       * 的「确认 → 待选项渐隐 → 中心脉冲持续 → 目标页打开」。
       * 用 this.target 而非 _lit：淡出过半后 pickLit 恒为 null（语义已无选中）。 */
      const k = coreFade(now, this.launchAt);
      const t = ((now - this.launchAt) % PULSE.cycleMs) / PULSE.cycleMs;
      const lab = clamp((fade - LAUNCH_FADE.labelFrom) / (LAUNCH_FADE.labelTo - LAUNCH_FADE.labelFrom), 0, 1);
      if (k < 1) drawActiveCore(ctx, CENTER.x, CENTER.y, 1 - k);
      drawLoadingCore(ctx, CENTER.x, CENTER.y, {
        iconId: this.target.iconId,
        label: this.target.name,
        t: t,
        rings: 2 + fade,
        rMax: PULSE.r1 + (PULSE.r2 - PULSE.r1) * fade,
        alpha: k,
        labelA: lab,
      });
    }

    if (this.state === S.EXIT) {
      drawConfirm(ctx, {
        kind: 'exit',
        /* v1.12：退出请求若被宿主忽略，明确告知可用的逃生口，而不是定格无反馈 */
        title: this._exitFailed ? '退出请求未被受理' : '即将退出应用',
        subtitle: this._exitFailed ? '请双击触控板退出程序' : '单击取消 / 3 秒后自动退出',
        remainMs: Math.max(0, CONFIRM_MS - (now - this.exitAt)),
        totalMs: CONFIRM_MS,
        sweepDeg: 360,
      });
    }

    /* 交互 v1.4/1.8：右上角 HUD 显示页面状态。点亮是 SELECT 内的派生态
     * （_lit 非空），点亮时即显示「已选中」（v1.8 修复，原实现只认
     * LAUNCH/EXIT 两个独立状态，点亮态漏映射）。待机中=空心点停采。 */
    const litNow = this.state === S.SELECT && this._lit;
    const hudStatus = {
      [S.IDLE]: { text: '状态：待机中', dot: false },
      [S.SELECT]: litNow
        ? { text: '状态：已选中', dot: true }
        : { text: '状态：选择中', dot: true },
      [S.LAUNCH]: { text: '状态：已确认', dot: true },
      [S.LOADING]: { text: '状态：打开中', dot: true },
      [S.EXIT]: { text: '状态：已选中', dot: true },
    }[this.state] || { text: '状态：待机中', dot: false };
    drawHud(ctx, '摇头晃脑', hudStatus);

    /* 交互 v1.14：左下角常驻操作提示条（三态文案），中央区域让位给入口环 */
    this._drawHint(ctx);

    /* 【v1.51 诊断行已下屏】此处原有一行 11px 诊断文字（品牌胶囊下方 y=48），
     * 承载跳转 url（`s1 pages/brick/brick?gameId=…`）与 IMU/音效自检
     * （`imu … | sfx …`）。真机上它是**路径与调试信息**，在选择态与跳转期间
     * 直接暴露给用户，属调试期产物 ⇒ 按用户要求移除上屏。
     * ⚠ `_diag()` / `_diagMsg` **保留**：仍写 Craft 控制台，且 harness.mjs、
     * harness-nosto.mjs 以 `_diagMsg` 作为落地握手的取证入口，删了会断回归。
     * 需要现场取证时临时恢复本段即可（源码里搜「v1.51 诊断行已下屏」）。 */
    flush(ctx);
  },

  /* 交互 v1.14 三态操作提示：待机=引导滑动进入；选择中=转头选择 + 单击回
   * 待机；已选中=单击确认。退出确认态给独立文案（该态单击的语义是取消）。
   * 交互 v1.17：A6 跳转脉冲 / A7 loading 等待统一「正在打开…」（两态语义
   * 上都是"确认已接受、目标正在打开"，单击已无操作空间）。 */
  _hintText() {
    if (this.state === S.EXIT) return '单击触控取消退出';
    if (this.state === S.SELECT) {
      return this._lit ? '单击触控确认选择' : '转头选择，单击触控返回待机';
    }
    if (this.state === S.LAUNCH || this.state === S.LOADING) return '正在打开…';
    return '滑动触控进入选择状态';
  },

  /* 左下角提示条：v1.48 起走 utils/hud.js 的 drawHint（设置页同规格同出口），
   * 尺寸 / 圆角 / 自适应宽度规则见该函数。 */
  _drawHint(ctx) {
    drawHint(ctx, this._hintText());
  },
};
