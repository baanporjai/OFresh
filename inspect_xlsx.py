"""
inspect_xlsx.py  — ดู structure จริงของ source XLSX
รัน: python inspect_xlsx.py
"""
import zipfile, glob, os

SOURCE_DIR = r'D:\Demo\OFresh\source_nayax'
pattern = os.path.join(SOURCE_DIR, 'DynamicTransactionsMonitorMega*')
files = sorted(glob.glob(pattern), key=os.path.getmtime)
if not files:
    print('ไม่พบไฟล์ source'); exit(1)

path = files[-1]
print(f'File: {path}  ({os.path.getsize(path):,} bytes)\n')

with zipfile.ZipFile(path) as zf:
    print('=== Files inside ZIP ===')
    for n in zf.namelist():
        info = zf.getinfo(n)
        print(f'  {n}  ({info.file_size} bytes)')

    print('\n=== sheet1.xml (first 3000 chars) ===')
    sheet = None
    for n in zf.namelist():
        if 'sheet' in n and n.endswith('.xml') and 'worksheet' in n:
            sheet = n
            break
    if sheet:
        raw = zf.read(sheet).decode('utf-8', errors='replace')
        print(raw[:3000])
    else:
        print('(ไม่พบ sheet XML)')

    if 'xl/sharedStrings.xml' in zf.namelist():
        print('\n=== sharedStrings.xml (first 1000 chars) ===')
        raw = zf.read('xl/sharedStrings.xml').decode('utf-8', errors='replace')
        print(raw[:1000])
    else:
        print('\n(ไม่มี sharedStrings.xml)')