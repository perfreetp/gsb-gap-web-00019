import { h, esc, fmt, modal, toast } from '../core.js';
import { api } from '../api.js';

export async function gradingPage(view) {
  view.innerHTML = '';
  const [pending, appeals] = await Promise.all([api('/grading/pending'), api('/grading/appeals')]);

  const c1 = h(`<div class="card"><h3>✍️ 待评阅试卷（识图题 / 简答题）</h3>
    <div class="table-wrap"><table><thead><tr><th>药农</th><th>考核</th><th>待评题数</th><th>状态</th><th></th></tr></thead>
    <tbody>${pending.map(r => `<tr>
      <td><b>${esc(r.person_name)}</b></td><td>${esc(r.title)}</td>
      <td><span class="pill amber">${r.pending_count}</span></td>
      <td>${r.graded ? '部分完成' : '客观题已判'}</td>
      <td><button class="btn small primary" data-reg="${r.reg_id}">进入评阅</button></td></tr>`).join('')
      || '<tr><td colspan="5" class="muted">暂无待评阅试卷</td></tr>'}</tbody></table></div></div>`);
  view.appendChild(c1);
  c1.querySelectorAll('[data-reg]').forEach(b => b.onclick = () => gradeDlg(Number(b.dataset.reg)));

  const c2 = h(`<div class="card"><h3>📨 成绩申诉复核（留痕）</h3>
    <div>${appeals.map(a => `<div class="qa-box">
      <div style="display:flex;justify-content:space-between">
        <div><b>${esc(a.person_name)}</b> · ${esc(a.title)} · 原成绩 ${a.total_score ?? '—'}
          <span class="pill ${a.status === 'pending' ? 'amber' : a.status === 'adjusted' ? 'blue' : 'gray'}">
            ${{ pending: '待复核', reviewed: '已复核', rejected: '已驳回', adjusted: '已调分' }[a.status]}</span></div>
        <span class="muted">${fmt(a.created_at)}</span></div>
      <div style="margin:6px 0">申诉理由：${esc(a.reason)}</div>
      ${a.reply ? `<div class="muted">复核回复：${esc(a.reply)}（${esc(a.reviewer_name)}）</div>` : ''}
      ${a.status === 'pending' ? `<div style="margin-top:8px"><button class="btn small primary" data-appeal="${a.id}" data-score="${a.total_score}">复核处理</button></div>` : ''}
    </div>`).join('') || '<p class="muted">暂无申诉</p>'}</div></div>`);
  view.appendChild(c2);
  c2.querySelectorAll('[data-appeal]').forEach(b => b.onclick = () =>
    appealReviewDlg(Number(b.dataset.appeal), b.dataset.score, () => gradingPage(view)));
}

async function gradeDlg(regId) {
  const d = await api('/grading/registration/' + regId);
  const subjective = d.questions.filter(q => q.type === 'short' || q.type === 'image');
  const node = h(`<div><h3>评阅：${esc(d.registration.title)}</h3>
    <div class="muted" style="margin-bottom:10px">药农成绩：客观 ${d.registration.objective_score ?? '—'}；
      主观题打分按题百分制，必要时第二名技术员复评，系统自动按双评平均折算。</div>
    <div id="qs"></div>
    <div class="modal-foot"><button class="btn primary" id="close">完成评阅</button></div></div>`);
  const qsBox = node.querySelector('#qs');
  const m = modal(node, { width: 740 });

  subjective.forEach(q => {
    const myGrade = q.grades.find(g => false); // 当前用户的评分由服务端 upsert
    const avg = q.grades.length ? (q.grades.reduce((s, g) => s + g.score, 0) / q.grades.length).toFixed(1) : null;
    const box = h(`<div class="qa-box">
      <div class="stem">【${{ short: '简答题', image: '识图题' }[q.type] || q.type}】${esc(q.stem)}</div>
      ${q.image_url ? `<img src="${q.image_url}" style="max-width:100%;max-height:240px;border:1px solid var(--line);border-radius:8px;margin-bottom:8px">` : ''}
      <div style="background:var(--green-ll);border-radius:8px;padding:10px;margin-bottom:8px">
        <div class="muted">考生作答：</div><div>${esc(Array.isArray(q.given) ? q.given.join('、') : (q.given || '（未作答）'))}</div></div>
      ${q.reference_answer ? `<div class="muted" style="margin-bottom:8px">参考答案：${esc(q.type === 'short' ? q.reference_answer : '')}</div>` : ''}
      ${q.grades.length ? `<div style="margin-bottom:8px">已有评阅：
        ${q.grades.map(g => `<span class="tag ${g.grader_count > 1 ? 'blue' : ''}">${esc(g.grader_name)}：${g.score}分</span>`).join('')}
        ${q.grades.length >= 2 ? `<span class="pill blue">双评均分 ${avg}</span>` : `<span class="pill amber">当前单评 ${avg}，可双评</span>`}</div>` : ''}
      <div class="form-row">
        <div class="field"><label>本题打分（0-100）</label><input type="number" min="0" max="100" value="${q.grades[0]?.score ?? ''}" class="g-score"></div>
        <div class="field" style="flex:1"><label>评语</label><input class="g-comment" value="${esc(q.grades[0]?.comment || '')}"></div>
        <div class="field" style="justify-content:flex-end"><button class="btn primary" data-answer="${q.answer_id}">提交评分</button></div>
      </div></div>`);
    qsBox.appendChild(box);
  });
  node.querySelector('#close').onclick = () => { m.close(); };
  node.querySelectorAll('[data-answer]').forEach(btn => btn.onclick = async () => {
    const box = btn.closest('.qa-box');
    const score = Number(box.querySelector('.g-score').value);
    if (Number.isNaN(score)) return toast('请输入 0-100 分', 'error');
    try {
      await api(`/grading/answer/${btn.dataset.answer}/grade`, { method: 'POST',
        body: { score, comment: box.querySelector('.g-comment').value } });
      toast('评分已保存（双评后自动取均）', 'ok');
      m.close(); gradeDlg(regId);
    } catch (e) { toast(e.message, 'error'); }
  });
}

function appealReviewDlg(appealId, oldScore, onDone) {
  const node = h(`<div><h3>复核成绩申诉</h3>
    <div class="form-row">
      <div class="field"><label>复核结论</label><select id="a-status">
        <option value="reviewed">维持原成绩</option>
        <option value="adjusted">调整分数</option>
        <option value="rejected">驳回申诉</option></select></div>
      <div class="field" id="score-box" style="display:none"><label>调整后总分</label>
        <input id="a-score" type="number" min="0" max="100" value="${oldScore ?? ''}"></div>
    </div>
    <div class="field"><label>复核回复（对药农可见并留痕）</label><textarea id="a-reply"></textarea></div>
    <div class="modal-foot"><button class="btn" id="cancel">取消</button><button class="btn primary" id="save">提交复核</button></div></div>`);
  const m = modal(node, { width: 580 });
  node.querySelector('#a-status').onchange = e =>
    node.querySelector('#score-box').style.display = e.target.value === 'adjusted' ? '' : 'none';
  node.querySelector('#cancel').onclick = m.close;
  node.querySelector('#save').onclick = async () => {
    const status = node.querySelector('#a-status').value;
    try {
      await api(`/grading/appeal/${appealId}/review`, { method: 'POST', body: {
        status, reply: node.querySelector('#a-reply').value.trim(),
        adjust_score: status === 'adjusted' ? Number(node.querySelector('#a-score').value) : undefined,
      } });
      toast('复核完成，已通知药农并写入审计', 'ok'); m.close(); onDone();
    } catch (e) { toast(e.message, 'error'); }
  };
}
