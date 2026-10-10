// ========== 租車市場 API（出租單俾所有人睇到） ==========
const express = require('express');
const crypto = require('crypto');
const db = require('../db/index.cjs');
const router = express.Router();

function hashPwd(p) { return crypto.createHash('sha256').update(String(p || '')).digest('hex'); }
// 管理權驗證：有設密碼 → 必須密碼啱；冇密碼 → 先接受 ownerKey
function canManage(row, pwd, ownerKey) {
  if (!row) return false;
  if (row.manage_pwd) {
    return pwd ? row.manage_pwd === hashPwd(pwd) : false;
  }
  if (row.owner_key && ownerKey) return row.owner_key === ownerKey;
  return false;
}

// 識別發佈人：用前端傳嚟嘅 ownerKey（手機號碼），冇登入都得
// 全部出租單公開列表
router.get('/', (req, res) => {
  try {
    const { district, color, q } = req.query;
    let sql = `SELECT * FROM rental_posts`;
    const where = [];
    const params = [];
    if (district && district !== 'all') {
      where.push(`district = ?`);
      params.push(district);
    }
    if (color && color !== 'all') {
      where.push(`taxi_color = ?`);
      params.push(color);
    }
    if (q) {
      where.push(`(owner_name LIKE ? OR plate LIKE ? OR note LIKE ?)`);
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    // 過期單自動下架（duration 屆滿就唔顯示）
    where.push(`(expires_at IS NULL OR expires_at > ?)`);
    params.push(Date.now());
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
    sql += ` ORDER BY created_at DESC LIMIT 100`;
    const rows = db.prepare(sql).all(...params);
    res.json({ posts: rows });
  } catch (e) {
    res.status(500).json({ error: '讀取出租單失敗' });
  }
});

// 自己發佈嘅單
router.get('/mine', (req, res) => {
  try {
    const ownerKey = req.query.ownerKey || '';
    if (!ownerKey) return res.json({ posts: [] });
    const rows = db.prepare(`SELECT * FROM rental_posts WHERE owner_key = ? ORDER BY created_at DESC`)
      .all(ownerKey);
    res.json({ posts: rows });
  } catch (e) {
    res.status(500).json({ error: '讀取失敗' });
  }
});

// 發佈出租單
router.post('/', (req, res) => {
  try {
    const b = req.body || {};
    const id = 'rt_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const ownerKey = String(b.ownerKey || '').slice(0, 50);
    const managePwd = b.managePwd ? hashPwd(b.managePwd) : null;
    const dur = Number(b.duration) > 0 ? Math.round(Number(b.duration)) : null;
    const expiresAt = dur ? Date.now() + dur * 24 * 60 * 60 * 1000 : null;
    db.prepare(`
      INSERT INTO rental_posts
      (id, taxi_color, car_model, shift, district, price, price_unit, plate,
       owner_name, owner_phone, year, seats, note, rating, rental_count, owner_key,
       duration, expires_at, manage_pwd, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      String(b.taxiColor || 'red'),
      String(b.carModel || 'old_comf'),
      String(b.shift || 'full_day'),
      String(b.district || 'kowloon'),
      Number(b.price) || 0,
      String(b.priceUnit || 'day'),
      String(b.plate || ''),
      String(b.ownerName || ''),
      String(b.ownerPhone || ''),
      Number(b.year) || 0,
      Number(b.seats) || 4,
      String(b.note || ''),
      5.0,
      0,
      ownerKey,
      dur,
      expiresAt,
      managePwd,
      Date.now(),
      Date.now()
    );
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: '發佈失敗' });
  }
});

// 刪除自己發佈嘅單（需管理密碼或 ownerKey 吻合）
router.delete('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const row = db.prepare('SELECT * FROM rental_posts WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: '單唔存在' });
    if (!canManage(row, req.query.pwd || '', req.query.ownerKey || '')) {
      return res.status(403).json({ error: '請輸入正確嘅管理密碼' });
    }
    db.prepare('DELETE FROM rental_posts WHERE id = ?').run(id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: '刪除失敗' });
  }
});

// 編輯自己發佈嘅出租單（需管理密碼）
router.put('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const b = req.body || {};
    const row = db.prepare('SELECT * FROM rental_posts WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: '單唔存在' });
    if (!canManage(row, b.pwd || '', b.ownerKey || '')) {
      return res.status(403).json({ error: '請輸入正確嘅管理密碼' });
    }
    db.prepare(`
      UPDATE rental_posts SET
        taxi_color=?, car_model=?, shift=?, district=?, price=?, price_unit=?,
        plate=?, owner_name=?, owner_phone=?, year=?, seats=?, note=?, updated_at=?
      WHERE id=?
    `).run(
      String(b.taxiColor || row.taxi_color),
      String(b.carModel || row.car_model),
      String(b.shift || row.shift),
      String(b.district || row.district),
      b.price !== undefined ? Number(b.price) : row.price,
      String(b.priceUnit || row.price_unit),
      String(b.plate ?? row.plate ?? ''),
      String(b.ownerName ?? row.owner_name ?? ''),
      String(b.ownerPhone ?? row.owner_phone ?? ''),
      b.year !== undefined ? Number(b.year) : row.year,
      b.seats !== undefined ? Number(b.seats) : row.seats,
      String(b.note ?? row.note ?? ''),
      Date.now(),
      id
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: '更新失敗' });
  }
});

// ========== 人搵車（乘客發佈搭車需求） ==========
// 公開列表（過期自動隱藏）
router.get('/find', (req, res) => {
  try {
    const { taxiColor, taxiType } = req.query;
    let sql = `SELECT * FROM rental_car_requests`;
    const where = [];
    const params = [];
    if (taxiColor && taxiColor !== 'all') {
      where.push(`taxi_color = ?`);
      params.push(taxiColor);
    }
    if (taxiType && taxiType !== 'all') {
      where.push(`taxi_type = ?`);
      params.push(taxiType);
    }
    // 過期單自動下架
    where.push(`(expires_at IS NULL OR expires_at > ?)`);
    params.push(Date.now());
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
    sql += ` ORDER BY created_at DESC LIMIT 100`;
    const rows = db.prepare(sql).all(...params);
    res.json({ posts: rows });
  } catch (e) {
    res.status(500).json({ error: '讀取人搵車失敗' });
  }
});

// 發佈人搵車
router.post('/find', (req, res) => {
  try {
    const b = req.body || {};
    const id = 'fr_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const ownerKey = String(b.ownerKey || '').slice(0, 50);
    const managePwd = b.managePwd ? hashPwd(b.managePwd) : null;
    const dur = Number(b.duration) > 0 ? Math.round(Number(b.duration)) : 30;
    const expiresAt = Date.now() + dur * 24 * 60 * 60 * 1000;
    db.prepare(`
      INSERT INTO rental_car_requests
      (id, owner_key, pickup_area, time_from, time_to, dates, taxi_color, taxi_type, duration, contact, expires_at, manage_pwd, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      ownerKey,
      String(b.pickupArea || '').slice(0, 60),
      String(b.timeFrom || '').slice(0, 20),
      String(b.timeTo || '').slice(0, 20),
      String(b.dates || '').slice(0, 100),
      String(b.taxiColor || 'all'),
      String(b.taxiType || 'all'),
      dur,
      String(b.contact || '').slice(0, 80),
      expiresAt,
      managePwd,
      Date.now()
    );
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: '發佈失敗' });
  }
});

// 刪除自己發佈嘅人搵車（需管理密碼或 ownerKey 吻合）
router.delete('/find/:id', (req, res) => {
  try {
    const { id } = req.params;
    const row = db.prepare('SELECT * FROM rental_car_requests WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: '單唔存在' });
    if (!canManage(row, req.query.pwd || '', req.query.ownerKey || '')) {
      return res.status(403).json({ error: '請輸入正確嘅管理密碼' });
    }
    db.prepare('DELETE FROM rental_car_requests WHERE id = ?').run(id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: '刪除失敗' });
  }
});

// 編輯自己發佈嘅人搵車（需管理密碼）
router.put('/find/:id', (req, res) => {
  try {
    const { id } = req.params;
    const b = req.body || {};
    const row = db.prepare('SELECT * FROM rental_car_requests WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: '單唔存在' });
    if (!canManage(row, b.pwd || '', b.ownerKey || '')) {
      return res.status(403).json({ error: '請輸入正確嘅管理密碼' });
    }
    db.prepare(`
      UPDATE rental_car_requests SET
        pickup_area=?, time_from=?, time_to=?, dates=?, taxi_color=?, taxi_type=?, contact=?
      WHERE id=?
    `).run(
      String(b.pickupArea ?? row.pickup_area ?? ''),
      String(b.timeFrom ?? row.time_from ?? ''),
      String(b.timeTo ?? row.time_to ?? ''),
      String(b.dates ?? row.dates ?? ''),
      String(b.taxiColor ?? row.taxi_color ?? 'all'),
      String(b.taxiType ?? row.taxi_type ?? 'all'),
      String(b.contact ?? row.contact ?? ''),
      id
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: '更新失敗' });
  }
});

module.exports = router;
