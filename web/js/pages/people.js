import { h, esc, modal, confirmDlg, toast } from '../core.js';
import { api } from '../api.js';
import { getState } from '../app.js';

export async function peoplePage(view) {
  view.innerHTML = '';
  const state = getState();
  const meta = state.meta;
  const canEdit = ['base_admin', 'enterprise'].includes(state.user.role);
  const tagName = id => meta.skill_tags.find(t => t.id === id)?.name || id;

  const card = h(`<div class="card">
    <div class="toolbar">
      <input id="q" placeholder="搜索姓名 / 身份证 / 手机" style="width:230px">
      <select id="f-coop"><option value="">全部合作社</option>
        ${meta.cooperatives.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>
      <select id="f-emp"><option value="">全部用工类型</option>
        <option value="long_term">长期用工</option><option value="seasonal">季节性用工</option></select>
      <select id="f-tag"><option value="">全部工种</option>
        ${meta.skill_tags.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select>
      <button class="btn" id="search">查询</button>
      <span style="flex:1"></span>
      ${canEdit ? `<button class="btn" id="import">批量导入 CSV</button>
      <button class="btn primary" id="add">＋ 新建人员</button>` : ''}
    </div>
    <div id="dup-bar"></div>
    <div id="list" class="table-wrap"></div></div>`);
  view.appendChild(card);

  async function load() {
    const p = new URLSearchParams();
    const q = card.querySelector('#q').value.trim();
    const coop = card.querySelector('#f-coop').value;
    const emp = card.querySelector('#f-emp').value;
    if (q) p.set('q', q); if (coop) p.set('cooperative_id', coop); if (emp) p.set('employment_type', emp);
    let rows = await api('/people?' + p.toString());
    const tag = card.querySelector('#f-tag').value;
    if (tag) rows = rows.filter(r => r.tag_ids.includes(Number(tag)));
    card.querySelector('#list').innerHTML = `<table><thead><tr>
      <th>姓名</th><th>身份证</th><th>手机</th><th>合作社</th><th>地块</th><th>用工</th><th>工种技能标签</th><th></th>
      </tr></thead><tbody>${rows.map(r => `<tr>
      <td><b>${esc(r.name)}</b></td><td>${esc(r.id_card || '—')}</td><td>${esc(r.phone || '—')}</td>
      <td>${esc(r.cooperative_name || '—')}</td><td>${esc((r.plot_code || '') + (r.plot_name || ''))}</td>
      <td><span class="pill ${r.employment_type === 'long_term' ? 'green' : 'amber'}">${r.employment_type === 'long_term' ? '长期' : '季节性'}</span></td>
      <td>${r.tag_names.map(t => `<span class="tag">${esc(t)}</span>`).join('') || '<span class="muted">未挂标签</span>'}</td>
      <td>${canEdit ? `<button class="btn small" data-edit="${r.id}">编辑</button>` : `<button class="btn small" data-view="${r.id}">查看</button>`}</td>
      </tr>`).join('')}</tbody></table>`;
    card.querySelector('#list').querySelectorAll('[data-edit]').forEach(b =>
      b.onclick = () => editPerson(rows.find(x => x.id == b.dataset.edit), load));
    card.querySelector('#list').querySelectorAll('[data-view]').forEach(b =>
      b.onclick = () => viewPerson(rows.find(x => x.id == b.dataset.view)));
  }
  card.querySelector('#search').onclick = load;
  card.querySelector('#q').onkeydown = e => e.key === 'Enter' && load();
  if (canEdit) {
    card.querySelector('#add').onclick = () => editPerson(null, load);
    card.querySelector('#import').onclick = () => importDlg(load);
  }

  // 重复人员提示条
  if (canEdit) {
    const dups = await api('/people/duplicates/list');
    if (dups.length) {
      card.querySelector('#dup-bar').innerHTML = `<div style="background:var(--amber-l);border:1px solid #ecd6a8;border-radius:8px;padding:10px 14px;margin-bottom:12px">
        🔍 检测到 <b>${dups.length}</b> 组疑似重复人员（身份证或姓名+手机一致）
        <button class="btn small" id="show-dup" style="margin-left:8px">去合并</button></div>`;
      card.querySelector('#show-dup').onclick = () => mergeList(dups, load);
    }
  }
  load();

  function formHtml(p) {
    return `<div class="field" style="flex:1;min-width:200px"><label>姓名 *</label><input id="f-name" value="${esc(p?.name || '')}"></div>
      <div class="field" style="flex:1;min-width:200px"><label>身份证（去重键）</label><input id="f-idcard" value="${esc(p?.id_card || '')}"></div>
      <div class="field" style="flex:1;min-width:200px"><label>联系方式</label><input id="f-phone" value="${esc(p?.phone || '')}"></div>
      <div class="field" style="flex:1"><label>所属合作社</label><select id="f-coop2">
        <option value="">—</option>${meta.cooperatives.map(c => `<option value="${c.id}" ${p?.cooperative_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
      <div class="field" style="flex:1"><label>所属地块</label><select id="f-plot">
        <option value="">—</option>${meta.plots.map(c => `<option value="${c.id}" ${p?.plot_id === c.id ? 'selected' : ''}>${esc(c.code + c.name)}</option>`).join('')}</select></div>
      <div class="field" style="flex:1"><label>用工类型</label><select id="f-emp2">
        <option value="long_term" ${p?.employment_type === 'long_term' ? 'selected' : ''}>长期用工</option>
        <option value="seasonal" ${(!p || p.employment_type !== 'long_term') ? 'selected' : ''}>季节性用工</option></select></div>
      <div class="field" style="flex-basis:100%"><label>工种技能标签（决定必需培训科目）</label>
        <div id="tag-box" style="display:flex;flex-wrap:wrap;gap:6px">
        ${meta.skill_tags.map(t => `<label class="opt" style="margin:0;flex:1;min-width:150px"><input type="checkbox" value="${t.id}"
          ${p?.tag_ids?.includes(t.id) ? 'checked' : ''}>${esc(t.name)}</label>`).join('')}
        </div>
        <div class="muted" id="required-subj" style="margin-top:6px"></div></div>`;
  }

  async function editPerson(p, onDone) {
    const node = h(`<div><h3>${p ? '编辑人员' : '新建人员台账'}</h3>
      <div class="form-row">${formHtml(p)}</div>
      <div class="modal-foot"><button class="btn" id="cancel">取消</button>
      <button class="btn primary" id="save">保存</button></div></div>`);
    const m = modal(node, { width: 720 });
    const updateRequired = () => {
      const ids = [...node.querySelectorAll('#tag-box input:checked')].map(x => Number(x.value));
      const subjects = new Set();
      meta.skill_tags.filter(t => ids.includes(t.id))
        .forEach(t => t.required_subject_ids.forEach(sid => subjects.add(meta.subjects.find(s => s.id === sid)?.name)));
      node.querySelector('#required-subj').innerHTML = subjects.size
        ? '该人员必需培训科目：' + [...subjects].map(s => `<span class="tag">${esc(s)}</span>`).join('')
        : '未选标签时无强制科目';
    };
    node.querySelectorAll('#tag-box input').forEach(x => x.onchange = updateRequired);
    updateRequired();
    node.querySelector('#cancel').onclick = m.close;
    node.querySelector('#save').onclick = async () => {
      const body = {
        name: node.querySelector('#f-name').value.trim(),
        id_card: node.querySelector('#f-idcard').value.trim() || null,
        phone: node.querySelector('#f-phone').value.trim() || null,
        cooperative_id: Number(node.querySelector('#f-coop2').value) || null,
        plot_id: Number(node.querySelector('#f-plot').value) || null,
        employment_type: node.querySelector('#f-emp2').value,
        tag_ids: [...node.querySelectorAll('#tag-box input:checked')].map(x => Number(x.value)),
      };
      if (!body.name) return toast('请填写姓名', 'error');
      try {
        if (p) { await api('/people/' + p.id, { method: 'PUT', body }); toast('已保存', 'ok'); }
        else {
          try { await api('/people', { method: 'POST', body: { ...body, base_id: state.user.base_id } }); toast('已新建', 'ok'); }
          catch (e) {
            if (e.status === 409) {
              toast(`已存在重复人员「${e.data.duplicate.name}」，请在列表中使用“去合并”`, 'error');
            }
            throw e;
          }
        }
        m.close(); onDone();
      } catch (e) { toast(e.message, 'error'); }
    };
  }

  async function viewPerson(p) {
    const detail = await api('/people/' + p.id);
    const node = h(`<div><h3>人员档案：${esc(detail.name)}</h3>
      <dl class="kv">
        <dt>身份证</dt><dd>${esc(detail.id_card || '—')}</dd>
        <dt>联系方式</dt><dd>${esc(detail.phone || '—')}</dd>
        <dt>合作社</dt><dd>${esc(detail.cooperative_name || '—')}</dd>
        <dt>地块</dt><dd>${esc((detail.plot_code || '') + (detail.plot_name || '')) || '—'}</dd>
        <dt>用工类型</dt><dd>${detail.employment_type === 'long_term' ? '长期用工' : '季节性用工'}</dd>
        <dt>工种标签</dt><dd>${detail.tag_names.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</dd>
      </dl><div class="modal-foot"><button class="btn primary" id="ok">关闭</button></div></div>`);
    const m = modal(node);
    node.querySelector('#ok').onclick = m.close;
  }

  async function mergeList(dups, onDone) {
    const people = await api('/people');
    const byId = Object.fromEntries(people.map(p => [p.id, p]));
    const node = h(`<div><h3>疑似重复人员合并</h3>
      <div class="muted" style="margin-bottom:10px">合并后关联的培训、考核、证书等记录统一迁入保留档案。</div>
      ${dups.map((d, i) => `<div class="qa-box">
        <div class="stem">${esc(d.name)}（身份证 ${esc(d.id_card || '—')} / 手机 ${esc(d.phone || '—')}）</div>
        <div style="display:flex;gap:10px;align-items:center">
          <label>保留档案 <select id="keep-${i}"><option value="${d.a_id}">#${d.a_id}</option><option value="${d.b_id}">#${d.b_id}</option></select></label>
          <button class="btn danger small" data-merge="${i}">执行合并</button>
        </div></div>`).join('')}
      <div class="modal-foot"><button class="btn" id="close">关闭</button></div></div>`);
    const m = modal(node, { width: 660 });
    node.querySelectorAll('[data-merge]').forEach(btn => btn.onclick = async () => {
      const i = btn.dataset.merge, d = dups[i];
      const target = Number(node.querySelector('#keep-' + i).value);
      const source = target === d.a_id ? d.b_id : d.a_id;
      try {
        const r = await api('/people/merge', { method: 'POST', body: { source_id: source, target_id: target } });
        toast(`已合并，迁移记录 ${Object.values(r.merged.migrated).reduce((a, b) => a + b, 0)} 条`, 'ok');
        m.close(); onDone();
      } catch (e) { toast(e.message, 'error'); }
    });
    node.querySelector('#close').onclick = m.close;
  }

  async function importDlg(onDone) {
    const node = h(`<div><h3>批量导入人员（CSV）</h3>
      <p class="section-sub">表头固定：<code>姓名,身份证,手机号,合作社,地块,用工类型,工种标签</code><br>
      合作社填名称、地块填编号（如 P-01），工种标签可填多个，以分号分隔；身份证或姓名+手机重复时自动合并并累加标签。</p>
      <textarea id="csv" style="width:100%;min-height:200px" placeholder="姓名,身份证,手机号,合作社,地块,用工类型,工种标签&#10;何三七,530102200001011234,13611112222,青山药农专业合作社,P-01,长期用工,育苗工;移栽工"></textarea>
      <div id="import-result"></div>
      <div class="modal-foot"><button class="btn" id="cancel">取消</button>
      <button class="btn primary" id="do">导入</button></div></div>`);
    const m = modal(node, { width: 680 });
    node.querySelector('#cancel').onclick = m.close;
    node.querySelector('#do').onclick = async () => {
      try {
        const r = await api('/people/import', { method: 'POST',
          body: { csv: node.querySelector('#csv').value, base_id: state.user.base_id } });
        node.querySelector('#import-result').innerHTML =
          `<div class="cert" style="margin-top:10px">✅ 新建 <b>${r.created}</b> 人，自动合并 <b>${r.merged}</b> 人，跳过 ${r.skipped} 行</div>`;
        toast('导入完成', 'ok'); onDone();
        setTimeout(m.close, 1500);
      } catch (e) { toast(e.message, 'error'); }
    };
  }
}
