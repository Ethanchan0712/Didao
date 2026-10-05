const express = require('express');
const db = require('../db/index.cjs');
const sseHub = require('../sse/hub.cjs');
const { authPassenger, authDriver } = require('../middleware/auth.cjs');

const router = express.Router();

function genOrderId() {
  return 'HK' + Math.random().toString(36).slice(2, 8).toUpperCase() + Date.now().toString().slice(-4);
}

function orderToJson(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    passenger: row.passenger_id ? {
      id: row.passenger_id,
      name: row.passenger_name,
      rating: row.passenger_rating,
    } : undefined,
    driver: row.driver_id ? {
      id: row.driver_id,
      name: row.driver_name,
      plate: row.driver_plate,
      carModel: row.driver_car_model,
      rating: row.driver_rating,
      currentLat: row.driver_lat,
      currentLng: row.driver_lng,
      isVvip: !!row.driver_is_vvip,
    } : undefined,
    pickup: {
      name: row.pickup_name,
      lat: row.pickup_lat,
      lng: row.pickup_lng,
    },
    destination: {
      name: row.destination_name,
      lat: row.destination_lat,
      lng: row.destination_lng,
    },
    carType: row.car_type,
    carModel: row.car_model || undefined,
    passengerNotes: row.passenger_notes ? JSON.parse(row.passenger_notes) : undefined,
    hasDiscount: !!row.has_discount,
    tipAmount: row.tip_amount || 0,
    estimatedFare: row.estimated_fare,
    actualFare: row.actual_fare,
    paymentMethod: row.payment_method,
    distanceKm: row.distance_km,
    etaMinutes: row.eta_minutes,
    passengerLat: row.passenger_lat,
    passengerLng: row.passenger_lng,
    taxiType: row.taxi_type,
    driverRating: row.driver_rating,
    passengerRating: row.passenger_rating,
    // 司機出貨單（v3）
    createdByDriver: !!row.created_by_driver,
    driverPostedFrom: row.driver_posted_from,
    passengerPhone: row.passenger_phone,
    teishoku: !!row.teishoku,
    teishokuPrice: row.teishoku_price,
    isDirect: row.is_direct || 'standard',
    // VVIP 分級派單
    dispatchPhase: row.dispatch_phase ?? 0,
    dispatchPhaseStartedAt: row.dispatch_phase_started_at,
    dispatchUnlockedAt: row.dispatch_unlocked_at,
    createdAt: row.created_at,
    acceptedAt: row.accepted_at,
    pickedUpAt: row.picked_up_at,
    completedAt: row.completed_at,
    paidAt: row.paid_at,
    finishedAt: row.finished_at,
  };
}

function getOrderById(id) {
  const row = db.prepare(`
    SELECT o.*,
           p.name as passenger_name, p.rating as passenger_rating,
           d.name as driver_name, d.plate as driver_plate,
           d.car_model as driver_car_model, d.rating as driver_rating,
           d.is_vvip as driver_is_vvip
    FROM orders o
    LEFT JOIN passengers p ON o.passenger_id = p.id
    LEFT JOIN drivers d ON o.driver_id = d.id
    WHERE o.id = ?
  `).get(id);
  return orderToJson(row);
}

// ========== 乘客叫車 ==========
router.post('/passenger/request', authPassenger, (req, res) => {
  const { 
    pickup, destination, carType, hasDiscount, tipAmount, estimatedFare, distanceKm, etaMinutes, taxiType,
    pickupName, pickupLat, pickupLng, destinationName, destinationLat, destinationLng,
    discount, tip, carModel, passengerNotes
  } = req.body;

  // Support both flat and nested formats
  const pickupObj = pickup || { name: pickupName, lat: pickupLat, lng: pickupLng };
  const destObj = destination || { name: destinationName, lat: destinationLat, lng: destinationLng };
  const hasDiscountVal = hasDiscount !== undefined ? hasDiscount : (discount === true);
  const tipVal = tipAmount !== undefined ? tipAmount : (tip || 0);

  if (!pickupObj || !destObj || !estimatedFare) {
    return res.status(400).json({ error: '參數唔完整' });
  }

  // 檢查乘客有冇進行中訂單（已完成嘅單唔算，可以再出單）
  const active = db.prepare(`SELECT id FROM orders
    WHERE passenger_id = ? AND status IN ('searching','accepted','picked_up','paid')`).get(req.userId);
  if (active) {
    return res.status(400).json({ error: '你有進行中嘅訂單，請先完成' });
  }

  const id = genOrderId();
  const now = Date.now();
  const pLat = pickupObj.lat ?? 22.3;
  const pLng = pickupObj.lng ?? 114.17;

  db.prepare(`INSERT INTO orders (
    id, status, passenger_id,
    pickup_name, pickup_lat, pickup_lng,
    destination_name, destination_lat, destination_lng,
    car_type, car_model, passenger_notes, has_discount, tip_amount, estimated_fare,
    distance_km, eta_minutes,
    passenger_lat, passenger_lng,
    taxi_type, dispatch_phase, dispatch_phase_started_at, created_at,
    passenger_phone
  ) VALUES (?, 'searching', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`).run(
    id, req.userId,
    pickupObj.name || '上車點', pLat, pLng,
    destObj.name || '目的地', destObj.lat, destObj.lng,
    carType || '4pax', carModel || null, passengerNotes ? JSON.stringify(passengerNotes) : null,
    hasDiscountVal ? 1 : 0, tipVal || 0, estimatedFare,
    distanceKm || null, etaMinutes || null,
    pLat, pLng,
    taxiType || 'red', now, now,
    req.user.phone || null
  );

  const order = getOrderById(id);

  // VVIP 分級派單：首先推送到所有在線 VVIP 司機
  // 普通司機要等 dispatch phase 升級先睇到（由前端顯示倒數 + 定時輪詢升級）
  const vvipDrivers = db.prepare(
    "SELECT id FROM drivers WHERE is_vvip = 1 AND online = 1 AND status = 'approved'"
  ).all();
  vvipDrivers.forEach(d => {
    sseHub.publishToDriver(d.id, 'new-vvip-order', { order });
  });

  // 同時推送到大廳（但大廳接口會過濾，普通司機睇唔到 phase 0 嘅單）
  sseHub.publishToDriverHall('new-order', { order });

  res.json({ order });
});

// ========== 乘客取消叫車 ==========
router.post('/passenger/cancel', authPassenger, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE passenger_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1').get(req.userId, 'searching');
  if (!order) return res.status(400).json({ error: '冇可取消嘅訂單' });

  db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(order.id);

  sseHub.publishToOrder(order.id, 'order-cancelled', { orderId: order.id });
  sseHub.publishToDriverHall('order-cancelled', { orderId: order.id });

  res.json({ ok: true });
});

// ========== 乘客當前訂單 ==========
router.get('/passenger/current', authPassenger, (req, res) => {
  const row = db.prepare(`
    SELECT o.*,
           p.name as passenger_name, p.rating as passenger_rating,
           d.name as driver_name, d.plate as driver_plate,
           d.car_model as driver_car_model, d.rating as driver_rating,
           d.is_vvip as driver_is_vvip
    FROM orders o
    LEFT JOIN passengers p ON o.passenger_id = p.id
    LEFT JOIN drivers d ON o.driver_id = d.id
    WHERE o.passenger_id = ? AND o.status IN ('searching','accepted','picked_up','completed','paid')
    ORDER BY o.created_at DESC
    LIMIT 1
  `).get(req.userId);
  res.json({ order: orderToJson(row) || null });
});

// ========== 乘客歷史訂單 ==========
router.get('/passenger/history', authPassenger, (req, res) => {
  const rows = db.prepare(`
    SELECT o.*,
           p.name as passenger_name, p.rating as passenger_rating,
           d.name as driver_name, d.plate as driver_plate,
           d.car_model as driver_car_model, d.rating as driver_rating,
           d.is_vvip as driver_is_vvip
    FROM orders o
    LEFT JOIN passengers p ON o.passenger_id = p.id
    LEFT JOIN drivers d ON o.driver_id = d.id
    WHERE o.passenger_id = ? AND o.status IN ('paid','finished')
    ORDER BY o.created_at DESC
    LIMIT 20
  `).all(req.userId);
  res.json({ orders: rows.map(orderToJson) });
});

// ========== 乘客評分司機 ==========
router.post('/passenger/rate', authPassenger, (req, res) => {
  const { orderId, rating } = req.body;
  if (!orderId || !rating) return res.status(400).json({ error: '參數唔完整' });

  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND passenger_id = ?').get(orderId, req.userId);
  if (!order) return res.status(404).json({ error: '訂單唔存在' });

  db.prepare('UPDATE orders SET driver_rating = ? WHERE id = ?').run(rating, orderId);

  // 更新司機平均分
  if (order.driver_id) {
    const d = db.prepare('SELECT rating, rating_count FROM drivers WHERE id = ?').get(order.driver_id);
    if (d) {
      const newCount = d.rating_count + 1;
      const newRating = ((d.rating * d.rating_count) + rating) / newCount;
      db.prepare('UPDATE drivers SET rating = ?, rating_count = ? WHERE id = ?').run(
        Math.round(newRating * 10) / 10, newCount, order.driver_id
      );
    }
  }

  // 檢查係咪雙方都評分咗
  const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (updated.passenger_rating) {
    db.prepare("UPDATE orders SET status = 'finished', finished_at = ? WHERE id = ?").run(Date.now(), orderId);
  }

  sseHub.publishToOrder(orderId, 'driver-rated', { orderId, rating });

  res.json({ ok: true });
});

// ========== 計算兩點距離（km，簡化球面距離） ==========
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ========== 分級派單：檢查並升級 dispatch_phase ==========
// Phase 0 = VVIP 專屬（首 10 秒）
// Phase 1 = 3 公里內司機（10-30 秒）
// Phase 2 = 5 公里內司機（30-60 秒）
// Phase 3 = 全港開放（60 秒後；範圍 999 = 無限制，跨區都接到）
const DISPATCH_PHASE_DURATIONS = [10000, 20000, 30000, 540000]; // 每階段持續時間
const DISPATCH_PHASE_RANGES = [0, 3, 5, 999]; // 每階段可見距離（km），0 = 無限（VVIP 唔計距離），999 = 全港開放

// 司機拒單記錄表：拒咗嘅單唔會再派俾同一司機
db.prepare(`CREATE TABLE IF NOT EXISTS order_rejections (
  order_id TEXT NOT NULL,
  driver_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (order_id, driver_id)
)`).run();

function refreshDispatchPhases() {
  const now = Date.now();
  const orders = db.prepare("SELECT id, dispatch_phase, dispatch_phase_started_at FROM orders WHERE status = 'searching'").all();
  for (const o of orders) {
    let phase = o.dispatch_phase || 0;
    let phaseStart = o.dispatch_phase_started_at || o.created_at;
    let elapsed = now - phaseStart;

    // 逐級升級
    while (phase < DISPATCH_PHASE_DURATIONS.length - 1 && elapsed >= DISPATCH_PHASE_DURATIONS[phase]) {
      elapsed -= DISPATCH_PHASE_DURATIONS[phase];
      phase += 1;
      phaseStart = phaseStart + DISPATCH_PHASE_DURATIONS[phase - 1];
    }

    if (phase !== (o.dispatch_phase || 0)) {
      db.prepare('UPDATE orders SET dispatch_phase = ?, dispatch_phase_started_at = ? WHERE id = ?').run(
        phase, phaseStart, o.id
      );
      // 推送新階段通知
      sseHub.publishToDriverHall('dispatch-phase-updated', {
        orderId: o.id,
        newPhase: phase,
        rangeKm: DISPATCH_PHASE_RANGES[phase],
      });
    }
  }
}

// 每秒鐘刷新一次派單階段
setInterval(refreshDispatchPhases, 1000);

// ========== 司機出貨（發佈訂單俾其他司機接）==========
router.post('/driver/post', authDriver, (req, res) => {
  const {
    pickup, destination, carType, carModel, estimatedFare, taxiType,
    isDirect, tip, dispatchPhase, teishokuPrice, passengerPhone, distanceKm, etaMinutes,
  } = req.body || {};

  const pickupObj = pickup || {};
  const destObj = destination || {};
  if (!pickupObj || !destObj || !estimatedFare) {
    return res.status(400).json({ error: '參數唔完整' });
  }

  const id = genOrderId();
  const now = Date.now();
  const pLat = pickupObj.lat ?? 22.3;
  const pLng = pickupObj.lng ?? 114.17;
  const dLat = destObj.lat ?? 22.28;
  const dLng = destObj.lng ?? 114.16;

  // passenger_id 用通用值（出貨單冇真實乘客）
  db.prepare(`INSERT INTO orders (
    id, status, passenger_id,
    pickup_name, pickup_lat, pickup_lng,
    destination_name, destination_lat, destination_lng,
    car_type, car_model, passenger_notes, has_discount, tip_amount, estimated_fare,
    distance_km, eta_minutes,
    passenger_lat, passenger_lng,
    taxi_type, dispatch_phase, dispatch_phase_started_at, created_at,
    created_by_driver, driver_posted_from, passenger_phone, teishoku, teishoku_price, is_direct
  ) VALUES (?, 'searching', 'driver_post', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id,
    pickupObj.name || '上車點', pLat, pLng,
    destObj.name || '目的地', dLat, dLng,
    carType || '4pax', carModel || null, null,
    (isDirect === 'discount85') ? 1 : 0, tip || 0, estimatedFare,
    distanceKm || null, etaMinutes || null,
    pLat, pLng,
    taxiType || 'red', dispatchPhase ?? 3, now, now,
    1, req.userId, passengerPhone || null,
    (isDirect === 'teishoku') ? 1 : 0, teishokuPrice || null, isDirect || 'standard'
  );

  const order = getOrderById(id);
  res.json({ order });
});

// ========== 司機取消自己出貨單 ==========
router.post('/driver/cancel-post/:orderId', authDriver, (req, res) => {
  const row = db.prepare("SELECT id FROM orders WHERE id = ? AND created_by_driver = 1 AND driver_posted_from = ? AND status = 'searching'")
    .get(req.params.orderId, req.userId);
  if (!row) {
    return res.status(404).json({ error: '搵唔到呢張出貨單，或者唔係你出嘅' });
  }
  db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(req.params.orderId);
  res.json({ ok: true });
});

// ========== 司機接單大廳列表 ==========
router.get('/driver/hall', authDriver, (req, res) => {
  // 淨係俾 approved 同 online 嘅司機睇
  const driver = db.prepare('SELECT status, online, is_vvip, current_lat, current_lng FROM drivers WHERE id = ?').get(req.userId);
  if (!driver || driver.status !== 'approved') {
    return res.json({ orders: [] });
  }
  if (!driver.online) {
    return res.json({ orders: [] });
  }

  // 刷新派單階段（保證數據最新）
  refreshDispatchPhases();

  // 24 小時後自動刪除過期單（淨係清 searching 未接嘅單；已接/進行中單唔會刪）
  const expireBefore = Date.now() - 24 * 60 * 60 * 1000;
  db.prepare(`DELETE FROM orders WHERE status = 'searching' AND created_at < ?`).run(expireBefore);

  const driverLat = driver.current_lat || 22.3;
  const driverLng = driver.current_lng || 114.17;
  const isVvip = !!driver.is_vvip;

  const rows = db.prepare(`
    SELECT o.*,
           p.name as passenger_name, p.rating as passenger_rating, p.phone as passenger_phone,
           d.name as driver_name, d.plate as driver_plate,
           d.car_model as driver_car_model, d.rating as driver_rating,
           d.is_vvip as driver_is_vvip
    FROM orders o
    LEFT JOIN passengers p ON o.passenger_id = p.id
    LEFT JOIN drivers d ON o.driver_id = d.id
    WHERE o.status = 'searching' AND o.created_at > ?
    ORDER BY o.created_at DESC
    LIMIT 20
  `).all(expireBefore);

  // 按派單階段 + 司機等級過濾
  const now = Date.now();
  const filtered = rows.filter(row => {
    const phase = row.dispatch_phase || 0;

    // 司機出貨單：公共單，所有 approved+online 司機都見到（跨區都接到）
    if (row.created_by_driver) return true;

    // 拒單記錄：呢位司機拒過嘅單唔會再派俾佢
    const rejected = db.prepare('SELECT 1 FROM order_rejections WHERE order_id = ? AND driver_id = ?')
      .get(row.id, req.userId);
    if (rejected) return false;

    // VVIP 司機：所有階段嘅單都睇到
    if (isVvip) return true;

    // 普通司機：phase 0 (VVIP 專屬) 睇唔到
    if (phase === 0) return false;

    // 計算距離，驗證係咪喺該階段範圍內
    const rangeKm = DISPATCH_PHASE_RANGES[phase] || 999;
    const dist = haversineKm(driverLat, driverLng, row.pickup_lat, row.pickup_lng);
    return dist <= rangeKm;
  });

  res.json({
    orders: filtered.map(orderToJson),
    driverIsVvip: isVvip,
    phaseRanges: DISPATCH_PHASE_RANGES,
    phaseDurations: DISPATCH_PHASE_DURATIONS,
  });
});

// ========== 司機接單 ==========
router.post('/driver/accept/:orderId', authDriver, (req, res) => {
  const { orderId } = req.params;
  const driver = db.prepare('SELECT * FROM drivers WHERE id = ?').get(req.userId);

  if (!driver || driver.status !== 'approved') {
    return res.status(400).json({ error: '你嘅帳號未審批，唔可以接單' });
  }
  if (!driver.online) {
    return res.status(400).json({ error: '請先上線先可以接單' });
  }

  // 檢查司機有冇進行中訂單（已完成嘅單唔算）
  const active = db.prepare(`SELECT id FROM orders
    WHERE driver_id = ? AND status IN ('accepted','picked_up','paid')`).get(req.userId);
  if (active) {
    return res.status(400).json({ error: '你有進行中嘅訂單' });
  }

  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND status = ?').get(orderId, 'searching');
  if (!order) {
    return res.status(400).json({ error: '訂單已經俾人接咗或者取消咗' });
  }

  const now = Date.now();
  const driverLat = driver.current_lat || order.pickup_lat + 0.01;
  const driverLng = driver.current_lng || order.pickup_lng + 0.01;

  db.prepare(`UPDATE orders SET
    status = 'accepted', driver_id = ?, accepted_at = ?,
    driver_lat = ?, driver_lng = ?
    WHERE id = ? AND status = 'searching'`).run(req.userId, now, driverLat, driverLng, orderId);

  const updated = getOrderById(orderId);

  sseHub.publishToOrder(orderId, 'order-accepted', { order: updated });
  sseHub.publishToDriverHall('order-taken', { orderId, driverId: req.userId });

  res.json({ order: updated });
});

// ========== 司機取消當前單（放棄單，釋放可再接） ==========
router.post('/driver/cancel-current', authDriver, (req, res) => {
  const order = db.prepare(`SELECT * FROM orders
    WHERE driver_id = ? AND status IN ('accepted','picked_up')
    ORDER BY created_at DESC LIMIT 1`).get(req.userId);
  if (!order) return res.status(400).json({ error: '冇可取消嘅進行中訂單' });

  db.prepare("UPDATE orders SET status = 'cancelled', finished_at = ? WHERE id = ?").run(Date.now(), order.id);
  const updated = getOrderById(order.id);

  sseHub.publishToOrder(order.id, 'order-cancelled', { order: updated });
  sseHub.publishToDriverHall('order-cancelled', { orderId: order.id });

  res.json({ ok: true, order: updated });
});

// ========== 司機拒單 ==========
router.post('/driver/reject/:orderId', authDriver, (req, res) => {
  // 記錄拒單：呢位司機之後唔會再見到呢張單（同一單唔會無限彈返出嚟）
  db.prepare('INSERT OR IGNORE INTO order_rejections (order_id, driver_id, created_at) VALUES (?, ?, ?)')
    .run(req.params.orderId, req.userId, Date.now());

  // 通知該司機端：確認已拒單，可即時收起浮動卡／列表項
  sseHub.publishToDriver(req.userId, 'order-rejected-confirmed', { orderId: req.params.orderId });

  res.json({ ok: true });
});

// ========== 司機當前訂單 ==========
router.get('/driver/current', authDriver, (req, res) => {
  const row = db.prepare(`
    SELECT o.*,
           p.name as passenger_name, p.rating as passenger_rating,
           d.name as driver_name, d.plate as driver_plate,
           d.car_model as driver_car_model, d.rating as driver_rating,
           d.is_vvip as driver_is_vvip
    FROM orders o
    LEFT JOIN passengers p ON o.passenger_id = p.id
    LEFT JOIN drivers d ON o.driver_id = d.id
    WHERE o.driver_id = ? AND o.status IN ('accepted','picked_up','completed','paid')
    ORDER BY o.created_at DESC
    LIMIT 1
  `).get(req.userId);
  res.json({ order: orderToJson(row) || null });
});

// ========== 司機訂單記錄（歷史單，可以睇返上一張＋打返俾乘客） ==========
router.get('/driver/history', authDriver, (req, res) => {
  const rows = db.prepare(`
    SELECT o.*,
           p.name as passenger_name, p.rating as passenger_rating,
           d.name as driver_name, d.plate as driver_plate,
           d.car_model as driver_car_model, d.rating as driver_rating,
           d.is_vvip as driver_is_vvip
    FROM orders o
    LEFT JOIN passengers p ON o.passenger_id = p.id
    LEFT JOIN drivers d ON o.driver_id = d.id
    WHERE o.driver_id = ?
    ORDER BY o.created_at DESC
    LIMIT 60
  `).all(req.userId);
  res.json({ orders: rows.map(orderToJson) });
});

// ========== 司機到達上車點 ==========
router.post('/driver/arrive-pickup', authDriver, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE driver_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1').get(req.userId, 'accepted');
  if (!order) return res.status(400).json({ error: '冇進行中嘅接單' });

  db.prepare("UPDATE orders SET status = 'picked_up', picked_up_at = ? WHERE id = ?").run(Date.now(), order.id);
  const updated = getOrderById(order.id);

  sseHub.publishToOrder(order.id, 'order-picked-up', { order: updated });
  res.json({ order: updated });
});

// ========== 司機到達目的地 ==========
router.post('/driver/complete', authDriver, (req, res) => {
  const { actualFare } = req.body;
  const order = db.prepare('SELECT * FROM orders WHERE driver_id = ? AND status IN (?, ?) ORDER BY created_at DESC LIMIT 1').get(req.userId, 'picked_up', 'accepted');
  if (!order) return res.status(400).json({ error: '冇進行中嘅行程' });

  const fare = actualFare ?? order.estimated_fare;
  db.prepare("UPDATE orders SET status = 'completed', actual_fare = ?, completed_at = ? WHERE id = ?").run(fare, Date.now(), order.id);
  const updated = getOrderById(order.id);

  sseHub.publishToOrder(order.id, 'order-completed', { order: updated });
  res.json({ order: updated });
});

// ========== 司機收入記錄 ==========
router.get('/driver/earnings', authDriver, (req, res) => {
  const rows = db.prepare(`
    SELECT o.*,
           p.name as passenger_name, p.rating as passenger_rating,
           d.name as driver_name, d.plate as driver_plate,
           d.car_model as driver_car_model, d.rating as driver_rating,
           d.is_vvip as driver_is_vvip
    FROM orders o
    LEFT JOIN passengers p ON o.passenger_id = p.id
    LEFT JOIN drivers d ON o.driver_id = d.id
    WHERE o.driver_id = ? AND o.status IN ('paid','finished','completed')
    ORDER BY o.created_at DESC
    LIMIT 30
  `).all(req.userId);
  res.json({ orders: rows.map(orderToJson) });
});

// ========== 司機評分乘客 ==========
router.post('/driver/rate', authDriver, (req, res) => {
  const { orderId, rating } = req.body;
  if (!orderId || !rating) return res.status(400).json({ error: '參數唔完整' });

  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND driver_id = ?').get(orderId, req.userId);
  if (!order) return res.status(404).json({ error: '訂單唔存在' });

  db.prepare('UPDATE orders SET passenger_rating = ? WHERE id = ?').run(rating, orderId);

  // 更新乘客平均分
  if (order.passenger_id) {
    const p = db.prepare('SELECT rating, rating_count FROM passengers WHERE id = ?').get(order.passenger_id);
    if (p) {
      const newCount = p.rating_count + 1;
      const newRating = ((p.rating * p.rating_count) + rating) / newCount;
      db.prepare('UPDATE passengers SET rating = ?, rating_count = ? WHERE id = ?').run(
        Math.round(newRating * 10) / 10, newCount, order.passenger_id
      );
    }
  }

  // 檢查雙方評分
  const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (updated.driver_rating) {
    db.prepare("UPDATE orders SET status = 'finished', finished_at = ? WHERE id = ?").run(Date.now(), orderId);
  }

  sseHub.publishToOrder(orderId, 'passenger-rated', { orderId, rating });

  res.json({ ok: true });
});

// ========== 司機上線/落線 ==========
router.post('/driver/online', authDriver, (req, res) => {
  const { online, lat, lng } = req.body;
  const now = Date.now();
  db.prepare('UPDATE drivers SET online = ?, current_lat = ?, current_lng = ?, last_seen = ? WHERE id = ?').run(
    online ? 1 : 0, lat || null, lng || null, online ? now : 0, req.userId
  );
  res.json({ online: !!online, lastSeen: online ? now : 0 });
});

// ========== 司機心跳（維持在線狀態，淨更新 last_seen，唔掂座標） ==========
router.post('/driver/heartbeat', authDriver, (req, res) => {
  const now = Date.now();
  db.prepare('UPDATE drivers SET last_seen = ? WHERE id = ? AND online = 1').run(now, req.userId);
  res.json({ ok: true, lastSeen: now });
});

// ========== 附近在線司機（真實數字，畀乘客叫車頁用） ==========
router.get('/driver/nearby', (req, res) => {
  const { lat, lng, radius = 12 } = req.query;
  const rows = db.prepare(
    "SELECT id, name, plate, current_lat, current_lng FROM drivers WHERE online = 1 AND status = 'approved' AND current_lat IS NOT NULL AND current_lng IS NOT NULL"
  ).all();
  let list = rows;
  if (lat && lng) {
    const pLat = Number(lat);
    const pLng = Number(lng);
    const R = 6371;
    const maxD = Number(radius);
    const distOf = (r) => {
      const dLat = (r.current_lat - pLat) * Math.PI / 180;
      const dLng = (r.current_lng - pLng) * Math.PI / 180;
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(pLat * Math.PI / 180) * Math.cos(r.current_lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    };
    list = rows
      .map((r) => ({ ...r, distance: Math.round(distOf(r) * 10) / 10 }))
      .filter((r) => r.distance <= maxD);
  }
  res.json({ count: list.length, drivers: list });
});

// ========== 更新位置 ==========
router.post('/driver/location', authDriver, (req, res) => {
  const { lat, lng, orderId } = req.body;
  if (lat == null || lng == null) return res.status(400).json({ error: '位置參數唔完整' });

  db.prepare('UPDATE drivers SET current_lat = ?, current_lng = ? WHERE id = ?').run(lat, lng, req.userId);

  if (orderId) {
    db.prepare('UPDATE orders SET driver_lat = ?, driver_lng = ? WHERE id = ? AND driver_id = ?').run(
      lat, lng, orderId, req.userId
    );
    sseHub.publishToOrder(orderId, 'driver-location', { lat, lng, orderId });
  }

  res.json({ ok: true });
});

router.post('/passenger/location', authPassenger, (req, res) => {
  const { lat, lng, orderId } = req.body;
  if (lat == null || lng == null || !orderId) return res.status(400).json({ error: '參數唔完整' });

  db.prepare('UPDATE orders SET passenger_lat = ?, passenger_lng = ? WHERE id = ? AND passenger_id = ?').run(
    lat, lng, orderId, req.userId
  );
  sseHub.publishToOrder(orderId, 'passenger-location', { lat, lng, orderId });

  res.json({ ok: true });
});

// ========== 付款 ==========
router.post('/passenger/pay', authPassenger, (req, res) => {
  const { method, orderId } = req.body;
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND passenger_id = ? AND status = ?').get(orderId || '', req.userId, 'completed');
  if (!order) return res.status(400).json({ error: '冇待付款嘅訂單' });

  const now = Date.now();
  db.prepare("UPDATE orders SET status = 'paid', payment_method = ?, paid_at = ? WHERE id = ?").run(
    method || 'cash', now, order.id
  );
  const updated = getOrderById(order.id);

  sseHub.publishToOrder(order.id, 'order-paid', { order: updated });
  sseHub.publishToAdmin('order-paid', { order: updated });

  res.json({ order: updated });
});

// ========== 香港地區反查（粗略，按最近區中心） ==========
const DISTRICT_CENTERS = [
  { name: '中西區', lat: 22.282, lng: 114.154 },
  { name: '灣仔', lat: 22.277, lng: 114.176 },
  { name: '東區', lat: 22.28, lng: 114.218 },
  { name: '南區', lat: 22.247, lng: 114.16 },
  { name: '油尖旺', lat: 22.319, lng: 114.172 },
  { name: '深水埗', lat: 22.331, lng: 114.162 },
  { name: '九龍城', lat: 22.328, lng: 114.187 },
  { name: '黃大仙', lat: 22.345, lng: 114.199 },
  { name: '觀塘', lat: 22.314, lng: 114.226 },
  { name: '荃灣', lat: 22.371, lng: 114.111 },
  { name: '葵青', lat: 22.357, lng: 114.13 },
  { name: '屯門', lat: 22.391, lng: 113.977 },
  { name: '元朗', lat: 22.443, lng: 114.03 },
  { name: '北區', lat: 22.495, lng: 114.138 },
  { name: '大埔', lat: 22.445, lng: 114.171 },
  { name: '西貢', lat: 22.382, lng: 114.27 },
  { name: '沙田', lat: 22.384, lng: 114.191 },
  { name: '離島', lat: 22.267, lng: 113.947 },
];

function districtOf(lat, lng) {
  let best = '香港';
  let bestDist = Infinity;
  for (const d of DISTRICT_CENTERS) {
    const dist = (lat - d.lat) ** 2 + (lng - d.lng) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = d.name;
    }
  }
  return best;
}

// OSM reverse geocode 攞街名（失敗就淨係顯示地區）
async function reverseGeocodeStreet(lat, lng) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18`,
      { headers: { 'User-Agent': 'dikdou-taxi-app/1.0' }, signal: ctrl.signal }
    );
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    const road = data?.address?.road;
    const suburb = data?.address?.suburb || data?.address?.town || data?.address?.city_district;
    return [road, suburb].filter(Boolean).join('，') || null;
  } catch {
    return null;
  }
}

// ========== 司機報告位置大水 ==========
router.post('/driver/report-flood', authDriver, async (req, res) => {
  const driver = db.prepare('SELECT * FROM drivers WHERE id = ?').get(req.userId);
  if (!driver) return res.status(404).json({ error: '司機唔存在' });

  const now = Date.now();
  const COOLDOWN = 10 * 60 * 1000;
  if (driver.last_flood_report_at && now - driver.last_flood_report_at < COOLDOWN) {
    const remainMs = COOLDOWN - (now - driver.last_flood_report_at);
    const remainMin = Math.ceil(remainMs / 60000);
    return res.status(429).json({ error: `10 分鐘內已報告過，${remainMin} 分鐘後先可以再報`, cooldownRemainMs: remainMs });
  }

  const lat = typeof req.body?.lat === 'number' ? req.body.lat : driver.current_lat;
  const lng = typeof req.body?.lng === 'number' ? req.body.lng : driver.current_lng;

  // 攞唔到位置都照樣報警（緊急功能唔應該因為冇 GPS 而報唔到），地區會顯示「位置未知」
  let district = null;
  let street = null;
  if (typeof lat === 'number' && typeof lng === 'number') {
    district = districtOf(lat, lng);
    street = await reverseGeocodeStreet(lat, lng).catch(() => null);
  }

  const id = 'FL' + Math.random().toString(36).slice(2, 8).toUpperCase() + Date.now().toString().slice(-4);
  db.prepare(
    'INSERT INTO flood_reports (id, driver_id, driver_name, lat, lng, district, street, created_at) VALUES (?,?,?,?,?,?,?,?)'
  ).run(id, driver.id, driver.name, typeof lat === 'number' ? lat : null, typeof lng === 'number' ? lng : null, district, street, now);
  db.prepare('UPDATE drivers SET last_flood_report_at = ? WHERE id = ?').run(now, driver.id);

  const alert = { id, driverName: driver.name, district, street, lat: typeof lat === 'number' ? lat : null, lng: typeof lng === 'number' ? lng : null, createdAt: now };

  // 推畀所有司機接貨畫面（司機之間互通警報）
  sseHub.publishToDriverHall('flood-alert', alert);
  sseHub.publishToAdmin('flood-alert', alert);

  res.json({ ok: true, alert });
});

// ========== 訂單詳情 ==========
router.get('/:id', (req, res) => {
  const order = getOrderById(req.params.id);
  if (!order) return res.status(404).json({ error: '訂單唔存在' });
  res.json({ order });
});

// ========== SSE 訂閱 ==========
router.get('/stream/order/:orderId', (req, res) => {
  // 乘客同司機都可以睇，唔做嚴格驗證，認 orderId 就夠
  const { orderId } = req.params;
  sseHub.subscribe(req, res, 'order', orderId);
});

router.get('/stream/driver-hall', authDriver, (req, res) => {
  sseHub.subscribe(req, res, 'driver-hall', null);
});

router.get('/stream/driver', authDriver, (req, res) => {
  sseHub.subscribe(req, res, 'driver', req.userId);
});

module.exports = router;
