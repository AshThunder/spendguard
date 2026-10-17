import type { Budget, NetResult } from "./net/budget.js";

/**
 * Client for the SpendGuard backend. PayBox adds the owner's `Authorization` header to
 * requests for the configured host; this plugin never reads or sends that secret itself.
 */
export class Store {
  constructor(private readonly baseUrl: string, private readonly budget: Budget, private readonly session: string | null) {}

  post<T>(path: string, body: unknown = {}): Promise<NetResult<T>> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.session) headers["x-spendguard-session"] = this.session;
    return this.budget.fetchJson(`${this.baseUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) }) as Promise<NetResult<T>>;
  }
}
