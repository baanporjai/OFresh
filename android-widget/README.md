# O'Fresh Widget (Android)

Home-screen widget แสดงปฏิทินยอดขายรายวันของ O'Fresh (สีเข้ม = ขายดี, ช่องวันนี้ไฮไลต์แยก) ดึงข้อมูลจาก
`order-api-worker.js` ตัวเดียวกับเว็บหลัก ผ่าน endpoint ใหม่ `/api/widget/daily-sales-calendar`

## โครงสร้าง

- `app/src/main/java/.../CalendarWidgetProvider.kt` — `AppWidgetProvider` อัปเดตทุก 30 นาที + รองรับแตะเพื่อรีเฟรชทันที
- `app/src/main/java/.../DailySalesApi.kt` — เรียก API ด้วย `HttpURLConnection` ธรรมดา (ไม่มี dependency เพิ่ม)
- `app/src/main/java/.../WidgetRenderer.kt` — วาดตารางปฏิทิน 6x7 ช่องลง `RemoteViews`
- `app/src/main/res/layout/widget_calendar.xml` — เลย์เอาต์ widget (ช่องวันที่คงที่ 42 ช่อง id `day_<row>_<col>`)

## ขั้นตอนติดตั้ง

### 1. ตั้งค่าฝั่ง Worker (ทำครั้งเดียว)

```bash
# สุ่ม token ยาวๆ เอง เช่น
openssl rand -hex 32

# ไปที่โฟลเดอร์ OFresh/ (ที่มี order-api-worker.js กับ wrangler.jsonc) แล้วรัน
wrangler secret put WIDGET_TOKEN
# แล้ววาง token ที่สุ่มได้ตอนถูกถาม จากนั้น deploy worker ตามปกติ
```

### 2. ตั้งค่าฝั่งแอป

คัดลอก `widget.secrets.properties.example` เป็น `widget.secrets.properties` (อยู่ที่ root ของ `android-widget/`
โฟลเดอร์นี้ ไฟล์นี้ถูก `.gitignore` ไว้แล้ว ไม่ต้องกลัวหลุดขึ้น git) แล้วใส่ค่า:

```properties
WORKER_BASE_URL=https://<โดเมน worker จริงของคุณ>
WIDGET_TOKEN=<ค่าเดียวกับที่ใส่ตอน wrangler secret put ด้านบน>
```

### 3. เปิดโปรเจกต์ด้วย Android Studio

1. เปิด Android Studio → **Open** → เลือกโฟลเดอร์ `android-widget/`
2. ปล่อยให้ Gradle sync (ครั้งแรกจะดาวน์โหลด Gradle wrapper/SDK components อัตโนมัติ ถ้า Android Studio ถามว่าจะสร้าง Gradle wrapper ให้ กด Yes)
3. เชื่อมมือถือ Android ผ่าน USB แล้วเปิด **USB debugging** (Settings → About phone → แตะ "Build number" 7 ครั้งเพื่อปลดล็อก Developer options → เปิด USB debugging) หรือใช้ Wireless debugging ก็ได้
4. กด Run ▶ เพื่อติดตั้งแอปลงเครื่อง (แอปนี้ไม่มีหน้าจอ เปิดแล้วจะไม่เห็นอะไร ไม่ต้องตกใจ — เป็นปกติของแอปที่มีแต่ widget)

### 4. เพิ่ม widget ลงโฮมสกรีน

กดค้างที่พื้นที่ว่างบนโฮมสกรีน → **Widgets** → หา **O'Fresh ปฏิทินยอดขาย** → ลากไปวาง ปรับขนาดได้ตามต้องการ
(แนะนำอย่างน้อย 4x4 ช่องเพื่อให้เห็นตารางครบ)

## รีเฟรชข้อมูล

- อัตโนมัติทุก 30 นาที (ค่าต่ำสุดที่ Android รองรับสำหรับ widget — ข้อมูล Nayax เองก็อัปเดตแค่วันละครั้งตอน ~7 โมงเช้าอยู่แล้ว รีเฟรชถี่กว่านี้ไม่มีประโยชน์)
- แตะที่ widget เพื่อรีเฟรชทันที (ไม่ต้องรอครบ 30 นาที)

## หมายเหตุ

- แอปนี้ไม่ได้ตั้งใจอัป Play Store — build แล้ว sideload ลงเครื่องตัวเองเท่านั้น
- ถ้าเปลี่ยนเครื่องหรือล้างเครื่อง ต้อง build+install ใหม่ (ไม่มี auto-update)
- ถ้าจะแจก APK ให้คนอื่นในทีมใช้ด้วย ต้อง build แยก APK ต่อคนที่มี `widget.secrets.properties` ของตัวเอง (คนละ token ก็ได้ ตราบใดที่ตรงกับค่าบน Worker) หรือแชร์ APK เดียวกันได้ถ้ายอมรับว่าทุกคนใช้ token เดียวกัน
