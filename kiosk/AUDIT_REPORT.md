# Android 9 WebView (Chromium ~67) Compatibility Audit Report
**Date:** 2026-06-28  
**Files audited:** index.html, order.html, i18n.js  
**Output folder:** Andriod9/

---

## สิ่งที่แก้ไขแล้ว (What Was Fixed)

### 1. CSS Custom Properties (`var(--xxx)`) → ค่าสีตรง
**ความเสี่ยง: สูงมาก** — Chrome 49+ รองรับ แต่ Android WebView บางรุ่นก่อน Chromium 49 ไม่รองรับเลย และ user ระบุ Chromium ~67 ซึ่งอาจเป็น WebView version ที่ต่างกัน

แทนที่ทุก CSS variable ด้วยค่าจริง:
| Variable | ค่าจริง |
|---|---|
| `--orange-primary` | `#FF6B00` |
| `--orange-light` | `#FF9A3C` |
| `--orange-dark` | `#E55A00` |
| `--orange-glow` | `#FFB347` |
| `--green-fresh` | `#339933` |
| `--dark` | `#1A1A2E` |
| `--dark-light` | `#16213E` |
| `--white` | `#FFFFFF` |
| `--off-white` | `#FFF8F0` |
| `--text-dark` | `#2D2D2D` |
| `--text-muted` | `#6B7280` |
| `--border` | `#E5E7EB` |

---

### 2. Flexbox `gap:` → `margin` บน child elements
**ความเสี่ยง: สูงมาก** — `gap` ใน Flexbox ไม่รองรับจนถึง Chrome 84

ทุก flex container ที่มี `gap:` ถูกแปลงเป็น `margin-right` / `margin-bottom` บน child:
- `.nav-links li { margin-right: 28px; }`
- `.hero-buttons > * { margin-right: 16px; margin-bottom: 12px; }`
- `.fresh-feature { margin-bottom: 20px; }`
- `.footer-socials a { margin-right: 12px; }`
- `.nav-right > * { margin-left: 16px; }`
- และอื่นๆ ทุก flex-gap

---

### 3. `backdrop-filter: blur()` → `background` สีทึบ
**ความเสี่ยง: สูงมาก** — ไม่รองรับใน Chrome <76 (stable)

- Navbar: `backdrop-filter: blur(20px)` → `background: rgba(255,255,255,0.97)`
- Benefit cards: `backdrop-filter: blur(10px)` → ลบออก (ใช้ `rgba` bg เดิมพอ)

---

### 4. `aspect-ratio: 1` → padding-top trick
**ความเสี่ยง: สูงมาก** — ไม่รองรับจนถึง Chrome 88

`.freshness-image-box` เดิมใช้ `aspect-ratio: 1` เปลี่ยนเป็น:
```css
position: relative;
padding-top: 100%;
/* inner content ใช้ position: absolute; inset: 0 */
```
เพิ่ม div `.freshness-image-inner` ครอบ content ข้างใน

---

### 5. CSS Grid `gap:` → `grid-gap:`
**ความเสี่ยง: ปานกลาง** — Chrome 66+ รองรับ `gap` shorthand สำหรับ Grid แต่ Chrome 57-65 ต้องใช้ `grid-gap`

เปลี่ยน quality-grid, stats-container, footer-content จาก CSS Grid เป็น Flexbox wrap แทน เพื่อความปลอดภัย

---

### 6. `-webkit-` Prefixes
**ความเสี่ยง: ต่ำ** — Chrome 67 ส่วนใหญ่ไม่ต้องการ prefix แต่ใส่ไว้เพื่อ safety

ใส่ prefix ครบทุก property:
- `-webkit-transform` / `transform`
- `-webkit-transition` / `transition`
- `-webkit-animation` / `animation`
- `@-webkit-keyframes` / `@keyframes`
- `-webkit-flex`, `-webkit-align-items`, `-webkit-justify-content` ฯลฯ
- `-webkit-flex-wrap`, `-webkit-flex-direction`
- `-webkit-box-sizing` / `box-sizing`
- `-webkit-filter: drop-shadow()` / `filter:`
- `-webkit-linear-gradient()` / `linear-gradient()`
- `-webkit-text-size-adjust: 100%`

---

### 7. JavaScript: IntersectionObserver → Feature Detection
**ความเสี่ยง: ปานกลาง** — Chrome 51+ รองรับ แต่ Android WebView อาจต่างกัน

เดิม: สร้าง IntersectionObserver โดยตรง  
แก้ไข:
```javascript
if ('IntersectionObserver' in window) {
    document.documentElement.classList.add('io-supported');
    // ... observer code
}
// ถ้าไม่รองรับ: elements แสดงผลปกติ (opacity: 1 ตาม CSS default)
```

CSS fallback: `.animate-on-scroll` default เป็น `opacity: 1` และซ่อนเฉพาะเมื่อ class `io-supported` มีอยู่บน `<html>`

---

### 8. JavaScript: `async/await` → `.then()/.catch()`
**ความเสี่ยง: ต่ำ** — Chrome 55+ รองรับ async/await แต่แก้ไวด้วย `.then()` เพื่อ safety  
ใน `order.html`: เปลี่ยน `async (e) => {}` และ `await fetch()` เป็น `fetch().then().catch()`

---

### 9. JavaScript: Arrow Functions → Regular Functions
**ความเสี่ยง: ต่ำ** — Chrome 45+ รองรับ arrow functions  
แก้ event listeners ทั้งหมดใน `index.html` เป็น `function()` เพื่อ safety สูงสุด

---

### 10. JavaScript: Template Literals → String Concatenation
**ความเสี่ยง: ต่ำ** — Chrome 41+ รองรับ  
แก้ `\`...\`` ใน `order.html` เป็น `'...' + var + '...'`

---

### 11. Font Family Fallback
**ความเสี่ยง: ปานกลาง** — WebView อาจ block Google Fonts ถ้าไม่มี internet

เดิม: `font-family: 'Prompt', sans-serif`  
แก้เป็น: `font-family: 'Prompt', 'Noto Sans Thai', 'Sarabun', Arial, sans-serif`

เพิ่ม `Noto Sans Thai` ใน Google Fonts request ด้วย (โหลดพร้อมกัน)

---

### 12. Image alt Attributes
ตรวจสอบแล้ว — ทุก `<img>` มี `alt` ครบ  
เพิ่ม alt ที่ชัดเจนขึ้นให้ step images:
- `alt="Step 1 - กดปุ่ม Card"`
- `alt="Step 2 - เลือกวิธีชำระเงิน"`
- `alt="Step 3 - รอรับน้ำส้ม"`

---

### 13. `loading="lazy"` — ไม่มีในโค้ดต้นฉบับ
ไม่พบการใช้ `loading="lazy"` — ไม่ต้องแก้ไข

---

### 14. i18n.js — ไม่ต้องแก้ไข
`i18n.js` ใช้ syntax ES5 ล้วน (object literals, regular functions) — copy ตรงได้เลย

---

## จุดเสี่ยงที่สุด (Highest Risk Areas)

| ลำดับ | จุดเสี่ยง | ผลถ้าพัง |
|---|---|---|
| 🔴 1 | **Flexbox `gap:`** | Layout พัง — elements ชนกัน ไม่มี spacing |
| 🔴 2 | **`aspect-ratio: 1`** | กล่องส้มกลมแฟบลง height = 0 หายไป |
| 🔴 3 | **`backdrop-filter`** | Navbar ใส ไม่มี blur — OK แล้วถ้าใช้ bg solid |
| 🟡 4 | **Google Fonts offline** | ตัวอักษรไทยแสดงผล fallback font (Arial) — ยังอ่านได้ |
| 🟡 5 | **IntersectionObserver** | ถ้าพัง → elements ทั้งหมดซ่อน (opacity: 0 ตลอด) — แก้แล้วด้วย fallback |
| 🟢 6 | **CSS Custom Properties** | แก้แล้ว — ไม่มีความเสี่ยงแล้ว |

---

## วิธี Deploy บนตู้

1. Upload ไฟล์จากโฟลเดอร์ `Andriod9/` ขึ้น server แทนที่ไฟล์เดิม
2. ตรวจสอบว่า path รูปภาพถูกต้อง (ในไฟล์นี้ใช้ `../` เพราะอยู่ใน subfolder)
3. **ถ้า deploy เป็น root:** เปลี่ยน `../OFresh_Logo_transparent.png` → `OFresh_Logo_transparent.png`
4. ทดสอบบนอุปกรณ์ Android 9 จริงหรือ Chrome DevTools emulation ที่ "Chrome 67"

---

## สิ่งที่ยังต้องระวัง

- **Font Awesome 6.5.1** โหลดจาก CDN — ถ้า WebView block external domain ไอคอนจะไม่แสดง พิจารณา host locally
- **Google Analytics** อาจ timeout บน WebView ที่ไม่มี internet — ไม่กระทบ UI
- **`scrollIntoView({behavior: 'smooth'})`** — Chrome 61+ รองรับ, Chrome 67 OK
- **`toLocaleString()`** — รองรับบน Chrome ทุกเวอร์ชัน OK
