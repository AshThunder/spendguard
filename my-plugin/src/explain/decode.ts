import { decodeAbiParameters, decodeFunctionData, erc20Abi, formatUnits, hexToString, keccak256, parseAbi, toBytes } from "viem";

import type { Flag } from "../guard/types.js";
import type { BaseRpc } from "../net/rpc.js";
import { canonicalJson } from "../util/canonical.js";
import { BASE_CHAIN, BASE_USDC, registryToken, type TokenMeta } from "./tokens.js";

export const DISCLAIMER =
  "SpendGuard's own decoding of the exact transaction bytes. Not verified by PayBox. It does not establish that the recipient is trustworthy or that any service will be delivered.";
export const TEXT_PREFIX = "SpendGuard's own decoding (not verified by PayBox):";

const allowanceAbi = parseAbi([
  "function increaseAllowance(address spender, uint256 addedValue) returns (bool)",
  "function decreaseAllowance(address spender, uint256 subtractedValue) returns (bool)",
]);
const UNLIMITED = 2n ** 255n;
const LARGE = 2n ** 128n;
const ZERO = "0x0000000000000000000000000000000000000000";

export interface EvmTx {
  chain: string;
  to: string;
  value: string;
  data: string;
}

export interface X402Request {
  chain: "eip155:8453";
  url: string;
  method: "GET" | "POST";
  body?: unknown;
  maxAmount: string;
}

export type Action =
  | "native_transfer"
  | "erc20_transfer"
  | "erc20_approve"
  | "erc20_transfer_from"
  | "erc20_increase_allowance"
  | "erc20_decrease_allowance"
  | "unknown_call"
  | "x402_payment";

export interface Explanation {
  source: "spendguard-plugin";
  decodedBySpendGuard: true;
  verifiedByPayBox: false;
  disclaimer: string;
  action: Action;
  summary: string;
  chain: string;
  contract: string | null;
  token: TokenMeta | null;
  amount: { atomic: string; display: string } | null;
  counterparty: string | null;
  owner: string | null;
  nativeValueWei: string;
  flags: Flag[];
  fingerprint: { hash: string; selector: string | null; calldataTail: string | null };
}

export interface DecodeContext {
  /** Metadata for a token outside the registry, if it was read on-chain. */
  tokenMeta?: TokenMeta | null;
  /** Whether an approval spender has contract code; undefined when unknown. */
  spenderHasCode?: boolean;
}

export function evmFingerprint(tx: EvmTx): string {
  return keccak256(toBytes(`${tx.chain}|${tx.to.toLowerCase()}|${BigInt(tx.value).toString()}|${tx.data.toLowerCase()}`));
}

export function x402Fingerprint(req: X402Request): string {
  const bodyHash = req.body === undefined ? "none" : keccak256(toBytes(canonicalJson(req.body)));
  return keccak256(toBytes(`x402|${req.chain}|${new URL(req.url).toString()}|${req.method}|${bodyHash}|${req.maxAmount}`));
}

/** Pure decoding of the exact bytes. Never throws for unrecognised calldata. */
export function decodeEvm(tx: EvmTx, ctx: DecodeContext = {}): Explanation {
  const to = tx.to.toLowerCase();
  const value = BigInt(tx.value);
  const data = tx.data.toLowerCase();
  const selector = data.length >= 10 ? data.slice(0, 10) : null;
  const base = {
    source: "spendguard-plugin" as const,
    decodedBySpendGuard: true as const,
    verifiedByPayBox: false as const,
    disclaimer: DISCLAIMER,
    chain: tx.chain,
    nativeValueWei: value.toString(),
    fingerprint: { hash: evmFingerprint(tx), selector, calldataTail: data.length > 2 ? `0x${data.slice(-16)}` : null },
  };
  const net = chainName(tx.chain);

  if (data === "0x") {
    const flags: Flag[] = [];
    if (to === ZERO) flags.push({ code: "recipient_is_zero_address", message: "The recipient is the zero address." });
    return {
      ...base, action: "native_transfer", contract: null, token: null, owner: null,
      amount: { atomic: value.toString(), display: formatUnits(value, 18) },
      counterparty: to, flags,
      summary: `Sends ${formatUnits(value, 18)} ETH to ${short(to)} on ${net}.`,
    };
  }

  const token = registryToken(to) ?? ctx.tokenMeta ?? { address: to, symbol: null, decimals: null, metadataSource: "unknown" as const };
  const decoded = tryDecode(data);
  if (!decoded) {
    return {
      ...base, action: "unknown_call", contract: to, token: null, owner: null, amount: null, counterparty: null,
      flags: [{ code: "unknown_call", message: `Unrecognised function ${selector ?? "(no selector)"} on contract ${to}.` }],
      summary: `Calls an unrecognised function (${selector ?? "no selector"}) on contract ${short(to)} on ${net}. SpendGuard cannot explain what it does.`,
    };
  }

  const flags: Flag[] = [];
  if (token.metadataSource === "unknown") {
    flags.push({ code: "unknown_token", message: `Token ${to} is not in SpendGuard's registry and its metadata could not be read; amounts are shown in atomic units.` });
  }
  if (value > 0n) {
    flags.push({ code: "native_value_with_token_call", message: `The transaction also sends ${formatUnits(value, 18)} ETH alongside a token call.` });
  }
  const sym = token.symbol ?? "tokens";
  const fmt = (n: bigint) => (token.decimals === null ? `${n} atomic units of` : formatUnits(n, token.decimals));
  const amountOf = (n: bigint) => ({ atomic: n.toString(), display: n >= UNLIMITED ? "UNLIMITED" : token.decimals === null ? n.toString() : formatUnits(n, token.decimals) });

  switch (decoded.name) {
    case "transfer": {
      const [recipient, amount] = decoded.args;
      const r = recipient.toLowerCase();
      if (r === ZERO) flags.push({ code: "recipient_is_zero_address", message: "The recipient is the zero address." });
      if (r === to) flags.push({ code: "recipient_is_token_contract", message: "The recipient is the token contract itself." });
      return {
        ...base, action: "erc20_transfer", contract: to, token, owner: null, amount: amountOf(amount), counterparty: r, flags,
        summary: `Sends ${fmt(amount)} ${sym} to ${short(r)} on ${net}.`,
      };
    }
    case "transferFrom": {
      const [from, recipient, amount] = decoded.args;
      const r = recipient.toLowerCase();
      if (r === ZERO) flags.push({ code: "recipient_is_zero_address", message: "The recipient is the zero address." });
      return {
        ...base, action: "erc20_transfer_from", contract: to, token, owner: from.toLowerCase(), amount: amountOf(amount), counterparty: r, flags,
        summary: `Moves ${fmt(amount)} ${sym} from ${short(from)} to ${short(r)} on ${net}, using an existing allowance.`,
      };
    }
    case "approve":
    case "increaseAllowance": {
      const [spender, amount] = decoded.args;
      const s = spender.toLowerCase();
      if (amount >= UNLIMITED) {
        flags.push({ code: "unlimited_allowance", message: `This grants ${short(s)} UNLIMITED permission to spend this wallet's ${sym}.` });
      } else if (amount >= LARGE) {
        flags.push({ code: "large_allowance", message: `This grants ${short(s)} an extremely large ${sym} allowance.` });
      }
      if (ctx.spenderHasCode === false) {
        flags.push({ code: "allowance_to_address_without_code", message: `The spender ${short(s)} is not a contract; approvals to plain addresses are a common phishing pattern.` });
      }
      const shown = amount >= UNLIMITED ? "UNLIMITED" : fmt(amount);
      const verb = decoded.name === "approve" ? "Allows" : "Increases the allowance so";
      return {
        ...base, action: decoded.name === "approve" ? "erc20_approve" : "erc20_increase_allowance",
        contract: to, token, owner: null, amount: amountOf(amount), counterparty: s, flags,
        summary: `${verb} ${short(s)} to spend ${shown} ${sym} from this wallet on ${net}.`,
      };
    }
    case "decreaseAllowance": {
      const [spender, amount] = decoded.args;
      return {
        ...base, action: "erc20_decrease_allowance", contract: to, token, owner: null, amount: amountOf(amount),
        counterparty: spender.toLowerCase(), flags,
        summary: `Reduces ${short(spender)}'s ${sym} allowance by ${fmt(amount)} on ${net}.`,
      };
    }
  }
}

export function explainX402(req: X402Request): Explanation {
  const url = new URL(req.url);
  const display = formatUnits(BigInt(req.maxAmount), 6);
  return {
    source: "spendguard-plugin",
    decodedBySpendGuard: true,
    verifiedByPayBox: false,
    disclaimer: DISCLAIMER,
    action: "x402_payment",
    summary: `Pays at most ${display} USDC on ${chainName(req.chain)} to call ${req.method} ${url.origin}${url.pathname}.`,
    chain: req.chain,
    contract: BASE_USDC,
    token: registryToken(BASE_USDC),
    amount: { atomic: req.maxAmount, display },
    counterparty: url.host,
    owner: null,
    nativeValueWei: "0",
    flags: [],
    fingerprint: { hash: x402Fingerprint(req), selector: null, calldataTail: null },
  };
}

/** Decoding plus best-effort on-chain context; falls back to the pure result on any failure. */
export async function explainEvm(tx: EvmTx, rpc: BaseRpc | null): Promise<Explanation> {
  const ctx: DecodeContext = {};
  const decoded = tryDecode(tx.data.toLowerCase());
  if (rpc && decoded && tx.chain === BASE_CHAIN) {
    const tasks: Promise<void>[] = [];
    if (!registryToken(tx.to)) tasks.push(readTokenMeta(rpc, tx.to).then((meta) => { ctx.tokenMeta = meta; }));
    if (decoded.name === "approve" || decoded.name === "increaseAllowance") {
      tasks.push(rpc.hasCode(decoded.args[0]).then((r) => { if (r.ok) ctx.spenderHasCode = r.value; }));
    }
    await Promise.all(tasks);
  }
  return decodeEvm(tx, ctx);
}

async function readTokenMeta(rpc: BaseRpc, address: string): Promise<TokenMeta | null> {
  const [symbol, decimals] = await Promise.all([rpc.ethCall(address, "0x95d89b41"), rpc.ethCall(address, "0x313ce567")]);
  if (!decimals.ok || !symbol.ok || decimals.value === "0x") return null;
  const d = Number(BigInt(decimals.value));
  if (!Number.isInteger(d) || d > 36) return null;
  return { address: address.toLowerCase(), symbol: decodeSymbol(symbol.value), decimals: d, metadataSource: "onchain-read" };
}

function decodeSymbol(hex: string): string | null {
  try {
    const [s] = decodeAbiParameters([{ type: "string" }], hex as `0x${string}`);
    return clean(s);
  } catch {
    try {
      return clean(hexToString(hex as `0x${string}`, { size: 32 }));
    } catch {
      return null;
    }
  }
}

function clean(s: string): string | null {
  const v = s.replace(/[^\x20-\x7e]/g, "").trim().slice(0, 16);
  return v ? `${v} (unverified name)` : null;
}

type Decoded =
  | { name: "transfer"; args: readonly [`0x${string}`, bigint] }
  | { name: "transferFrom"; args: readonly [`0x${string}`, `0x${string}`, bigint] }
  | { name: "approve"; args: readonly [`0x${string}`, bigint] }
  | { name: "increaseAllowance"; args: readonly [`0x${string}`, bigint] }
  | { name: "decreaseAllowance"; args: readonly [`0x${string}`, bigint] };

function tryDecode(data: string): Decoded | null {
  if (data.length < 10) return null;
  for (const abi of [erc20Abi, allowanceAbi] as const) {
    try {
      const d = decodeFunctionData({ abi, data: data as `0x${string}` });
      if (["transfer", "transferFrom", "approve", "increaseAllowance", "decreaseAllowance"].includes(d.functionName)) {
        return { name: d.functionName, args: d.args } as Decoded;
      }
    } catch {
      // not this ABI
    }
  }
  return null;
}

export function short(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

function chainName(chain: string): string {
  return chain === BASE_CHAIN ? "Base" : chain;
}

export function renderExplanation(e: Explanation): string {
  const lines = [TEXT_PREFIX, e.summary];
  if (e.counterparty) lines.push(`${e.action.includes("allowance") || e.action === "erc20_approve" ? "Spender" : "Recipient"}: ${e.counterparty}`);
  if (e.token) lines.push(`Token: ${e.token.symbol ?? "unknown"} ${e.token.address} (metadata: ${e.token.metadataSource})`);
  if (e.amount) lines.push(e.amount.display === "UNLIMITED" ? `Amount: UNLIMITED (atomic ${e.amount.atomic})` : `Amount (atomic): ${e.amount.atomic}`);
  lines.push(e.flags.length ? `Risk flags: ${e.flags.map((f) => `${f.code} (${f.message})`).join("; ")}` : "Risk flags: none detected");
  const fp = e.fingerprint;
  lines.push(`Fingerprint: ${fp.hash}${fp.selector ? ` | selector ${fp.selector}` : ""}${fp.calldataTail ? ` | calldata ends ${fp.calldataTail}` : ""}`);
  lines.push(e.action === "x402_payment"
    ? "PayBox fetches the live 402 challenge and checks the asset and amount itself."
    : "Compare the destination, value and calldata with PayBox's transaction window before approving.");
  return lines.join("\n");
}
