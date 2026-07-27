const SHEET_ID = '1gM9mwHPeLoggthOBpwi6GXPlFntYvHFYzTqKRQIhNYg';
const EXPENSE_SHEET_NAME = 'Expenses'; // ชื่อแท็บที่เก็บข้อมูลต้นทุน/ค่าใช้จ่าย (คนละแท็บกับออเดอร์ส้ม)
const VISITS_SHEET_NAME = 'Visits';    // ชื่อแท็บที่เก็บรูปลูกค้าหน้าตู้ + ผลวิเคราะห์ (คนละแท็บ เช่นกัน)
const VISIT_PHOTO_FOLDER_NAME = "O'Fresh Customer Visit Photos";

function doPost(e) {
  const data = JSON.parse(e.postData.contents);

  // คำขอเกี่ยวกับต้นทุน/ค่าใช้จ่าย (จากหน้า /admin/accounting) แยกเส้นทางออกไปทันที
  // ไม่ปนกับโค้ดออเดอร์ส้มด้านล่าง — ใช้ Apps Script ตัวเดียวกัน คนละแท็บในสเปรดชีตเดียวกัน
  if (data.target === 'expense') {
    return handleExpenseRequest(data);
  }

  // คำขอเกี่ยวกับรูปลูกค้าหน้าตู้ (จากหน้า /admin/visits) — แยกเส้นทางแบบเดียวกับ expense ด้านบน
  if (data.target === 'visit') {
    return handleVisitRequest(data);
  }

  // เปิดสเปรดชีตด้วย ID ตรงๆ แทน getActiveSpreadsheet() เพราะทำงานได้แน่นอนไม่ว่า
  // deployment จะถูกสร้างแบบ container-bound หรือ standalone ก็ตาม
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];

  // อ่านหัวคอลัมน์จริงจากแถวแรกของชีต แล้วจับคู่ค่าตามชื่อคอลัมน์เสมอ
  // (กันปัญหาข้อมูลเลื่อนคอลัมน์ผิด ถ้ามีคนแทรก/สลับคอลัมน์ในชีตภายหลัง)
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(h => String(h).trim().toLowerCase());

  if (data.action === 'updateStatus') {
    return updateStatus(sheet, headers, data);
  }

  if (data.action === 'updateOrder') {
    return updateOrder(sheet, headers, data);
  }

  // ใช้เช็คว่า deployment ที่รันอยู่เป็นโค้ดเวอร์ชันไหน (ยิง POST {"action":"ping"} มาดูได้)
  if (data.action === 'ping') {
    return jsonOut({ success: true, version: 2, actions: ['updateStatus', 'updateOrder'] });
  }

  // กันพลาด: ถ้าระบุ action มาแต่ไม่รู้จัก ให้ตอบ error ทันที
  // ห้ามตกลงไปเพิ่มแถวใหม่เด็ดขาด (เคยเกิดเคสหน้าเว็บส่ง action ใหม่มาก่อนที่สคริปต์จะถูก deploy ตาม
  // แล้วกลายเป็นออเดอร์ซ้ำในชีต) — ฟอร์มสั่งซื้อจริงไม่ส่ง action มาอยู่แล้ว
  if (data.action) {
    return jsonOut({ success: false, error: 'Unknown action: ' + data.action });
  }

  const values = {
    timestamp: new Date(),
    id: data.id || '',
    name: data.name || '',
    phone: data.phone || '',
    line: data.line || '',
    qty: data.qty || 0,
    total: data.total || 0,
    address: data.address || '',
    deliverydate: data.deliveryDate || '',
    note: data.note || '',
    status: 'pending',
  };

  const row = headers.map(h => (h in values) ? values[h] : '');
  sheet.appendRow(row);

  return ContentService
    .createTextOutput(JSON.stringify({ success: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

function updateStatus(sheet, headers, data) {
  const colId = headers.indexOf('id') + 1;
  const colStatus = headers.indexOf('status') + 1;
  if (!colId || !colStatus) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: 'id or status column not found' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: 'No data rows' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const ids = sheet.getRange(2, colId, lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(data.id)) {
      sheet.getRange(i + 2, colStatus).setValue(data.status || 'pending');
      return ContentService
        .createTextOutput(JSON.stringify({ success: true }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }
  return ContentService
    .createTextOutput(JSON.stringify({ success: false, error: 'Order id not found' }))
    .setMimeType(ContentService.MimeType.JSON);
}

// แก้ไขรายละเอียดออเดอร์ (จากหน้า /admin/orders) — ตามหาแถวด้วย id แล้วแก้เฉพาะฟิลด์ที่ส่งมา
function updateOrder(sheet, headers, data) {
  const colId = headers.indexOf('id') + 1;
  if (!colId) return jsonOut({ success: false, error: 'id column not found' });

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return jsonOut({ success: false, error: 'No data rows' });

  // ชื่อคีย์ที่หน้าเว็บส่งมา (camelCase) → ชื่อหัวคอลัมน์ในชีต (lowercase)
  const fieldMap = {
    name: 'name', phone: 'phone', line: 'line', qty: 'qty', total: 'total',
    address: 'address', deliveryDate: 'deliverydate', note: 'note',
  };

  const ids = sheet.getRange(2, colId, lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(data.id)) {
      Object.keys(fieldMap).forEach(function(key) {
        if (!(key in data)) return; // แก้เฉพาะฟิลด์ที่ส่งมา ฟิลด์อื่นไม่แตะ
        const col = headers.indexOf(fieldMap[key]) + 1;
        if (col) sheet.getRange(i + 2, col).setValue(data[key]);
      });
      return jsonOut({ success: true });
    }
  }
  return jsonOut({ success: false, error: 'Order id not found' });
}

// ═══════════════ ต้นทุน / ค่าใช้จ่าย (หน้า /admin/accounting) ═══════════════

function handleExpenseRequest(data) {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(EXPENSE_SHEET_NAME);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(h => String(h).trim().toLowerCase());

  if (data.action === 'update') return updateExpense(sheet, headers, data);
  if (data.action === 'delete') return deleteExpense(sheet, headers, data);

  // action ไม่ระบุ หรือ 'add' → เพิ่มแถวใหม่
  const values = {
    timestamp: new Date(),
    id: data.id || '',
    type: data.type || 'opex',   // 'cogs' = ต้นทุนขาย, 'opex' = ค่าใช้จ่ายดำเนินงาน
    category: data.category || '',
    description: data.description || '',
    amount: data.amount || 0,
    date: data.date || '',       // วันที่เกิดรายการจริง YYYY-MM-DD ใช้จัดกลุ่มรายเดือน
    note: data.note || '',
  };

  const row = headers.map(h => (h in values) ? values[h] : '');
  sheet.appendRow(row);

  return jsonOut({ success: true, id: values.id });
}

function updateExpense(sheet, headers, data) {
  const colId = headers.indexOf('id') + 1;
  if (!colId) return jsonOut({ success: false, error: 'id column not found' });

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return jsonOut({ success: false, error: 'No data rows' });

  const editable = ['type', 'category', 'description', 'amount', 'date', 'note'];
  const ids = sheet.getRange(2, colId, lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(data.id)) {
      editable.forEach(field => {
        const col = headers.indexOf(field) + 1;
        if (col && (field in data)) sheet.getRange(i + 2, col).setValue(data[field]);
      });
      return jsonOut({ success: true });
    }
  }
  return jsonOut({ success: false, error: 'Expense id not found' });
}

function deleteExpense(sheet, headers, data) {
  const colId = headers.indexOf('id') + 1;
  if (!colId) return jsonOut({ success: false, error: 'id column not found' });

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return jsonOut({ success: false, error: 'No data rows' });

  const ids = sheet.getRange(2, colId, lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(data.id)) {
      sheet.deleteRow(i + 2);
      return jsonOut({ success: true });
    }
  }
  return jsonOut({ success: false, error: 'Expense id not found' });
}

// ═══════════════ รูปลูกค้าหน้าตู้ (หน้า /admin/visits) ═══════════════
// อ่านประวัติทำผ่าน "Publish to web" เป็น CSV ของแท็บ Visits (เหมือนออเดอร์ส้ม/ต้นทุน/nayax) —
// เขียนแค่ทางเดียวที่นี่ ผ่าน target: 'visit' ด้านบน ไม่ต้องมี doGet เพิ่ม

function handleVisitRequest(data) {
  if (data.action === 'saveVisit') return saveVisit(data);
  return jsonOut({ success: false, error: 'Unknown visit action: ' + data.action });
}

function saveVisit(data) {
  if (!data.imageBase64) return jsonOut({ success: false, error: 'Missing image' });

  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(VISITS_SHEET_NAME);
  if (!sheet) return jsonOut({ success: false, error: 'Visits tab not found' });

  const mimeType = data.mimeType || 'image/jpeg';
  const bytes = Utilities.base64Decode(data.imageBase64);
  const blob = Utilities.newBlob(bytes, mimeType, 'visit_' + Date.now() + '.jpg');

  const file = getVisitPhotoFolder_().createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  // แปลง URL แบบ "เปิดดูตรงๆ" แทนหน้า preview ของ Drive เพื่อใช้เป็น <img src> ได้เลย
  const photoUrl = 'https://drive.google.com/uc?export=view&id=' + file.getId();

  const timestamp = data.timestamp ? new Date(data.timestamp) : new Date();
  sheet.appendRow([
    timestamp,
    photoUrl,
    Number(data.peopleCount) || 0,
    !!data.hasChildren,
    data.matchedTxnTime || '',
    data.matchedAmount != null ? data.matchedAmount : '',
    data.notes || '',
    data.gender || '',
  ]);

  return jsonOut({ success: true, photoUrl: photoUrl });
}

function getVisitPhotoFolder_() {
  const folders = DriveApp.getFoldersByName(VISIT_PHOTO_FOLDER_NAME);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(VISIT_PHOTO_FOLDER_NAME);
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
