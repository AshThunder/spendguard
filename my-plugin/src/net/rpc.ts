import type { Budget, NetResult } from "./budget.js";

export interface RpcReceipt {
  status: string;
  from: string;
  to: string | null;
  logs: { address: string; topics: string[]; data: string }[];
}

export interface RpcTransaction {
  from: string;
  to: string | null;
  value: string;
  input: string;
}

export class BaseRpc {
  private id = 0;

  constructor(private readonly url: string, private readonly budget: Budget) {}

  async call<T>(method: string, params: unknown[]): Promise<NetResult<T>> {
    const result = await this.budget.fetchJson(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
    });
    if (!result.ok) return result;
    const body = result.value as { result?: T; error?: { message?: string } } | null;
    if (!body || body.error) return { ok: false, reason: body?.error?.message ?? "RPC error" };
    return { ok: true, value: body.result as T };
  }

  async nonces(address: string): Promise<NetResult<{ latest: number; pending: number }>> {
    const [latest, pending] = await Promise.all([
      this.call<string>("eth_getTransactionCount", [address, "latest"]),
      this.call<string>("eth_getTransactionCount", [address, "pending"]),
    ]);
    if (!latest.ok) return latest;
    if (!pending.ok) return pending;
    return { ok: true, value: { latest: Number(BigInt(latest.value)), pending: Number(BigInt(pending.value)) } };
  }

  async hasCode(address: string): Promise<NetResult<boolean>> {
    const code = await this.call<string>("eth_getCode", [address, "latest"]);
    return code.ok ? { ok: true, value: code.value !== "0x" && code.value !== "0x0" } : code;
  }

  async ethCall(to: string, data: string): Promise<NetResult<string>> {
    return this.call<string>("eth_call", [{ to, data }, "latest"]);
  }

  async receipt(hash: string): Promise<NetResult<RpcReceipt | null>> {
    return this.call<RpcReceipt | null>("eth_getTransactionReceipt", [hash]);
  }

  async transaction(hash: string): Promise<NetResult<RpcTransaction | null>> {
    return this.call<RpcTransaction | null>("eth_getTransactionByHash", [hash]);
  }
}
