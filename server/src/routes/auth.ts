import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { getHelper } from '../db/connection.js';

const router = Router();

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const db = await getHelper();
  const user = db.get('SELECT * FROM users WHERE username = ?', username);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.displayName = user.display_name;
  req.session.role = user.role;

  res.json({ id: user.id, username: user.username, displayName: user.display_name, role: user.role });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', (req, res) => {
  if (req.session?.userId) {
    res.json({ id: req.session.userId, username: req.session.username, displayName: req.session.displayName, role: req.session.role });
  } else {
    res.status(401).json({ error: 'Not authenticated' });
  }
});

export default router;
