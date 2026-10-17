import * as z from "zod/v4";

import { address, BACKEND_MISSING, context, failure, sessionToken, text } from "./common.js";

export const sessionInput = z.object({
  action: z.enum(["start", "complete", "revoke"]),
  wallet: address.optional().describe("start: the public address of the PayBox wallet to bind the session to."),
  challenge_id: z.string().max(80).optional().describe("complete: the challenge_id returned by start."),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/).max(4096).optional().describe("complete: output.signature from get_request."),
  session_token: sessionToken.optional().describe("revoke: the session to end."),
}).strict();

export async function session(args: z.infer<typeof sessionInput>) {
  const ctx = context();
  if (args.action === "start") {
    if (!args.wallet) return failure("wallet is required to start a session.");
    const store = ctx.store(null);
    if (!store) return failure(BACKEND_MISSING);
    const res = await store.post<{ challenge_id: string; challenge_expires_at: number; typed_data: Record<string, unknown> }>("/v1/session/challenge", { wallet: args.wallet });
    if (!res.ok) return failure(`Could not start a session (${res.reason}).`);
    return {
      content: text(
        "To prove this wallet is yours, sign the session message with PayBox:",
        `1. Call request_wallet_sign with this wallet's credential_id and intent {"op":"typedData","typedData": <typed_data below>}.\n2. If it returns pending_approval, show the user the approval_url. Poll get_request (never call request_wallet_sign again) until success.\n3. Call session with action "complete", challenge_id "${res.value.challenge_id}" and output.signature.`,
        "The session lets SpendGuard store this wallet's rules and audit log for 24 hours. It cannot move funds.",
        `typed_data: ${JSON.stringify(res.value.typed_data)}`,
      ),
      structuredContent: res.value,
    };
  }
  if (args.action === "complete") {
    if (!args.challenge_id || !args.signature) return failure("challenge_id and signature are required to complete a session.");
    const store = ctx.store(null);
    if (!store) return failure(BACKEND_MISSING);
    const res = await store.post<{ session_token: string; wallet: string; expires_at: number }>("/v1/session/complete", { challenge_id: args.challenge_id, signature: args.signature });
    if (!res.ok) return failure(`Session not started (${res.reason}).`);
    return {
      content: text(
        `Session active for ${res.value.wallet} until ${new Date(res.value.expires_at * 1000).toISOString()}.`,
        `session_token: ${res.value.session_token}`,
        "Pass this session_token on every later SpendGuard call. Do not repeat it in your reply to the user.",
      ),
      structuredContent: res.value,
    };
  }
  if (!args.session_token) return failure("session_token is required to revoke a session.");
  const store = ctx.store(args.session_token);
  if (!store) return failure(BACKEND_MISSING);
  const res = await store.post<{ revoked: boolean }>("/v1/session/revoke");
  if (!res.ok) return failure(`Session not revoked (${res.reason}).`);
  return { content: text("Session revoked. SpendGuard will no longer accept this token."), structuredContent: res.value };
}
