// 全局状态、API 封装、通用 UI 组件
const state = {
  token: localStorage.getItem('gap_token') || null,
  user: null, worker: null,
  org: null,
  page: 'dashboard',
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}),
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    if (res.status === 401) { logout(); throw new Error('登录已过期，请重新登录'); }
    throw new Error(data.error || ('请求失败 ' + res.status));
  }
  return data;
}

function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast ' + type;
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => (el.hidden = true), 2600);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDate(s) { return s ? s.replace('T', ' ').slice(0, 16) : '—'; }
function fmtDay(s) { return s ? String(s).slice(0, 10) : '—'; }
function roleName(r) { return { enterprise: '企业质控', admin: '基地管理员', tech: '技术指导员', farmer: '药农' }[r] || r; }
function empName(t) { return t === 'long_term' ? '长期用工' : '季节性用工'; }
function typeName(t) { return { single: '单选', multi: '多选', judge: '判断', image: '识图', short: '简答' }[t] || t; }
function diffName(d) { return ['', '易', '中', '难'][d] || d; }

function modal(title, bodyHtml, { wide = false, footer = [] } = {}) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `<div class="modal-mask" id="modal-mask">
    <div class="modal ${wide ? 'wide' : ''}">
      <div class="modal-head"><b>${esc(title)}</b><button class="btn ghost" id="modal-x">✕</button></div>
      <div class="modal-body" id="modal-body">${bodyHtml}</div>
      ${footer.length ? `<div class="modal-foot">${footer.map((f, i) =>
        `<button class="btn ${f.cls || ''}" data-fi="${i}">${esc(f.text)}</button>`).join('')}</div>` : ''}
    </div></div>`;
  const close = () => (root.innerHTML = '');
  document.getElementById('modal-x').onclick = close;
  document.getElementById('modal-mask').addEventListener('click', e => { if (e.target.id === 'modal-mask') close(); });
  footer.forEach((f, i) => {
    const btn = document.querySelector(`[data-fi="${i}"]`);
    btn.onclick = async () => {
      try { const r = await f.onClick?.({ close, body: document.getElementById('modal-body') }); if (r !== false) close(); }
      catch (e) { toast(e.message, 'err'); }
    };
  });
  return { close, body: document.getElementById('modal-body') };
}

function confirmDlg(text) {
  return new Promise(resolve => {
    modal('请确认', `<p style="padding:6px 0">${esc(text)}</p>`, {
      footer: [
        { text: '取消', onClick: () => resolve(false) },
        { text: '确定', cls: 'primary', onClick: () => resolve(true) },
      ],
    });
  });
}

// 本地离线队列（弱网报名/签到/学习进度）
const offlineStore = {
  key: 'gap_offline_ops',
  list() { return JSON.parse(localStorage.getItem(this.key) || '[]'); },
  add(op) {
    const ops = this.list();
    const nonce = op.client_nonce || crypto.randomUUID();
    if (ops.some(o => o.client_nonce === nonce)) return nonce;
    ops.push({ ...op, client_nonce: nonce, ts: Date.now() });
    localStorage.setItem(this.key, JSON.stringify(ops));
    return nonce;
  },
  clear(nonces) {
    const remain = this.list().filter(o => !nonces.includes(o.client_nonce));
    localStorage.setItem(this.key, JSON.stringify(remain));
  },
};

async function syncOfflineOps() {
  const ops = offlineStore.list();
  if (!ops.length) return;
  if (!navigator.onLine) return;
  try {
    const r = await api('/api/ops/sync', { method: 'POST', body: { ops } });
    offlineStore.clear(ops.map(o => o.client_nonce));
    if (r.results?.length) toast(`离线数据已补传 ${r.results.length} 条（已去重）`, 'ok');
  } catch (e) { /* 下次再试 */ }
}
window.addEventListener('online', syncOfflineOps);
