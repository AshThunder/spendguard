import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { evmOutputSchema, x402OutputSchema } from "./paybox.js";
import { explanationSchema } from "./tools/common.js";
import {
  auditInput, auditLog, checkInput, checkOutput, checkPayment, confirmOverride, explainInput, explainTransaction,
  overrideInput, proposeInput, proposeUsdcTransfer, proposeX402Payment, reportInput, reportStatus,
} from "./tools/guard.js";
import { rules, rulesInput, runDueInput, runDueRules } from "./tools/rules.js";
import { session, sessionInput } from "./tools/session.js";

const PROTOCOL_VERSION = "2026-07-28";
const UNVERIFIED = "Explanations are SpendGuard's own decoding, not verified by PayBox.";

function createServer() {
  const server = new McpServer(
    { name: "spendguard", version: "0.1.0" },
    { supportedProtocolVersions: [PROTOCOL_VERSION] },
  );

  server.registerTool("check_payment", {
    title: "Check a payment before making it",
    description:
      "SpendGuard, the safety layer between agents and money. Call this before every payment or retry on Base. It explains what the payment does, applies spending limits, and blocks duplicates, payments still settling, and retry loops. Returns allow (with a single-use decision_id), pause, or block with plain-English reasons. " +
      `Use dry_run to evaluate without a session or stored state. ${UNVERIFIED}`,
    inputSchema: checkInput,
    outputSchema: checkOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, checkPayment);

  server.registerTool("explain_transaction", {
    title: "Explain a transaction in plain English",
    description:
      "Decodes an EVM call on Base (native ETH, ERC-20 transfer, approve, transferFrom, allowance changes) or an x402 request, and flags risks such as unlimited approvals. Works on proposals from any plugin. Read-only. " + UNVERIFIED,
    inputSchema: explainInput,
    outputSchema: explanationSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, explainTransaction);

  server.registerTool("propose_usdc_transfer", {
    title: "Propose an approved USDC transfer",
    description:
      "Turns an allow decision from check_payment into one unsigned Base USDC transfer proposal. Pass propose_arguments from that allow result (session_token and decision_id only). The decision is single-use. The result includes structuredContent[\"io.paybox/transactionProposal\"] with to, value, data, chain, and expiresAt. PayBox handles wallet selection, approval and signing. Submit the proposal once, then poll get_request and call report_status.",
    inputSchema: proposeInput,
    outputSchema: evmOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, proposeUsdcTransfer);

  server.registerTool("propose_x402", {
    title: "Propose an approved x402 payment",
    description:
      "Turns an allow decision for an x402 payment into one PayBox x402 proposal (USDC on Base). Pass propose_arguments from that allow result (session_token and decision_id only). The decision is single-use. Poll the PayBox request it creates and call report_status.",
    inputSchema: proposeInput,
    outputSchema: x402OutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, proposeX402Payment);

  server.registerTool("report_status", {
    title: "Report a PayBox request status",
    description:
      "Tell SpendGuard what get_request returned for a payment. Call it when the status changes, not on every poll. On success with a tx_hash, SpendGuard reads the receipt and reports whether the observed token movement matches its decoding.",
    inputSchema: reportInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, reportStatus);

  server.registerTool("confirm_override", {
    title: "Confirm a wallet-signed override",
    description:
      "After a pause or overridable block, and only if the user wants to proceed: submit the signature of override_challenge.typed_data (from PayBox request_wallet_sign). Unlocks one retry of that exact payment. Hard limits and duplicates are never overridable.",
    inputSchema: overrideInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, confirmOverride);

  server.registerTool("session", {
    title: "Start or end a SpendGuard session",
    description:
      "start returns a message for the wallet to sign with PayBox request_wallet_sign; complete exchanges the signature for a 24-hour session_token bound to that wallet; revoke ends it. Sessions keep each wallet's rules, attempts and audit log private to that wallet. They cannot move funds.",
    inputSchema: sessionInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, session);

  server.registerTool("audit_log", {
    title: "Read or verify the audit log",
    description: "Lists SpendGuard decisions for this wallet (allowed, paused, blocked, with reasons), or verifies that the hash-chained log is intact.",
    inputSchema: auditInput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, auditLog);

  server.registerTool("rules", {
    title: "Manage recurring and goal rules",
    description:
      "Create, list, pause, resume or revoke simple USDC rules: weekly, every N days, save toward a goal, or sweep a percentage above a threshold. Rules never pay on their own; run_due_rules checks them through the Spend Guard.",
    inputSchema: rulesInput,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, rules);

  server.registerTool("run_due_rules", {
    title: "Run the next due rule through the Spend Guard",
    description:
      "Finds the next due rule, works out the amount (reading balances on Base for goals and sweeps), and runs check_payment for it. Each schedule slot can pay at most once. On allow, call propose_usdc_transfer with the decision_id.",
    inputSchema: runDueInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, runDueRules);

  return server;
}

serveStdio(createServer, { legacy: "reject" });
