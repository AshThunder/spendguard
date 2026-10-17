import { createPublicClient, http, isAddressEqual, recoverTypedDataAddress, type Hex } from "viem";
import { base } from "viem/chains";

export const DOMAIN = { name: "SpendGuard", version: "1", chainId: 8453 } as const;

const EIP712Domain = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
] as const;

export const SESSION_TYPES = {
  SpendGuardSession: [
    { name: "wallet", type: "address" },
    { name: "nonce", type: "string" },
    { name: "issuedAt", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
    { name: "statement", type: "string" },
  ],
} as const;

export const OVERRIDE_TYPES = {
  SpendGuardOverride: [
    { name: "wallet", type: "address" },
    { name: "decisionId", type: "string" },
    { name: "paymentKey", type: "string" },
    { name: "fingerprint", type: "bytes32" },
    { name: "amountUsdcAtomic", type: "string" },
    { name: "reasons", type: "string" },
    { name: "nonce", type: "string" },
    { name: "expiresAt", type: "uint256" },
    { name: "statement", type: "string" },
  ],
} as const;

export const SESSION_STATEMENT =
  "Start a SpendGuard session for this wallet. It lets SpendGuard store your rules and audit log. It cannot move funds; every payment still needs PayBox approval.";
export const OVERRIDE_STATEMENT =
  "This authorizes one retry of this exact payment. It does not make the payment safe.";

export interface SessionMessage {
  wallet: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  statement: string;
}

export interface OverrideMessage {
  wallet: string;
  decisionId: string;
  paymentKey: string;
  fingerprint: string;
  amountUsdcAtomic: string;
  reasons: string;
  nonce: string;
  expiresAt: number;
  statement: string;
}

/** JSON typed data for PayBox `request_wallet_sign` with `op: "typedData"`. */
export function sessionTypedData(m: SessionMessage) {
  return {
    domain: DOMAIN,
    types: { EIP712Domain, ...SESSION_TYPES },
    primaryType: "SpendGuardSession" as const,
    message: { ...m, issuedAt: String(m.issuedAt), expiresAt: String(m.expiresAt) },
  };
}

export function overrideTypedData(m: OverrideMessage) {
  return {
    domain: DOMAIN,
    types: { EIP712Domain, ...OVERRIDE_TYPES },
    primaryType: "SpendGuardOverride" as const,
    message: { ...m, expiresAt: String(m.expiresAt) },
  };
}

/**
 * Verifies a signature over typed data rebuilt from stored values, never from agent input.
 * EOAs are checked offline; smart-contract wallets fall back to ERC-1271/6492 over Base RPC.
 */
export async function verifyTyped(
  rpcUrl: string,
  wallet: string,
  signature: string,
  typed: { types: Record<string, readonly { name: string; type: string }[]>; primaryType: string; message: Record<string, unknown> },
): Promise<boolean> {
  if (!/^0x[0-9a-fA-F]+$/.test(signature)) return false;
  const { EIP712Domain: _ignored, ...types } = typed.types;
  const args = {
    domain: DOMAIN,
    types,
    primaryType: typed.primaryType,
    message: typed.message,
    signature: signature as Hex,
  } as const;
  try {
    const recovered = await recoverTypedDataAddress(args as Parameters<typeof recoverTypedDataAddress>[0]);
    if (isAddressEqual(recovered, wallet as Hex)) return true;
  } catch {
    // not a plain 65-byte EOA signature; try contract verification
  }
  try {
    const client = createPublicClient({ chain: base, transport: http(rpcUrl, { timeout: 4_000 }) });
    return await client.verifyTypedData({ address: wallet as Hex, ...(args as object) } as Parameters<typeof client.verifyTypedData>[0]);
  } catch {
    return false;
  }
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0 && a.length === b.length;
}
