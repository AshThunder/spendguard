import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import type { D1Database, D1PreparedStatement, D1Result } from "../src/http.js";

/** Local stand-in for Cloudflare D1 on Node's built-in SQLite, for tests and the demo. */
export function localD1(path = ":memory:", schemaFile = new URL("../schema.sql", import.meta.url)): D1Database {
  const db = new DatabaseSync(path);
  db.exec(readFileSync(schemaFile, "utf8"));

  const statement = (sql: string, values: unknown[] = []): D1PreparedStatement & { exec(): D1Result } => {
    const params = values.map((v) => (v === undefined ? null : v)) as SQLInputValue[];
    const exec = (): D1Result => {
      const stmt = db.prepare(sql);
      if (/^\s*(SELECT|WITH)|\bRETURNING\b/i.test(sql)) {
        return { results: stmt.all(...params) as never[], meta: { changes: 0 } };
      }
      const info = stmt.run(...params);
      return { results: [], meta: { changes: Number(info.changes) } };
    };
    return {
      bind: (...v: unknown[]) => statement(sql, v),
      exec,
      first: async <T>() => (exec().results[0] as T | undefined) ?? null,
      all: async <T>() => exec() as D1Result<T>,
      run: async () => exec(),
    };
  };

  return {
    prepare: (sql) => statement(sql),
    batch: async (stmts) => {
      db.exec("BEGIN");
      try {
        const out = stmts.map((s) => (s as ReturnType<typeof statement>).exec());
        db.exec("COMMIT");
        return out;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
