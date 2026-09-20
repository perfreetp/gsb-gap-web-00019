-- GAP 培训考核一体化平台 数据库结构
CREATE TABLE IF NOT EXISTS bases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cooperatives (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  base_id INTEGER NOT NULL REFERENCES bases(id),
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  base_id INTEGER NOT NULL REFERENCES bases(id),
  cooperative_id INTEGER REFERENCES cooperatives(id),
  code TEXT NOT NULL,            -- 地块编号
  name TEXT NOT NULL,           -- 地块名称
  crop_variety TEXT,            -- 种植药材品种
  manager_id INTEGER,           -- 责任药农
  area_mu REAL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('enterprise','base_admin','tech','farmer')),
  base_id INTEGER REFERENCES bases(id),
  person_id INTEGER,            -- 药农关联 people.id
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- 人员台账（主档）
CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  base_id INTEGER NOT NULL REFERENCES bases(id),
  name TEXT NOT NULL,
  id_card TEXT,                 -- 身份证（基地内去重键）
  phone TEXT,
  cooperative_id INTEGER REFERENCES cooperatives(id),
  plot_id INTEGER REFERENCES plots(id),
  employment_type TEXT CHECK (employment_type IN ('long_term','seasonal')),
  merged_into INTEGER REFERENCES people(id),  -- 重复合并指向
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_people_base ON people(base_id);
CREATE INDEX IF NOT EXISTS idx_people_idcard ON people(base_id, id_card);

CREATE TABLE IF NOT EXISTS skill_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,    -- seedling/transplant/weeding/...
  name TEXT NOT NULL,
  required_subject_ids TEXT NOT NULL  -- JSON 数组，必需培训科目
);

CREATE TABLE IF NOT EXISTS person_skills (
  person_id INTEGER NOT NULL REFERENCES people(id),
  tag_id INTEGER NOT NULL REFERENCES skill_tags(id),
  PRIMARY KEY (person_id, tag_id)
);

CREATE TABLE IF NOT EXISTS subjects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  pesticide_safety INTEGER NOT NULL DEFAULT 0,  -- 农药安全类（证书有有效期）
  valid_months INTEGER NOT NULL DEFAULT 0       -- 证书有效月数，0=长期
);

CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id INTEGER NOT NULL REFERENCES subjects(id),
  title TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('doc','video')),
  duration_sec INTEGER NOT NULL DEFAULT 0,
  content TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS course_progress (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL REFERENCES people(id),
  course_id INTEGER NOT NULL REFERENCES courses(id),
  watched_sec INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  UNIQUE (person_id, course_id)
);

CREATE TABLE IF NOT EXISTS trainers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  title TEXT,
  phone TEXT,
  rating_sum REAL NOT NULL DEFAULT 0,
  rating_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS trainings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  base_id INTEGER NOT NULL REFERENCES bases(id),
  title TEXT NOT NULL,
  subject_id INTEGER REFERENCES subjects(id),
  tag_id INTEGER REFERENCES skill_tags(id),  -- 按工种定向
  plot_id INTEGER REFERENCES plots(id),
  location TEXT,
  trainer_id INTEGER REFERENCES trainers(id),
  start_at INTEGER NOT NULL,
  duration_min INTEGER NOT NULL DEFAULT 120,
  content TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL
);

-- 应到名单（定向工种时可快照，空名单=按工种动态计算）
CREATE TABLE IF NOT EXISTS training_attendees (
  training_id INTEGER NOT NULL REFERENCES trainings(id),
  person_id INTEGER NOT NULL REFERENCES people(id),
  PRIMARY KEY (training_id, person_id)
);

-- 签到（幂等：同人同场次仅一条；client_event_id 防重复补传）
CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  training_id INTEGER NOT NULL REFERENCES trainings(id),
  person_id INTEGER NOT NULL REFERENCES people(id),
  method TEXT NOT NULL CHECK (method IN ('scan','proxy')),
  proxy_user_id INTEGER REFERENCES users(id),  -- 代签技术员
  client_event_id TEXT,
  signed_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (training_id, person_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_att_event ON attendance(client_event_id) WHERE client_event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS training_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  training_id INTEGER NOT NULL REFERENCES trainings(id),
  person_id INTEGER NOT NULL REFERENCES people(id),
  score INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
  UNIQUE (training_id, person_id)
);

CREATE TABLE IF NOT EXISTS question_bank (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id INTEGER NOT NULL REFERENCES subjects(id),
  variety TEXT,                 -- 药材品种，NULL=通用
  chapter TEXT,                 -- GAP 章节
  difficulty INTEGER NOT NULL CHECK (difficulty IN (1,2,3)),
  type TEXT NOT NULL CHECK (type IN ('single','multi','judge','image','short')),
  stem TEXT NOT NULL,
  image_url TEXT,
  options TEXT,                 -- JSON 数组
  answer TEXT,                  -- 客观题 JSON 答案；主观题参考答案
  analysis TEXT
);

CREATE TABLE IF NOT EXISTS exams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  base_id INTEGER NOT NULL REFERENCES bases(id),
  title TEXT NOT NULL,
  subject_id INTEGER NOT NULL REFERENCES subjects(id),
  variety TEXT,
  chapter TEXT,
  start_at INTEGER NOT NULL,
  duration_min INTEGER NOT NULL,
  pass_score INTEGER NOT NULL DEFAULT 60,
  max_retakes INTEGER NOT NULL DEFAULT 1,
  paper_question_count INTEGER NOT NULL DEFAULT 10,
  require_course_completion INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL
);

-- A/B 卷：组卷快照
CREATE TABLE IF NOT EXISTS exam_papers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id INTEGER NOT NULL REFERENCES exams(id),
  version TEXT NOT NULL CHECK (version IN ('A','B')),
  question_ids TEXT NOT NULL,  -- JSON 数组
  UNIQUE (exam_id, version)
);

CREATE TABLE IF NOT EXISTS exam_registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id INTEGER NOT NULL REFERENCES exams(id),
  person_id INTEGER NOT NULL REFERENCES people(id),
  attempt INTEGER NOT NULL DEFAULT 0,  -- 第几次（0 首考）
  paper_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'registered'
    CHECK (status IN ('registered','in_progress','submitted','graded','absent','blocked')),
  client_event_id TEXT,
  started_at INTEGER,
  submitted_at INTEGER,
  auto_submitted INTEGER NOT NULL DEFAULT 0,
  objective_score REAL,
  subjective_score REAL,
  total_score REAL,
  graded INTEGER NOT NULL DEFAULT 0,
  UNIQUE (exam_id, person_id, attempt)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reg_event ON exam_registrations(client_event_id) WHERE client_event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS exam_answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reg_id INTEGER NOT NULL REFERENCES exam_registrations(id),
  question_id INTEGER NOT NULL REFERENCES question_bank(id),
  answer TEXT,
  score REAL,
  updated_at INTEGER NOT NULL,
  UNIQUE (reg_id, question_id)
);

CREATE TABLE IF NOT EXISTS answer_grades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  answer_id INTEGER NOT NULL REFERENCES exam_answers(id),
  grader_id INTEGER NOT NULL REFERENCES users(id),
  score REAL NOT NULL,
  comment TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (answer_id, grader_id)
);

CREATE TABLE IF NOT EXISTS appeals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reg_id INTEGER NOT NULL REFERENCES exam_registrations(id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','reviewed','rejected','adjusted')),
  reply TEXT,
  reviewer_id INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER
);

CREATE TABLE IF NOT EXISTS certificates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL REFERENCES people(id),
  subject_id INTEGER NOT NULL REFERENCES subjects(id),
  exam_id INTEGER NOT NULL REFERENCES exams(id),
  reg_id INTEGER NOT NULL REFERENCES exam_registrations(id),
  cert_no TEXT UNIQUE NOT NULL,
  score REAL NOT NULL,
  issued_at INTEGER NOT NULL,
  valid_until INTEGER,           -- NULL=长期
  revoked INTEGER NOT NULL DEFAULT 0
);

-- 采收批次与作业人员校验
CREATE TABLE IF NOT EXISTS harvest_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  base_id INTEGER NOT NULL REFERENCES bases(id),
  plot_id INTEGER NOT NULL REFERENCES plots(id),
  batch_no TEXT UNIQUE NOT NULL,
  variety TEXT,
  harvested_at INTEGER NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS harvest_workers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES harvest_batches(id),
  person_id INTEGER NOT NULL REFERENCES people(id),
  tag_id INTEGER REFERENCES skill_tags(id),
  certified INTEGER NOT NULL,
  warning_reason TEXT,
  UNIQUE (batch_id, person_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),  -- NULL=广播给基地
  base_id INTEGER,
  person_id INTEGER REFERENCES people(id),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  ref_type TEXT,
  ref_id INTEGER,
  read INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER,
  actor_name TEXT,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  detail TEXT,
  created_at INTEGER NOT NULL
);
