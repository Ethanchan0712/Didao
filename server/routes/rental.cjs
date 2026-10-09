// ========== 租車市場 API（出租單俾所有人睇到） ==========
const express = require('express');
const db = require('../db/index.cjs');
const router = express.Router();

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
    const dur = Number(b.duration) > 0 ? Math.round(Number(b.duration)) : null;
    const expiresAt = dur ? Date.now() + dur * 24 * 60 * 60 * 1000 : null;
    db.prepare(`
      INSERT INTO rental_posts
      (id, taxi_color, car_model, shift, district, price, price_unit, plate,
       owner_name, owner_phone, year, seats, note, rating, rental_count, owner_key,
       duration, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      Date.now(),
      Date.now()
    );
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: '發佈失敗' });
  }
});

// 刪除自己發佈嘅單（需 ownerKey 吻合）
router.delete('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const ownerKey = req.query.ownerKey || '';
    const row = db.prepare('SELECT * FROM rental_posts WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: '單唔存在' });
    if (ownerKey && row.owner_key && ownerKey !== row.owner_key) {
      return res.status(403).json({ error: '冇權限刪除' });
    }
    db.prepare('DELETE FROM rental_posts WHERE id = ?').run(id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: '刪除失敗' });
  }
});

module.exports = router;
