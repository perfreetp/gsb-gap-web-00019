import { h, esc, elapse, toast } from '../core.js';
import { api, queuePush } from '../api.js';
import { showResult } from './exams.js';

const TYPE_LABEL = { single: '单选题', multi: '多选题', judge: '判断题', image: '识图题', short: '简答题' };

export async function runExam(examId, onFinish) {
  // 开始/续考（服务端在超时时直接返回 409+result）
  let data;
  try {
    data = await api(`/exams/${examId}/start`, { method: 'POST' });
  } catch (e) {
    if (e.data?.result) { showResult(e.data.result, onFinish); return; }
    throw e;
  }

  const root = document.getElementById('view');
  const answers = { ...data.saved_answers };
  let submitted = false;

  root.innerHTML = '';
  const box = h(`<div>
    <div class="card" style="position:sticky;top:70px;z-index:10">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
        <div><b>${esc(data.exam.title)}</b>
          <span class="tag blue" style="margin-left:8px">${data.paper_version} 卷 · 第 ${data.attempt === 0 ? '首考' : data.attempt + '次考'}</span></div>
        <div style="display:flex;align-items:center;gap:14px">
          <span class="muted" id="save-state">已自动保存</span>
          <span class="exam-timer" id="timer">--:--</span>
          <button class="btn primary" id="submit">交卷</button>
        </div>
      </div>
    </div>
    <div id="qs"></div>
  </div>`);
  root.appendChild(box);

  const qsBox = box.querySelector('#qs');
  data.questions.forEach((q, idx) => {
    const current = answers[q.id];
    const qa = h(`<div class="qa-box" data-q="${q.id}">
      <div class="stem">${idx + 1}. 【${TYPE_LABEL[q.type]}】${esc(q.stem)}</div>
      ${q.image_url ? `<img src="${q.image_url}" style="max-width:100%;max-height:260px;border:1px solid var(--line);border-radius:8px;margin-bottom:10px" onerror="this.style.display='none'">` : ''}
      <div class="opts"></div>
    </div>`);
    const opts = qa.querySelector('.opts');
    if (q.type === 'short') {
      opts.innerHTML = `<textarea style="width:100%;min-height:110px" placeholder="请输入简答内容">${esc(Array.isArray(current) ? '' : current || '')}</textarea>`;
    } else {
      const multi = q.type === 'multi';
      opts.innerHTML = q.options.map((opt, i) => `
        <label class="opt"><input type="${multi ? 'checkbox' : 'radio'}" name="q${q.id}" value="${i}"
          ${(Array.isArray(current) && current.includes(i)) ? 'checked' : ''}>${String.fromCharCode(65 + i)}. ${esc(opt)}</label>`).join('');
    }
    qsBox.appendChild(qa);
  });

  // 倒计时
  let deadline = data.deadline;
  const timerEl = box.querySelector('#timer');
  const tick = () => {
    const left = deadline - Date.now();
    timerEl.textContent = elapse(Math.max(0, left));
    timerEl.style.color = left < 60000 ? 'var(--red)' : 'var(--ink)';
    if (left <= 0 && !submitted) doSubmit(true);
  };
  tick();
  const timer = setInterval(tick, 1000);

  function collect() {
    const out = {};
    data.questions.forEach(q => {
      const qa = qsBox.querySelector(`[data-q="${q.id}"]`);
      if (q.type === 'short') {
        const v = qa.querySelector('textarea').value.trim();
        if (v) out[q.id] = v;
      } else {
        const picked = [...qa.querySelectorAll('input:checked')].map(i => Number(i.value));
        if (picked.length) out[q.id] = picked;
      }
    });
    return out;
  }

  // 自动暂存（每 15 秒或切题时）
  let saveTimer;
  async function saveAll(silent) {
    Object.assign(answers, collect());
    const payload = Object.entries(answers).map(([qid, ans]) => [Number(qid), ans]);
    if (!payload.length) return;
    box.querySelector('#save-state').textContent = '保存中…';
    try {
      await api('/exams/answer', { method: 'POST', body: { reg_id: data.reg_id, answers: payload } });
      box.querySelector('#save-state').textContent = '已自动保存 ' + new Date().toLocaleTimeString('zh-CN');
    } catch (e) {
      queuePush({ path: '/exams/answer', method: 'POST', body: { reg_id: data.reg_id, answers: payload } });
      box.querySelector('#save-state').textContent = '📴 离线暂存，联网补传';
    }
  }
  saveTimer = setInterval(() => saveAll(true), 15000);
  document.addEventListener('change', saveAll);
  document.addEventListener('input', () => { clearTimeout(window.__gapTyping); window.__gapTyping = setTimeout(saveAll, 1200); });

  async function doSubmit(auto) {
    if (submitted) return;
    submitted = true;
    clearInterval(timer); clearInterval(saveTimer);
    await saveAll(true);
    try {
      const r = await api(`/exams/${examId}/submit`, { method: 'POST' });
      if (r.duplicated) toast('已交卷，勿重复提交');
      onFinish();
      showResult(r.result, onFinish);
    } catch (e) {
      submitted = false;
      toast(e.message, 'error');
    }
  }

  box.querySelector('#submit').onclick = () => {
    const unanswered = data.questions.filter(q => answers[q.id] === undefined).length;
    const msg = unanswered ? `还有 ${unanswered} 题未作答，确认交卷？` : '确认交卷？交卷后不可修改。';
    if (confirm(msg)) doSubmit(false);
  };
  window.__gapDoSubmit = () => doSubmit(false);

  // 页面关闭前尽力保存
  window.addEventListener('beforeunload', saveAll);
}
