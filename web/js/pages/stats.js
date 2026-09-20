import { h, esc, fmt } from '../core.js';
import { api } from '../api.js';

const DIMS = [['subject', '按科目'], ['cooperative', '按合作社'], ['plot', '按地块']];

export async function statsPage(view) {
  view.innerHTML = '';
  // 合格率维度切换
  const barCard = h(`<div class="card"><h3>📊 合格率维度</h3>
    <div class="toolbar">
      <select id="dim">${DIMS.map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
    </div><div id="bars"></div></div>`);
  view.appendChild(barCard);

  async function loadDim(dim) {
    const rows = await api('/stats/pass-rate?dim=' + dim);
    const box = barCard.querySelector('#bars');
    box.innerHTML = rows.length ? rows.map(r => `
      <div style="margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:3px">
          <span>${esc(r.label)}</span>
          <span class="muted">合格 ${r.passed || 0}/${r.graded || 0} · <b>${r.rate ?? 0}%</b></span></div>
        <div class="progress"><span style="width:${r.rate || 0}%"></span></div>
      </div>`).join('') : '<p class="muted">暂无已评阅数据</p>';
  }
  barCard.querySelector('#dim').onchange = e => loadDim(e.target.value);
  loadDim('subject');

  // 缺训名单
  const missing = await api('/stats/missing-training');
  view.appendChild(h(`<div class="card"><h3>⚠️ 缺训名单（按已结束场次）</h3>
    <div class="table-wrap"><table><thead><tr><th>药农</th><th>缺席培训</th><th>培训时间</th></tr></thead>
    <tbody>${missing.length ? [...new Map(missing.map(m => [m.person_id + '-' + m.training_id, m])).values()]
      .map(m => `<tr><td>${esc(m.person_name)}</td><td>${esc(m.training_title)}</td><td>${fmt(m.start_at)}</td></tr>`).join('')
      : '<tr><td colspan="3" class="muted">全员出勤，无缺训记录</td></tr>'}</tbody></table></div></div>`));

  // 年度学时
  const year = new Date().getFullYear();
  const hours = await api('/stats/annual-hours?year=' + year);
  view.appendChild(h(`<div class="card"><h3>🕘 ${year} 年度学时（按实际签到计）</h3>
    <div class="table-wrap"><table><thead><tr><th>药农</th><th>合作社</th><th>参训场次</th><th>学时（小时）</th></tr></thead>
    <tbody>${hours.map(r => `<tr><td>${esc(r.name)}</td><td>${esc(r.cooperative_name || '—')}</td>
      <td>${r.sessions}</td><td><b>${r.hours}</b></td></tr>`).join('')}</tbody></table></div></div>`));

  // 讲师评分
  const trainers = await api('/stats/trainer-ratings');
  view.appendChild(h(`<div class="card"><h3>⭐ 讲师授课评分</h3>
    <div class="table-wrap"><table><thead><tr><th>讲师</th><th>职称</th><th>授课场次</th><th>评分条数</th><th>平均分</th></tr></thead>
    <tbody>${trainers.map(t => `<tr><td>${esc(t.name)}</td><td>${esc(t.title || '—')}</td><td>${t.sessions}</td>
      <td>${t.feedback_count}</td><td>${t.avg_score ? '⭐ ' + t.avg_score : '—'}</td></tr>`).join('')}</tbody></table></div></div>`));
}
