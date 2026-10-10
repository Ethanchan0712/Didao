const jwt = require('jsonwebtoken');
const db = require('../db/index.cjs');

const JWT_SECRET = process.env.JWT_SECRET || 'dikdou_hk_taxi_secret_key_2024';

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
}

function getToken(req) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) return header.slice(7);
  if (req.query && req.query.token) return req.query.token;
  return null;
}

function authPassenger(req, res, next) {
  const token = getToken(req);
  if (!token) {
    return res.status(401).json({ error: '未登入' });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'passenger') throw new Error('wrong role');
    const user = db.prepare('SELECT id, username, phone, name, avatar, rating, rating_count FROM passengers WHERE id = ?').get(decoded.id);
    if (!user) return res.status(401).json({ error: '帳號不存在' });
    req.user = user;
    req.userId = user.id;
    next();
  } catch {
    return res.status(401).json({ error: '登入已過期' });
  }
}

function authDriver(req, res, next) {
  const token = getToken(req);
  if (!token) {
    return res.status(401).json({ error: '未登入' });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'driver') throw new Error('wrong role');
    const user = db.prepare('SELECT id, username, phone, name, avatar, plate, car_model, driver_license, id_front4, status, online, rating, rating_count, current_lat, current_lng, is_vvip, vvip_applied, vvip_requested_at FROM drivers WHERE id = ?').get(decoded.id);
    if (!user) return res.status(401).json({ error: '帳號不存在' });
    // 統一 boolean 型別（login endpoint 用 !! 轉 boolean，呢度原封唔動會回 0/1 number，兩邊唔一致）
    user.online = !!user.online;
    user.is_vvip = !!user.is_vvip;
    user.vvip_applied = !!user.vvip_applied;
    req.user = user;
    req.userId = user.id;
    next();
  } catch {
    return res.status(401).json({ error: '登入已過期' });
  }
}

function authAdmin(req, res, next) {
  const token = getToken(req);
  if (!token) {
    return res.status(401).json({ error: '未登入' });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin') return res.status(403).json({ error: '無權限訪問（此功能需要管理員帳號）' });
    const user = db.prepare('SELECT id, username, role FROM admins WHERE id = ?').get(decoded.id);
    if (!user) return res.status(401).json({ error: '帳號不存在' });
    req.user = user;
    req.userId = user.id;
    next();
  } catch {
    return res.status(401).json({ error: '登入已過期' });
  }
}

// 營運主任（operator）都通過——admin 或 operator，用嚟批核成員
function authOperator(req, res, next) {
  const token = getToken(req);
  if (!token) {
    return res.status(401).json({ error: '未登入' });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin' && decoded.role !== 'operator') return res.status(403).json({ error: '無權限訪問（此功能需要管理員／營運主任帳號）' });
    const user = db.prepare('SELECT id, username, role FROM admins WHERE id = ?').get(decoded.id);
    if (!user) return res.status(401).json({ error: '帳號不存在' });
    req.user = user;
    req.userId = user.id;
    next();
  } catch {
    return res.status(401).json({ error: '登入已過期' });
  }
}

module.exports = { signToken, authPassenger, authDriver, authAdmin, authOperator, JWT_SECRET };
