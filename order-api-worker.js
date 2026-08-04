/**
 * O'Fresh Order API — Cloudflare Worker
 *
 * Deploy เป็น Worker ใหม่แยกต่างหาก แล้วตั้ง Environment Secret:
 *   LINE_CHANNEL_TOKEN     = <Channel Access Token จาก LINE Developers>
 *   LINE_CHANNEL_SECRET    = <Channel Secret จาก LINE Developers — คนละค่ากับ LINE_CHANNEL_TOKEN
 *                             ใช้ตรวจลายเซ็น webhook ที่ยิงเข้ามา (ป้องกันคนปลอม request มาสร้าง/ยืนยันออเดอร์)>
 *   GEMINI_API_KEY         = <API key จาก aistudio.google.com/apikey — ใช้ให้ Gemini ช่วยอ่าน/แปลง
 *                             ข้อความแอดมินในกลุ่มเป็นออเดอร์ที่มีโครงสร้าง>
 *   SHEET_WEBHOOK_URL      = <Apps Script webhook สำหรับบันทึกออเดอร์>
 *   ADMIN_PIN              = <PIN สำหรับเข้าหน้าแดชบอร์ด>
 *   SESSION_SECRET         = <ค่าสุ่มยาวๆ ใช้เซ็นชื่อ session token>
 *   ORDERS_SHEET_CSV_URL   = <ลิงก์ CSV ของ Google Sheet ออเดอร์ส้ม>
 *   NAYAX_SHEET_CSV_URL    = <ลิงก์ CSV ของ Google Sheet ยอดขาย Nayax>
 *   EXPENSES_SHEET_CSV_URL    = <ลิงก์ CSV ของ Google Sheet ต้นทุน/ค่าใช้จ่าย>
 *   EXPENSE_SHEET_WEBHOOK_URL = <Apps Script webhook สำหรับบันทึก/แก้ไข/ลบ รายการต้นทุน-ค่าใช้จ่าย —
 *                                ไม่ตั้งก็ได้ ถ้าใช้ Apps Script/สเปรดชีตตัวเดียวกับออเดอร์ส้ม (แค่คนละแท็บ)
 *                                จะ fallback ไปใช้ SHEET_WEBHOOK_URL แทนอัตโนมัติ>
 *   LINE_REWARD_CARD_URL   = <URL ของ "บัตรสะสมแต้ม" (Reward Card) จาก LINE Official Account Manager
 *                             (สร้างแคมเปญเองที่ Home > บัตรสะสมแต้ม ใน manager.line.biz แล้วคัดลอก URL การ์ดมาใส่ที่นี่
 *                             — เราไม่ได้สร้าง/เก็บสถานะสแตมป์เอง แค่ส่ง URL นี้กลับให้ลูกค้า LINE จัดการที่เหลือให้ทั้งหมด
 *                             ต้องรันเอง: wrangler secret put LINE_REWARD_CARD_URL>
 *   VISIT_SHEET_CSV_URL    = <ลิงก์ CSV ของแท็บ "Visits" ในสเปรดชีตออเดอร์ส้มเดียวกัน (Publish to web) —
 *                             เก็บรูป+ผลวิเคราะห์ลูกค้าหน้าตู้ ใช้ order-sheet-script.gs ตัวเดียวกับออเดอร์
 *                             ส้ม/ต้นทุน (คนละแท็บ) — การวิเคราะห์รูป (จำนวนคน/มีเด็กมาด้วยไหม) ใช้
 *                             GEMINI_API_KEY ตัวเดียวกับผู้ช่วย AI แปลงออเดอร์ในกลุ่มไลน์ด้านบน ไม่ต้องเพิ่ม
 *                             secret ใหม่
 *   VISIT_SHEET_WEBHOOK_URL = <ไม่ตั้งก็ได้ ถ้าใช้ Apps Script/สเปรดชีตตัวเดียวกับออเดอร์ส้ม จะ fallback ไปใช้
 *                              SHEET_WEBHOOK_URL แทนอัตโนมัติ เหมือน EXPENSE_SHEET_WEBHOOK_URL ด้านบน>
 *
 * ต้องเพิ่ม KV namespace binding ชื่อ OFRESH_KV ด้วย (Settings → Bindings → KV Namespace บน dashboard)
 * ใช้เก็บ cache ประวัติลูกค้าสำหรับให้ AI จับคู่ลูกค้าเดิม
 *
 * และต้องเปิด "Use webhook" ในหน้า LINE Developers Console ของ channel เดิม แล้วตั้ง Webhook URL
 * เป็น https://<worker-domain>/api/line/webhook (บอทถูกเพิ่มเข้ากลุ่ม O'Fresh_admin อยู่แล้วจากการ push
 * แจ้งเตือนเดิม ไม่ต้องเชิญใหม่)
 *
 * ADMIN_GROUP_ID ตั้งค่าไว้ใน code ด้านล่างได้เลย (ไม่ใช่ข้อมูลลับ)
 */

const ADMIN_GROUP_ID = 'C6cb7cc0124997383e2066d971d5d0819'; // LINE group: O'Fresh_admin
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 ชั่วโมง

// ── AI order assistant (กลุ่มไลน์แอดมิน) ──
// บันทึกออเดอร์ลงชีตทันทีที่ parse ได้ ไม่มีขั้นตอนยืนยัน — ถ้า AI จับคู่ลูกค้าผิดคนหรือ parse ผิด
// แก้ไขได้ทันทีด้วยปุ่ม "ยกเลิกออเดอร์นี้" ที่แนบมาด้วยทุกครั้ง หรือแก้รายละเอียดในแดชบอร์ด (orderstats.html)
const CUSTOMER_HISTORY_TTL_SECONDS = 5 * 60;
const ORDER_PRICE_PER_KG = 60;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (request.method === 'POST' && url.pathname === '/api/order') {
      return handleOrder(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/admin/login') {
      return handleAdminLogin(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/api/admin/orders') {
      return handleAdminSheetProxy(request, env, env.ORDERS_SHEET_CSV_URL, ctx, url.searchParams.has('fresh'));
    }

    if (request.method === 'GET' && url.pathname === '/api/admin/nayax-stats') {
      return handleAdminSheetProxy(request, env, env.NAYAX_SHEET_CSV_URL, ctx, url.searchParams.has('fresh'));
    }

    if (request.method === 'GET' && url.pathname === '/api/admin/expenses') {
      return handleAdminSheetProxy(request, env, env.EXPENSES_SHEET_CSV_URL, ctx, url.searchParams.has('fresh'));
    }

    if (request.method === 'POST' && url.pathname === '/api/admin/expenses') {
      return handleAdminExpenseWrite(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/api/public/highlights') {
      return handlePublicHighlights(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/api/public/order-highlights') {
      return handlePublicOrderHighlights(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/line/webhook') {
      return handleLineWebhook(request, env, ctx);
    }

    if (request.method === 'POST' && url.pathname === '/api/admin/visit-upload') {
      return handleVisitUpload(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/api/admin/visit-history') {
      return handleAdminSheetProxy(request, env, env.VISIT_SHEET_CSV_URL, ctx, url.searchParams.has('fresh'));
    }

    if (request.method === 'POST' && url.pathname === '/api/admin/visit-update') {
      return handleVisitUpdate(request, env);
    }

    // จอหน้าตู้จริงเป็น WebView ที่รัน JavaScript ไม่ได้ — สองเส้นทางนี้เลย render ตัวเลขเป็น HTML
    // สำเร็จรูปฝั่งเซิร์ฟเวอร์ตรงๆ (ไม่มี <script> fetch เหมือน realstat_*.html แบบเดิม) แล้วใช้
    // <meta refresh> รีเฟรชหน้าเป็นระยะแทน
    if (request.method === 'GET' && url.pathname === '/realstat/central') {
      return handleRealstatCentral(request, env);
    }
    if (request.method === 'GET' && url.pathname === '/realstat/lamyai') {
      return handleRealstatLamyai(request, env);
    }

    return jsonResponse({ error: 'Not found' }, 404);
  },
};

async function handleOrder(request, env) {
  let data;
  try {
    data = await request.json();
  } catch {
    return jsonResponse({ success: false, error: 'Invalid JSON' }, 400);
  }

  const { id, name, phone, line, qty, total, address, deliveryDate, note } = data;

  if (!name || !phone || !qty || !address) {
    return jsonResponse({ success: false, error: 'Missing required fields' }, 400);
  }

  const now = new Date().toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });

  const deliveryDateText = deliveryDate
    ? new Date(deliveryDate + 'T00:00:00').toLocaleDateString('th-TH', { day: 'numeric', month: 'long', year: 'numeric' })
    : null;

  const text = [
    '🍊 คำสั่งซื้อส้มใหม่! O\'Fresh',
    '─────────────────',
    `👤 ชื่อ: ${name}`,
    `📞 เบอร์: ${phone}`,
    line ? `💬 LINE: ${line}` : null,
    `⚖️ จำนวน: ${qty} กก.`,
    `💰 ยอดรวม: ฿${Number(total).toLocaleString()} (ไม่รวมค่าส่ง)`,
    `📍 ที่อยู่: ${address}`,
    deliveryDateText ? `📅 วันที่ต้องการของ: ${deliveryDateText}` : null,
    note ? `📝 หมายเหตุ: ${note}` : null,
    '─────────────────',
    `🕐 ${now}`,
  ].filter(Boolean).join('\n');

  try {
    const lineRes = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.LINE_CHANNEL_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: ADMIN_GROUP_ID,
        messages: [{ type: 'text', text }],
      }),
    });

    if (!lineRes.ok) {
      const errText = await lineRes.text();
      console.error('LINE API error:', errText);
      return jsonResponse({ success: false, error: 'LINE push failed' }, 500);
    }

    // บันทึกออเดอร์ลง Google Sheet สำหรับ dashboard — ไม่ให้ล้มทั้งคำขอถ้าบันทึกไม่สำเร็จ
    if (env.SHEET_WEBHOOK_URL) {
      try {
        await fetch(env.SHEET_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, name, phone, line, qty, total, address, deliveryDate, note }),
        });
      } catch (sheetErr) {
        console.error('Sheet webhook error:', sheetErr);
      }
    }

    return jsonResponse({ success: true });

  } catch (err) {
    console.error('Fetch error:', err);
    return jsonResponse({ success: false, error: 'Internal error' }, 500);
  }
}

async function handleAdminLogin(request, env) {
  let data;
  try {
    data = await request.json();
  } catch {
    return jsonResponse({ success: false, error: 'Invalid JSON' }, 400);
  }

  const pin = (data.pin || '').toString();
  if (!env.ADMIN_PIN || !timingSafeEqual(pin, env.ADMIN_PIN)) {
    return jsonResponse({ success: false, error: 'Invalid PIN' }, 401);
  }

  const token = await createToken(env.SESSION_SECRET);
  return jsonResponse({ success: true, token });
}

// Google Sheets export เป็น CSV ช้าโดยธรรมชาติ (render ทั้งชีตใหม่ทุกครั้ง ยิ่งมีแถวเยอะยิ่งช้า)
// เดิมยิงตรงไป Google ทุกครั้งพร้อม cache-buster ทำให้ทุกคลิก "รีเฟรสข้อมูล" หรือแอดมินหลายคนที่เปิดพร้อมกัน
// ต้องรอ round-trip เต็มๆ ไปหา Google ใหม่หมด — ใส่ cache ที่ edge ของ Cloudflare (Cache API) TTL สั้นแค่ 15 วิ
// เพื่อลดเวลารอในเคสที่มีคนโหลดซ้ำถี่ๆ โดยข้อมูลยังถือว่าสดพอสำหรับแดชบอร์ดแอดมิน
// allowStale=false (ส่ง ?fresh=1 มา เช่นตอนกดปุ่มรีเฟรสข้อมูลเอง) จะข้าม cache ไปดึงสดเสมอ
async function handleAdminSheetProxy(request, env, sheetUrl, ctx, forceFresh) {
  const ok = await verifyAuthHeader(request, env);
  if (!ok) return jsonResponse({ error: 'Unauthorized' }, 401);

  if (!sheetUrl) return jsonResponse({ error: 'Not configured' }, 500);

  const cache = caches.default;
  const cacheKey = new Request(sheetUrl, { method: 'GET' });

  try {
    if (!forceFresh) {
      const cached = await cache.match(cacheKey);
      if (cached) {
        return new Response(cached.body, { headers: { ...CORS_HEADERS, 'Content-Type': 'text/csv; charset=utf-8' } });
      }
    }

    const res = await fetch(sheetUrl);
    const text = await res.text();

    const toCache = new Response(text, {
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'public, max-age=15' },
    });
    if (ctx) ctx.waitUntil(cache.put(cacheKey, toCache));

    return new Response(text, {
      headers: { ...CORS_HEADERS, 'Content-Type': 'text/csv; charset=utf-8' },
    });
  } catch (err) {
    console.error('Sheet proxy error:', err);
    return jsonResponse({ error: 'Failed to fetch sheet' }, 502);
  }
}

// เขียนรายการต้นทุน/ค่าใช้จ่าย (เพิ่ม/แก้ไข/ลบ) — ต้องผ่าน PIN token เพราะเป็นข้อมูลการเงินที่กระทบยอดกำไร
// ต่างจาก updateOrderStatus ใน orderstats.html ที่ยิงตรงไปที่ Apps Script โดยไม่ auth
// (เหมาะกับสถานะออเดอร์ซึ่งความเสี่ยงต่ำ) — ที่นี่ให้ Worker เป็นตัวกลางยืนยัน token ก่อน
// แล้วค่อย forward ไป Apps Script แทน เพื่อไม่ให้ URL เขียนข้อมูลการเงินหลุดไปอยู่ใน client-side JS เปิดเผย
async function handleAdminExpenseWrite(request, env) {
  const ok = await verifyAuthHeader(request, env);
  if (!ok) return jsonResponse({ error: 'Unauthorized' }, 401);

  // ถ้าไม่ได้ตั้ง secret แยกไว้ ให้ fallback ไปใช้ SHEET_WEBHOOK_URL เดิม (ออเดอร์ส้ม) แทน
  // เผื่อกรณีเก็บต้นทุน/ค่าใช้จ่ายไว้ในสเปรดชีตเดียวกัน (คนละแท็บ) กับออเดอร์ ใช้ Apps Script ตัวเดียวกันได้
  const webhookUrl = env.EXPENSE_SHEET_WEBHOOK_URL || env.SHEET_WEBHOOK_URL;
  if (!webhookUrl) return jsonResponse({ error: 'Not configured' }, 500);

  let data;
  try {
    data = await request.json();
  } catch {
    return jsonResponse({ success: false, error: 'Invalid JSON' }, 400);
  }

  const action = (data.action === 'update' || data.action === 'delete') ? data.action : 'add';

  if (action === 'add') {
    if (!data.id || !data.type || !data.category || !data.amount || !data.date) {
      return jsonResponse({ success: false, error: 'Missing required fields' }, 400);
    }
    if (data.type !== 'cogs' && data.type !== 'opex') {
      return jsonResponse({ success: false, error: 'Invalid type' }, 400);
    }
  } else if (!data.id) {
    return jsonResponse({ success: false, error: 'Missing id' }, 400);
  }

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // target: 'expense' ให้ Apps Script แยกเส้นทางออกจากการเขียนออเดอร์ส้ม เผื่อใช้ webhook เดียวกัน
      body: JSON.stringify({ ...data, action, target: 'expense' }),
    });
    const result = await res.json().catch(() => ({ success: res.ok }));
    return jsonResponse(result, result.success === false ? 502 : 200);
  } catch (err) {
    console.error('Expense webhook error:', err);
    return jsonResponse({ success: false, error: 'Failed to save expense' }, 502);
  }
}

// คำนวณตัวเลขสรุป (แก้วรวม/ชั่วโมงยอดนิยม/แก้วล่าสุด) จากข้อมูล Nayax ดิบ — ใช้ร่วมกันทั้ง
// /api/public/highlights (JSON สำหรับหน้าที่รัน JS ได้) และ /realstat/* (HTML สำเร็จรูปสำหรับจอหน้าตู้
// ที่เป็น WebView รัน JS ไม่ได้) กันโค้ดซ้ำและกันสองทางคำนวณเพี้ยนไม่ตรงกัน
function computeHighlights_(rows, { machineFilter, scopeCupsToMachine, monthParam }) {
  const cupsRows = (machineFilter && scopeCupsToMachine) ? rows.filter(r => r.machine === machineFilter) : rows;
  const totalCups = cupsRows.length;

  const machineRows = machineFilter ? rows.filter(r => r.machine === machineFilter) : rows;

  // รายเดือนที่มีข้อมูลจริงของตู้นี้ — ให้ dropdown เลือกได้ตรงกับข้อมูลจริง ไม่ใช่เดาเดือนเอาเอง
  const monthKeySet = new Set(machineRows.map(r => {
    const p = toBangkokParts(r.datetime);
    return `${p.year}-${p.month}`;
  }));
  const availableMonths = Array.from(monthKeySet)
    .map(k => { const [year, month] = k.split('-').map(Number); return { year, month }; })
    .sort((a, b) => (b.year - a.year) || (b.month - a.month));

  // ชั่วโมงยอดนิยม — ดูเฉพาะเดือนที่เลือก (เวลาไทย) ค่าเริ่มต้นคือเดือนปัจจุบัน ไม่ใช่ค่าเฉลี่ยสะสมทั้งหมด
  let targetYear, targetMonth;
  if (monthParam && /^\d{4}-\d{1,2}$/.test(monthParam)) {
    const [y, m] = monthParam.split('-').map(Number);
    targetYear = y; targetMonth = m;
  } else {
    const cur = toBangkokParts(new Date());
    targetYear = cur.year; targetMonth = cur.month;
  }
  const monthRows = machineRows.filter(r => {
    const p = toBangkokParts(r.datetime);
    return p.year === targetYear && p.month === targetMonth;
  });
  const hourCounts = Array(24).fill(0);
  monthRows.forEach(r => hourCounts[toBangkokParts(r.datetime).hour]++);
  const peakHour = hourCounts.every(c => c === 0) ? null : hourCounts.indexOf(Math.max(...hourCounts));

  // เวลาแก้วล่าสุด — ใช้ scope เดียวกับชั่วโมงยอดนิยม (ตาม machineFilter ถ้ามี) เพราะจอหน้าตู้อยากรู้ว่า
  // "ตู้นี้" ขายล่าสุดเมื่อไหร่ ไม่ใช่ทั้งบริษัท ต่างจาก totalCups ที่ default เป็นยอดรวมทุกตู้เสมอ
  const lastSaleAt = machineRows.length
    ? new Date(Math.max(...machineRows.map(r => r.datetime.getTime()))).toISOString()
    : null;

  return { totalCups, peakHour, lastSaleAt, hourCounts, availableMonths, selectedMonth: { year: targetYear, month: targetMonth } };
}

async function fetchNayaxRows_(env) {
  const res = await fetch(env.NAYAX_SHEET_CSV_URL + (env.NAYAX_SHEET_CSV_URL.includes('?') ? '&' : '?') + 't=' + Date.now());
  const text = await res.text();
  return parseNayaxCSV(text);
}

// เอนด์พอยต์สาธารณะสำหรับหน้าแรก — คืนแค่ตัวเลขสรุป (ไม่มีข้อมูลลูกค้า/ธุรกรรมดิบ) จึงไม่ต้องใช้ PIN
// ?machine=OFresh_CentralFest (optional) — จำกัด "ชั่วโมงยอดนิยม" ให้ดูเฉพาะตู้นั้น ใช้กับจอที่ติดอยู่หน้าตู้
// เฉพาะเครื่อง (เช่น realstat_central.html) ส่วน totalCups ยังเป็นยอดรวมทุกตู้เสมอ ไม่ผูกกับ query param นี้
async function handlePublicHighlights(request, env) {
  if (!env.NAYAX_SHEET_CSV_URL) return jsonResponse({ error: 'Not configured' }, 500);

  try {
    const url = new URL(request.url);
    const machineFilter = url.searchParams.get('machine');
    // ปกติ "แก้วรวม" นับทุกตู้เสมอ (realstat_central.html ตั้งใจให้เป็นยอดรวมทั้งบริษัท) — ต้องส่ง
    // cupsScope=machine มาด้วยชัดๆ ถึงจะกรองแก้วรวมให้เหลือเฉพาะตู้ที่ระบุใน machine (ใช้กับ
    // realstat_lamyai.html ที่อยากโชว์แก้วเฉพาะงานลำไย ไม่ใช่ยอดรวมทุกตู้)
    const scopeCupsToMachine = url.searchParams.get('cupsScope') === 'machine';
    // month=YYYY-M (M เป็นเลข 0-11 ให้ตรงกับ toBangkokParts().month) — ไม่ระบุ = เดือนปัจจุบัน
    // ใช้กับ dropdown เลือกเดือนของ heatmap ให้ตรงกับหน้า stats.html แอดมิน
    const monthParam = url.searchParams.get('month');

    const rows = await fetchNayaxRows_(env);
    const stats = computeHighlights_(rows, { machineFilter, scopeCupsToMachine, monthParam });

    return jsonResponse(stats, 200, { 'Cache-Control': 'public, max-age=300' });
  } catch (err) {
    console.error('Public highlights error:', err);
    return jsonResponse({ error: 'Failed to compute highlights' }, 502);
  }
}

// ═══════════ /realstat/central, /realstat/lamyai — จอหน้าตู้จริง (WebView รัน JS ไม่ได้) ═══════════
// render ตัวเลขเป็น HTML สำเร็จรูปฝั่งเซิร์ฟเวอร์ตรงๆ แทนการพึ่ง <script> fetch เหมือนไฟล์
// realstat_*.html แบบเดิม (ยังเก็บไฟล์เดิมไว้เผื่อเปิดดูจากเบราว์เซอร์ปกติที่รัน JS ได้) แล้วใช้
// <meta http-equiv="refresh"> รีเฟรชหน้าใหม่ทั้งหน้าเป็นระยะแทนการ fetch ข้อมูลใหม่ด้วย JS

function htmlResponse_(html, status = 200, extraHeaders = {}) {
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...extraHeaders } });
}

const TH_MONTH_NAMES_ = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
// ใช้ตาราง Thai month name ตรงๆ แทน Date/Intl เพราะแค่ต้องการ "เดือน+ปี พ.ศ." จากเลข year/month
// (0-11) ที่รู้ค่าแน่ชัดอยู่แล้ว ไม่มีประโยชน์ต้องเสี่ยงปัญหา timezone จาก Date object เพิ่ม
function thaiMonthYearLabel_(year, month) {
  return `${TH_MONTH_NAMES_[month]} ${year + 543}`;
}

function peakHourRangeText_(peakHour) {
  return typeof peakHour === 'number' ? `${peakHour}:00-${(peakHour + 1) % 24}:00` : '—';
}

// "แก้วล่าสุด" เป็น UTC ISO string จริงจาก computeHighlights_ (ผ่าน bangkokTimeToUtc มาแล้วตอน parse
// จาก Nayax CSV) ต้องระบุ timeZone: 'Asia/Bangkok' ตรงๆ ตอน format เสมอ เพราะ Worker รันด้วย timezone
// UTC เป็นค่าเริ่มต้น — พลาดจุดนี้จะเพี้ยนไป 7 ชั่วโมงเหมือนบั๊กที่เจอมาก่อนหน้านี้ในระบบ visits
function renderUpdatedAtText_(lastSaleAt) {
  if (!lastSaleAt) return 'ยังไม่มีข้อมูลแก้วของตู้นี้';
  const label = new Date(lastSaleAt).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' });
  return 'ข้อมูลอัพเดทล่าสุด ' + label;
}

function renderHourGridHtml_(hourCounts) {
  const maxH = Math.max(...hourCounts);
  return hourCounts.map((cnt, h) => {
    const p = maxH > 0 ? cnt / maxH : 0;
    const cls = p >= .85 ? 'p1' : p >= .55 ? 'p2' : p >= .25 ? 'p3' : '';
    return `<div class="hour-cell ${cls}">
      <div class="hc-count">${cnt || ''}</div>
      <div class="hc-lbl">${h}:00</div>
    </div>`;
  }).join('');
}

// หน้า error สั้นๆ เผื่อดึงข้อมูล Nayax ไม่สำเร็จ — รีเฟรชถี่กว่าปกติ (60s) เพื่อลองใหม่เร็วๆ
// จอนี้ถูกเปิดค้างไว้ที่หน้าตู้ตลอดเวลา ไม่มีใครมาคอยกดรีเฟรชเอง
function renderRealstatErrorHtml_(title) {
  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<meta http-equiv="refresh" content="60">
<title>${title}</title>
<style>
  body { font-family: 'Prompt', sans-serif; display: flex; align-items: center; justify-content: center;
    min-height: 100vh; margin: 0; background: #FFF8F0; color: #b91c1c; text-align: center; padding: 20px; }
</style>
</head>
<body>โหลดข้อมูลไม่สำเร็จ — ระบบจะลองใหม่อัตโนมัติ</body>
</html>`;
}

function renderRealstatCentralHtml_(stats) {
  const cupsText = stats.totalCups.toLocaleString('th-TH');
  const peakText = peakHourRangeText_(stats.peakHour);
  const updatedText = renderUpdatedAtText_(stats.lastSaleAt);

  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<meta http-equiv="refresh" content="120">
<title>O'Fresh — สถิติสดจากตู้ Central Fest</title>
<link rel="icon" href="https://ofresh.baanporjai.com/favicon.ico">

<link href="https://fonts.googleapis.com/css2?family=Prompt:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
<style>
  :root {
    --orange: #FF6B00;
    --orange-dark: #E85D00;
    --green: #339933;
    --off-white: #FFF8F0;
    --text-dark: #2D2D2D;
    --text-muted: #6B7280;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    min-height: 100%;
    font-family: 'Prompt', sans-serif;
    color: var(--text-dark);
    background: linear-gradient(160deg, #FFF8F0 0%, #FFEEDD 100%);
  }
  body {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    min-height: 100vh; padding: 5vh 5vw; text-align: center;
    gap: clamp(24px, 4vh, 48px);
  }

  .logo { width: min(50vw, 320px); height: auto; object-fit: contain; }

  .live-tag {
    display: inline-flex; align-items: center; gap: 10px;
    background: rgba(51,153,51,.1); color: var(--green);
    padding: 8px 20px; border-radius: 50px;
    font-size: clamp(13px, 1.6vw, 17px); font-weight: 700;
    letter-spacing: .3px;
  }
  .live-dot {
    width: 10px; height: 10px; border-radius: 50%; background: var(--green);
    animation: pulse 1.6s ease-in-out infinite;
  }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .25; } }

  .stats {
    display: grid; grid-template-columns: repeat(2, 1fr);
    gap: clamp(16px, 3vw, 32px);
    width: 100%; max-width: 900px;
  }
  .stat-card {
    background: #fff; border-radius: 28px;
    padding: clamp(24px, 4vh, 44px) clamp(16px, 3vw, 32px);
    box-shadow: 0 16px 50px rgba(0,0,0,.07);
    border: 1px solid rgba(255,107,0,.08);
  }
  .stat-icon { font-size: clamp(32px, 5vw, 48px); margin-bottom: 10px; }
  .stat-icon img { height: clamp(56px, 9vw, 88px); width: auto; display: block; margin: 0 auto; }
  .stat-value {
    font-size: clamp(36px, 7vw, 72px); font-weight: 800; color: var(--orange);
    line-height: 1.1; font-variant-numeric: tabular-nums;
  }
  .stat-label { font-size: clamp(16px, 2.4vw, 24px); font-weight: 700; margin-top: 10px; }
  .stat-sub { font-size: clamp(12px, 1.6vw, 16px); color: var(--text-muted); margin-top: 4px; font-weight: 300; }

  .updated-at { font-size: clamp(11px, 1.4vw, 14px); color: var(--text-muted); opacity: .7; }

  @media (max-width: 560px) {
    .stats { grid-template-columns: 1fr; max-width: 360px; }
  }
</style>
</head>
<body>

  <img class="logo" src="https://ofresh.baanporjai.com/OFresh_Logo_transparent.png" alt="O'Fresh">

  <div class="live-tag">
    <span class="live-dot"></span>
    <span>อัปเดตข้อมูลวันต่อวันจากตู้จริง</span>
  </div>

  <div class="stats">
    <div class="stat-card">
      <div class="stat-icon"><img src="https://ofresh.baanporjai.com/assets/cup.png" alt="cup"></div>
      <div class="stat-value">${cupsText}</div>
      <div class="stat-label">แก้วที่เสิร์ฟไปแล้ว</div>
      <div class="stat-sub">จากยอดขายจริงของตู้</div>
    </div>
    <div class="stat-card">
      <div class="stat-icon">⏰</div>
      <div class="stat-value">${peakText}</div>
      <div class="stat-label">ชั่วโมงยอดนิยม</div>
      <div class="stat-sub">ช่วงเวลาที่มีคนสั่งมากที่สุดเดือนนี้ (ตู้ Central Fest)</div>
    </div>
  </div>

  <div>
    <div class="updated-at">${updatedText}</div>
  </div>

</body>
</html>`;
}

function renderRealstatLamyaiHtml_(stats) {
  const cupsText = stats.totalCups.toLocaleString('th-TH');
  const peakText = peakHourRangeText_(stats.peakHour);
  const badgeText = typeof stats.peakHour === 'number'
    ? `🔥 ยอดฮิต ${stats.peakHour}:00–${(stats.peakHour + 1) % 24}:00`
    : 'ยังไม่มีข้อมูล';
  const monthLabel = thaiMonthYearLabel_(stats.selectedMonth.year, stats.selectedMonth.month);
  const updatedText = renderUpdatedAtText_(stats.lastSaleAt);
  const hourGridHtml = renderHourGridHtml_(stats.hourCounts);

  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<meta http-equiv="refresh" content="120">
<title>O'Fresh — สถิติสดจากตู้งานลำไย</title>
<link rel="icon" href="https://ofresh.baanporjai.com/favicon.ico">

<link href="https://fonts.googleapis.com/css2?family=Prompt:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
<style>
  :root {
    --orange: #FF6B00;
    --orange-dark: #E85D00;
    --green: #339933;
    --off-white: #FFF8F0;
    --text-dark: #2D2D2D;
    --text-muted: #6B7280;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    min-height: 100%;
    font-family: 'Prompt', sans-serif;
    color: var(--text-dark);
    background: linear-gradient(160deg, #FFF8F0 0%, #FFEEDD 100%);
  }
  body {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    min-height: 100vh; padding: 5vh 5vw; text-align: center;
    gap: clamp(24px, 4vh, 48px);
  }

  .logo { width: min(32vw, 200px); height: auto; object-fit: contain; }

  .live-tag {
    display: inline-flex; align-items: center; gap: 10px;
    background: rgba(51,153,51,.1); color: var(--green);
    padding: 8px 20px; border-radius: 50px;
    font-size: clamp(13px, 1.6vw, 17px); font-weight: 700;
    letter-spacing: .3px;
  }
  .live-dot {
    width: 10px; height: 10px; border-radius: 50%; background: var(--green);
    animation: pulse 1.6s ease-in-out infinite;
  }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .25; } }

  .stats {
    display: grid; grid-template-columns: repeat(2, 1fr);
    gap: clamp(16px, 3vw, 32px);
    width: 100%; max-width: 900px;
  }
  .stat-card {
    background: #fff; border-radius: 28px;
    padding: clamp(24px, 4vh, 44px) clamp(16px, 3vw, 32px);
    box-shadow: 0 16px 50px rgba(0,0,0,.07);
    border: 1px solid rgba(255,107,0,.08);
  }
  .stat-icon { font-size: clamp(32px, 5vw, 48px); margin-bottom: 10px; }
  .stat-icon img { height: clamp(56px, 9vw, 88px); width: auto; display: block; margin: 0 auto; }
  .stat-value {
    font-size: clamp(36px, 7vw, 72px); font-weight: 800; color: var(--orange);
    line-height: 1.1; font-variant-numeric: tabular-nums;
  }
  #peakHourValue { font-size: clamp(24px, 4.5vw, 46px); white-space: nowrap; }
  .stat-label { font-size: clamp(16px, 2.4vw, 24px); font-weight: 700; margin-top: 10px; }

  .updated-at { font-size: clamp(11px, 1.4vw, 14px); color: var(--text-muted); opacity: .7; }

  @media (max-width: 560px) {
    .stats { grid-template-columns: 1fr; max-width: 360px; }
  }

  .heatmap-card {
    background: #fff; border-radius: 28px;
    padding: clamp(20px, 3.5vh, 36px) clamp(16px, 3vw, 32px);
    box-shadow: 0 16px 50px rgba(0,0,0,.07);
    border: 1px solid rgba(255,107,0,.08);
    width: 100%; max-width: 900px;
  }
  .heatmap-header {
    display: flex; align-items: center; justify-content: center; gap: 12px;
    flex-wrap: wrap; margin-bottom: 18px;
  }
  .heatmap-title { font-size: clamp(15px, 2vw, 19px); font-weight: 700; }
  .heatmap-month {
    font-size: clamp(12px, 1.6vw, 15px); font-weight: 600; color: var(--text-dark);
    background: #F5F5F5; border-radius: 999px; padding: 7px 14px;
  }
  .heatmap-badge {
    background: rgba(255,107,0,.1); color: var(--orange-dark);
    padding: 5px 14px; border-radius: 999px; font-size: clamp(12px, 1.6vw, 15px); font-weight: 700;
  }
  .hour-grid { display: grid; grid-template-columns: repeat(12,1fr); gap: 5px; }
  @media (max-width: 600px) { .hour-grid { grid-template-columns: repeat(6,1fr); } }
  .hour-cell {
    aspect-ratio: 1; border-radius: 8px; background: #F5F5F5;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
  }
  .hour-cell .hc-count { font-size: clamp(.6rem, 1.4vw, .82rem); font-weight: 700; color: var(--text-dark); line-height: 1; }
  .hour-cell .hc-lbl { font-size: clamp(.45rem, 1vw, .58rem); color: var(--text-muted); margin-top: 2px; }
  .hour-cell.p1 { background: var(--orange); box-shadow: 0 0 12px rgba(255,107,0,.3); }
  .hour-cell.p1 .hc-count, .hour-cell.p1 .hc-lbl { color: #fff; }
  .hour-cell.p2 { background: #FFB870; }
  .hour-cell.p2 .hc-count, .hour-cell.p2 .hc-lbl { color: #fff; }
  .hour-cell.p3 { background: #FFD7A8; }
  .heatmap-legend { display: flex; align-items: center; justify-content: center; gap: 8px; margin-top: 14px; font-size: clamp(11px, 1.4vw, 13px); color: var(--text-muted); }
  .legend-scale { display: flex; gap: 4px; }
  .legend-dot { width: 14px; height: 14px; border-radius: 4px; }
</style>
</head>
<body>

  <img class="logo" src="https://ofresh.baanporjai.com/OFresh_Logo_transparent.png" alt="O'Fresh">

  <div class="live-tag">
    <span class="live-dot"></span>
    <span>ข้อมูลอัปเดตแบบวันต่อวันจากตู้ในงานลำไย</span>
  </div>

  <div class="stats">
    <div class="stat-card">
      <div class="stat-icon"><img src="https://ofresh.baanporjai.com/assets/cup.png" alt="cup"></div>
      <div class="stat-value">${cupsText}</div>
      <div class="stat-label">แก้วที่เสิร์ฟไปแล้ว</div>
    </div>
    <div class="stat-card">
      <div class="stat-icon">⏰</div>
      <div class="stat-value" id="peakHourValue">${peakText}</div>
      <div class="stat-label">ชั่วโมงยอดนิยม</div>
    </div>
  </div>

  <div class="heatmap-card">
    <div class="heatmap-header">
      <div class="heatmap-title">🌡️ ช่วงเวลาที่ลูกค้าสั่งมากที่สุด</div>
      <div class="heatmap-month">${monthLabel}</div>
      <div class="heatmap-badge">${badgeText}</div>
    </div>
    <div class="hour-grid">${hourGridHtml}</div>
    <div class="heatmap-legend">
      <div class="legend-scale">
        <div class="legend-dot" style="background:#F5F5F5"></div>
        <div class="legend-dot" style="background:#FFD7A8"></div>
        <div class="legend-dot" style="background:#FFB870"></div>
        <div class="legend-dot" style="background:var(--orange)"></div>
      </div>
      <span>น้อย → มาก</span>
    </div>
  </div>

  <div>
    <div class="updated-at">${updatedText}</div>
  </div>

</body>
</html>`;
}

async function handleRealstatCentral(request, env) {
  if (!env.NAYAX_SHEET_CSV_URL) return htmlResponse_(renderRealstatErrorHtml_("O'Fresh — Central Fest"));
  try {
    const rows = await fetchNayaxRows_(env);
    const stats = computeHighlights_(rows, { machineFilter: 'OFresh_CentralFest', scopeCupsToMachine: false, monthParam: null });
    return htmlResponse_(renderRealstatCentralHtml_(stats), 200, { 'Cache-Control': 'public, max-age=120' });
  } catch (err) {
    console.error('Realstat central error:', err);
    return htmlResponse_(renderRealstatErrorHtml_("O'Fresh — Central Fest"));
  }
}

async function handleRealstatLamyai(request, env) {
  if (!env.NAYAX_SHEET_CSV_URL) return htmlResponse_(renderRealstatErrorHtml_("O'Fresh — งานลำไย"));
  try {
    const rows = await fetchNayaxRows_(env);
    const stats = computeHighlights_(rows, { machineFilter: 'OFresh_Lamyai', scopeCupsToMachine: true, monthParam: null });
    return htmlResponse_(renderRealstatLamyaiHtml_(stats), 200, { 'Cache-Control': 'public, max-age=120' });
  } catch (err) {
    console.error('Realstat lamyai error:', err);
    return htmlResponse_(renderRealstatErrorHtml_("O'Fresh — งานลำไย"));
  }
}

// เอนด์พอยต์สาธารณะสำหรับหน้าสั่งซื้อ — คืนแค่จำนวนออเดอร์/น้ำหนักรวม (ไม่มียอดขาย/ข้อมูลลูกค้า)
async function handlePublicOrderHighlights(request, env) {
  if (!env.ORDERS_SHEET_CSV_URL) return jsonResponse({ error: 'Not configured' }, 500);

  try {
    const res = await fetch(env.ORDERS_SHEET_CSV_URL + (env.ORDERS_SHEET_CSV_URL.includes('?') ? '&' : '?') + 't=' + Date.now());
    const text = await res.text();
    const rows = parseOrdersCSV(text);

    const totalOrders = rows.length;
    const totalQty = rows.reduce((s, r) => s + r.qty, 0);
    const avgQty = totalOrders ? totalQty / totalOrders : 0;

    return jsonResponse(
      { totalOrders, totalQty, avgQty },
      200,
      { 'Cache-Control': 'public, max-age=300' }
    );
  } catch (err) {
    console.error('Public order highlights error:', err);
    return jsonResponse({ error: 'Failed to compute highlights' }, 502);
  }
}

function parseOrdersCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const h = splitCSVLine(lines[0]).map(s => s.trim().toLowerCase().replace(/\r/g, ''));
  const iTs = h.indexOf('timestamp'), iQty = h.indexOf('qty');

  return lines.slice(1).map(line => {
    const v = splitCSVLine(line);
    const g = i => (v[i] || '').trim().replace(/\r/g, '');
    const datetime = parseTimestamp(g(iTs));
    const qty = parseFloat(g(iQty)) || 0;
    return { datetime, qty };
  }).filter(r => r.datetime && !isNaN(r.datetime) && r.qty > 0);
}

function parseTimestamp(s) {
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s*(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!m) return new Date(s);
  const [, d, mo, y, hr, mi, se] = m.map(Number);
  return new Date(y, mo - 1, d, hr, mi, se);
}

function splitCSVLine(line) {
  const fields = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else { cur += c; }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { fields.push(cur); cur = ''; }
      else cur += c;
    }
  }
  fields.push(cur);
  return fields;
}

// เวลาในไฟล์ Nayax/รูปกล้อง/ที่พนักงานกรอกเอง เป็น "เวลาไทย" (Bangkok, UTC+7) เสมอ — แต่ Cloudflare
// Workers รันด้วย timezone UTC เป็นค่าเริ่มต้น ถ้าใช้ new Date(y,m,d,hr,mn) (component constructor)
// ตรงๆ มันจะตีความตัวเลขเดิมเป็นเวลา UTC ไปเลย ทำให้ผลลัพธ์เพี้ยนไปช้า 7 ชั่วโมง (เช่น 20:06 ไทยจริง
// กลายเป็นถูกบันทึกเป็น 20:06Z ซึ่งคือ 03:06 ของอีกวันตามเวลาไทย) — ต้องแปลงผ่าน Date.UTC() แล้วลบ 7
// ชั่วโมงออกเองเสมอ เพื่อให้ได้ UTC instant ที่ถูกต้องจริงๆ
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
function bangkokTimeToUtc(y, mo, d, hr, mn, sec) {
  return new Date(Date.UTC(y, mo, d, hr, mn, sec || 0) - BANGKOK_OFFSET_MS);
}

// ทางกลับกัน — ดึงปี/เดือน/ชั่วโมง "ตามเวลาไทย" จาก Date instant ที่ถูกต้องแล้ว (เช่นจาก bangkokTimeToUtc)
// ห้ามใช้ .getHours()/.getMonth()/.getFullYear() ตรงๆ เพราะจะได้ค่าเวลา UTC กลับมาแทน (runtime นี้เป็น UTC เสมอ)
function toBangkokParts(date) {
  const shifted = new Date(date.getTime() + BANGKOK_OFFSET_MS);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth(), hour: shifted.getUTCHours() };
}

// รับสตริงเวลาแบบ "YYYY-MM-DDTHH:mm[:ss]" หรือ "YYYY-MM-DD HH:mm[:ss]" ที่ไม่มี timezone suffix
// (ถือว่าเป็นเวลาไทยเสมอ) แล้วแปลงเป็น UTC ที่ถูกต้อง — ถ้ามี Z หรือ +hh:mm ต่อท้ายอยู่แล้วให้เชื่อค่านั้นตรงๆ
function parseBangkokIsoLike(s) {
  if (!s) return null;
  const trimmed = String(s).trim();
  if (/[Zz]|[+-]\d{2}:?\d{2}$/.test(trimmed)) {
    const d = new Date(trimmed);
    return isNaN(d) ? null : d;
  }
  const m = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const [, y, mo, d, hr, mi, se] = m.map(Number);
  return bangkokTimeToUtc(y, mo - 1, d, hr, mi, se || 0);
}

function parseNayaxCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const h = lines[0].split(',').map(s => s.trim().toLowerCase().replace(/\r/g, ''));
  const iDt = h.indexOf('machineautime'), iPrice = h.indexOf('auvalue');
  const iMachine = h.indexOf('machine_name');

  function parseDt(s) {
    if (!s) return null;
    const [dp, tp] = s.trim().split(' ');
    const [d, m, y] = (dp || '').split('/').map(Number);
    const [hr, mn] = (tp || '0:0').split(':').map(Number);
    if (!y) return null;
    const fullYear = y < 100 ? y + 2000 : y;
    return bangkokTimeToUtc(fullYear, m - 1, d, hr, mn || 0);
  }

  return lines.slice(1).map(line => {
    const v = line.split(',');
    const g = i => (v[i] || '').trim().replace(/\r/g, '');
    const datetime = parseDt(g(iDt));
    const price = parseFloat(g(iPrice)) || 0;
    return { datetime, price, machine: g(iMachine) };
  }).filter(r => r.datetime && !isNaN(r.datetime) && r.price > 0);
}

// ── รูปลูกค้าหน้าตู้ (visits.html) ──
// รับรูปจาก visits.html -> ให้ Claude ดูรูปประเมินจำนวนคน/มีเด็กมาด้วยไหม -> จับคู่กับยอดขาย Nayax
// ที่เวลาใกล้เคียงที่สุด (ถ้ามีภายใน 5 นาที) -> ส่งต่อให้ Apps Script บันทึกรูป+ข้อมูลลงชีต
const VISIT_MATCH_WINDOW_MS = 5 * 60 * 1000;

async function handleVisitUpload(request, env) {
  const ok = await verifyAuthHeader(request, env);
  if (!ok) return jsonResponse({ error: 'Unauthorized' }, 401);
  // เหมือน expense — ไม่ตั้ง VISIT_SHEET_WEBHOOK_URL แยกก็ได้ ใช้ webhook เดียวกับออเดอร์ส้มแทน
  const webhookUrl = env.VISIT_SHEET_WEBHOOK_URL || env.SHEET_WEBHOOK_URL;
  if (!webhookUrl) {
    return jsonResponse({ error: 'Not configured' }, 500);
  }

  let data;
  try {
    data = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }
  if (!data.imageBase64) {
    return jsonResponse({ error: 'Missing image' }, 400);
  }

  const fallbackTimestamp = data.timestamp ? new Date(data.timestamp) : new Date();
  const mimeType = data.mimeType || 'image/jpeg';

  const analysis = await analyzeVisitPhoto_(env, data.imageBase64, mimeType);

  // ใช้เวลาที่อ่านได้จากตัวรูป (ตู้แปะวัน-เวลาไว้ในรูปอยู่แล้ว) เป็นหลักเสมอถ้า AI อ่านได้ชัดเจน —
  // แม่นยำกว่าเวลาที่พนักงานพิมพ์เอง/เวลาที่กดอัปโหลด ซึ่งอาจห่างจากเวลาถ่ายจริงหลายนาทีถึงหลายชั่วโมง
  let timestamp = fallbackTimestamp, timestampSource = 'manual';
  if (analysis.photoTimestamp) {
    // เวลาที่แปะบนรูป (ตู้/กล้อง) เป็นเวลาไทยเสมอ ไม่มี timezone suffix มาด้วย — ต้องแปลงผ่าน
    // parseBangkokIsoLike ไม่ใช่ new Date() ตรงๆ (ดูคอมเมนต์อธิบายที่ bangkokTimeToUtc ด้านบน)
    const parsed = parseBangkokIsoLike(analysis.photoTimestamp);
    if (parsed && !isNaN(parsed)) { timestamp = parsed; timestampSource = 'photo'; }
  }

  let matchedTxnTime = '', matchedAmount = null;
  if (env.NAYAX_SHEET_CSV_URL) {
    try {
      const res = await fetch(env.NAYAX_SHEET_CSV_URL + (env.NAYAX_SHEET_CSV_URL.includes('?') ? '&' : '?') + 't=' + Date.now());
      const rows = parseNayaxCSV(await res.text());
      let closest = null, closestDiff = Infinity;
      for (const r of rows) {
        const diff = Math.abs(r.datetime.getTime() - timestamp.getTime());
        if (diff < closestDiff) { closestDiff = diff; closest = r; }
      }
      if (closest && closestDiff <= VISIT_MATCH_WINDOW_MS) {
        matchedTxnTime = closest.datetime.toISOString();
        matchedAmount = closest.price;
      }
    } catch (err) {
      console.error('Nayax match lookup failed (non-fatal):', err);
    }
  }

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: 'visit',
        action: 'saveVisit',
        imageBase64: data.imageBase64,
        mimeType,
        timestamp: timestamp.toISOString(),
        peopleCount: analysis.peopleCount,
        hasChildren: analysis.hasChildren,
        gender: analysis.gender,
        notes: analysis.notes,
        matchedTxnTime,
        matchedAmount,
      }),
    });
    const result = await res.json();
    if (!result.success) return jsonResponse({ error: result.error || 'Failed to save visit' }, 502);
    return jsonResponse({
      success: true,
      photoUrl: result.photoUrl,
      timestamp: timestamp.toISOString(),
      timestampSource,
      peopleCount: analysis.peopleCount,
      hasChildren: analysis.hasChildren,
      gender: analysis.gender,
      notes: analysis.notes,
      matchedTxnTime,
      matchedAmount,
    });
  } catch (err) {
    console.error('Visit save failed:', err);
    return jsonResponse({ error: 'Failed to save visit' }, 502);
  }
}

// แก้ไขข้อมูลการมาเยือนที่บันทึกไว้แล้ว (จากหน้า /admin/visits) — ใช้ id (Drive file id ที่ฝังอยู่ใน
// photoUrl) หาแถวที่จะแก้ ส่งต่อให้ Apps Script ผ่าน action: 'updateVisit'
async function handleVisitUpdate(request, env) {
  const ok = await verifyAuthHeader(request, env);
  if (!ok) return jsonResponse({ error: 'Unauthorized' }, 401);
  const webhookUrl = env.VISIT_SHEET_WEBHOOK_URL || env.SHEET_WEBHOOK_URL;
  if (!webhookUrl) return jsonResponse({ error: 'Not configured' }, 500);

  let data;
  try {
    data = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }
  if (!data.id) return jsonResponse({ error: 'Missing id' }, 400);

  const payload = { target: 'visit', action: 'updateVisit', id: data.id };
  if (data.peopleCount != null) payload.peopleCount = Number(data.peopleCount) || 0;
  if (data.hasChildren != null) payload.hasChildren = !!data.hasChildren;
  if (data.gender) payload.gender = data.gender;
  if (data.notes != null) payload.notes = data.notes;
  if (data.timestamp) {
    // ค่าที่ส่งมาจากฟอร์มแก้ไข (input datetime-local) เป็นเวลาไทยเสมอ ไม่มี timezone suffix —
    // ต้องแปลงผ่าน parseBangkokIsoLike เหมือนจุดอื่นๆ ก่อนส่งต่อเป็น ISO UTC ให้ Apps Script
    const parsed = parseBangkokIsoLike(data.timestamp);
    if (parsed && !isNaN(parsed)) payload.timestamp = parsed.toISOString();
  }

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await res.json();
    if (!result.success) return jsonResponse({ error: result.error || 'Failed to update visit' }, 502);
    return jsonResponse({ success: true });
  } catch (err) {
    console.error('Visit update failed:', err);
    return jsonResponse({ error: 'Failed to update visit' }, 502);
  }
}

// เรียก Gemini ดูรูปแล้วประเมินจำนวนคน/มีเด็กมาด้วยไหม — ใช้ GEMINI_API_KEY ตัวเดียวกับที่ผู้ช่วย
// AI แปลงข้อความออเดอร์ในกลุ่มไลน์ใช้อยู่แล้ว (ดู parseOrderWithAI ด้านบน) ไม่ต้องเพิ่ม secret ใหม่
// ถ้าวิเคราะห์ไม่สำเร็จก็ยังบันทึกรูปได้ปกติ แค่ปล่อยให้ค่าพวกนี้เป็น null ไม่ทำให้การอัปโหลดทั้งหมดล้มเหลวไปด้วย
async function analyzeVisitPhoto_(env, imageBase64, mimeType) {
  if (!env.GEMINI_API_KEY) {
    return { peopleCount: null, hasChildren: null, gender: null, notes: 'GEMINI_API_KEY not configured' };
  }
  const prompt = 'This photo was taken by a vending machine\'s front-facing camera at the moment of a purchase. ' +
    'Count how many people are visible who appear to be customers at the machine (ignore anyone clearly just ' +
    'passing by in the background). Note whether any of them appear to be children (roughly under 12 years old). ' +
    'Also give your best guess at the apparent gender mix of the visible customers. ' +
    'The camera also burns a date/time stamp as text somewhere on the photo (usually a corner) — read it exactly ' +
    'as printed (it is local Thailand time, do NOT add any timezone suffix) and convert it to ' +
    'YYYY-MM-DDTHH:mm:ss format. ' +
    'Respond with a JSON object: {"peopleCount": <integer>, "hasChildren": <true or false>, ' +
    '"gender": <one of "male", "female", "mixed" (both present), or "unknown" (cannot tell / no one visible)>, ' +
    '"notes": "<one short phrase, e.g. \'two adults, one child\' or \'single customer\'>", ' +
    '"photoTimestamp": "<YYYY-MM-DDTHH:mm:ss datetime read from the stamp on the photo, or null if no timestamp is visible/legible>"}. ' +
    'If you cannot see any people clearly, use peopleCount: 0, hasChildren: false, gender: "unknown".';

  try {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', {
      method: 'POST',
      headers: {
        'x-goog-api-key': env.GEMINI_API_KEY,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            { inline_data: { mime_type: mimeType, data: imageBase64 } },
            { text: prompt },
          ],
        }],
        // บังคับให้ตอบเป็น JSON ล้วนๆ ที่ฝั่ง API เลย กันปัญหาโมเดลพันด้วย markdown fence หรือพูดนำ/พูดต่อท้าย
        generationConfig: { responseMimeType: 'application/json' },
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini API error ${res.status}: ${errText.slice(0, 300)}`);
    }
    const data = await res.json();
    if (data.promptFeedback && data.promptFeedback.blockReason) {
      throw new Error('Blocked by Gemini safety filter: ' + data.promptFeedback.blockReason);
    }
    const candidate = data.candidates && data.candidates[0];
    if (candidate && candidate.finishReason && candidate.finishReason !== 'STOP') {
      throw new Error('Gemini did not finish normally: ' + candidate.finishReason);
    }
    const raw = (candidate && candidate.content && candidate.content.parts && candidate.content.parts[0] && candidate.content.parts[0].text) || '';
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Gemini response did not contain JSON: ' + raw.slice(0, 200));
    const parsed = JSON.parse(match[0]);
    const validGenders = ['male', 'female', 'mixed', 'unknown'];
    return {
      peopleCount: Number.isFinite(parsed.peopleCount) ? parsed.peopleCount : null,
      hasChildren: typeof parsed.hasChildren === 'boolean' ? parsed.hasChildren : null,
      gender: validGenders.includes(parsed.gender) ? parsed.gender : null,
      notes: parsed.notes || '',
      photoTimestamp: parsed.photoTimestamp || null,
    };
  } catch (err) {
    console.error('Gemini vision analysis failed (non-fatal):', err);
    // ใส่ข้อความ error จริงลงใน notes (ไม่ใช่แค่ "AI analysis failed" เฉยๆ) เพื่อให้เห็นสาเหตุจริงจาก
    // หน้าประวัติ/ชีตได้เลย โดยไม่ต้องเข้าไปดู Worker logs — หน้านี้เป็นแอดมินภายในอยู่แล้วไม่มีความเสี่ยง
    return { peopleCount: null, hasChildren: null, gender: null, notes: 'AI analysis failed: ' + (err && err.message ? err.message.slice(0, 200) : String(err)) };
  }
}

async function verifyAuthHeader(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return false;
  return verifyToken(token, env.SESSION_SECRET);
}

// ── Token: base64url(payload) + "." + base64url(HMAC-SHA256(payload)) ──
// Worker เป็น stateless เลยเซ็นชื่อ expiry ไว้ในตัว token เอง แทนที่จะเก็บ session ไว้ที่ server

async function createToken(secret) {
  const payload = JSON.stringify({ exp: Date.now() + SESSION_TTL_MS });
  const payloadB64 = toBase64Url(payload);
  const sig = await hmac(secret, payloadB64);
  return `${payloadB64}.${sig}`;
}

async function verifyToken(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payloadB64, sig] = parts;

  const expectedSig = await hmac(secret, payloadB64);
  if (!timingSafeEqual(sig, expectedSig)) return false;

  try {
    const payload = JSON.parse(fromBase64Url(payloadB64));
    return typeof payload.exp === 'number' && Date.now() < payload.exp;
  } catch {
    return false;
  }
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return toBase64Url(String.fromCharCode(...new Uint8Array(sig)));
}

function toBase64Url(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(str) {
  return atob(str.replace(/-/g, '+').replace(/_/g, '/'));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ══════════════════════════════════════════════════════════════════════
// AI order assistant — อ่านข้อความในกลุ่มไลน์แอดมิน แปลงเป็นออเดอร์แล้วบันทึกลงชีตทันที
// รอแอดมินกดยืนยันก่อนเขียนลงชีตจริงเสมอ (ไม่มี auto-save)
// ══════════════════════════════════════════════════════════════════════

async function handleLineWebhook(request, env, ctx) {
  // ต้องอ่านเป็น text ดิบก่อน (ไม่ใช่ .json()) เพราะลายเซ็นคำนวณจาก raw body bytes
  const bodyText = await request.text();
  const signature = request.headers.get('X-Line-Signature') || '';

  const validSig = await verifyLineSignature(bodyText, signature, env.LINE_CHANNEL_SECRET);
  if (!validSig) return new Response('Invalid signature', { status: 401 });

  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const events = Array.isArray(payload.events) ? payload.events : [];
  for (const event of events) {
    const isAdminGroup = event.source && event.source.type === 'group' && event.source.groupId === ADMIN_GROUP_ID;
    const isDirectMessage = event.source && event.source.type === 'user';

    // ตอบ LINE ให้เร็วที่สุด (200 ทันที) แล้วประมวลผลจริงต่อเบื้องหลังผ่าน waitUntil
    // เพราะเรียก Gemini + อ่านชีต/รูปภาพอาจใช้เวลาหลายวินาที ไม่ควรให้ LINE รอ
    if (isAdminGroup) {
      if (event.type === 'message' && event.message && event.message.type === 'text') {
        ctx.waitUntil(handleIncomingText(event, env).catch(err => console.error('handleIncomingText error:', err)));
      } else if (event.type === 'postback') {
        ctx.waitUntil(handlePostback(event, env).catch(err => console.error('handlePostback error:', err)));
      }
    } else if (isDirectMessage && event.type === 'message' && event.message && event.message.type === 'image') {
      // แชท 1:1 กับลูกค้า — แจ้งเตือนกลุ่มแอดมินพร้อมปุ่มให้กดส่งลิงก์บัตรสะสมแต้ม (ไม่มีการตรวจสอบรูปอัตโนมัติใดๆ)
      ctx.waitUntil(handleSlipImage(event, env).catch(err => console.error('handleSlipImage error:', err)));
    }
  }

  return new Response('OK', { status: 200 });
}

// LINE เซ็นลายเซ็นเป็น base64(HMAC-SHA256(channelSecret, rawBody)) มาตรฐาน (ไม่ใช่ base64url)
async function verifyLineSignature(bodyText, signatureB64, channelSecret) {
  if (!channelSecret || !signatureB64) return false;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(channelSecret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(bodyText));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return timingSafeEqual(expected, signatureB64);
}

// ประวัติลูกค้า group ตามชื่อ (ตรรกะเดียวกับ customers.html: groupByCustomer) แคชไว้ใน KV
// 5 นาที กันยิงไป Google Sheets ซ้ำทุกข้อความที่พิมพ์เข้ามาในกลุ่ม
async function getCustomerHistory(env) {
  const cacheKey = 'customer_history';
  if (env.OFRESH_KV) {
    const cached = await env.OFRESH_KV.get(cacheKey, { type: 'json' });
    if (cached) return cached;
  }

  if (!env.ORDERS_SHEET_CSV_URL) return [];

  const res = await fetch(env.ORDERS_SHEET_CSV_URL);
  const text = await res.text();
  const rows = parseOrdersCSVFull(text);

  const map = new Map();
  rows.forEach(r => {
    if (!r.name) return;
    if (!map.has(r.name)) map.set(r.name, []);
    map.get(r.name).push(r);
  });

  const customers = Array.from(map.values()).map(orders => {
    orders.sort((a, b) => b.datetime - a.datetime);
    const latest = orders[0];
    return {
      name: latest.name,
      phone: latest.phone,
      line: latest.line,
      address: latest.address,
      typicalQty: latest.qty,
      orderCount: orders.length,
      lastOrderDate: latest.datetime.toISOString().slice(0, 10),
    };
  });

  if (env.OFRESH_KV) {
    await env.OFRESH_KV.put(cacheKey, JSON.stringify(customers), { expirationTtl: CUSTOMER_HISTORY_TTL_SECONDS });
  }
  return customers;
}

// เหมือน parseOrdersCSV ที่มีอยู่แล้ว แต่ดึงฟิลด์ครบสำหรับจับคู่ประวัติลูกค้า (ไม่ใช่แค่ datetime/qty)
function parseOrdersCSVFull(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const h = splitCSVLine(lines[0]).map(s => s.trim().toLowerCase().replace(/\r/g, ''));
  const iTs = h.indexOf('timestamp'), iName = h.indexOf('name'), iPhone = h.indexOf('phone'),
        iLine = h.indexOf('line'), iQty = h.indexOf('qty'), iAddress = h.indexOf('address');

  return lines.slice(1).map(line => {
    const v = splitCSVLine(line);
    const g = i => (v[i] || '').trim().replace(/\r/g, '');
    const datetime = parseTimestamp(g(iTs));
    const qty = parseFloat(g(iQty)) || 0;
    return { datetime, name: g(iName), phone: g(iPhone), line: g(iLine), qty, address: g(iAddress) };
  }).filter(r => r.datetime && !isNaN(r.datetime) && r.name);
}

// เลือกเฉพาะลูกค้าที่มีแนวโน้มเกี่ยวข้องกับข้อความนี้ (ชื่อ/เบอร์ปรากฏในข้อความ) ส่งให้ Gemini
// แทนที่จะส่งประวัติทั้งหมด — ประหยัด token และลดโอกาส Gemini สับสนจับคู่ผิดคนจากลูกค้าที่ไม่เกี่ยวข้อง
function prefilterCustomers(text, customers, limit = 8) {
  const lower = text.toLowerCase();
  // ดึงเฉพาะ "กลุ่มตัวเลขติดกัน 4 หลักขึ้นไป" แทนการรวมตัวเลขทั้งข้อความเป็นก้อนเดียว
  // เพราะถ้ารวมทั้งหมด ตัวเลขปลีกย่อยอื่น (เช่น จำนวนกิโล, วันที่) จะไปปนกับเบอร์โทรจนจับคู่ผิด
  const digitRuns = text.match(/\d{4,}/g) || [];
  const scored = customers.map(c => {
    let score = 0;
    const nameLower = (c.name || '').toLowerCase();
    if (nameLower && lower.includes(nameLower)) score += 3;
    else if (nameLower) {
      // เผื่อแอดมินพิมพ์แค่ชื่อจริงหรือนามสกุล ไม่ใช่ชื่อเต็ม (เช่น "พี่สมชาย" ไม่ใช่ "สมชาย ใจดี")
      const parts = nameLower.split(/\s+/).filter(p => p.length >= 2);
      if (parts.some(p => lower.includes(p))) score += 2;
    }
    if (c.phone) {
      const tail = c.phone.slice(-4);
      if (digitRuns.some(run => run.includes(tail))) score += 3;
    }
    if (c.address) {
      const addrWords = c.address.split(/\s+/).filter(w => w.length >= 3);
      if (addrWords.some(w => lower.includes(w.toLowerCase()))) score += 1;
    }
    return { c, score };
  });
  const matched = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score).map(s => s.c);
  if (matched.length > 0) return matched.slice(0, limit);
  // ไม่เจอใครตรงเลย — ส่งลูกค้าที่สั่งบ่อยสุด 2-3 คนไปเป็น context กว้างๆ เผื่อ Gemini ช่วยจับคู่ชื่อคล้ายได้
  return customers.slice().sort((a, b) => b.orderCount - a.orderCount).slice(0, 3);
}

async function parseOrderFromMessage(text, customers, env) {
  const knownCustomers = prefilterCustomers(text, customers);

  const systemPrompt = [
    'คุณคือผู้ช่วยแปลงข้อความแจ้งออเดอร์ส้มที่แอดมินพิมพ์ในแชทกลุ่ม ให้เป็นออเดอร์แบบมีโครงสร้าง',
    'ตอบกลับเป็น JSON ล้วนๆ เท่านั้น ห้ามมีข้อความอื่นนอก JSON และห้ามใช้ markdown code fence',
    'รูปแบบ JSON ที่ต้องตอบ:',
    '{"isOrder":boolean,"name":string,"phone":string,"line":string,"qty":number,"address":string,"deliveryDate":string|null,"note":string,"confidence":number,"missingFields":string[],"matchedCustomer":string|null}',
    '- isOrder: false ถ้าข้อความนี้ไม่ได้พูดถึงการสั่งซื้อส้มเลย (เช่น ทักทาย คุยเรื่องอื่น) — ฟิลด์อื่นใส่ค่าว่าง/0 ได้',
    '- ราคาส้ม 60 บาทต่อกิโลกรัม ถ้าไม่ได้ระบุจำนวนเงินในข้อความ ไม่ต้องคำนวณ total เอง (ไม่มีฟิลด์ total ในผลลัพธ์)',
    '- deliveryDate: แปลงเป็น YYYY-MM-DD ถ้าระบุมา (เช่น "พรุ่งนี้" ให้คำนวณจากวันที่ปัจจุบันที่ให้ไว้) ไม่งั้นใส่ null',
    '- confidence (0-1): มั่นใจแค่ไหนว่า parse ถูกต้องครบถ้วนและจับคู่ลูกค้าถูกคน ถ้าชื่อ/เบอร์กำกวมหรือจับคู่ได้หลายคน ให้ confidence ต่ำ',
    '- missingFields: รายชื่อฟิลด์ที่จำเป็น (name, phone, qty, address) ที่ยังขาดหรือไม่ชัดเจน',
    '- matchedCustomer: ชื่อลูกค้าจากประวัติที่ตรงกับข้อความนี้ (ถ้ามี) ใส่ตามชื่อในประวัติเป๊ะๆ ไม่งั้นใส่ null',
    `วันที่ปัจจุบัน (เวลาไทย): ${new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' })}`,
  ].join('\n');

  const userContent = JSON.stringify({
    message: text,
    customerHistory: knownCustomers,
  });

  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', {
    method: 'POST',
    headers: {
      'x-goog-api-key': env.GEMINI_API_KEY,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userContent }] }],
      // บังคับให้ตอบเป็น JSON ล้วนๆ ที่ฝั่ง API เลย กันปัญหาโมเดลพันด้วย markdown fence หรือพูดนำ/พูดต่อท้าย
      generationConfig: { responseMimeType: 'application/json' },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const candidate = data.candidates && data.candidates[0];
  const raw = (candidate && candidate.content && candidate.content.parts && candidate.content.parts[0] && candidate.content.parts[0].text) || '';
  // responseMimeType บังคับ JSON ไว้แล้ว แต่ยังกันเผื่อมีอะไรแวดล้อมหลุดมาบ้าง ดึงเฉพาะ { ... } ตัวแรกที่สมบูรณ์
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Gemini response did not contain JSON: ' + raw.slice(0, 200));

  const parsed = JSON.parse(match[0]);
  return {
    isOrder: !!parsed.isOrder,
    name: parsed.name || '',
    phone: parsed.phone || '',
    line: parsed.line || '',
    qty: Number(parsed.qty) || 0,
    address: parsed.address || '',
    deliveryDate: parsed.deliveryDate || '',
    note: parsed.note || '',
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
    missingFields: Array.isArray(parsed.missingFields) ? parsed.missingFields : [],
    matchedCustomer: parsed.matchedCustomer || null,
  };
}

function generateOrderId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

async function replyToLine(env, replyToken, messages) {
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.LINE_CHANNEL_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ replyToken, messages }),
  });
  if (!res.ok) {
    console.error('LINE reply error:', await res.text());
  }
}

function buildOrderSummaryText(order) {
  const deliveryDateText = order.deliveryDate
    ? new Date(order.deliveryDate + 'T00:00:00').toLocaleDateString('th-TH', { day: 'numeric', month: 'long', year: 'numeric' })
    : null;
  return [
    '🍊 บันทึกออเดอร์จากข้อความ',
    '─────────────────',
    `👤 ชื่อ: ${order.name || '(ไม่ระบุ)'}`,
    order.phone ? `📞 เบอร์: ${order.phone}` : null,
    order.line ? `💬 LINE: ${order.line}` : null,
    `⚖️ จำนวน: ${order.qty || '(ไม่ระบุ)'} กก.`,
    order.address ? `📍 ที่อยู่: ${order.address}` : `📍 ที่อยู่: (ไม่ระบุ)`,
    deliveryDateText ? `📅 วันที่ต้องการของ: ${deliveryDateText}` : null,
    order.note ? `📝 หมายเหตุ: ${order.note}` : null,
    order.matchedCustomer ? `✅ จับคู่กับลูกค้าเดิม: ${order.matchedCustomer}` : null,
    order.missingFields && order.missingFields.length ? `⚠️ ข้อมูลที่ยังขาด: ${order.missingFields.join(', ')}` : null,
  ].filter(Boolean).join('\n');
}

// ปุ่มเดียวแนบไปกับข้อความสรุปหลังบันทึกทุกครั้ง — ทางแก้เร็วสุดถ้า AI จับคู่ผิดคนหรือ parse ผิด
// (แก้รายละเอียดอื่นๆ นอกจากยกเลิก ทำในแดชบอร์ด orderstats.html แทน)
function cancelQuickReply(orderId) {
  return {
    items: [
      { type: 'action', action: { type: 'postback', label: '↩️ ยกเลิกออเดอร์นี้', data: `cancel:${orderId}`, displayText: 'ยกเลิกออเดอร์นี้' } },
    ],
  };
}

// ══════════════════════════════════════════════════════════════════════
// Reward-card auto-reply — ลูกค้าทัก DM ส่งรูปสลิป
// เช็คยอดเงินอัตโนมัติด้วย Gemini vision (แค่ตัวเลขยอด ไม่เช็ควันที่/ชื่อบัญชี) ถ้ายอดตรง 69 บาทชัดเจน
// ส่งลิงก์บัตรสะสมแต้มให้ลูกค้าทันที — ถ้าอ่านไม่ออก/ไม่ตรง/error ระหว่างทาง fallback ไปแจ้งกลุ่มแอดมิน
// พร้อมปุ่มให้กดส่งเอง (ทางสำรองเดิม)
// ══════════════════════════════════════════════════════════════════════

// ส่งข้อความแบบ push (ต่างจาก replyToLine ตรงที่ยิงหา groupId/userId ตรงๆ ได้ ไม่ต้องมี replyToken สดๆ)
// return ค่าสำเร็จ/ไม่สำเร็จ ให้ผู้เรียกตัดสินใจต่อได้ (เช่น handleSlipImage เช็คว่า push ลิงก์อัตโนมัติสำเร็จจริงไหม)
async function pushToLine(env, to, messages) {
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.LINE_CHANNEL_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ to, messages }),
  });
  if (!res.ok) {
    console.error('LINE push error:', await res.text());
    return false;
  }
  return true;
}

function sendRewardQuickReply(shortId) {
  return {
    items: [
      { type: 'action', action: { type: 'postback', label: '🎁 ส่งลิงก์บัตรสะสมแต้ม', data: `sendreward:${shortId}`, displayText: 'ส่งลิงก์บัตรสะสมแต้มให้ลูกค้า' } },
    ],
  };
}

// ข้อความขอบคุณ + ลิงก์บัตรสะสมแต้ม — ใช้ร่วมกันทั้งเส้นทางอัตโนมัติ (handleSlipImage) และเส้นทางกดปุ่มเอง (handlePostback)
function buildRewardText(env) {
  return `ขอบคุณสำหรับการอุดหนุนกดน้ำส้มคั้นสดนะคะ 🎉🍊\nนี่คือบัตรสะสมแต้มของคุณค่ะ:\n${env.LINE_REWARD_CARD_URL}`;
}

// ดึงชื่อ LINE ของลูกค้า — ใช้แค่ประกอบข้อความแจ้งกลุ่มแอดมิน ถ้าดึงไม่ได้ (เช่น ลูกค้ายังไม่ได้แอด/บล็อก OA ไปแล้ว)
// ให้ null เฉยๆ ไม่ throw กระทบ flow หลัก
async function getLineDisplayName(env, userId) {
  try {
    const res = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, {
      headers: { 'Authorization': `Bearer ${env.LINE_CHANNEL_TOKEN}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.displayName || null;
  } catch (err) {
    console.error('getLineDisplayName failed:', err);
    return null;
  }
}

// ดึงรูปจริงจาก LINE Content API ด้วย message id
async function fetchLineImageContent(env, messageId) {
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { 'Authorization': `Bearer ${env.LINE_CHANNEL_TOKEN}` },
  });
  if (!res.ok) {
    throw new Error(`LINE content API error ${res.status}: ${await res.text()}`);
  }
  const mimeType = res.headers.get('Content-Type') || 'image/jpeg';
  const buffer = await res.arrayBuffer();
  return { buffer, mimeType };
}

// เข้ารหัส ArrayBuffer เป็น base64 แบบ chunk — ห้ามใช้ btoa(String.fromCharCode(...bytes)) ตรงๆ กับ array ใหญ่ๆ
// (รูปสลิปหลายร้อย KB) เพราะ spread จะชน argument-list limit ของ JS engine
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK_SIZE = 8192;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + CHUNK_SIZE);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

// เช็คแค่ตัวเลขยอดเงินจากรูปสลิปอย่างเดียว (ไม่เช็ควันที่/ชื่อบัญชี) — ใช้แพทเทิร์นเดียวกับ parseOrderFromMessage
async function checkSlipAmount(imageBase64, mimeType, env) {
  const systemPrompt = [
    'คุณคือผู้ช่วยอ่านยอดเงินจากรูปสลิปโอนเงินธนาคารไทย',
    'ตอบกลับเป็น JSON ล้วนๆ เท่านั้น ห้ามมีข้อความอื่นนอก JSON และห้ามใช้ markdown code fence',
    'รูปแบบ JSON ที่ต้องตอบ: {"amount":number|null}',
    '- amount: จำนวนเงินที่โอน หน่วยบาท เป็นตัวเลขล้วนๆ ไม่ใส่หน่วยหรือคอมมา ถ้าอ่านไม่ออกหรือรูปนี้ไม่ใช่สลิปโอนเงินเลยให้ null',
  ].join('\n');

  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', {
    method: 'POST',
    headers: {
      'x-goog-api-key': env.GEMINI_API_KEY,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ inline_data: { mime_type: mimeType, data: imageBase64 } }] }],
      generationConfig: { responseMimeType: 'application/json' },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const candidate = data.candidates && data.candidates[0];
  const raw = (candidate && candidate.content && candidate.content.parts && candidate.content.parts[0] && candidate.content.parts[0].text) || '';
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Gemini response did not contain JSON: ' + raw.slice(0, 200));

  const parsed = JSON.parse(match[0]);
  const amount = parsed.amount != null && !isNaN(Number(parsed.amount)) ? Number(parsed.amount) : null;
  return { amount };
}

// ทางสำรอง (เดิมจาก Phase 1) — เก็บ userId ชั่วคราวรอแอดมินกดปุ่ม แล้วแจ้งกลุ่มแอดมินพร้อมปุ่ม
async function notifyAdminForManualReview(event, env, reasonSuffix) {
  const shortId = generateOrderId();
  // เก็บ userId ของลูกค้าไว้ชั่วคราว รอแอดมินกดปุ่มในกลุ่ม (replyToken ตอนนี้จะหมดอายุก่อนแอดมินทันเวลา
  // เลยต้องใช้ push API ยิงหา userId นี้ตรงๆ ทีหลัง ไม่ใช่ reply API)
  await env.OFRESH_KV.put(
    `slipuser:${shortId}`,
    JSON.stringify({ userId: event.source.userId }),
    { expirationTtl: 86400 }
  );

  await pushToLine(env, ADMIN_GROUP_ID, [{
    type: 'text',
    text: `📸 มีลูกค้าส่งรูปสลิปมาในแชท OA${reasonSuffix || ''} — เช็ครูปในแชทเอง แล้วกดปุ่มด้านล่างถ้าถูกต้อง`,
    quickReply: sendRewardQuickReply(shortId),
  }]);
}

async function handleSlipImage(event, env) {
  // ตอบลูกค้าทันทีเป็นอย่างแรก (ใช้ replyToken ที่ยังสดอยู่) ก่อนไปทำงานที่ช้ากว่า (ดึงรูป + เรียก Gemini)
  try {
    await replyToLine(env, event.replyToken, [
      { type: 'text', text: 'ได้รับรูปแล้วค่ะ 🙏 รอสักครู่นะคะ' },
    ]);
  } catch (err) {
    console.error('handleSlipImage ack reply failed:', err);
  }

  try {
    const { buffer, mimeType } = await fetchLineImageContent(env, event.message.id);
    const imageBase64 = arrayBufferToBase64(buffer);
    const { amount } = await checkSlipAmount(imageBase64, mimeType, env);

    const amountOk = typeof amount === 'number' && Math.abs(amount - 69) < 0.01;

    if (amountOk && env.LINE_REWARD_CARD_URL) {
      const sent = await pushToLine(env, event.source.userId, [{ type: 'text', text: buildRewardText(env) }]);
      if (sent) {
        const displayName = await getLineDisplayName(env, event.source.userId);
        const who = displayName ? `คุณ ${displayName} ` : 'ลูกค้า';
        await pushToLine(env, ADMIN_GROUP_ID, [{
          type: 'text',
          text: `✅ ตรวจพบยอด 69 บาท ส่งลิงก์บัตรสะสมแต้มให้${who}อัตโนมัติแล้วครับ`,
        }]);
        return;
      }
    }

    // ยอดไม่ตรง/อ่านไม่ออก/ยังไม่ตั้ง secret/push อัตโนมัติล้มเหลว — ตกไปทางสำรองให้แอดมินกดเอง
    await notifyAdminForManualReview(event, env, ' (ระบบตรวจยอดอัตโนมัติไม่ผ่าน/ไม่ชัดเจน)');
  } catch (err) {
    console.error('handleSlipImage amount check failed:', err);
    try {
      await notifyAdminForManualReview(event, env, ' (ระบบตรวจยอดอัตโนมัติไม่ผ่าน/ไม่ชัดเจน)');
    } catch (err2) {
      console.error('handleSlipImage fallback notify also failed:', err2);
    }
  }
}

async function saveOrderToSheet(env, order, id) {
  if (!env.SHEET_WEBHOOK_URL) throw new Error('SHEET_WEBHOOK_URL not configured');
  const total = (order.qty || 0) * ORDER_PRICE_PER_KG;
  await fetch(env.SHEET_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id, name: order.name, phone: order.phone, line: order.line,
      qty: order.qty, total, address: order.address,
      deliveryDate: order.deliveryDate, note: order.note,
    }),
  });
}

async function cancelOrderInSheet(env, id) {
  if (!env.SHEET_WEBHOOK_URL) throw new Error('SHEET_WEBHOOK_URL not configured');
  await fetch(env.SHEET_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ action: 'updateStatus', id, status: 'cancelled' }),
  });
}

// รับข้อความใหม่จากกลุ่ม — parse แล้วบันทึกลงชีตทันที ไม่มีขั้นตอนยืนยัน
async function handleIncomingText(event, env) {
  const text = event.message.text;
  const replyToken = event.replyToken;

  const customers = await getCustomerHistory(env);
  let parsed;
  try {
    parsed = await parseOrderFromMessage(text, customers, env);
  } catch (err) {
    console.error('parseOrderFromMessage failed:', err);
    await replyToLine(env, replyToken, [{ type: 'text', text: '⚠️ บอทอ่านข้อความนี้ไม่สำเร็จ รบกวนพิมพ์รายละเอียดออเดอร์อีกครั้งครับ' }]);
    return;
  }

  if (!parsed.isOrder) return; // ข้อความคุยเล่นทั่วไป ไม่ใช่ออเดอร์ — เงียบไว้ ไม่ตอบกลับ

  const orderId = generateOrderId();
  try {
    await saveOrderToSheet(env, parsed, orderId);
  } catch (err) {
    console.error('saveOrderToSheet failed:', err);
    await replyToLine(env, replyToken, [{ type: 'text', text: '⚠️ บันทึกออเดอร์ไม่สำเร็จ รบกวนกรอกในแดชบอร์ดเองหรือลองพิมพ์ใหม่อีกครั้งครับ' }]);
    return;
  }

  await replyToLine(env, replyToken, [
    { type: 'text', text: buildOrderSummaryText(parsed) },
    { type: 'text', text: '✅ บันทึกออเดอร์นี้แล้วครับ', quickReply: cancelQuickReply(orderId) },
  ]);
}

async function handlePostback(event, env) {
  const data = event.postback.data || '';
  const sep = data.indexOf(':');
  if (sep === -1) return;
  const action = data.slice(0, sep);
  const orderId = data.slice(sep + 1);
  const replyToken = event.replyToken;

  if (action === 'cancel') {
    try {
      await cancelOrderInSheet(env, orderId);
      await replyToLine(env, replyToken, [{ type: 'text', text: '↩️ ยกเลิกออเดอร์นี้แล้วครับ' }]);
    } catch (err) {
      console.error('cancelOrderInSheet failed:', err);
      await replyToLine(env, replyToken, [{ type: 'text', text: '⚠️ ยกเลิกไม่สำเร็จ รบกวนแก้สถานะในแดชบอร์ดแทนครับ' }]);
    }
  } else if (action === 'sendreward') {
    const shortId = orderId; // ตัวแปรชื่อ orderId เดิม แต่ในเคสนี้คือ shortId ของ handleSlipImage
    try {
      if (!env.LINE_REWARD_CARD_URL) throw new Error('LINE_REWARD_CARD_URL secret not configured');

      const stored = await env.OFRESH_KV.get(`slipuser:${shortId}`, { type: 'json' });
      if (!stored || !stored.userId) {
        await replyToLine(env, replyToken, [{ type: 'text', text: '⚠️ หาไม่เจอหรือหมดเวลาแล้ว อาจกดซ้ำหรือเกิน 24 ชม. ลองส่งเองแทนครับ' }]);
        return;
      }

      await pushToLine(env, stored.userId, [{ type: 'text', text: buildRewardText(env) }]);
      await env.OFRESH_KV.delete(`slipuser:${shortId}`); // กันกดซ้ำ

      await replyToLine(env, replyToken, [{ type: 'text', text: '✅ ส่งลิงก์บัตรสะสมแต้มให้ลูกค้าแล้วครับ' }]);
    } catch (err) {
      console.error('sendreward postback failed:', err);
      await replyToLine(env, replyToken, [{ type: 'text', text: '⚠️ ส่งลิงก์ไม่สำเร็จ รบกวนลองใหม่หรือส่งเองแทนครับ' }]);
    }
  }
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', ...extraHeaders },
  });
}
