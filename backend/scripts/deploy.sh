#!/usr/bin/env bash
# Deploys the SpendGuard backend with the Cloudflare API (no wrangler needed).
# Requires: CLOUDFLARE_API_TOKEN (Workers Scripts:Edit, D1:Edit) and CLOUDFLARE_ACCOUNT_ID.
# The owner key is generated once into .owner-key and is never printed.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"
NAME="${WORKER_NAME:-spendguard}"
API="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}"
AUTH=(-H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}")

cf() { curl -fsS "${AUTH[@]}" "$@"; }
field() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);if(!j.success){console.error(JSON.stringify(j.errors));process.exit(1)};const v=($1)(j.result);process.stdout.write(v==null?'':String(v))})"; }

[ -f dist/worker.js ] || { echo "run pnpm build first" >&2; exit 1; }

if [ ! -s .owner-key ]; then
  umask 077
  openssl rand -hex 32 > .owner-key
  echo "Generated a new owner key in backend/.owner-key (not printed)." >&2
fi

DB_ID=$(cf "${API}/d1/database?name=spendguard" | field 'r=>(r.find(d=>d.name==="spendguard")||{}).uuid')
if [ -z "$DB_ID" ]; then
  DB_ID=$(cf -X POST "${API}/d1/database" -H "content-type: application/json" -d '{"name":"spendguard"}' | field 'r=>r.uuid')
  echo "Created D1 database spendguard (${DB_ID})." >&2
fi
SQL=$(node -e 'process.stdout.write(JSON.stringify({sql:require("fs").readFileSync("schema.sql","utf8")}))')
cf -X POST "${API}/d1/database/${DB_ID}/query" -H "content-type: application/json" -d "$SQL" > /dev/null
echo "Schema applied." >&2

METADATA=$(DB_ID="$DB_ID" node -e '
const key = require("fs").readFileSync(".owner-key", "utf8").trim();
process.stdout.write(JSON.stringify({
  main_module: "worker.js",
  compatibility_date: "2026-10-01",
  bindings: [
    { type: "d1", name: "DB", id: process.env.DB_ID },
    { type: "plain_text", name: "BASE_RPC_URL", text: process.env.BASE_RPC_URL || "https://mainnet.base.org" },
    { type: "secret_text", name: "OWNER_KEY", text: key },
  ],
}));')
cf -X PUT "${API}/workers/scripts/${NAME}" \
  -F "metadata=${METADATA};type=application/json" \
  -F "worker.js=@dist/worker.js;type=application/javascript+module" > /dev/null
cf -X POST "${API}/workers/scripts/${NAME}/subdomain" -H "content-type: application/json" -d '{"enabled":true}' > /dev/null
SUB=$(cf "${API}/workers/subdomain" | field 'r=>r.subdomain')
URL="https://${NAME}.${SUB}.workers.dev"
echo "Deployed ${URL}" >&2
curl -fsS "${URL}/health" && echo
echo "Portal settings: SPENDGUARD_BACKEND_URL=${URL}; network host ${NAME}.${SUB}.workers.dev; secret header Authorization = 'Bearer ' + contents of backend/.owner-key" >&2
