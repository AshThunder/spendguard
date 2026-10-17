import type * as z from "zod/v4";

/** The subset of Cloudflare D1 that SpendGuard uses. */
export interface D1Result<T = unknown> {
  results: T[];
  meta: { changes: number };
}
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}
export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

export interface Env {
  DB: D1Database;
  BASE_RPC_URL?: string;
  /** Owner key the PayBox portal injects as `Authorization: Bearer <key>` for plugin requests. */
  OWNER_KEY?: string;
  /** Local development only (.dev.vars): skip the owner key and accept x-spendguard-now. */
  DEV_INSECURE?: string;
}

export interface Ctx {
  env: Env;
  db: D1Database;
  now: number;
  rpcUrl: string;
  wallet: string | null;
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function parse<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) throw new HttpError(400, `invalid request: ${result.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  return result.data;
}

export function requireWallet(ctx: Ctx): string {
  if (!ctx.wallet) throw new HttpError(401, "a valid SpendGuard session is required; start one with the session tool");
  return ctx.wallet;
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}
