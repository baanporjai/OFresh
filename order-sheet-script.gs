const SHEET_ID = '1gM9mwHPeLoggthOBpwi6GXPlFntYvHFYzTqKRQIhNYg';
const EXPENSE_SHEET_NAME = 'Expenses'; // ชื่อแท็บที่เก็บข้อมูลต้นทุน/ค่าใช้จ่าย (คนละแท็บกับออเดอร์ส้ม)

function doPost(e) {
  const data = JSON.parse(e.postData.contents);

  // คำขอเกี่ยวกับต้นทุน/ค่าใช้จ่าย (จากหน้า /admin/accounting) แยกเส้นทางออกไปทันที
  // ไม่ปนกับโค้ดออเดอร์ส้มด้านล่าง — ใช้ Apps Script ตัวเดียวกัน คนละแท็บในสเปรดชีตเดียวกัน
  if (data.target === 'expense') {
    return handleExpenseRequest(data);
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

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
