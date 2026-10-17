// Runs scripts/deploy.sh using the existing `wrangler login` session (~/.config/.wrangler),
// refreshing its OAuth token the way wrangler does. Tokens are passed via env and never printed.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const CONFIG = join(homedir(), ".config/.wrangler/config/default.toml");
const CLIENT_ID = "54d11594-84e4-41aa-b438-e81b8fa78ee7";

let toml = readFileSync(CONFIG, "utf8");
const get = (k) => toml.match(new RegExp(`^${k} = "([^"]*)"`, "m"))?.[1];

let token = get("oauth_token");
if (!token || Date.parse(get("expiration_time") ?? "") < Date.now() + 60_000) {
  const res = await fetch("https://dash.cloudflare.com/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: get("refresh_token") ?? "", client_id: CLIENT_ID }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    console.error(`Could not refresh the wrangler login (HTTP ${res.status}). Run "npx wrangler login" once, then retry.`);
    process.exit(1);
  }
  token = body.access_token;
  const set = (k, v) => { toml = toml.replace(new RegExp(`^${k} = "[^"]*"`, "m"), `${k} = "${v}"`); };
  set("oauth_token", token);
  if (body.refresh_token) set("refresh_token", body.refresh_token);
  set("expiration_time", new Date(Date.now() + body.expires_in * 1000).toISOString());
  writeFileSync(CONFIG, toml, { mode: 0o600 });
  console.error("Refreshed the wrangler login.");
}

let accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!accountId) {
  const res = await fetch("https://api.cloudflare.com/client/v4/accounts", { headers: { authorization: `Bearer ${token}` } });
  const body = await res.json();
  if (!body.success || body.result.length === 0) {
    console.error(`Could not list Cloudflare accounts: ${JSON.stringify(body.errors ?? [])}`);
    process.exit(1);
  }
  if (body.result.length > 1) {
    console.error(`Several accounts found; set CLOUDFLARE_ACCOUNT_ID to one of: ${body.result.map((a) => `${a.id} (${a.name})`).join(", ")}`);
    process.exit(1);
  }
  accountId = body.result[0].id;
  console.error(`Using Cloudflare account ${body.result[0].name}.`);
}

const run = spawnSync("bash", [join(dirname(new URL(import.meta.url).pathname), "deploy.sh")], {
  stdio: "inherit",
  env: { ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId },
});
process.exit(run.status ?? 1);
