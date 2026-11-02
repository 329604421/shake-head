// 多文件页面模式自检（替代官方只检 .ink 的脚本）
// 用法: node check-multifile.js <项目目录>
const fs = require('fs');
const path = require('path');

const root = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
let fail = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { console.log('  ✗ ' + m); fail++; };

console.log('=== AIUI 多文件页面模式自检: ' + root + ' ===');

// [1] 每个页面目录恰好有 4 个文件：.json + .js + .wxml + .wxss
console.log('\n[1] 多文件四件套齐全');
const pageDirs = (() => {
  try { return fs.readdirSync(path.join(root, 'pages')).filter(d => fs.statSync(path.join(root, 'pages', d)).isDirectory()); }
  catch (e) { return []; }
})();
for (const d of pageDirs) {
  const dir = path.join(root, 'pages', d);
  const files = fs.readdirSync(dir);
  const expect = [d + '.json', d + '.js', d + '.wxml', d + '.wxss'];
  const missing = expect.filter(f => !files.includes(f));
  if (missing.length) bad(d + ' 缺文件: ' + missing.join(', '));
  else ok(d + ' 四件套齐全');
}

// [2] .json 只含 navigationBarTitleText（不含 schema）
console.log('\n[2] 页面 .json 仅含 navigationBarTitleText');
for (const d of pageDirs) {
  const f = path.join(root, 'pages', d, d + '.json');
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (j.schema) bad(d + '.json 含 schema —— 真机闪退根因');
    else if (typeof j.navigationBarTitleText !== 'string') bad(d + '.json 缺 navigationBarTitleText');
    else ok(d + '.json 合规（title=' + j.navigationBarTitleText + '）');
  } catch (e) { bad(d + '.json 解析失败: ' + e.message); }
}

// [3] .js 使用 export default 注册（非 Page({})）
console.log('\n[3] .js 用 export default 注册');
for (const d of pageDirs) {
  const f = path.join(root, 'pages', d, d + '.js');
  const src = fs.readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  /* 页面对象既可能是字面量 `export default {`，也可能是表达式
   * `export default Object.assign({}, gameBase(...), {...})`（v1.33 起五款游戏页
   * 与四个二级页都走底座），所以只认 `export default` 关键字本身。 */
  if (/^export\s+default\b/m.test(src)) ok(d + '.js export default ✓');
  else bad(d + '.js 未用 export default —— AIUI 页面注册走 ESM default');
}

// [4] .wxml 含 <canvas id="stage"> 与根 <view class="root">
console.log('\n[4] .wxml 含根容器与 canvas');
for (const d of pageDirs) {
  const f = path.join(root, 'pages', d, d + '.wxml');
  const src = fs.readFileSync(f, 'utf8');
  if (!/<view\s+class\s*=\s*["']root["']/.test(src)) bad(d + '.wxml 缺 <view class="root">');
  else if (!/<canvas\s+[^>]*id\s*=\s*["']stage["']/.test(src)) bad(d + '.wxml 缺 <canvas id="stage">');
  else ok(d + '.wxml 结构合规');
}

// [5] .wxss 不含官方明确不支持的属性
console.log('\n[5] .wxss 合规');
const BAD_CSS = [/animation\s*:/, /@keyframes/, /white-space\s*:/, /word-break\s*:/, /letter-spacing\s*:/, /position\s*:\s*sticky/, /visibility\s*:/];
for (const d of pageDirs) {
  const f = path.join(root, 'pages', d, d + '.wxss');
  const src = fs.readFileSync(f, 'utf8');
  const hits = [];
  for (const re of BAD_CSS) if (re.test(src)) hits.push(re.source);
  if (hits.length) bad(d + '.wxss 含不支持属性: ' + hits.join(','));
  else ok(d + '.wxss 合规');
}

// [6] 所有 JS 语法合法
console.log('\n[6] JS 语法（node --check）');
const cp = require('child_process');
const allJs = ['app.js'].concat(pageDirs.map(d => path.join('pages', d, d + '.js')));
const utilJs = (() => { try { return fs.readdirSync(path.join(root, 'utils')).filter(f => f.endsWith('.js')).map(f => path.join('utils', f)); } catch (e) { return []; } })();
let jsOk = 0;
for (const rel of allJs.concat(utilJs)) {
  const full = path.join(root, rel);
  try { cp.execSync('node --check "' + full + '"', { stdio: 'pipe' }); jsOk++; }
  catch (e) { bad(rel + ' 语法错误'); }
}
if (jsOk === allJs.length + utilJs.length) ok('全部 ' + jsOk + ' 个 JS 文件语法合法');

// [7] import 链（import wx from 'wx'）
console.log('\n[7] import 链');
const jsFiles = allJs.concat(utilJs.map(u => u));
let impOk = 0;
for (const rel of jsFiles) {
  const src = fs.readFileSync(path.join(root, rel), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const usesWx = /\bwx\s*\./.test(src);
  const importsWx = /^import\s+wx\s+from\s+['"]wx['"]/m.test(src);
  if (usesWx && !importsWx) bad(rel + ' 用 wx.* 但未 import wx');
  else { impOk++; }
}
if (impOk === jsFiles.length) ok('wx 导入齐全（' + impOk + ' 个文件）');

// [8] 编码（无 BOM/CRLF）
console.log('\n[8] 编码（无 BOM/CRLF）');
const allFiles = ['app.js', 'app.json', 'AGENTS.md'].concat(pageDirs.flatMap(d => [d + '.json', d + '.js', d + '.wxml', d + '.wxss'].map(f => path.join('pages', d, f))));
let encOk = 0;
for (const rel of allFiles) {
  const buf = fs.readFileSync(path.join(root, rel));
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) bad(rel + ' 含 BOM');
  else if (buf.includes(Buffer.from('\r\n'))) bad(rel + ' 含 CRLF');
  else encOk++;
}
if (encOk === allFiles.length) ok('全部 ' + encOk + ' 个文件 UTF-8 LF 干净');

console.log('\n' + (fail === 0 ? '=== 多文件模式自检全部通过 ===' : '=== 发现 ' + fail + ' 个问题 ==='));
process.exit(fail === 0 ? 0 : 1);