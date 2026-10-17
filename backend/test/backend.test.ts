import assert from "node:assert/strict";
import { test } from "node:test";

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { localD1 } from "../local/d1.js";
import { handle } from "../src/index.js";

const T0 = 1_800_000_000;
const limits = { maxPerTxUsdcAtomic: "25000000", dailyCapUsdcAtomic: "100000000", minRetryIntervalS: 30, maxAttemptsPerWindow: 8, retryWindowS: 600, inflightLockS: 300 };
const FP = "0x" + "ab".repeat(32);
const BOB = "0x2222222222222222222222222222222222222222";

function backend() {
  const env = { DB: localD1(), DEV_INSECURE: "1" };
  let now = T0;
  const call = async (path: string, body: unknown = {}, session?: string) => {
    const headers: Record<string, string> = { "content-type": "application/json", "x-spendguard-now": String(now) };
    if (session) headers["x-spendguard-session"] = session;
    const res = await handle(new Request(`http://local${path}`, { method: "POST", headers, body: JSON.stringify(body) }), env);
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { env, call, advance: (s: number) => { now += s; } };
}

async function login(call: ReturnType<typeof backend>["call"], account = privateKeyToAccount(generatePrivateKey())) {
  const ch = await call("/v1/session/challenge", { wallet: account.address });
  const typed = ch.body.typed_data;
  const { EIP712Domain: _d, ...types } = typed.types;
  const signature = await account.signTypedData({ domain: typed.domain, types, primaryType: typed.primaryType, message: typed.message });
  const done = await call("/v1/session/complete", { challenge_id: ch.body.challenge_id, signature });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  return { account, token: done.body.session_token as string, wallet: account.address.toLowerCase() };
}

const checkBody = (wallet: string, key: string, extra: Record<string, unknown> = {}) => ({
  wallet, payment_key: key, kind: "usdc_transfer", fingerprint: FP, usdc_atomic: "5000000", counterparty: BOB, flags: [],
  chain: { ok: true, latestNonce: 1, pendingNonce: 1 }, limits, details: { recipient: BOB }, summary: "Sends 5 USDC", ...extra,
});

test("rejects requests without a valid owner key outside dev mode", async () => {
  const res = await handle(new Request("http://x/v1/check", { method: "POST", body: "{}" }), { DB: localD1(), OWNER_KEY: "k" });
  assert.equal(res.status, 401);
  const ok = await handle(new Request("http://x/v1/rules/due", { method: "POST", body: "{}", headers: { authorization: "Bearer k" } }), { DB: localD1(), OWNER_KEY: "k" });
  assert.equal(ok.status, 401, "owner key alone is not a wallet session");
  assert.match(JSON.stringify(await ok.json()), /session/);
});

test("sessions require the wallet's own signature and are single-use challenges", async () => {
  const { call } = backend();
  const a = privateKeyToAccount(generatePrivateKey());
  const b = privateKeyToAccount(generatePrivateKey());
  const ch = await call("/v1/session/challenge", { wallet: a.address });
  const { EIP712Domain: _d, ...types } = ch.body.typed_data.types;
  const wrong = await b.signTypedData({ domain: ch.body.typed_data.domain, types, primaryType: ch.body.typed_data.primaryType, message: ch.body.typed_data.message });
  assert.equal((await call("/v1/session/complete", { challenge_id: ch.body.challenge_id, signature: wrong })).status, 403);
  const right = await a.signTypedData({ domain: ch.body.typed_data.domain, types, primaryType: ch.body.typed_data.primaryType, message: ch.body.typed_data.message });
  assert.equal((await call("/v1/session/complete", { challenge_id: ch.body.challenge_id, signature: right })).status, 200);
  assert.equal((await call("/v1/session/complete", { challenge_id: ch.body.challenge_id, signature: right })).status, 400, "replay");
});

test("one wallet's session cannot touch another wallet", async () => {
  const { call } = backend();
  const alice = await login(call);
  const bob = await login(call);
  assert.equal((await call("/v1/check", checkBody(bob.wallet, "k"), alice.token)).status, 403);
  await call("/v1/rules", { action: "create", spec: { type: "interval_days", recipient: BOB, amountUsdcAtomic: "1000000", everyDays: 7 } }, alice.token);
  assert.equal((await call("/v1/rules", { action: "list" }, bob.token)).body.rules.length, 0);
  assert.equal((await call("/v1/audit", { action: "list" }, bob.token)).body.entries.length, 1, "only bob's own session event");
});

test("full lifecycle: allow, single-use decision, in-flight block, settle, duplicate block", async () => {
  const { call } = backend();
  const s = await login(call);
  const c1 = await call("/v1/check", checkBody(s.wallet, "inv-1"), s.token);
  assert.equal(c1.body.verdict, "allow");
  const consume = { decision_id: c1.body.decision_id, fingerprint: FP, inflight_lock_s: 300 };
  assert.equal((await call("/v1/decision/consume", { ...consume, fingerprint: "0x" + "cd".repeat(32) }, s.token)).status, 409, "different bytes");
  assert.equal((await call("/v1/decision/consume", consume, s.token)).status, 200);
  assert.equal((await call("/v1/decision/consume", consume, s.token)).status, 409, "single use");

  const retry = await call("/v1/check", checkBody(s.wallet, "inv-1"), s.token);
  assert.equal(retry.body.verdict, "block");
  assert.equal(retry.body.reasons[0].code, "in_flight");

  await call("/v1/status", { payment_key: "inv-1", request_id: "req_1", status: "pending_confirmation", inflight_lock_s: 300 }, s.token);
  const settled = await call("/v1/status", { payment_key: "inv-1", request_id: "req_1", status: "success", observed: "match", inflight_lock_s: 300 }, s.token);
  assert.equal(settled.body.state, "settled");
  const dup = await call("/v1/check", checkBody(s.wallet, "inv-1"), s.token);
  assert.equal(dup.body.verdict, "block");
  assert.ok(dup.body.reasons.some((r: { code: string }) => r.code === "already_settled"));
  assert.equal(dup.body.override_challenge, null, "duplicates are never overridable");
});

test("concurrent consumes of two allow decisions for one key: only one wins", async () => {
  const { call } = backend();
  const s = await login(call);
  const a = await call("/v1/check", checkBody(s.wallet, "race"), s.token);
  const b = await call("/v1/check", checkBody(s.wallet, "race", { limits: { ...limits, minRetryIntervalS: 0 } }), s.token);
  assert.equal(a.body.verdict, "allow");
  assert.equal(b.body.verdict, "allow");
  const results = await Promise.all([a, b].map((d) => call("/v1/decision/consume", { decision_id: d.body.decision_id, fingerprint: FP, inflight_lock_s: 300 }, s.token)));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
});

test("error pauses, a wallet-signed override allows exactly one retry of the exact payment", async () => {
  const { call, advance } = backend();
  const s = await login(call);
  const c1 = await call("/v1/check", checkBody(s.wallet, "inv-2"), s.token);
  await call("/v1/decision/consume", { decision_id: c1.body.decision_id, fingerprint: FP, inflight_lock_s: 300 }, s.token);
  await call("/v1/status", { payment_key: "inv-2", request_id: "req_2", status: "error", inflight_lock_s: 300 }, s.token);
  advance(60);

  const paused = await call("/v1/check", checkBody(s.wallet, "inv-2"), s.token);
  assert.equal(paused.body.verdict, "pause");
  const ch = paused.body.override_challenge;
  assert.ok(ch);
  const { EIP712Domain: _d, ...types } = ch.typed_data.types;
  const sign = (acct = s.account) => acct.signTypedData({ domain: ch.typed_data.domain, types, primaryType: ch.typed_data.primaryType, message: ch.typed_data.message });

  const other = await login(call);
  assert.equal((await call("/v1/override/confirm", { challenge_id: ch.challenge_id, signature: await sign(other.account) }, other.token)).status, 400, "other wallet cannot use this challenge");
  assert.equal((await call("/v1/override/confirm", { challenge_id: ch.challenge_id, signature: await sign(other.account) }, s.token)).status, 403, "wrong signer");
  assert.equal((await call("/v1/override/confirm", { challenge_id: ch.challenge_id, signature: await sign() }, s.token)).status, 200);
  assert.equal((await call("/v1/override/confirm", { challenge_id: ch.challenge_id, signature: await sign() }, s.token)).status, 400, "challenge replay");

  const changed = await call("/v1/check", checkBody(s.wallet, "inv-2", { usdc_atomic: "9000000" }), s.token);
  assert.equal(changed.body.verdict, "pause", "override does not cover a different amount");
  const allowed = await call("/v1/check", checkBody(s.wallet, "inv-2"), s.token);
  assert.equal(allowed.body.verdict, "allow");
  assert.equal(allowed.body.override_applied, true);
  const again = await call("/v1/check", checkBody(s.wallet, "inv-2"), s.token);
  assert.equal(again.body.verdict, "pause", "override was single-use");
});

test("an expired in-flight lock pauses instead of allowing", async () => {
  const { call, advance } = backend();
  const s = await login(call);
  const c = await call("/v1/check", checkBody(s.wallet, "inv-3"), s.token);
  await call("/v1/decision/consume", { decision_id: c.body.decision_id, fingerprint: FP, inflight_lock_s: 300 }, s.token);
  advance(301);
  const later = await call("/v1/check", checkBody(s.wallet, "inv-3"), s.token);
  assert.equal(later.body.verdict, "pause");
  assert.equal(later.body.reasons[0].code, "lock_expired_unreported");
});

test("retry storm across new payment keys is blocked", async () => {
  const { call } = backend();
  const s = await login(call);
  let last;
  for (let i = 0; i < 9; i++) last = await call("/v1/check", checkBody(s.wallet, `storm-${i}`), s.token);
  assert.equal(last!.body.verdict, "block");
  assert.ok(last!.body.reasons.some((r: { code: string }) => r.code === "retry_storm"));
});

test("audit log is hash-chained and detects tampering", async () => {
  const { call, env } = backend();
  const s = await login(call);
  await call("/v1/check", checkBody(s.wallet, "a1"), s.token);
  await call("/v1/check", checkBody(s.wallet, "a2"), s.token);
  const v = await call("/v1/audit", { action: "verify" }, s.token);
  assert.equal(v.body.intact, true);
  assert.equal(v.body.entries, 3);
  await env.DB.prepare("UPDATE audit_log SET event = replace(event, 'allow', 'block') WHERE seq = 2").run();
  const broken = await call("/v1/audit", { action: "verify" }, s.token);
  assert.equal(broken.body.intact, false);
  assert.equal(broken.body.brokenAtSeq, 2);
});

test("rules: due slot, pause/resume/revoke, and one payment per slot", async () => {
  const { call } = backend();
  const s = await login(call);
  const created = await call("/v1/rules", { action: "create", spec: { type: "interval_days", recipient: BOB, amountUsdcAtomic: "5000000", everyDays: 7 } }, s.token);
  const id = created.body.rule.rule_id;
  const due = await call("/v1/rules/due", {}, s.token);
  assert.equal(due.body.due, true);
  assert.equal(due.body.payment_key, `rule:${id}:${T0}`);

  assert.equal((await call("/v1/rules", { action: "pause", rule_id: id }, s.token)).body.rule.status, "paused");
  assert.equal((await call("/v1/rules/due", {}, s.token)).body.due, false);
  assert.equal((await call("/v1/rules", { action: "resume", rule_id: id }, s.token)).body.rule.status, "active");

  const c = await call("/v1/check", checkBody(s.wallet, due.body.payment_key), s.token);
  await call("/v1/decision/consume", { decision_id: c.body.decision_id, fingerprint: FP, inflight_lock_s: 300 }, s.token);
  await call("/v1/status", { payment_key: due.body.payment_key, request_id: "req_r", status: "success", inflight_lock_s: 300 }, s.token);
  assert.equal((await call("/v1/rules/due", {}, s.token)).body.due, false, "slot already paid");

  assert.equal((await call("/v1/rules", { action: "revoke", rule_id: id }, s.token)).body.rule.status, "revoked");
  assert.equal((await call("/v1/rules", { action: "resume", rule_id: id }, s.token)).status, 409, "revoked is final");
});
