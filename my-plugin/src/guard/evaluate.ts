import { PENDING_STATUSES } from "./types.js";
import type { Decision, EvaluateInput, PayBoxStatus, Reason, ReasonCode } from "./types.js";

const N = false;
const O = true;

function reason(code: ReasonCode, overridable: boolean, message: string): Reason {
  return { code, overridable, message };
}

/**
 * Pure Spend Guard decision. Non-overridable reasons always block; a wallet-signed
 * override can only clear the overridable reasons it was signed for, and only for the
 * identical fingerprint and amount.
 */
export function evaluate(input: EvaluateInput): Decision {
  const { intent, history, chain, limits, now } = input;
  const reasons: Reason[] = [];
  const amount = intent.usdcAtomic === null ? null : BigInt(intent.usdcAtomic);

  const unlimited = intent.flags.some((f) => f.code === "unlimited_allowance" || f.code === "large_allowance");
  if (!unlimited && amount !== null && amount > BigInt(limits.maxPerTxUsdcAtomic)) {
    reasons.push(reason("over_per_tx_limit", N, `Amount exceeds the per-transaction limit of ${usdc(limits.maxPerTxUsdcAtomic)} USDC.`));
  }
  if (!unlimited && amount !== null && amount + BigInt(history.spent24hUsdcAtomic) > BigInt(limits.dailyCapUsdcAtomic)) {
    reasons.push(reason("over_daily_cap", N,
      `This would bring the last 24h total to ${usdc((amount + BigInt(history.spent24hUsdcAtomic)).toString())} USDC, above the daily cap of ${usdc(limits.dailyCapUsdcAtomic)} USDC.`));
  }
  for (const flag of intent.flags) {
    if (flag.code === "unlimited_allowance" || flag.code === "large_allowance") {
      reasons.push(reason("unlimited_allowance", N, `${flag.message} SpendGuard never allows unlimited token approvals; approve an exact amount instead.`));
    } else if (flag.code === "recipient_is_zero_address" || flag.code === "recipient_is_token_contract") {
      reasons.push(reason("invalid_target", N, `${flag.message} Funds sent there are usually lost.`));
    } else if (flag.code === "unknown_call") {
      reasons.push(reason("unknown_call", O, "SpendGuard cannot explain what this transaction does."));
    } else if (flag.code === "unknown_token") {
      reasons.push(reason("unknown_token", O, flag.message));
    } else if (flag.code === "native_value_with_token_call" || flag.code === "allowance_to_address_without_code") {
      reasons.push(reason("suspicious_call", O, flag.message));
    }
  }
  if (intent.kind === "raw_evm" && amount === null && !intent.flags.some((f) => f.code === "unknown_call")) {
    reasons.push(reason("unpriced_asset", O, "The asset is not USDC, so spending limits cannot be applied automatically."));
  }

  const key = history.key;
  const requestHint = key.requestId ? ` request_id ${key.requestId}` : " the original request";
  switch (key.state) {
    case "settled":
      reasons.push(reason("already_settled", N, "This payment key already settled successfully. Use a new payment key only if you intend to pay again."));
      break;
    case "denied":
      reasons.push(reason("user_denied", N, "PayBox reported this payment as denied by policy or the user. Do not retry it; ask the user."));
      break;
    case "in_flight":
      if (key.lockedUntil !== null && key.lockedUntil > now) {
        reasons.push(reason("in_flight", N,
          `A payment for this key is still in flight${key.lastStatus ? ` (${key.lastStatus})` : ""}. Keep polling get_request with${requestHint}; do not resubmit.`));
      } else {
        reasons.push(reason("lock_expired_unreported", O,
          "A previous proposal for this key was issued but no final PayBox status was reported. Check get_request before paying again."));
      }
      break;
    case "retryable":
      if (key.lastStatus === "error") {
        reasons.push(reason("ambiguous_status", O, "PayBox reported an error for the previous attempt. Confirm nothing was paid before retrying."));
      } else if (key.lastStatus !== null && !isKnownStatus(key.lastStatus)) {
        reasons.push(reason("ambiguous_status", O, `The previous attempt reported an unrecognised status "${key.lastStatus}".`));
      }
      break;
    case "new":
      break;
  }
  if (key.observed === "mismatch" || key.observed === "signer_mismatch") {
    reasons.push(reason(key.observed === "mismatch" ? "observed_mismatch" : "signer_mismatch", O,
      "The previous on-chain result for this key did not match what SpendGuard decoded."));
  }

  if (intent.kind !== "x402") {
    if (!chain.ok) {
      reasons.push(reason("chain_read_failed", O, `SpendGuard could not read the wallet's on-chain state (${chain.reason ?? "unavailable"}).`));
    } else if ((chain.pendingNonce ?? 0) > (chain.latestNonce ?? 0)) {
      reasons.push(reason("onchain_pending_tx", O, "The wallet has a transaction broadcast but not yet confirmed on Base."));
    }
  }

  if (history.attemptsInWindow >= limits.maxAttemptsPerWindow) {
    reasons.push(reason("retry_storm", O,
      `${history.attemptsInWindow} payment attempts from this wallet in the last ${limits.retryWindowS}s. This looks like a retry loop.`));
  }
  const tooFast = history.lastAttemptAt !== null && now - history.lastAttemptAt < limits.minRetryIntervalS;

  const blocking = reasons.filter((r) => !r.overridable);
  const overridable = reasons.filter((r) => r.overridable);

  if (blocking.length === 0 && input.override && overrideMatches(input)) {
    const signed = new Set(input.override.reasonCodes);
    if (overridable.every((r) => signed.has(r.code))) {
      return {
        verdict: "allow",
        reasons: overridable,
        summary: "Allowed once by a wallet-signed override for this exact payment.",
        overrideApplied: true,
        overridableCodes: [],
      };
    }
  }

  if (tooFast) {
    overridable.push(reason("retry_too_fast", O, `Last attempt for this key was under ${limits.minRetryIntervalS}s ago.`));
    reasons.push(overridable[overridable.length - 1]!);
  }

  if (blocking.length > 0 || overridable.some((r) => r.code === "retry_storm")) {
    return {
      verdict: "block",
      reasons,
      summary: (blocking[0] ?? overridable.find((r) => r.code === "retry_storm")!).message,
      overrideApplied: false,
      overridableCodes: blocking.length === 0 ? overridable.map((r) => r.code) : [],
    };
  }
  if (overridable.length > 0) {
    return {
      verdict: "pause",
      reasons,
      summary: overridable[0]!.message,
      overrideApplied: false,
      overridableCodes: overridable.map((r) => r.code),
    };
  }
  return { verdict: "allow", reasons: [], summary: "No risk detected.", overrideApplied: false, overridableCodes: [] };
}

function overrideMatches(input: EvaluateInput): boolean {
  const o = input.override!;
  return o.fingerprint === input.intent.fingerprint && o.usdcAtomic === input.intent.usdcAtomic;
}

function isKnownStatus(status: string): status is PayBoxStatus {
  return ["success", "denied", "error", ...PENDING_STATUSES].includes(status as PayBoxStatus);
}

export function usdc(atomic: string): string {
  const v = BigInt(atomic);
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, "0").replace(/0{1,4}$/, "");
  return `${whole}.${frac.length < 2 ? frac.padEnd(2, "0") : frac}`;
}
