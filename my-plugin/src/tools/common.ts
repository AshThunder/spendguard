import * as z from "zod/v4";

import { loadConfig, type Config } from "../config.js";
import { Budget } from "../net/budget.js";
import { BaseRpc } from "../net/rpc.js";
import { Store } from "../store.js";

export const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "an EVM address (0x + 40 hex)");
export const decimalUsdc = z.string().regex(/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/, "a USDC amount like \"5\" or \"1.25\"");
export const sessionToken = z.string().min(10).max(200).describe("Token from the session tool. Keep it inside this conversation; never show it to the user.");
export const paymentKey = z.string().regex(/^[A-Za-z0-9:_.-]{1,120}$/)
  .describe("Your idempotency key for this logical payment (e.g. invoice-123). Reuse it for every retry of the same payment; use a new key only for a genuinely new payment.");

const flagSchema = z.object({ code: z.string(), message: z.string() }).strict();
export const explanationSchema = z.object({
  source: z.literal("spendguard-plugin"),
  decodedBySpendGuard: z.literal(true),
  verifiedByPayBox: z.literal(false),
  disclaimer: z.string(),
  action: z.string(),
  summary: z.string(),
  chain: z.string(),
  contract: z.string().nullable(),
  token: z.object({
    address: z.string(),
    symbol: z.string().nullable(),
    decimals: z.number().int().nullable(),
    metadataSource: z.enum(["registry", "onchain-read", "unknown"]),
  }).strict().nullable(),
  amount: z.object({ atomic: z.string(), display: z.string() }).strict().nullable(),
  counterparty: z.string().nullable(),
  owner: z.string().nullable(),
  nativeValueWei: z.string(),
  flags: z.array(flagSchema),
  fingerprint: z.object({ hash: z.string(), selector: z.string().nullable(), calldataTail: z.string().nullable() }).strict(),
}).strict();

export const evmTxSchema = z.object({
  chain: z.literal("eip155:8453").describe("Base mainnet; SpendGuard checks Base only."),
  to: address,
  value: z.string().regex(/^(0|[1-9][0-9]{0,77})$/).describe("Native value in wei."),
  data: z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/).max(245_762),
}).strict();

export interface CallContext {
  config: Config;
  budget: Budget;
  rpc: BaseRpc;
  store: (session: string | null) => Store | null;
}

export function context(): CallContext {
  const config = loadConfig();
  const budget = new Budget();
  return {
    config,
    budget,
    rpc: new BaseRpc(config.rpcUrl, budget),
    store: (session) => (config.backendUrl ? new Store(config.backendUrl, budget, session) : null),
  };
}

export function text(...lines: (string | null | undefined)[]) {
  return [{ type: "text" as const, text: lines.filter((l): l is string => !!l).join("\n\n") }];
}

/** A failed call that proposes nothing. Never carries a transaction proposal. */
export function failure(message: string) {
  return { isError: true, content: text(message) };
}

export const BACKEND_MISSING =
  "SpendGuard's backend is not configured (SPENDGUARD_BACKEND_URL). Nothing was checked or proposed. Use dry_run to evaluate without state.";

export function backendDown(reason: string) {
  return failure(`SpendGuard's backend did not answer (${reason}). Nothing was proposed. Do not retry the payment through another route; try this check again shortly.`);
}
