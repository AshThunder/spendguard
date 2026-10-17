import assert from "node:assert/strict";
import { test } from "node:test";

import { encodeFunctionData, erc20Abi, maxUint256, parseAbi } from "viem";

import { decodeEvm, evmFingerprint, explainX402, renderExplanation, TEXT_PREFIX, x402Fingerprint } from "../src/explain/decode.js";
import { observe } from "../src/explain/receipt.js";
import { BASE_USDC } from "../src/explain/tokens.js";
import type { BaseRpc } from "../src/net/rpc.js";
import { usdcTransferTx } from "../src/tools/payment.js";

const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";
const tx = (to: string, data: string, value = "0") => ({ chain: "eip155:8453", to, value, data });

test("explains a USDC transfer from its exact bytes", () => {
  const e = decodeEvm(usdcTransferTx(BOB, "5000000"));
  assert.equal(e.action, "erc20_transfer");
  assert.equal(e.summary, "Sends 5 USDC to 0x2222…2222 on Base.");
  assert.equal(e.counterparty, BOB);
  assert.equal(e.amount?.atomic, "5000000");
  assert.equal(e.token?.metadataSource, "registry");
  assert.equal(e.verifiedByPayBox, false);
  assert.deepEqual(e.flags, []);
  assert.ok(renderExplanation(e).startsWith(TEXT_PREFIX));
});

test("flags an unlimited approval", () => {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [BOB, maxUint256] });
  const e = decodeEvm(tx(BASE_USDC, data), { spenderHasCode: false });
  assert.equal(e.action, "erc20_approve");
  assert.match(e.summary, /UNLIMITED USDC/);
  assert.deepEqual(e.flags.map((f) => f.code), ["unlimited_allowance", "allowance_to_address_without_code"]);
});

test("flags transfers to the zero address and to the token contract", () => {
  const zero = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: ["0x0000000000000000000000000000000000000000", 1n] });
  assert.ok(decodeEvm(tx(BASE_USDC, zero)).flags.some((f) => f.code === "recipient_is_zero_address"));
  const self = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [BASE_USDC, 1n] });
  assert.ok(decodeEvm(tx(BASE_USDC, self)).flags.some((f) => f.code === "recipient_is_token_contract"));
});

test("explains native ETH, transferFrom and allowance changes", () => {
  assert.equal(decodeEvm(tx(BOB, "0x", "1000000000000000000")).summary, "Sends 1 ETH to 0x2222…2222 on Base.");
  const tf = encodeFunctionData({ abi: erc20Abi, functionName: "transferFrom", args: [ALICE, BOB, 2_000_000n] });
  assert.equal(decodeEvm(tx(BASE_USDC, tf)).action, "erc20_transfer_from");
  const dec = encodeFunctionData({ abi: parseAbi(["function decreaseAllowance(address,uint256)"]), functionName: "decreaseAllowance", args: [BOB, 1n] });
  assert.equal(decodeEvm(tx(BASE_USDC, dec)).action, "erc20_decrease_allowance");
});

test("refuses to guess unknown calls and unknown tokens", () => {
  const e = decodeEvm(tx(BOB, "0xdeadbeef00"));
  assert.equal(e.action, "unknown_call");
  assert.match(e.summary, /cannot explain/);
  const unknownToken = "0x3333333333333333333333333333333333333333";
  const t = decodeEvm(tx(unknownToken, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [BOB, 7n] })));
  assert.ok(t.flags.some((f) => f.code === "unknown_token"));
  assert.match(t.summary, /7 atomic units of tokens/);
});

test("flags native value sent with a token call", () => {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [BOB, 1n] });
  assert.ok(decodeEvm(tx(BASE_USDC, data, "5")).flags.some((f) => f.code === "native_value_with_token_call"));
});

test("fingerprints change with any byte and are case-insensitive", () => {
  const a = usdcTransferTx(BOB, "5000000");
  assert.equal(evmFingerprint(a), evmFingerprint({ ...a, to: a.to.toUpperCase().replace("0X", "0x") }));
  assert.notEqual(evmFingerprint(a), evmFingerprint(usdcTransferTx(BOB, "5000001")));
  const req = { chain: "eip155:8453" as const, url: "https://api.example.com/x", method: "POST" as const, body: { b: 1, a: 2 }, maxAmount: "50000" };
  assert.equal(x402Fingerprint(req), x402Fingerprint({ ...req, body: { a: 2, b: 1 } }));
  assert.notEqual(x402Fingerprint(req), x402Fingerprint({ ...req, maxAmount: "50001" }));
});

test("explains an x402 request", () => {
  const e = explainX402({ chain: "eip155:8453", url: "https://api.example.com/search?q=1", method: "POST", maxAmount: "50000" });
  assert.equal(e.summary, "Pays at most 0.05 USDC on Base to call POST https://api.example.com/search.");
});

function fakeRpc(receipt: unknown): BaseRpc {
  return { receipt: async () => ({ ok: true, value: receipt }) } as unknown as BaseRpc;
}
const topic = (a: string) => "0x" + a.slice(2).padStart(64, "0");
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const log = (from: string, to: string, amount: bigint, token = BASE_USDC) =>
  ({ address: token, topics: [TRANSFER, topic(from), topic(to)], data: "0x" + amount.toString(16).padStart(64, "0") });
const expected = { kind: "erc20" as const, token: BASE_USDC, from: ALICE, to: BOB, amountAtomic: "5000000" };

test("observes a matching USDC Transfer log", async () => {
  const r = await observe(fakeRpc({ status: "0x1", from: ALICE, to: BASE_USDC, logs: [log(ALICE, BOB, 5_000_000n)] }), "0x" + "1".repeat(64), expected);
  assert.equal(r.observedOnChain, "match");
});

test("reports mismatches, wrong signers, reverts and missing receipts", async () => {
  const h = "0x" + "1".repeat(64);
  assert.equal((await observe(fakeRpc({ status: "0x1", from: ALICE, to: BASE_USDC, logs: [log(ALICE, BOB, 4_000_000n)] }), h, expected)).observedOnChain, "mismatch");
  assert.equal((await observe(fakeRpc({ status: "0x1", from: ALICE, to: BASE_USDC, logs: [log(ALICE, BOB, 5_000_000n), log(ALICE, ALICE, 1n)] }), h, expected)).observedOnChain, "mismatch");
  assert.equal((await observe(fakeRpc({ status: "0x1", from: BOB, to: BASE_USDC, logs: [] }), h, expected)).observedOnChain, "signer_mismatch");
  assert.equal((await observe(fakeRpc({ status: "0x0", from: ALICE, to: BASE_USDC, logs: [] }), h, expected)).observedOnChain, "failed_tx");
  assert.equal((await observe(fakeRpc(null), h, expected)).observedOnChain, "unavailable");
});
