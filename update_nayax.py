#!/usr/bin/env python3
"""
update_nayax.py
อัปเดต DataNayax.xlsx จากไฟล์ source DynamicTransactionsMonitorMega ล่าสุด

ใช้ zipfile + xml.etree.ElementTree โดยตรง (ไม่ใช้ openpyxl สำหรับ DataNayax
เพราะมี Fill() bug — แต่ใช้ openpyxl อ่าน source XLSX ได้ปกติ)

Usage:
    python update_nayax.py
    python update_nayax.py --dry-run    # แสดงผลลัพธ์โดยไม่เขียนไฟล์
"""

import os
import sys
import glob
import zipfile
import shutil
import csv
import logging
import argparse
from datetime import datetime, timedelta
from pathlib import Path
import xml.etree.ElementTree as ET

# ─────────────────────────────────────────────────────────────────────────────
# CONFIG — แก้ไข path ตามสภาพแวดล้อมจริง
# ─────────────────────────────────────────────────────────────────────────────
SOURCE_DIR   = r'D:\Demo\OFresh\source_nayax'
DATANAYAX    = r'D:\Demo\OFresh\DataNayax.xlsx'
BACKUP_DIR   = r'D:\Demo\OFresh\backup'
LOG_FILE     = r'D:\Demo\OFresh\update_nayax.log'

EXCEL_BASE   = datetime(1899, 12, 30)   # Excel date serial origin

# Shared string indices ใน DataNayax.xlsx (จาก sharedStrings.xml ที่มีอยู่)
SS = {
    'OFresh_CentralFest': 31,
    'Taweewoot':          14,
    'Mobile Phone':       16,
    'Contactless Reader': 20,
    'Contact Reader':     25,
    'Magnetic Card Reader': 26,
}

NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'

# ─────────────────────────────────────────────────────────────────────────────
# LOGGING
# ─────────────────────────────────────────────────────────────────────────────
os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s: %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S',
    handlers=[
        logging.FileHandler(LOG_FILE, encoding='utf-8'),
        logging.StreamHandler(sys.stdout),
    ]
)
log = logging.getLogger()

# ─────────────────────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def xml_escape(s: str) -> str:
    """Escape XML special chars และตัด control characters ที่ invalid ใน XML ออก"""
    s = str(s) if s is not None else ''
    # ตัด XML-illegal control characters (U+0000–U+0008, U+000B, U+000C, U+000E–U+001F, U+FFFE, U+FFFF)
    s = ''.join(c for c in s if ord(c) not in range(0x00, 0x09)
                                 and ord(c) not in (0x0B, 0x0C)
                                 and ord(c) not in range(0x0E, 0x20)
                                 and ord(c) not in (0xFFFE, 0xFFFF))
    return (s.replace('&', '&amp;')
             .replace('<', '&lt;')
             .replace('>', '&gt;')
             .replace('"', '&quot;'))


def to_excel_serial(dt: datetime) -> float:
    """datetime → Excel serial number (วันที่เป็น float)"""
    delta = dt - EXCEL_BASE
    return delta.days + delta.seconds / 86400.0


def parse_dt(s) -> datetime:
    """แปลง string/datetime → datetime"""
    if isinstance(s, datetime):
        return s
    s = str(s).strip()
    for fmt in (
        '%d/%m/%Y %H:%M:%S', '%d/%m/%Y %H:%M',
        '%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M',
        '%m/%d/%Y %H:%M:%S', '%d-%m-%Y %H:%M:%S',
    ):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    raise ValueError(f'ไม่สามารถแปลงวันเวลา: {repr(s)}')


def col_letters(cell_ref: str) -> str:
    """'AB12' → 'AB'"""
    return ''.join(c for c in cell_ref if c.isalpha())


def card_type_to_ss(card_type_str) -> int:
    """แปลง Card Type string → shared string index"""
    ct = str(card_type_str or '').lower()
    if 'mobile' in ct or 'phone' in ct:
        return SS['Mobile Phone']
    if 'contactless' in ct:
        return SS['Contactless Reader']
    if 'contact' in ct:
        return SS['Contact Reader']
    if 'magnetic' in ct:
        return SS['Magnetic Card Reader']
    return SS['Contactless Reader']  # default


def machine_name_ss(name: str):
    """
    คืน SS index ถ้าชื่อ machine ตรงกับ OFresh_CentralFest
    หรือว่างเปล่า, มิเช่นนั้นคืน None (ใช้ inlineStr แทน)
    """
    if not name:
        return SS['OFresh_CentralFest']
    n = name.lower().replace(' ', '').replace('_', '')
    if 'centralfest' in n or 'ofresh' in n:
        return SS['OFresh_CentralFest']
    return None

# ─────────────────────────────────────────────────────────────────────────────
# STEP 1 — หาไฟล์ source ล่าสุด
# ─────────────────────────────────────────────────────────────────────────────

def find_latest_source() -> str:
    pattern = os.path.join(SOURCE_DIR, 'DynamicTransactionsMonitorMega*')
    files = [f for f in glob.glob(pattern) if os.path.isfile(f)]
    if not files:
        raise FileNotFoundError(
            f'ไม่พบไฟล์ที่ขึ้นต้นด้วย DynamicTransactionsMonitorMega ใน:\n  {SOURCE_DIR}'
        )
    latest = max(files, key=os.path.getmtime)
    log.info(f'Source ล่าสุด: {os.path.basename(latest)} ({os.path.getsize(latest):,} bytes)')
    return latest

# ─────────────────────────────────────────────────────────────────────────────
# STEP 2 — อ่าน source file (รองรับทั้ง CSV และ XLSX)
# ─────────────────────────────────────────────────────────────────────────────

def _local(tag: str) -> str:
    """'{http://...}row' → 'row'  (ตัด namespace prefix ออก)"""
    return tag.split('}')[1] if '}' in tag else tag


def _iter_local(root, local_name: str):
    """Iterate elements by local tag name โดยไม่สนใจ namespace"""
    for elem in root.iter():
        if _local(elem.tag) == local_name:
            yield elem


def _find_local(parent, local_name: str):
    """find() แบบ namespace-agnostic"""
    for child in parent:
        if _local(child.tag) == local_name:
            return child
    return None


def _parse_cell_value(cell, ss_list: list) -> str:
    """
    อ่านค่าจาก <c> element รองรับ:
      t="str"        → <v> text โดยตรง (ไม่ใช้ shared string)
      t="s"          → shared string index ใน ss_list
      t="inlineStr"  → <is><t> text
      t="b"          → boolean
      (ไม่มี t)      → numeric, ใช้ <v> text
    """
    t = cell.get('t', '')
    if t == 'inlineStr':
        is_el = _find_local(cell, 'is')
        if is_el is not None:
            t_el = _find_local(is_el, 't')
            return (t_el.text or '') if t_el is not None else ''
        return ''
    v_el = _find_local(cell, 'v')
    if v_el is None or v_el.text is None:
        return ''
    val = v_el.text
    if t == 's':
        idx = int(val)
        return ss_list[idx] if idx < len(ss_list) else ''
    if t == 'b':
        return 'TRUE' if val == '1' else 'FALSE'
    return val  # t="str", t="n", t="" ทั้งหมดคืน text ตรงๆ


def _read_xlsx_raw(filepath: str) -> list[dict]:
    """
    อ่าน XLSX ด้วย zipfile + ET:
    - Namespace-agnostic (รองรับ xmlns:x= และ default xmlns=)
    - ไม่พึ่ง sharedStrings.xml (Nayax export ใช้ t="str" ทั้งหมด)
    - Cell / Row ที่ไม่มี r attribute → นับ sequential
    - Header detection: หา row แรกที่มี "Transaction ID" (ไม่ใช่ row r="1" ซึ่งเป็น title)
    """
    with zipfile.ZipFile(filepath, 'r') as zf:
        names = zf.namelist()

        # shared strings (optional — Nayax file ไม่มี แต่รองรับไว้)
        ss_list: list[str] = []
        if 'xl/sharedStrings.xml' in names:
            with zf.open('xl/sharedStrings.xml') as f:
                ss_root = ET.parse(f).getroot()
            for si in _iter_local(ss_root, 'si'):
                text = ''.join((t_el.text or '') for t_el in _iter_local(si, 't'))
                ss_list.append(text)

        # หา sheet worksheet
        sheet_path = 'xl/worksheets/sheet1.xml'
        if sheet_path not in names:
            candidates = sorted(n for n in names
                                if 'worksheets/sheet' in n and n.endswith('.xml'))
            if not candidates:
                raise FileNotFoundError(f'ไม่พบ sheet XML ใน {filepath}')
            sheet_path = candidates[0]

        with zf.open(sheet_path) as f:
            sheet_bytes = f.read()

    root = ET.fromstring(sheet_bytes)
    headers: list[str] = []
    rows: list[dict] = []
    header_found = False

    for row_el in _iter_local(root, 'row'):
        # อ่าน cell values — ถ้าไม่มี r attribute ใช้ sequential index
        cell_values: list[str] = []
        seq_idx = 0
        # สร้าง dict col_idx → value (รองรับทั้ง r attribute และ sequential)
        cell_map: dict[int, str] = {}

        for cell in row_el:
            if _local(cell.tag) != 'c':
                continue
            ref = cell.get('r', '')
            letters = col_letters(ref)
            if letters:
                # มี r attribute → แปลง column letter เป็น index
                col_idx = 0
                for ch in letters.upper():
                    col_idx = col_idx * 26 + (ord(ch) - ord('A') + 1)
                col_idx -= 1
            else:
                # ไม่มี r attribute → ใช้ sequential
                col_idx = seq_idx
            seq_idx = col_idx + 1

            val = _parse_cell_value(cell, ss_list)
            cell_map[col_idx] = val

        if not cell_map:
            continue

        max_col = max(cell_map.keys()) + 1
        row_vals = [cell_map.get(i, '') for i in range(max_col)]

        if not header_found:
            # ค้นหา header row โดย detect ว่ามี "Transaction ID" อยู่ไหม
            if any('Transaction ID' in v for v in row_vals):
                headers = [v.strip() for v in row_vals]
                header_found = True
                log.info(f'พบ header row: {len(headers)} columns')
            # else: ข้าม (title row หรือ metadata row)
        else:
            # data row
            d = {headers[i]: cell_map.get(i, '').strip()
                 for i in range(len(headers))}
            rows.append(d)

    log.info(f'อ่าน XLSX (zipfile+ET): {len(rows):,} rows, {len(headers)} columns')
    return rows

def read_source_file(filepath: str) -> list[dict]:
    ext = Path(filepath).suffix.lower()

    if ext in ('.csv', '.txt'):
        for enc in ('utf-8-sig', 'utf-8', 'cp874', 'cp1252', 'tis-620'):
            try:
                with open(filepath, encoding=enc, newline='') as f:
                    rows = list(csv.DictReader(f))
                # ตรวจว่า header มี column ที่ต้องการ
                if rows and 'Transaction ID' in rows[0]:
                    log.info(f'อ่าน CSV (encoding={enc}): {len(rows):,} rows')
                    return rows
            except (UnicodeDecodeError, Exception):
                continue
        raise RuntimeError('ไม่สามารถอ่าน CSV ด้วย encoding ใดๆ ที่รองรับ')

    else:
        # XLSX — อ่านด้วย zipfile + ET โดยตรง (ไม่ต้องใช้ openpyxl)
        return _read_xlsx_raw(filepath)

# ─────────────────────────────────────────────────────────────────────────────
# STEP 3 — อ่าน DataNayax.xlsx ผ่าน zipfile + ET (ไม่ใช้ openpyxl)
# ─────────────────────────────────────────────────────────────────────────────

def read_datanayax(xlsx_path: str) -> tuple:
    """
    คืนค่า:
      existing_txn_ids : set[str]   — Transaction IDs ที่มีอยู่แล้ว
      last_auth_dt     : datetime|None — auth time ล่าสุดใน file
      last_data_row    : int         — row number สุดท้ายที่มีข้อมูล
      sheet1_bytes     : bytes       — raw bytes ของ sheet1.xml
      sheet1_path      : str         — path ใน zip
    """
    with zipfile.ZipFile(xlsx_path, 'r') as zf:
        names = zf.namelist()

        # อ่าน shared strings
        shared_strings: list[str] = []
        if 'xl/sharedStrings.xml' in names:
            with zf.open('xl/sharedStrings.xml') as f:
                root = ET.parse(f).getroot()
            for si in root.findall(f'{{{NS}}}si'):
                text = ''.join(t.text or '' for t in si.iter(f'{{{NS}}}t'))
                shared_strings.append(text)

        # หา sheet1.xml
        sheet1_path = 'xl/worksheets/sheet1.xml'
        if sheet1_path not in names:
            candidates = [n for n in names
                          if n.startswith('xl/worksheets/sheet') and n.endswith('.xml')]
            if not candidates:
                raise FileNotFoundError('ไม่พบ sheet XML ใน DataNayax.xlsx')
            sheet1_path = sorted(candidates)[0]

        with zf.open(sheet1_path) as f:
            sheet1_bytes = f.read()

    # parse sheet XML
    root = ET.fromstring(sheet1_bytes)
    existing_txn_ids: set[str] = set()
    last_auth_dt: datetime | None = None
    last_data_row = 1

    for row_el in root.iter(f'{{{NS}}}row'):
        r_num = int(row_el.get('r', 0))
        if r_num <= 1:
            continue  # ข้าม header row

        # ดึงค่าแต่ละ cell
        row_vals: dict[str, str] = {}
        for cell in row_el:
            ref = cell.get('r', '')
            col = col_letters(ref)
            t   = cell.get('t', '')
            v   = cell.find(f'{{{NS}}}v')
            val = v.text if v is not None else None

            if t == 's' and val is not None:
                idx = int(val)
                val = shared_strings[idx] if idx < len(shared_strings) else val

            if val is not None:
                row_vals[col] = val

        # Transaction ID อยู่ column H
        txn = row_vals.get('H')
        if txn:
            existing_txn_ids.add(str(txn).strip())

        # Auth time อยู่ column B (Excel serial)
        b_val = row_vals.get('B')
        if b_val:
            try:
                dt = EXCEL_BASE + timedelta(days=float(b_val))
                if last_auth_dt is None or dt > last_auth_dt:
                    last_auth_dt = dt
            except (ValueError, OverflowError):
                pass

        if r_num > last_data_row:
            last_data_row = r_num

    log.info(
        f'DataNayax: {len(existing_txn_ids)} Transaction IDs, '
        f'last row={last_data_row}, '
        f'last auth={last_auth_dt}'
    )
    return existing_txn_ids, last_auth_dt, last_data_row, sheet1_bytes, sheet1_path

# ─────────────────────────────────────────────────────────────────────────────
# STEP 4 — กรอง rows ใหม่
# ─────────────────────────────────────────────────────────────────────────────

def filter_new_rows(
    source_rows: list[dict],
    existing_txn_ids: set[str],
    last_auth_dt: datetime | None,
) -> list[dict]:
    """
    คืนเฉพาะ rows ที่:
      1. Transaction ID ยังไม่มีใน DataNayax
      2. Machine Authorization Time > last_auth_dt (ถ้ามี)
    เรียงจากเก่า → ใหม่
    """
    new_rows: list[tuple[datetime, dict]] = []
    skip_dup = skip_old = skip_bad = 0

    for r in source_rows:
        txn_id = str(r.get('Transaction ID', '') or '').strip()
        if not txn_id:
            skip_bad += 1
            continue

        # ตรวจ duplicate
        if txn_id in existing_txn_ids:
            skip_dup += 1
            continue

        # แปลงวันเวลา
        auth_str = str(r.get('Machine Authorization Time', '') or '').strip()
        if not auth_str:
            skip_bad += 1
            continue
        try:
            auth_dt = parse_dt(auth_str)
        except ValueError as e:
            log.warning(f'Skip (bad date): {e}')
            skip_bad += 1
            continue

        # ตรวจว่าหลัง last_auth_dt
        if last_auth_dt and auth_dt <= last_auth_dt:
            skip_old += 1
            continue

        new_rows.append((auth_dt, r))

    # เรียงจากเก่า → ใหม่ ก่อนเพิ่มลง sheet
    new_rows.sort(key=lambda x: x[0])

    log.info(
        f'กรองได้ {len(new_rows)} rows ใหม่ '
        f'(ซ้ำ={skip_dup}, เก่าเกิน={skip_old}, bad={skip_bad})'
    )
    return [r for _, r in new_rows]

# ─────────────────────────────────────────────────────────────────────────────
# STEP 5 — สร้าง XML สำหรับแต่ละ row
# ─────────────────────────────────────────────────────────────────────────────

def build_row_xml(row_num: int, src: dict) -> str:
    """
    สร้าง <row r="N">...</row> ตาม column mapping ที่กำหนด

    Column mapping:
      A  machine_name         s="55" t="s"
      B  machineAuTime        s="57" (Excel serial)
      C  machineSeTime        s="57" (Excel serial)
      D  product              s="4"  t="str"
      E  card_first4digits    s="4"  t="str"
      F  card_last4digits     s="4"  t="str"
      G  card_type_desc       s="4"  t="s"
      H  transaction_id       s="4"  (numeric)
      I  auValue              s="4"  (numeric int)
      J  PayServTransid       s="4"  (numeric)
      K  actor_desc           s="4"  t="s"  (Taweewoot=14, fixed)
      M  payment_method_id    s="4"  (numeric)
      N  Date YYYY/MM/DD      s="60" t="str" + <f t="shared" si="39"/>
    """

    def cell_ss(col: str, ss_idx: int, style: str) -> str:
        """Cell ที่ใช้ shared string"""
        return f'<c r="{col}{row_num}" s="{style}" t="s"><v>{ss_idx}</v></c>'

    def cell_num(col: str, val, style: str) -> str:
        """Cell numeric"""
        return f'<c r="{col}{row_num}" s="{style}"><v>{val}</v></c>'

    def cell_str(col: str, val: str, style: str) -> str:
        """Cell string — ใช้ t="str" (ตรงกับ format ที่ DataNayax เดิมใช้)"""
        return (f'<c r="{col}{row_num}" s="{style}" t="str">'
                f'<v>{xml_escape(val)}</v></c>')

    cells: list[str] = []

    # ── A: machine_name ──────────────────────────────────────────────────────
    machine = str(src.get('Machine Name', '') or '').strip()
    ss_idx = machine_name_ss(machine)
    if ss_idx is not None:
        cells.append(cell_ss('A', ss_idx, '55'))
    else:
        cells.append(cell_str('A', machine, '55'))

    # ── B: Machine Authorization Time (Excel serial) ──────────────────────
    auth_dt = parse_dt(src['Machine Authorization Time'])
    cells.append(cell_num('B', f'{to_excel_serial(auth_dt):.10f}', '57'))

    # ── C: Machine Settlement Time ────────────────────────────────────────
    settle_raw = src.get('Machine Settlement Time', '') or ''
    try:
        settle_dt = parse_dt(settle_raw)
        settle_serial = to_excel_serial(settle_dt)
    except Exception:
        settle_serial = to_excel_serial(auth_dt)  # fallback ใช้ auth time
    cells.append(cell_num('C', f'{settle_serial:.10f}', '57'))

    # ── D: product (strip trailing newline) ───────────────────────────────
    product = str(src.get('Product Selection Info', '') or '').rstrip('\n').rstrip()
    cells.append(cell_str('D', product, '4'))

    # ── E/F: Card Number → first4 / last4 ────────────────────────────────
    card_num = str(src.get('Card Number', '') or '').strip()
    first4 = card_num[:4] if len(card_num) >= 4 else card_num
    last4  = card_num[-4:] if len(card_num) >= 4 else card_num
    cells.append(cell_str('E', first4, '4'))
    cells.append(cell_str('F', last4,  '4'))

    # ── G: Card Type (shared string) ──────────────────────────────────────
    ct_ss = card_type_to_ss(src.get('Card Type', ''))
    cells.append(cell_ss('G', ct_ss, '4'))

    # ── H: Transaction ID (numeric) ───────────────────────────────────────
    txn_id = str(src.get('Transaction ID', '') or '').strip()
    try:
        cells.append(cell_num('H', int(txn_id), '4'))
    except ValueError:
        cells.append(cell_str('H', txn_id, '4'))

    # ── I: Authorization Value (integer) ─────────────────────────────────
    try:
        au_val = int(float(str(src.get('Authorization Value', 0) or 0)))
    except (ValueError, TypeError):
        au_val = 0
    cells.append(cell_num('I', au_val, '4'))

    # ── J: Authorization RRN (numeric) ───────────────────────────────────
    rrn = str(src.get('Authorization RRN', '') or '').strip()
    try:
        cells.append(cell_num('J', int(rrn), '4'))
    except ValueError:
        cells.append(cell_str('J', rrn, '4'))

    # ── K: actor_desc = Taweewoot (fixed, SS index 14) ───────────────────
    cells.append(cell_ss('K', SS['Taweewoot'], '4'))

    # ── L: ไม่ได้ระบุ — ข้าม ────────────────────────────────────────────

    # ── M: Payment Method ID (numeric) ───────────────────────────────────
    pmid = str(src.get('Payment Method ID', '') or '').strip()
    try:
        cells.append(cell_num('M', int(pmid), '4'))
    except ValueError:
        cells.append(cell_str('M', pmid, '4'))

    # ── N: Date YYYY/MM/DD (shared formula si=39) ─────────────────────────
    date_str = auth_dt.strftime('%Y/%m/%d')
    cells.append(
        f'<c r="N{row_num}" s="60" t="str">'
        f'<f t="shared" si="39"/>'
        f'<v>{xml_escape(date_str)}</v>'
        f'</c>'
    )

    return f'<row r="{row_num}">{"".join(cells)}</row>\n'

# ─────────────────────────────────────────────────────────────────────────────
# STEP 6 — เขียนกลับลง DataNayax.xlsx
# ─────────────────────────────────────────────────────────────────────────────

def update_xlsx(
    xlsx_path: str,
    sheet1_bytes: bytes,
    sheet1_path: str,
    new_row_xmls: list[str],
) -> None:
    # Backup ก่อนทำการเปลี่ยนแปลง
    os.makedirs(BACKUP_DIR, exist_ok=True)
    ts = datetime.now().strftime('%Y%m%d_%H%M%S')
    backup_path = os.path.join(BACKUP_DIR, f'DataNayax_{ts}.xlsx')
    shutil.copy2(xlsx_path, backup_path)
    log.info(f'Backup: {backup_path}')

    # แทรก row XML ใหม่ก่อน </sheetData>
    sheet1_str = sheet1_bytes.decode('utf-8')
    insert_pos = sheet1_str.rfind('</sheetData>')
    if insert_pos == -1:
        raise RuntimeError('ไม่พบ </sheetData> ใน sheet1.xml — โครงสร้างไฟล์อาจผิดปกติ')

    new_sheet1 = (
        sheet1_str[:insert_pos]
        + ''.join(new_row_xmls)
        + sheet1_str[insert_pos:]
    )
    new_sheet1_bytes = new_sheet1.encode('utf-8')

    # เขียน xlsx ใหม่ (คัดลอกทุก entry ยกเว้น sheet1.xml ที่แทนที่)
    tmp_path = xlsx_path + '.tmp'
    try:
        with zipfile.ZipFile(xlsx_path, 'r') as zin:
            with zipfile.ZipFile(tmp_path, 'w', compression=zipfile.ZIP_DEFLATED) as zout:
                for item in zin.infolist():
                    if item.filename == sheet1_path:
                        zout.writestr(item, new_sheet1_bytes)
                    else:
                        zout.writestr(item, zin.read(item.filename))

        # ตรวจสอบว่าไฟล์ที่เขียนใหม่เปิดได้เป็น zip
        with zipfile.ZipFile(tmp_path, 'r') as ztest:
            bad = ztest.testzip()
            if bad:
                raise RuntimeError(f'ไฟล์ที่เขียนใหม่มีปัญหา: {bad}')

        os.replace(tmp_path, xlsx_path)

    except Exception:
        # rollback
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise

    log.info(f'บันทึกสำเร็จ: {xlsx_path}')

# ─────────────────────────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='อัปเดต DataNayax.xlsx')
    parser.add_argument('--dry-run', action='store_true',
                        help='แสดงผลลัพธ์โดยไม่เขียนไฟล์จริง')
    args = parser.parse_args()

    log.info('=' * 65)
    log.info(f'เริ่ม update_nayax.py{"  [DRY-RUN]" if args.dry_run else ""}')

    try:
        # 1. หา source ล่าสุด
        source_path = find_latest_source()

        # 2. อ่าน source
        source_rows = read_source_file(source_path)
        if not source_rows:
            log.warning('Source file ว่างเปล่า — ไม่มีอะไรทำ')
            return

        # 3. อ่าน DataNayax
        (existing_txn_ids, last_auth_dt,
         last_data_row, sheet1_bytes, sheet1_path) = read_datanayax(DATANAYAX)

        # 4. กรอง rows ใหม่
        new_rows = filter_new_rows(source_rows, existing_txn_ids, last_auth_dt)
        if not new_rows:
            log.info('ไม่มี transaction ใหม่ — DataNayax.xlsx ไม่มีการเปลี่ยนแปลง')
            return

        # 5. สร้าง XML สำหรับแต่ละ row
        row_xmls: list[str] = []
        for i, src_row in enumerate(new_rows):
            rn = last_data_row + 1 + i
            try:
                row_xmls.append(build_row_xml(rn, src_row))
            except Exception as e:
                txn = src_row.get('Transaction ID', '?')
                log.error(f'Skip TXN={txn}: {e}')

        if not row_xmls:
            log.warning('ไม่สามารถสร้าง row ใดได้เลย — ตรวจสอบ log สำหรับ error')
            return

        log.info(f'เตรียม {len(row_xmls)} rows (row {last_data_row+1}–{last_data_row+len(row_xmls)})')

        if args.dry_run:
            log.info('[DRY-RUN] ตัวอย่าง XML row แรก:')
            log.info(row_xmls[0].strip())
            log.info('[DRY-RUN] ไม่ได้เขียนไฟล์จริง')
            return

        # 6. เขียนกลับ
        update_xlsx(DATANAYAX, sheet1_bytes, sheet1_path, row_xmls)

        log.info(
            f'✓ เสร็จสิ้น เพิ่ม {len(row_xmls)} transactions '
            f'(rows {last_data_row+1}–{last_data_row+len(row_xmls)})'
        )

    except FileNotFoundError as e:
        log.error(f'ไม่พบไฟล์: {e}')
        sys.exit(1)
    except Exception as e:
        log.exception(f'ERROR: {e}')
        sys.exit(1)


if __name__ == '__main__':
    main()