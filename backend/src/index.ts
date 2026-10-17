import { timingSafeEqual } from "./auth.js";
import { audit, check, confirmOverride, consume, getDecision, keyInfo, reportStatus } from "./guard.js";
import { type Ctx, type Env, HttpError, json } from "./http.js";
import { dueRule, rules } from "./rules.js";
import { sessionChallenge, sessionComplete, sessionRevoke, walletForSession } from "./session.js";

type Handler = (ctx: Ctx, body: unknown, token: string | null) => Promise<unknown>;

const routes: Record<string, Handler> = {
  "/v1/session/challenge": (ctx, body) => sessionChallenge(ctx, body),
  "/v1/session/complete": (ctx, body) => sessionComplete(ctx, body),
  "/v1/session/revoke": (ctx, _body, token) => sessionRevoke(ctx, token),
  "/v1/check": (ctx, body) => check(ctx, body),
  "/v1/decision/get": (ctx, body) => getDecision(ctx, body),
  "/v1/decision/consume": (ctx, body) => consume(ctx, body),
  "/v1/key": (ctx, body) => keyInfo(ctx, body),
  "/v1/status": (ctx, body) => reportStatus(ctx, body),
  "/v1/override/confirm": (ctx, body) => confirmOverride(ctx, body),
  "/v1/audit": (ctx, body) => audit(ctx, body),
  "/v1/rules": (ctx, body) => rules(ctx, body),
  "/v1/rules/due": (ctx) => dueRule(ctx),
};

export async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health") return json({ ok: true });
  const handler = routes[url.pathname];
  if (!handler) return json({ error: "not found" }, 404);
  if (request.method !== "POST") return json({ error: "use POST" }, 405);

  const dev = env.DEV_INSECURE === "1";
  if (!dev) {
    const auth = request.headers.get("authorization") ?? "";
    if (!env.OWNER_KEY || !auth.startsWith("Bearer ") || !(await timingSafeEqual(auth.slice(7), env.OWNER_KEY))) {
      return json({ error: "unauthorized" }, 401);
    }
  }

  const testNow = dev ? Number(request.headers.get("x-spendguard-now")) : NaN;
  const ctx: Ctx = {
    env,
    db: env.DB,
    now: Number.isFinite(testNow) && testNow > 0 ? Math.floor(testNow) : Math.floor(Date.now() / 1000),
    rpcUrl: env.BASE_RPC_URL ?? "https://mainnet.base.org",
    wallet: null,
  };
  const token = request.headers.get("x-spendguard-session");
  ctx.wallet = await walletForSession(ctx, token);

  let body: unknown = {};
  try {
    const text = await request.text();
    if (text.length > 64 * 1024) return json({ error: "request too large" }, 413);
    body = text ? JSON.parse(text) : {};
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  try {
    return json(await handler(ctx, body, token));
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status);
    console.error("unhandled", error);
    return json({ error: "internal error" }, 500);
  }
}

export default { fetch: handle };
