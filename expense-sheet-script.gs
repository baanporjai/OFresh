// ใช้สเปรดชีตเดิม (เช่นชีตออเดอร์ส้ม) แล้วเพิ่มแท็บใหม่ก็ได้ — ใส่ ID สเปรดชีตที่จะใช้ตรงนี้
const SHEET_ID = '<ใส่ Spreadsheet ID ของสเปรดชีต (ใหม่หรือของเดิมก็ได้)>';
// ชื่อแท็บ (sheet tab) ที่เก็บข้อมูลต้นทุน/ค่าใช้จ่ายจริงๆ — ต้องระบุชื่อเจาะจง
// ห้ามใช้ getSheets()[0] เหมือน order-sheet-script.gs เพราะถ้าใช้สเปรดชีตร่วมกับออเดอร์
// แท็บแรก (index 0) จะเป็นแท็บออเดอร์ ไม่ใช่แท็บต้นทุน/ค่าใช้จ่าย — จะเขียนข้อมูลผิดที่ทันที
const SHEET_NAME = 'Expenses';

function doPost(e) {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  const data = JSON.parse(e.postData.contents);

  // อ่านหัวคอลัมน์จริงจากแถวแรกของชีต แล้วจับคู่ค่าตามชื่อคอลัมน์เสมอ
  // (กันปัญหาข้อมูลเลื่อนคอลัมน์ผิด ถ้ามีคนแทรก/สลับคอลัมน์ในชีตภายหลัง)
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
