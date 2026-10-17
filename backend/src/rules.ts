import * as z from "zod/v4";

import { currentSlot, nextSlot, paymentKeyFor, type RuleSpec } from "../../my-plugin/src/rules/schedule.js";
import { appendAudit } from "./audit.js";
import { type Ctx, HttpError, newId, parse, requireWallet } from "./http.js";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((a) => a.toLowerCase());
const atomic = z.string().regex(/^[1-9][0-9]{0,30}$/);
const everyDays = z.number().int().min(1).max(366);

export const ruleSpecSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("weekly"), recipient: address, amountUsdcAtomic: atomic, dayOfWeek: z.number().int().min(0).max(6), hourUtc: z.number().int().min(0).max(23) }).strict(),
  z.object({ type: z.literal("interval_days"), recipient: address, amountUsdcAtomic: atomic, everyDays }).strict(),
  z.object({ type: z.literal("goal"), recipient: address, amountUsdcAtomic: atomic, targetUsdcAtomic: atomic, everyDays }).strict(),
  z.object({ type: z.literal("threshold_sweep"), recipient: address, thresholdUsdcAtomic: atomic, percent: z.number().int().min(1).max(100), everyDays }).strict(),
]);

interface RuleRow { id: string; spec: string; status: string; created_at: number; updated_at: number }

function present(row: RuleRow, now: number) {
  const spec = JSON.parse(row.spec) as RuleSpec;
  return { rule_id: row.id, status: row.status, spec, created_at: row.created_at, next_slot: row.status === "active" ? nextSlot(spec, row.created_at, now) : null };
}

export async function rules(ctx: Ctx, body: unknown) {
  const wallet = requireWallet(ctx);
  const req = parse(z.object({
    action: z.enum(["create", "list", "pause", "resume", "revoke", "complete"]),
    rule_id: z.string().max(80).optional(),
    spec: ruleSpecSchema.optional(),
  }).strict(), body);

  if (req.action === "list") {
    const { results } = await ctx.db.prepare("SELECT * FROM rules WHERE wallet = ? ORDER BY created_at").bind(wallet).all<RuleRow>();
    return { rules: results.map((r) => present(r, ctx.now)) };
  }
  if (req.action === "create") {
    if (!req.spec) throw new HttpError(400, "spec is required to create a rule");
    if (req.spec.recipient === wallet) throw new HttpError(400, "a rule cannot send funds back to the same wallet");
    const id = newId("rule");
    await ctx.db.prepare("INSERT INTO rules (id, wallet, spec, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)")
      .bind(id, wallet, JSON.stringify(req.spec), ctx.now, ctx.now).run();
    const audit = await appendAudit(ctx.db, wallet, { type: "rule_created", at: ctx.now, ruleId: id, spec: req.spec });
    const row = await ctx.db.prepare("SELECT * FROM rules WHERE id = ?").bind(id).first<RuleRow>();
    return { rule: present(row!, ctx.now), audit };
  }

  if (!req.rule_id) throw new HttpError(400, "rule_id is required");
  const allowedFrom: Record<string, string[]> = { pause: ["active"], resume: ["paused"], revoke: ["active", "paused", "completed"], complete: ["active"] };
  const target = { pause: "paused", resume: "active", revoke: "revoked", complete: "completed" }[req.action];
  const from = allowedFrom[req.action]!;
  const res = await ctx.db.prepare(`UPDATE rules SET status = ?, updated_at = ? WHERE id = ? AND wallet = ? AND status IN (${from.map(() => "?").join(",")})`)
    .bind(target, ctx.now, req.rule_id, wallet, ...from).run();
  if (res.meta.changes !== 1) throw new HttpError(409, `rule not found for this wallet, or it cannot be ${req.action}d from its current status`);
  const audit = await appendAudit(ctx.db, wallet, { type: `rule_${target}`, at: ctx.now, ruleId: req.rule_id });
  const row = await ctx.db.prepare("SELECT * FROM rules WHERE id = ?").bind(req.rule_id).first<RuleRow>();
  return { rule: present(row!, ctx.now), audit };
}

/** First active rule whose current slot has not settled and is not in flight. */
export async function dueRule(ctx: Ctx) {
  const wallet = requireWallet(ctx);
  const { results } = await ctx.db.prepare("SELECT * FROM rules WHERE wallet = ? AND status = 'active' ORDER BY created_at").bind(wallet).all<RuleRow>();
  for (const row of results) {
    const spec = JSON.parse(row.spec) as RuleSpec;
    const slot = currentSlot(spec, row.created_at, ctx.now);
    if (slot === null) continue;
    const key = paymentKeyFor(row.id, slot);
    const state = await ctx.db.prepare("SELECT state, locked_until FROM payment_keys WHERE wallet = ? AND key = ?").bind(wallet, key)
      .first<{ state: string; locked_until: number | null }>();
    if (state?.state === "settled" || state?.state === "denied") continue;
    if (state?.state === "in_flight" && (state.locked_until ?? 0) > ctx.now) continue;
    return { wallet, due: true, rule: present(row, ctx.now), slot, payment_key: key };
  }
  return { wallet, due: false, active_rules: results.length };
}
