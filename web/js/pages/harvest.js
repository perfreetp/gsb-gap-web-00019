import { h, esc, fmt, modal, toast } from '../core.js';
import { api } from '../api.js';
import { getState } from '../app.js';

export async function harvestPage(view) {
  view.innerHTML = '';
  const { user, meta } = getState();
  const canCreate = ['tech', 'base_admin', 'enterprise'].includes(user.role);
  const batches = await api('/harvest/batches');

  const card = h(`<div class="card">
    <div class="toolbar">
      <b>🌾 采收批次台账</b><span class="muted">登记即校验当期作业人员持证状态，随批次留痕，可导出给下游客户/检查方</span>
      <span style="flex:1"></span>
      ${canCreate ? '<button class="btn primary" id="new">＋ 登记采收批次</button>' : ''}
    </div>
    <div class="table-wrap"><table><thead><tr><th>批次号</th><th>地块</th><th>品种</th><th>采收时间</th>
      <th>作业人数</th><th>持证预警</th><th></th></tr></thead>
    <tbody>${batches.map(b => `<tr>
      <td><b>${esc(b.batch_no)}</b></td><td>${esc(b.plot_code + b.plot_name)}</td>
      <td>${esc(b.variety || '—')}</td><td>${fmt(b.harvested_at)}</td>
      <td>${b.worker_count}</td>
      <td>${b.warning_count ? `<span class="pill red">${b.warning_count} 人未持证（已填因）</span>` : '<span class="pill green">全部持证</span>'}</td>
      <td><button class="btn small" data-view="${b.id}">批次留痕/导出</button></td></tr>`).join('')
      || '<tr><td colspan="7" class="muted">暂无采收批次</td></tr>'}</tbody></table></div></div>`);
  view.appendChild(card);
  card.querySelector('#new')?.addEventListener('click', () => createDlg(meta, () => harvestPage(view)));
  card.querySelectorAll('[data-view]').forEach(b =>
    b.onclick = () => viewBatch(Number(b.dataset.view)));
}

function createDlg(meta, onDone) {
  const people = []; // 动态加载
  const node = h(`<div><h3>登记采收批次并校验持证</h3>
    <div class="form-row">
      <div class="field" style="flex:1"><label>地块 *</label><select id="h-plot">
        ${meta.plots.map(p => `<option value="${p.id}">${esc(p.code + p.name)}（${esc(p.crop_variety || '')}）</option>`).join('')}</select></div>
      <div class="field"><label>批次号（留空自动生成）</label><input id="h-no"></div>
      <div class="field"><label>采收时间</label><input id="h-time" type="datetime-local"></div>
    </div>
    <div class="form-row" style="align-items:flex-end">
      <div class="field" style="flex:1"><label>增加作业人员</label>
        <input id="h-person" list="h-plist" placeholder="选择药农">
        <datalist id="h-plist"></datalist></div>
      <div class="field"><label>从事工种</label><select id="h-tag">
        ${meta.skill_tags.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></div>
      <button class="btn" id="h-add">＋ 添加并校验</button>
    </div>
    <div id="h-workers" style="margin-top:8px"></div>
    <div id="h-error"></div>
    <div class="modal-foot"><button class="btn" id="cancel">取消</button>
      <button class="btn primary" id="save">提交登记</button></div></div>`);
  const m = modal(node, { width: 740 });
  const dtLocal = ts => {
    const d = new Date(ts), p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  node.querySelector('#h-time').value = dtLocal(Date.now());

  const workers = [];
  let allPeople = [];
  api('/people').then(list => {
    allPeople = list;
    node.querySelector('#h-plist').innerHTML = list.map(p =>
      `<option value="${p.name} #${p.id}">${p.cooperative_name || ''}</option>`).join('');
  });

  function renderWorkers() {
    node.querySelector('#h-workers').innerHTML = workers.map((w, i) => `
      <div class="qa-box" style="padding:12px" data-i="${i}">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
          <div><b>${esc(w.person_name)}</b> · <span class="tag">${esc(w.tag_name)}</span>
            ${w.certified ? '<span class="pill green">✅ 持证齐全</span>'
              : '<span class="pill red">⚠️ 未持证：' + w.missing_subjects.map(s => esc(s.name)).join('、') + '</span>'}</div>
          <button class="btn small danger" data-del="${i}">移除</button>
        </div>
        ${!w.certified ? `<div class="field" style="margin-top:8px"><label>未持证原因（必填，随批次留痕）</label>
          <textarea class="warn-reason" placeholder="如：复训考核待考，本次仅承担辅助作业，由持证人员现场带教">${esc(w.warning_reason || '')}</textarea></div>` : ''}
      </div>`).join('');
    node.querySelectorAll('[data-del]').forEach(b =>
      b.onclick = () => { workers.splice(Number(b.dataset.del), 1); renderWorkers(); });
    node.querySelectorAll('.warn-reason').forEach((ta, i) => {
      const unc = workers.filter(w => !w.certified)[i];
      if (unc) ta.oninput = e => unc.warning_reason = e.target.value;
    });
  }

  node.querySelector('#h-add').onclick = async () => {
    const raw = node.querySelector('#h-person').value.trim();
    const pid = Number((raw.match(/#(\d+)$/) || [])[1]);
    const tagId = Number(node.querySelector('#h-tag').value);
    if (!pid) return toast('请选择药农', 'error');
    if (workers.some(w => w.person_id === pid)) return toast('该人员已添加', 'error');
    const r = await api('/harvest/check-workers', { method: 'POST',
      body: { plot_id: Number(node.querySelector('#h-plot').value), workers: [{ person_id: pid, tag_id: tagId }] } });
    const w = r.workers[0];
    workers.push({ ...w, tag_id: tagId, warning_reason: '' });
    node.querySelector('#h-person').value = '';
    renderWorkers();
  };

  node.querySelector('#cancel').onclick = m.close;
  node.querySelector('#save').onclick = async () => {
    if (!workers.length) return toast('请至少添加一名作业人员', 'error');
    const noReason = workers.filter(w => !w.certified && !String(w.warning_reason || '').trim());
    if (noReason.length) return toast(`${noReason.length} 名未持证人员尚未填写原因`, 'error');
    try {
      const r = await api('/harvest/batches', { method: 'POST', body: {
        plot_id: Number(node.querySelector('#h-plot').value),
        batch_no: node.querySelector('#h-no').value.trim() || undefined,
        harvested_at: new Date(node.querySelector('#h-time').value).getTime(),
        workers: workers.map(w => ({ person_id: w.person_id, tag_id: w.tag_id,
          warning_reason: w.certified ? undefined : w.warning_reason })),
      } });
      toast(r.warnings ? `登记成功，${r.warnings} 条无证预警已通知管理员` : '登记成功，全员持证', r.warnings ? '' : 'ok');
      m.close(); onDone();
    } catch (e) { toast(e.message, 'error'); }
  };
  renderWorkers();
}

async function viewBatch(id) {
  const d = await api('/harvest/batches/' + id);
  const node = h(`<div>
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h3>批次留痕：${esc(d.batch.batch_no)}</h3>
      <button class="btn small" id="export">导出留痕(JSON)</button>
    </div>
    <div class="card" style="margin:12px 0">
      <dl class="kv">
        <dt>基地</dt><dd>${esc(d.batch.base_name)}</dd>
        <dt>地块</dt><dd>${esc(d.batch.plot_code + d.batch.plot_name)}（${esc(d.batch.cooperative_name || '')}）</dd>
        <dt>品种</dt><dd>${esc(d.batch.variety || '—')}</dd>
        <dt>采收时间</dt><dd>${fmt(d.batch.harvested_at)}</dd>
      </dl>
    </div>
    <div class="table-wrap"><table><thead><tr><th>作业人员</th><th>身份证</th><th>工种</th><th>持证校验</th>
      <th>关联有效证书</th><th>未持证原因</th></tr></thead><tbody>
      ${d.workers.map(w => `<tr>
        <td><b>${esc(w.person_name)}</b></td><td>${esc(w.id_card || '—')}</td><td>${esc(w.tag_name || '—')}</td>
        <td>${w.certified ? '<span class="pill green">持证</span>' : '<span class="pill red">未持证</span>'}</td>
        <td>${w.certificates.map(c => `<div>${esc(c.subject)} <span class="muted">${esc(c.cert_no)}</span></div>`).join('') || '—'}</td>
        <td style="max-width:260px">${esc(w.warning_reason || '—')}</td>
      </tr>`).join('')}</tbody></table></div>
    <div class="modal-foot"><button class="btn primary" id="close">关闭</button></div></div>`);
  const m = modal(node, { width: 800 });
  node.querySelector('#close').onclick = m.close;
  node.querySelector('#export').onclick = () => {
    const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = d.batch.batch_no + '-trace.json';
    a.click();
  };
}
