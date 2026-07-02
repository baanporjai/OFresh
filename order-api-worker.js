/**
 * O'Fresh Order API — Cloudflare Worker
 *
 * Deploy เป็น Worker ใหม่แยกต่างหาก แล้วตั้ง Environment Secret:
 *   LINE_CHANNEL_TOKEN = <Channel Access Token จาก LINE Developers>
 *
 * ADMIN_USER_ID ตั้งค่าไว้ใน code ด้านล่างได้เลย (ไม่ใช่ข้อมูลลับ)
 */

const ADMIN_USER_ID = 'Uf98128660213c82a12e8cfc382fa5243';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    if (request.method === 'POST' && url.pathname === '/api/order') {
      let data;
      try {
        data = await request.json();
      } catch {
        return jsonResponse({ success: false, error: 'Invalid JSON' }, 400);
      }

      const { name, phone, line, qty, total, address, deliveryDate, note } = data;

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
              body: JSON.stringify({ name, phone, line, qty, total, address, deliveryDate, note }),
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

    return jsonResponse({ error: 'Not found' }, 404);
  },
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
