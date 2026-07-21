/**
 * O'Fresh Order API — Cloudflare Worker
 *
 * Deploy เป็น Worker ใหม่แยกต่างหาก แล้วตั้ง Environment Secret:
 *   LINE_CHANNEL_TOKEN     = <Channel Access Token จาก LINE Developers>
 *   LINE_CHANNEL_SECRET    = <Channel Secret จาก LINE Developers — คนละค่ากับ LINE_CHANNEL_TOKEN
 *                             ใช้ตรวจลายเซ็น webhook ที่ยิงเข้ามา (ป้องกันคนปลอม request มาสร้าง/ยืนยันออเดอร์)>
 *   ANTHROPIC_API_KEY      = <API key จาก console.anthropic.com — ใช้ให้ Claude Haiku ช่วยอ่าน/แปลง
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
 *
 * ต้องเพิ่ม KV namespace binding ชื่อ OFRESH_KV ด้วย (Settings → Bindings → KV Namespace บน dashboard)
 * ใช้เก็บ cache ประวัติลูกค้า + draft ออเดอร์ที่รอแอดมินกดยืนยัน
 *
 * และต้องเปิด "Use webhook" ในหน้า LINE Developers Console ของ channel เดิม แล้วตั้ง Webhook URL
 * เป็น https://<worker-domain>/api/line/webhook (บอทถูกเพิ่มเข้ากลุ่ม O'Fresh_admin อยู่แล้วจากการ push
 * แจ้งเตือนเดิม ไม่ต้องเชิญใหม่)
 *
 * ADMIN_GROUP_ID ตั้งค่าไว้ใน code ด้านล่างได้เลย (ไม่ใช่ข้อมูลลับ)
 */

const ADMIN_GROUP_ID = 'C6cb7cc0124997383e2066d971d5d0819'; // LINE group: O'Fresh_admin
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 ชั่วโมง

// ── AI order-draft assistant (กลุ่มไลน์แอดมิน) ──
// นโยบายเวอร์ชันแรก: ไม่มี auto-save เด็ดขาด ไม่ว่า AI จะมั่นใจแค่ไหน — ทุกออเดอร์ต้องให้แอดมินกด
// "ยืนยัน" เองก่อนจึงจะเขียนลงชีตจริง เพราะถ้า AI จับคู่ลูกค้าผิดคนหรือ parse ผิดแบบมั่นใจสูงโดยไม่รู้ตัว
// ออเดอร์ที่ผิดอาจถูกแพ็ค/จัดส่งจริงก่อนแอดมินทันเห็น ต่างจากงานแก้ไขในแดชบอร์ดที่ reverse ได้ง่าย
const CUSTOMER_HISTORY_TTL_SECONDS = 5 * 60;
const DRAFT_TTL_SECONDS = 30 * 60;
const EDITING_FLAG_TTL_SECONDS = 10 * 60;
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

// เอนด์พอยต์สาธารณะสำหรับหน้าแรก — คืนแค่ตัวเลขสรุป (ไม่มีข้อมูลลูกค้า/ธุรกรรมดิบ) จึงไม่ต้องใช้ PIN
async function handlePublicHighlights(request, env) {
  if (!env.NAYAX_SHEET_CSV_URL) return jsonResponse({ error: 'Not configured' }, 500);

  try {
    const res = await fetch(env.NAYAX_SHEET_CSV_URL + (env.NAYAX_SHEET_CSV_URL.includes('?') ? '&' : '?') + 't=' + Date.now());
    const text = await res.text();
    const rows = parseNayaxCSV(text);

    const totalCups = rows.length;

    // ชั่วโมงยอดนิยม — ดูเฉพาะเดือนปัจจุบัน (เวลาไทย) เพื่อสะท้อนพฤติกรรมล่าสุด ไม่ใช่ค่าเฉลี่ยสะสมทั้งหมด
    const nowBangkok = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
    const curYear = nowBangkok.getFullYear(), curMonth = nowBangkok.getMonth();
    const monthRows = rows.filter(r => r.datetime.getFullYear() === curYear && r.datetime.getMonth() === curMonth);
    const hourCounts = Array(24).fill(0);
    monthRows.forEach(r => hourCounts[r.datetime.getHours()]++);
    const peakHour = hourCounts.every(c => c === 0) ? null : hourCounts.indexOf(Math.max(...hourCounts));

    return jsonResponse(
      { totalCups, peakHour },
      200,
      { 'Cache-Control': 'public, max-age=300' }
    );
  } catch (err) {
    console.error('Public highlights error:', err);
    return jsonResponse({ error: 'Failed to compute highlights' }, 502);
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

function parseNayaxCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const h = lines[0].split(',').map(s => s.trim().toLowerCase().replace(/\r/g, ''));
  const iDt = h.indexOf('machineautime'), iPrice = h.indexOf('auvalue');

  function parseDt(s) {
    if (!s) return null;
    const [dp, tp] = s.trim().split(' ');
    const [d, m, y] = (dp || '').split('/').map(Number);
    const [hr, mn] = (tp || '0:0').split(':').map(Number);
    if (!y) return null;
    const fullYear = y < 100 ? y + 2000 : y;
    return new Date(fullYear, m - 1, d, hr, mn || 0);
  }

  return lines.slice(1).map(line => {
    const v = line.split(',');
    const g = i => (v[i] || '').trim().replace(/\r/g, '');
    const datetime = parseDt(g(iDt));
    const price = parseFloat(g(iPrice)) || 0;
    return { datetime, price };
  }).filter(r => r.datetime && !isNaN(r.datetime) && r.price > 0);
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
// AI order-draft assistant — อ่านข้อความในกลุ่มไลน์แอดมิน แปลงเป็นออเดอร์ร่าง
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
    if (!isAdminGroup) continue;

    // ตอบ LINE ให้เร็วที่สุด (200 ทันที) แล้วประมวลผลจริงต่อเบื้องหลังผ่าน waitUntil
    // เพราะเรียก Claude + อ่านชีตอาจใช้เวลาหลายวินาที ไม่ควรให้ LINE รอ
    if (event.type === 'message' && event.message && event.message.type === 'text') {
      ctx.waitUntil(handleIncomingText(event, env).catch(err => console.error('handleIncomingText error:', err)));
    } else if (event.type === 'postback') {
      ctx.waitUntil(handlePostback(event, env).catch(err => console.error('handlePostback error:', err)));
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

// เลือกเฉพาะลูกค้าที่มีแนวโน้มเกี่ยวข้องกับข้อความนี้ (ชื่อ/เบอร์ปรากฏในข้อความ) ส่งให้ Claude
// แทนที่จะส่งประวัติทั้งหมด — ประหยัด token และลดโอกาส Claude สับสนจับคู่ผิดคนจากลูกค้าที่ไม่เกี่ยวข้อง
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
  // ไม่เจอใครตรงเลย — ส่งลูกค้าที่สั่งบ่อยสุด 2-3 คนไปเป็น context กว้างๆ เผื่อ Claude ช่วยจับคู่ชื่อคล้ายได้
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

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const raw = (data.content && data.content[0] && data.content[0].text) || '';
  // เผื่อ Claude ห่อ JSON ด้วย markdown fence หรือมีข้อความแวดล้อมหลุดมาบ้าง ดึงเฉพาะ { ... } ตัวแรกที่สมบูรณ์
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Claude response did not contain JSON: ' + raw.slice(0, 200));

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
    '🍊 ร่างออเดอร์จากข้อความ',
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

// ปุ่ม "ยืนยัน"/"แก้ไข" แนบไปกับข้อความสรุป draft — ไม่มีทาง auto-save เด็ดขาดตามนโยบายเวอร์ชันแรก
function confirmQuickReply(draftId) {
  return {
    items: [
      { type: 'action', action: { type: 'postback', label: '✅ ยืนยัน', data: `confirm:${draftId}`, displayText: 'ยืนยัน' } },
      { type: 'action', action: { type: 'postback', label: '✏️ แก้ไข', data: `edit:${draftId}`, displayText: 'แก้ไข' } },
    ],
  };
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

// รับข้อความใหม่จากกลุ่ม — ถ้ากำลังรอแอดมินพิมพ์แก้ไข draft เดิมอยู่ ให้ parse ใหม่แล้ว merge
// กับของเดิม (ฟิลด์ไหนที่รอบใหม่ไม่ได้พูดถึง ให้คงค่าเดิมไว้) ไม่งั้นถือเป็นออเดอร์ใหม่ทั้งหมด
async function handleIncomingText(event, env) {
  const text = event.message.text;
  const groupId = event.source.groupId;
  const replyToken = event.replyToken;

  const editingKey = `editing:${groupId}`;
  const editingDraftId = env.OFRESH_KV ? await env.OFRESH_KV.get(editingKey) : null;

  const customers = await getCustomerHistory(env);
  let parsed;
  try {
    parsed = await parseOrderFromMessage(text, customers, env);
  } catch (err) {
    console.error('parseOrderFromMessage failed:', err);
    await replyToLine(env, replyToken, [{ type: 'text', text: '⚠️ บอทอ่านข้อความนี้ไม่สำเร็จ รบกวนพิมพ์รายละเอียดออเดอร์อีกครั้งครับ' }]);
    return;
  }

  if (editingDraftId) {
    const oldDraft = await env.OFRESH_KV.get(`draft:${editingDraftId}`, { type: 'json' });
    await env.OFRESH_KV.delete(editingKey);

    if (!oldDraft) {
      await replyToLine(env, replyToken, [{ type: 'text', text: '⚠️ ร่างออเดอร์เดิมหมดอายุแล้ว ถือว่านี่เป็นออเดอร์ใหม่นะครับ' }]);
    } else if (!parsed.isOrder) {
      // ข้อความแก้ไขไม่ได้พูดถึงออเดอร์เลย — คงร่างเดิมไว้เฉยๆ ให้พิมพ์ใหม่อีกที
      await env.OFRESH_KV.put(editingKey, editingDraftId, { expirationTtl: EDITING_FLAG_TTL_SECONDS });
      await replyToLine(env, replyToken, [{ type: 'text', text: 'ไม่เห็นรายละเอียดออเดอร์ในข้อความนี้เลยครับ ลองพิมพ์ใหม่อีกครั้ง' }]);
      return;
    } else {
      // merge เฉพาะฟิลด์ข้อมูลออเดอร์จริง (ค่าว่าง/0 แปลว่า "รอบนี้ไม่ได้พูดถึง" เลยคงค่าเดิมไว้)
      // ส่วน confidence/missingFields เป็น "ผลประเมินข้อความล่าสุด" ต้องเอาค่าใหม่เสมอ ไม่ใช่ merge
      // (ไม่งั้นถ้ารอบใหม่ parse ครบแล้ว missingFields ว่างเปล่า แต่ดันถูกมองว่า "ไม่ได้พูดถึง" แล้วคงของเก่าไว้)
      const MERGEABLE_FIELDS = ['name', 'phone', 'line', 'qty', 'address', 'deliveryDate', 'note', 'matchedCustomer'];
      const merged = { ...oldDraft };
      for (const key of MERGEABLE_FIELDS) {
        const v = parsed[key];
        if (v !== '' && v !== 0 && v != null) merged[key] = v;
      }
      merged.confidence = parsed.confidence;
      merged.missingFields = parsed.missingFields;
      await env.OFRESH_KV.put(`draft:${editingDraftId}`, JSON.stringify(merged), { expirationTtl: DRAFT_TTL_SECONDS });
      await replyToLine(env, replyToken, [
        { type: 'text', text: buildOrderSummaryText(merged) },
        { type: 'text', text: 'แก้ไขแล้วถูกไหมครับ?', quickReply: confirmQuickReply(editingDraftId) },
      ]);
    }
    return;
  }

  if (!parsed.isOrder) return; // ข้อความคุยเล่นทั่วไป ไม่ใช่ออเดอร์ — เงียบไว้ ไม่ตอบกลับ

  const draftId = generateOrderId();
  if (env.OFRESH_KV) {
    await env.OFRESH_KV.put(`draft:${draftId}`, JSON.stringify(parsed), { expirationTtl: DRAFT_TTL_SECONDS });
  }

  await replyToLine(env, replyToken, [
    { type: 'text', text: buildOrderSummaryText(parsed) },
    { type: 'text', text: 'ยืนยันบันทึกออเดอร์นี้ไหมครับ?', quickReply: confirmQuickReply(draftId) },
  ]);
}

async function handlePostback(event, env) {
  const data = event.postback.data || '';
  const sep = data.indexOf(':');
  if (sep === -1) return;
  const action = data.slice(0, sep);
  const draftId = data.slice(sep + 1);
  const replyToken = event.replyToken;
  const groupId = event.source.groupId;

  if (action === 'confirm') {
    const draft = env.OFRESH_KV ? await env.OFRESH_KV.get(`draft:${draftId}`, { type: 'json' }) : null;
    if (!draft) {
      await replyToLine(env, replyToken, [{ type: 'text', text: '⚠️ ร่างออเดอร์นี้หมดอายุแล้ว (เกิน 30 นาที) กรุณาพิมพ์รายละเอียดออเดอร์ใหม่อีกครั้งครับ' }]);
      return;
    }
    try {
      await saveOrderToSheet(env, draft, draftId);
      await env.OFRESH_KV.delete(`draft:${draftId}`);
      await replyToLine(env, replyToken, [{
        type: 'text',
        text: `✅ บันทึกออเดอร์ของ "${draft.name}" แล้วครับ`,
        quickReply: { items: [{ type: 'action', action: { type: 'postback', label: '↩️ ยกเลิกออเดอร์นี้', data: `cancel:${draftId}`, displayText: 'ยกเลิกออเดอร์นี้' } }] },
      }]);
    } catch (err) {
      console.error('saveOrderToSheet failed:', err);
      await replyToLine(env, replyToken, [{ type: 'text', text: '⚠️ บันทึกออเดอร์ไม่สำเร็จ ลองกดยืนยันอีกครั้ง หรือแจ้งแอดมินระบบครับ' }]);
    }
  } else if (action === 'edit') {
    if (env.OFRESH_KV) await env.OFRESH_KV.put(`editing:${groupId}`, draftId, { expirationTtl: EDITING_FLAG_TTL_SECONDS });
    await replyToLine(env, replyToken, [{ type: 'text', text: '✏️ พิมพ์รายละเอียดที่ถูกต้องมาได้เลยครับ (พิมพ์เฉพาะส่วนที่ผิด ส่วนที่ไม่พูดถึงจะคงค่าเดิมไว้)' }]);
  } else if (action === 'cancel') {
    try {
      await cancelOrderInSheet(env, draftId);
      await replyToLine(env, replyToken, [{ type: 'text', text: '↩️ ยกเลิกออเดอร์นี้แล้วครับ' }]);
    } catch (err) {
      console.error('cancelOrderInSheet failed:', err);
      await replyToLine(env, replyToken, [{ type: 'text', text: '⚠️ ยกเลิกไม่สำเร็จ รบกวนแก้สถานะในแดชบอร์ดแทนครับ' }]);
    }
  }
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', ...extraHeaders },
  });
}
