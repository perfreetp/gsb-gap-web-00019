import { $, h } from './core.js';
import * as API from './api.js';
import pages from './pages.js';

const ROLE_NAME = { enterprise: '企业质控', base_admin: '基地管理员', tech: '技术指导员', farmer: '药农' };

const NAV = [
  { key: 'dashboard', ico: '📊', label: '工作台', roles: ['enterprise', 'base_admin', 'tech'] },
  { key: 'people', ico: '👥', label: '人员台账', roles: ['enterprise', 'base_admin', 'tech'] },
  { key: 'trainings', ico: '📅', label: '培训场次', roles: ['enterprise', 'base_admin', 'tech', 'farmer'] },
  { key: 'courses', ico: '📚', label: '课程内容库', roles: ['enterprise', 'base_admin', 'tech', 'farmer'] },
  { key: 'exams', ico: '📝', label: '考核管理', roles: ['enterprise', 'base_admin', 'tech', 'farmer'] },
  { key: 'grading', ico: '✍️', label: '评阅与申诉', roles: ['enterprise', 'base_admin', 'tech'] },
  { key: 'certificates', ico: '🎫', label: '培训合格证', roles: ['enterprise', 'base_admin', 'tech', 'farmer'] },
  { key: 'harvest', ico: '🌾', label: '采收登记', roles: ['enterprise', 'base_admin', 'tech'] },
  { key: 'stats', ico: '📈', label: '统计分析', roles: ['enterprise', 'base_admin', 'tech'] },
  { key: 'audit', ico: '🧾', label: '审计日志', roles: ['enterprise', 'base_admin', 'tech'] },
];

let state = { user: null, meta: null, current: 'dashboard' };
export const getState = () => state;

async function refreshUnread() {
  try {
    const list = await API.api('/notifications');
    const unread = list.filter(n => !n.read).length;
    const badge = $('#unread');
    badge.textContent = unread;
    badge.classList.toggle('hidden', unread === 0);
  } catch {}
}

function renderNav() {
  const nav = $('#nav');
  nav.innerHTML = '';
  NAV.filter(n => n.roles.includes(state.user.role)).forEach(n => {
    const item = h(`<div class="nav-item" data-key="${n.key}"><span class="ico">${n.ico}</span>${n.label}</div>`);
    if (n.key === state.current) item.classList.add('active');
    item.onclick = () => navigate(n.key);
    nav.appendChild(item);
  });
}

export async function navigate(key, params) {
  state.current = key;
  renderNav();
  const entry = NAV.find(n => n.key === key);
  $('#page-title').textContent = entry?.label || '';
  const view = $('#view');
  view.innerHTML = '<div class="muted">加载中…</div>';
  try {
    await pages[key](view, params || {});
  } catch (e) {
    if (e.message.includes('登录')) { logout(); return; }
    view.innerHTML = `<div class="card">加载失败：${e.message}</div>`;
  }
}

function logout() {
  API.clearToken();
  location.reload();
}

async function boot() {
  const user = await API.me();
  if (!user) {
    $('#login-view').classList.remove('hidden');
    $('#login-form').onsubmit = async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        const u = await API.login(fd.get('username').trim(), fd.get('password'));
        location.reload();
      } catch (err) { alert(err.message); }
    };
    return;
  }
  state.user = user;
  state.meta = await API.api('/meta');
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  $('#who').innerHTML = `<div style="color:#fff;font-weight:600">${user.name}</div>${ROLE_NAME[user.role]}`;
  $('#logout').onclick = logout;
  $('#bell').onclick = () => import('./notif-panel.js').then(m => m.open(refreshUnread));
  renderNav();

  // 联网状态与离线补传
  const dot = $('#net-dot');
  const setOnline = online => {
    dot.className = 'net-dot ' + (online ? 'online' : 'offline');
    dot.title = online ? '在线' : '离线（数据暂存本地）';
    if (online) API.queueFlush().then(refreshUnread);
  };
  window.addEventListener('online', () => setOnline(true));
  window.addEventListener('offline', () => setOnline(false));
  setOnline(navigator.onLine);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { setOnline(navigator.onLine); refreshUnread(); } });

  const defaultPage = user.role === 'farmer' ? 'trainings' : 'dashboard';
  navigate(defaultPage);
  refreshUnread();
  setInterval(refreshUnread, 60000);
}

boot();
