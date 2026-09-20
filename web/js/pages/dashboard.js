import { h, esc, fmt } from '../core.js';
import { api } from '../api.js';
import { getState, navigate } from '../app.js';

export async function dashboardPage(view) {
  view.innerHTML = '';
  const { user } = getState();
  const s = await api('/stats/overview');
  const upcoming = (await api('/trainings?upcoming=1')).slice(0, 5);
  const pendingGrading = await api('/grading/pending').catch(() => []);
  const expiring = (await api('/certificates?expiring_days=30')).slice(0, 5);

  view.appendChild(h(`<div class="grid c4">
    <div class="stat"><div class="lbl">在册药农</div><div class="num">${s.people}</div></div>
    <div class="stat"><div class="lbl">考核合格率</div><div class="num">${s.pass_rate ?? '—'}${s.pass_rate != null ? '%' : ''}</div></div>
    <div class="stat ${s.expiring_certs ? 'warn' : ''}"><div class="lbl">30天内证书到期</div><div class="num">${s.expiring_certs}</div></div>
    <div class="stat ${s.harvest_warnings ? 'bad' : ''}"><div class="lbl">采收无证预警</div><div class="num">${s.harvest_warnings}</div></div>
  </div>`));
  view.appendChild(h(`<div class="grid c4" style="margin-top:14px">
    <div class="stat"><div class="lbl">已评阅考核场次</div><div class="num">${s.exams.graded}</div></div>
    <div class="stat"><div class="lbl">累计签到人次</div><div class="num">${s.trainings.signins}</div></div>
    <div class="stat"><div class="lbl">培训场次</div><div class="num">${s.trainings.sessions}</div></div>
    <div class="stat"><div class="lbl">有效证书</div><div class="num">${s.certs}</div></div>
  </div>`));

  const wrap = h(`<div class="grid c2" style="margin-top:16px"></div>`);
  const trainCard = h(`<div class="card"><h3>📅 近期培训</h3>
    ${upcoming.length ? upcoming.map(t => `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #eef3f0">
      <div><b>${esc(t.title)}</b><div class="muted">${fmt(t.start_at)} · ${esc(t.location || '')} · ${esc(t.trainer_name || '')}</div></div>
      <span class="pill green">${t.signed_count}/${t.expected_count} 已签到</span></div>`).join('')
      : '<p class="muted">暂无安排</p>'}</div>`);
  trainCard.querySelector('h3').style.cursor = 'pointer';
  trainCard.querySelector('h3').onclick = () => navigate('trainings');
  wrap.appendChild(trainCard);

  const alerts = h(`<div class="card"><h3>🔔 待办与预警</h3>
    ${user.role !== 'enterprise' && pendingGrading.length ? `<div style="cursor:pointer;color:var(--blue)" data-go="grading">✍️ ${pendingGrading.length} 份试卷待评阅（识图/简答）</div>` : ''}
    ${expiring.length ? expiring.map(c => `<div style="padding:6px 0">⏰ <b>${esc(c.person_name)}</b> 的《${esc(c.subject_name)}》证书还有 ${c.days_left} 天到期</div>`).join('') : '<div class="muted">暂无到期证书</div>'}
    ${s.harvest_warnings ? `<div style="margin-top:6px"><span class="pill red">${s.harvest_warnings} 条采收无证记录</span></div>` : ''}
  </div>`);
  alerts.querySelectorAll('[data-go]').forEach(el => el.onclick = () => navigate(el.dataset.go));
  wrap.appendChild(alerts);
  view.appendChild(wrap);
}
