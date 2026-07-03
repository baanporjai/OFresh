# ทำไมโฟลเดอร์นี้ถูก archive

`_worker.js` ในนี้เป็น Cloudflare Pages Functions ที่เกือบจะเหมือนกับ `order-api-worker.js` ที่ root ทุกอย่าง ยกเว้นไม่มีฟิลด์ `id`

จากการเช็ค `order.html` พบว่าฟอร์มสั่งซื้อจริงยิงไปที่ `https://fancy-dust-060c.yai-taweewoot.workers.dev/api/order` ซึ่งเป็น Worker แบบ deploy ตรง (ตรงกับ `order-api-worker.js` ที่ root) ไม่ใช่ Pages Functions แบบนี้ — จึงเชื่อว่าไฟล์นี้ไม่ได้ใช้งานจริงแล้ว

**ก่อนลบทิ้งถาวร:** ควรเช็คใน Cloudflare Dashboard ก่อนว่ามี Pages project ไหนตั้งค่าให้ใช้ `_worker.js` นี้อยู่หรือไม่ (2026-07-03)
