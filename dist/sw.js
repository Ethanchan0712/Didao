/* 的道 DikDou PWA Service Worker
 * 基本離線快取：快取靜態資源 + App Shell
 */

const CACHE_NAME = 'dikdou-cache-v1';
const APP_SHELL = ['/'];

// 安裝：快取 App Shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(APP_SHELL).catch(() => {
        // 部分資源可能未就緒，忽略錯誤
      });
    })
  );
  self.skipWaiting();
});

// 啟用：清理舊快取
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

// 攔截請求：Stale-While-Revalidate 策略
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // 只處理 GET 請求
  if (request.method !== 'GET') return;

  // 略過非 http(s) 請求
  if (!request.url.startsWith('http')) return;

  // 略過 API 請求（POST 已過濾，呢度處理跨域 SSE 等）
  if (request.url.includes('/api/') || request.url.includes('/events')) return;

  event.respondWith(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.match(request).then((cached) => {
        // 網絡更新快取
        const fetchPromise = fetch(request)
          .then((response) => {
            // 只快取成功回應
            if (response && response.status === 200) {
              cache.put(request, response.clone()).catch(() => {});
            }
            return response;
          })
          .catch(() => {
            // 離線時返已快取內容
            return cached || caches.match('/');
          });

        // 有快取就即刻返，同時背景更新
        return cached || fetchPromise;
      });
    })
  );
});
