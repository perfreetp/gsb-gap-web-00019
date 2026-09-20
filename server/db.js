const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DB_PATH = process.env.GAP_DB || path.join(__dirname, 'gap.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

const now = () => Date.now();

function hashPassword(pw) {
  return crypto.createHash('sha256').update(`gap::${pw}`).digest('hex');
}

function notify({ user_id = null, base_id = null, person_id = null, type, title, body = '', ref_type = null, ref_id = null }) {
  db.prepare(`INSERT INTO notifications (user_id, base_id, person_id, type, title, body, ref_type, ref_id, created_at)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(user_id, base_id, person_id, type, title, body, ref_type, ref_id, now());
}

function audit(actor, action, entity, entity_id, detail = null) {
  db.prepare(`INSERT INTO audit_logs (actor_user_id, actor_name, action, entity, entity_id, detail, created_at)
              VALUES (?,?,?,?,?,?,?)`)
    .run(actor?.id || null, actor?.name || actor?.username || null, action, entity, entity_id,
      detail ? JSON.stringify(detail) : null, now());
}

module.exports = { db, now, hashPassword, notify, audit };
