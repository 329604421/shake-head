/* pack.mjs —— 生成可导入 Craft 的干净工程快照（ZIP）
 *
 * 为什么需要：AIUI 官方 Web IDE（Craft）以「导入工程快照」方式运行，
 * 直接用旧快照会静默跑旧代码，且画面上若无版本标识无法察觉。每次改动后
 * 重新打包并导入，才能保证真机与本地代码一致。
 *
 * 行为：打包 pages/ utils/ app.js app.json assets/ 等全部运行期源文件，自动排除
 * tests / tools / docs / site / .github / node_modules / .git / 系统垃圾文件；
 * 自动读取 utils/layout.js 里的 BUILD 常量作为文件名版本号。
 *
 * 运行：node tools/pack.mjs [latest]
 * 产物：dist/摇头晃脑-眼镜端-<BUILD>.zip（dist/ 已在 .gitignore 中）
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/* 白名单：只放行 AIUI 运行时真正需要的东西。仓库里的 tests / tools / docs /
 * site / .github 以及开源元文件（README / LICENSE / .gitignore / .env.example）
 * 都不该混进快照 —— 黑名单漏一个就会打进包里，白名单则天然免疫。 */
const INCLUDE_FILE = new Set(['app.js', 'app.json']);
const INCLUDE_DIR = new Set(['pages', 'utils', 'assets']);
const EXCLUDE_DIR = new Set([
  'node_modules', '.git', '.github', '.cache', '.workbuddy', '.idea', '.vscode',
]);
const EXCLUDE_FILE = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

/* ---------- 版本号：从 layout.js 的 BUILD 常量读取 ---------- */
function readBuild() {
  try {
    const src = fs.readFileSync(path.join(ROOT, 'utils/layout.js'), 'utf8');
    const m = src.match(/export\s+const\s+BUILD\s*=\s*['"]([^'"]+)['"]/);
    if (m) return m[1];
  } catch (e) { /* 落到默认值 */ }
  return 'snapshot';
}

/* ---------- CRC32（Node 20.15+ 原生提供，低版本兜底自算） ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* ---------- 递归收集待打包文件 ---------- */
function collect(dir, prefix, out) {
  for (const name of fs.readdirSync(dir).sort()) {
    if (EXCLUDE_FILE.has(name)) continue;
    const abs = path.join(dir, name);
    const rel = prefix ? prefix + '/' + name : name;
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      if (EXCLUDE_DIR.has(name)) continue;
      collect(abs, rel, out);
    } else if (st.isFile()) {
      out.push({ rel, abs });
    }
  }
}

/* ---------- ZIP（store 模式，无压缩；文件名 UTF-8 置 flag bit 11） ---------- */
function dosStamp(d) {
  const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
  const date = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  return { time, date };
}

function buildZip(files) {
  const { time, date } = dosStamp(new Date());
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const f of files) {
    const data = fs.readFileSync(f.abs);
    const nameBuf = Buffer.from(f.rel, 'utf8');
    const crc = crc32(data);
    const flag = 0x0800; // UTF-8 文件名

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(flag, 6);
    lh.writeUInt16LE(0, 8);            // method: store
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(0x0314, 4);       // version made by: Unix, 2.0
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(flag, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);           // extra
    ch.writeUInt16LE(0, 32);           // comment
    ch.writeUInt16LE(0, 34);           // disk start
    ch.writeUInt16LE(0, 36);           // internal attrs
    ch.writeUInt32LE(0x81a40000, 38);  // external attrs: 0644
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);

    offset += 30 + nameBuf.length + data.length;
  }

  const cdBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, cdBuf, eocd]);
}

/* ---------- main ---------- */
/* 交互约定（v1.18）：**默认不自动打包**。日常改代码只跑验证（ESM 语法检查
 * + navsim 实证），明确要「打包 / 出包 / 要 zip」时才执行本脚本 —— 免得
 * 每次微调都产出一份新快照、还要重新导入 Craft。
 * 两种产物：
 *   node tools/pack.mjs          → dist/摇头晃脑-眼镜端-<BUILD>.zip（版本归档）
 *   node tools/pack.mjs latest   → dist/摇头晃脑-眼镜端-latest.zip（固定名，小步
 *                                   迭代时反复覆盖同一个文件，导入端不必每次
 *                                   换快照、也不会堆一排水版本号） */
const useLatest = process.argv.slice(2).indexOf('latest') >= 0;

const files = [];
for (const name of fs.readdirSync(ROOT).sort()) {
  const abs = path.join(ROOT, name);
  if (INCLUDE_FILE.has(name) && fs.statSync(abs).isFile()) files.push({ rel: name, abs });
  else if (INCLUDE_DIR.has(name) && fs.statSync(abs).isDirectory()) collect(abs, name, files);
}
if (!files.length) { console.error('未收集到任何文件，检查目录：' + ROOT); process.exit(1); }

const build = useLatest ? 'latest' : readBuild();
const outDir = path.join(ROOT, 'dist');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, '摇头晃脑-眼镜端-' + build + '.zip');
fs.writeFileSync(outPath, buildZip(files));

console.log('构建版本：' + build);
console.log('打包文件：' + files.length + ' 个');
files.forEach((f) => console.log('  · ' + f.rel));
console.log('产物：' + outPath);
