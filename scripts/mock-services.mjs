// Local stand-in for Stripe + Resend so the bidding flow can be exercised end to end
// without creating real invoices or sending real email.
//
//   node scripts/mock-services.mjs                # listens on :4242, logs to .netlify/mock-log.jsonl
//   FAIL_INVOICE=1 node scripts/mock-services.mjs # every invoice creation fails (tests the retry path)
//
// Point the functions at it with STRIPE_API_BASE / RESEND_API_BASE (see scripts/smoke-test.sh).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.MOCK_PORT) || 4242;
const LOG = process.env.MOCK_LOG || path.join(".netlify", "mock-log.jsonl");
const FAIL_INVOICE = process.env.FAIL_INVOICE === "1";
fs.mkdirSync(path.dirname(LOG), { recursive: true });
fs.writeFileSync(LOG, "");
let n = 0;
const accounts = new Map();

http.createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const url = new URL(req.url, "http://mock");
  const send = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  const readyControl = url.pathname.match(/^\/__mock\/accounts\/([^/]+)\/ready$/);
  if (req.method === "POST" && readyControl) {
    const account = accounts.get(decodeURIComponent(readyControl[1]));
    if (!account) return send(404, { error: "mock: unknown account" });
    account.charges_enabled = true;
    account.payouts_enabled = true;
    account.details_submitted = true;
    account.capabilities.card_payments = "active";
    account.capabilities.transfers = "active";
    account.requirements.currently_due = [];
    account.requirements.disabled_reason = null;
    return send(200, account);
  }
  const body = (req.headers["content-type"] || "").includes("json") ? JSON.parse(raw || "{}") : Object.fromEntries(new URLSearchParams(raw));
  fs.appendFileSync(LOG, JSON.stringify({
    at: new Date().toISOString(),
    method: req.method,
    path: url.pathname,
    idempotency: req.headers["idempotency-key"] || null,
    stripeAccount: req.headers["stripe-account"] || null,
    body
  }) + "\n");
  n += 1;
  // Resend
  if (url.pathname === "/emails") return send(200, { id: `email_${n}` });
  // Stripe
  if (req.method === "POST" && url.pathname === "/v1/accounts") {
    const account = {
      id: `acct_mock_${n}`,
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: false,
      capabilities: { card_payments: "inactive", transfers: "inactive" },
      requirements: { currently_due: ["external_account"], disabled_reason: "requirements.past_due" }
    };
    accounts.set(account.id, account);
    return send(200, account);
  }
  const accountMatch = url.pathname.match(/^\/v1\/accounts\/([^/]+)$/);
  if (req.method === "GET" && accountMatch) {
    const account = accounts.get(decodeURIComponent(accountMatch[1]));
    return account ? send(200, account) : send(404, { error: { message: "mock: unknown account" } });
  }
  if (req.method === "POST" && url.pathname === "/v1/account_links") {
    return send(200, { url: `https://connect.stripe.com/setup/mock/${n}`, expires_at: Math.floor(Date.now() / 1000) + 3600 });
  }
  if (url.pathname === "/v1/customers/search") return send(200, { data: [] });
  if (url.pathname === "/v1/customers") return send(200, { id: `cus_${n}`, email: body.email });
  if (url.pathname === "/v1/invoices") return FAIL_INVOICE ? send(400, { error: { message: "Mock failure: invoice creation disabled" } }) : send(200, { id: `in_${n}`, status: "draft" });
  if (url.pathname === "/v1/invoiceitems") return send(200, { id: `ii_${n}` });
  const finalize = url.pathname.match(/^\/v1\/invoices\/(in_\d+)\/finalize$/);
  if (finalize) return send(200, { id: finalize[1], number: `MOCK-${String(n).padStart(4, "0")}`, status: "open", hosted_invoice_url: `https://invoice.stripe.com/i/mock/${finalize[1]}`, invoice_pdf: `https://pay.stripe.com/invoice/mock/${finalize[1]}/pdf` });
  send(404, { error: { message: `mock: unknown ${req.method} ${url.pathname}` } });
}).listen(PORT, () => console.log(`mock Stripe + Resend listening on :${PORT} — log: ${LOG}`));
