import { usdc } from "../guard/evaluate.js";

export type RuleSpec =
  | { type: "weekly"; recipient: string; amountUsdcAtomic: string; dayOfWeek: number; hourUtc: number }
  | { type: "interval_days"; recipient: string; amountUsdcAtomic: string; everyDays: number }
  | { type: "goal"; recipient: string; amountUsdcAtomic: string; targetUsdcAtomic: string; everyDays: number }
  | { type: "threshold_sweep"; recipient: string; thresholdUsdcAtomic: string; percent: number; everyDays: number };

const DAY = 86_400;
const WEEK = 7 * DAY;

/**
 * Start of the schedule slot that is current at `now` (unix seconds), or null before the
 * first slot. Missed earlier slots are never caught up; each slot can pay at most once
 * because its payment key is `rule:<id>:<slot>`.
 */
export function currentSlot(spec: RuleSpec, createdAt: number, now: number): number | null {
  if (spec.type === "weekly") {
    const dayStart = Math.floor(now / DAY) * DAY;
    const weekday = new Date(dayStart * 1000).getUTCDay();
    let slot = dayStart - ((weekday - spec.dayOfWeek + 7) % 7) * DAY + spec.hourUtc * 3600;
    if (slot > now) slot -= WEEK;
    return slot >= createdAt ? slot : null;
  }
  const period = spec.everyDays * DAY;
  if (now < createdAt) return null;
  return createdAt + Math.floor((now - createdAt) / period) * period;
}

export function nextSlot(spec: RuleSpec, createdAt: number, now: number): number {
  if (spec.type === "weekly") {
    const current = currentSlot(spec, 0, now) ?? now;
    const next = current + WEEK;
    return next < createdAt ? next + WEEK * Math.ceil((createdAt - next) / WEEK) : next;
  }
  const period = spec.everyDays * DAY;
  return (currentSlot(spec, createdAt, now) ?? createdAt) + period;
}

export function paymentKeyFor(ruleId: string, slot: number): string {
  return `rule:${ruleId}:${slot}`;
}

export type RuleAmount =
  | { kind: "pay"; amountUsdcAtomic: string; note: string }
  | { kind: "skip"; note: string }
  | { kind: "completed"; note: string };

/** Amount for this slot. Balances are USDC atomic units read from Base; null if unavailable. */
export function ruleAmount(spec: RuleSpec, balances: { wallet: bigint | null; recipient: bigint | null }): RuleAmount {
  switch (spec.type) {
    case "weekly":
    case "interval_days":
      return { kind: "pay", amountUsdcAtomic: spec.amountUsdcAtomic, note: "Fixed scheduled amount." };
    case "goal": {
      if (balances.recipient === null) return { kind: "skip", note: "Goal balance could not be read on-chain; skipping this run safely." };
      const remaining = BigInt(spec.targetUsdcAtomic) - balances.recipient;
      if (remaining <= 0n) return { kind: "completed", note: "Goal reached: the savings balance is at or above the target." };
      const amount = remaining < BigInt(spec.amountUsdcAtomic) ? remaining : BigInt(spec.amountUsdcAtomic);
      return { kind: "pay", amountUsdcAtomic: amount.toString(), note: `${usdc(remaining.toString())} USDC left to reach the goal.` };
    }
    case "threshold_sweep": {
      if (balances.wallet === null) return { kind: "skip", note: "Wallet balance could not be read on-chain; skipping this run safely." };
      const excess = balances.wallet - BigInt(spec.thresholdUsdcAtomic);
      if (excess <= 0n) return { kind: "skip", note: "Balance is not above the threshold." };
      const amount = (excess * BigInt(spec.percent)) / 100n;
      return amount > 0n
        ? { kind: "pay", amountUsdcAtomic: amount.toString(), note: `${spec.percent}% of the balance above the threshold.` }
        : { kind: "skip", note: "Sweep amount rounds to zero." };
    }
  }
}
