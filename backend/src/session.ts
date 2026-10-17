import * as z from "zod/v4";

import { appendAudit } from "./audit.js";
import { randomToken, SESSION_STATEMENT, sessionTypedData, sha256Hex, verifyTyped } from "./auth.js";
import { type Ctx, HttpError, newId, parse, requireWallet } from "./http.js";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((a) => a.toLowerCase());
const CHALLENGE_TTL = 300;
const SESSION_TTL = 24 * 3600;

export async function sessionChallenge(ctx: Ctx, body: unknown) {
  const { wallet } = parse(z.object({ wallet: address }).strict(), body);
  const id = newId("sch");
  const nonce = randomToken(16);
  const expiresAt = ctx.now + SESSION_TTL;
  await ctx.db
    .prepare("INSERT INTO session_challenges (id, wallet, nonce, issued_at, expires_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, wallet, nonce, ctx.now, ctx.now + CHALLENGE_TTL)
    .run();
  return {
    challenge_id: id,
    challenge_expires_at: ctx.now + CHALLENGE_TTL,
    typed_data: sessionTypedData({ wallet, nonce, issuedAt: ctx.now, expiresAt, statement: SESSION_STATEMENT }),
  };
}

export async function sessionComplete(ctx: Ctx, body: unknown) {
  const { challenge_id, signature } = parse(z.object({ challenge_id: z.string().max(80), signature: z.string().max(4096) }).strict(), body);
  const ch = await ctx.db
    .prepare("SELECT * FROM session_challenges WHERE id = ?")
    .bind(challenge_id)
    .first<{ wallet: string; nonce: string; issued_at: number; expires_at: number; used_at: number | null }>();
  if (!ch || ch.used_at !== null || ch.expires_at <= ctx.now) throw new HttpError(400, "session challenge is unknown, used, or expired; start a new one");
  const expiresAt = ch.issued_at + SESSION_TTL;
  const typed = sessionTypedData({ wallet: ch.wallet, nonce: ch.nonce, issuedAt: ch.issued_at, expiresAt, statement: SESSION_STATEMENT });
  if (!(await verifyTyped(ctx.rpcUrl, ch.wallet, signature, typed))) throw new HttpError(403, "signature does not match the challenged wallet");

  const claimed = await ctx.db.prepare("UPDATE session_challenges SET used_at = ? WHERE id = ? AND used_at IS NULL").bind(ctx.now, challenge_id).run();
  if (claimed.meta.changes !== 1) throw new HttpError(409, "session challenge was already used");
  const token = `sgs_${randomToken(32)}`;
  await ctx.db
    .prepare("INSERT INTO sessions (token_hash, wallet, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(token), ch.wallet, ctx.now, expiresAt)
    .run();
  await appendAudit(ctx.db, ch.wallet, { type: "session_started", at: ctx.now, expiresAt });
  return { session_token: token, wallet: ch.wallet, expires_at: expiresAt };
}

export async function sessionRevoke(ctx: Ctx, token: string | null) {
  const wallet = requireWallet(ctx);
  await ctx.db.prepare("UPDATE sessions SET revoked_at = ? WHERE token_hash = ?").bind(ctx.now, await sha256Hex(token ?? "")).run();
  await appendAudit(ctx.db, wallet, { type: "session_revoked", at: ctx.now });
  return { revoked: true };
}

export async function walletForSession(ctx: Ctx, token: string | null): Promise<string | null> {
  if (!token || token.length > 200) return null;
  const row = await ctx.db
    .prepare("SELECT wallet FROM sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?")
    .bind(await sha256Hex(token), ctx.now)
    .first<{ wallet: string }>();
  return row?.wallet ?? null;
}
