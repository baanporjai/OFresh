/**
 * O'Fresh Order API — Cloudflare Worker
 *
 * Deploy เป็น Worker ใหม่แยกต่างหาก แล้วตั้ง Environment Secret:
 *   LINE_CHANNEL_TOKEN     = <Channel Access Token จาก LINE Developers>
 *   SHEET_WEBHOOK_URL      = <Apps Script webhook สำหรับบันทึกออเดอร์>
 *   ADMIN_PIN              = <PIN สำหรับเข้าหน้าแดชบอร์ด>
 *   SESSION_SECRET         = <ค่าสุ่มยาวๆ ใช้เซ็นชื่อ session token>
 *   ORDERS_SHEET_CSV_URL   = <ลิงก์ CSV ของ Google Sheet ออเดอร์ส้ม>
 *   NAYAX_SHEET_CSV_URL    = <ลิงก์ CSV ของ Google Sheet ยอดขาย Nayax>
 *
 * ADMIN_USER_ID ตั้งค่าไว้ใน code ด้านล่างได้เลย (ไม่ใช่ข้อมูลลับ)
 */

const ADMIN_USER_ID = 'Uf98128660213c82a12e8cfc382fa5243';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 ชั่วโมง

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default {
  async fetch(request, env) {
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
      return handleAdminSheetProxy(request, env, env.ORDERS_SHEET_CSV_URL);
    }

    if (request.method === 'GET' && url.pathname === '/api/admin/nayax-stats') {
      return handleAdminSheetProxy(request, env, env.NAYAX_SHEET_CSV_URL);
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

  const text = [
    '🍊 คำสั่งซื้อส้มใหม่! O\'Fresh',
    '─────────────────',
    `👤 ชื่อ: ${name}`,
    `📞 เบอร์: ${phone}`,
    line ? `💬 LINE: ${line}` : null,
    `⚖️ จำนวน: ${qty} กก.`,
    `💰 ยอดรวม: ฿${Number(total).toLocaleString()} (ไม่รวมค่าส่ง)`,
    `📍 ที่อยู่: ${address}`,
    deliveryDate ? `📅 วันที่ต้องการของ: ${deliveryDate}` : null,
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
        to: ADMIN_USER_ID,
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

async function handleAdminSheetProxy(request, env, sheetUrl) {
  const ok = await verifyAuthHeader(request, env);
  if (!ok) return jsonResponse({ error: 'Unauthorized' }, 401);

  if (!sheetUrl) return jsonResponse({ error: 'Not configured' }, 500);

  try {
    const res = await fetch(sheetUrl + (sheetUrl.includes('?') ? '&' : '?') + 't=' + Date.now());
    const text = await res.text();
    return new Response(text, {
      headers: { ...CORS_HEADERS, 'Content-Type': 'text/csv; charset=utf-8' },
    });
  } catch (err) {
    console.error('Sheet proxy error:', err);
    return jsonResponse({ error: 'Failed to fetch sheet' }, 502);
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

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
