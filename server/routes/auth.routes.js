const express = require('express');
const router = express.Router();
const { login, auth } = require('../auth');

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const result = login(String(username || '').trim(), String(password || ''));
  if (!result) return res.status(401).json({ error: '用户名或密码错误' });
  res.json(result);
});

router.get('/me', auth, (req, res) => res.json({ user: req.user }));

module.exports = router;
