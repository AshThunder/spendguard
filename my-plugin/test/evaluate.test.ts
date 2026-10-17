import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluate, usdc } from "../src/guard/evaluate.js";
import type { EvaluateInput, History, Limits, PaymentIntent } from "../src/guard/types.js";
import { simulated, SCENARIOS } from "../src/simulate.js";

const NOW = 1_800_000_000;
const limits: Limits = {
  maxPerTxUsdcAtomic: "25000000", dailyCapUsdcAtomic: "100000000",
  minRetryIntervalS: 30, maxAttemptsPerWindow: 8, retryWindowS: 600, inflightLockS: 300,
};
const intent: PaymentIntent = {
  wallet: "0x1111111111111111111111111111111111111111", paymentKey: "k1", kind: "usdc_transfer",
  fingerprint: "0x" + "ab".repeat(32), usdcAtomic: "5000000", counterparty: "0x2222222222222222222222222222222222222222", flags: [],
};
const fresh: History = {
  key: { state: "new", lastStatus: null, lockedUntil: null, requestId: null, observed: null },
  attemptsInWindow: 0, lastAttemptAt: null, spent24hUsdcAtomic: "0",
};
const okChain = { ok: true, latestNonce: 3, pendingNonce: 3 };

function run(over: Partial<EvaluateInput> = {}) {
  return evaluate({ intent, history: fresh, chain: okChain, limits, now: NOW, ...over });
}
const codes = (d: ReturnType<typeof run>) => d.reasons.map((r) => r.code);

test("allows a clean first payment", () => {
  const d = run();
  assert.equal(d.verdict, "allow");
  assert.deepEqual(d.reasons, []);
});

test("blocks over the per-transaction limit and cannot be overridden", () => {
  const d = run({ intent: { ...intent, usdcAtomic: "30000000" } });
  assert.equal(d.verdict, "block");
  assert.ok(codes(d).includes("over_per_tx_limit"));
  assert.deepEqual(d.overridableCodes, []);
  const o = run({ intent: { ...intent, usdcAtomic: "30000000" }, override: { fingerprint: intent.fingerprint, usdcAtomic: "30000000", reasonCodes: ["over_per_tx_limit"] } });
  assert.equal(o.verdict, "block");
});

test("blocks when the daily cap would be exceeded", () => {
  const d = run({ history: { ...fresh, spent24hUsdcAtomic: "98000000" } });
  assert.equal(d.verdict, "block");
  assert.ok(codes(d).includes("over_daily_cap"));
});

test("blocks a duplicate of a settled payment", () => {
  const d = run({ history: { ...fresh, key: { ...fresh.key, state: "settled", lastStatus: "success" } } });
  assert.equal(d.verdict, "block");
  assert.deepEqual(codes(d), ["already_settled"]);
});

for (const status of ["pending_approval", "pending_signature", "pending_settlement", "pending_confirmation"]) {
  test(`blocks while the previous request is ${status} and points at polling`, () => {
    const d = run({ history: { ...fresh, key: { state: "in_flight", lastStatus: status, lockedUntil: NOW + 100, requestId: "req_9", observed: null } } });
    assert.equal(d.verdict, "block");
    assert.ok(codes(d).includes("in_flight"));
    assert.match(d.summary, /get_request with request_id req_9; do not resubmit/);
    assert.deepEqual(d.overridableCodes, []);
  });
}

test("pauses (never allows) when an in-flight lock expired without a status", () => {
  const d = run({ history: { ...fresh, key: { state: "in_flight", lastStatus: null, lockedUntil: NOW - 1, requestId: null, observed: null } } });
  assert.equal(d.verdict, "pause");
  assert.deepEqual(d.overridableCodes, ["lock_expired_unreported"]);
});

test("pauses after a PayBox error until a human confirms", () => {
  const d = run({ history: { ...fresh, key: { ...fresh.key, state: "retryable", lastStatus: "error" } } });
  assert.equal(d.verdict, "pause");
  assert.ok(codes(d).includes("ambiguous_status"));
});

test("an approval to a plain address pauses as suspicious_call, not as a status problem", () => {
  const d = run({ intent: { ...intent, flags: [{ code: "allowance_to_address_without_code", message: "plain address" }] } });
  assert.equal(d.verdict, "pause");
  assert.deepEqual(d.overridableCodes, ["suspicious_call"]);
});

test("blocks a denied payment", () => {
  const d = run({ history: { ...fresh, key: { ...fresh.key, state: "denied", lastStatus: "denied" } } });
  assert.equal(d.verdict, "block");
  assert.ok(codes(d).includes("user_denied"));
});

test("pauses when the wallet has an unconfirmed transaction on-chain", () => {
  const d = run({ chain: { ok: true, latestNonce: 3, pendingNonce: 4 } });
  assert.equal(d.verdict, "pause");
  assert.ok(codes(d).includes("onchain_pending_tx"));
});

test("pauses when the chain cannot be read (fail closed)", () => {
  const d = run({ chain: { ok: false, reason: "request timed out" } });
  assert.equal(d.verdict, "pause");
  assert.ok(codes(d).includes("chain_read_failed"));
});

test("x402 payments do not depend on wallet nonces", () => {
  const d = run({ intent: { ...intent, kind: "x402" }, chain: { ok: false, reason: "n/a" } });
  assert.equal(d.verdict, "allow");
});

test("pauses a too-fast retry and blocks a retry storm", () => {
  assert.equal(run({ history: { ...fresh, lastAttemptAt: NOW - 5 } }).verdict, "pause");
  const storm = run({ history: { ...fresh, attemptsInWindow: 8 } });
  assert.equal(storm.verdict, "block");
  assert.ok(storm.overridableCodes.includes("retry_storm"));
});

test("blocks unlimited approvals outright", () => {
  const d = run({ intent: { ...intent, kind: "raw_evm", flags: [{ code: "unlimited_allowance", message: "UNLIMITED." }] } });
  assert.equal(d.verdict, "block");
  assert.ok(codes(d).includes("unlimited_allowance"));
  assert.deepEqual(d.overridableCodes, []);
});

test("pauses unknown calls and non-USDC assets", () => {
  assert.ok(codes(run({ intent: { ...intent, kind: "raw_evm", usdcAtomic: null, flags: [{ code: "unknown_call", message: "?" }] } })).includes("unknown_call"));
  assert.ok(codes(run({ intent: { ...intent, kind: "raw_evm", usdcAtomic: null } })).includes("unpriced_asset"));
});

test("an override clears only the reasons it was signed for, for the exact payment", () => {
  const history: History = { ...fresh, key: { ...fresh.key, state: "retryable", lastStatus: "error" }, lastAttemptAt: NOW - 5 };
  const good = { fingerprint: intent.fingerprint, usdcAtomic: intent.usdcAtomic, reasonCodes: ["ambiguous_status" as const] };
  const ok = run({ history, override: good });
  assert.equal(ok.verdict, "allow");
  assert.equal(ok.overrideApplied, true);

  assert.equal(run({ history, override: { ...good, fingerprint: "0x" + "cd".repeat(32) } }).verdict, "pause", "different transaction");
  assert.equal(run({ history, override: { ...good, usdcAtomic: "6000000" } }).verdict, "pause", "different amount");
  assert.equal(run({ history: { ...history, attemptsInWindow: 9 }, override: good }).verdict, "block", "storm not covered by signature");
  assert.equal(run({ history: { ...history, key: { ...history.key, state: "settled" } }, override: good }).verdict, "block", "never overrides a duplicate");
});

test("every simulation scenario produces a decision with a reason", () => {
  for (const scenario of SCENARIOS) {
    const sim = simulated(scenario, NOW);
    const d = run({ history: sim.history, chain: sim.chain });
    if (scenario === "none") assert.equal(d.verdict, "allow");
    else assert.notEqual(d.verdict, "allow", scenario);
  }
});

test("formats USDC amounts", () => {
  assert.equal(usdc("5000000"), "5.00");
  assert.equal(usdc("1250000"), "1.25");
  assert.equal(usdc("1000"), "0.001");
  assert.equal(usdc("1234567"), "1.234567");
});
