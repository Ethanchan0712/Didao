const express = require('express');
const db = require('../db/index.cjs');
const sseHub = require('../sse/hub.cjs');
const { authPassenger, authDriver, authAdmin } = require('../middleware/auth.cjs');

const router = express.Router();

function genId() {
  return 'msg_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

// ========== 發送訊息（乘客） ==========
router.post('/passenger/send', authPassenger, (req, res) => {
  const { orderId, text } = req.body;
  if (!orderId || !text) return res.status(400).json({ error: '參數唔完整' });

  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND passenger_id = ?').get(orderId, req.userId);
  if (!order) return res.status(404).json({ error: '訂單唔存在' });
  if (['cancelled', 'finished'].includes(order.status)) {
    return res.status(400).json({ error: '訂單已完結，唔可以再發訊息' });
  }

  const id = genId();
  const now = Date.now();

  db.prepare(`INSERT INTO chat_messages (id, order_id, sender_role, sender_id, text, timestamp)
              VALUES (?, ?, 'passenger', ?, ?, ?)`).run(id, orderId, req.userId, text, now);

  const message = { id, orderId, from: 'passenger', text, timestamp: now };
  sseHub.publishToOrder(orderId, 'new-message', { message });

  res.json({ message });
});

// ========== 發送訊息（司機） ==========
router.post('/driver/send', authDriver, (req, res) => {
  const { orderId, text } = req.body;
  if (!orderId || !text) return res.status(400).json({ error: '參數唔完整' });

  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND driver_id = ?').get(orderId, req.userId);
  if (!order) return res.status(404).json({ error: '訂單唔存在' });
  if (['cancelled', 'finished'].includes(order.status)) {
    return res.status(400).json({ error: '訂單已完結，唔可以再發訊息' });
  }

  const id = genId();
  const now = Date.now();

  db.prepare(`INSERT INTO chat_messages (id, order_id, sender_role, sender_id, text, timestamp)
              VALUES (?, ?, 'driver', ?, ?, ?)`).run(id, orderId, req.userId, text, now);

  const message = { id, orderId, from: 'driver', text, timestamp: now };
  sseHub.publishToOrder(orderId, 'new-message', { message });

  res.json({ message });
});

// ========== 攞訂單訊息列表 ==========
router.get('/order/:orderId', (req, res) => {
  const rows = db.prepare(`
    SELECT id, order_id, sender_role as \"from\", text, timestamp
    FROM chat_messages
    WHERE order_id = ?
    ORDER BY timestamp ASC
    LIMIT 200
  `).all(req.params.orderId);

  const messages = rows.map(r => ({
    id: r.id,
    orderId: r.order_id,
    from: r.from,
    text: r.text,
    timestamp: r.timestamp,
  }));

  res.json({ messages });
});

module.exports = router;
