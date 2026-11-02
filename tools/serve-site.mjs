/* serve-site.mjs —— 本地预览官网静态站（零依赖）
 *
 * 官网是纯静态单页：index.html + assets/（图片与一段 mp4）。直接用
 * file:// 打开会因为 video 的 range 请求和相对路径行为不一致而踩坑，
 * 所以给一个最小 http 服务：
 *
 *   node tools/serve-site.mjs          → http://127.0.0.1:4173
 *   node tools/serve-site.mjs 8080     → 换端口
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'site');
const PORT = Number(process.argv[2] || 4173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

const server = http.createServer(function (req, res) {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
  const abs = path.resolve(ROOT, rel);

  /* 目录穿越防护：解析后必须仍在 site/ 内 */
  if (abs.indexOf(ROOT) !== 0) {
    res.writeHead(403).end('forbidden');
    return;
  }

  fs.stat(abs, function (err, st) {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 not found');
      return;
    }
    const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;
    /* video 拖动进度依赖 206 + Content-Range */
    if (range && /^bytes=\d*-\d*$/.test(range)) {
      const parts = range.replace('bytes=', '').split('-');
      const start = parts[0] ? Number(parts[0]) : 0;
      const end = parts[1] ? Number(parts[1]) : st.size - 1;
      res.writeHead(206, {
        'content-type': type,
        'content-range': 'bytes ' + start + '-' + end + '/' + st.size,
        'accept-ranges': 'bytes',
        'content-length': end - start + 1,
      });
      fs.createReadStream(abs, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'accept-ranges': 'bytes' });
    fs.createReadStream(abs).pipe(res);
  });
});

server.listen(PORT, '127.0.0.1', function () {
  console.log('官网预览：http://127.0.0.1:' + PORT + '  （Ctrl+C 结束）');
});
