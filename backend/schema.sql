-- SpendGuard state. Every row is scoped to the wallet proven by a session signature.

CREATE TABLE IF NOT EXISTS session_challenges (
  id TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  nonce TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS payment_keys (
  wallet TEXT NOT NULL,
  key TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'new',
  last_status TEXT,
  locked_until INTEGER,
  request_id TEXT,
  observed TEXT,
  last_decision_id TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (wallet, key)
);

CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet TEXT NOT NULL,
  key TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS attempts_wallet_at ON attempts (wallet, at);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  key TEXT NOT NULL,
  kind TEXT NOT NULL,
  verdict TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  usdc_atomic TEXT,
  details TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  consume_token TEXT
);
CREATE INDEX IF NOT EXISTS decisions_wallet_consumed ON decisions (wallet, consumed_at);

CREATE TABLE IF NOT EXISTS override_challenges (
  id TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  usdc_atomic TEXT,
  reasons TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE IF NOT EXISTS overrides (
  id TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  usdc_atomic TEXT,
  reasons TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  challenge_id TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  spec TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Append-only, hash-chained per wallet. UNIQUE (wallet, prev_hash) stops concurrent forks.
CREATE TABLE IF NOT EXISTS audit_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet TEXT NOT NULL,
  event TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  UNIQUE (wallet, prev_hash)
);
