import { canonicalJson } from "../../my-plugin/src/util/canonical.js";
import { sha256Hex } from "./auth.js";
import type { D1Database } from "./http.js";

export const GENESIS = "0".repeat(64);

export interface AuditEvent {
  type: string;
  at: number;
  [field: string]: unknown;
}

function chainHash(prev: string, event: AuditEvent): Promise<string> {
  return sha256Hex(`${prev}\n${canonicalJson(event)}`);
}

/** Appends to the wallet's hash chain. A concurrent append that loses the race retries. */
export async function appendAudit(db: D1Database, wallet: string, event: AuditEvent): Promise<{ seq: number; hash: string }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const last = await db.prepare("SELECT hash FROM audit_log WHERE wallet = ? ORDER BY seq DESC LIMIT 1").bind(wallet).first<{ hash: string }>();
    const prev = last?.hash ?? GENESIS;
    const hash = await chainHash(prev, event);
    try {
      const row = await db
        .prepare("INSERT INTO audit_log (wallet, event, prev_hash, hash) VALUES (?, ?, ?, ?) RETURNING seq")
        .bind(wallet, canonicalJson(event), prev, hash)
        .first<{ seq: number }>();
      return { seq: row!.seq, hash };
    } catch (error) {
      if (!String(error).includes("UNIQUE")) throw error;
    }
  }
  throw new Error("audit append contention");
}

export async function listAudit(db: D1Database, wallet: string, limit: number) {
  const { results } = await db
    .prepare("SELECT seq, event, prev_hash, hash FROM audit_log WHERE wallet = ? ORDER BY seq DESC LIMIT ?")
    .bind(wallet, limit)
    .all<{ seq: number; event: string; prev_hash: string; hash: string }>();
  return results.map((r) => ({ seq: r.seq, event: JSON.parse(r.event) as AuditEvent, prevHash: r.prev_hash, hash: r.hash }));
}

export async function verifyAudit(db: D1Database, wallet: string) {
  const { results } = await db
    .prepare("SELECT seq, event, prev_hash, hash FROM audit_log WHERE wallet = ? ORDER BY seq ASC")
    .bind(wallet)
    .all<{ seq: number; event: string; prev_hash: string; hash: string }>();
  let prev = GENESIS;
  for (const row of results) {
    const expected = await chainHash(prev, JSON.parse(row.event) as AuditEvent);
    if (row.prev_hash !== prev || row.hash !== expected) {
      return { intact: false, entries: results.length, brokenAtSeq: row.seq, head: prev };
    }
    prev = row.hash;
  }
  return { intact: true, entries: results.length, brokenAtSeq: null, head: prev };
}
