# SpendGuard

**The safety layer between AI agents and your money.**

AI agents now pay invoices, buy API calls over x402 and run recurring transfers. The expensive failures are rarely exotic hacks. They are ordinary: an agent retries a payment that was still confirming and pays twice, loops on an error and fires twenty payments, or signs an "approve" from another tool that quietly grants unlimited spending. PayBox already guarantees that nothing is signed without a grant or approval. SpendGuard adds the judgement in between: *should this agent pay this, right now, again?*

SpendGuard is a PayBox marketplace plugin for USDC on Base and x402. It:

- **Explains** any Base transaction in plain English before you approve it: who receives what, unlimited approvals, approvals to plain addresses, transfers to the token contract.
- **Stops** risky payments: per-transaction limit, daily cap, unlimited approvals, invalid targets.
- **Prevents duplicates**: one payment per payment key. It blocks while a payment is in flight, after it settled, and when an agent loops through fresh keys (retry storm).
- **Pauses on ambiguity** (a PayBox `error`, an expired lock with no final status, an unconfirmed transaction on-chain) and only continues after a **wallet-signed override bound to that exact payment**.
- **Proves the outcome**: after `success` it reads the Base receipt and checks that exactly the decoded USDC transfer happened.
- **Keeps a tamper-evident audit log**: every decision is hash-chained per wallet, and `audit_log verify` detects any edit.
- **Runs recurring and goal rules** (weekly, every N days, save-toward-a-goal, sweep-above-threshold). Every run goes through the same guard.

## What is verified, by whom

SpendGuard is careful about these words, and so is every message it returns.

| Phrase | Meaning |
|---|---|
| Decoded by SpendGuard | SpendGuard's own reading of the calldata. Labelled "SpendGuard's own decoding (not verified by PayBox)". Compare it with the PayBox transaction window. |
| Observed on-chain | SpendGuard read the Base receipt and found exactly one matching USDC `Transfer` from this wallet. It does not mean the recipient is trustworthy or that a service was delivered. |
| Authorized by wallet signature | The wallet owner signed an EIP-712 message for one retry of one exact payment. It does not make the payment safe; hard limits and duplicate checks still apply. |
| PayBox approved / success | PayBox's own status from `get_request`. `success` means confirmed on-chain. |

## Safety model

There are two layers, and SpendGuard never weakens the first.

1. **PayBox is the hard ceiling.** Your grant, approval mode and passkey decide what can be signed at all. SpendGuard never holds keys, never signs, and never sees secrets.
2. **SpendGuard decides when it is sensible.** It only returns a PayBox transaction proposal after an `allow` decision, and each decision can be used once.

Specific guarantees:

- **Single-use decisions with an in-flight lock.** Using a decision and locking the payment key happen in one database batch, so two parallel agents cannot both get a proposal for the same key. The returned transaction is decoded again and must match the approved fingerprint and amount, or nothing is proposed.
- **An expired lock pauses and never auto-allows.** If no final status was reported, SpendGuard assumes the payment may have gone through.
- **Overrides are narrow.** An override is bound to the wallet, the decision, the payment key, the transaction fingerprint, the amount, the exact reason codes and an expiry. It is single-use. It can never clear limits, unlimited approvals, invalid targets, duplicates, denials or an active in-flight lock.
- **Per-wallet isolation on a shared backend.** A wallet address is public, so it is not a credential. Each wallet opens a 24-hour session by signing an EIP-712 challenge with PayBox `request_wallet_sign`. Every route checks that the session's wallet owns the data. The owner key (a brokered PayBox header) only proves the call came from this plugin.
- **Plugin runtime rules.** There is no network activity at startup or listing. Every call has a 6s budget, with 3s per request, no redirects and exact hosts only. Secrets are never read from the environment, and no explanation is put inside the proposal schema.

## Tools

| Tool | What it does |
|---|---|
| `explain_transaction` | Plain-English decoding of a Base call or x402 request. Read-only. |
| `check_payment` | The guard. Returns `allow`, `pause` or `block` with reasons. `dry_run` (with optional `simulate`) needs no session or network. |
| `propose_usdc_transfer` | Turns an `allow` decision into a PayBox EVM proposal. Builds the transfer itself. |
| `propose_x402` | Turns an `allow` decision into a PayBox x402 proposal, for owner-allowed hosts only. |
| `report_status` | Records the PayBox status from `get_request`. On `success` with `tx_hash`, it observes the receipt. |
| `confirm_override` | Submits the wallet signature for a paused payment's override challenge. |
| `session` | `start` / `complete` / `revoke` a wallet-signature session. |
| `audit_log` | `list` or `verify` the hash-chained log. |
| `rules` | `create` / `list` / `pause` / `resume` / `revoke` recurring and goal rules. |
| `run_due_rules` | Finds the next due rule and runs the guard for it. It never proposes on its own. |

## Agent flows

**Pay an invoice safely**

1. `session start` → `request_wallet_sign` (typedData) → poll `get_request` → `session complete`.
2. `check_payment` with `payment_key: "invoice-42"` → `allow` and a `decision_id`.
3. `propose_usdc_transfer` → submit the proposal **once** → poll `get_request` (never call the tool again).
4. `report_status` on each change, including `tx_hash` on `success` → `settled`, observed on-chain: match.

**Check another plugin's transaction**: `explain_transaction`, then `check_payment` with `kind: "raw_evm"`. On `allow` the key is locked; submit the original proposal through its own plugin, then `report_status`.

**Savings goal**: `rules create` with `{type: "goal", recipient, amount_usdc: "10", target_usdc: "500", every_days: 7}`. When you check in, call `run_due_rules`; each slot has its own payment key, so it can pay at most once.

Example prompts:

- "Use SpendGuard to pay 5 USDC to 0x… for invoice 42."
- "Before I approve this, explain what this transaction does: …"
- "Save 10 USDC a week into my savings wallet until it holds 500."
- "Show me SpendGuard's audit log and verify it."

## Repository layout

- `my-plugin/` — the PayBox plugin (built from the official starter). `dist/plugin.mjs` is the upload.
  - `src/guard/evaluate.ts` — the pure decision rules, shared with the backend.
  - `src/explain/` — calldata decoding, the token registry, receipt observation.
  - `src/tools/` — the MCP tools. `src/rules/` — schedules.
  - `scripts/demo.ts` — the end-to-end demo.
- `backend/` — a Cloudflare Worker and D1 database: sessions, decisions, locks, overrides, rules, the audit chain.
  - `local/` runs the same handler on Node with SQLite for development and tests.

## Run locally

Requires Node 24 and pnpm 11.

```bash
cd my-plugin && pnpm install && pnpm build
pnpm test:unit        # 35 guard, decoding and schedule tests
pnpm test             # PayBox conformance on dist/plugin.mjs
pnpm demo             # full story against a local backend (add -- --live-rpc to read mainnet.base.org)
cd ../backend && pnpm test   # 10 backend tests: auth, isolation, races, overrides, tampering, rules
```

The demo spawns `dist/plugin.mjs` once per tool call, as PayBox does. It uses a throwaway local key in place of `request_wallet_sign` and `SIMULATE=receipt_match` in place of a real receipt (both clearly labelled in the output). Nothing moves funds.

## Deploy the backend

You need a Cloudflare API token with *Workers Scripts: Edit* and *D1: Edit*. Wrangler is not needed.

```bash
cd backend
export CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=...
pnpm run deploy   # not "pnpm deploy", which is a built-in pnpm command
```

Or reuse a browser login instead of a token: `node scripts/cf-login.mjs` (same OAuth flow as `wrangler login`, without installing wrangler), then `node scripts/deploy-with-wrangler-login.mjs`.

Either way, this creates the `spendguard` D1 database, applies `schema.sql`, uploads the Worker and prints its URL. It generates an owner key into `backend/.owner-key` (gitignored, never printed).

## PayBox portal settings

- **Artifact**: `my-plugin/dist/plugin.mjs`
- **Network hosts**: `mainnet.base.org` and `spendguard.carrot-sponsor-worker.workers.dev`, plus any x402 hosts you allow.
- **Live backend**: `https://spendguard.carrot-sponsor-worker.workers.dev`
- **Secret header** for the Worker host: `Authorization` = `Bearer <contents of backend/.owner-key>`. Paste it into the portal only.
- **Environment variables** (none are secret):

| Variable | Default | Purpose |
|---|---|---|
| `SPENDGUARD_BACKEND_URL` | — (required for live checks) | Worker URL |
| `BASE_RPC_URL` | `https://mainnet.base.org` | Base JSON-RPC |
| `MAX_PER_TX_USDC` | `25` | Per-payment limit |
| `DAILY_CAP_USDC` | `100` | Rolling 24h cap |
| `MIN_RETRY_INTERVAL_S` | `30` | Minimum gap between attempts on one key |
| `MAX_ATTEMPTS_PER_WINDOW` / `RETRY_WINDOW_S` | `8` / `600` | Retry-storm threshold |
| `INFLIGHT_LOCK_S` | `300` | How long a proposed payment stays locked |
| `X402_ALLOWED_HOSTS` | empty | Comma-separated hosts `propose_x402` may pay |

## Demo

The hackathon demo is a video, posted with the submission. It is not in this repository.

In Claude, through PayBox, SpendGuard:

1. Explains a draft that would let a made-up address spend all of the wallet's USDC, and blocks it. An unlimited approval cannot be signed away.
2. Allows one USDC on Base. Nothing moves until the wallet signs in PayBox.
3. Reads the receipt and checks that the USDC which moved is the transfer it decoded.
4. Blocks a second payment of the same invoice, because it has already settled.
5. Shows the hash-chained audit log for that wallet.

## What was built here and what was reused

- Reused: the official PayBox plugin starter (MCP server scaffold, conformance and test scripts, proposal schemas in `src/paybox.ts`), `@modelcontextprotocol/server`, `zod`, `viem` (ABI encoding, EIP-712 verification), and Cloudflare Workers/D1.
- Built for this hackathon: the guard rules, decoding and risk flags, receipt observation, the decision/lock/override protocol, wallet-signature sessions, the hash-chained audit log, recurring and goal rules, the backend, tests and the demo.
