import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'gap.db'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

export function migrate() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS bases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    location TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS cooperatives (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    base_id INTEGER REFERENCES bases(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    UNIQUE(base_id, name)
  );

  CREATE TABLE IF NOT EXISTS plots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    base_id INTEGER REFERENCES bases(id) ON DELETE CASCADE,
    coop_id INTEGER REFERENCES cooperatives(id) ON DELETE SET NULL,
    code TEXT NOT NULL,
    name TEXT,
    herb_variety TEXT,
    area_mu REAL,
    manager_id INTEGER,
    UNIQUE(base_id, code)
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    real_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('enterprise','admin','tech','farmer')),
    base_id INTEGER REFERENCES bases(id) ON DELETE SET NULL,
    worker_id INTEGER,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS workers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    base_id INTEGER REFERENCES bases(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    id_card TEXT,
    gender TEXT,
    phone TEXT,
    employment_type TEXT CHECK(employment_type IN ('long_term','seasonal')),
    coop_id INTEGER REFERENCES cooperatives(id) ON DELETE SET NULL,
    plot_id INTEGER REFERENCES plots(id) ON DELETE SET NULL,
    status TEXT DEFAULT 'active',
    merged_into INTEGER REFERENCES workers(id) ON DELETE SET NULL,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_workers_card ON workers(id_card);
  CREATE INDEX IF NOT EXISTS idx_workers_base ON workers(base_id);

  CREATE TABLE IF NOT EXISTS worker_merge_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kept_id INTEGER NOT NULL,
    removed_id INTEGER NOT NULL,
    reason TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS skills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    sort_no INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS subjects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    category TEXT,
    valid_months INTEGER DEFAULT 0,
    credit_hours REAL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS skill_subjects (
    skill_id INTEGER REFERENCES skills(id) ON DELETE CASCADE,
    subject_id INTEGER REFERENCES subjects(id) ON DELETE CASCADE,
    PRIMARY KEY(skill_id, subject_id)
  );

  CREATE TABLE IF NOT EXISTS worker_skills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_id INTEGER REFERENCES workers(id) ON DELETE CASCADE,
    skill_id INTEGER REFERENCES skills(id) ON DELETE CASCADE,
    UNIQUE(worker_id, skill_id)
  );

  CREATE TABLE IF NOT EXISTS courses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_id INTEGER REFERENCES subjects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    type TEXT CHECK(type IN ('doc','video')),
    duration_sec INTEGER DEFAULT 0,
    chapters TEXT,
    content TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS course_progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_id INTEGER REFERENCES workers(id) ON DELETE CASCADE,
    course_id INTEGER REFERENCES courses(id) ON DELETE CASCADE,
    watched_sec INTEGER DEFAULT 0,
    finished_chapters TEXT DEFAULT '[]',
    completed INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(worker_id, course_id)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    base_id INTEGER REFERENCES bases(id) ON DELETE CASCADE,
    subject_id INTEGER REFERENCES subjects(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    train_time TEXT NOT NULL,
    location TEXT,
    plot_id INTEGER REFERENCES plots(id) ON DELETE SET NULL,
    lecturer TEXT,
    content TEXT,
    required_skill_id INTEGER REFERENCES skills(id) ON DELETE SET NULL,
    credit_hours REAL DEFAULT 0,
    status TEXT DEFAULT 'scheduled',
    created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS enrollments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
    worker_id INTEGER REFERENCES workers(id) ON DELETE CASCADE,
    enrolled_at TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(session_id, worker_id)
  );

  CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
    worker_id INTEGER REFERENCES workers(id) ON DELETE CASCADE,
    check_in_at TEXT,
    method TEXT CHECK(method IN ('qrcode','proxy')),
    proxy_by INTEGER,
    client_nonce TEXT,
    source TEXT DEFAULT 'online',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(session_id, worker_id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_att_nonce ON attendance(client_nonce) WHERE client_nonce IS NOT NULL;

  CREATE TABLE IF NOT EXISTS session_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
    worker_id INTEGER REFERENCES workers(id) ON DELETE CASCADE,
    score INTEGER CHECK(score BETWEEN 1 AND 5),
    comment TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(session_id, worker_id)
  );

  CREATE TABLE IF NOT EXISTS question_bank (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_id INTEGER REFERENCES subjects(id) ON DELETE CASCADE,
    variety TEXT,
    chapter TEXT,
    difficulty INTEGER CHECK(difficulty BETWEEN 1 AND 3),
    type TEXT CHECK(type IN ('single','multi','judge','image','short')),
    stem TEXT NOT NULL,
    options TEXT,
    answer TEXT,
    score REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS exams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    base_id INTEGER REFERENCES bases(id) ON DELETE CASCADE,
    subject_id INTEGER REFERENCES subjects(id) ON DELETE CASCADE,
    variety TEXT,
    title TEXT NOT NULL,
    start_time TEXT NOT NULL,
    duration_min INTEGER NOT NULL,
    pass_score REAL NOT NULL DEFAULT 60,
    max_retakes INTEGER DEFAULT 1,
    blueprint TEXT DEFAULT '[]',
    status TEXT DEFAULT 'published',
    created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS exam_papers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exam_id INTEGER REFERENCES exams(id) ON DELETE CASCADE,
    version TEXT NOT NULL,
    questions TEXT NOT NULL,
    total_score REAL DEFAULT 100,
    UNIQUE(exam_id, version)
  );

  CREATE TABLE IF NOT EXISTS exam_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exam_id INTEGER REFERENCES exams(id) ON DELETE CASCADE,
    paper_id INTEGER REFERENCES exam_papers(id) ON DELETE CASCADE,
    worker_id INTEGER REFERENCES workers(id) ON DELETE CASCADE,
    attempt_no INTEGER DEFAULT 1,
    status TEXT DEFAULT 'ongoing' CHECK(status IN ('ongoing','submitted','graded','absent')),
    started_at TEXT DEFAULT (datetime('now','localtime')),
    deadline_at TEXT,
    submitted_at TEXT,
    objective_score REAL DEFAULT 0,
    subjective_score REAL DEFAULT 0,
    total_score REAL,
    passed INTEGER,
    source TEXT DEFAULT 'online',
    client_nonce TEXT,
    UNIQUE(exam_id, worker_id, attempt_no)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_attempt_nonce ON exam_attempts(client_nonce) WHERE client_nonce IS NOT NULL;

  CREATE TABLE IF NOT EXISTS attempt_answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    attempt_id INTEGER REFERENCES exam_attempts(id) ON DELETE CASCADE,
    qid INTEGER NOT NULL,
    answer TEXT,
    score REAL,
    reviewer_id INTEGER,
    review_round INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(attempt_id, qid)
  );

  CREATE TABLE IF NOT EXISTS appeals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    attempt_id INTEGER REFERENCES exam_attempts(id) ON DELETE CASCADE,
    worker_id INTEGER REFERENCES workers(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
    reply TEXT,
    reviewer_id INTEGER,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    handled_at TEXT
  );

  CREATE TABLE IF NOT EXISTS certificates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cert_no TEXT NOT NULL UNIQUE,
    worker_id INTEGER REFERENCES workers(id) ON DELETE CASCADE,
    subject_id INTEGER REFERENCES subjects(id) ON DELETE CASCADE,
    attempt_id INTEGER REFERENCES exam_attempts(id) ON DELETE SET NULL,
    score REAL,
    issued_at TEXT DEFAULT (datetime('now','localtime')),
    expire_at TEXT,
    status TEXT DEFAULT 'valid'
  );

  CREATE TABLE IF NOT EXISTS harvest_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_no TEXT NOT NULL UNIQUE,
    base_id INTEGER REFERENCES bases(id) ON DELETE CASCADE,
    plot_id INTEGER REFERENCES plots(id) ON DELETE SET NULL,
    variety TEXT,
    harvest_time TEXT NOT NULL,
    remark TEXT,
    created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS harvest_workers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id INTEGER REFERENCES harvest_batches(id) ON DELETE CASCADE,
    worker_id INTEGER REFERENCES workers(id) ON DELETE CASCADE,
    certified INTEGER NOT NULL,
    required_subject TEXT,
    reason TEXT,
    UNIQUE(batch_id, worker_id)
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    worker_id INTEGER REFERENCES workers(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT,
    type TEXT,
    ref_id INTEGER,
    is_read INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id INTEGER,
    actor_name TEXT,
    action TEXT NOT NULL,
    entity TEXT,
    entity_id INTEGER,
    detail TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS op_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_nonce TEXT NOT NULL UNIQUE,
    worker_id INTEGER,
    op_type TEXT NOT NULL,
    payload TEXT,
    status TEXT DEFAULT 'pending',
    result TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    synced_at TEXT
  );
  `);
}

migrate();
