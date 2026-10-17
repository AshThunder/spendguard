import * as z from "zod/v4";

import { decodeEvm, evmFingerprint, explainEvm, explainX402, renderExplanation, x402Fingerprint, type EvmTx, type X402Request } from "../explain/decode.js";
import { observe, type ExpectedMovement } from "../explain/receipt.js";
import { BASE_USDC } from "../explain/tokens.js";
import { evaluate } from "../guard/evaluate.js";
import type { ChainState, Decision, Reason } from "../guard/types.js";
import { proposeEvm, proposeX402 } from "../paybox.js";
import { simulated, SCENARIOS, type Scenario } from "../simulate.js";
import { address, BACKEND_MISSING, backendDown, context, explanationSchema, failure, paymentKey, sessionToken, text, type CallContext } from "./common.js";
import { buildPayment, paymentSchema, type BuiltPayment } from "./payment.js";

/* ---------- explain_transaction ---------- */

export const explainInput = z.object({
  transaction: z.object({
    chain: z.literal("eip155:8453"),
    to: address,
    value: z.string().regex(/^(0|[1-9][0-9]{0,77})$/),
    data: z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/).max(245_762),
  }).strict().optional().describe("An EVM call on Base, e.g. the to/value/data of another plugin's proposal."),
  x402: z.object({
    url: z.string().url().max(2048),
    method: z.enum(["GET", "POST"]).default("GET"),
    body: z.record(z.string(), z.json()).optional(),
    max_amount_atomic: z.string().regex(/^[1-9][0-9]{0,19}$/).describe("Atomic USDC (6 decimals): 50000 = 0.05 USDC."),
  }).strict().optional(),
}).strict();

export async function explainTransaction(args: z.infer<typeof explainInput>) {
  if (!!args.transaction === !!args.x402) return failure("Provide exactly one of transaction or x402.");
  const ctx = context();
  const explanation = args.transaction
    ? await explainEvm(args.transaction, ctx.rpc)
    : explainX402({ chain: "eip155:8453", url: new URL(args.x402!.url).toString(), method: args.x402!.method,
      ...(args.x402!.body !== undefined ? { body: args.x402!.body } : {}), maxAmount: args.x402!.max_amount_atomic });
  return { content: text(renderExplanation(explanation)), structuredContent: explanation };
}

/* ---------- check_payment ---------- */

export const checkInput = z.object({
  wallet: address.describe("Public address of the PayBox wallet that will sign (from list_credentials metadata). Use the same wallet for use_plugin.wallet_id."),
  payment_key: paymentKey,
  payment: paymentSchema,
  session_token: sessionToken.optional(),
  dry_run: z.boolean().default(false).describe("Evaluate without storing anything or touching the network. No proposal can follow a dry run."),
  simulate: z.enum(SCENARIOS).optional().describe("Dry runs only: replay a risky situation to see how the guard reacts."),
}).strict();

const reasonSchema = z.object({ code: z.string(), overridable: z.boolean(), message: z.string() }).strict();
export const checkOutput = z.object({
  verdict: z.enum(["allow", "pause", "block"]),
  summary: z.string(),
  reasons: z.array(reasonSchema),
  decision_id: z.string().nullable(),
  decision_expires_at: z.number().int().nullable(),
  override_challenge: z.object({ challenge_id: z.string(), expires_at: z.number().int(), typed_data: z.record(z.string(), z.unknown()) }).strict().nullable(),
  propose_arguments: z.object({ session_token: z.string(), decision_id: z.string() }).strict().nullable(),
  next_step: z.string(),
  dry_run: z.boolean(),
  simulated: z.string().nullable(),
  explanation: explanationSchema,
}).strict();

interface CheckResult {
  verdict: Decision["verdict"];
  summary: string;
  reasons: Reason[];
  decision_id: string | null;
  decision_expires_at: number | null;
  override_challenge: { challenge_id: string; expires_at: number; typed_data: Record<string, unknown> } | null;
}

function nextStep(kind: BuiltPayment["kind"], r: CheckResult, dryRun: boolean): string {
  if (dryRun) return r.verdict === "allow" ? "Dry run only: call check_payment without dry_run (with a session) to get a usable decision." : "Dry run only. Nothing was stored.";
  if (r.verdict === "allow") {
    if (kind === "usdc_transfer") return "Call propose_usdc_transfer within 4 minutes. Its input must be propose_arguments exactly: session_token and decision_id. Do not send the recipient or amount. Submit the resulting proposal once, then poll get_request and call report_status when its status changes.";
    if (kind === "x402") return "Call propose_x402 within 4 minutes. Its input must be propose_arguments exactly: session_token and decision_id. Poll the PayBox request it creates; do not run the payment tool again to poll.";
    return "SpendGuard has locked this payment key. Submit the original transaction once through its own plugin, poll get_request, and call report_status with its request_id.";
  }
  if (r.override_challenge) {
    return "Do not retry automatically. Show the user the reasons. Only if the user wants to proceed: sign override_challenge.typed_data with PayBox request_wallet_sign (intent op \"typedData\"), poll get_request for the signature, then call confirm_override. Then run check_payment again with the identical payment.";
  }
  return `Do not retry. ${r.summary}`;
}

type RunCheck = { kind: "ok"; result: CheckResult } | { kind: "error"; message: string } | { kind: "down"; reason: string };

export async function runCheck(
  ctx: CallContext,
  args: { wallet: string; payment_key: string; session_token?: string | undefined },
  built: BuiltPayment,
): Promise<RunCheck> {
  const store = ctx.store(args.session_token ?? null);
  if (!store) return { kind: "error", message: BACKEND_MISSING };
  if (!args.session_token) return { kind: "error", message: "A session_token is required for a real check. Start one with the session tool, or use dry_run." };
  const chain = built.kind === "x402" ? { ok: true } : await chainState(ctx, args.wallet);
  const res = await store.post<CheckResult>("/v1/check", {
    wallet: args.wallet,
    payment_key: args.payment_key,
    kind: built.kind,
    fingerprint: built.explanation.fingerprint.hash,
    usdc_atomic: built.usdcAtomic,
    counterparty: built.explanation.counterparty,
    flags: built.explanation.flags,
    chain,
    limits: ctx.config.limits,
    details: built.details,
    summary: built.explanation.summary,
  });
  return res.ok ? { kind: "ok", result: res.value } : { kind: "down", reason: res.reason };
}

export function checkFailure(res: Exclude<RunCheck, { kind: "ok" }>) {
  return res.kind === "error" ? failure(res.message) : backendDown(res.reason);
}

async function chainState(ctx: CallContext, wallet: string): Promise<ChainState> {
  const n = await ctx.rpc.nonces(wallet);
  return n.ok ? { ok: true, latestNonce: n.value.latest, pendingNonce: n.value.pending } : { ok: false, reason: n.reason };
}

export function checkResponse(built: BuiltPayment, r: CheckResult, dryRun: boolean, scenario: string | null, preface?: string, sessionTokenForPropose?: string | null) {
  const step = nextStep(built.kind, r, dryRun);
  const proposeArguments = !dryRun && r.verdict === "allow" && r.decision_id && sessionTokenForPropose && (built.kind === "usdc_transfer" || built.kind === "x402")
    ? { session_token: sessionTokenForPropose, decision_id: r.decision_id }
    : null;
  const out = {
    verdict: r.verdict, summary: r.summary, reasons: r.reasons, decision_id: r.decision_id, decision_expires_at: r.decision_expires_at,
    override_challenge: r.override_challenge, propose_arguments: proposeArguments, next_step: step, dry_run: dryRun, simulated: scenario, explanation: built.explanation,
  };
  const reasons = r.reasons.length ? r.reasons.map((x) => `- ${x.code}${x.overridable ? " (overridable)" : ""}: ${x.message}`).join("\n") : null;
  return {
    content: text(
      preface,
      `SpendGuard verdict: ${r.verdict.toUpperCase()}${dryRun ? " (dry run)" : ""}${scenario ? ` | simulated: ${scenario}` : ""}\n${r.summary}`,
      reasons,
      renderExplanation(built.explanation),
      proposeArguments ? `propose_arguments: ${JSON.stringify(proposeArguments)}` : null,
      `Next: ${step}`,
    ),
    structuredContent: out,
  };
}

export async function checkPayment(args: z.infer<typeof checkInput>) {
  const ctx = context();
  if (args.simulate && !args.dry_run) return failure("simulate is only available with dry_run: true.");
  const built = await buildPayment(args.payment, args.dry_run ? null : ctx.rpc, allowedHostsFor(ctx, args));
  if ("error" in built) return failure(built.error);

  if (args.dry_run) {
    const now = Math.floor(Date.now() / 1000);
    const sim = simulated((args.simulate ?? "none") as Scenario, now);
    const d = evaluate({
      intent: { wallet: args.wallet.toLowerCase(), paymentKey: args.payment_key, kind: built.kind, fingerprint: built.explanation.fingerprint.hash,
        usdcAtomic: built.usdcAtomic, counterparty: built.explanation.counterparty, flags: built.explanation.flags },
      history: sim.history, chain: built.kind === "x402" ? { ok: true } : sim.chain, limits: ctx.config.limits, now,
    });
    return checkResponse(built, { verdict: d.verdict, summary: d.summary, reasons: d.reasons, decision_id: null, decision_expires_at: null, override_challenge: null },
      true, args.simulate ?? null, args.simulate ? `Simulated situation: ${sim.description}` : undefined);
  }

  const res = await runCheck(ctx, args, built);
  if (res.kind !== "ok") return checkFailure(res);
  return checkResponse(built, res.result, false, null, undefined, args.session_token);
}

/** Dry runs may explain any x402 host; live checks require the owner's allowlist. */
function allowedHostsFor(ctx: CallContext, args: z.infer<typeof checkInput>): string[] {
  if (!args.dry_run || args.payment.kind !== "x402") return ctx.config.x402AllowedHosts;
  return [new URL(args.payment.url).hostname.toLowerCase()];
}

/* ---------- propose_usdc_transfer / propose_x402 ---------- */

const decisionId = z.string().min(1).max(80);
/** Unknown fields are ignored. Agents often copy the whole allow result; only these two values are read. */
export const proposeInput = z.object({
  session_token: sessionToken.optional(),
  sessionToken: sessionToken.optional(),
  decision_id: decisionId.optional().describe("decision_id from an allow result. Prefer copying propose_arguments unchanged."),
  decisionId: decisionId.optional(),
});

export function normalizeProposeInput(args: z.infer<typeof proposeInput>): { session_token: string; decision_id: string } | null {
  const session_token = args.session_token ?? args.sessionToken;
  const decision_id = args.decision_id ?? args.decisionId;
  return session_token && decision_id ? { session_token, decision_id } : null;
}

interface DecisionInfo {
  payment_key: string;
  kind: string;
  verdict: string;
  fingerprint: string;
  usdc_atomic: string | null;
  details: Record<string, unknown>;
  usable: boolean;
}

async function loadDecision(ctx: CallContext, args: { session_token: string; decision_id: string }, kind: "usdc_transfer" | "x402") {
  const store = ctx.store(args.session_token);
  if (!store) return { error: BACKEND_MISSING } as const;
  const res = await store.post<DecisionInfo>("/v1/decision/get", { decision_id: args.decision_id });
  if (!res.ok) return { error: `Decision could not be loaded (${res.reason}). Nothing was proposed.` } as const;
  const d = res.value;
  if (d.kind !== kind) return { error: `This decision is for ${d.kind}, not ${kind}.` } as const;
  if (!d.usable) return { error: `This decision cannot be used (verdict ${d.verdict}, or it was already used or expired). Run check_payment again; nothing was proposed.` } as const;
  return { store, decision: d } as const;
}

export async function proposeUsdcTransfer(args: z.infer<typeof proposeInput>) {
  const normalized = normalizeProposeInput(args);
  if (!normalized) return failure("Pass propose_arguments from the allow result: session_token and decision_id. Nothing was proposed.");
  const ctx = context();
  const loaded = await loadDecision(ctx, normalized, "usdc_transfer");
  if ("error" in loaded) return failure(loaded.error!);
  const { store, decision } = loaded;
  const tx = decision.details.tx as EvmTx;
  const recipient = String(decision.details.recipient);
  const amountAtomic = String(decision.details.amountAtomic);

  // Decode what we are about to return and refuse if it differs from what the guard approved.
  const explanation = decodeEvm(tx);
  const consistent =
    explanation.action === "erc20_transfer" &&
    explanation.contract === BASE_USDC &&
    explanation.counterparty === recipient &&
    explanation.amount?.atomic === amountAtomic &&
    decision.usdc_atomic === amountAtomic &&
    evmFingerprint(tx) === decision.fingerprint &&
    tx.value === "0";
  if (!consistent) return failure("Self-check failed: the transaction SpendGuard would return does not match what the guard approved. Nothing was proposed.");

  const result = proposeEvm({ chain: tx.chain, to: tx.to, value: tx.value, data: tx.data });
  if (!result.structuredContent["io.paybox/transactionProposal"]) {
    return failure("Could not build the transaction proposal. Nothing was proposed.");
  }
  const consumed = await store.post<{ locked_until: number }>("/v1/decision/consume", {
    decision_id: normalized.decision_id, fingerprint: decision.fingerprint, inflight_lock_s: ctx.config.limits.inflightLockS,
  });
  if (!consumed.ok) return failure(`Decision could not be used (${consumed.reason}). Nothing was proposed.`);
  // Same object proposeEvm built. PayBox reads structuredContent["io.paybox/transactionProposal"].
  result.content = text(
    renderExplanation(explanation),
    result.content[0]!.text,
    `Payment key ${decision.payment_key} is now locked as in flight. Submit this proposal once. Poll get_request with the returned request_id and call report_status (with tx_hash on success). Never call this tool again for the same payment.`,
  );
  return result;
}

export async function proposeX402Payment(args: z.infer<typeof proposeInput>) {
  const normalized = normalizeProposeInput(args);
  if (!normalized) return failure("Pass propose_arguments from the allow result: session_token and decision_id. Nothing was proposed.");
  const ctx = context();
  const loaded = await loadDecision(ctx, normalized, "x402");
  if ("error" in loaded) return failure(loaded.error!);
  const { store, decision } = loaded;
  const req = decision.details.request as X402Request;
  if (x402Fingerprint(req) !== decision.fingerprint || decision.usdc_atomic !== req.maxAmount) {
    return failure("Self-check failed: the x402 request does not match what the guard approved. Nothing was proposed.");
  }
  const host = new URL(req.url).hostname.toLowerCase();
  if (!ctx.config.x402AllowedHosts.includes(host)) return failure(`Host ${host} is no longer allowed. Nothing was proposed.`);
  const result = proposeX402({ chain: "eip155:8453", url: req.url, method: req.method, maxAmount: req.maxAmount, ...(req.body !== undefined ? { body: req.body as never } : {}) });
  if (!result.structuredContent["io.paybox/transactionProposal"]) {
    return failure("Could not build the x402 proposal. Nothing was proposed.");
  }
  const consumed = await store.post<{ locked_until: number }>("/v1/decision/consume", {
    decision_id: normalized.decision_id, fingerprint: decision.fingerprint, inflight_lock_s: ctx.config.limits.inflightLockS,
  });
  if (!consumed.ok) return failure(`Decision could not be used (${consumed.reason}). Nothing was proposed.`);
  result.content = text(
    renderExplanation(explainX402(req)),
    result.content[0]!.text,
    `Payment key ${decision.payment_key} is locked as in flight. PayBox completes x402 after this call ends: poll the PayBox request ID, then call report_status. SpendGuard cannot observe x402 settlement on-chain; it relies on the reported status.`,
  );
  return result;
}

/* ---------- report_status ---------- */

export const reportInput = z.object({
  session_token: sessionToken,
  payment_key: paymentKey,
  request_id: z.string().min(1).max(200).describe("The PayBox request_id you are polling with get_request."),
  status: z.string().min(1).max(64).describe("The status get_request returned: pending_approval, pending_signature, pending_settlement, pending_confirmation, success, denied, or error."),
  tx_hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional().describe("Transaction hash from the success output, so SpendGuard can observe what moved on-chain."),
}).strict();

export async function reportStatus(args: z.infer<typeof reportInput>) {
  const ctx = context();
  const store = ctx.store(args.session_token);
  if (!store) return failure(BACKEND_MISSING);
  const info = await store.post<{ wallet: string; state: string; last_decision: { details: Record<string, unknown> } | null }>("/v1/key", { payment_key: args.payment_key });
  if (!info.ok) return backendDown(info.reason);

  let observed: { observedOnChain: string; detail: string } | null = null;
  let simulatedNote: string | null = null;
  const movement = info.value.last_decision?.details.movement as Omit<ExpectedMovement, "from"> | null | undefined;
  if (args.status === "success" && movement) {
    if (!args.tx_hash) {
      observed = { observedOnChain: "unavailable", detail: "No tx_hash was reported, so the token movement was not observed." };
    } else if (ctx.config.simulate === "receipt_match") {
      observed = { observedOnChain: "match", detail: "SIMULATED (SIMULATE=receipt_match): receipt observation skipped for the local demo." };
      simulatedNote = "Receipt observation was simulated for the local demo.";
    } else {
      observed = await observe(ctx.rpc, args.tx_hash, { ...movement, from: info.value.wallet });
    }
  }
  const res = await store.post<{ state: string; next_step: string; audit: { seq: number; hash: string } }>("/v1/status", {
    payment_key: args.payment_key, request_id: args.request_id, status: args.status,
    ...(args.tx_hash ? { tx_hash: args.tx_hash.toLowerCase() } : {}),
    ...(observed ? { observed: observed.observedOnChain, observed_detail: observed.detail } : {}),
    inflight_lock_s: ctx.config.limits.inflightLockS,
  });
  if (!res.ok) return failure(`Status was not recorded (${res.reason}).`);
  const out = { payment_key: args.payment_key, state: res.value.state, observed_on_chain: observed?.observedOnChain ?? null,
    observation_detail: observed?.detail ?? null, next_step: res.value.next_step, audit_hash: res.value.audit.hash };
  return {
    content: text(
      `Payment key ${args.payment_key}: ${res.value.state}`,
      observed ? `Observed on-chain: ${observed.observedOnChain}. ${observed.detail}` : null,
      observed?.observedOnChain === "match" ? "This confirms the token movement only. It does not establish that the recipient is trustworthy or that any service was delivered." : null,
      simulatedNote,
      `Next: ${res.value.next_step}`,
    ),
    structuredContent: out,
  };
}

/* ---------- confirm_override ---------- */

export const overrideInput = z.object({
  session_token: sessionToken,
  challenge_id: z.string().min(1).max(80),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/).max(4096).describe("output.signature from get_request after request_wallet_sign with op typedData."),
}).strict();

export async function confirmOverride(args: z.infer<typeof overrideInput>) {
  const ctx = context();
  const store = ctx.store(args.session_token);
  if (!store) return failure(BACKEND_MISSING);
  const res = await store.post<{ payment_key: string; clears: string[]; expires_at: number; next_step: string }>("/v1/override/confirm",
    { challenge_id: args.challenge_id, signature: args.signature });
  if (!res.ok) return failure(`Override not accepted (${res.reason}).`);
  return {
    content: text(
      `Override recorded for ${res.value.payment_key}. It clears only: ${res.value.clears.join(", ")}. It is single-use and valid for this exact payment until ${new Date(res.value.expires_at * 1000).toISOString()}.`,
      "A wallet signature authorizes one retry. It does not make the payment safe.",
      `Next: ${res.value.next_step}`,
    ),
    structuredContent: res.value,
  };
}

/* ---------- audit_log ---------- */

export const auditInput = z.object({
  session_token: sessionToken,
  action: z.enum(["list", "verify"]).default("list"),
  limit: z.number().int().min(1).max(50).default(20),
}).strict();

export async function auditLog(args: z.infer<typeof auditInput>) {
  const ctx = context();
  const store = ctx.store(args.session_token);
  if (!store) return failure(BACKEND_MISSING);
  const res = await store.post<Record<string, unknown>>("/v1/audit", { action: args.action, limit: args.limit });
  if (!res.ok) return failure(`Audit log unavailable (${res.reason}).`);
  const v = res.value;
  if (args.action === "verify") {
    return {
      content: text(v.intact
        ? `Audit chain intact: ${v.entries} entries, head hash ${v.head}.`
        : `Audit chain BROKEN at entry ${v.brokenAtSeq}. Entries after that point cannot be trusted.`),
      structuredContent: v,
    };
  }
  const entries = (v.entries as { seq: number; hash: string; event: Record<string, unknown> }[]) ?? [];
  return {
    content: text(entries.length
      ? entries.map((e) => `#${e.seq} ${new Date(Number(e.event.at) * 1000).toISOString()} ${e.event.type}${e.event.verdict ? ` ${String(e.event.verdict).toUpperCase()}` : ""}${e.event.summary ? `: ${e.event.summary}` : ""} [${e.hash.slice(0, 12)}]`).join("\n")
      : "No audit entries yet."),
    structuredContent: v,
  };
}
