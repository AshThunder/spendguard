import { createServer } from "node:http";

import { handle } from "../src/index.js";
import { localD1 } from "./d1.js";

/** Runs the Worker handler on Node with a local SQLite database. Development only. */
const port = Number(process.env.PORT ?? 8787);
const env = { DB: localD1(process.env.DB_PATH ?? ":memory:"), DEV_INSECURE: "1", BASE_RPC_URL: process.env.BASE_RPC_URL };

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const response = await handle(new Request(`http://localhost:${port}${req.url}`, {
    method: req.method, headers, ...(req.method === "POST" ? { body: Buffer.concat(chunks) } : {}),
  }), env);
  res.writeHead(response.status, { "content-type": "application/json" });
  res.end(await response.text());
}).listen(port, () => console.error(`SpendGuard backend (local, DEV_INSECURE) on http://localhost:${port}`));
