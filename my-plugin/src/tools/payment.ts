import { encodeFunctionData, erc20Abi } from "viem";
import * as z from "zod/v4";

import { decodeEvm, explainEvm, explainX402, type EvmTx, type Explanation, type X402Request } from "../explain/decode.js";
import { BASE_CHAIN, BASE_USDC } from "../explain/tokens.js";
import type { PaymentKind } from "../guard/types.js";
import type { BaseRpc } from "../net/rpc.js";
import { atomicAmount } from "../paybox.js";
import { address, decimalUsdc, evmTxSchema } from "./common.js";

export const paymentSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("usdc_transfer"),
    recipient: address,
    amount_usdc: decimalUsdc,
  }).strict().describe("Send USDC on Base. SpendGuard builds the exact transfer itself."),
  z.object({
    kind: z.literal("x402"),
    url: z.string().url().max(2048).describe("HTTPS x402 endpoint on a host the plugin owner allowed."),
    method: z.enum(["GET", "POST"]).default("GET"),
    body: z.record(z.string(), z.json()).optional().describe("JSON body for POST only. Never include secrets."),
    max_amount_usdc: decimalUsdc.describe("Most you are willing to pay, in USDC."),
  }).strict().describe("Pay for an x402 HTTP request in USDC on Base."),
  z.object({
    kind: z.literal("raw_evm"),
    transaction: evmTxSchema,
  }).strict().describe("Check an EVM call built elsewhere (for example by another plugin) before submitting it."),
]);
export type PaymentInput = z.infer<typeof paymentSchema>;

export interface BuiltPayment {
  kind: PaymentKind;
  explanation: Explanation;
  usdcAtomic: string | null;
  details: Record<string, unknown>;
}

export function usdcTransferTx(recipient: string, amountAtomic: string): EvmTx {
  return {
    chain: BASE_CHAIN,
    to: BASE_USDC,
    value: "0",
    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [recipient as `0x${string}`, BigInt(amountAtomic)] }),
  };
}

export function x402Request(p: Extract<PaymentInput, { kind: "x402" }>): X402Request {
  return {
    chain: BASE_CHAIN,
    url: new URL(p.url).toString(),
    method: p.method,
    ...(p.method === "POST" && p.body !== undefined ? { body: p.body } : {}),
    maxAmount: atomicAmount(p.max_amount_usdc, 6),
  };
}

/** Builds the exact bytes or request and SpendGuard's explanation of them. */
export async function buildPayment(p: PaymentInput, rpc: BaseRpc | null, allowedHosts: string[]): Promise<BuiltPayment | { error: string }> {
  if (p.kind === "usdc_transfer") {
    const amountAtomic = atomicAmount(p.amount_usdc, 6);
    if (amountAtomic === "0") return { error: "Amount must be greater than zero." };
    const tx = usdcTransferTx(p.recipient, amountAtomic);
    return {
      kind: "usdc_transfer",
      explanation: decodeEvm(tx),
      usdcAtomic: amountAtomic,
      details: { recipient: p.recipient.toLowerCase(), amountAtomic, tx, movement: { kind: "erc20", token: BASE_USDC, to: p.recipient.toLowerCase(), amountAtomic } },
    };
  }
  if (p.kind === "x402") {
    const url = new URL(p.url);
    if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password || url.hash) {
      return { error: "x402 endpoints must be HTTPS on port 443 without credentials or fragments." };
    }
    if (p.method === "GET" && p.body !== undefined) return { error: "GET x402 requests cannot have a body." };
    if (!allowedHosts.includes(url.hostname.toLowerCase())) {
      return { error: `Host ${url.hostname} is not in X402_ALLOWED_HOSTS. The plugin owner must allow it (and add it as a network host) first.` };
    }
    const req = x402Request(p);
    if (req.maxAmount === "0") return { error: "max_amount_usdc must be greater than zero." };
    return { kind: "x402", explanation: explainX402(req), usdcAtomic: req.maxAmount, details: { request: req } };
  }
  const tx = p.transaction;
  const explanation = await explainEvm(tx, rpc);
  const isUsdc = explanation.token?.address === BASE_USDC;
  const usdcAtomic = isUsdc && explanation.amount ? explanation.amount.atomic : null;
  const movement =
    explanation.action === "erc20_transfer" && explanation.counterparty && explanation.amount
      ? { kind: "erc20", token: explanation.contract, to: explanation.counterparty, amountAtomic: explanation.amount.atomic }
      : explanation.action === "native_transfer" && explanation.counterparty
        ? { kind: "native", token: null, to: explanation.counterparty, amountAtomic: tx.value }
        : null;
  return { kind: "raw_evm", explanation, usdcAtomic, details: { tx, movement } };
}
