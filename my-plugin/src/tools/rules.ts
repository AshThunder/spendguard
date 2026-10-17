import { decodeAbiParameters, encodeFunctionData, erc20Abi, formatUnits } from "viem";
import * as z from "zod/v4";

import { BASE_USDC } from "../explain/tokens.js";
import { atomicAmount } from "../paybox.js";
import { ruleAmount, type RuleSpec } from "../rules/schedule.js";
import { address, BACKEND_MISSING, backendDown, context, decimalUsdc, failure, sessionToken, text, type CallContext } from "./common.js";
import { checkFailure, checkResponse, runCheck } from "./guard.js";
import { buildPayment } from "./payment.js";

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

export const rulesInput = z.object({
  session_token: sessionToken,
  action: z.enum(["create", "list", "pause", "resume", "revoke"]),
  rule_id: z.string().max(80).optional().describe("pause / resume / revoke: the rule to change. Revoking is permanent."),
  rule: z.object({
    type: z.enum(["weekly", "interval_days", "goal", "threshold_sweep"]).describe(
      "weekly: fixed amount every week. interval_days: fixed amount every N days. goal: move amount_usdc every N days until the recipient holds target_usdc. threshold_sweep: every N days, move percent of the wallet's USDC above threshold_usdc."),
    recipient: address.describe("Where the USDC goes, e.g. your savings wallet."),
    amount_usdc: decimalUsdc.optional(),
    day_of_week: z.enum(DAYS).optional(),
    hour_utc: z.number().int().min(0).max(23).optional(),
    every_days: z.number().int().min(1).max(366).optional(),
    target_usdc: decimalUsdc.optional(),
    threshold_usdc: decimalUsdc.optional(),
    percent: z.number().int().min(1).max(100).optional(),
  }).strict().optional().describe("create: the rule. Every run still goes through the Spend Guard and needs PayBox approval per your grant."),
}).strict();

function toSpec(r: NonNullable<z.infer<typeof rulesInput>["rule"]>): RuleSpec | string {
  const amt = (v: string | undefined, name: string) => (v === undefined ? null : atomicAmount(v, 6)) ?? `${name} is required`;
  const need = <T>(v: T | undefined, name: string): T | string => (v === undefined ? `${name} is required` : v);
  const fields: Record<string, unknown> = { type: r.type, recipient: r.recipient.toLowerCase() };
  if (r.type === "weekly") {
    Object.assign(fields, { amountUsdcAtomic: amt(r.amount_usdc, "amount_usdc"), dayOfWeek: r.day_of_week ? DAYS.indexOf(r.day_of_week) : "day_of_week is required", hourUtc: need(r.hour_utc, "hour_utc") });
  } else if (r.type === "interval_days") {
    Object.assign(fields, { amountUsdcAtomic: amt(r.amount_usdc, "amount_usdc"), everyDays: need(r.every_days, "every_days") });
  } else if (r.type === "goal") {
    Object.assign(fields, { amountUsdcAtomic: amt(r.amount_usdc, "amount_usdc"), targetUsdcAtomic: amt(r.target_usdc, "target_usdc"), everyDays: need(r.every_days, "every_days") });
  } else {
    Object.assign(fields, { thresholdUsdcAtomic: amt(r.threshold_usdc, "threshold_usdc"), percent: need(r.percent, "percent"), everyDays: need(r.every_days, "every_days") });
  }
  const missing = Object.values(fields).find((v) => typeof v === "string" && v.endsWith(" is required"));
  return typeof missing === "string" ? missing : (fields as unknown as RuleSpec);
}

interface RuleView { rule_id: string; status: string; spec: RuleSpec; next_slot: number | null }

function describe(rule: RuleView): string {
  const s = rule.spec;
  const usdc = (a: string) => `${formatUnits(BigInt(a), 6)} USDC`;
  const what =
    s.type === "weekly" ? `${usdc(s.amountUsdcAtomic)} every ${DAYS[s.dayOfWeek]} at ${s.hourUtc}:00 UTC`
    : s.type === "interval_days" ? `${usdc(s.amountUsdcAtomic)} every ${s.everyDays} day(s)`
    : s.type === "goal" ? `${usdc(s.amountUsdcAtomic)} every ${s.everyDays} day(s) until the recipient holds ${usdc(s.targetUsdcAtomic)}`
    : `${s.percent}% of USDC above ${usdc(s.thresholdUsdcAtomic)}, every ${s.everyDays} day(s)`;
  const next = rule.next_slot ? `, next run ${new Date(rule.next_slot * 1000).toISOString()}` : "";
  return `${rule.rule_id} [${rule.status}] ${s.type}: ${what} to ${s.recipient}${next}`;
}

export async function rules(args: z.infer<typeof rulesInput>) {
  const ctx = context();
  const store = ctx.store(args.session_token);
  if (!store) return failure(BACKEND_MISSING);
  let body: Record<string, unknown> = { action: args.action };
  if (args.action === "create") {
    if (!args.rule) return failure("rule is required to create a rule.");
    const spec = toSpec(args.rule);
    if (typeof spec === "string") return failure(spec);
    body = { action: "create", spec };
  } else if (args.action !== "list") {
    if (!args.rule_id) return failure("rule_id is required.");
    body = { action: args.action, rule_id: args.rule_id };
  }
  const res = await store.post<{ rules?: RuleView[]; rule?: RuleView }>("/v1/rules", body);
  if (!res.ok) return failure(`Rule request failed (${res.reason}).`);
  const list = res.value.rules ?? (res.value.rule ? [res.value.rule] : []);
  return {
    content: text(list.length ? list.map(describe).join("\n") : "No rules yet.",
      args.action === "create" ? "Rules never pay on their own: call run_due_rules when you check in, and every run goes through the Spend Guard and PayBox approval." : null),
    structuredContent: res.value,
  };
}

export const runDueInput = z.object({ session_token: sessionToken }).strict();

async function usdcBalance(ctx: CallContext, who: string): Promise<bigint | null> {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [who as `0x${string}`] });
  const r = await ctx.rpc.ethCall(BASE_USDC, data);
  if (!r.ok || r.value === "0x") return null;
  try {
    return decodeAbiParameters([{ type: "uint256" }], r.value as `0x${string}`)[0];
  } catch {
    return null;
  }
}

/** Finds the next due rule and runs the Spend Guard for it. Never proposes by itself. */
export async function runDueRules(args: z.infer<typeof runDueInput>) {
  const ctx = context();
  const store = ctx.store(args.session_token);
  if (!store) return failure(BACKEND_MISSING);
  const due = await store.post<{ wallet: string; due: boolean; rule?: RuleView; payment_key?: string; active_rules?: number }>("/v1/rules/due");
  if (!due.ok) return backendDown(due.reason);
  if (!due.value.due) {
    return { content: text(`No rule is due right now (${due.value.active_rules ?? 0} active).`), structuredContent: { due: false } };
  }
  const rule = due.value.rule!;
  const wallet = due.value.wallet;
  const needsBalances = rule.spec.type === "goal" || rule.spec.type === "threshold_sweep";
  const [walletBal, recipientBal] = needsBalances
    ? await Promise.all([usdcBalance(ctx, wallet), usdcBalance(ctx, rule.spec.recipient)])
    : [null, null];
  const amount = ruleAmount(rule.spec, { wallet: walletBal, recipient: recipientBal });

  if (amount.kind === "completed") {
    await store.post("/v1/rules", { action: "complete", rule_id: rule.rule_id });
    return { content: text(`${describe(rule)}\n${amount.note} The rule is now completed.`), structuredContent: { due: false, completed: rule.rule_id } };
  }
  if (amount.kind === "skip") {
    return { content: text(`${describe(rule)}\nSkipped: ${amount.note}`), structuredContent: { due: true, skipped: amount.note } };
  }

  const built = await buildPayment(
    { kind: "usdc_transfer", recipient: rule.spec.recipient, amount_usdc: formatUnits(BigInt(amount.amountUsdcAtomic), 6) },
    ctx.rpc, ctx.config.x402AllowedHosts,
  );
  if ("error" in built) return failure(built.error);
  const res = await runCheck(ctx, { wallet, payment_key: due.value.payment_key!, session_token: args.session_token }, built);
  if (res.kind !== "ok") return checkFailure(res);
  return checkResponse(built, res.result, false, null, `Rule due: ${describe(rule)}\nPayment key: ${due.value.payment_key} (this slot can pay at most once). ${amount.note}`, args.session_token);
}
