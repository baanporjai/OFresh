/**
 * O'Fresh — Customer Visit Photos backend (Google Apps Script Web App)
 *
 * Stores photos uploaded from the vending machine's front camera (via visits.html,
 * proxied through order-api-worker.js) plus the AI's read on group size / children,
 * and an optional matched Nayax sale. Photos are saved to a Drive folder; the sheet
 * only stores metadata + the Drive file URL.
 *
 * Sheet "Visits" headers (row 1): timestamp | photoUrl | peopleCount | hasChildren |
 *   matchedTxnTime | matchedAmount | notes
 *
 * Deploy: Extensions > Apps Script > paste this file > Deploy > New deployment
 *   Type: Web app · Execute as: Me · Who has access: Anyone
 * Then set Project Settings > Script Properties > ADMIN_KEY to a secret string
 * (this is a DIFFERENT key from LarnaCake's inventory ADMIN_KEY — don't reuse it).
 *
 * Updating an existing deployment: editing this file alone does NOT update the live
 * /exec URL — you must Deploy > Manage deployments > pick the deployment > Edit
 * (pencil) > Version: New version > Deploy.
 */

var SHEET_VISITS = 'Visits';
var PHOTO_FOLDER_NAME = "O'Fresh Customer Visit Photos";

function getAdminKey_() {
  return PropertiesService.getScriptProperties().getProperty('ADMIN_KEY');
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  var action = (e.parameter && e.parameter.action) || 'list';
  if (action === 'list') {
    if (e.parameter.key !== getAdminKey_()) {
      return jsonResponse_({ error: 'unauthorized' });
    }
    return jsonResponse_(getVisits_());
  }
  return jsonResponse_({ error: 'unknown action' });
}

function doPost(e) {
  var payload;
  try {
    payload = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse_({ error: 'invalid json' });
  }
  if (payload.key !== getAdminKey_()) {
    return jsonResponse_({ error: 'unauthorized' });
  }
  if (payload.action === 'saveVisit') {
    return jsonResponse_(saveVisit_(payload));
  }
  return jsonResponse_({ error: 'unknown action' });
}

function getVisitsSheet_() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_VISITS);
}

function getPhotoFolder_() {
  var folders = DriveApp.getFoldersByName(PHOTO_FOLDER_NAME);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(PHOTO_FOLDER_NAME);
}

function saveVisit_(payload) {
  if (!payload.imageBase64) {
    return { error: 'missing image' };
  }
  var mimeType = payload.mimeType || 'image/jpeg';
  var bytes = Utilities.base64Decode(payload.imageBase64);
  var blob = Utilities.newBlob(bytes, mimeType, 'visit_' + Date.now() + '.jpg');

  var file = getPhotoFolder_().createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  // แปลง URL แบบ "เปิดดูตรงๆ" แทนหน้า preview ของ Drive เพื่อใช้เป็น <img src> ได้เลย
  var photoUrl = 'https://drive.google.com/uc?export=view&id=' + file.getId();

  var timestamp = payload.timestamp ? new Date(payload.timestamp) : new Date();
  var sheet = getVisitsSheet_();
  sheet.appendRow([
    timestamp,
    photoUrl,
    Number(payload.peopleCount) || 0,
    !!payload.hasChildren,
    payload.matchedTxnTime || '',
    payload.matchedAmount != null ? payload.matchedAmount : '',
    payload.notes || '',
  ]);

  return { success: true, photoUrl: photoUrl };
}

function getVisits_() {
  var sheet = getVisitsSheet_();
  var values = sheet.getDataRange().getValues();
  var result = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (!row[0]) continue;
    result.push({
      timestamp: row[0] instanceof Date ? row[0].toISOString() : row[0],
      photoUrl: row[1],
      peopleCount: row[2],
      hasChildren: row[3],
      matchedTxnTime: row[4],
      matchedAmount: row[5],
      notes: row[6],
    });
  }
  result.reverse();
  return { visits: result };
}
