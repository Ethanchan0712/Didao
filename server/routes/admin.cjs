const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db/index.cjs');
const sseHub = require('../sse/hub.cjs');
const { authAdmin, authOperator } = require('../middleware/auth.cjs');

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
  const onlineDrivers = db.prepare(
    "SELECT COUNT(*) as c FROM drivers WHERE online = 1 AND status = 'approved' AND last_seen > ?"
  ).get(Date.now() - 300000).c;

  res.json({
    pending, approved, rejected,
    vvipCount, vvipPending,
    totalOrders, todayOrders,
    totalRevenue, passengerCount,
    onlineDrivers,
  });
});

// ========== 司機申請列表（分頁） ==========
router.get('/drivers', authOperator, (req, res) => {
  const { page = 1, pageSize = 20 } = req.query;
  // 營運主任淨係可以睇 pending 申請（批核用），睇唔到其他司機資料
  const isOperator = req.user.role === 'operator';
  const status = isOperator ? 'pending' : (req.query.status || 'pending');
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

  // 管理員睇每個司機係咪已開通營運主任（operator 唔需要呢欄）
  const opSet = new Set(
    isOperator ? [] : db.prepare("SELECT username FROM admins WHERE role = 'operator'").all().map((r) => r.username)
  );

  res.json({
    drivers: rows.map((r) => ({ ...toCamel(r), isOperator: isOperator ? false : opSet.has(r.phone) })),
    total, page: p, pageSize: ps, isOperator,
  });
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

// ========== 開通營運主任（管理員專用） ==========
// 營運主任＝一個可以登入後台批核司機申請嘅角色。將某個已開通司機升級，
// 用佢自己嘅電話做登入帳號、原本密碼登入後台，權限淨係批核。
router.post('/members/:id/set-operator', authAdmin, (req, res) => {
  const driver = db.prepare('SELECT * FROM drivers WHERE id = ?').get(req.params.id);
  if (!driver) return res.status(404).json({ error: '司機唔存在' });
  if (driver.status !== 'approved') {
    return res.status(400).json({ error: '淨係可以將已開通（approved）司機設為營運主任' });
  }
  // 用電話做登入帳號（會員號碼＝電話，唯一），密碼沿用司機原本密碼
  const exists = db.prepare('SELECT id FROM admins WHERE username = ?').get(driver.phone);
  if (exists) {
    db.prepare("UPDATE admins SET role = 'operator' WHERE username = ?").run(driver.phone);
  } else {
    db.prepare('INSERT INTO admins (id, username, password, role, created_at) VALUES (?, ?, ?, ?, ?)').run(
      'op_' + Date.now().toString(36), driver.phone, driver.password, 'operator', Date.now()
    );
  }
  sseHub.publishToAdmin('driver-updated', { driver: { id: driver.id, isOperator: true } });
  res.json({ ok: true, driverId: driver.id, username: driver.phone, role: 'operator' });
});

// ========== 取消營運主任（管理員專用） ==========
router.post('/members/:id/revoke-operator', authAdmin, (req, res) => {
  const driver = db.prepare('SELECT id, phone FROM drivers WHERE id = ?').get(req.params.id);
  if (!driver) return res.status(404).json({ error: '司機唔存在' });
  const r = db.prepare("DELETE FROM admins WHERE username = ? AND role = 'operator'").run(driver.phone);
  sseHub.publishToAdmin('driver-updated', { driver: { id: driver.id, isOperator: false } });
  res.json({ ok: true, driverId: driver.id, removed: r.changes > 0 });
});

// ========== 批准司機（營運主任都做到） ==========
router.post('/drivers/:id/approve', authOperator, (req, res) => {
  const { id } = req.params;
  const { grantVip, grantVvipTrial } = req.body || {};
  const driver = db.prepare('SELECT * FROM drivers WHERE id = ?').get(id);
  if (!driver) return res.status(404).json({ error: '司機唔存在' });

  const now = Date.now();
  const DAY = 24 * 3600 * 1000;
  // 批 VIP 試用 10 日（由批核嗰刻起計時）
  let vipExpires = grantVip ? now + 10 * DAY : (driver.vip_expires_at ?? null);
  let isVip = grantVip ? 1 : (driver.is_vip || 0);
  // 批皇牌體驗 1 日（由批核嗰刻起計時；唔覆蓋原有永久/更長皇牌）
  let vvipExpires = grantVvipTrial
    ? (driver.vvip_expires_at && driver.vvip_expires_at > now + DAY ? driver.vvip_expires_at : now + DAY)
    : (driver.vvip_expires_at ?? null);
  let isVvip = grantVvipTrial ? 1 : (driver.is_vvip || 0);

  db.prepare(
    `UPDATE drivers SET status = 'approved', approved_at = ?, is_vip = ?, vip_expires_at = ?, is_vvip = ?, vvip_expires_at = ? WHERE id = ?`
  ).run(now, isVip, vipExpires, isVvip, vvipExpires, id);
  const updated = db.prepare('SELECT * FROM drivers WHERE id = ?').get(id);

  sseHub.publishToAdmin('driver-updated', { driver: updated });
  res.json({ driver: toCamel(updated) });
});

// ========== 拒絕司機（營運主任都做到） ==========
router.post('/drivers/:id/reject', authOperator, (req, res) => {
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

// ========== 每日訂單統計（管理員睇每日單量） ==========
router.get('/orders/daily', authAdmin, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT
        date(created_at/1000 + 28800, 'unixepoch') AS day,
        COUNT(*) AS total,
        SUM(CASE WHEN status IN ('finished','completed','paid') THEN 1 ELSE 0 END) AS success,
        SUM(CASE WHEN status IN ('cancelled') AND driver_id IS NULL THEN 1 ELSE 0 END) AS unmatched,
        SUM(CASE WHEN status IN ('finished','completed','paid') THEN COALESCE(actual_fare, estimated_fare, 0) ELSE 0 END) AS fare_est
      FROM orders
      GROUP BY day
      ORDER BY day DESC
      LIMIT 60
    `).all();
    // 補今日（香港時區 +8）
    const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const hasToday = rows.some(r => r.day === today);
    if (!hasToday) {
      rows.unshift({ day: today, total: 0, success: 0, unmatched: 0, fare_est: 0 });
    }
    res.json({ daily: rows });
  } catch (e) {
    res.status(500).json({ error: '讀取每日統計失敗' });
  }
});

// ========== 管理員刪單（清理測試單／問題單） ==========
router.delete('/orders/:id', authAdmin, (req, res) => {
  const info = db.prepare('DELETE FROM orders WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: '訂單唔存在' });
  res.json({ ok: true });
});

// ========== 管理員清測試單（淨係清未接嘅 searching 單，按乘客電話前綴） ==========
router.post('/orders/cleanup-test', authAdmin, (req, res) => {
  // 清 9777 開頭（測試帳戶）乘客嘅 searching 單，以及超過 2 小時仲未接嘅 searching 單
  const now = Date.now();
  const cutoff = now - 2 * 60 * 60 * 1000;
  const info = db.prepare(`DELETE FROM orders
    WHERE status = 'searching' AND (passenger_id IN (
      SELECT id FROM passengers WHERE phone LIKE '9777%'
    ) OR created_at < ?)`).run(cutoff);
  res.json({ ok: true, deleted: info.changes });
});

// ========== SSE 管理員 ==========
// ========== 介紹人統計（管理員專用） ==========
// 會員號碼=電話號碼。統計每部已開通司機有幾多人填佢做介紹人
router.get('/referrers', authAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT r.phone AS member_phone, r.name AS member_name, r.username, r.plate,
           (SELECT COUNT(*) FROM drivers d WHERE d.referrer_phone = r.phone AND d.status IN ('approved','pending','rejected')) AS referred_count
    FROM drivers r
    WHERE r.status = 'approved'
      AND EXISTS (SELECT 1 FROM drivers d WHERE d.referrer_phone = r.phone)
    ORDER BY referred_count DESC, r.created_at ASC
  `).all();
  res.json({ referrers: rows.map(toCamel) });
});

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

// ========== 還原：上傳備份 JSON，重建全部資料（先自動備份現有資料，防損失）==========
// 還原只處理業務資料表。admins（管理員帳戶）唔動——由 server 啟動時 seed 管理，
// 避免還原清空 admin 表之後登入唔到。
const RESTORE_TABLES = ['passengers', 'drivers', 'orders', 'rental_posts', 'chat_messages', 'flood_reports'];

router.post('/restore', authAdmin, (req, res) => {
  const dump = req.body;
  if (!dump || !dump.tables || typeof dump.tables !== 'object') {
    return res.status(400).json({ error: '無效嘅備份檔（缺少 tables）' });
  }
  try {
    // 1. 還原前自動備份現有資料（萬一還原出錯都有得返頭）
    const beforeDump = { exportedAt: Date.now(), app: 'dikdou', version: 'v1.36', tables: {} };
    for (const t of RESTORE_TABLES) {
      try { beforeDump.tables[t] = db.prepare(`SELECT * FROM ${t}`).all(); } catch { beforeDump.tables[t] = []; }
    }
    const backupDir = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : path.join(__dirname, '..', 'db');
    fs.mkdirSync(backupDir, { recursive: true });
    const beforePath = path.join(backupDir, `restore_before_${new Date().toISOString().slice(0, 10)}.json`);
    fs.writeFileSync(beforePath, JSON.stringify(beforeDump, null, 2));

    // 2. 清空（先子表後主表，避免外鍵衝突；admins 表唔動）
    const mainTables = ['passengers', 'drivers'];
    const childTables = ['orders', 'rental_posts', 'chat_messages', 'flood_reports'];
    for (const t of [...childTables, ...mainTables]) {
      try { db.prepare(`DELETE FROM ${t}`).run(); } catch { /* 表唔存在就跳過 */ }
    }

    // 3. 插入備份資料（先主表後子表）
    let inserted = 0;
    let skipped = 0;
    for (const t of [...mainTables, ...childTables]) {
      const rows = dump.tables[t];
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        const cols = Object.keys(row);
        if (cols.length === 0) continue;
        const placeholders = cols.map(() => '?').join(',');
        const values = cols.map((c) => row[c]);
        try {
          db.prepare(`INSERT INTO ${t} (${cols.map((c) => '"' + c + '"').join(',')}) VALUES (${placeholders})`).run(...values);
          inserted += 1;
        } catch { skipped += 1; }
      }
    }

    res.json({ ok: true, restoredTables: RESTORE_TABLES, inserted, skipped, autoBackupPath: beforePath });
  } catch (e) {
    res.status(500).json({ error: '還原失敗: ' + (e.message || '') });
  }
});

module.exports = router;
