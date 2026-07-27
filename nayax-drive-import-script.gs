/**
 * นำเข้ารายงาน Nayax จาก Google Drive เข้าสเปรดชีต "Nayax Data" (ตัวที่สร้างขึ้นมาแทนตัวเดิมที่หายไป)
 *
 * หมายเหตุ: สเปรดชีต Nayax ตัวเดิม (ที่ update_nayax.py/push_to_gsheet.py เคยเขียนอยู่) ถูกลบไปแล้ว
 * ผู้ใช้สร้างสเปรดชีตใหม่ชื่อ "Nayax Data" ขึ้นมาแทน พร้อมข้อมูลเดิมกู้คืนมาแล้ว — สคริปต์นี้ปรับให้เขียน
 * ลงสเปรดชีตใหม่นี้แทน คอลัมน์ A-N ยังคงเดิมตามข้อมูลที่กู้คืนมา (รวมคอลัมน์ N "date" ที่คำนวณเพิ่มเอง)
 * dedupe ด้วย transaction_id (column H)
 *
 * ⚠️ ต้องเช็คด้วย: update_nayax.py/push_to_gsheet.py (สคริปต์ Python เดิม) ยัง hardcode SHEET_ID ของ
 * สเปรดชีตที่หายไปอยู่ — ถ้ายังอยากใช้คู่ขนานต่อ ต้องแก้ SHEET_ID ในไฟล์นั้นให้ชี้มาที่สเปรดชีตใหม่นี้ด้วย
 *
 * วิธีติดตั้ง:
 *   1. เปิดสเปรดชีต "Nayax Data" (ID ใหม่) → Extensions → Apps Script
 *   2. วางไฟล์นี้ทั้งหมด แก้ค่าคงที่ 2 ตัวด้านล่าง (Folder ID) ให้ตรงกับของจริง (โฟลเดอร์เดิมยังอยู่ ไม่ต้องสร้างใหม่)
 *      — TARGET_TAB_NAME ตั้งเป็น "Nayax Data" ไว้แล้ว แต่ควรเปิดสเปรดชีตเช็คชื่อแท็บจริงด้านล่างก่อนรัน
 *        (ถ้าชื่อไม่ตรง สคริปต์จะ error ชัดเจนว่าหาแท็บไม่เจอ ไม่สร้างแท็บใหม่ซ้ำให้แน่นอน)
 *   3. รันฟังก์ชัน importNayaxDriveReports ด้วยมือ 1 ครั้ง เพื่อ authorize สิทธิ์ Drive/Sheet ใหม่
 *      (สิทธิ์เดิมใช้กับสเปรดชีตเก่าที่หายไปแล้ว ต้อง authorize ใหม่)
 *   4. ตั้ง Time-driven trigger (ไอคอนนาฬิกาซ้ายมือ) ให้เรียก importNayaxDriveReports ตามความถี่ที่ต้องการ
 *
 * งานประจำที่ต้องทำเอง (นอกเหนือจากสคริปต์นี้): ทุกครั้งที่มีอีเมล "Nayax Transactions Report"
 * เข้ามา ให้กดลิงก์ดาวน์โหลด แล้วอัปโหลดไฟล์ CSV เข้าโฟลเดอร์ INCOMING_FOLDER_ID ด้านล่าง
 */

const INCOMING_FOLDER_ID = 'PASTE_INCOMING_FOLDER_ID_HERE'; // โฟลเดอร์เดิมยังอยู่ ใช้ ID เดิมได้เลย
const PROCESSED_FOLDER_ID = 'PASTE_PROCESSED_FOLDER_ID_HERE'; // โฟลเดอร์เดิมยังอยู่ ใช้ ID เดิมได้เลย
// ชื่อแท็บในสเปรดชีตใหม่ "Nayax Data" — เปิดสเปรดชีตเช็คชื่อแท็บจริงที่แถวล่างสุดของหน้าจอก่อนรัน
const TARGET_TAB_NAME = 'Nayax Data';
const TRANSACTION_ID_COLUMN = 8; // column H ในแท็บเป้าหมาย (1-indexed)

// หัวคอลัมน์จริงจากไฟล์ Nayax_R0_*.csv (ยืนยันจากตัวอย่างไฟล์จริงแล้ว) — ใช้จับคู่ตอนอ่านไฟล์ต้นทาง
// ไม่อิง index เผื่อ Nayax สลับลำดับคอลัมน์ในไฟล์ export ในอนาคต
const CSV_HEADERS = [
  'machine_name', 'machineAuTime', 'machineSeTime', 'product',
  'card_first4digits', 'card_last4digits', 'card_type_desc', 'transaction_id',
  'auValue', 'PayServTransid', 'actor_desc', 'machine_serial_number', 'payment_method_id_enc',
];

// ลำดับคอลัมน์ A-N ของแท็บเป้าหมาย (ต้องตรงกับที่ push_to_gsheet.py เขียนอยู่แล้วเป๊ะ ห้ามสลับ)
// ชื่อในลิสต์นี้อ้างอิงคีย์ของ CSV_HEADERS ด้านบน ยกเว้น '__DATE__' ที่คำนวณเพิ่มเอง (คอลัมน์ N ของแท็บเดิม
// เป็นวันที่รูปแบบ YYYY/MM/DD ที่ push_to_gsheet.py คำนวณจาก machineAuTime — ไม่มีให้ตรงๆ ใน CSV)
const TARGET_COLUMN_ORDER = [
  'machine_name', 'machineAuTime', 'machineSeTime', 'product',
  'card_first4digits', 'card_last4digits', 'card_type_desc', 'transaction_id',
  'auValue', 'PayServTransid', 'actor_desc', 'machine_serial_number', 'payment_method_id_enc',
  '__DATE__',
];

function importNayaxDriveReports() {
  const incomingFolder = DriveApp.getFolderById(INCOMING_FOLDER_ID);
  const processedFolder = DriveApp.getFolderById(PROCESSED_FOLDER_ID);
  const files = incomingFolder.getFilesByType(MimeType.CSV);

  const sheet = getTargetSheet_();
  const existingIds = getExistingTransactionIds_(sheet);

  let filesProcessed = 0;
  let rowsAdded = 0;

  while (files.hasNext()) {
    const file = files.next();
    const result = importOneFile_(file, sheet, existingIds);
    rowsAdded += result.rowsAdded;
    filesProcessed++;

    // ย้ายไฟล์ไป Processed หลังนำเข้าสำเร็จ กันไฟล์ค้าง/ประมวลผลซ้ำรอบถัดไป
    processedFolder.addFile(file);
    incomingFolder.removeFile(file);

    Logger.log('ไฟล์ %s: เพิ่ม %s แถวใหม่ (ข้าม %s แถวซ้ำ)', file.getName(), result.rowsAdded, result.rowsSkipped);
  }

  Logger.log('เสร็จสิ้น — ประมวลผล %s ไฟล์ รวมเพิ่ม %s แถว เข้าแท็บ "%s"', filesProcessed, rowsAdded, TARGET_TAB_NAME);
}

function importOneFile_(file, sheet, existingIds) {
  const csvText = file.getBlob().getDataAsString('UTF-8');
  const rows = Utilities.parseCsv(csvText);
  if (rows.length < 2) return { rowsAdded: 0, rowsSkipped: 0 };

  const headers = rows[0].map(h => h.trim());
  const colIndex = {};
  CSV_HEADERS.forEach(name => {
    const idx = headers.indexOf(name);
    if (idx !== -1) colIndex[name] = idx;
  });

  const idCol = colIndex['transaction_id'];
  if (idCol === undefined) {
    Logger.log('ข้ามไฟล์ %s — หาคอลัมน์ transaction_id ไม่เจอ (header ไม่ตรงที่คาดไว้)', file.getName());
    return { rowsAdded: 0, rowsSkipped: 0 };
  }

  const auTimeCol = colIndex['machineAuTime'];
  const newRows = [];
  let rowsSkipped = 0;

  for (let i = 1; i < rows.length; i++) {
    const raw = rows[i];
    const id = (raw[idCol] || '').trim();
    if (!id || existingIds.has(id)) { rowsSkipped++; continue; }

    const auTimeVal = auTimeCol !== undefined ? raw[auTimeCol] : '';
    newRows.push(TARGET_COLUMN_ORDER.map(name => {
      if (name === '__DATE__') return deriveDateString_(auTimeVal);
      const idx = colIndex[name];
      return idx !== undefined ? raw[idx] : '';
    }));
    existingIds.add(id);
  }

  if (newRows.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, TARGET_COLUMN_ORDER.length).setValues(newRows);
  }

  return { rowsAdded: newRows.length, rowsSkipped };
}

// machineAuTime เป็น "D/M/YYYY H:MM:SS" → แปลงเป็น "YYYY/MM/DD" ให้ตรงรูปแบบคอลัมน์ N เดิม
// (เทียบเท่า serial_to_datestr ใน push_to_gsheet.py แต่รับ string ตรงๆ แทน Excel serial number)
function deriveDateString_(machineAuTimeStr) {
  const m = (machineAuTimeStr || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return '';
  const [, d, mo, y] = m;
  return `${y}/${mo.padStart(2, '0')}/${d.padStart(2, '0')}`;
}

// ต้องมีแท็บนี้อยู่แล้ว (สร้าง/ตั้งค่าไว้จากการใช้งาน push_to_gsheet.py เดิม) — ถ้าหาไม่เจอ
// ไม่สร้างแท็บใหม่ให้เองเด็ดขาด เพราะจะกลายเป็นแท็บแยกที่ไม่ตรงกับของเดิม (ตามที่เคยเจอปัญหามาแล้ว)
function getTargetSheet_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = spreadsheet.getSheetByName(TARGET_TAB_NAME);
  if (!sheet) {
    throw new Error('ไม่พบแท็บ "' + TARGET_TAB_NAME + '" ในสเปรดชีตนี้ — ตรวจชื่อแท็บให้ตรงเป๊ะ (รวม "_" ต่อท้าย) ก่อนรันใหม่');
  }
  return sheet;
}

function getExistingTransactionIds_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return new Set();

  const values = sheet.getRange(2, TRANSACTION_ID_COLUMN, lastRow - 1, 1).getValues();
  return new Set(values.map(row => String(row[0]).trim()).filter(Boolean));
}
