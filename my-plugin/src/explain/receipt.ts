import type { Observation } from "../guard/types.js";
import type { BaseRpc } from "../net/rpc.js";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface ExpectedMovement {
  kind: "erc20" | "native";
  token: string | null;
  from: string;
  to: string;
  amountAtomic: string;
}

export interface ObservedResult {
  observedOnChain: Observation;
  detail: string;
}

/**
 * Checks what a confirmed transaction actually moved. A match proves the token movement
 * happened; it says nothing about whether the recipient is trustworthy.
 */
export async function observe(rpc: BaseRpc, txHash: string, expected: ExpectedMovement): Promise<ObservedResult> {
  const receipt = await rpc.receipt(txHash);
  if (!receipt.ok) return { observedOnChain: "unavailable", detail: `Receipt could not be read (${receipt.reason}).` };
  if (!receipt.value) return { observedOnChain: "unavailable", detail: "No receipt yet; the transaction is not confirmed." };
  if (receipt.value.status !== "0x1") return { observedOnChain: "failed_tx", detail: "The transaction reverted on-chain; nothing moved." };
  const from = expected.from.toLowerCase();
  if (receipt.value.from.toLowerCase() !== from) {
    return { observedOnChain: "signer_mismatch", detail: `Signed by ${receipt.value.from}, not the wallet SpendGuard checked (${expected.from}).` };
  }

  if (expected.kind === "native") {
    const tx = await rpc.transaction(txHash);
    if (!tx.ok || !tx.value) return { observedOnChain: "unavailable", detail: "Transaction details could not be read." };
    const ok = (tx.value.to ?? "").toLowerCase() === expected.to.toLowerCase() && BigInt(tx.value.value) === BigInt(expected.amountAtomic);
    return ok
      ? { observedOnChain: "match", detail: `Observed on-chain: ${expected.amountAtomic} wei moved to ${expected.to}.` }
      : { observedOnChain: "mismatch", detail: "The native value or recipient on-chain differs from what SpendGuard decoded." };
  }

  const transfers = receipt.value.logs
    .filter((log) => log.address.toLowerCase() === expected.token?.toLowerCase() && log.topics[0] === TRANSFER_TOPIC && log.topics.length === 3)
    .map((log) => ({ from: topicAddress(log.topics[1]!), to: topicAddress(log.topics[2]!), amount: BigInt(log.data) }));
  const fromWallet = transfers.filter((t) => t.from === from);
  const exact = fromWallet.filter((t) => t.to === expected.to.toLowerCase() && t.amount === BigInt(expected.amountAtomic));
  if (exact.length === 1 && fromWallet.length === 1) {
    return { observedOnChain: "match", detail: `Observed on-chain: exactly one Transfer of ${expected.amountAtomic} atomic units from ${expected.from} to ${expected.to}.` };
  }
  return {
    observedOnChain: "mismatch",
    detail: `Expected one Transfer of ${expected.amountAtomic} to ${expected.to}; observed ${fromWallet.length} transfer(s) from the wallet: ${fromWallet.map((t) => `${t.amount} to ${t.to}`).join(", ") || "none"}.`,
  };
}

function topicAddress(topic: string): string {
  return `0x${topic.slice(-40)}`.toLowerCase();
}
