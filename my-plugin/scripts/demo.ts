/**
 * Local end-to-end demo of SpendGuard. Runs dist/plugin.mjs once per tool call (as PayBox does) against an
 * in-process copy of the backend on SQLite. A throwaway local key stands in for PayBox request_wallet_sign,
 * and SIMULATE=receipt_match stands in for a real Base receipt. Nothing here moves funds.
 *
 *   pnpm build && pnpm demo
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { localD1 } from "../../backend/local/d1.js";
import { handle } from "../../backend/src/index.js";
import { release } from "./report.mjs";

const PLUGIN = resolve(import.meta.dirname, "../dist/plugin.mjs");
const SAVINGS = privateKeyToAccount(generatePrivateKey()).address;
const VENDOR = "0x3333333333333333333333333333333333333333";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const UNLIMITED_APPROVE = "0x095ea7b3" + VENDOR.slice(2).padStart(64, "0") + "f".repeat(64);
const STORM_LIMIT = 20;
const LIVE_RPC = process.argv.includes("--live-rpc");
/** A fresh wallet on Base: no transactions, no contract code, zero balances. */
const STUB_RPC: Record<string, string> = { eth_getTransactionCount: "0x0", eth_getCode: "0x", eth_call: "0x" + "0".repeat(64) };
const fakeTxHash = () => "0x" + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

async function startBackend(): Promise<{ url: string; close: () => void }> {
  const env = { DB: localD1(":memory:"), DEV_INSECURE: "1" };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (req.url === "/rpc") {
      const { id, method } = JSON.parse(Buffer.concat(chunks).toString());
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result: STUB_RPC[method] ?? null }));
      return;
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const r = await handle(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers, ...(req.method === "POST" ? { body: Buffer.concat(chunks) } : {}) }), env);
    res.writeHead(r.status, { "content-type": "application/json" });
    res.end(await r.text());
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

type ToolResult = { content: { type: string; text: string }[]; structuredContent?: any; isError?: boolean };

function makeCaller(env: Record<string, string>) {
  return (name: string, args: Record<string, unknown>): Promise<ToolResult> =>
    new Promise((ok, fail) => {
      const child = spawn(process.execPath, [PLUGIN], { env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["pipe", "pipe", "pipe"] });
      const timer = setTimeout(() => { child.kill("SIGKILL"); fail(new Error(`${name} exceeded 10s`)); }, 10_000);
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        const msg = JSON.parse(line);
        if (msg.id !== 1) return;
        clearTimeout(timer);
        child.kill();
        msg.error ? fail(new Error(JSON.stringify(msg.error))) : ok(msg.result);
      });
      child.stdin.write(JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name, arguments: args, _meta: {
          "io.modelcontextprotocol/protocolVersion": release.protocolVersion,
          "io.modelcontextprotocol/clientInfo": { name: "spendguard-demo", version: "0.1.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        } },
      }) + "\n");
    });
}

async function signTyped(account: ReturnType<typeof privateKeyToAccount>, typed: any): Promise<string> {
  const { EIP712Domain: _d, ...types } = typed.types;
  return account.signTypedData({ domain: typed.domain, types, primaryType: typed.primaryType, message: typed.message });
}

function show(label: string, r: ToolResult) {
  console.log(`\n${bold("> " + label)}${r.isError ? " (isError)" : ""}`);
  for (const c of r.content) console.log(c.text.replace(/typed_data: .*/s, "typed_data: {…}").replace(/sgs_[A-Za-z0-9_-]+/g, "sgs_…"));
}

function expect(cond: boolean, what: string) {
  if (!cond) throw new Error(`Demo expectation failed: ${what}`);
  console.log(dim(`  ✓ ${what}`));
}

function scene(n: number, title: string) {
  console.log(`\n${bold(`━━━ Scene ${n}: ${title} ━━━`)}`);
}

async function main() {
  const backend = await startBackend();
  const call = makeCaller({
    SPENDGUARD_BACKEND_URL: backend.url, SIMULATE: "receipt_match", MIN_RETRY_INTERVAL_S: "0", MAX_ATTEMPTS_PER_WINDOW: String(STORM_LIMIT),
    ...(LIVE_RPC ? {} : { BASE_RPC_URL: `${backend.url}/rpc` }),
  });
  const wallet = privateKeyToAccount(generatePrivateKey());
  console.log(dim(`Local backend ${backend.url}. Throwaway wallet ${wallet.address} stands in for a PayBox wallet; its key never leaves this process.`));
  console.log(dim(LIVE_RPC ? "Reading Base state from the public RPC." : "Base RPC is a local stand-in for a fresh wallet (use --live-rpc for mainnet.base.org)."));

  try {
    scene(0, "Prove the wallet is yours (session)");
    const start = await call("session", { action: "start", wallet: wallet.address });
    show("session start", start);
    const done = await call("session", { action: "complete", challenge_id: start.structuredContent.challenge_id, signature: await signTyped(wallet, start.structuredContent.typed_data) });
    show("session complete (signature from request_wallet_sign stand-in)", done);
    const token = done.structuredContent.session_token as string;
    expect(!!token, "session token issued only after a valid wallet signature");

    scene(1, "Explain: what is this transaction really doing?");
    const tx = { chain: "eip155:8453", to: USDC, value: "0", data: UNLIMITED_APPROVE };
    const ex = await call("explain_transaction", { transaction: tx });
    show("explain_transaction (another plugin's approve call)", ex);
    expect(ex.structuredContent.flags.some((f: { code: string }) => f.code.includes("unlimited")), "unlimited allowance flagged");

    scene(2, "Stop: block the unlimited approval");
    const stop = await call("check_payment", { wallet: wallet.address, payment_key: "approve-vendor", payment: { kind: "raw_evm", transaction: tx }, session_token: token });
    show("check_payment raw_evm", stop);
    expect(stop.structuredContent.verdict === "block" && stop.structuredContent.override_challenge === null, "blocked, and not overridable");

    scene(3, "Prevent a duplicate: one invoice, one payment");
    const key = "invoice-42";
    const payment = { kind: "usdc_transfer", recipient: VENDOR, amount_usdc: "5" };
    const allow = await call("check_payment", { wallet: wallet.address, payment_key: key, payment, session_token: token });
    show("check_payment 5 USDC", allow);
    expect(allow.structuredContent.verdict === "allow", "allowed");
    const prop = await call("propose_usdc_transfer", { session_token: token, decision_id: allow.structuredContent.decision_id });
    show("propose_usdc_transfer", prop);
    expect(!!prop.structuredContent?.["io.paybox/transactionProposal"], "PayBox transaction proposal returned");
    await call("report_status", { session_token: token, payment_key: key, request_id: "req_demo_1", status: "pending_confirmation" });
    const reuse = await call("propose_usdc_transfer", { session_token: token, decision_id: allow.structuredContent.decision_id });
    show("propose_usdc_transfer again with the same decision", reuse);
    expect(reuse.isError === true, "decision is single-use");
    const dup = await call("check_payment", { wallet: wallet.address, payment_key: key, payment, session_token: token });
    show("agent retries while PayBox still says pending_confirmation", dup);
    expect(dup.structuredContent.reasons.some((r: { code: string }) => r.code === "in_flight"), "in-flight duplicate blocked");

    scene(4, "Prove the outcome: settle, observe, refuse a second payment");
    const settled = await call("report_status", { session_token: token, payment_key: key, request_id: "req_demo_1", status: "success", tx_hash: fakeTxHash() });
    show("report_status success", settled);
    expect(settled.structuredContent.state === "settled", "settled");
    const again = await call("check_payment", { wallet: wallet.address, payment_key: key, payment, session_token: token });
    show("check_payment for the paid invoice", again);
    expect(again.structuredContent.reasons.some((r: { code: string }) => r.code === "already_settled"), "already-settled invoice blocked");

    scene(5, "Ambiguous failure: pause, then a wallet-signed override for this exact payment");
    const key2 = "invoice-43";
    const p2 = { kind: "usdc_transfer", recipient: VENDOR, amount_usdc: "3" };
    const a2 = await call("check_payment", { wallet: wallet.address, payment_key: key2, payment: p2, session_token: token });
    await call("propose_usdc_transfer", { session_token: token, decision_id: a2.structuredContent.decision_id });
    await call("report_status", { session_token: token, payment_key: key2, request_id: "req_demo_2", status: "error" });
    const paused = await call("check_payment", { wallet: wallet.address, payment_key: key2, payment: p2, session_token: token });
    show("check_payment after PayBox reported error", paused);
    expect(paused.structuredContent.verdict === "pause" && !!paused.structuredContent.override_challenge, "paused with an override challenge");
    const ch = paused.structuredContent.override_challenge;
    const ov = await call("confirm_override", { session_token: token, challenge_id: ch.challenge_id, signature: await signTyped(wallet, ch.typed_data) });
    show("confirm_override", ov);
    const bigger = await call("check_payment", { wallet: wallet.address, payment_key: key2, payment: { ...p2, amount_usdc: "9" }, session_token: token });
    expect(bigger.structuredContent.verdict !== "allow", "override does not cover a different amount");
    const retried = await call("check_payment", { wallet: wallet.address, payment_key: key2, payment: p2, session_token: token });
    show("check_payment with the identical payment", retried);
    expect(retried.structuredContent.verdict === "allow", "exactly one retry allowed");

    scene(6, "Goal rule: save toward a target, still through the guard");
    const rule = await call("rules", { session_token: token, action: "create", rule: { type: "goal", recipient: SAVINGS, amount_usdc: "10", target_usdc: "500", every_days: 7 } });
    show("rules create", rule);
    const due = await call("run_due_rules", { session_token: token });
    show("run_due_rules", due);
    expect(due.structuredContent.verdict === "allow" && /rule:/.test(due.content[0]!.text), "due slot checked by the guard with a once-per-slot payment key");

    scene(7, "Retry storm: a looping agent inventing new invoice numbers");
    let storm: ToolResult | null = null;
    for (let i = 0; i < STORM_LIMIT; i++) {
      storm = await call("check_payment", { wallet: wallet.address, payment_key: `loop-${i}`, payment: { kind: "usdc_transfer", recipient: VENDOR, amount_usdc: "1" }, session_token: token });
      if (storm.structuredContent.verdict === "block") break;
    }
    show("check_payment (after repeated fresh keys)", storm!);
    expect(storm!.structuredContent.reasons.some((r: { code: string }) => r.code === "retry_storm"), "retry storm blocked across payment keys");

    scene(8, "Audit: tamper-evident history");
    const log = await call("audit_log", { session_token: token, action: "list", limit: 50 });
    show("audit_log list", log);
    const verify = await call("audit_log", { session_token: token, action: "verify" });
    show("audit_log verify", verify);
    expect(verify.structuredContent.intact === true, "hash chain intact");

    console.log(`\n${bold("Demo complete.")}`);
  } finally {
    backend.close();
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
