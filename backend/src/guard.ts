import * as z from "zod/v4";

import { evaluate } from "../../my-plugin/src/guard/evaluate.js";
import type { History, KeyState, OverrideGrant, ReasonCode } from "../../my-plugin/src/guard/types.js";
import { PAYBOX_STATUSES, PENDING_STATUSES } from "../../my-plugin/src/guard/types.js";
import { appendAudit, listAudit, verifyAudit } from "./audit.js";
import { OVERRIDE_STATEMENT, overrideTypedData, randomToken, verifyTyped } from "./auth.js";
import { type Ctx, HttpError, newId, parse, requireWallet } from "./http.js";

const DECISION_TTL = 240;
const OVERRIDE_TTL = 300;
const atomic = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);
const hash32 = z.string().regex(/^0x[0-9a-f]{64}$/);
const paymentKey = z.string().min(1).max(200);

const limitsSchema = z.object({
  maxPerTxUsdcAtomic: atomic,
  dailyCapUsdcAtomic: atomic,
  minRetryIntervalS: z.number().int().min(0).max(86_400),
  maxAttemptsPerWindow: z.number().int().min(1).max(1000),
  retryWindowS: z.number().int().min(1).max(86_400),
  inflightLockS: z.number().int().min(30).max(86_400),
}).strict();

const checkSchema = z.object({
  wallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((a) => a.toLowerCase()),
  payment_key: paymentKey,
  kind: z.enum(["usdc_transfer", "x402", "raw_evm"]),
  fingerprint: hash32,
  usdc_atomic: atomic.nullable(),
  counterparty: z.string().max(300).nullable(),
  flags: z.array(z.object({ code: z.string().max(64), message: z.string().max(500) }).strict()).max(16),
  chain: z.object({ ok: z.boolean(), latestNonce: z.number().int().optional(), pendingNonce: z.number().int().optional(), reason: z.string().max(200).optional() }).strict(),
  limits: limitsSchema,
  details: z.record(z.string(), z.unknown()),
  summary: z.string().max(500),
}).strict();

interface KeyRow {
  state: KeyState["state"];
  last_status: string | null;
  locked_until: number | null;
  request_id: string | null;
  observed: KeyState["observed"];
  last_decision_id: string | null;
}

async function keyRow(ctx: Ctx, wallet: string, key: string): Promise<KeyRow | null> {
  return ctx.db.prepare("SELECT * FROM payment_keys WHERE wallet = ? AND key = ?").bind(wallet, key).first<KeyRow>();
}

function toKeyState(row: KeyRow | null): KeyState {
  return row
    ? { state: row.state, lastStatus: row.last_status, lockedUntil: row.locked_until, requestId: row.request_id, observed: row.observed }
    : { state: "new", lastStatus: null, lockedUntil: null, requestId: null, observed: null };
}

export async function check(ctx: Ctx, body: unknown) {
  const wallet = requireWallet(ctx);
  const req = parse(checkSchema, body);
  if (req.wallet !== wallet) throw new HttpError(403, "wallet does not match the wallet this session was signed for");
  const key = req.payment_key;
  const db = ctx.db;

  const [row, windowCount, lastForKey, spentRows, overrideRow] = await Promise.all([
    keyRow(ctx, wallet, key),
    db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE wallet = ? AND at > ?").bind(wallet, ctx.now - req.limits.retryWindowS).first<{ n: number }>(),
    db.prepare("SELECT MAX(at) AS at FROM attempts WHERE wallet = ? AND key = ?").bind(wallet, key).first<{ at: number | null }>(),
    db.prepare("SELECT usdc_atomic FROM decisions WHERE wallet = ? AND consumed_at > ? AND usdc_atomic IS NOT NULL").bind(wallet, ctx.now - 86_400).all<{ usdc_atomic: string }>(),
    db.prepare("SELECT * FROM overrides WHERE wallet = ? AND key = ? AND used_at IS NULL AND expires_at > ? ORDER BY expires_at DESC LIMIT 1")
      .bind(wallet, key, ctx.now).first<{ id: string; fingerprint: string; usdc_atomic: string | null; reasons: string }>(),
  ]);

  const history: History = {
    key: toKeyState(row),
    attemptsInWindow: windowCount?.n ?? 0,
    lastAttemptAt: lastForKey?.at ?? null,
    spent24hUsdcAtomic: spentRows.results.reduce((sum, r) => sum + BigInt(r.usdc_atomic), 0n).toString(),
  };
  const intent = {
    wallet, paymentKey: key, kind: req.kind, fingerprint: req.fingerprint, usdcAtomic: req.usdc_atomic,
    counterparty: req.counterparty, flags: req.flags as never,
  };
  const override: OverrideGrant | null = overrideRow
    ? { fingerprint: overrideRow.fingerprint, usdcAtomic: overrideRow.usdc_atomic, reasonCodes: overrideRow.reasons.split(",") as ReasonCode[] }
    : null;

  let decision = evaluate({ intent, history, chain: req.chain, limits: req.limits, now: ctx.now, override });
  if (decision.overrideApplied) {
    const used = await db.prepare("UPDATE overrides SET used_at = ? WHERE id = ? AND used_at IS NULL").bind(ctx.now, overrideRow!.id).run();
    if (used.meta.changes !== 1) decision = evaluate({ intent, history, chain: req.chain, limits: req.limits, now: ctx.now, override: null });
  }

  const decisionId = newId("dec");
  const expiresAt = ctx.now + DECISION_TTL;
  await db.batch([
    db.prepare("INSERT INTO attempts (wallet, key, at) VALUES (?, ?, ?)").bind(wallet, key, ctx.now),
    db.prepare("INSERT OR IGNORE INTO payment_keys (wallet, key, state, updated_at) VALUES (?, ?, 'new', ?)").bind(wallet, key, ctx.now),
    db.prepare(`INSERT INTO decisions (id, wallet, key, kind, verdict, fingerprint, usdc_atomic, details, created_at, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(decisionId, wallet, key, req.kind, decision.verdict, req.fingerprint, req.usdc_atomic, JSON.stringify(req.details), ctx.now, expiresAt),
  ]);

  let overrideChallenge = null;
  if (decision.verdict !== "allow" && decision.overridableCodes.length > 0) {
    const id = newId("och");
    const nonce = randomToken(16);
    const challengeExpires = ctx.now + OVERRIDE_TTL;
    const reasons = decision.overridableCodes.join(",");
    await db.prepare(`INSERT INTO override_challenges (id, wallet, decision_id, key, fingerprint, usdc_atomic, reasons, nonce, expires_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, wallet, decisionId, key, req.fingerprint, req.usdc_atomic, reasons, nonce, challengeExpires).run();
    overrideChallenge = {
      challenge_id: id,
      expires_at: challengeExpires,
      typed_data: overrideTypedData({
        wallet, decisionId, paymentKey: key, fingerprint: req.fingerprint, amountUsdcAtomic: req.usdc_atomic ?? "none",
        reasons, nonce, expiresAt: challengeExpires, statement: OVERRIDE_STATEMENT,
      }),
    };
  }

  let lockedUntil: number | null = null;
  if (decision.verdict === "allow" && req.kind === "raw_evm") {
    lockedUntil = await consumeDecision(ctx, wallet, decisionId, req.fingerprint, req.limits.inflightLockS);
  }

  const audit = await appendAudit(db, wallet, {
    type: "decision", at: ctx.now, decisionId, paymentKey: key, kind: req.kind, verdict: decision.verdict,
    reasons: decision.reasons.map((r) => r.code), summary: decision.summary, explanation: req.summary,
    fingerprint: req.fingerprint, usdcAtomic: req.usdc_atomic, overrideApplied: decision.overrideApplied,
  });

  return {
    decision_id: decisionId,
    verdict: decision.verdict,
    summary: decision.summary,
    reasons: decision.reasons,
    override_applied: decision.overrideApplied,
    decision_expires_at: decision.verdict === "allow" ? expiresAt : null,
    locked_until: lockedUntil,
    override_challenge: overrideChallenge,
    audit,
  };
}

/** Single-use: the decision is consumed and the key locked in one transaction, or neither. */
async function consumeDecision(ctx: Ctx, wallet: string, decisionId: string, fingerprint: string, lockS: number): Promise<number> {
  const marker = randomToken(16);
  const lockedUntil = ctx.now + lockS;
  const [consume, lock] = await ctx.db.batch([
    ctx.db.prepare(`UPDATE decisions SET consumed_at = ?, consume_token = ?
                    WHERE id = ? AND wallet = ? AND verdict = 'allow' AND consumed_at IS NULL AND expires_at > ? AND fingerprint = ?
                      AND EXISTS (SELECT 1 FROM payment_keys k WHERE k.wallet = decisions.wallet AND k.key = decisions.key
                                  AND (k.state IN ('new', 'retryable') OR (k.state = 'in_flight' AND k.locked_until <= ?)))`)
      .bind(ctx.now, marker, decisionId, wallet, ctx.now, fingerprint, ctx.now),
    ctx.db.prepare(`UPDATE payment_keys SET state = 'in_flight', locked_until = ?, last_status = NULL, request_id = NULL, observed = NULL,
                      last_decision_id = ?, updated_at = ?
                    WHERE wallet = ? AND key = (SELECT key FROM decisions WHERE id = ? AND consume_token = ?)`)
      .bind(lockedUntil, decisionId, ctx.now, wallet, decisionId, marker),
  ]);
  if (consume!.meta.changes !== 1 || lock!.meta.changes !== 1) {
    throw new HttpError(409, "decision is not usable: it was already used, expired, does not match this exact transaction, or another payment for this key is in flight");
  }
  return lockedUntil;
}

export async function getDecision(ctx: Ctx, body: unknown) {
  const wallet = requireWallet(ctx);
  const { decision_id } = parse(z.object({ decision_id: z.string().max(80) }).strict(), body);
  const row = await ctx.db.prepare("SELECT * FROM decisions WHERE id = ? AND wallet = ?").bind(decision_id, wallet)
    .first<{ key: string; kind: string; verdict: string; fingerprint: string; usdc_atomic: string | null; details: string; expires_at: number; consumed_at: number | null }>();
  if (!row) throw new HttpError(404, "unknown decision for this wallet");
  return {
    decision_id, payment_key: row.key, kind: row.kind, verdict: row.verdict, fingerprint: row.fingerprint,
    usdc_atomic: row.usdc_atomic, details: JSON.parse(row.details) as Record<string, unknown>,
    usable: row.verdict === "allow" && row.consumed_at === null && row.expires_at > ctx.now,
  };
}

export async function consume(ctx: Ctx, body: unknown) {
  const wallet = requireWallet(ctx);
  const req = parse(z.object({ decision_id: z.string().max(80), fingerprint: hash32, inflight_lock_s: z.number().int().min(30).max(86_400) }).strict(), body);
  const lockedUntil = await consumeDecision(ctx, wallet, req.decision_id, req.fingerprint, req.inflight_lock_s);
  const audit = await appendAudit(ctx.db, wallet, { type: "proposal_issued", at: ctx.now, decisionId: req.decision_id, fingerprint: req.fingerprint, lockedUntil });
  return { locked_until: lockedUntil, audit };
}

export async function keyInfo(ctx: Ctx, body: unknown) {
  const wallet = requireWallet(ctx);
  const { payment_key } = parse(z.object({ payment_key: paymentKey }).strict(), body);
  const row = await keyRow(ctx, wallet, payment_key);
  if (!row) return { wallet, payment_key, state: "new", last_decision: null };
  const dec = row.last_decision_id
    ? await ctx.db.prepare("SELECT kind, fingerprint, usdc_atomic, details FROM decisions WHERE id = ?").bind(row.last_decision_id)
      .first<{ kind: string; fingerprint: string; usdc_atomic: string | null; details: string }>()
    : null;
  return {
    wallet, payment_key, state: row.state, last_status: row.last_status, locked_until: row.locked_until, request_id: row.request_id, observed: row.observed,
    last_decision: dec ? { decision_id: row.last_decision_id, kind: dec.kind, fingerprint: dec.fingerprint, usdc_atomic: dec.usdc_atomic, details: JSON.parse(dec.details) } : null,
  };
}

export async function reportStatus(ctx: Ctx, body: unknown) {
  const wallet = requireWallet(ctx);
  const req = parse(z.object({
    payment_key: paymentKey,
    request_id: z.string().min(1).max(200),
    status: z.string().min(1).max(64),
    tx_hash: hash32.optional(),
    observed: z.enum(["match", "mismatch", "signer_mismatch", "failed_tx", "unavailable"]).optional(),
    observed_detail: z.string().max(500).optional(),
    inflight_lock_s: z.number().int().min(30).max(86_400),
  }).strict(), body);
  const row = await keyRow(ctx, wallet, req.payment_key);
  if (!row || row.state === "new") throw new HttpError(409, "no proposal was issued for this payment key");
  if (row.request_id && row.request_id !== req.request_id && row.state === "in_flight") {
    throw new HttpError(409, `this payment key is tracking request_id ${row.request_id}; report that request's status`);
  }

  const known = (PAYBOX_STATUSES as readonly string[]).includes(req.status);
  let state = row.state;
  let lockedUntil = row.locked_until;
  let next: string;
  if (!known) {
    state = "in_flight";
    next = `Unrecognised status "${req.status}". Keep polling get_request; SpendGuard treats this as unresolved.`;
  } else if ((PENDING_STATUSES as readonly string[]).includes(req.status)) {
    state = "in_flight";
    lockedUntil = Math.max(row.locked_until ?? 0, ctx.now + req.inflight_lock_s);
    next = `Still ${req.status}. Keep polling get_request with request_id ${req.request_id}; do not resubmit. Report again when the status changes.`;
  } else if (req.status === "success") {
    if (req.observed === "failed_tx") {
      state = "retryable";
      next = "PayBox reported success but the transaction reverted on-chain. Nothing moved; check with the user before retrying.";
    } else {
      state = "settled";
      next = req.observed === "match"
        ? "Settled. The observed on-chain token movement matches SpendGuard's decoding."
        : req.observed
          ? `Settled, but the on-chain observation is "${req.observed}". Review it with the user.`
          : "Settled per PayBox. No on-chain observation was made for this payment type.";
    }
  } else if (req.status === "denied") {
    state = "denied";
    next = "Denied by policy or the user. Do not retry; ask the user what they want.";
  } else {
    state = "retryable";
    next = "PayBox reported an error. A new attempt will be paused until the user confirms nothing was paid.";
  }

  await ctx.db.prepare(`UPDATE payment_keys SET state = ?, last_status = ?, locked_until = ?, request_id = ?, observed = ?, updated_at = ?
                        WHERE wallet = ? AND key = ?`)
    .bind(state, req.status, lockedUntil, req.request_id, req.observed ?? row.observed, ctx.now, wallet, req.payment_key).run();
  const audit = await appendAudit(ctx.db, wallet, {
    type: "status_reported", at: ctx.now, paymentKey: req.payment_key, requestId: req.request_id, status: req.status,
    txHash: req.tx_hash ?? null, observedOnChain: req.observed ?? null, observedDetail: req.observed_detail ?? null, state,
  });
  return { payment_key: req.payment_key, state, next_step: next, audit };
}

export async function confirmOverride(ctx: Ctx, body: unknown) {
  const wallet = requireWallet(ctx);
  const { challenge_id, signature } = parse(z.object({ challenge_id: z.string().max(80), signature: z.string().max(4096) }).strict(), body);
  const ch = await ctx.db.prepare("SELECT * FROM override_challenges WHERE id = ? AND wallet = ?").bind(challenge_id, wallet)
    .first<{ decision_id: string; key: string; fingerprint: string; usdc_atomic: string | null; reasons: string; nonce: string; expires_at: number; used_at: number | null }>();
  if (!ch || ch.used_at !== null || ch.expires_at <= ctx.now) throw new HttpError(400, "override challenge is unknown for this wallet, used, or expired");
  const typed = overrideTypedData({
    wallet, decisionId: ch.decision_id, paymentKey: ch.key, fingerprint: ch.fingerprint, amountUsdcAtomic: ch.usdc_atomic ?? "none",
    reasons: ch.reasons, nonce: ch.nonce, expiresAt: ch.expires_at, statement: OVERRIDE_STATEMENT,
  });
  if (!(await verifyTyped(ctx.rpcUrl, wallet, signature, typed))) throw new HttpError(403, "signature does not match this wallet and challenge");

  const overrideId = newId("ovr");
  const [claimed] = await ctx.db.batch([
    ctx.db.prepare("UPDATE override_challenges SET used_at = ? WHERE id = ? AND used_at IS NULL").bind(ctx.now, challenge_id),
    ctx.db.prepare(`INSERT INTO overrides (id, wallet, key, fingerprint, usdc_atomic, reasons, expires_at, challenge_id)
                    SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1`)
      .bind(overrideId, wallet, ch.key, ch.fingerprint, ch.usdc_atomic, ch.reasons, ctx.now + OVERRIDE_TTL, challenge_id),
  ]);
  if (claimed!.meta.changes !== 1) throw new HttpError(409, "override challenge was already used");
  const audit = await appendAudit(ctx.db, wallet, {
    type: "override_confirmed", at: ctx.now, challengeId: challenge_id, paymentKey: ch.key, fingerprint: ch.fingerprint, reasons: ch.reasons.split(","),
  });
  return {
    override_id: overrideId, payment_key: ch.key, clears: ch.reasons.split(","), expires_at: ctx.now + OVERRIDE_TTL, audit,
    next_step: "Call check_payment again with the identical payment. Hard limits and duplicates are still enforced.",
  };
}

export async function audit(ctx: Ctx, body: unknown) {
  const wallet = requireWallet(ctx);
  const { action, limit } = parse(z.object({ action: z.enum(["list", "verify"]), limit: z.number().int().min(1).max(50).default(20) }).strict(), body);
  return action === "verify" ? { wallet, ...(await verifyAudit(ctx.db, wallet)) } : { wallet, entries: await listAudit(ctx.db, wallet, limit) };
}
