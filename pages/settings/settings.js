/* pages/settings/settings.js —— 设置页（C1 页，PRD-01 §09）
 *
 * 【v1.48 重构】原「教学 / 校准 / 设置」长列表页 → **环形头控设置页**：
 *   ① 只保留两项设置 + 一个返回：灵敏度（LT）、游戏音效（RT）、返回（B）；
 *      教学引导列表与「重新校准基准」按产品口径移出本页。
 *   ② 三项圆形分布，半径与主页同为 RING_POS（屏心 ±114），复用
 *      utils/ring.js 的 makeItem / layoutEntries / pickLit / drawEntries ——
 *      与主页、游戏页 B2 菜单**同一套判定与绘制**，不走第二套实现。
 *   ③ 交互与主页同源：滑动触控进选择态 → 转头点亮 → 单击生效。
 *   ④ 【与主页的关键差异】主页单击 = 确认并进入跳转态；本页单击 = **就地
 *      改变设置并停留在选择态**（连续可调），只有「返回」与"未点亮时单击"
 *      才回退——这是需求明确要求的差异，改动手感前务必确认。
 *   ⑤ 右上角 HUD 状态胶囊、左下角操作提示条与主页同规格同出口
 *      （utils/hud.js 的 drawHud / drawHint）。
 *
 * 【音效默认生效】v1.47 证实 `import 'audio'` 可解析，v1.48 起主页与游戏
 * 底座各自注入；本页仍注入一次（承载音效诊断与"改完立刻试听"）。
 *
 * 启动链与生命周期走 utils/pagebase.js（四个二级页共用）。
 */

import wx from 'wx';
import {
  CENTER, RING_POS, TOUCH, PRIME_MS,
} from '../../utils/layout.js';
import { clear, flush } from '../../utils/draw.js';
import { drawHud, drawHint } from '../../utils/hud.js';
import {
  makeItem, layoutEntries, pickLit, drawEntries,
  drawIdleCrosshair, drawActiveCore, drawCoreCountdown,
} from '../../utils/ring.js';
import { bootStandard, lifecycle } from '../../utils/pagebase.js';
import { writeSettings } from '../../utils/storage.js';
import * as sfx from '../../utils/sfx.js';
import host from '../../utils/audio-host.js';

const S = { IDLE: 'IDLE', SELECT: 'SELECT' };

/* 灵敏度三档（与 utils/input.js 的 SENSITIVITY 键一致），单击循环切换 */
const SENS = [
  { v: 'low', label: '低' },
  { v: 'standard', label: '标准' },
  { v: 'high', label: '高' },
];

/* v1.49 返回落地判定（与 utils/gamepage.js 同口径，常量不跨模块引用的原因：
 * gamepage 带整套游戏状态机，二级页不该为两个常量引入它）。
 * navigateBack 是**宿主请求型 API**：success 是无条件回调，不能当成功证据。
 * 成败只能靠落地判定——返回成功后本页被出栈，宿主会回调 onHide。 */
const BACK_PROBE_MS = 800;
const BACK_MAX_TRY = 3;

export default Object.assign({}, lifecycle('settings'), {
  data: {
    bootMsg: 'boot=init',
  },

  onLoad() {
    const self = this;
    this.settings = bootStandard(this, 'settings', {
      prepare: function (page, settings) {
        /* ⚠ 必须在这里落定 page.settings：utils/boot.js 的 startLoop 会
         * **同步**跑一帧「保底首帧」，那一帧的 render 就发生在
         * `this.settings = bootStandard(...)` 赋值之前 —— 等 onLoad 拿到
         * 返回值再存，首帧必然读到 undefined（smoke 复现：tick 异常）。 */
        page.settings = settings;
        /* v1.48：先注入宿主音频构造器（唯一 import 'audio' 的位置），再 probe
         * —— 与主页同一口径，保证本页的音效自检与试听都能出声。 */
        try {
          if (host && (host.Sound || host.AudioPlayer)) sfx.injectAudio(host);
        } catch (e) { /* 注入失败保持静默降级 */ }
        sfx.probe();

        page.items = [
          makeItem('LT', RING_POS.LT, { id: 'sens', name: '灵敏度', iconId: 'sensitivity', kind: 'opt' }, 0),
          makeItem('RT', RING_POS.RT, { id: 'sfx', name: '游戏音效', iconId: 'volumeOn', kind: 'toggle' }, 0),
          makeItem('B', RING_POS.B, { id: 'back', name: '返回主页', iconId: 'home', kind: 'back' }, 0),
        ];
        page.state = S.IDLE;
        return settings;
      },
      gesture: {
        onTap: function () { self.onTap(); },
        onSwipe: function () { self.onSwipe(); },
        onCancel: function () { self.resetToIdle(); },
      },
    }) || { sensitivity: 'standard', sfxOn: true };

    /* v1.49 冷启动预热（与主页 pages/index/index.js 完全同口径）：
     * 每个页面各有自己的 InputEngine ⇒ 各自的传感器实例，而官方契约只描述
     * 单实例语义 —— 所以**二级页永远是一次冷启动**，磁力计融合未收敛。
     * 进页先起采跑满 PRIME_MS 再停采，用户第一次滑动进选择态时融合已热。
     * v1.48 缺这段，真机表现为「进设置页后 IMU 突然漂移、且反复出现」。 */
    this.state = S.IDLE;
    this._hidden = false;
    if (this.engine) {
      this._primeUntil = Date.now() + PRIME_MS;
      this.engine.start();
      this.engine.freezeDrift(false);
    }
  },

  onShow() {
    this._hidden = false;
    /* 回前台一律复位到待机待采态（与主页 onShow 同口径） */
    this.resetToIdle();
  },

  /* 覆盖 pagebase 的 onHide：除停采外，还要置落地标记——它是 navigateBack
   * 唯一可信的成功证据（见 BACK_PROBE_MS 处注释）。 */
  onHide() {
    this._hidden = true;
    if (this.gesture) this.gesture.cancel();
    if (this.engine) this.engine.stop();
  },

  /* 交互 v1.14（与主页同源）：待机单击**无语义**，滑动才进选择态 */
  onSwipe() {
    if (this.state !== S.IDLE) return;
    this._enterSelect();
  },

  _enterSelect() {
    if (this.engine) {
      this.engine.start();
      this.engine.freezeDrift(true);
    }
    this.state = S.SELECT;
    this.selectAt = Date.now();
    /* 吞掉滑动可能附带的伪单击（与主页同一守卫） */
    this._swipeGuard = Date.now() + TOUCH.swipeSuppress;
    sfx.play('select');
  },

  resetToIdle() {
    this.state = S.IDLE;
    this._lit = null;
    if (this.engine) {
      this.engine.freezeDrift(false);
      this.engine.recenter();
      /* v1.49：预热窗口内不 stop —— 否则复位会把预热打断，冷启动收敛又得
       * 从头计（这正是「漂移反复出现」的成因之一）。到期由 tick 统一收口。 */
      if (!this._primeUntil) this.engine.stop();
    }
  },

  /* 单击语义（与主页差异最大处，见文件头 ④）：
   *   SELECT + 点亮 → 就地改变设置，**停留在选择态**（可连续调）
   *   SELECT + 点亮「返回」→ 返回主页
   *   SELECT + 未点亮 → 退回待机
   *   IDLE → 无语义 */
  onTap() {
    if (this._backAt) return;                    /* 返回请求在途：不再受理 */
    if (Date.now() < (this._swipeGuard || 0)) return;
    if (this.state !== S.SELECT) return;
    const lit = this._lit;
    if (!lit) { this.resetToIdle(); return; }
    const id = lit.meta.id;
    if (id === 'back') {
      sfx.play('confirm');
      this._backTried = 0;
      this._requestBack();
      return;
    }
    if (id === 'sens') { this._cycleSens(); return; }
    if (id === 'sfx') { this._toggleSfx(); return; }
  },

  /* 宿主请求型 API 红线（同 utils/gamepage.js _requestBack）：navigateBack 的
   * success 是无条件回调（官方契约只承诺"已发出"），故成败靠落地判定——
   * 返回成功后本页被出栈，宿主回调 onHide（_hidden 置位）。未命中则每
   * BACK_PROBE_MS 重试，最多 3 次。
   * ⚠ v1.48 用的是裸 `wx.navigateBack()`，真机「选中返回单击无反应」——
   *   与 gamepage 已验证的调用形态（带 delta 与三回调）保持一致。 */
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

  /* 配额内继续重试；用尽则回待机并清在途标记——绝不让用户卡在"无反应" */
  _backFailed() {
    if ((this._backTried || 0) >= BACK_MAX_TRY) {
      this._backAt = 0;
      this.resetToIdle();
      return;
    }
    this._requestBack();
  },

  _cycleSens() {
    let i = 0;
    for (let k = 0; k < SENS.length; k += 1) {
      if (SENS[k].v === this.settings.sensitivity) { i = k; break; }
    }
    const next = SENS[(i + 1) % SENS.length];
    this.settings.sensitivity = next.v;
    writeSettings(this.settings);
    if (this.engine) this.engine.setSensitivity(next.v);
    /* ⚠ 不退出选择态：可继续转头选下一项（需求 ⑤） */
    this._changedAt = Date.now();
    sfx.play('select');
  },

  _toggleSfx() {
    this.settings.sfxOn = !this.settings.sfxOn;
    writeSettings(this.settings);
    sfx.applySettings(this.settings);
    /* 开启即刻试听一声；关闭则本声自然不会再响（applySettings 已生效） */
    if (this.settings.sfxOn) sfx.play('select');
    this._changedAt = Date.now();
  },

  tick() {
    const now = Date.now();
    const dt = Math.min(100, now - (this._last || now));
    this._last = now;
    if (this.engine) this.engine.update(dt);
    if (this.gesture) this.gesture.tick(now);

    /* v1.49 冷启动预热到期：仍在待机 ⇒ 停采（回到交互 v1.3 的省电口径）；
     * 已进入选择态 ⇒ 预热使命完成，直接作废（不再干预后续 start/stop）。 */
    if (this._primeUntil && (this.state !== S.IDLE || now >= this._primeUntil)) {
      this._primeUntil = 0;
      if (this.state === S.IDLE && this.engine) this.engine.stop();
    }

    /* v1.49 返回落地判定：请求发出后 BACK_PROBE_MS 内没等到 onHide ⇒ 未受理 */
    if (this._backAt && !this._hidden && now - this._backAt > BACK_PROBE_MS) {
      this._backFailed();
    }

    if (this.state === S.SELECT) {
      /* 与主页同款兜底：选择态必须活在 IMU 上，任何路径把它停掉都会表现为
       * 「转头没反应」且无法自恢复，这里每 500ms 拉起一次。 */
      if (this.engine && !this.engine.running && now - (this._restartAt || 0) > 500) {
        this._restartAt = now;
        this.engine.start();
      }
      /* 15s 无操作自动回待机（PRD §06 挂起分支，与主页同参） */
      if (now - this.selectAt > TOUCH.selectSuspend) this.resetToIdle();
    }

    this.render(now);
  },

  /* 点亮项标签 = 「名称 · 当前状态」，写在图标外侧（utils/ring.js 的
   * drawEntryLabel，近端对齐、越界镜像）。音效不可用时状态退化为「不可用」，
   * 不额外铺诊断文案——本页只承载设置信息。 */
  _syncMeta() {
    const s0 = this.settings || {};
    let sensLabel = '标准';
    for (let k = 0; k < SENS.length; k += 1) {
      if (SENS[k].v === s0.sensitivity) sensLabel = SENS[k].label;
    }
    let ok = true;
    /* ⚠ 诊断绝不可拖垮渲染循环：取不到就按"可用"处理，状态照常显示 */
    try { ok = sfx.brief() !== 'NO-CTOR'; } catch (e) { ok = true; }
    const sfxLabel = !ok ? '不可用' : (s0.sfxOn ? '开启' : '关闭');
    const it = this.items || [];
    for (let i = 0; i < it.length; i += 1) {
      const m = it[i].meta;
      if (m.id === 'sens') m.name = '灵敏度 · ' + sensLabel;
      else if (m.id === 'sfx') {
        m.name = '游戏音效 · ' + sfxLabel;
        m.iconId = (s0.sfxOn && ok) ? 'volumeOn' : 'volumeOff';
      }
    }
  },

  render(now) {
    const ctx = this.ctx;
    if (!ctx) return;
    clear(ctx);
    this._syncMeta();

    const snap = this.engine ? this.engine.snapshot() : { x: 0, y: 0 };
    /* 与主页同口径：仅选择态消费头控偏移（世界锚定），待机固定居中 */
    const tracking = this.state === S.SELECT;
    const laid = layoutEntries(this.items || [], tracking ? snap.x : 0, tracking ? snap.y : 0, 0);
    this._lit = pickLit(laid);
    drawEntries(ctx, laid);

    if (this.state === S.SELECT) {
      drawActiveCore(ctx, CENTER.x, CENTER.y);
      const remain = TOUCH.selectSuspend - (now - this.selectAt);
      drawCoreCountdown(ctx, CENTER.x, CENTER.y, Math.max(1, Math.ceil(remain / 1000)));
    } else {
      drawIdleCrosshair(ctx, CENTER.x, CENTER.y);
    }

    /* 右上角状态胶囊（与主页同三态：待机中 / 选择中 / 已选中）。
     * v1.49：左上角标题改为「设置」—— 此前沿用应用名「摇头晃脑」，
     * 与页内只含设置项的定位不符（需求：本页标题即页名）。 */
    const litNow = this.state === S.SELECT && this._lit;
    drawHud(ctx, '设置', this.state === S.IDLE
      ? { text: '状态：待机中', dot: false }
      : (litNow ? { text: '状态：已选中', dot: true } : { text: '状态：选择中', dot: true }));

    drawHint(ctx, this._hintText());
    flush(ctx);
  },

  /* 左下角操作提示（与主页同规格）：待机=引导滑动；选中=按项给出动作语义；
   * 未点亮=转头选择 + 单击回待机。 */
  _hintText() {
    if (this.state !== S.SELECT) return '滑动触控进入选择状态';
    if (!this._lit) return '转头选择，单击触控返回待机';
    const id = this._lit.meta.id;
    if (id === 'back') return '单击触控返回主页';
    if (id === 'sens') return '单击触控切换灵敏度';
    return '单击触控开关音效';
  },
});
