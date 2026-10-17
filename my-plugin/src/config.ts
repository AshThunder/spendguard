import type { Limits } from "./guard/types.js";
import { atomicAmount } from "./paybox.js";

export interface Config {
  backendUrl: string | null;
  rpcUrl: string;
  limits: Limits;
  x402AllowedHosts: string[];
  simulate: string | null;
}

function int(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = value === undefined || value === "" ? fallback : Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

function usdc(value: string | undefined, fallback: string): string {
  try {
    return atomicAmount(value && value !== "" ? value : fallback, 6);
  } catch {
    return atomicAmount(fallback, 6);
  }
}

/** Non-sensitive settings from the portal's Environment variables. Secrets are never read here. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const backend = env.SPENDGUARD_BACKEND_URL?.trim();
  return {
    backendUrl: backend ? backend.replace(/\/+$/, "") : null,
    rpcUrl: env.BASE_RPC_URL?.trim() || "https://mainnet.base.org",
    limits: {
      maxPerTxUsdcAtomic: usdc(env.MAX_PER_TX_USDC, "25"),
      dailyCapUsdcAtomic: usdc(env.DAILY_CAP_USDC, "100"),
      minRetryIntervalS: int(env.MIN_RETRY_INTERVAL_S, 30, 0, 86_400),
      maxAttemptsPerWindow: int(env.MAX_ATTEMPTS_PER_WINDOW, 8, 1, 1000),
      retryWindowS: int(env.RETRY_WINDOW_S, 600, 1, 86_400),
      inflightLockS: int(env.INFLIGHT_LOCK_S, 300, 30, 86_400),
    },
    x402AllowedHosts: (env.X402_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),
    simulate: env.SIMULATE?.trim() || null,
  };
}
