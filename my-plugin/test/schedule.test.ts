import assert from "node:assert/strict";
import { test } from "node:test";

import { currentSlot, nextSlot, paymentKeyFor, ruleAmount, type RuleSpec } from "../src/rules/schedule.js";

const R = "0x2222222222222222222222222222222222222222";
// Friday 2026-10-16 15:00:00 UTC
const FRI_15 = Date.UTC(2026, 9, 16, 15) / 1000;
const DAY = 86_400;

test("weekly rule: current slot is the most recent matching weekday and hour", () => {
  const spec: RuleSpec = { type: "weekly", recipient: R, amountUsdcAtomic: "5000000", dayOfWeek: 5, hourUtc: 9 };
  const createdMonday = FRI_15 - 4 * DAY;
  assert.equal(currentSlot(spec, createdMonday, FRI_15), Date.UTC(2026, 9, 16, 9) / 1000);
  assert.equal(currentSlot(spec, createdMonday, FRI_15 - 7 * 3600), null, "Friday 08:00, before the first slot");
  assert.equal(nextSlot(spec, createdMonday, FRI_15), Date.UTC(2026, 9, 23, 9) / 1000);
});

test("interval rule: first slot is due at creation, then every N days", () => {
  const spec: RuleSpec = { type: "interval_days", recipient: R, amountUsdcAtomic: "1000000", everyDays: 7 };
  assert.equal(currentSlot(spec, FRI_15, FRI_15), FRI_15);
  assert.equal(currentSlot(spec, FRI_15, FRI_15 + 6 * DAY), FRI_15);
  assert.equal(currentSlot(spec, FRI_15, FRI_15 + 7 * DAY), FRI_15 + 7 * DAY);
  assert.equal(paymentKeyFor("rule_a", FRI_15), `rule:rule_a:${FRI_15}`);
});

test("goal rule pays the remainder and completes at the target", () => {
  const spec: RuleSpec = { type: "goal", recipient: R, amountUsdcAtomic: "5000000", targetUsdcAtomic: "50000000", everyDays: 7 };
  assert.deepEqual(ruleAmount(spec, { wallet: null, recipient: 10_000_000n }).kind, "pay");
  const last = ruleAmount(spec, { wallet: null, recipient: 48_000_000n });
  assert.equal(last.kind === "pay" && last.amountUsdcAtomic, "2000000");
  assert.equal(ruleAmount(spec, { wallet: null, recipient: 50_000_000n }).kind, "completed");
  assert.equal(ruleAmount(spec, { wallet: null, recipient: null }).kind, "skip", "unknown balance is never guessed");
});

test("threshold sweep moves a percentage above the threshold only", () => {
  const spec: RuleSpec = { type: "threshold_sweep", recipient: R, thresholdUsdcAtomic: "100000000", percent: 10, everyDays: 1 };
  const r = ruleAmount(spec, { wallet: 150_000_000n, recipient: null });
  assert.equal(r.kind === "pay" && r.amountUsdcAtomic, "5000000");
  assert.equal(ruleAmount(spec, { wallet: 90_000_000n, recipient: null }).kind, "skip");
});
