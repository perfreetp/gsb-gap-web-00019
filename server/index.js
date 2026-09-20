const path = require('path');
const express = require('express');
const { auth } = require('./auth');
require('./seedGuard');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

app.use('/api/auth', require('./routes/auth.routes'));

// 以下接口均需登录
app.use('/api/meta', auth, require('./routes/meta.routes'));
app.use('/api/people', auth, require('./routes/people.routes'));
app.use('/api/courses', auth, require('./routes/courses.routes'));
app.use('/api/trainings', auth, require('./routes/trainings.routes'));
app.use('/api/exams', auth, require('./routes/exams.routes'));
app.use('/api/grading', auth, require('./routes/grading.routes'));
app.use('/api/certificates', auth, require('./routes/certificates.routes'));
app.use('/api/harvest', auth, require('./routes/harvest.routes'));
app.use('/api/stats', auth, require('./routes/stats.routes'));
app.use('/api/notifications', auth, require('./routes/notifications.routes'));
app.use('/api/audit', auth, require('./routes/audit.routes'));

app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || '服务器内部错误' });
});

// 静态前端
app.use(express.static(path.join(__dirname, '..', 'web')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`GAP 平台已启动: http://localhost:${PORT}`));
