import { toast } from './core.js';

const TOKEN_KEY = 'gap_token';
export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = t => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

export async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json',
      ...(getToken() ? { Authorization: 'Bearer ' + getToken() } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error(data?.error || `请求失败(${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export async function login(username, password) {
  const r = await fetch('/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || '登录失败');
  setToken(data.token);
  return data.user;
}
export async function me() {
  const r = await fetch('/api/auth/me', { headers: { Authorization: 'Bearer ' + getToken() } });
  if (!r.ok) return null;
  return (await r.json()).user;
}

// 弱网离线队列（IndexedDB 也可，localStorage 足够演示）
const QUEUE_KEY = 'gap_offline_queue';
export function queueLoad() { try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; } }
export function queueSave(items) { localStorage.setItem(QUEUE_KEY, JSON.stringify(items)); }
export function queuePush(item) { const q = queueLoad(); q.push(item); queueSave(q); }
export async function queueFlush() {
  const q = queueLoad();
  if (!q.length) return { flushed: 0 };
  const remain = [];
  let flushed = 0;
  for (const item of q) {
    try {
      await api(item.path, { method: item.method, body: item.body });
      flushed++;
    } catch (e) {
      // 业务拒绝（如重复）也视为已处理；网络错误保留
      if (e.message.includes('Failed to fetch') || e.message.includes('fetch')) remain.push(item);
      else flushed++;
    }
  }
  queueSave(remain);
  if (flushed) toast(`已补传 ${flushed} 条离线记录`, 'ok');
  return { flushed, remain: remain.length };
}
