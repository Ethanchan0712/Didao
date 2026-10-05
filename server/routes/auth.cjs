const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/index.cjs');
const { signToken, authPassenger, authDriver } = require('../middleware/auth.cjs');

const router = express.Router();

function genId(prefix) {
  return prefix + '_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

// ========== 乘客註冊 ==========
router.post('/passenger/register', (req, res) => {
  const { username, phone, password, name } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: '請輸入帳號同密碼' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: '密碼至少 6 位' });
  }

  const existing = db.prepare('SELECT id FROM passengers WHERE username = ? OR phone = ?').get(username, phone || '');
  if (existing) {
    return res.status(400).json({ error: '帳號或電話已經註冊咗' });
  }

  const id = genId('p');
  const hash = bcrypt.hashSync(password, 10);
  const now = Date.now();

  db.prepare(`INSERT INTO passengers (id, username, phone, password, name, created_at)
              VALUES (?, ?, ?, ?, ?, ?)`).run(id, username, phone || '', hash, name || username, now);

  const user = db.prepare('SELECT id, username, phone, name, rating, rating_count FROM passengers WHERE id = ?').get(id);
  const token = signToken({ id, role: 'passenger' });

  res.json({ user, token });
});

// ========== 乘客登入 ==========
router.post('/passenger/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: '請輸入帳號同密碼' });
  }

  const row = db.prepare('SELECT * FROM passengers WHERE username = ? OR phone = ?').get(username, username);
  if (!row) {
    return res.status(401).json({ error: '帳號或密碼錯誤' });
  }

  const ok = bcrypt.compareSync(password, row.password);
  if (!ok) {
    return res.status(401).json({ error: '帳號或密碼錯誤' });
  }

  const user = {
    id: row.id,
    username: row.username,
    phone: row.phone,
    name: row.name,
    avatar: row.avatar,
    rating: row.rating,
    rating_count: row.rating_count,
  };
  const token = signToken({ id: row.id, role: 'passenger' });

  res.json({ user, token });
});

// ========== 乘客電話登入（階段一 mock SMS）==========
// 階段一：唔使真 SMS，萬能驗證碼 123456；之後接真 SMS 服務
router.post('/passenger/send-code', (req, res) => {
  const { phone } = req.body;
  if (!phone || !/^[0-9+\-\s]{6,15}$/.test(String(phone))) {
    return res.status(400).json({ error: '請輸入正確電話號碼' });
  }
  res.json({ ok: true, message: '驗證碼已發送（萬能驗證碼：123456）', mockCode: '123456' });
});

router.post('/passenger/phone-login', (req, res) => {
  const { phone, code } = req.body;
  if (!phone || !code) {
    return res.status(400).json({ error: '請輸入電話同驗證碼' });
  }
  if (String(code).trim() !== '123456') {
    return res.status(401).json({ error: '驗證碼錯誤' });
  }
  const phoneNorm = String(phone).replace(/[\s-]/g, '');
  let row = db.prepare('SELECT * FROM passengers WHERE phone = ?').get(phoneNorm);
  if (!row) {
    const id = genId('p');
    const hash = bcrypt.hashSync('phone1234', 10);
    const now = Date.now();
    db.prepare(`INSERT INTO passengers (id, username, phone, password, name, rating, rating_count, created_at)
                VALUES (?, ?, ?, ?, '乘客', 5.0, 0, ?)`).run(id, 'p_' + phoneNorm, phoneNorm, hash, now);
    row = db.prepare('SELECT * FROM passengers WHERE id = ?').get(id);
  }
  const user = {
    id: row.id,
    username: row.username,
    phone: row.phone,
    name: row.name,
    avatar: row.avatar,
    rating: row.rating,
    rating_count: row.rating_count,
  };
  const token = signToken({ id: row.id, role: 'passenger' });
  res.json({ user, token });
});

// ========== 乘客資料 ==========
router.get('/passenger/me', authPassenger, (req, res) => {
  res.json({ user: req.user });
});

// ========== 司機註冊 ==========
router.post('/driver/register', (req, res) => {
  const { username, phone, password, name, plate, carModel, driverLicense, idFront4, referrerPhone } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: '請輸入帳號同密碼' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: '密碼至少 6 位' });
  }
  if (!driverLicense) {
    return res.status(400).json({ error: '請填寫的士証號碼' });
  }
  if (!idFront4 || !/^[A-Za-z0-9]{4}$/.test(String(idFront4))) {
    return res.status(400).json({ error: '請填寫身份証頭4位數字（例：A123）' });
  }

  const existing = db.prepare('SELECT id FROM drivers WHERE username = ? OR phone = ?').get(username, phone || '');
  if (existing) {
    return res.status(400).json({ error: '帳號或電話已經註冊咗' });
  }

  // 介紹人（會員號碼＝電話號碼）：可選填，但填咗一定要係已開通嘅司機會員
  let referrerPhoneNorm = null;
  if (referrerPhone && String(referrerPhone).trim()) {
    referrerPhoneNorm = String(referrerPhone).trim();
    const referrer = db.prepare(
      "SELECT id, name, status FROM drivers WHERE phone = ? AND status = 'approved'"
    ).get(referrerPhoneNorm);
    if (!referrer) {
      return res.status(400).json({ error: '介紹人號碼唔正確（要填已開通嘅司機電話號碼）' });
    }
  }

  const id = genId('d');
  const hash = bcrypt.hashSync(password, 10);
  const now = Date.now();

  db.prepare(`INSERT INTO drivers (id, username, phone, password, name, plate, car_model, driver_license, id_front4, referrer_phone, status, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`).run(
    id, username, phone || '', hash, name || username,
    plate || '', carModel || '', driverLicense || '', String(idFront4).toUpperCase(),
    referrerPhoneNorm, now
  );

  const user = db.prepare(`SELECT id, username, phone, name, plate, car_model, driver_license, id_front4, referrer_phone, status, rating, rating_count
                           FROM drivers WHERE id = ?`).get(id);
  const token = signToken({ id, role: 'driver' });

  // 通知管理員有新申請
  const sseHub = require('../sse/hub.cjs');
  sseHub.publishToAdmin('new-driver-application', { driver: user });

  res.json({ user, token });
});

// ========== 司機登入 ==========
router.post('/driver/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: '請輸入帳號同密碼' });
  }

  const row = db.prepare('SELECT * FROM drivers WHERE username = ? OR phone = ?').get(username, username);
  if (!row) {
    return res.status(401).json({ error: '帳號或密碼錯誤' });
  }

  const ok = bcrypt.compareSync(password, row.password);
  if (!ok) {
    return res.status(401).json({ error: '帳號或密碼錯誤' });
  }

  const user = {
    id: row.id,
    username: row.username,
    phone: row.phone,
    name: row.name,
    avatar: row.avatar,
    plate: row.plate,
    car_model: row.car_model,
    driver_license: row.driver_license,
    id_front4: row.id_front4,
    status: row.status,
    online: !!row.online,
    rating: row.rating,
    rating_count: row.rating_count,
    current_lat: row.current_lat,
    current_lng: row.current_lng,
    is_vvip: !!row.is_vvip,
    vvip_expires_at: row.vvip_expires_at || null,
    is_vip: !!row.is_vip,
    vip_expires_at: row.vip_expires_at || null,
    vvip_applied: !!row.vvip_applied,
    vvip_requested_at: row.vvip_requested_at,
  };
  const token = signToken({ id: row.id, role: 'driver' });

  res.json({ user, token });
});

// ========== 司機資料 ==========
router.get('/driver/me', authDriver, (req, res) => {
  res.json({ user: req.user });
});

// ========== 司機更改密碼 ==========
router.post('/driver/change-password', authDriver, (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword) {
    return res.status(400).json({ error: '請輸入舊密碼同新密碼' });
  }
  if (String(newPassword).length < 6) {
    return res.status(400).json({ error: '新密碼至少 6 位' });
  }

  const row = db.prepare('SELECT password FROM drivers WHERE id = ?').get(req.user.id);
  if (!row) return res.status(404).json({ error: '司機唔存在' });

  if (!bcrypt.compareSync(String(oldPassword), row.password)) {
    return res.status(401).json({ error: '舊密碼錯誤' });
  }

  const hash = bcrypt.hashSync(String(newPassword), 10);
  db.prepare('UPDATE drivers SET password = ? WHERE id = ?').run(hash, req.user.id);
  res.json({ ok: true });
});

// ========== 司機申請 VVIP ==========
router.post('/driver/vvip-apply', authDriver, (req, res) => {
  const userId = req.user.id;
  const row = db.prepare('SELECT * FROM drivers WHERE id = ?').get(userId);
  if (!row) return res.status(404).json({ error: '司機唔存在' });
  if (row.status !== 'approved') return res.status(400).json({ error: '帳號未審批，唔可以申請 VVIP' });
  if (row.is_vvip) return res.status(400).json({ error: '你已經係 VVIP 司機' });
  if (row.vvip_applied) return res.status(400).json({ error: '申請已遞交，請等待管理員審批' });

  const now = Date.now();
  db.prepare('UPDATE drivers SET vvip_applied = 1, vvip_requested_at = ? WHERE id = ?').run(now, userId);

  // 通知管理員
  const sseHub = require('../sse/hub.cjs');
  sseHub.publishToAdmin('vvip-application-new', { driverId: userId, name: row.name, plate: row.plate });

  const updated = db.prepare('SELECT * FROM drivers WHERE id = ?').get(userId);
  res.json({
    user: {
      id: updated.id,
      name: updated.name,
      is_vvip: !!updated.is_vvip,
      vvip_applied: !!updated.vvip_applied,
      vvip_requested_at: updated.vvip_requested_at,
    }
  });
});

// ========== 管理員登入 ==========
router.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: '請輸入帳號同密碼' });
  }

  const row = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
  if (!row) {
    return res.status(401).json({ error: '帳號或密碼錯誤' });
  }

  const ok = bcrypt.compareSync(password, row.password);
  if (!ok) {
    return res.status(401).json({ error: '帳號或密碼錯誤' });
  }

  const role = row.role || 'admin';
  const user = { id: row.id, username: row.username, role };
  const token = signToken({ id: row.id, role });

  res.json({ user, token });
});

module.exports = router;
