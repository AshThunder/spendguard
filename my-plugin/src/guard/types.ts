export const PAYBOX_STATUSES = [
  "pending_approval",
  "pending_signature",
  "pending_settlement",
  "pending_confirmation",
  "success",
  "denied",
  "error",
] as const;
export type PayBoxStatus = (typeof PAYBOX_STATUSES)[number];

export const PENDING_STATUSES: readonly PayBoxStatus[] = [
  "pending_approval",
  "pending_signature",
  "pending_settlement",
  "pending_confirmation",
];

export type Verdict = "allow" | "pause" | "block";

export type ReasonCode =
  | "over_per_tx_limit"
  | "over_daily_cap"
  | "unlimited_allowance"
  | "invalid_target"
  | "already_settled"
  | "in_flight"
  | "user_denied"
  | "ambiguous_status"
  | "lock_expired_unreported"
  | "chain_read_failed"
  | "onchain_pending_tx"
  | "unknown_call"
  | "unknown_token"
  | "suspicious_call"
  | "unpriced_asset"
  | "observed_mismatch"
  | "signer_mismatch"
  | "retry_too_fast"
  | "retry_storm";

export interface Reason {
  code: ReasonCode;
  overridable: boolean;
  message: string;
}

export type PaymentKind = "usdc_transfer" | "x402" | "raw_evm";

export type FlagCode =
  | "unlimited_allowance"
  | "large_allowance"
  | "allowance_to_address_without_code"
  | "recipient_is_token_contract"
  | "recipient_is_zero_address"
  | "native_value_with_token_call"
  | "unknown_call"
  | "unknown_token"
  | "over_limit";

export interface Flag {
  code: FlagCode;
  message: string;
}

/** What the agent wants to do, as decoded by SpendGuard from the exact bytes or request. */
export interface PaymentIntent {
  wallet: string;
  paymentKey: string;
  kind: PaymentKind;
  fingerprint: string;
  /** USDC atomic units counted against limits; null when the asset is not USDC. */
  usdcAtomic: string | null;
  counterparty: string | null;
  flags: Flag[];
}

export type KeyStateName = "new" | "in_flight" | "settled" | "retryable" | "denied";
export type Observation = "match" | "mismatch" | "signer_mismatch" | "failed_tx" | "unavailable";

export interface KeyState {
  state: KeyStateName;
  lastStatus: string | null;
  lockedUntil: number | null;
  requestId: string | null;
  observed: Observation | null;
}

export interface History {
  key: KeyState;
  attemptsInWindow: number;
  lastAttemptAt: number | null;
  spent24hUsdcAtomic: string;
}

export interface ChainState {
  ok: boolean;
  latestNonce?: number;
  pendingNonce?: number;
  reason?: string;
}

export interface Limits {
  maxPerTxUsdcAtomic: string;
  dailyCapUsdcAtomic: string;
  minRetryIntervalS: number;
  maxAttemptsPerWindow: number;
  retryWindowS: number;
  inflightLockS: number;
}

export interface OverrideGrant {
  fingerprint: string;
  usdcAtomic: string | null;
  reasonCodes: ReasonCode[];
}

export interface EvaluateInput {
  intent: PaymentIntent;
  history: History;
  chain: ChainState;
  limits: Limits;
  /** Unix seconds. */
  now: number;
  override?: OverrideGrant | null;
}

export interface Decision {
  verdict: Verdict;
  reasons: Reason[];
  summary: string;
  overrideApplied: boolean;
  /** Reason codes a wallet-signed override may clear; empty when nothing is overridable. */
  overridableCodes: ReasonCode[];
}
