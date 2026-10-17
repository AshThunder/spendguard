import assert from "node:assert/strict";
import { test } from "node:test";

import { evmOutputSchema, proposeEvm } from "../src/paybox.js";
import { normalizeProposeInput, proposeInput } from "../src/tools/guard.js";

const session = "sgs_" + "a".repeat(24);
const decision = "dec_53789d80ab684199950e587c947ffbbc";

test("propose input keeps session and decision when the agent copies the whole allow result", () => {
  const parsed = proposeInput.parse({
    session_token: session,
    decision_id: decision,
    verdict: "allow",
    summary: "ok",
    wallet_id: "625b1843-f643-42f3-92e2-f22ea5e1bec2",
    explanation: { summary: "sends 1 USDC" },
  });
  assert.deepEqual(normalizeProposeInput(parsed), { session_token: session, decision_id: decision });
  assert.equal("verdict" in parsed, false);
});

test("propose input accepts camelCase aliases", () => {
  const parsed = proposeInput.parse({ sessionToken: session, decisionId: decision });
  assert.deepEqual(normalizeProposeInput(parsed), { session_token: session, decision_id: decision });
});

test("a USDC proposal matches the declared PayBox output schema", () => {
  const result = proposeEvm({
    chain: "eip155:8453",
    to: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    value: "0",
    data: "0x" + "ab".repeat(68),
  });
  const proposal = result.structuredContent["io.paybox/transactionProposal"];
  assert.equal(proposal.kind, "evm");
  assert.equal(proposal.transaction.to, "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
  assert.equal(proposal.transaction.value, "0");
  assert.match(proposal.expiresAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(evmOutputSchema.safeParse(result.structuredContent).success, true);
});
