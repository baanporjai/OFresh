const SHEET_ID = '1gM9mwHPeLoggthOBpwi6GXPlFntYvHFYzTqKRQIhNYg';

function doPost(e) {
  // เปิดสเปรดชีตด้วย ID ตรงๆ แทน getActiveSpreadsheet() เพราะทำงานได้แน่นอนไม่ว่า
  // deployment จะถูกสร้างแบบ container-bound หรือ standalone ก็ตาม
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
  const data = JSON.parse(e.postData.contents);

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
