import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECRET_FILE = path.join(__dirname, '..', 'data', 'secret.key');
let SECRET;
if (fs.existsSync(SECRET_FILE)) {
  SECRET = fs.readFileSync(SECRET_FILE);
} else {
  SECRET = crypto.randomBytes(32);
  fs.writeFileSync(SECRET_FILE, SECRET);
}

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password, salt, hash) {
  const candidate = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(hash));
}

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

export function makeToken(user) {
  const payload = { uid: user.id, role: user.role, base_id: user.base_id, exp: Date.now() + 12 * 3600 * 1000 };
  const body = b64url(payload);
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function parseToken(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expect = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (sig.length !== expect.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function audit(actor, action, entity, entityId, detail) {
  db.prepare(`INSERT INTO audit_logs(actor_id, actor_name, action, entity, entity_id, detail)
              VALUES(?,?,?,?,?,?)`)
    .run(actor?.id ?? null, actor?.real_name ?? actor?.username ?? '系统',
         action, entity, entityId ?? null, detail ? JSON.stringify(detail) : null);
}

export function notify({ user_id = null, worker_id = null, title, body = '', type = null, ref_id = null }) {
  db.prepare(`INSERT INTO notifications(user_id, worker_id, title, body, type, ref_id)
              VALUES(?,?,?,?,?,?)`).run(user_id, worker_id, title, body, type, ref_id);
}

export function now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// 本地时间 YYYY-MM-DD HH:mm:ss
export function localNow(d = new Date()) {
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 19).replace('T', ' ');
}

export function addMonths(dateStr, months) {
  if (!months) return null;
  const d = new Date(dateStr.replace(' ', 'T'));
  d.setMonth(d.getMonth() + months);
  return localNow(d);
}

export function certNo(subjectCode, attemptId) {
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `GAP-${subjectCode}-${String(attemptId).padStart(5, '0')}-${rand}`;
}

export function maskIdCard(card) {
  if (!card || card.length < 8) return card;
  return card.slice(0, 4) + '**********' + card.slice(-4);
}
