"""
push_to_gsheet.py
อ่าน delta rows จาก DataNayax.xlsx แล้ว append ขึ้น Google Sheets
รันบนเครื่อง Windows: python push_to_gsheet.py
"""
import zipfile, re, json, os
from datetime import datetime, timedelta

# ─── CONFIG ───────────────────────────────────────────────────
CREDS_PATH  = r"D:\Demo\OFresh\gsheet_creds.json"
XLSX_PATH   = r"D:\Demo\OFresh\DataNayax.xlsx"
SHEET_ID    = "1wcejCjw0hcyCjx9ypLzDl959AhpUz6ZAiD3OtVdUV48"
TAB_NAME    = "Nayax_R0_A2002715304_D20260119_"
# ─────────────────────────────────────────────────────────────

EXCEL_BASE = datetime(1899, 12, 30)

def serial_to_dt(s):
    try:
        return EXCEL_BASE + timedelta(days=float(s))
    except:
        return None

def serial_to_datestr(s):
    dt = serial_to_dt(s)
    return dt.strftime("%Y/%m/%d") if dt else ""

def serial_to_datetimestr(s):
    dt = serial_to_dt(s)
    return dt.strftime("%d/%m/%Y %H:%M:%S") if dt else ""

# ─── Shared string index → text ───────────────────────────────
SS_MAP = {
    31: "OFresh_CentralFest",
    14: "Taweewoot",
    16: "Mobile Phone",
    20: "Contactless Reader",
    25: "Contact Reader",
    26: "Magnetic Card Reader",
    368: "Unknown(1  69.00)",
    373: "Unknown(1  0.00)",
}

def load_shared_strings(z):
    if "xl/sharedStrings.xml" not in z.namelist():
        return {}
    import xml.etree.ElementTree as ET
    root = ET.fromstring(z.read("xl/sharedStrings.xml"))
    ns = {"n": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    shared = {}
    for i, si in enumerate(root.findall("n:si", ns)):
        t = si.find("n:t", ns)
        if t is not None:
            shared[i] = t.text or ""
        else:
            parts = [r.find("n:t", ns) for r in si.findall("n:r", ns)]
            shared[i] = "".join((p.text or "") for p in parts if p is not None)
    return shared

def read_xlsx_rows(xlsx_path):
    """อ่าน rows จาก sheet1 ของ DataNayax.xlsx"""
    with zipfile.ZipFile(xlsx_path) as z:
        shared = load_shared_strings(z)
        raw = z.read("xl/worksheets/sheet1.xml")

    # ดึงค่า cell ด้วย regex (เร็วกว่า ET สำหรับไฟล์ใหญ่)
    # Pattern: <c r="XN" [attrs]><v>VAL</v></c>
    cell_pat = re.compile(
        rb'<c r="([A-Z]+)(\d+)"([^>]*)>'
        rb'(?:<f[^/]*/>\s*)?'
        rb'<v>([^<]*)</v></c>'
    )
    rows = {}
    for m in cell_pat.finditer(raw):
        col   = m.group(1).decode()
        r_num = int(m.group(2))
        attrs = m.group(3).decode()
        val   = m.group(4).decode()

        if r_num < 2:  # skip header
            continue

        is_shared = 't="s"' in attrs
        if is_shared:
            val = shared.get(int(val), val)

        if r_num not in rows:
            rows[r_num] = {}
        rows[r_num][col] = val

    return rows

def get_gsheet_last_txn_ids(ws):
    """ดึง Transaction ID ทั้งหมดที่มีอยู่ใน Google Sheet แล้ว (column H)"""
    try:
        h_col = ws.col_values(8)  # column H = index 8
        return set(str(v).strip() for v in h_col[1:] if v)  # skip header
    except:
        return set()

def rows_to_append(xlsx_rows, existing_txn_ids):
    """หา rows ใหม่ที่ยังไม่มีใน Google Sheet"""
    new_rows = []
    for r_num in sorted(xlsx_rows.keys()):
        row = xlsx_rows[r_num]
        txn_id = str(row.get("H", "")).strip()
        if not txn_id or txn_id in existing_txn_ids:
            continue

        # แปลงเป็น list ตาม column order A-N
        machine_name  = row.get("A", "OFresh_CentralFest")
        au_serial     = row.get("B", "")
        se_serial     = row.get("C", "")
        product       = row.get("D", "")
        card_first4   = row.get("E", "")
        card_last4    = row.get("F", "")
        card_type     = row.get("G", "")
        transaction_id = txn_id
        au_value      = row.get("I", "")
        pay_rrn       = row.get("J", "")
        actor         = row.get("K", "Taweewoot")
        serial_num    = row.get("L", "")
        pay_method_id = row.get("M", "")
        date_str      = serial_to_datestr(au_serial) if au_serial else row.get("N", "")

        # แปลง serial → datetime string สำหรับ B, C
        au_dt_str = serial_to_datetimestr(au_serial)
        se_dt_str = serial_to_datetimestr(se_serial)

        new_rows.append([
            machine_name,   # A
            au_dt_str,      # B - machineAuTime
            se_dt_str,      # C - machineSeTime
            product,        # D
            card_first4,    # E
            card_last4,     # F
            card_type,      # G
            transaction_id, # H
            au_value,       # I
            pay_rrn,        # J
            actor,          # K
            serial_num,     # L
            pay_method_id,  # M
            date_str,       # N
        ])

    return new_rows

def main():
    import gspread

    print(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] Starting push_to_gsheet...")

    # เชื่อมต่อ Google Sheets
    print("  Connecting to Google Sheets...")
    gc = gspread.service_account(filename=CREDS_PATH)
    sh = gc.open_by_key(SHEET_ID)
    ws = sh.worksheet(TAB_NAME)

    # ดึง TXN IDs ที่มีอยู่แล้วใน Google Sheet
    print("  Reading existing Transaction IDs from Google Sheet...")
    existing_txn_ids = get_gsheet_last_txn_ids(ws)
    print(f"  Existing rows in Google Sheet: {len(existing_txn_ids)}")

    # อ่าน DataNayax.xlsx
    print(f"  Reading {XLSX_PATH}...")
    xlsx_rows = read_xlsx_rows(XLSX_PATH)
    print(f"  Total data rows in xlsx: {len(xlsx_rows)}")

    # หา delta rows
    new_rows = rows_to_append(xlsx_rows, existing_txn_ids)
    print(f"  New rows to append: {len(new_rows)}")

    if not new_rows:
        print("  Nothing to append. Google Sheet is up to date.")
        return

    # Append ขึ้น Google Sheet
    print(f"  Appending {len(new_rows)} rows...")
    ws.append_rows(new_rows, value_input_option="USER_ENTERED")
    print(f"  Done! Appended rows:")
    for r in new_rows:
        print(f"    TXN {r[7]}: {r[1]} | {r[3]} | {r[6]}")

    print(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] Finished.")

if __name__ == "__main__":
    main()
