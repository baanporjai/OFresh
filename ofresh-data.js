/**
 * O'Fresh — data layer on Cloudflare D1 (replaces the Google Sheets + Apps Script storage).
 *
 * The admin pages and the LINE bot already read their data as CSV text, in the layout the published Google Sheet
 * used. The *Csv() functions below produce exactly that layout from D1, so none of those readers had to change.
 * Writes (orders, expenses, Nayax uploads) go straight into D1.
 *
 * Times: kept as the text the sheet had, in Thailand time ("D/M/YYYY, H:MM:SS" for order/expense timestamps).
 */

const BANGKOK_OFFSET_MS = 7 * 3600 * 1000;

// ---------------------------------------------------------------- CSV helpers
/** RFC-4180-ish parser: quoted fields, "" escapes, newlines inside quotes, BOM, CRLF. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  const s = String(text ?? '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); if (row.length > 1 || row[0] !== '') rows.push(row); }
  return rows;
}

function csvField(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const csvLine = (cells) => cells.map(csvField).join(',');

/** "D/M/YYYY, H:MM:SS" in Thailand time — the layout of the sheet's timestamp column */
export function thaiTimestampNow(now = new Date()) {
  const d = new Date(now.getTime() + BANGKOK_OFFSET_MS);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCDate()}/${d.getUTCMonth() + 1}/${d.getUTCFullYear()}, ${d.getUTCHours()}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

const text = (v) => (v == null ? '' : String(v));
const num = (v) => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };

async function metaGet(db, key, fallback) {
  const r = await db.prepare('SELECT value FROM meta WHERE key = ?').bind(key).first();
  return r ? r.value : fallback;
}
async function metaSet(db, key, value) {
  await db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').bind(key, value).run();
}

async function batched(db, stmts, size = 80) {
  for (let i = 0; i < stmts.length; i += size) await db.batch(stmts.slice(i, i + size));
}

// ---------------------------------------------------------------- orders
const ORDERS_HEADER_DEFAULT = 'timestamp,id,name,phone,line,qty,total,address,deliveryDate ,note,status';

export async function ordersCsv(db) {
  const header = await metaGet(db, 'orders_header', ORDERS_HEADER_DEFAULT);
  const rows = await db.prepare('SELECT ts, id, name, phone, line, qty, total, address, delivery_date, note, status FROM orders ORDER BY seq').all();
  return [header, ...rows.results.map((r) => csvLine([r.ts, r.id, r.name, r.phone, r.line, r.qty, r.total, r.address, r.delivery_date, r.note, r.status]))].join('\n') + '\n';
}

/** website form / LINE bot -> new order, status "pending". Returns the order id. */
export async function createOrder(db, o) {
  const id = o.id || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await db.prepare(
    `INSERT INTO orders (id, ts, name, phone, line, qty, total, address, delivery_date, note, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
  ).bind(id, thaiTimestampNow(), text(o.name), text(o.phone), text(o.line), num(o.qty), num(o.total), text(o.address), text(o.deliveryDate), text(o.note)).run();
  return id;
}

export async function updateOrderStatus(db, id, status) {
  const r = await db.prepare('UPDATE orders SET status = ? WHERE id = ?').bind(text(status || 'pending'), text(id)).run();
  return r.meta.changes ? { success: true } : { success: false, error: 'Order id not found' };
}

const ORDER_FIELD_MAP = { name: 'name', phone: 'phone', line: 'line', qty: 'qty', total: 'total', address: 'address', deliveryDate: 'delivery_date', note: 'note' };
export async function updateOrder(db, id, fields) {
  const sets = [], binds = [];
  for (const [key, col] of Object.entries(ORDER_FIELD_MAP)) {
    if (!(key in fields)) continue; // only the fields that were sent
    sets.push(`${col} = ?`);
    binds.push(key === 'qty' || key === 'total' ? num(fields[key]) : text(fields[key]));
  }
  if (!sets.length) {
    const found = await db.prepare('SELECT 1 FROM orders WHERE id = ?').bind(text(id)).first();
    return found ? { success: true } : { success: false, error: 'Order id not found' };
  }
  const r = await db.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, text(id)).run();
  return r.meta.changes ? { success: true } : { success: false, error: 'Order id not found' };
}

// ---------------------------------------------------------------- expenses
const EXPENSES_HEADER_DEFAULT = 'timestamp,id,type,category,description,amount,date,note';

export async function expensesCsv(db) {
  const header = await metaGet(db, 'expenses_header', EXPENSES_HEADER_DEFAULT);
  const rows = await db.prepare('SELECT ts, id, type, category, description, amount, date, note FROM expenses ORDER BY seq').all();
  return [header, ...rows.results.map((r) => csvLine([r.ts, r.id, r.type, r.category, r.description, r.amount, r.date, r.note]))].join('\n') + '\n';
}

export async function addExpense(db, d) {
  const id = d.id || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await db.prepare('INSERT INTO expenses (id, ts, type, category, description, amount, date, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, thaiTimestampNow(), text(d.type || 'opex'), text(d.category), text(d.description), num(d.amount), text(d.date), text(d.note)).run();
  return { success: true, id };
}

const EXPENSE_EDITABLE = ['type', 'category', 'description', 'amount', 'date', 'note'];
export async function updateExpense(db, d) {
  const sets = [], binds = [];
  for (const f of EXPENSE_EDITABLE) if (f in d) { sets.push(`${f} = ?`); binds.push(f === 'amount' ? num(d[f]) : text(d[f])); }
  if (!sets.length) {
    const found = await db.prepare('SELECT 1 FROM expenses WHERE id = ?').bind(text(d.id)).first();
    return found ? { success: true } : { success: false, error: 'Expense id not found' };
  }
  const r = await db.prepare(`UPDATE expenses SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, text(d.id)).run();
  return r.meta.changes ? { success: true } : { success: false, error: 'Expense id not found' };
}

export async function deleteExpense(db, d) {
  const r = await db.prepare('DELETE FROM expenses WHERE id = ?').bind(text(d.id)).run();
  return r.meta.changes ? { success: true } : { success: false, error: 'Expense id not found' };
}

// ---------------------------------------------------------------- Nayax sales
// [name in the Nayax CSV, column in D1]
const NAYAX_COLUMNS = [
  ['machine_name', 'machine_name'], ['machineAuTime', 'machine_au_time'], ['machineSeTime', 'machine_se_time'], ['product', 'product'],
  ['card_first4digits', 'card_first4digits'], ['card_last4digits', 'card_last4digits'], ['card_type_desc', 'card_type_desc'],
  ['transaction_id', 'transaction_id'], ['auValue', 'au_value'], ['PayServTransid', 'pay_serv_transid'], ['actor_desc', 'actor_desc'],
  ['machine_serial_number', 'machine_serial_number'], ['payment_method_id_enc', 'payment_method_id_enc'],
];
const NAYAX_HEADER_DEFAULT = [...NAYAX_COLUMNS.map((c) => c[0]), 'date'].join(',');

export async function nayaxCsv(db) {
  const header = await metaGet(db, 'nayax_header', NAYAX_HEADER_DEFAULT);
  const cols = NAYAX_COLUMNS.map((c) => c[1]);
  const rows = await db.prepare(`SELECT ${cols.join(', ')}, sale_date FROM nayax_sales ORDER BY rowid`).all();
  return [header, ...rows.results.map((r) => csvLine([...cols.map((c) => r[c]), r.sale_date]))].join('\n') + '\n';
}

/**
 * Nayax times are normally "D/M/YYYY H:MM(:SS)" (24h). Some reports arrive in the US style "M/D/YYYY h:MM:SS AM|PM"
 * (typically after the file was opened and re-saved in Excel with US regional settings) - reading those as D/M/YYYY
 * put 2 Nov 2026 on 11 Feb 2026. Anything with AM/PM is US style; convert it to "DD/MM/YYYY HH:MM:SS" so what we
 * store (and the dashboards read back) is always day-first.
 */
export function normalizeNayaxTime(s) {
  const t = String(s ?? '').trim();
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])$/.exec(t);
  if (!us) return t;
  const pad = (n) => String(n).padStart(2, '0');
  const hour = (Number(us[4]) % 12) + (/p/i.test(us[7]) ? 12 : 0);
  return `${pad(us[2])}/${pad(us[1])}/${us[3]} ${pad(hour)}:${us[5]}:${us[6] ?? '00'}`;
}

/** "D/M/YYYY H:MM:SS" (or the US AM/PM style) -> "YYYY/MM/DD" (column N of the old sheet), '' if it is not a date */
export function saleDateOf(machineAuTime) {
  const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(normalizeNayaxTime(machineAuTime));
  return m ? `${m[3]}/${m[2].padStart(2, '0')}/${m[1].padStart(2, '0')}` : '';
}

const NAYAX_TIME_COLUMNS = new Set(['machineAuTime', 'machineSeTime']);

const MAX_NAYAX_UPLOAD_ROWS = 20000;

/**
 * Reads a Nayax "Transactions Report" CSV. Rows whose transaction_id is already stored are skipped (so uploading the same
 * file twice, or two overlapping reports, never double counts). With commit=false nothing is written and the result says
 * what would happen. Rows that cannot be used are listed with the reason; they are never half-saved.
 */
export async function importNayaxCsv(db, csvText, { commit = false } = {}) {
  const rows = parseCsv(csvText);
  if (rows.length < 2) return { ok: false, error: 'ไฟล์ว่างหรือไม่มีข้อมูลหลังหัวตาราง' };
  if (rows.length - 1 > MAX_NAYAX_UPLOAD_ROWS) return { ok: false, error: `ไฟล์ใหญ่เกิน ${MAX_NAYAX_UPLOAD_ROWS} แถว` };

  const header = rows[0].map((h) => h.trim());
  const idx = {};
  for (const [csvName] of NAYAX_COLUMNS) {
    const i = header.findIndex((h) => h.toLowerCase() === csvName.toLowerCase());
    if (i !== -1) idx[csvName] = i;
  }
  const missing = ['transaction_id', 'machineAuTime', 'auValue', 'machine_name'].filter((c) => idx[c] === undefined);
  if (missing.length) return { ok: false, error: `ไม่ใช่ไฟล์รายงาน Nayax ที่คาดไว้ — ไม่พบคอลัมน์ ${missing.join(', ')}`, header };

  const bad = [], fresh = [], seen = new Set();
  let duplicatesInFile = 0;
  for (let n = 1; n < rows.length; n++) {
    const r = rows[n];
    const line = n + 1; // line number in the file (header = line 1)
    const get = (name) => (idx[name] === undefined ? '' : (r[idx[name]] ?? '').trim());
    const id = get('transaction_id');
    const when = normalizeNayaxTime(get('machineAuTime'));
    const value = get('auValue');
    if (!id) { bad.push({ line, reason: 'ไม่มี transaction_id' }); continue; }
    if (!saleDateOf(when)) { bad.push({ line, id, reason: `เวลา (machineAuTime) อ่านไม่ได้: "${when}" (ต้องเป็น วัน/เดือน/ปี ค.ศ. เวลา)` }); continue; }
    if (value === '' || !Number.isFinite(parseFloat(value.replace(/,/g, '')))) { bad.push({ line, id, reason: `ยอด (auValue) ไม่ใช่ตัวเลข: "${value}"` }); continue; }
    if (seen.has(id)) { duplicatesInFile++; continue; }
    seen.add(id);
    fresh.push({ id, when, row: NAYAX_COLUMNS.map(([csvName]) => (NAYAX_TIME_COLUMNS.has(csvName) ? normalizeNayaxTime(get(csvName)) : get(csvName))) });
  }

  // which of these ids are already stored
  const existing = new Set();
  const ids = fresh.map((f) => f.id);
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const r = await db.prepare(`SELECT transaction_id FROM nayax_sales WHERE transaction_id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all();
    for (const x of r.results) existing.add(x.transaction_id);
  }
  const toAdd = fresh.filter((f) => !existing.has(f.id));

  const dates = toAdd.map((f) => saleDateOf(f.when)).sort();

  // Sanity check shown in the preview: a file whose dates are far from the data we already have usually means the
  // day/month order was misread (this is how 2 Nov 2026 once landed on 11 Feb 2026), or a future-dated file.
  let warning = null;
  if (dates.length) {
    const asTime = (d) => Date.parse(d.split('/').join('-'));
    const latest = (await db.prepare('SELECT MAX(sale_date) AS d FROM nayax_sales').first())?.d;
    const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10).split('-').join('/'); // Thai date
    if (latest && (asTime(latest) - asTime(dates[0])) / 86400000 > 30) {
      warning = `วันที่ในไฟล์ (เริ่ม ${dates[0]}) เก่ากว่าข้อมูลล่าสุดในระบบ (${latest}) มากกว่า 30 วัน — ตรวจดูว่าวัน/เดือนในไฟล์ไม่ถูกสลับก่อนกดยืนยัน`;
    } else if ((asTime(dates[dates.length - 1]) - asTime(today)) / 86400000 > 1) {
      warning = `ไฟล์มีรายการที่วันที่อยู่ในอนาคต (${dates[dates.length - 1]}) — ตรวจดูว่าวัน/เดือนในไฟล์ไม่ถูกสลับก่อนกดยืนยัน`;
    }
  }

  const result = {
    ok: true,
    committed: false,
    totalRows: rows.length - 1,
    toAdd: toAdd.length,
    alreadyStored: fresh.length - toAdd.length,
    duplicatesInFile,
    bad: bad.length,
    badRows: bad.slice(0, 50),
    warning,
    firstDate: dates[0] ?? null,
    lastDate: dates[dates.length - 1] ?? null,
    sample: toAdd.slice(0, 3).map((f) => ({ id: f.id, time: f.when, machine: f.row[0], product: f.row[3], value: f.row[8] })),
  };
  if (!commit) return result;
  if (bad.length) return { ...result, ok: false, error: `มี ${bad.length} แถวที่ใช้ไม่ได้ จึงไม่บันทึกอะไรเลย — แก้ไฟล์แล้วอัปโหลดใหม่` };

  const cols = NAYAX_COLUMNS.map((c) => c[1]);
  const stmts = toAdd.map((f) => db.prepare(
    `INSERT OR IGNORE INTO nayax_sales (${cols.join(', ')}, sale_date) VALUES (${cols.map(() => '?').join(', ')}, ?)`,
  ).bind(...f.row, saleDateOf(f.when)));
  await batched(db, stmts);
  return { ...result, committed: true };
}

export async function recordUpload(db, { kind, filename, result, by }) {
  await db.prepare('INSERT INTO uploads (ts, kind, filename, total_rows, added, skipped, bad, by_user) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(thaiTimestampNow(), kind, text(filename).slice(0, 200), result.totalRows ?? 0, result.toAdd ?? 0, (result.alreadyStored ?? 0) + (result.duplicatesInFile ?? 0), result.bad ?? 0, text(by)).run();
}

export async function recentUploads(db, limit = 10) {
  const r = await db.prepare('SELECT ts, kind, filename, total_rows, added, skipped, bad FROM uploads ORDER BY id DESC LIMIT ?').bind(limit).all();
  return r.results;
}

export async function nayaxSummary(db) {
  const r = await db.prepare('SELECT COUNT(*) AS n, MIN(sale_date) AS first_date, MAX(sale_date) AS last_date FROM nayax_sales').first();
  const last = await db.prepare('SELECT machine_au_time FROM nayax_sales ORDER BY sale_date DESC, rowid DESC LIMIT 1').first();
  return { rows: r.n, firstDate: r.first_date, lastDate: r.last_date, lastSaleAt: last ? last.machine_au_time : null };
}

// ---------------------------------------------------------------- one-off import from the old published sheets
async function fetchCsv(url) {
  const res = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { redirect: 'follow' });
  if (!res.ok) throw new Error(`sheet CSV ${res.status}`);
  return res.text();
}

/** Copies Orders, Expenses and Nayax sales from the published Google Sheet CSVs into D1. Safe to run twice (matched by id). */
export async function importFromSheets(env) {
  const db = env.DB;
  const report = {};

  if (env.ORDERS_SHEET_CSV_URL) {
    const rows = parseCsv(await fetchCsv(env.ORDERS_SHEET_CSV_URL));
    const header = rows[0];
    const col = (name) => header.findIndex((h) => h.trim().toLowerCase() === name);
    const c = Object.fromEntries(['timestamp', 'id', 'name', 'phone', 'line', 'qty', 'total', 'address', 'deliverydate', 'note', 'status'].map((n) => [n, col(n)]));
    if (c.id === -1 || c.timestamp === -1) throw new Error('orders sheet: header not recognised ' + JSON.stringify(header));
    await metaSet(db, 'orders_header', header.map(csvField).join(','));
    const g = (r, n) => (c[n] === -1 ? '' : (r[c[n]] ?? ''));
    const stmts = rows.slice(1).filter((r) => g(r, 'id')).map((r) => db.prepare(
      'INSERT OR IGNORE INTO orders (id, ts, name, phone, line, qty, total, address, delivery_date, note, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(g(r, 'id'), g(r, 'timestamp'), g(r, 'name'), g(r, 'phone'), g(r, 'line'), num(g(r, 'qty')), num(g(r, 'total')), g(r, 'address'), g(r, 'deliverydate'), g(r, 'note'), g(r, 'status') || 'pending'));
    await batched(db, stmts);
    report.orders = { sheet: stmts.length, inD1: (await db.prepare('SELECT COUNT(*) n FROM orders').first()).n };
  }

  if (env.EXPENSES_SHEET_CSV_URL) {
    const rows = parseCsv(await fetchCsv(env.EXPENSES_SHEET_CSV_URL));
    const header = rows[0];
    const col = (name) => header.findIndex((h) => h.trim().toLowerCase() === name);
    const c = Object.fromEntries(['timestamp', 'id', 'type', 'category', 'description', 'amount', 'date', 'note'].map((n) => [n, col(n)]));
    if (c.id === -1) throw new Error('expenses sheet: header not recognised ' + JSON.stringify(header));
    await metaSet(db, 'expenses_header', header.map(csvField).join(','));
    const g = (r, n) => (c[n] === -1 ? '' : (r[c[n]] ?? ''));
    const stmts = rows.slice(1).filter((r) => g(r, 'id')).map((r) => db.prepare(
      'INSERT OR IGNORE INTO expenses (id, ts, type, category, description, amount, date, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(g(r, 'id'), g(r, 'timestamp'), g(r, 'type') || 'opex', g(r, 'category'), g(r, 'description'), num(g(r, 'amount')), g(r, 'date'), g(r, 'note')));
    await batched(db, stmts);
    report.expenses = { sheet: stmts.length, inD1: (await db.prepare('SELECT COUNT(*) n FROM expenses').first()).n };
  }

  if (env.NAYAX_SHEET_CSV_URL) {
    const rows = parseCsv(await fetchCsv(env.NAYAX_SHEET_CSV_URL));
    const header = rows[0];
    const find = (name) => header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
    const idx = NAYAX_COLUMNS.map(([csvName]) => find(csvName));
    const iDate = header.findIndex((h) => h.trim().toLowerCase() === 'date');
    const iId = idx[NAYAX_COLUMNS.findIndex((c) => c[0] === 'transaction_id')];
    if (iId === -1) throw new Error('nayax sheet: transaction_id column not found ' + JSON.stringify(header));
    await metaSet(db, 'nayax_header', header.map(csvField).join(','));
    const cols = NAYAX_COLUMNS.map((c) => c[1]);
    const iAu = idx[NAYAX_COLUMNS.findIndex((c) => c[0] === 'machineAuTime')];
    let skipped = 0;
    const stmts = [];
    for (const r of rows.slice(1)) {
      const id = (r[iId] ?? '').trim();
      if (!id) { skipped++; continue; }
      const vals = idx.map((i) => (i === -1 ? '' : (r[i] ?? '')));
      const sale = iDate !== -1 && (r[iDate] ?? '') !== '' ? r[iDate] : saleDateOf(r[iAu]);
      stmts.push(db.prepare(`INSERT OR IGNORE INTO nayax_sales (${cols.join(', ')}, sale_date) VALUES (${cols.map(() => '?').join(', ')}, ?)`).bind(...vals, sale));
    }
    await batched(db, stmts);
    const s = await nayaxSummary(db);
    report.nayax = { sheetRows: rows.length - 1, skippedBlankId: skipped, inD1: s.rows, firstDate: s.firstDate, lastDate: s.lastDate };
  }
  return report;
}
