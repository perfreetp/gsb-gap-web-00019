import { h, esc, fmt } from '../core.js';
import { api } from '../api.js';

const ACTIONS = ['', 'create', 'update', 'merge', 'import', 'signin', 'proxy_signin', 'submit',
  'auto_submit', 'paper_score_entry', 'grade', 'grade_update', 'double_grade_average',
  'appeal_submit', 'appeal_review', 'revoke', 'schedule'];

export async function auditPage(view) {
  view.innerHTML = '';
  const card = h(`<div class="card">
    <h3>🧾 审计日志（成绩修改 / 签到补录 / 证书操作均留痕）</h3>
    <div class="toolbar">
      <select id="entity">
        <option value="">全部对象</option>
        <option value="person">人员</option><option value="training">培训</option>
        <option value="exam_registration">考核成绩</option><option value="certificate">证书</option>
        <option value="harvest_batch">采收批次</option><option value="appeal">申诉</option>
      </select>
      <select id="action"><option value="">全部动作</option>${ACTIONS.slice(1).map(a => `<option>${a}</option>`).join('')}</select>
      <input id="q" placeholder="搜索操作人/内容">
      <button class="btn" id="go">查询</button>
    </div>
    <div id="list" class="table-wrap"></div></div>`);
  view.appendChild(card);

  async function load() {
    const p = new URLSearchParams();
    const e = card.querySelector('#entity').value, a = card.querySelector('#action').value;
    const q = card.querySelector('#q').value.trim();
    if (e) p.set('entity', e); if (a) p.set('action', a); if (q) p.set('q', q);
    const rows = await api('/audit?' + p.toString());
    card.querySelector('#list').innerHTML = `<table><thead><tr><th>时间</th><th>操作人</th><th>动作</th>
      <th>对象</th><th>详情</th></tr></thead><tbody>${rows.map(r => `<tr>
      <td style="white-space:nowrap">${fmt(r.created_at)}</td>
      <td>${esc(r.actor_name || '系统')}</td>
      <td><span class="tag blue">${esc(r.action)}</span></td>
      <td>${esc(r.entity)}${r.entity_id ? ' #' + r.entity_id : ''}</td>
      <td class="muted" style="max-width:420px">${esc(r.detail ? JSON.stringify(r.detail) : '')}</td></tr>`).join('')}
      </tbody></table>`;
  }
  card.querySelector('#go').onclick = load;
  card.querySelector('#q').onkeydown = e => e.key === 'Enter' && load();
  load();
}
