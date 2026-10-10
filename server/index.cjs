const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use((req, res, next) => { console.log('[REQ]', new Date().toISOString().slice(11,19), req.method, req.originalUrl); next(); });
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
// 統一補 body：無 JSON body 嘅 POST（無 Content-Type / 空 body）都會令 req.body 係 undefined，
// 任何 handler destructure req.body 即爆 TypeError→500。呢度補返空物件，杜絕成類 500。
app.use((req, res, next) => { req.body = req.body || {}; next(); });

// DB init (side effect - creates tables + seeds)
require('./db/index.cjs');

// API routes
app.use('/api/auth', require('./routes/auth.cjs'));
app.use('/api/orders', require('./routes/orders.cjs'));
app.use('/api/chat', require('./routes/chat.cjs'));
app.use('/api/admin', require('./routes/admin.cjs'));
app.use('/api/rental', require('./routes/rental.cjs'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// 私隱政策頁（Google Play / PCPD 要求；獨立於 SPA 之外，直接 serve）
app.get('/privacy', (req, res) => {
  const privacyPath = path.join(__dirname, 'privacy.html');
  if (fs.existsSync(privacyPath)) {
    res.sendFile(privacyPath);
  } else {
    res.status(200).send('本平台私隱政策暫未上線，請電郵 tkdw0712@gmail.com 查詢。');
  }
});

// 網頁刪除帳戶申請頁（Google Play Account Deletion 要求：in-app + web link）
app.get('/delete-account', (req, res) => {
  const delPath = path.join(__dirname, 'delete-account.html');
  if (fs.existsSync(delPath)) {
    res.sendFile(delPath);
  } else {
    res.status(200).send('請喺 App 內「設定」→「刪除帳戶」，或電郵 tkdw0712@gmail.com 申請刪除帳戶。');
  }
});

// Serve static client build in production
const clientDist = path.join(__dirname, '..', 'dist');
const fs = require('fs');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  // SPA fallback
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api/')) {
      res.sendFile(path.join(clientDist, 'index.html'));
    } else {
      next();
    }
  });
}

// ===== 全局錯誤處理：唔俾單一請求錯誤整死成個 server =====
app.use((err, req, res, next) => {
  console.error('[ERR]', new Date().toISOString(), req.method, req.originalUrl, err.message);
  if (res.headersSent) return next(err);
  // 壞 JSON body：係 client 錯，回 400 而唔係 500
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: '請求格式唔正確（JSON 解析失敗）' });
  }
  res.status(500).json({ error: '伺服器內部錯誤，請稍後再試' });
});

// 未捕獲異常都唔可以令 server 死——記錄＋繼續服務
process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] unhandledRejection:', reason);
});

app.listen(PORT, () => {
  console.log(`\n🚕 的道後端服務啟動成功！`);
  console.log(`   端口: ${PORT}`);
  console.log(`   API:  http://localhost:${PORT}/api/`);
  console.log(`   管理員: admin / lovevivi815\n`);
});
