import { h, esc, fmt } from './core.js';
import { api } from './api.js';
import { modal } from './core.js';

const TYPE_ICO = {
  training_notice: '📅', training_absent: '⚠️', exam_fail: '❌', cert_issued: '🎫',
  cert_expiring: '⏰', appeal_result: '📨', harvest_warning: '🌾', exam_autosubmit: '⌛',
};

export async function open(onClose) {
  const list = await api('/notifications');
  const node = h(`<div>
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h3>通知中心</h3>
      <button class="btn small" id="read-all">全部已读</button>
    </div>
    <div style="margin-top:10px">${list.length ? list.map(n => `
      <div class="notif-item ${n.read ? '' : 'unread'}" data-id="${n.id}">
        <div>
          <div><b>${TYPE_ICO[n.type] || '🔔'} ${esc(n.title)}</b></div>
          <div class="muted" style="margin-top:3px">${esc(n.body || '')}</div>
        </div>
        <div class="muted" style="white-space:nowrap">${fmt(n.created_at)}</div>
      </div>`).join('') : '<p class="muted">暂无通知</p>'}
    </div></div>`);
  const m = modal(node, { width: 640 });
  node.querySelector('#read-all').onclick = async () => { await api('/notifications/read-all', { method: 'POST' }); m.close(); onClose?.(); };
  node.querySelectorAll('.notif-item').forEach(it => it.onclick = async () => {
    await api(`/notifications/${it.dataset.id}/read`, { method: 'POST' });
    onClose?.();
  });
}
