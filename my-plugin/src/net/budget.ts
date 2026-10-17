export type NetResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * One shared network budget per tool call. Hosted calls get 10s in total including
 * sandbox startup, so outbound work is capped well below that and never throws.
 */
export class Budget {
  private readonly deadline: number;

  constructor(totalMs = 6_000, private readonly perRequestMs = 3_000) {
    this.deadline = Date.now() + totalMs;
  }

  remaining(): number {
    return this.deadline - Date.now();
  }

  async fetchJson(url: string, init: RequestInit = {}): Promise<NetResult<unknown>> {
    const left = this.remaining();
    if (left < 500) return { ok: false, reason: "network budget exhausted" };
    try {
      const response = await fetch(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(Math.min(this.perRequestMs, left)),
      });
      const text = await response.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        return { ok: false, reason: `non-JSON response (HTTP ${response.status})` };
      }
      if (!response.ok) {
        const message = (body as { error?: unknown } | null)?.error;
        return { ok: false, reason: typeof message === "string" ? message : `HTTP ${response.status}` };
      }
      return { ok: true, value: body };
    } catch (error) {
      const name = (error as Error)?.name;
      return { ok: false, reason: name === "TimeoutError" || name === "AbortError" ? "request timed out" : "request failed" };
    }
  }
}
