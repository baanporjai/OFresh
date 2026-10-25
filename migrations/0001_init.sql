-- O'Fresh data (was the Google Sheet tabs Orders / Expenses / Nayax Data). Text columns keep what the sheet showed,
-- so the CSV the admin pages read back from D1 has exactly the layout they already parse.

CREATE TABLE orders (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  id            TEXT NOT NULL UNIQUE,
  ts            TEXT NOT NULL DEFAULT '',     -- "D/M/YYYY, H:MM:SS" Thailand time
  name          TEXT NOT NULL DEFAULT '',
  phone         TEXT NOT NULL DEFAULT '',
  line          TEXT NOT NULL DEFAULT '',
  qty           REAL NOT NULL DEFAULT 0,      -- kilograms
  total         REAL NOT NULL DEFAULT 0,
  address       TEXT NOT NULL DEFAULT '',
  delivery_date TEXT NOT NULL DEFAULT '',     -- YYYY-MM-DD
  note          TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE expenses (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT NOT NULL UNIQUE,
  ts          TEXT NOT NULL DEFAULT '',
  type        TEXT NOT NULL DEFAULT 'opex',   -- cogs | opex
  category    TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  amount      REAL NOT NULL DEFAULT 0,
  date        TEXT NOT NULL DEFAULT '',       -- YYYY-MM-DD
  note        TEXT NOT NULL DEFAULT ''
);

-- one row per machine transaction; transaction_id is the key, so re-uploading a report never double counts
CREATE TABLE nayax_sales (
  transaction_id        TEXT PRIMARY KEY,
  machine_name          TEXT NOT NULL DEFAULT '',
  machine_au_time       TEXT NOT NULL DEFAULT '',   -- "D/M/YYYY H:MM:SS" Thailand time, as Nayax writes it
  machine_se_time       TEXT NOT NULL DEFAULT '',
  product               TEXT NOT NULL DEFAULT '',
  card_first4digits     TEXT NOT NULL DEFAULT '',
  card_last4digits      TEXT NOT NULL DEFAULT '',
  card_type_desc        TEXT NOT NULL DEFAULT '',
  au_value              TEXT NOT NULL DEFAULT '',
  pay_serv_transid      TEXT NOT NULL DEFAULT '',
  actor_desc            TEXT NOT NULL DEFAULT '',
  machine_serial_number TEXT NOT NULL DEFAULT '',
  payment_method_id_enc TEXT NOT NULL DEFAULT '',
  sale_date             TEXT NOT NULL DEFAULT ''    -- YYYY/MM/DD (column N of the old sheet)
);
CREATE INDEX idx_nayax_sale_date ON nayax_sales (sale_date);

-- which files were uploaded when, and what came of each
CREATE TABLE uploads (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL,
  kind       TEXT NOT NULL,
  filename   TEXT NOT NULL DEFAULT '',
  total_rows INTEGER NOT NULL DEFAULT 0,
  added      INTEGER NOT NULL DEFAULT 0,
  skipped    INTEGER NOT NULL DEFAULT 0,
  bad        INTEGER NOT NULL DEFAULT 0,
  by_user    TEXT NOT NULL DEFAULT ''
);

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
