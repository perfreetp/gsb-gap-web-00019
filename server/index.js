import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, migrate } from './db.js';
import { parseToken, audit } from './util.js';
import { sweepExpired } from './exam-core.js';

migrate();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');
const PORT = process.env.PORT || 3000;

const routes = [];
export function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const rx = new RegExp('^' + pattern.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, m => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
  routes.push({ method, rx, keys, handler, opts });
}

Promise.all([
  import('./api/auth.js'),
  import('./api/org.js'),
  import('./api/workers.js'),
  import('./api/training.js'),
  import('./api/courses.js'),
  import('./api/exam.js'),
  import('./api/harvest.js'),
  import('./api/stats.js'),
]).then(() => {
  const server = http.createServer(async (req, res) => {
    try {
      await dispatch(req, res);
    } catch (err) {
      console.error(err);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '服务器内部错误：' + err.message }));
    }
  });
  server.listen(PORT, () => console.log(`GAP 平台已启动: http://localhost:${PORT}`));
  // 每分钟扫描超时考试，自动交卷
  setInterval(() => { try { sweepExpired(); } catch (e) { console.error(e); } }, 60000);
});

async function dispatch(req, res) {
  const url = new URL(req.url, 'http://x');
  const pathname = url.pathname;

  if (pathname.startsWith('/api/')) {
    const match = routes.find(r => r.method === req.method && r.rx.test(pathname));
    if (!match) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: '接口不存在' }));
    }
    const m = pathname.match(match.rx);
    const params = {};
    match.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
    const query = Object.fromEntries(url.searchParams);

    let body = null;
    if (req.method === 'POST' || req.method === 'PUT') {
      const raw = await readBody(req);
      const ct = req.headers['content-type'] || '';
      if (ct.includes('application/json') && raw) {
        try { body = JSON.parse(raw); } catch { return json(res, 400, { error: '请求体不是合法 JSON' }); }
      } else {
        body = Object.fromEntries(new URLSearchParams(raw));
      }
    }

    let user = null;
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const payload = parseToken(token);
    if (payload) user = db.prepare('SELECT * FROM users WHERE id=?').get(payload.uid);

    if (!match.opts.public && !user) return json(res, 401, { error: '未登录或登录已过期' });

    const ctx = { req, res, params, query, body, user, db,
      audit: (action, entity, id, detail) => audit(user, action, entity, id, detail) };
    try {
      await match.handler(ctx);
    } catch (err) {
      if (err instanceof HttpError) return json(res, err.status, { error: err.message });
      throw err;
    }
    return;
  }

  serveStatic(pathname, res);
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new HttpError(413, '请求体过大')); req.destroy(); } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

function serveStatic(pathname, res) {
  let fp = path.normalize(path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname));
  if (!fp.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) fp = path.join(PUBLIC, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
}
