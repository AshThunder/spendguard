// Equivalent of `wrangler login` without installing wrangler: OAuth (PKCE) with wrangler's public
// client, callback on localhost:8976, tokens saved to ~/.config/.wrangler/config/default.toml.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const CONFIG = join(homedir(), ".config/.wrangler/config/default.toml");
const CLIENT_ID = "54d11594-84e4-41aa-b438-e81b8fa78ee7";
const REDIRECT = "http://localhost:8976/oauth/callback";
const DEFAULT_SCOPES = ["account:read", "user:read", "workers:write", "workers_scripts:write", "d1:write", "offline_access"];

const previous = existsSync(CONFIG) ? readFileSync(CONFIG, "utf8").match(/^scopes = \[(.*)\]/m)?.[1] : null;
const scopes = previous ? [...previous.matchAll(/"([^"]+)"/g)].map((m) => m[1]) : DEFAULT_SCOPES;

const b64url = (buf) => buf.toString("base64url");
const verifier = b64url(randomBytes(48));
const state = b64url(randomBytes(24));
const url = new URL("https://dash.cloudflare.com/oauth2/auth");
url.search = new URLSearchParams({
  response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT, scope: scopes.join(" "), state,
  code_challenge: b64url(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256",
}).toString();

const server = createServer(async (req, res) => {
  const q = new URL(req.url, REDIRECT).searchParams;
  if (!req.url.startsWith("/oauth/callback")) { res.writeHead(404).end(); return; }
  if (q.get("state") !== state || !q.get("code")) {
    res.writeHead(400).end("Login was not completed. You can close this tab.");
    console.error(`Login failed: ${q.get("error") ?? "state mismatch"}`);
    process.exit(1);
  }
  const tok = await fetch("https://dash.cloudflare.com/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: q.get("code"), client_id: CLIENT_ID, redirect_uri: REDIRECT, code_verifier: verifier }),
  });
  const body = await tok.json().catch(() => ({}));
  if (!tok.ok || !body.access_token) {
    res.writeHead(500).end("Token exchange failed. You can close this tab.");
    console.error(`Token exchange failed (HTTP ${tok.status}).`);
    process.exit(1);
  }
  mkdirSync(dirname(CONFIG), { recursive: true });
  writeFileSync(CONFIG, [
    `oauth_token = "${body.access_token}"`,
    `expiration_time = "${new Date(Date.now() + body.expires_in * 1000).toISOString()}"`,
    `refresh_token = "${body.refresh_token ?? ""}"`,
    `scopes = [ ${scopes.map((s) => `"${s}"`).join(", ")} ]`,
    "",
  ].join("\n"), { mode: 0o600 });
  res.writeHead(200, { "content-type": "text/plain" }).end("Cloudflare login complete. You can close this tab and return to Cursor.");
  console.error("Cloudflare login saved.");
  server.close();
  process.exit(0);
});

server.listen(8976, "localhost", () => {
  console.error(`Open this link to sign in to Cloudflare:\n${url}\n`);
  spawn("xdg-open", [url.toString()], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
});
setTimeout(() => { console.error("Timed out waiting for the browser login."); process.exit(1); }, 5 * 60_000);
