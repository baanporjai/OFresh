# O'Fresh

เว็บไซต์และระบบหลังบ้านของ **O'Fresh** ตู้ขายน้ำส้มคั้นสดอัตโนมัติ ตั้งอยู่ที่ Central Festival เชียงใหม่ ชั้น 4
เว็บไซต์หลักเผยแพร่อยู่ที่ [ofresh.baanporjai.com](https://ofresh.baanporjai.com)

## โครงสร้างโปรเจกต์

```
OFresh/
├── index.html              เว็บหน้าหลัก (landing page)
├── order.html               ฟอร์มสั่งซื้อส้มแบบส่ง (bulk order)
├── stats.html / orderstats.html / OFresh_Dashboard.html   แดชบอร์ดยอดขาย (ข้อมูลจาก Nayax)
├── presentation.html        หน้านำเสนอสำหรับนักลงทุน/พาร์ทเนอร์
├── ofresh_banner_1.html     หน้าแบนเนอร์โฆษณา
├── i18n.js                  ข้อความแปลภาษาของเว็บหลัก
│
├── kiosk/                   หน้าจอตู้ขาย (self-service kiosk) รองรับ TH/EN/JA/KO/ZH
│   ├── index*.html, order*.html, kiosk.css, order.css, i18n.js
│   └── AUDIT_REPORT.md      บันทึกการแก้ปัญหาความเข้ากันได้กับ Android 9 / WebView เก่า
│
├── order-api-worker.js      Cloudflare Worker (deploy จริง): รับออเดอร์จากฟอร์ม → แจ้งเตือนผ่าน LINE
├── order-sheet-script.gs    Google Apps Script: บันทึกออเดอร์ลง Google Sheet
│
├── LINE OA Chatbot/line-bot-ai/   แชทบอท LINE OA (Next.js + Gemini AI) — repo แยกต่างหาก มี .git ของตัวเอง
│
├── Design/                  ไฟล์งานออกแบบต้นฉบับ (โลโก้, รูปโปรโมท, วิดีโอ) — เฉพาะรูปเล็กที่เว็บใช้จริงถูก track ใน git
├── Facebook Post/           รูปภาพสำหรับโพสต์ Facebook
├── business-data/           ข้อมูลยอดขาย, คู่มือเครื่อง, ไฟล์ที่ไม่เกี่ยวกับโค้ดเว็บ (ไม่ track ใน git)
├── _archive/                โค้ดเก่าที่ไม่ได้ใช้งานแล้วแต่ยังไม่แน่ใจ 100% ว่าลบได้ (ดู NOTE.md ในแต่ละโฟลเดอร์ย่อย)
│
├── inspect_xlsx.py, push_to_gsheet.py, update_nayax.py, remove_bg.py   สคริปต์ Python ช่วยประมวลผลข้อมูลยอดขาย/รูปภาพ
│
└── .claude/launch.json      คำสั่งรัน local dev server (ดูหัวข้อ "รันเว็บทดสอบ" ด้านล่าง)
```

### สิ่งที่ไม่ได้เก็บใน git (ดู `.gitignore`)
- `gsheet_creds.json` — Google service account credentials (ข้อมูลลับ)
- `DataNayax.xlsx`, `backup/`, `source_nayax/` — ข้อมูลยอดขายจากระบบ Nayax
- ไฟล์ PDF คู่มือเครื่อง, `.apk`, วิดีโอ/ไฟล์ต้นฉบับงานออกแบบขนาดใหญ่ (`.mp4`, `.ai`, `.pptx`)
- `node_modules/`, `.wrangler/` — cache/dependency ที่สร้างใหม่ได้เสมอ

## เทคโนโลยีที่ใช้

- เว็บหลัก + kiosk: HTML/CSS/JavaScript ล้วน ไม่มี build step, deploy ผ่าน **Cloudflare Pages**
- ระบบสั่งซื้อ: **Cloudflare Worker** รับข้อมูลจากฟอร์ม แล้วส่งต่อแจ้งเตือนผ่าน LINE และบันทึกลง Google Sheet
- LINE OA Chatbot: **Next.js + TypeScript** ใช้ Google Gemini AI ตอบแชท (โปรเจกต์ย่อยแยกต่างหาก)

## รันเว็บทดสอบในเครื่อง (local)

```bash
npx serve -p 3300 .
```

แล้วเปิดเบราว์เซอร์ไปที่ `http://localhost:3300`

(ถ้าเจอ error execution policy บน Windows PowerShell ให้ใช้ `npx.cmd serve -p 3300 .` แทน)
