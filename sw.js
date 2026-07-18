const CACHE_NAME = 'ofresh-v4';
// ต้องเป็น URL ปลายทางจริง (ไม่ใช่ URL ที่ Cloudflare Pages 307-redirect ต่อ)
// เพราะ Cache API ห้าม cache response ที่มาจาก redirect — ถ้าใส่ URL ที่ redirect ไป install จะ fail ทั้งหมด
const APP_SHELL = [
  '/stats',
  '/orderstats',
  '/customers',
  '/manifest.json',
  '/OFresh_Logo_transparent.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .catch(err => console.error('App shell caching failed:', err))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Cache-first สำหรับไฟล์หน้าเว็บของตัวเอง (same-origin GET) — ไม่ยุ่งกับ API ของ Worker เพื่อไม่ให้ข้อมูลสด/การส่งออเดอร์ค้าง
self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then(cached => {
      const fetchPromise = fetch(request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        }
        return res;
      }).catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
