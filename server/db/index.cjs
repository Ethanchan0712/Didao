const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

// DB_PATH 支援環境變數：Render 持久磁碟（/app/data）或者默認本地
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'taxi.db');
const fs = require('fs');
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000'); // 高並發寫入時等 5 秒先報鎖死，避免「database is locked」

// ========== Schema ==========
db.exec(`
CREATE TABLE IF NOT EXISTS passengers (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  phone TEXT UNIQUE,
  password TEXT NOT NULL,
  name TEXT,
  avatar TEXT,
  rating REAL DEFAULT 5,
  rating_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- 司機出貨單嘅通用乘客佔位（唔係真實乘客，只係滿足外鍵）
INSERT OR IGNORE INTO passengers (id, username, phone, password, name, created_at)
VALUES ('driver_post', 'driver_post', '0000000000', 'x', '出貨', 0);

CREATE TABLE IF NOT EXISTS drivers (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  phone TEXT UNIQUE,
  password TEXT NOT NULL,
  name TEXT,
  avatar TEXT,
  plate TEXT,
  car_model TEXT,
  driver_license TEXT,
  id_front4 TEXT,                     -- 身份証頭4位數字（司機註冊填寫）
  rating REAL DEFAULT 5,
  rating_count INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending', -- pending / approved / rejected
  reject_reason TEXT,
  online INTEGER DEFAULT 0,
  current_lat REAL,
  current_lng REAL,
  is_vvip INTEGER DEFAULT 0,          -- 0=普通, 1=VVIP
  vvip_expires_at INTEGER,             -- 皇牌到期時間戳（NULL=永久）
  vvip_applied INTEGER DEFAULT 0,     -- 0=未申請, 1=已申請待審批
  vvip_requested_at INTEGER,          -- 申請時間
  is_vip INTEGER DEFAULT 0,           -- 0=普通, 1=VIP會員
  vip_expires_at INTEGER,             -- VIP 到期時間戳（NULL=永久）
  referrer_phone TEXT,                -- 介紹人（已開通司機）嘅電話號碼（會員號碼）
  created_at INTEGER NOT NULL,
  approved_at INTEGER
);

CREATE TABLE IF NOT EXISTS admins (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'searching',
  passenger_id TEXT NOT NULL,
  driver_id TEXT,
  pickup_name TEXT NOT NULL,
  pickup_lat REAL NOT NULL,
  pickup_lng REAL NOT NULL,
  destination_name TEXT NOT NULL,
  destination_lat REAL NOT NULL,
  destination_lng REAL NOT NULL,
  car_type TEXT NOT NULL DEFAULT '4pax',
  car_model TEXT,
  passenger_notes TEXT,
  has_discount INTEGER DEFAULT 0,
  tip_amount REAL DEFAULT 0,
  estimated_fare REAL NOT NULL,
  actual_fare REAL,
  payment_method TEXT,
  distance_km REAL,
  eta_minutes INTEGER,
  driver_lat REAL,
  driver_lng REAL,
  passenger_lat REAL,
  passenger_lng REAL,
  taxi_type TEXT DEFAULT 'red',
  driver_rating INTEGER,
  passenger_rating INTEGER,
  -- VVIP 分級派單
  dispatch_phase INTEGER DEFAULT 0,   -- 0=VVIP專屬, 1=3公里, 2=5公里, 3=10公里
  dispatch_phase_started_at INTEGER,  -- 當前階段開始時間
  dispatch_unlocked_at INTEGER,       -- 解鎖到普通司機嘅時間
  -- 司機出貨單（v3）
  created_by_driver INTEGER DEFAULT 0,
  driver_posted_from TEXT,
  passenger_phone TEXT,
  teishoku INTEGER DEFAULT 0,
  teishoku_price REAL,
  is_direct TEXT DEFAULT 'standard',
  created_at INTEGER NOT NULL,
  accepted_at INTEGER,
  picked_up_at INTEGER,
  completed_at INTEGER,
  paid_at INTEGER,
  finished_at INTEGER,
  FOREIGN KEY (passenger_id) REFERENCES passengers(id),
  FOREIGN KEY (driver_id) REFERENCES drivers(id)
);

-- 司機出貨單欄位（v3 新增；舊數據庫用 ALTER 補欄）
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  sender_role TEXT NOT NULL, -- passenger / driver
  sender_id TEXT NOT NULL,
  text TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  read_by_other INTEGER DEFAULT 0,
  FOREIGN KEY (order_id) REFERENCES orders(id)
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_passenger ON orders(passenger_id);
CREATE INDEX IF NOT EXISTS idx_orders_driver ON orders(driver_id);
CREATE INDEX IF NOT EXISTS idx_chat_order ON chat_messages(order_id);
CREATE INDEX IF NOT EXISTS idx_drivers_status ON drivers(status);
CREATE INDEX IF NOT EXISTS idx_drivers_vvip ON drivers(is_vvip);
CREATE INDEX IF NOT EXISTS idx_orders_dispatch ON orders(dispatch_phase, status);
`);

// ========== 兼容舊數據庫：補返 v3 新增欄位 ==========
(function migrateOrdersColumns() {
  const cols = db.prepare('PRAGMA table_info(orders)').all().map(c => c.name);
  const add = (name, ddl) => {
    if (!cols.includes(name)) {
      try {
        db.prepare(`ALTER TABLE orders ADD COLUMN ${ddl}`).run();
        console.log(`[DB] orders +${name}`);
      } catch (e) {
        console.warn(`[DB] skip ${name}:`, e.message);
      }
    }
  };
  add('created_by_driver', 'created_by_driver INTEGER DEFAULT 0');
  add('driver_posted_from', 'driver_posted_from TEXT');
  add('passenger_phone', 'passenger_phone TEXT');
  add('teishoku', 'teishoku INTEGER DEFAULT 0');
  add('teishoku_price', 'teishoku_price REAL');
  add('is_direct', 'is_direct TEXT DEFAULT \'standard\'');
})();

// ========== 兼容舊數據庫：drivers 補 id_front4 ==========
(function migrateDriversColumns() {
  const cols = db.prepare('PRAGMA table_info(drivers)').all().map(c => c.name);
  if (!cols.includes('id_front4')) {
    try {
      db.prepare('ALTER TABLE drivers ADD COLUMN id_front4 TEXT').run();
      console.log('[DB] drivers +id_front4');
    } catch (e) {
      console.warn('[DB] skip id_front4:', e.message);
    }
  }
  if (!cols.includes('last_flood_report_at')) {
    try {
      db.prepare('ALTER TABLE drivers ADD COLUMN last_flood_report_at INTEGER').run();
      console.log('[DB] drivers +last_flood_report_at');
    } catch (e) {
      console.warn('[DB] skip last_flood_report_at:', e.message);
    }
  }
  if (!cols.includes('vvip_expires_at')) {
    try {
      db.prepare('ALTER TABLE drivers ADD COLUMN vvip_expires_at INTEGER').run();
      console.log('[DB] drivers +vvip_expires_at');
    } catch (e) {
      console.warn('[DB] skip vvip_expires_at:', e.message);
    }
  }
  if (!cols.includes('last_seen')) {
    try {
      db.prepare('ALTER TABLE drivers ADD COLUMN last_seen INTEGER').run();
      console.log('[DB] drivers +last_seen');
    } catch (e) {
      console.warn('[DB] skip last_seen:', e.message);
    }
  }
  if (!cols.includes('referrer_phone')) {
    try {
      db.prepare('ALTER TABLE drivers ADD COLUMN referrer_phone TEXT').run();
      console.log('[DB] drivers +referrer_phone');
    } catch (e) {
      console.warn('[DB] skip referrer_phone:', e.message);
    }
  }
  if (!cols.includes('is_vip')) {
    try {
      db.prepare('ALTER TABLE drivers ADD COLUMN is_vip INTEGER DEFAULT 0').run();
      console.log('[DB] drivers +is_vip');
    } catch (e) {
      console.warn('[DB] skip is_vip:', e.message);
    }
  }
  if (!cols.includes('vip_expires_at')) {
    try {
      db.prepare('ALTER TABLE drivers ADD COLUMN vip_expires_at INTEGER').run();
      console.log('[DB] drivers +vip_expires_at');
    } catch (e) {
      console.warn('[DB] skip vip_expires_at:', e.message);
    }
  }
})();

// ========== 水浸警報表 ==========
db.prepare(`CREATE TABLE IF NOT EXISTS flood_reports (
  id TEXT PRIMARY KEY,
  driver_id TEXT,
  driver_name TEXT,
  lat REAL,
  lng REAL,
  district TEXT,
  street TEXT,
  created_at INTEGER
)`).run();
console.log('[DB] flood_reports table ready');

// ========== 租車市場表（出租單俾所有人睇到） ==========
db.exec(`
CREATE TABLE IF NOT EXISTS rental_posts (
  id TEXT PRIMARY KEY,
  taxi_color TEXT NOT NULL,      -- red / green / blue
  car_model TEXT NOT NULL,       -- old_comf / hybrid / ev / mifa7 / vw_van
  shift TEXT NOT NULL,           -- full_day / morning / night / relief_morning / relief_night
  district TEXT NOT NULL,        -- 香港島/九龍/新界東/新界西/大嶼山
  price REAL NOT NULL,
  price_unit TEXT DEFAULT 'day',
  plate TEXT,
  owner_name TEXT,
  owner_phone TEXT,
  year INTEGER,
  seats INTEGER DEFAULT 4,
  note TEXT,
  rating REAL DEFAULT 5,
  rental_count INTEGER DEFAULT 0,
  owner_key TEXT,                -- 發佈人識別（手機/帳號），用嚟判斷「係咪我發佈」
  duration INTEGER,              -- 發佈有效日數（7/14/30/90），NULL=永久
  expires_at INTEGER,            -- 過期時間戳（created_at + duration 天數）
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_rental_district ON rental_posts(district);
CREATE INDEX IF NOT EXISTS idx_rental_created ON rental_posts(created_at);
`);
// migration：舊 DB 冇 duration/expires_at → 補欄位
try {
  const rpCols = db.prepare('PRAGMA table_info(rental_posts)').all().map((c) => c.name);
  if (!rpCols.includes('duration')) {
    db.prepare('ALTER TABLE rental_posts ADD COLUMN duration INTEGER').run();
    console.log('[DB] rental_posts +duration');
  }
  if (!rpCols.includes('expires_at')) {
    db.prepare('ALTER TABLE rental_posts ADD COLUMN expires_at INTEGER').run();
    console.log('[DB] rental_posts +expires_at');
  }
  if (!rpCols.includes('manage_pwd')) {
    db.prepare('ALTER TABLE rental_posts ADD COLUMN manage_pwd TEXT').run();
    console.log('[DB] rental_posts +manage_pwd');
  }
} catch (e) { console.warn('[DB] rental_posts migration skip:', e.message); }
console.log('[DB] rental_posts table ready');

// ========== 人搵車（乘客發佈搭車需求，車主睇到可以聯絡） ==========
db.exec(`
CREATE TABLE IF NOT EXISTS rental_car_requests (
  id TEXT PRIMARY KEY,
  owner_key TEXT,
  pickup_area TEXT,
  time_from TEXT,
  time_to TEXT,
  dates TEXT,
  taxi_color TEXT,
  taxi_type TEXT,
  duration INTEGER,
  contact TEXT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_req_created ON rental_car_requests(created_at);
`);
// 舊 DB migration：補返 contact 欄位（如果表已存在但冇）
try {
  const reqCols = db.prepare('PRAGMA table_info(rental_car_requests)').all().map((c) => c.name);
  if (!reqCols.includes('contact')) {
    db.prepare('ALTER TABLE rental_car_requests ADD COLUMN contact TEXT').run();
    console.log('[DB] rental_car_requests 加咗 contact 欄位');
  }
  if (!reqCols.includes('manage_pwd')) {
    db.prepare('ALTER TABLE rental_car_requests ADD COLUMN manage_pwd TEXT').run();
    console.log('[DB] rental_car_requests +manage_pwd');
  }
} catch (e) { /* ignore */ }
console.log('[DB] rental_car_requests table ready');

// ========== Seed admin + 營運主任 ==========
(function migrateAdminRole() {
  const cols = db.prepare('PRAGMA table_info(admins)').all().map(c => c.name);
  if (!cols.includes('role')) {
    try {
      db.prepare("ALTER TABLE admins ADD COLUMN role TEXT DEFAULT 'admin'").run();
      console.log('[DB] admins +role');
    } catch (e) {
      console.warn('[DB] skip admins.role:', e.message);
    }
  }
})();
const adminCheck = db.prepare('SELECT COUNT(*) as c FROM admins WHERE username = ?');
const { c: adminCount } = adminCheck.get('admin');
if (adminCount === 0) {
  const hash = bcrypt.hashSync('lovevivi815', 10);
  db.prepare('INSERT INTO admins (id, username, password, role, created_at) VALUES (?, ?, ?, ?, ?)').run(
    'admin_001', 'admin', hash, 'admin', Date.now()
  );
  console.log('[DB] Admin seeded: admin / lovevivi815');
}
// 營運主任（operator）——淨係批核，唔可以睇訂單/收入/刪人/開皇牌
const opCheck = db.prepare('SELECT COUNT(*) as c FROM admins WHERE username = ? OR username = ?');
const { c: opCount } = opCheck.get('主任', 'operator1');
if (opCount === 0) {
  const hash = bcrypt.hashSync('55888712', 10);
  db.prepare('INSERT INTO admins (id, username, password, role, created_at) VALUES (?, ?, ?, ?, ?)').run(
    'op_001', '主任', hash, 'operator', Date.now()
  );
  console.log('[DB] 營運主任 seeded: 主任 / 55888712');
}

// ========== Seed 示範司機（方便測試；皇牌 demo123 / 普通 demo456） ==========
const seedDrivers = [
  { id: 'driver_demo123', username: 'demo123', name: '示範皇牌', plate: 'GK9577', car_model: '舊金豐', is_vvip: 1 },
  { id: 'driver_demo456', username: 'demo456', name: '示範普通', plate: 'GK9527', car_model: '混能', is_vvip: 0 },
];
const driverSeedStmt = db.prepare(`
  INSERT OR IGNORE INTO drivers (id, username, phone, password, name, plate, car_model, status, online, is_vvip, vvip_applied, created_at, approved_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, 'approved', 1, ?, 0, ?, ?)
`);
for (const d of seedDrivers) {
  const { c: cnt } = db.prepare('SELECT COUNT(*) as c FROM drivers WHERE username = ?').get(d.username);
  if (cnt === 0) {
    driverSeedStmt.run(d.id, d.username, '9000' + d.username.slice(-3), bcrypt.hashSync('55888712', 10), d.name, d.plate, d.car_model, d.is_vvip, Date.now(), Date.now());
    console.log(`[DB] 示範司機 seeded: ${d.username} / 55888712 (${d.is_vvip ? '皇牌' : '普通'})`);
  }
  // 強制更新示範司機密碼（確保任何部署都係 55888712）
  db.prepare('UPDATE drivers SET password = ? WHERE username = ?').run(bcrypt.hashSync('55888712', 10), d.username);
}

// ========== 過期皇牌自動降級 ==========
// 皇牌有期限（管理員開通時揀 1/3/6/12 個月），到期自動降返普通
function expireVvips() {
  try {
    const now = Date.now();
    const res = db.prepare(
      'UPDATE drivers SET is_vvip = 0 WHERE is_vvip = 1 AND vvip_expires_at IS NOT NULL AND vvip_expires_at <= ?'
    ).run(now);
    if (res.changes > 0) console.log(`[DB] ${res.changes} 個皇牌到期，自動降返普通`);
    return res.changes;
  } catch (e) {
    console.warn('[DB] expireVvips:', e.message);
    return 0;
  }
}
expireVvips();
setInterval(expireVvips, 5 * 60 * 1000).unref?.();
db.expireVvips = expireVvips;

// VIP 會員到期自動清除（試用 10 日，到期降返普通）
function expireVips() {
  try {
    const now = Date.now();
    const res = db.prepare(
      'UPDATE drivers SET is_vip = 0 WHERE is_vip = 1 AND vip_expires_at IS NOT NULL AND vip_expires_at <= ?'
    ).run(now);
    if (res.changes > 0) console.log(`[DB] ${res.changes} 個 VIP 到期，自動降返普通`);
    return res.changes;
  } catch (e) {
    console.warn('[DB] expireVips:', e.message);
    return 0;
  }
}
expireVips();
setInterval(expireVips, 5 * 60 * 1000).unref?.();
db.expireVips = expireVips;

module.exports = db;
