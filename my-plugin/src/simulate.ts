import type { ChainState, History } from "./guard/types.js";

export const SCENARIOS = [
  "none",
  "delayed_settlement",
  "ambiguous_error",
  "retry_storm",
  "inflight_nonce",
  "duplicate_success",
  "lock_expired",
] as const;
export type Scenario = (typeof SCENARIOS)[number];

export interface Simulated {
  history: History;
  chain: ChainState;
  description: string;
}

/** Synthetic history for dry runs only. Live checks never use these. */
export function simulated(scenario: Scenario, now: number): Simulated {
  const fresh: History = {
    key: { state: "new", lastStatus: null, lockedUntil: null, requestId: null, observed: null },
    attemptsInWindow: 0,
    lastAttemptAt: null,
    spent24hUsdcAtomic: "0",
  };
  const chain: ChainState = { ok: true, latestNonce: 7, pendingNonce: 7 };
  switch (scenario) {
    case "none":
      return { history: fresh, chain, description: "No prior activity." };
    case "delayed_settlement":
      return {
        history: { ...fresh, attemptsInWindow: 1, lastAttemptAt: now - 45,
          key: { state: "in_flight", lastStatus: "pending_confirmation", lockedUntil: now + 240, requestId: "req_simulated_1", observed: null } },
        chain: { ok: true, latestNonce: 7, pendingNonce: 8 },
        description: "The previous payment for this key was broadcast and is still pending_confirmation.",
      };
    case "ambiguous_error":
      return {
        history: { ...fresh, attemptsInWindow: 1, lastAttemptAt: now - 90,
          key: { state: "retryable", lastStatus: "error", lockedUntil: null, requestId: "req_simulated_2", observed: null } },
        chain,
        description: "PayBox returned error for the previous attempt; it is unclear whether anything moved.",
      };
    case "retry_storm":
      return {
        history: { ...fresh, attemptsInWindow: 12, lastAttemptAt: now - 3,
          key: { state: "retryable", lastStatus: "error", lockedUntil: null, requestId: "req_simulated_3", observed: null } },
        chain,
        description: "The agent has attempted 12 payments in the last 10 minutes, the last one 3 seconds ago.",
      };
    case "inflight_nonce":
      return { history: fresh, chain: { ok: true, latestNonce: 7, pendingNonce: 9 }, description: "The wallet has two transactions broadcast but unconfirmed on Base." };
    case "duplicate_success":
      return {
        history: { ...fresh, attemptsInWindow: 1, lastAttemptAt: now - 600,
          key: { state: "settled", lastStatus: "success", lockedUntil: null, requestId: "req_simulated_4", observed: "match" } },
        chain,
        description: "This payment key already settled successfully.",
      };
    case "lock_expired":
      return {
        history: { ...fresh, attemptsInWindow: 1, lastAttemptAt: now - 900,
          key: { state: "in_flight", lastStatus: null, lockedUntil: now - 600, requestId: null, observed: null } },
        chain,
        description: "A proposal was issued 15 minutes ago and no PayBox status was ever reported.",
      };
  }
}
