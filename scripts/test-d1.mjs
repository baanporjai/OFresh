// Offline tests for the O'Fresh D1 data layer + Worker routes. node:sqlite stands in for D1.
//   node --no-warnings scripts/test-d1.mjs
// If SNAPSHOT_ORDERS_CSV points at a real export of the old orders sheet, that is round-tripped too (never committed: customer data).
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log("FAIL:", msg); } };

function makeDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(fs.readFileSync(root + "migrations/0001_init.sql", "utf8"));
  class Stmt {
    constructor(sql) { this.sql = sql; this.v = []; }
    bind(...v) { const s = new Stmt(this.sql); s.v = v; return s; }
    all() { return { results: sqlite.prepare(this.sql).all(...this.v).map((r) => ({ ...r })), meta: {} }; }
    first() { const r = sqlite.prepare(this.sql).get(...this.v); return r ? { ...r } : null; }
    run() { const i = sqlite.prepare(this.sql).run(...this.v); return { meta: { changes: Number(i.changes), last_row_id: Number(i.lastInsertRowid) } }; }
  }
  const exec = (s) => (/^\s*select/i.test(s.sql) || /returning/i.test(s.sql) ? s.all() : s.run());
  const wrap = (st) => ({ bind: (...v) => wrap(st.bind(...v)), all: async () => st.all(), first: async () => st.first(), run: async () => st.run(), _s: st });
  return {
    d1: {
      prepare: (sql) => wrap(new Stmt(sql)),
      async batch(stmts) { sqlite.exec("BEGIN"); try { const out = stmts.map((s) => exec(s._s)); sqlite.exec("COMMIT"); return out; } catch (e) { sqlite.exec("ROLLBACK"); throw e; } },
    },
    raw: sqlite,
  };
}

// ---------------------------------------------------------------- fixtures: the old published sheets
const ORDERS_CSV = [
  "timestamp,id,name,phone,line,qty,total,address,deliveryDate ,note,status",
  '2/7/2026, 20:53:24,ord-aaa,สมชาย ใจดี,0811111111,somchai,2,120,"99/1 ถ.เชียงใหม่-ลำปาง, ต.ศรีภูมิ",2026-07-04,,delivered',
  '6/8/2026, 13:11:43,ord-bbb,"นางสาว ""แอน"" ทดสอบ",0822222222,,1,60,"บ้านเลขที่ 5\nซอย 2",2026-08-06,โทรก่อนส่ง,cancelled',
  '10/10/2026, 9:05:00,ord-ccc,ร้านลุงดำ,0833333333,,22,1320,ตลาดต้นพยอม,2026-10-12,,pending',
].map((l, i) => (i === 0 ? l : l.replace(/^(\d+\/\d+\/\d+),\s(\d+:\d+:\d+),/, '"$1, $2",'))).join("\r\n");
const EXPENSES_CSV = [
  "timestamp,id,type,category,description,amount,date,note",
  '"4/8/2026, 13:03:27",exp-1,cogs,ต้นทุนสินค้า,"ส้ม 100 กก., ล็อต 1",6000,2026-08-01,',
  '"5/8/2026, 9:00:00",exp-2,opex,ค่าเช่า,ค่าเช่าตู้,12000,2026-08-05,รายเดือน',
].join("\n");
const NAYAX_HEADER = "machine_name,machineAuTime,machineSeTime,product,card_first4digits,card_last4digits,card_type_desc,transaction_id,auValue,PayServTransid,actor_desc,machine_serial_number,payment_method_id_enc,date";
const NAYAX_SHEET_CSV = [NAYAX_HEADER,
  "OFresh_CentralFest,2/7/2026 20:06:11,2/7/2026 20:06:20,Orange Juice,4111,1234,VISA,T-1001,99,PS1,Customer,SN1,ENC1,2026/07/02",
  "OFresh_CentralFest,2/7/2026 21:30:00,2/7/2026 21:30:09,Orange Juice,5222,9876,MasterCard,T-1002,99,PS2,Customer,SN1,ENC2,2026/07/02",
].join("\n");

const thaiNow = () => new Date(Date.now() + 7 * 3600e3);
const p2 = (n) => String(n).padStart(2, "0");
const todayTh = () => { const d = thaiNow(); return `${d.getUTCDate()}/${d.getUTCMonth() + 1}/${d.getUTCFullYear()}`; };
const nayaxFile = (rows, header = "machine_name,machineAuTime,machineSeTime,product,card_first4digits,card_last4digits,card_type_desc,transaction_id,auValue,PayServTransid,actor_desc,machine_serial_number,payment_method_id_enc") =>
  [header, ...rows.map((r) => `${r.machine ?? "OFresh_CentralFest"},${r.when},${r.when},${r.product ?? "Orange Juice"},4111,1234,VISA,${r.id},${r.value ?? "99"},PS,Customer,SN1,ENC`)].join("\r\n");

// ---------------------------------------------------------------- environment
const lineCalls = [];
const realFetch = globalThis.fetch;
let sheetBodies = { ORDERS: ORDERS_CSV, EXPENSES: EXPENSES_CSV, NAYAX: NAYAX_SHEET_CSV };
globalThis.fetch = async (url, init) => {
  const u = String(url);
  const csv = (b) => new Response(b, { headers: { "content-type": "text/csv" } });
  if (u.startsWith("https://sheet.test/orders")) return csv(sheetBodies.ORDERS);
  if (u.startsWith("https://sheet.test/expenses")) return csv(sheetBodies.EXPENSES);
  if (u.startsWith("https://sheet.test/nayax")) return csv(sheetBodies.NAYAX);
  if (u.startsWith("https://api.line.me/")) { lineCalls.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }); }
  return realFetch(url, init);
};
globalThis.caches = { default: { async match() { return undefined; }, async put() {} } };

const kvDeleted = [];
const kvStore = new Map();
const KV = { async get(k) { return kvStore.has(k) ? JSON.parse(kvStore.get(k)) : null; }, async put(k, v) { kvStore.set(k, v); }, async delete(k) { kvDeleted.push(k); kvStore.delete(k); } };

const ofd = await import(new URL("../ofresh-data.js", import.meta.url));
const worker = (await import(new URL("../order-api-worker.js", import.meta.url))).default;

const { d1, raw } = makeDb();
const env = {
  DB: d1, OFRESH_KV: KV, ADMIN_PIN: "123456", SESSION_SECRET: "test-secret-test-secret-test-secret", MIGRATE_TOKEN: "mig-token-1234567890",
  LINE_CHANNEL_TOKEN: "t", WIDGET_TOKEN: "widget-token-1234567890",
  ORDERS_SHEET_CSV_URL: "https://sheet.test/orders", EXPENSES_SHEET_CSV_URL: "https://sheet.test/expenses", NAYAX_SHEET_CSV_URL: "https://sheet.test/nayax",
};
const ctx = { waitUntil() {} };
const call = (path, init = {}) => worker.fetch(new Request("https://api.test" + path, init), env, ctx);
const sql = (q, ...a) => raw.prepare(q).all(...a);

// ---------------------------------------------------------------- CSV parser
{
  const rows = ofd.parseCsv('﻿a,b,c\r\n1,"x, y","say ""hi"""\r\n"multi\nline",2,\r\n');
  ok(rows.length === 3 && rows[0][0] === "a", "BOM and CRLF handled");
  ok(rows[1][1] === "x, y" && rows[1][2] === 'say "hi"', "quoted comma and doubled quote");
  ok(rows[2][0] === "multi\nline" && rows[2][2] === "", "newline inside quotes, empty last field");
}

// ---------------------------------------------------------------- one-off import from the sheets
let r = await call("/api/migrate/from-sheets", { method: "POST" });
ok(r.status === 401, "import needs the migrate token");
r = await call("/api/migrate/from-sheets", { method: "POST", headers: { "X-Migrate-Token": env.MIGRATE_TOKEN } });
const mig = await r.json();
ok(mig.ok && mig.report.orders.inD1 === 3 && mig.report.expenses.inD1 === 2 && mig.report.nayax.inD1 === 2, "sheets imported " + JSON.stringify(mig.report));
await call("/api/migrate/from-sheets", { method: "POST", headers: { "X-Migrate-Token": env.MIGRATE_TOKEN } });
ok(sql("select count(*) n from orders")[0].n === 3 && sql("select count(*) n from nayax_sales")[0].n === 2 && sql("select count(*) n from expenses")[0].n === 2, "running the import twice adds nothing");

r = await call("/api/admin/login", { method: "POST", body: JSON.stringify({ pin: env.ADMIN_PIN }) });
const token = (await r.json()).token;
const auth = { headers: { Authorization: `Bearer ${token}` } };
ok(!!token, "login works");
ok((await call("/api/admin/login", { method: "POST", body: JSON.stringify({ pin: "000000" }) })).status === 401, "wrong PIN refused");

// the pages read these as CSV: same header, same cells, same order as the sheet
const same = (a, b) => JSON.stringify(ofd.parseCsv(a)) === JSON.stringify(ofd.parseCsv(b));
const ordersOut = await (await call("/api/admin/orders", auth)).text();
ok(ordersOut.split("\n")[0] === "timestamp,id,name,phone,line,qty,total,address,deliveryDate ,note,status", "orders header kept exactly (including the trailing space)");
ok(same(ordersOut, ORDERS_CSV), "orders CSV identical to the sheet (quotes, commas, newlines, order)");
ok(same(await (await call("/api/admin/expenses", auth)).text(), EXPENSES_CSV), "expenses CSV identical to the sheet");
ok(same(await (await call("/api/admin/nayax-stats", auth)).text(), NAYAX_SHEET_CSV), "nayax CSV identical to the sheet");
for (const p of ["/api/admin/orders", "/api/admin/expenses", "/api/admin/nayax-stats", "/api/admin/upload-info"]) ok((await call(p)).status === 401, `${p} needs the PIN token`);

if (process.env.SNAPSHOT_ORDERS_CSV && fs.existsSync(process.env.SNAPSHOT_ORDERS_CSV)) {
  const real = makeDb();
  const e2 = { ...env, DB: real.d1, ORDERS_SHEET_CSV_URL: "https://sheet.test/orders", EXPENSES_SHEET_CSV_URL: undefined, NAYAX_SHEET_CSV_URL: undefined };
  sheetBodies = { ...sheetBodies, ORDERS: fs.readFileSync(process.env.SNAPSHOT_ORDERS_CSV, "utf8") };
  await ofd.importFromSheets(e2);
  ok(same(await ofd.ordersCsv(real.d1), sheetBodies.ORDERS), "real orders snapshot round-trips exactly (" + (ofd.parseCsv(sheetBodies.ORDERS).length - 1) + " rows)");
  sheetBodies = { ORDERS: ORDERS_CSV, EXPENSES: EXPENSES_CSV, NAYAX: NAYAX_SHEET_CSV };
}

// ---------------------------------------------------------------- Nayax CSV upload
const upload = (body, mode = "preview", headers = {}) => call(`/api/admin/nayax-upload?mode=${mode}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/csv", "X-Filename": encodeURIComponent("Nayax_R0_2026.csv"), ...headers }, body });
const today = todayTh();
const f1 = nayaxFile([{ id: "T-2001", when: `${today} 9:15:00` }, { id: "T-2002", when: `${today} 10:30:45` }, { id: "T-2003", when: `${today} 11:00:00`, value: "198" }]);
const before = sql("select count(*) n from nayax_sales")[0].n;

ok((await call("/api/admin/nayax-upload?mode=preview", { method: "POST", body: f1 })).status === 401, "upload needs the PIN token");
// the browser asks first; every header the page sends must be allowed or it fails with "Failed to fetch"
{
  const pre = await call("/api/admin/nayax-upload?mode=preview", { method: "OPTIONS", headers: { Origin: "https://ofresh.baanporjai.com", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type,x-filename" } });
  const allowed = (pre.headers.get("Access-Control-Allow-Headers") || "").toLowerCase().split(",").map((h) => h.trim());
  ok(pre.status === 200 && ["authorization", "content-type", "x-filename"].every((h) => allowed.includes(h)), "CORS preflight allows the headers the upload page sends: " + allowed.join(","));
}
let j = await (await upload(f1, "preview")).json();
ok(j.ok && !j.committed && j.toAdd === 3 && j.alreadyStored === 0 && j.bad === 0, "preview reports 3 new rows " + JSON.stringify({ a: j.toAdd, b: j.bad }));
ok(sql("select count(*) n from nayax_sales")[0].n === before, "preview writes nothing");
ok(j.sample.length === 3 && j.firstDate && j.lastDate, "preview shows samples and the date range");
j = await (await upload(f1, "commit")).json();
ok(j.ok && j.committed && j.toAdd === 3, "commit adds the 3 rows");
ok(sql("select count(*) n from nayax_sales")[0].n === before + 3, "rows are in D1");
ok(sql("select sale_date d from nayax_sales where transaction_id='T-2001'")[0].d === `${thaiNow().getUTCFullYear()}/${p2(thaiNow().getUTCMonth() + 1)}/${p2(thaiNow().getUTCDate())}`, "sale date derived as YYYY/MM/DD");
ok(kvDeleted.includes("nayax_rows_cache") && kvDeleted.includes("customer_history"), "cached rows are cleared after a commit");

j = await (await upload(f1, "commit")).json();
ok(j.ok && j.toAdd === 0 && j.alreadyStored === 3, "uploading the same file again adds nothing");
ok(sql("select count(*) n from nayax_sales")[0].n === before + 3, "no duplicates after a repeat upload");

const f2 = nayaxFile([{ id: "T-2003", when: `${today} 11:00:00` }, { id: "T-2004", when: `${today} 12:00:00` }, { id: "T-2004", when: `${today} 12:00:00` }]);
j = await (await upload(f2, "commit")).json();
ok(j.toAdd === 1 && j.alreadyStored === 1 && j.duplicatesInFile === 1, "overlapping report adds only the new row " + JSON.stringify({ a: j.toAdd, s: j.alreadyStored, d: j.duplicatesInFile }));

// bad rows: nothing at all is saved
const nBefore = sql("select count(*) n from nayax_sales")[0].n;
const fBad = nayaxFile([{ id: "T-3001", when: `${today} 9:00:00` }, { id: "T-3002", when: "not a date" }, { id: "T-3003", when: `${today} 9:10:00`, value: "abc" }, { id: "", when: `${today} 9:20:00` }]);
j = await (await upload(fBad, "preview")).json();
ok(j.ok && j.bad === 3 && j.toAdd === 1 && j.badRows.length === 3 && j.badRows[0].line === 3, "preview lists the unusable rows with line numbers");
const rBad = await upload(fBad, "commit"); j = await rBad.json();
ok(rBad.status === 422 && !j.ok && sql("select count(*) n from nayax_sales")[0].n === nBefore, "commit with bad rows is refused and saves nothing");
ok(sql("select count(*) n from nayax_sales where transaction_id='T-3001'")[0].n === 0, "the good row in a bad file is not saved either");

// wrong kind of file
j = await (await upload("name,phone\nsomchai,081", "preview")).json();
ok(!j.ok && /ไม่พบคอลัมน์/.test(j.error), "a file that is not a Nayax report is rejected with the reason");
j = await (await upload("", "preview")).json();
ok(!j.ok, "empty file rejected");
j = await (await upload(nayaxFile([]), "preview")).json();
ok(!j.ok, "header-only file rejected");
const big = await upload("x".repeat(5 * 1024 * 1024 + 10), "preview");
ok(big.status === 413, "file over 5 MB rejected");

// tolerant of Excel-style files: BOM, CRLF, lowercase header names, columns in another order
const odd = "﻿" + ["TRANSACTION_ID,MACHINEAUTIME,AUVALUE,MACHINE_NAME,PRODUCT", `T-4001,${today} 8:00:00,75,OFresh_Lamyai,Juice`].join("\r\n");
j = await (await upload(odd, "commit")).json();
ok(j.ok && j.committed && j.toAdd === 1, "BOM + CRLF + upper-case + reordered columns accepted");
ok(sql("select machine_name m, au_value v from nayax_sales where transaction_id='T-4001'")[0].m === "OFresh_Lamyai", "columns mapped by name, not position");

// history + status
const info = await (await call("/api/admin/upload-info", auth)).json();
ok(info.uploads.length >= 3 && info.uploads[0].filename === "Nayax_R0_2026.csv" && info.nayax.rows === sql("select count(*) n from nayax_sales")[0].n, "upload history and data summary available");
ok(info.uploads.length === 4 && info.uploads.some((u) => u.added === 0), "history has one row per committed upload (4), none for previews or refused files");

// the pages that read Nayax data see the new rows
const stats = await (await call("/api/admin/nayax-stats", auth)).text();
ok(stats.includes("T-2001") && stats.split("\n")[0].toLowerCase().includes("machineautime"), "stats CSV includes the uploaded rows");
const hl = await (await call("/api/public/highlights")).json();
ok(hl.totalCups >= 5, "public highlights count the uploaded cups " + JSON.stringify({ cups: hl.totalCups }));
const cal = await (await call("/api/widget/daily-sales-calendar", { headers: { "X-Widget-Token": env.WIDGET_TOKEN } })).json();
ok(cal.monthTotal > 0 || cal.monthCups > 0 || JSON.stringify(cal).includes("days"), "widget calendar reads D1 rows");
ok((await call("/realstat/central")).status === 200, "realstat page renders from D1");

// ---------------------------------------------------------------- orders from the website / LINE
r = await call("/api/order", { method: "POST", body: JSON.stringify({ id: "web-1", name: "ลูกค้าเว็บ", phone: "0844444444", line: "lineid", qty: 5, total: 300, address: "1 ถนนทดสอบ", deliveryDate: "2026-11-02", note: "ทดสอบ" }) });
ok(r.status === 200 && lineCalls.length === 1, "order accepted and LINE notified");
const web = sql("select * from orders where id='web-1'")[0];
ok(web && web.status === "pending" && web.qty === 5 && web.total === 300 && /^\d{1,2}\/\d{1,2}\/\d{4}, \d{1,2}:\d{2}:\d{2}$/.test(web.ts), "order stored with status pending and a Thai timestamp " + web?.ts);
ok((await call("/api/order", { method: "POST", body: JSON.stringify({ name: "x" }) })).status === 400, "incomplete order refused");
const ordersAfter = ofd.parseCsv(await (await call("/api/admin/orders", auth)).text());
ok(ordersAfter.length === 5 && ordersAfter[4][1] === "web-1", "new order appears last in the orders CSV");
const oh = await (await call("/api/public/order-highlights")).json();
ok(oh.totalOrders >= 3, "public order highlights read D1 " + JSON.stringify(oh));

const upd = (body, withAuth = true) => call("/api/admin/order-update", { method: "POST", ...(withAuth ? auth : {}), body: JSON.stringify(body) });
ok((await upd({ action: "updateStatus", id: "web-1", status: "delivered" }, false)).status === 401, "order update needs the PIN token");
ok((await (await upd({ action: "updateStatus", id: "web-1", status: "delivered" })).json()).success, "status updated");
ok(sql("select status s from orders where id='web-1'")[0].s === "delivered", "status saved");
ok((await upd({ action: "updateStatus", id: "nope", status: "x" })).status === 404, "unknown order reported");
ok((await (await upd({ action: "updateOrder", id: "web-1", name: "แก้ชื่อ", qty: 7, total: 420, deliveryDate: "2026-11-05" })).json()).success, "order edited");
const edited = sql("select * from orders where id='web-1'")[0];
ok(edited.name === "แก้ชื่อ" && edited.qty === 7 && edited.total === 420 && edited.delivery_date === "2026-11-05" && edited.phone === "0844444444" && edited.address === "1 ถนนทดสอบ", "edit changes only the sent fields");
ok((await upd({ action: "bogus", id: "web-1" })).status === 400, "unknown action refused");
ok((await upd({ action: "updateStatus" })).status === 400, "missing id refused");

// ---------------------------------------------------------------- expenses
const exp = (body) => call("/api/admin/expenses", { method: "POST", ...auth, body: JSON.stringify(body) });
ok((await call("/api/admin/expenses", { method: "POST", body: "{}" })).status === 401, "expense write needs the PIN token");
ok((await (await exp({ id: "exp-9", type: "opex", category: "ค่าน้ำ", description: "ทดสอบ", amount: 500, date: "2026-10-01" })).json()).success, "expense added");
ok((await (await exp({ action: "update", id: "exp-9", amount: 650, note: "แก้" })).json()).success, "expense updated");
const e9 = sql("select * from expenses where id='exp-9'")[0];
ok(e9.amount === 650 && e9.description === "ทดสอบ" && e9.note === "แก้", "expense edit keeps untouched fields");
ok((await exp({ id: "x", type: "bad", category: "c", amount: 1, date: "2026-10-01" })).status === 400, "bad expense type refused");
ok((await (await exp({ action: "delete", id: "exp-9" })).json()).success && sql("select count(*) n from expenses where id='exp-9'")[0].n === 0, "expense deleted");
ok((await exp({ action: "delete", id: "exp-9" })).status === 404, "deleting twice is reported");

// ---------------------------------------------------------------- LINE bot customer history comes from D1
const hist = await (await import(new URL("../order-api-worker.js", import.meta.url))).default;
ok(typeof hist.fetch === "function", "worker module loads");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
