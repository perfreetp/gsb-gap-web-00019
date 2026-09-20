import { h, esc, fmt, modal, toast } from '../core.js';
import { api, queuePush, queueLoad } from '../api.js';
import { getState } from '../app.js';
import { uuid, pseudoQR } from '../offline.js';

export async function trainingsPage(view) {
  view.innerHTML = '';
  const { user, meta } = getState();
  const manage = ['tech', 'base_admin', 'enterprise'].includes(user.role);
  let list = await api('/trainings');

  const card = h(`<div class="card">
    <div class="toolbar">
      <select id="f-up"><option value="">全部场次</option><option value="1">未开始</option></select>
      ${manage ? '<span style="flex:1"></span><button class="btn primary" id="new">＋ 按农时排培训</button>' : ''}
      <span class="muted" id="offline-note"></span>
    </div>
    <div id="list"></div></div>`);
  view.appendChild(card);
  const pending = queueLoad().filter(q => q.path.startsWith('/trainings'));
  if (pending.length) card.querySelector('#offline-note').textContent = `（${pending.length} 条签到待联网补传）`;

  function render() {
    const onlyUp = card.querySelector('#f-up').value === '1';
    const rows = onlyUp ? list.filter(t => t.start_at >= Date.now()) : list;
    card.querySelector('#list').innerHTML = rows.map(t => `
      <div class="qa-box">
        <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px">
          <div>
            <div class="stem">${esc(t.title)} ${t.start_at < Date.now() ? '<span class="pill gray">已结束</span>' : '<span class="pill green">待开展</span>'}</div>
            <div class="muted">🕑 ${fmt(t.start_at)} · ${t.duration_min}分钟 · 📍 ${esc(t.location || '—')}
              · 地块 ${esc(t.plot_code || '—')} · 讲师 ${esc(t.trainer_name || '待安排')}</div>
            ${t.subject_name ? `<span class="tag blue">${esc(t.subject_name)}</span>` : ''}
            ${t.tag_name ? `<span class="tag">定向：${esc(t.tag_name)}</span>` : ''}
            ${t.content ? `<div class="muted" style="margin-top:4px">内容：${esc(t.content)}</div>` : ''}
          </div>
          <div style="text-align:right">
            <div class="muted">签到 ${t.signed_count}/${t.expected_count}${t.trainer_rating ? ' · ⭐' + t.trainer_rating : ''}</div>
            <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
              <button class="btn small" data-detail="${t.id}">应到/缺课</button>
              <button class="btn small" data-sign="${t.id}">现场签到码</button>
              ${manage ? `<button class="btn small" data-remind="${t.id}">推送缺课提醒</button>` : ''}
            </div>
          </div>
        </div>
      </div>`).join('');
    card.querySelector('#list').querySelectorAll('[data-detail]').forEach(b =>
      b.onclick = () => detail(Number(b.dataset.detail)));
    card.querySelector('#list').querySelectorAll('[data-sign]').forEach(b =>
      b.onclick = () => signCode(Number(b.dataset.sign)));
    card.querySelector('#list').querySelectorAll('[data-remind]').forEach(b =>
      b.onclick = async () => {
        try {
          const r = await api(`/trainings/${b.dataset.remind}/remind-absent`, { method: 'POST' });
          toast(`已向 ${r.absent_count} 名缺课人员推送提醒`, 'ok');
          detail(Number(b.dataset.remind));
        } catch (e) { toast(e.message, 'error'); }
      });
  }
  card.querySelector('#f-up').onchange = render;
  if (manage) card.querySelector('#new').onclick = () => scheduleDlg(meta, async () => { list = await api('/trainings'); render(); });
  render();

  // 场次明细
  async function detail(id) {
    const d = await api('/trainings/' + id);
    const canProxy = manage;
    const node = h(`<div>
      <h3>${esc(d.title)}</h3>
      <div class="muted" style="margin-bottom:10px">${fmt(d.start_at)} · ${esc(d.location)} · 应到 ${d.attendees.length} 人 · 实到 ${d.signed_count} 人 · 缺课 <b style="color:var(--red)">${d.absent.length}</b> 人</div>
      <div class="table-wrap"><table><thead><tr><th>姓名</th><th>合作社</th><th>手机</th><th>状态</th><th>签到方式</th><th></th></tr></thead>
      <tbody>${d.attendees.map(a => `<tr>
        <td>${esc(a.name)}</td><td>${esc(a.cooperative_name || '—')}</td><td>${esc(a.phone || '—')}</td>
        <td>${a.signed ? '<span class="pill green">已签到</span>' : '<span class="pill red">缺课</span>'}</td>
        <td>${a.sign ? (a.sign.method === 'proxy' ? `代签${a.sign.proxy_name ? '（' + esc(a.sign.proxy_name) + '）' : ''}` : '扫码') : '—'}</td>
        <td>${!a.signed && canProxy ? `<button class="btn small" data-proxy="${a.id}">代签补录</button>` : ''}</td>
      </tr>`).join('') || '<tr><td colspan="6" class="muted">未设置应到名单</td></tr>'}</tbody></table></div>
      <div class="modal-foot">
        <button class="btn" id="feedback">我给讲师评分</button>
        <button class="btn primary" id="close">关闭</button></div></div>`);
    const m = modal(node, { width: 720 });
    node.querySelector('#close').onclick = m.close;
    node.querySelectorAll('[data-proxy]').forEach(b => b.onclick = async () => {
      try { await api(`/trainings/${id}/signin`, { method: 'POST',
        body: { person_id: Number(b.dataset.proxy), method: 'proxy' } });
        toast('代签补录成功', 'ok'); m.close(); detail(id); }
      catch (e) { toast(e.message, 'error'); }
    });
    node.querySelector('#feedback').onclick = async () => {
      const score = Number(prompt('请评分 1-5 星', '5'));
      if (score >= 1 && score <= 5) { await api(`/trainings/${id}/feedback`, { method: 'POST', body: { score } }); toast('感谢评分', 'ok'); m.close(); }
    };
  }

  // 签到码 + 药农扫码报名/签到（弱网存本地）
  function signCode(id) {
    const t = list.find(x => x.id === id);
    const payload = JSON.stringify({ type: 'gap-training-signin', id });
    const node = h(`<div style="text-align:center">
      <h3>${esc(t.title)}</h3>
      <div class="muted" style="margin:6px 0 12px">${fmt(t.start_at)} · ${esc(t.location || '')}</div>
      <img src="${pseudoQR(payload)}" style="width:180px;height:180px;border:1px solid var(--line);border-radius:10px">
      <div class="muted" style="margin:8px 0">现场出示，药农扫码完成报名与签到</div>
      <div class="form-row" style="justify-content:center">
        ${user.role === 'farmer'
          ? `<button class="btn primary" id="do-sign">📱 我要扫码签到</button>
             <button class="btn" id="do-reg">报名本场</button>`
          : `<div class="muted">药农登录后在本页可直接签到/报名；技术员也可在“应到/缺课”中代签补录</div>`}
      </div>
      <div id="sign-msg"></div>
      <div class="modal-foot"><button class="btn" id="close">关闭</button></div></div>`);
    const m = modal(node, { width: 460 });
    node.querySelector('#close').onclick = m.close;
    const doSign = async () => {
      const eventId = uuid();
      const body = { client_event_id: eventId, signed_at: Date.now() };
      try {
        const r = await api(`/trainings/${id}/signin`, { method: 'POST', body });
        node.querySelector('#sign-msg').innerHTML = r.duplicated
          ? '<span class="pill gray">已签到，请勿重复（幂等去重）</span>'
          : '<span class="pill green">✅ 签到成功</span>';
        toast('签到成功', 'ok');
      } catch (e) {
        if (String(e).includes('Failed to fetch')) {
          queuePush({ path: `/trainings/${id}/signin`, method: 'POST', body });
          node.querySelector('#sign-msg').innerHTML = '<span class="pill amber">📴 弱网已存本地，联网后自动补传</span>';
        } else toast(e.message, 'error');
      }
    };
    node.querySelector('#do-sign')?.addEventListener('click', doSign);
    node.querySelector('#do-reg')?.addEventListener('click', async () => {
      try { await api(`/trainings/${id}/register`, { method: 'POST' }); toast('报名成功', 'ok'); }
      catch (e) { toast(e.message, 'error'); }
    });
  }
}

// 技术员排课
function scheduleDlg(meta, onDone) {
  const dtLocal = ts => {
    const d = new Date(ts), p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const defaultTime = new Date(Date.now() + 2 * 86400000); defaultTime.setHours(9, 0, 0, 0);
  const node = h(`<div><h3>按农时安排培训场次</h3>
    <div class="form-row">
      <div class="field" style="flex:2"><label>培训标题 *</label><input id="t-title" placeholder="如：三七出苗期追肥与除草培训"></div>
    </div>
    <div class="form-row">
      <div class="field"><label>开始时间 *</label><input id="t-time" type="datetime-local" value="${dtLocal(defaultTime.getTime())}"></div>
      <div class="field"><label>时长(分钟)</label><input id="t-dur" type="number" value="120"></div>
      <div class="field"><label>讲师</label><select id="t-trainer"><option value="">—</option>
        ${meta.trainers.map(x => `<option value="${x.id}">${esc(x.name)}（${esc(x.title || '')}）</option>`).join('')}</select></div>
    </div>
    <div class="form-row">
      <div class="field" style="flex:1"><label>培训科目</label><select id="t-subject"><option value="">—</option>
        ${meta.subjects.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select></div>
      <div class="field" style="flex:1"><label>定向工种（自动生成应到名单）</label><select id="t-tag"><option value="">不定向（全员）</option>
        ${meta.skill_tags.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select></div>
      <div class="field" style="flex:1"><label>地块</label><select id="t-plot"><option value="">—</option>
        ${meta.plots.map(x => `<option value="${x.id}">${esc(x.code + x.name)}</option>`).join('')}</select></div>
      <div class="field" style="flex:1"><label>地点</label><input id="t-loc" placeholder="如：东坡田头教学点"></div>
    </div>
    <div class="field"><label>培训内容</label><textarea id="t-content" placeholder="讲授要点、现场演示内容"></textarea></div>
    <div class="modal-foot"><button class="btn" id="cancel">取消</button><button class="btn primary" id="save">发布并通知应到人员</button></div>
  </div>`);
  const m = modal(node, { width: 720 });
  node.querySelector('#cancel').onclick = m.close;
  node.querySelector('#save').onclick = async () => {
    const body = {
      title: node.querySelector('#t-title').value.trim(),
      start_at: new Date(node.querySelector('#t-time').value).getTime(),
      duration_min: Number(node.querySelector('#t-dur').value) || 120,
      trainer_id: Number(node.querySelector('#t-trainer').value) || null,
      subject_id: Number(node.querySelector('#t-subject').value) || null,
      tag_id: Number(node.querySelector('#t-tag').value) || null,
      plot_id: Number(node.querySelector('#t-plot').value) || null,
      location: node.querySelector('#t-loc').value.trim(),
      content: node.querySelector('#t-content').value.trim(),
    };
    if (!body.title || !body.start_at) return toast('标题与时间必填', 'error');
    try {
      await api('/trainings', { method: 'POST', body: { ...body, base_id: getState().user.base_id } });
      toast('已排课并推送通知', 'ok'); m.close(); onDone();
    } catch (e) { toast(e.message, 'error'); }
  };
}
