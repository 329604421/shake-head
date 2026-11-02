/* hud.js —— 常驻 HUD 双胶囊（PRD-01 §01）
 * 左上品牌胶囊 76×24 @(16,12)：12% 底纹 + 文字 12/500 @100% 居中
 * 右上状态胶囊 110×24 @(354,12)：状态圆点 + 文字左对齐 @100%
 *   待机中 = 空心描边圆点（传感器停采）；选择中 / 已选中 = 实心圆点
 * A1~A7 brandText=「摇头晃脑」；B1~B4 传入当前游戏名。
 * A7 / B3 loading 等待态显示「状态：打开中」。
 *
 * 【交互 v1.4】右上角由「IMU 健康显示」改为「页面状态显示」：
 * drawHud(ctx, brand, { text: '状态：选择中', dot: true })。
 * 调用方负责传入状态文案与圆点形态；不再内置 IMU 健康判断。
 */

import { C, g } from './theme.js';
import { HUD, HINT } from './layout.js';
import { fillRoundRect, strokeRoundRect, text, textWidth, fillCircle, strokeCircle, clamp } from './draw.js';

/* alpha：整体可见度（1 = 常亮）。v1.40 引入，唯一用途是通关 / 失败弹窗展示时
 * 把 HUD 压到 48%（弹窗是模态的，其余元素一律退居次要层）。缺省 1，
 * 老调用点零改动。 */
export function drawHud(ctx, brandText, opts, alpha) {
  const k = alpha === undefined ? 1 : clamp(alpha, 0, 1);
  // 左上：品牌胶囊
  fillRoundRect(ctx, HUD.brand.x, HUD.brand.y, HUD.brand.w, HUD.brand.h, 4, g(0.12 * k));
  text(ctx, brandText,
    HUD.brand.x + HUD.brand.w / 2, HUD.brand.y + HUD.brand.h / 2,
    { size: 12, weight: 500, color: g(k) });

  // 右上：状态胶囊（opts = { text, dot }；缺省实心点 + 空文案兜底）
  const o = opts || {};
  const statusText = o.text || '';
  const dotSolid = o.dot !== false;
  fillRoundRect(ctx, HUD.imu.x, HUD.imu.y, HUD.imu.w, HUD.imu.h, 4, g(0.12 * k));
  const cy = HUD.imu.y + HUD.imu.h / 2;
  /* 【v1.51】dot === null ⇒ 右上胶囊承载**非状态**文案（战绩页「最近一局成绩」），
   * 不画圆点（圆点是状态灯，与文案语义冲突），文字起点回退到 HUD.noDotTextX。
   * 缺省行为（true 实心 / false 空心）一字未改，老调用点零影响。 */
  let tx = HUD.imuTextX;
  if (o.dot === null) {
    tx = HUD.noDotTextX;
  } else if (dotSolid) {
    fillCircle(ctx, HUD.dotCx, cy, 4, g(k));
  } else {
    strokeCircle(ctx, HUD.dotCx, cy, 4, g(k), 1);
  }
  text(ctx, statusText, tx, cy,
    { size: 12, weight: 500, color: g(k), align: 'left' });
}

/* 左下角常驻操作提示条（交互 v1.14）：与 HUD 品牌胶囊同高 24 / 同圆角 4，
 * 左缘对齐 x=16，底部边距 12（与 HUD 顶部边距 12 对称）。宽度随文案自适应
 * （textWidth 实测与字宽估算取大，避免宿主 measureText 不可用时底框裁切）。
 * 【v1.48】主页与设置页**同规格同源**：此前主页一份私有实现、设置页手绘另
 * 一份，两页提示条位置行高不一致。现由本函数统一出口。 */
export function drawHint(ctx, str) {
  const s = String(str || '');
  const opt = { size: HINT.size, weight: HINT.weight };
  const w = Math.ceil(textWidth(ctx, s, opt)) + HINT.padX * 2;
  fillRoundRect(ctx, HINT.x, HINT.y, w, HINT.h, HINT.r, g(0.12));
  strokeRoundRect(ctx, HINT.x, HINT.y, w, HINT.h, HINT.r, g(0.24), 1);
  text(ctx, s, HINT.x + HINT.padX, HINT.y + HINT.h / 2, {
    size: HINT.size, weight: HINT.weight, color: g(0.72), align: 'left',
  });
  return w;
}
