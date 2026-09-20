import { h, esc, fmt, fmtMD, modal, toast, confirmDlg } from '../core.js';
import { api } from '../api.js';
import { getState } from '../app.js';
import { pseudoQR } from '../offline.js';

export async function certificatesPage(view) {
  view.innerHTML = '';
  const { user } = getState();
  const manage = ['tech', 'base_admin', 'enterprise'].includes(user.role);
  const certs = await api('/certificates');

  const card = h(`<div class="card">
    <div class="toolbar">
      <label class="tag amber" style="cursor:pointer"><input type="checkbox" id="f-exp" style="vertical-align:middle"> 仅看 30 天内到期</label>
      ${manage && user.role !== 'enterprise' ? '<button class="btn" id="sweep">扫描到期并推送复训提醒</button>' : ''}
      <span style="flex:1"></span>
      <span class="muted">共 ${certs.length} 张证书</span>
    </div>
    <div id="grid" class="grid c3"></div></div>`);
  view.appendChild(card);

  function render() {
    const rows = card.querySelector('#f-exp').checked
      ? certs.filter(c => c.days_left != null && c.days_left <= 30 && !c.revoked) : certs;
    card.querySelector('#grid').innerHTML = rows.map(c => `
      <div class="cert" style="${c.revoked ? 'opacity:.55' : ''}">
        <div class="no">${esc(c.cert_no)}</div>
        <h2>培训合格证</h2>
        <div style="text-align:center;margin:8px 0 14px">中药材生产质量管理规范（GAP）</div>
        <dl class="kv">
          <dt>持证人</dt><dd><b>${esc(c.person_name)}</b></dd>
          <dt>合格科目</dt><dd>${esc(c.subject_name)}</dd>
          <dt>考核成绩</dt><dd>${c.score} 分</dd>
          <dt>签发日期</dt><dd>${fmtMD(c.issued_at)}</dd>
          <dt>有效期至</dt><dd>${c.valid_until ? fmtMD(c.valid_until) + (c.pesticide_safety ? '（农药安全类，到期需复训）' : '') : '长期有效'}</dd>
        </dl>
        <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-top:14px">
          <img src="${pseudoQR(c.cert_no)}" style="width:96px;height:96px;border-radius:6px">
          <div style="text-align:right">
            ${c.revoked ? '<span class="pill red">已撤销</span>'
              : c.expired ? '<span class="pill red">已过期</span>'
              : c.days_left != null && c.days_left <= 30 ? `<span class="pill amber">${c.days_left} 天后到期</span>`
              : '<span class="pill green">有效</span>'}
            <div style="margin-top:8px"><button class="btn small" data-view="${c.id}">查看/导出</button></div>
          </div>
        </div>
      </div>`).join('') || '<p class="muted">暂无符合条件的证书</p>';
    card.querySelector('#grid').querySelectorAll('[data-view]').forEach(b =>
      b.onclick = () => viewCert(rows.find(x => x.id == b.dataset.view)));
  }
  render();
  card.querySelector('#f-exp').onchange = render;
  card.querySelector('#sweep')?.addEventListener('click', async () => {
    const r = await api('/certificates/sweep-expiry', { method: 'POST' });
    toast(`扫描 ${r.scanned} 张，推送复训提醒 ${r.sent} 条`, 'ok');
  });

  function viewCert(c) {
    const verifyUrl = location.origin + '/#verify=' + encodeURIComponent(c.cert_no);
    const node = h(`<div>
      <div class="cert">
        <div class="no">${esc(c.cert_no)}</div>
        <h2>培训合格证</h2>
        <div style="text-align:center;margin:6px 0 12px">中药材生产质量管理规范（GAP）</div>
        <dl class="kv">
          <dt>基地</dt><dd>${esc(c.base_name)}</dd>
          <dt>持证人</dt><dd>${esc(c.person_name)}（${esc(c.id_card || '')}）</dd>
          <dt>合格科目</dt><dd>${esc(c.subject_name)}</dd>
          <dt>考核</dt><dd>${esc(c.exam_title)} · ${c.score} 分</dd>
          <dt>签发日期</dt><dd>${fmtMD(c.issued_at)}</dd>
          <dt>有效期至</dt><dd>${c.valid_until ? fmtMD(c.valid_until) : '长期有效'}</dd>
        </dl>
        <div style="text-align:center;margin-top:14px">
          <img src="${pseudoQR(c.cert_no)}" style="width:130px;height:130px;border-radius:8px">
          <div class="muted" style="margin-top:6px">扫码/访问可向客户或检查方验证真伪</div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn" id="copy">复制验证链接</button>
        <button class="btn" id="print">打印/导出 PDF</button>
        ${manage && !c.revoked && user.role !== 'farmer' ? '<button class="btn danger" id="revoke">撤销证书</button>' : ''}
        <button class="btn primary" id="close">关闭</button></div></div>`);
    const m = modal(node, { width: 620 });
    node.querySelector('#close').onclick = m.close;
    node.querySelector('#copy').onclick = () => {
      navigator.clipboard?.writeText(verifyUrl); toast('验证链接已复制', 'ok');
    };
    node.querySelector('#print').onclick = () => window.print();
    node.querySelector('#revoke')?.addEventListener('click', async () => {
      const reason = prompt('撤销原因（将写入审计日志）');
      if (!reason) return;
      await api(`/certificates/${c.id}/revoke`, { method: 'POST', body: { reason } });
      toast('证书已撤销', 'ok'); m.close(); certificatesPage(view);
    });
  }
}
