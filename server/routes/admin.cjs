const express = require('express');
const db = require('../db/index.cjs');
const sseHub = require('../sse/hub.cjs');
const { authAdmin } = require('../middleware/auth.cjs');

const router = express.Router();

// snake_case → camelCase（DB row 對前端）
function toCamel(row) {
  const out = {};
  for (const k of Object.keys(row || {})) {
    const ck = k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    out[ck] = row[k];
  }
  return out;
}

// ========== 統計 ==========
router.get('/stats', authAdmin, (req, res) => {
  const pending = db.prepare("SELECT COUNT(*) as c FROM drivers WHERE status = 'pending'").get().c;
  const approved = db.prepare("SELECT COUNT(*) as c FROM drivers WHERE status = 'approved'").get().c;
  const rejected = db.prepare("SELECT COUNT(*) as c FROM drivers WHERE status = 'rejected'").get().c;
  const vvipCount = db.prepare('SELECT COUNT(*) as c FROM drivers WHERE is_vvip = 1').get().c;
  const vvipPending = db.prepare('SELECT COUNT(*) as c FROM drivers WHERE vvip_applied = 1 AND is_vvip = 0').get().c;
  const totalOrders = db.prepare('SELECT COUNT(*) as c FROM orders').get().c;
  const todayOrders = db.prepare('SELECT COUNT(*) as c FROM orders WHERE created_at > ?').get(Date.now() - 86400000).c;
  const totalRevenue = db.prepare("SELECT COALESCE(SUM(actual_fare), 0) as s FROM orders WHERE status IN ('paid','finished')").get().s;
  const passengerCount = db.prepare('SELECT COUNT(*) as c FROM passengers').get().c;
  const onlineDrivers = db.prepare("SELECT COUNT(*) as c FROM drivers WHERE online = 1 AND status = 'approved'").get().c;

  res.json({
    pending, approved, rejected,
    vvipCount, vvipPending,
    totalOrders, todayOrders,
    totalRevenue, passengerCount,
    onlineDrivers,
  });
});

// ========== 司機申請列表（分頁） ==========
router.get('/drivers', authAdmin, (req, res) => {
  const { status = 'pending', page = 1, pageSize = 20 } = req.query;
  const p = Math.max(1, parseInt(String(page), 10) || 1);
  const ps = Math.min(100, Math.max(1, parseInt(String(pageSize), 10) || 20));
  const offset = (p - 1) * ps;

  let where = '';
  const params = [];
  if (status && status !== 'all') {
    where = 'WHERE status = ?';
    params.push(status);
  }

  const total = db.prepare(`SELECT COUNT(*) as c FROM drivers ${where}`).get(...params).c;
  const rows = db.prepare(
    `SELECT * FROM drivers ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(...params, ps, offset);

  res.json({ drivers: rows.map(toCamel), total, page: p, pageSize: ps });
});

// ========== 刪除司機帳戶 ==========
router.delete('/drivers/:id', authAdmin, (req, res) => {
  const { id } = req.params;
  const driver = db.prepare('SELECT * FROM drivers WHERE id = ?').get(id);
  if (!driver) return res.status(404).json({ error: '司機唔存在' });

  const now = Date.now();
  // 取消佢所有進行中訂單，並解除 driver_id 關聯（避免外鍵約束問題）
  db.prepare(
    "UPDATE orders SET status = 'cancelled', driver_id = NULL WHERE driver_id = ? AND status IN ('searching','accepted','picked_up','completed','paid')"
  ).run(id);
  // 清走佢出嘅貨單
  db.prepare(
    "UPDATE orders SET status = 'cancelled', created_by_driver = 0 WHERE created_by_driver = 1 AND driver_posted_from = ? AND status = 'searching'"
  ).run(id);
  // 清聊天記錄
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_messages'").get()) {
    db.prepare("DELETE FROM chat_messages WHERE sender_role = 'driver' AND sender_id = ?").run(id);
  }
  db.prepare('DELETE FROM drivers WHERE id = ?').run(id);

  sseHub.publishToAdmin('driver-updated', { driver: { id, deleted: true } });
  res.json({ ok: true, deletedId: id, cancelledAt: now });
});

// ========== 批准司機 ==========
router.post('/drivers/:id/approve', authAdmin, (req, res) => {
  const { id } = req.params;
  const driver = db.prepare('SELECT * FROM drivers WHERE id = ?').get(id);
  if (!driver) return res.status(404).json({ error: '司機唔存在' });

  db.prepare("UPDATE drivers SET status = 'approved', approved_at = ? WHERE id = ?").run(Date.now(), id);
  const updated = db.prepare('SELECT * FROM drivers WHERE id = ?').get(id);

  sseHub.publishToAdmin('driver-updated', { driver: updated });
  res.json({ driver: toCamel(updated) });
});

// ========== 拒絕司機 ==========
router.post('/drivers/:id/reject', authAdmin, (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;
  const driver = db.prepare('SELECT * FROM drivers WHERE id = ?').get(id);
  if (!driver) return res.status(404).json({ error: '司機唔存在' });

  db.prepare("UPDATE drivers SET status = 'rejected', reject_reason = ? WHERE id = ?").run(reason || '', id);
  const updated = db.prepare('SELECT * FROM drivers WHERE id = ?').get(id);

  sseHub.publishToAdmin('driver-updated', { driver: updated });
  res.json({ driver: toCamel(updated) });
});

// ========== VVIP 申請列表 ==========
router.get('/vvip-applications', authAdmin, (req, res) => {
  const status = req.query.status || 'pending';
  let where = '';
  if (status === 'pending') {
    where = 'WHERE vvip_applied = 1 AND is_vvip = 0';
  } else if (status === 'approved') {
    where = 'WHERE is_vvip = 1';
  } else if (status === 'rejected') {
    where = "WHERE vvip_applied = 0 AND is_vvip = 0 AND status = 'approved'";
  } else {
    where = 'WHERE 1=1';
  }
  const rows = db.prepare(
    `SELECT id, username, phone, name, avatar, plate, car_model, driver_license,
       rating, rating_count, status, reject_reason, online, current_lat, current_lng,
       is_vvip, vvip_expires_at, vvip_applied, vvip_requested_at, created_at, approved_at
     FROM drivers ${where} ORDER BY vvip_requested_at DESC, created_at DESC LIMIT 100`
  ).all();
  res.json({ applications: rows.map(toCamel) });
});

// ========== 批准 VVIP ==========
router.post('/drivers/:id/approve-vvip', authAdmin, (req, res) => {
  const { id } = req.params;
  const driver = db.prepare('SELECT * FROM drivers WHERE id = ?').get(id);
  if (!driver) return res.status(404).json({ error: '司機唔存在' });
  if (driver.status !== 'approved') return res.status(400).json({ error: '司機未通過資格審批' });

  // 皇牌有效期：管理員揀 1/3/6/12 個月，或者永久
  const { months } = req.body || {};
  const allowed = [1, 3, 6, 12];
  let expiresAt = null; // null = 永久
  if (months && months !== 'forever' && months !== 'permanent') {
    const n = parseInt(months, 10);
    if (!allowed.includes(n)) {
      return res.status(400).json({ error: '有效期請揀 1/3/6/12 個月或永久' });
    }
    expiresAt = Date.now() + n * 30 * 24 * 3600 * 1000;
  }

  db.prepare('UPDATE drivers SET is_vvip = 1, vvip_expires_at = ?, vvip_applied = 0 WHERE id = ?').run(expiresAt, id);
  const updated = db.prepare('SELECT * FROM drivers WHERE id = ?').get(id);

  sseHub.publishToAdmin('driver-updated', { driver: updated });
  sseHub.publishToDriver(id, 'vvip-approved', { driver: updated });

  res.json({ driver: toCamel(updated) });
});

// ========== 取消 VVIP ==========
router.post('/drivers/:id/revoke-vvip', authAdmin, (req, res) => {
  const { id } = req.params;
  const driver = db.prepare('SELECT * FROM drivers WHERE id = ?').get(id);
  if (!driver) return res.status(404).json({ error: '司機唔存在' });

  db.prepare('UPDATE drivers SET is_vvip = 0, vvip_applied = 0, vvip_expires_at = NULL WHERE id = ?').run(id);
  const updated = db.prepare('SELECT * FROM drivers WHERE id = ?').get(id);

  sseHub.publishToAdmin('driver-updated', { driver: updated });
  sseHub.publishToDriver(id, 'vvip-revoked', { driver: updated });

  res.json({ driver: toCamel(updated) });
});

// ========== 駁回 VVIP 申請 ==========
router.post('/drivers/:id/reject-vvip', authAdmin, (req, res) => {
  const { id } = req.params;
  const driver = db.prepare('SELECT * FROM drivers WHERE id = ?').get(id);
  if (!driver) return res.status(404).json({ error: '司機唔存在' });

  db.prepare('UPDATE drivers SET vvip_applied = 0, vvip_requested_at = NULL WHERE id = ?').run(id);
  const updated = db.prepare('SELECT * FROM drivers WHERE id = ?').get(id);

  sseHub.publishToAdmin('driver-updated', { driver: updated });
  sseHub.publishToDriver(id, 'vvip-rejected', { driver: updated });

  res.json({ driver: toCamel(updated) });
});

// ========== 訂單列表 ==========
router.get('/orders', authAdmin, (req, res) => {
  const { status } = req.query;
  let query = `
    SELECT o.*,
           p.name as passenger_name, p.phone as passenger_phone,
           d.name as driver_name, d.plate as driver_plate
    FROM orders o
    LEFT JOIN passengers p ON o.passenger_id = p.id
    LEFT JOIN drivers d ON o.driver_id = d.id
  `;
  const params = [];
  if (status && status !== 'all') {
    query += ' WHERE o.status = ?';
    params.push(status);
  }
  query += ' ORDER BY o.created_at DESC LIMIT 100';
  const rows = db.prepare(query).all(...params);
  res.json({ orders: rows });
});

// ========== SSE 管理員 ==========
router.get('/stream', authAdmin, (req, res) => {
  sseHub.subscribe(req, res, 'admin', null);
});

// ========== 備份：導出全部資料（會員＋訂單＋租車）成 JSON ==========
router.get('/backup', authAdmin, (req, res) => {
  try {
    const tables = ['passengers', 'drivers', 'admins', 'orders', 'rental_posts', 'chat_messages', 'flood_reports'];
    const dump = {
      exportedAt: Date.now(),
      app: 'dikdou',
      version: 'v1.35',
      tables: {},
    };
    for (const t of tables) {
      try {
        dump.tables[t] = db.prepare(`SELECT * FROM ${t}`).all();
      } catch {
        dump.tables[t] = [];
      }
    }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="dikdou_backup_${new Date().toISOString().slice(0,10)}.json"`);
    res.json(dump);
  } catch (e) {
    res.status(500).json({ error: '備份失敗' });
  }
});

module.exports = router;
