/* icons.js —— 描边图标集（48 viewBox / stroke-width 3 / round cap+join）
 * 手绘等价 IconPark 图形（BlockEight / EggOne / Sphere / RocketOne / Airplane /
 * Ranking / SettingTwo / Logout / Home / Refresh / Tuning / VolumeNotice /
 * VolumeMute），渲染时缩放至 Ø24 内嵌。
 *
 * ⚠ 渲染不依赖 Path2D —— AIUI Canvas 契约未承诺该 API，
 * 内置微解析器把 SVG path 字符串（仅绝对指令 M/L/C/A/Z）直译为
 * moveTo / lineTo / bezierCurveTo / arc。解析失败时跳过该子路径，
 * 单枚图标失败不拖垮整帧。
 */

/* SVG 椭圆弧端点参数化 → 圆心参数化（W3C 规范算法），
 * 全部图标均为圆形弧（rx==ry、rot=0），通用实现以备扩展。 */
function svgArc(ctx, x1, y1, rx, ry, rotDeg, laf, sf, x2, y2) {
  if (rx === 0 || ry === 0) { ctx.lineTo(x2, y2); return; }
  const rot = rotDeg * Math.PI / 180;
  const cosR = Math.cos(rot), sinR = Math.sin(rot);
  const dx2 = (x1 - x2) / 2, dy2 = (y1 - y2) / 2;
  const x1p = cosR * dx2 + sinR * dy2;
  const y1p = -sinR * dx2 + cosR * dy2;
  const rx2 = rx * rx, ry2 = ry * ry, x1p2 = x1p * x1p, y1p2 = y1p * y1p;
  const denom = rx2 * y1p2 + ry2 * x1p2;
  const radicand = (rx2 * ry2 - denom) / denom;
  let lams = radicand < 0 ? 0 : Math.sqrt(radicand);
  if (laf === sf) lams = -lams;
  const cxp = lams * rx * y1p / ry;
  const cyp = -lams * ry * x1p / rx;
  const cx0 = cosR * cxp - sinR * cyp + (x1 + x2) / 2;
  const cy0 = sinR * cxp + cosR * cyp + (y1 + y2) / 2;
  function ang(ux, uy, vx, vy) {
    const dot = ux * vx + uy * vy;
    const len = Math.sqrt(ux * ux + uy * uy) * Math.sqrt(vx * vx + vy * vy);
    let a = Math.acos(Math.min(1, Math.max(-1, len ? dot / len : 1)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  }
  const ux = (x1p - cxp) / rx, uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx, vy = (-y1p - cyp) / ry;
  const th1 = ang(1, 0, ux, uy);
  let dth = ang(ux, uy, vx, vy);
  if (!sf && dth > 0) dth -= 2 * Math.PI;
  if (sf && dth < 0) dth += 2 * Math.PI;
  ctx.arc(cx0, cy0, rx, th1, th1 + dth, !sf);
}

/* path 字符串 → 画布路径。仅支持绝对指令 M/L/C/A/Z（本图标集约定）。 */
function tracePath(ctx, d) {
  const tokens = d.match(/[MLCZA]|-?\d*\.?\d+/g);
  if (!tokens) return false;
  let i = 0, cx = 0, cy = 0, sx = 0, sy = 0, started = false;
  while (i < tokens.length) {
    const cmd = tokens[i];
    if (!/[MLCZA]/.test(cmd)) return false;
    i++;
    if (cmd === 'M') {
      cx = +tokens[i++]; cy = +tokens[i++];
      ctx.moveTo(cx, cy); sx = cx; sy = cy; started = true;
    } else if (cmd === 'L') {
      const x = +tokens[i++], y = +tokens[i++];
      if (!started) { ctx.moveTo(cx, cy); started = true; }
      ctx.lineTo(x, y); cx = x; cy = y;
    } else if (cmd === 'C') {
      const x1 = +tokens[i++], y1 = +tokens[i++];
      const x2 = +tokens[i++], y2 = +tokens[i++];
      const x = +tokens[i++], y = +tokens[i++];
      if (!started) { ctx.moveTo(cx, cy); started = true; }
      ctx.bezierCurveTo(x1, y1, x2, y2, x, y); cx = x; cy = y;
    } else if (cmd === 'A') {
      const rx = +tokens[i++], ry = +tokens[i++];
      const rot = +tokens[i++], laf = +tokens[i++], sf = +tokens[i++];
      const x = +tokens[i++], y = +tokens[i++];
      if (!started) { ctx.moveTo(cx, cy); started = true; }
      svgArc(ctx, cx, cy, rx, ry, rot, laf, sf, x, y);
      cx = x; cy = y;
    } else if (cmd === 'Z') {
      ctx.closePath(); cx = sx; cy = sy; started = false;
    }
  }
  return true;
}

export const ICONS = {
  // 打砖块 · BlockEight：三块错位砖
  bricks: [
    'M8 10 L20 10 L20 22 L8 22 Z',
    'M28 10 L40 10 L40 22 L28 22 Z',
    'M18 26 L30 26 L30 38 L18 38 Z',
  ],
  // 接鸡蛋 · EggOne：蛋形轮廓
  egg: [
    'M24 5 C31 5 37 16 37 26 C37 34 31 40 24 40 C17 40 11 34 11 26 C11 16 17 5 24 5 Z',
  ],
  // 滚球迷宫 · Sphere：球体 + 两条经线弧
  marble: [
    'M4 24 A20 20 0 1 1 44 24 A20 20 0 1 1 4 24 Z',
    'M8 18 C15 24 33 24 40 18',
    'M8 30 C15 24 33 24 40 30',
  ],
  // 导弹指挥部 · RocketOne：火箭 + 尾焰 + 舷窗
  missile: [
    'M24 4 C30 10 32 18 32 27 L32 34 L16 34 L16 27 C16 18 18 10 24 4 Z',
    'M16 28 L8 36 L16 38 M32 28 L40 36 L32 38 M21 34 L24 42 L27 34',
    'M20 19 A4 4 0 1 1 28 19 A4 4 0 1 1 20 19',
  ],
  // 打飞机 · Airplane
  plane: [
    'M24 5 L27 19 L43 27 L43 31 L27 26 L26 35 L31 39 L31 42 L24 40 L17 42 L17 39 L22 35 L21 26 L5 31 L5 27 L21 19 Z',
  ],
  // 战绩 · Ranking：三阶领奖台
  ranking: [
    'M6 40 L18 40 L18 26 L6 26 Z',
    'M18 40 L30 40 L30 14 L18 14 Z',
    'M30 40 L42 40 L42 22 L30 22 Z',
  ],
  // 教学/设置 · SettingTwo：齿轮
  settings: [
    'M15 24 A9 9 0 1 1 33 24 A9 9 0 1 1 15 24',
    'M24 5 L24 11 M24 37 L24 43 M5 24 L11 24 M37 24 L43 24 M10.6 10.6 L15 15 M33 33 L37.4 37.4 M37.4 10.6 L33 15 M15 33 L10.6 37.4',
  ],
  // 退出 · Logout：门 + 外向箭头
  logout: [
    'M28 8 L10 8 L10 40 L28 40',
    'M22 24 L42 24',
    'M35 17 L42 24 L35 31',
  ],
  // 主页 · Home
  home: [
    'M8 22 L24 8 L40 22',
    'M12 19 L12 40 L36 40 L36 19',
    'M20 40 L20 29 L28 29 L28 40',
  ],
  // 重新游戏 · Refresh：优弧 + 箭头
  refresh: [
    'M39 24 A15 15 0 1 1 32 11',
    'M32 3 L32 11 L40 11',
  ],
  /* 灵敏度 · Tuning（v1.48 设置页）：两条水平滑轨 + 错位旋钮。
   * 与 IconPark「Tuning」同构；旋钮错位（上右下左）暗示"可调档位"。 */
  sensitivity: [
    'M6 16 L42 16',
    'M26 16 A4 4 0 1 1 34 16 A4 4 0 1 1 26 16',
    'M6 32 L42 32',
    'M14 32 A4 4 0 1 1 22 32 A4 4 0 1 1 14 32',
  ],
  /* 音效开 · VolumeNotice（v1.48 设置页）：喇叭 + 两道声波 */
  volumeOn: [
    'M8 18 L16 18 L26 10 L26 38 L16 30 L8 30 Z',
    'M32 18 A7 7 0 0 1 32 30',
    'M38 13 A13 13 0 0 1 38 35',
  ],
  /* 音效关 · VolumeMute（v1.48 设置页）：同一喇叭 + 叉（同喇叭保证开关态
   * 切换时图形不跳位，只有右侧符号变化） */
  volumeOff: [
    'M8 18 L16 18 L26 10 L26 38 L16 30 L8 30 Z',
    'M32 19 L42 29',
    'M42 19 L32 29',
  ],
};

/* 在 (cx,cy) 绘制 size×size 图标，color 为描边色（含 alpha 的 rgba 串） */
export function drawIcon(ctx, id, cx, cy, color, size) {
  const def = ICONS[id];
  if (!def) return;
  const s = size || 24;
  const k = s / 48;
  ctx.save();
  ctx.translate(cx - 24 * k, cy - 24 * k);
  ctx.scale(k, k);
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let i = 0; i < def.length; i++) {
    try {
      ctx.beginPath();
      tracePath(ctx, def[i]);
      ctx.stroke();
    } catch (e) { /* 单枚失败不拖垮整帧 */ }
  }
  ctx.restore();
}
