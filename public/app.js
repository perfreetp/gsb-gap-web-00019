const MENUS = {
  enterprise: [
    { key: 'dashboard', ico: '🏠', name: '全量概览' },
    { key: 'workers', ico: '👥', name: '人员台账' },
    { key: 'plots', ico: '🗺️', name: '地块合作社' },
    { key: 'training', ico: '📚', name: '培训记录' },
    { key: 'courses', ico: '🎬', name: '课程库' },
    { key: 'exams', ico: '📝', name: '考试成绩' },
    { key: 'review', ico: '✍️', name: '评阅申诉' },
    { key: 'certs', ico: '🏅', name: '合格证' },
    { key: 'harvest', ico: '🌾', name: '采收留痕' },
    { key: 'stats', ico: '📊', name: '统计分析' },
    { key: 'audit', ico: '🛡️', name: '审计日志' },
  ],
  admin: [
    { key: 'dashboard', ico: '🏠', name: '工作台' },
    { key: 'workers', ico: '👥', name: '人员台账' },
    { key: 'plots', ico: '🗺️', name: '地块合作社' },
    { key: 'training', ico: '📚', name: '培训管理' },
    { key: 'courses', ico: '🎬', name: '课程库' },
    { key: 'exams', ico: '📝', name: '考核管理' },
    { key: 'review', ico: '✍️', name: '评阅申诉' },
    { key: 'certs', ico: '🏅', name: '合格证' },
    { key: 'harvest', ico: '🌾', name: '采收登记' },
    { key: 'stats', ico: '📊', name: '统计分析' },
    { key: 'audit', ico: '🛡️', name: '审计日志' },
  ],
  tech: [
    { key: 'dashboard', ico: '🏠', name: '工作台' },
    { key: 'workers', ico: '👥', name: '人员查看' },
    { key: 'plots', ico: '🗺️', name: '地块查看' },
    { key: 'training', ico: '📚', name: '培训排课' },
    { key: 'courses', ico: '🎬', name: '课程库' },
    { key: 'exams', ico: '📝', name: '组卷监考' },
    { key: 'review', ico: '✍️', name: '评阅复核' },
    { key: 'certs', ico: '🏅', name: '证书查看' },
    { key: 'harvest', ico: '🌾', name: '采收登记' },
    { key: 'stats', ico: '📊', name: '统计分析' },
  ],
  farmer: [
    { key: 'dashboard', ico: '🏠', name: '我的首页' },
    { key: 'training', ico: '📚', name: '培训报名' },
    { key: 'courses', ico: '🎬', name: '在线学习' },
    { key: 'exam', ico: '📝', name: '我的考试' },
    { key: 'certs', ico: '🏅', name: '我的证书' },
  ],
};

const PAGES = {
  dashboard: renderDashboard,
  workers: renderWorkers,
  plots: renderPlots,
  training: renderTraining,
  'session-detail': renderSessionDetail,
  courses: renderCourses,
  exams: renderExams,
  'exam-taking': (id) => startExam(id),
  exam: renderExamEntry,
  review: renderReview,
  certs: renderCertificates,
  harvest: renderHarvest,
  stats: renderStats,
  audit: renderAudit,
};

function go(page, arg) {
  const allowed = new Set(MENUS[state.user.role].map(m => m.key));
  // 详情类页面不在菜单但允许访问
  const accessible = allowed.has(page) || ['session-detail', 'exam-taking'].includes(page);
  if (!accessible) page = 'dashboard';
  state.page = page;
  renderShell();
  const fn = PAGES[page];
  Promise.resolve(fn(arg)).catch(e => {
    document.getElementById('content').innerHTML =
      `<div class="panel"><div class="empty">⚠️ ${esc(e.message)}</div></div>`;
  });
}
window.go = go;

function renderShell() {
  document.getElementById('app-view').hidden = false;
  document.getElementById('login-view').hidden = true;
  const menus = MENUS[state.user.role];
  const active = menus.find(m => m.key === state.page) || menus[0];
  document.getElementById('top-title').textContent = active.name;
  document.getElementById('top-sub').textContent = roleName(state.user.role) +
    (state.worker ? ` · ${state.worker.name}${state.worker.plot_code ? ' · 地块 ' + state.worker.plot_code : ''}` : '');
  document.getElementById('who').textContent = state.user.real_name;
  document.getElementById('sidebar').innerHTML = menus.map(m =>
    `<div class="nav-item ${m.key === state.page ? 'active' : ''}" onclick="go('${m.key}')">
      <span class="ico">${m.ico}</span>${m.name}</div>`).join('');
}

async function login(username, password) {
  const r = await fetch('/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  }).then(x => x.json().then(j => ({ ok: x.ok, j })));
  if (!r.ok) throw new Error(r.j.error || '登录失败');
  state.token = r.j.token; state.user = r.j.user;
  localStorage.setItem('gap_token', state.token);
  const me = await api('/api/auth/me');
  state.worker = me.worker;
  // 上线自动补传
  syncOfflineOps();
  go('dashboard');
  loadBellBadge();
}

function logout() {
  state.token = null; state.user = null;
  localStorage.removeItem('gap_token');
  document.getElementById('app-view').hidden = true;
  document.getElementById('login-view').hidden = false;
}
window.logout = logout;

async function loadBellBadge() {
  try {
    const { list } = await api('/api/notifications');
    const unread = list.filter(n => !n.is_read).length;
    const badge = document.getElementById('bell-badge');
    badge.hidden = unread === 0; badge.textContent = unread;
    return list;
  } catch { return []; }
}

document.getElementById('login-form').onsubmit = async e => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try { await login(fd.get('username'), fd.get('password')); }
  catch (err) { toast(err.message, 'err'); }
};

document.getElementById('logout-btn').onclick = logout;
document.getElementById('bell-btn').onclick = async () => {
  const list = await loadBellBadge();
  modal('消息通知', list.length ? list.map(n => `
    <div class="notif-item ${n.is_read ? '' : 'unread'}">
      <b>${esc(n.title)}</b><span class="muted" style="float:right">${fmtDate(n.created_at)}</span>
      <p>${esc(n.body || '')}</p>
    </div>`).join('') : '<div class="empty">暂无通知</div>',
    { wide: true, footer: [{ text: '全部标为已读', cls: 'primary', onClick: async () => {
      for (const n of list) if (!n.is_read) await api(`/api/notifications/${n.id}/read`, { method: 'POST' });
      loadBellBadge();
    } }] });
};

// 演示账号快捷填充
const DEMO = [
  { u: 'qiye', label: '企业质控·周经理' },
  { u: 'admin1', label: '基地管理员·亳州' },
  { u: 'tech1', label: '技术员·杨老师' },
  { u: 'farmer1', label: '药农·王大山' },
  { u: 'farmer2', label: '药农·赵敏(季节性)' },
];
document.getElementById('demo-chips').innerHTML = DEMO.map(d =>
  `<span class="chip" data-u="${d.u}" title="密码 ${d.u}123">${d.label}</span>`).join('');
document.querySelectorAll('#demo-chips .chip').forEach(ch => ch.onclick = () => {
  const f = document.getElementById('login-form');
  f.username.value = ch.dataset.u; f.password.value = ch.dataset.u + '123';
});

// 启动：有 token 则自动登录
(async function boot() {
  if (state.token) {
    try {
      const me = await api('/api/auth/me');
      state.user = me.user; state.worker = me.worker;
      go('dashboard'); loadBellBadge(); syncOfflineOps();
    } catch { logout(); }
  }
  // 每 60 秒：到期证书扫描（仅登录态，后端有角色校验，失败静默）
  setInterval(async () => {
    if (!state.token) return;
    try { await api('/api/certificates/renew-scan', { method: 'POST', body: {} }); } catch {}
    if (state.user) loadBellBadge();
  }, 60000);
})();
