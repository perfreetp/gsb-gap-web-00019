import { h, esc, fmt, modal, toast, elapse } from '../core.js';
import { api } from '../api.js';
import { getState } from '../app.js';
import { runExam } from './exam-runner.js';

const STATUS_LABEL = {
  registered: ['已报名', 'blue'], in_progress: ['答题中', 'amber'],
  submitted: ['待评阅', 'amber'], graded: ['已出分', 'green'], absent: ['缺考', 'gray'], blocked: ['受限', 'red'],
};

export async function examsPage(view) {
  const { user, meta } = getState();
  const manage = ['tech', 'base_admin', 'enterprise'].includes(user.role);
  view.innerHTML = '';
  const [exams, myRecords] = await Promise.all([
    api('/exams'),
    user.role === 'farmer' ? api('/exams/my/records') : Promise.resolve([]),
  ]);
  const myMap = new Map();
  myRecords.forEach(r => myMap.set(r.exam_id, r));

  const card = h(`<div class="card">
    <div class="toolbar">
      ${manage ? '<button class="btn primary" id="new">＋ 新建考核（自动抽题 A/B 卷）</button>' : ''}
    </div>
    <div id="list"></div></div>`);
  view.appendChild(card);

  card.querySelector('#list').innerHTML = exams.map(e => {
    const my = myMap.get(e.id);
    return `<div class="qa-box">
      <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px">
        <div>
          <div class="stem">📝 ${esc(e.title)}
            ${e.start_at > Date.now() ? '<span class="pill blue">未开考</span>' : '<span class="pill gray">已开考</span>'}</div>
          <div class="muted">🕑 ${fmt(e.start_at)} · ${e.duration_min} 分钟 · 及格线 ${e.pass_score} 分 · 最多补考 ${e.max_retakes} 次 · 每卷 ${e.paper_question_count} 题</div>
          <span class="tag blue">${esc(e.subject_name)}</span>
          ${e.variety ? `<span class="tag">品种：${esc(e.variety)}</span>` : ''}
          ${e.chapter ? `<span class="tag">${esc(e.chapter)}</span>` : ''}
          ${e.require_course_completion ? '<span class="tag amber">需完成课件</span>' : ''}
        </div>
        <div style="text-align:right">
          ${my ? `<div><span class="pill ${STATUS_LABEL[my.status][1]}">${STATUS_LABEL[my.status][0]}</span></div>
            ${my.total_score != null ? `<div style="margin-top:6px;font-size:20px;font-weight:700;color:${my.total_score >= e.pass_score ? 'var(--green-d)' : 'var(--red)'}">${my.total_score} 分</div>` : ''}
            <div style="margin-top:6px;display:flex;gap:6px;justify-content:flex-end">
              <button class="btn small" data-result="${my.id}">查看/申诉</button>
              ${['registered', 'in_progress'].includes(my.status) ? `<button class="btn small primary" data-start="${e.id}">进入答题</button>` : ''}
            </div>`
            : user.role === 'farmer'
              ? (e.start_at > Date.now()
                  ? `<button class="btn small primary" data-register="${e.id}">扫码/在线报名</button>`
                  : '<span class="muted">场次已结束</span>')
              : manage ? `<button class="btn small" data-manage="${e.id}">报考与成绩</button>
                          <button class="btn small" data-paper="${e.id}">纸质卷回录</button>` : ''}
        </div>
      </div></div>`;
  }).join('');

  card.querySelector('#list').querySelectorAll('[data-register]').forEach(b =>
    b.onclick = async () => {
      try { await api(`/exams/${b.dataset.register}/register`, { method: 'POST' });
        toast('报名成功，可进入答题', 'ok'); examsPage(view); }
      catch (e) {
        if (e.data?.missing_courses) toast('未学完：' + e.data.missing_courses.join('、'), 'error');
        else toast(e.message, 'error');
      }
    });
  card.querySelector('#list').querySelectorAll('[data-start]').forEach(b =>
    b.onclick = async () => {
      try { await runExam(Number(b.dataset.start), () => examsPage(view)); }
      catch (e) {
        if (e.data?.result) showResult(e.data.result, () => examsPage(view));
        else toast(e.message, 'error');
      }
    });
  card.querySelector('#list').querySelectorAll('[data-result]').forEach(b =>
    b.onclick = () => showResultLite(Number(b.dataset.result), myRecords));
  card.querySelector('#list').querySelectorAll('[data-manage]').forEach(b =>
    b.onclick = () => manageDlg(Number(b.dataset.manage), meta));
  card.querySelector('#list').querySelectorAll('[data-paper]').forEach(b =>
    b.onclick = () => paperScoreDlg(Number(b.dataset.paper), meta, () => examsPage(view)));

  if (manage) card.querySelector('#new').onclick = () => createDlg(meta, () => examsPage(view));
}

async function showResultLite(regId, myRecords) {
  const reg = myRecords.find(r => r.id === regId);
  showResult({
    reg_id: regId, status: reg.status, total_score: reg.total_score,
    objective_score: reg.objective_score, subjective_score: reg.subjective_score,
    pass_score: reg.exam_pass, graded: !!reg.graded,
  }, () => {}, reg);
}

export async function showResult(result, onClose, regRow) {
  const node = h(`<div style="text-align:center">
    <h3>考核结果</h3>
    <div style="font-size:52px;font-weight:800;margin:10px 0;color:${result.passed ? 'var(--green-d)' : 'var(--red)'}">${result.total_score ?? '—'}</div>
    <div class="muted">及格线 ${result.pass_score} 分
      ${result.objective_score != null ? ` · 客观题 ${result.objective_score}` : ''}
      ${result.subjective_score != null ? ` · 主观题 ${result.subjective_score}` : ''}</div>
    <div style="margin:14px 0">
      ${result.status === 'submitted' ? '<span class="pill amber">客观题已判分，识图/简答待技术员评阅（必要时双评取平均）</span>'
        : result.passed ? '<span class="pill green">🎉 合格！电子培训合格证已生成</span>'
        : '<span class="pill red">未达及格线，可在补考配额内参加补考</span>'}
    </div>
    <div class="modal-foot" style="justify-content:center">
      ${result.graded ? '<button class="btn" id="appeal">对成绩有异议？在线申诉</button>' : ''}
      <button class="btn primary" id="close">关闭</button></div></div>`);
  const m = modal(node, { width: 480 });
  node.querySelector('#close').onclick = () => { m.close(); onClose?.(); };
  node.querySelector('#appeal')?.addEventListener('click', () => {
    m.close(); appealDlg(result.reg_id, onClose);
  });
}

function appealDlg(regId, onClose) {
  const node = h(`<div><h3>成绩申诉</h3>
    <textarea id="reason" style="width:100%;min-height:120px" placeholder="请说明异议点，技术员将复核并全程留痕"></textarea>
    <div class="modal-foot"><button class="btn" id="cancel">取消</button>
    <button class="btn primary" id="send">提交申诉</button></div></div>`);
  const m = modal(node, { width: 560 });
  node.querySelector('#cancel').onclick = m.close;
  node.querySelector('#send').onclick = async () => {
    if (!node.querySelector('#reason').value.trim()) return toast('请填写申诉理由', 'error');
    await api(`/exams/registration/${regId}/appeal`, { method: 'POST',
      body: { reason: node.querySelector('#reason').value.trim() } });
    toast('申诉已提交，请留意复核结果通知', 'ok'); m.close(); onClose?.();
  };
}

async function manageDlg(examId, meta) {
  const d = await api('/exams/' + examId);
  const node = h(`<div><h3>${esc(d.exam.title)} · 报考与成绩</h3>
    <div class="muted" style="margin-bottom:10px">A 卷 ${d.papers.find(p => p.version === 'A')?.question_ids.length} 题，
      B 卷 ${d.papers.find(p => p.version === 'B')?.question_ids.length} 题</div>
    <div class="table-wrap"><table><thead><tr><th>药农</th><th>次数</th><th>卷</th><th>状态</th><th>客观</th><th>主观</th><th>总分</th></tr></thead>
    <tbody>${d.registrations.map(r => `<tr>
      <td>${esc(r.person_name)}</td><td>${r.attempt === 0 ? '首考' : '补考' + r.attempt}</td>
      <td>${r.paper_version}</td>
      <td><span class="pill ${STATUS_LABEL[r.status][1]}">${STATUS_LABEL[r.status][0]}${r.auto_submitted ? '(超时)' : ''}</span></td>
      <td>${r.objective_score ?? '—'}</td><td>${r.subjective_score ?? '—'}</td>
      <td><b>${r.total_score ?? '—'}</b></td></tr>`).join('') || '<tr><td colspan="7" class="muted">暂无报名</td></tr>'}</tbody></table></div>
    <div class="modal-foot"><button class="btn primary" id="close">关闭</button></div></div>`);
  const m = modal(node, { width: 700 });
  node.querySelector('#close').onclick = m.close;
}

function paperScoreDlg(examId, meta, onDone) {
  const node = h(`<div><h3>纸质卷成绩回录</h3>
    <div class="form-row">
      <div class="field" style="flex:1"><label>药农（搜索）</label><input id="ps-q" list="ps-list" placeholder="输入姓名选择">
        <datalist id="ps-list"></datalist></div>
      <div class="field"><label>分数</label><input id="ps-score" type="number" min="0" max="100"></div>
    </div>
    <div id="ps-msg" class="muted"></div>
    <div class="modal-foot"><button class="btn" id="cancel">取消</button>
    <button class="btn primary" id="save">回录并签发结果</button></div></div>`);
  const m = modal(node, { width: 560 });
  api('/people').then(people => {
    const dl = node.querySelector('#ps-list');
    dl.innerHTML = people.map(p => `<option value="${p.name} #${p.id}">`).join('');
  });
  node.querySelector('#cancel').onclick = m.close;
  node.querySelector('#save').onclick = async () => {
    const raw = node.querySelector('#ps-q').value.trim();
    const id = Number((raw.match(/#(\d+)$/) || [])[1]);
    const score = Number(node.querySelector('#ps-score').value);
    if (!id || Number.isNaN(score)) return toast('请选择药农并填写分数', 'error');
    try {
      const r = await api(`/exams/${examId}/paper-score`, { method: 'POST', body: { person_id: id, score } });
      toast(r.result.passed ? '回录成功，证书已签发' : '回录成功，成绩不合格', r.result.passed ? 'ok' : '');
      m.close(); onDone();
    } catch (e) { toast(e.message, 'error'); }
  };
}

function createDlg(meta, onDone) {
  const dtLocal = ts => {
    const d = new Date(ts), p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const t = new Date(Date.now() + 2 * 86400000); t.setHours(9, 30, 0, 0);
  const node = h(`<div><h3>新建考核场次</h3>
    <div class="form-row">
      <div class="field" style="flex:2"><label>标题 *</label><input id="e-title"></div>
      <div class="field" style="flex:1"><label>科目 *</label><select id="e-subject">
        ${meta.subjects.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div>
    </div>
    <div class="form-row">
      <div class="field"><label>药材品种（抽题过滤）</label><input id="e-variety" placeholder="如 三七，可空"></div>
      <div class="field"><label>GAP 章节</label><input id="e-chapter" placeholder="如 第六章 投入品"></div>
      <div class="field"><label>开考时间 *</label><input id="e-time" type="datetime-local" value="${dtLocal(t.getTime())}"></div>
    </div>
    <div class="form-row">
      <div class="field"><label>时长(分钟)</label><input id="e-dur" type="number" value="40"></div>
      <div class="field"><label>及格线</label><input id="e-pass" type="number" value="60"></div>
      <div class="field"><label>补考次数</label><input id="e-retake" type="number" value="1"></div>
      <div class="field"><label>每卷题量</label><input id="e-n" type="number" value="5"></div>
      <div class="field"><label>报考前须完成课件</label><select id="e-gate"><option value="1">是</option><option value="0">否</option></select></div>
    </div>
    <div class="muted">系统按品种、章节、难度分层抽题，同场次自动生成 A/B 卷；场次开始后超时自动交卷。</div>
    <div class="modal-foot"><button class="btn" id="cancel">取消</button><button class="btn primary" id="save">生成 A/B 卷</button></div></div>`);
  const m = modal(node, { width: 720 });
  node.querySelector('#cancel').onclick = m.close;
  node.querySelector('#save').onclick = async () => {
    try {
      const r = await api('/exams', { method: 'POST', body: {
        base_id: getState().user.base_id,
        title: node.querySelector('#e-title').value.trim() || 'GAP 考核',
        subject_id: Number(node.querySelector('#e-subject').value),
        variety: node.querySelector('#e-variety').value.trim() || null,
        chapter: node.querySelector('#e-chapter').value.trim() || null,
        start_at: new Date(node.querySelector('#e-time').value).getTime(),
        duration_min: Number(node.querySelector('#e-dur').value),
        pass_score: Number(node.querySelector('#e-pass').value),
        max_retakes: Number(node.querySelector('#e-retake').value),
        paper_question_count: Number(node.querySelector('#e-n').value),
        require_course_completion: node.querySelector('#e-gate').value === '1',
      } });
      toast(`已组卷：A 卷 ${r.paper_a} 题 / B 卷 ${r.paper_b} 题`, 'ok');
      m.close(); onDone();
    } catch (e) { toast(e.message, 'error'); }
  };
}
