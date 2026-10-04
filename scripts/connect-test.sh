#!/usr/bin/env bash
set -u

BASE="${1:-http://localhost:8890}"
PREVIEW_TOKEN="${PREVIEW_TOKEN:-devpreview}"
ADMIN_TOKEN="${ADMIN_TOKEN:-devtoken}"
MOCK_BASE="${MOCK_BASE:-http://127.0.0.1:4343}"
MOCK_LOG="${MOCK_LOG:-.netlify/mock-log.jsonl}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
FAIL=0

check() {
  local label="$1" actual="$2" expected="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  ok   $label"
  else
    echo "  FAIL $label (expected $expected, got $actual)"
    FAIL=1
  fi
}

echo "1. payout readiness gates bidding"
JORDAN_GET=$(curl -sS -H "x-preview-token: $PREVIEW_TOKEN" "$BASE/api/jordan-reyes/bids")
if node -e 'const j=JSON.parse(process.argv[1]);process.exit(j.paymentsReady===false?0:1)' "$JORDAN_GET"; then
  echo "  ok   Jordan paymentsReady is false"
else
  echo "  FAIL Jordan paymentsReady is false"
  FAIL=1
fi
JORDAN_BODY='{"id":"TR-L1","type":"bid","amount":250,"company":"Connect Test Co","name":"Connect Tester","email":"connect-test@example.test"}'
JORDAN_CODE=$(curl -sS -o "$TMP_DIR/blocked.json" -w '%{http_code}' -X POST "$BASE/api/jordan-reyes/bids" -H 'content-type: application/json' -H "x-preview-token: $PREVIEW_TOKEN" -d "$JORDAN_BODY")
check "Jordan bid is blocked before payouts are ready" "$JORDAN_CODE" "409"
if grep -Fq "Jordan is finishing payout setup" "$TMP_DIR/blocked.json"; then echo "  ok   Jordan receives paymentsPending copy"; else echo "  FAIL Jordan receives paymentsPending copy"; FAIL=1; fi
JORDAN_GET=$(curl -sS -H "x-preview-token: $PREVIEW_TOKEN" "$BASE/api/jordan-reyes/bids")
if printf '%s' "$JORDAN_GET" | grep -q '"TR-L1"'; then echo "  FAIL rejected Jordan bid is not stored"; FAIL=1; else echo "  ok   rejected Jordan bid is not stored"; fi
FIXTURE_GET=$(curl -sS "$BASE/api/platform-fixture/bids")
if node -e 'const j=JSON.parse(process.argv[1]);process.exit(j.paymentsReady===true?0:1)' "$FIXTURE_GET"; then
  echo "  ok   platform fixture payments are ready"
else
  echo "  FAIL platform fixture payments are ready"
  FAIL=1
fi

echo "2. admin onboarding and route access"
check "onboard without auth is rejected" "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/jordan-reyes/connect/onboard")" "401"
check "onboard with wrong token is rejected" "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/jordan-reyes/connect/onboard" -H 'authorization: Bearer wrong')" "401"
check "unknown tenant is rejected" "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/nope/connect/onboard" -H "authorization: Bearer $ADMIN_TOKEN")" "404"
check "platform fixture is rejected" "$(curl -sS -o "$TMP_DIR/platform.json" -w '%{http_code}' -X POST "$BASE/api/platform-fixture/connect/onboard" -H "authorization: Bearer $ADMIN_TOKEN")" "400"
if grep -Fq "Tenant does not use Stripe Connect." "$TMP_DIR/platform.json"; then echo "  ok   platform fixture error is clear"; else echo "  FAIL platform fixture error is clear"; FAIL=1; fi

ONBOARD_CODE=$(curl -sS -o "$TMP_DIR/onboard.json" -w '%{http_code}' -X POST "$BASE/api/jordan-reyes/connect/onboard" -H "authorization: Bearer $ADMIN_TOKEN")
check "Jordan onboarding succeeds" "$ONBOARD_CODE" "200"
ACCOUNT_ID=$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).accountId||"")' "$TMP_DIR/onboard.json")
ONBOARD_URL=$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).url||"")' "$TMP_DIR/onboard.json")
if [[ "$ACCOUNT_ID" == acct_mock_* ]]; then echo "  ok   mock connected account ID returned"; else echo "  FAIL mock connected account ID returned"; FAIL=1; fi
if [[ "$ONBOARD_URL" == https://connect.stripe.com/setup/mock/* ]]; then echo "  ok   Stripe-hosted mock onboarding URL returned"; else echo "  FAIL Stripe-hosted mock onboarding URL returned"; FAIL=1; fi

if node - "$MOCK_LOG" "$ACCOUNT_ID" <<'NODE'
const fs = require("fs");
const [file, accountId] = process.argv.slice(2);
const rows = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);
const accounts = rows.filter((r) => r.method === "POST" && r.path === "/v1/accounts");
const links = rows.filter((r) => r.method === "POST" && r.path === "/v1/account_links");
const account = accounts[0];
const body = account?.body || {};
const required = {
  country: "US",
  "controller[fees][payer]": "account",
  "controller[losses][payments]": "stripe",
  "controller[requirement_collection]": "stripe",
  "controller[stripe_dashboard][type]": "full",
  "capabilities[card_payments][requested]": "true",
  "capabilities[transfers][requested]": "true",
  "metadata[tenant]": "jordan-reyes",
  "metadata[source]": "athlete-sponsorship-portal"
};
if (accounts.length !== 1 || account.idempotency !== "jordan-reyes-connect-account-standard" || body.country !== required.country) process.exit(1);
if (Object.entries(required).some(([key, value]) => body[key] !== value)) process.exit(1);
if (Object.hasOwn(body, "type") || Object.hasOwn(body, "business_profile[url]")) process.exit(1);
if (!links.length || links.some((row) => {
  const b = row.body || {};
  return b.account !== accountId || b.type !== "account_onboarding" ||
    !b.refresh_url?.includes("/api/jordan-reyes/connect/refresh?sig=") ||
    !b.return_url?.includes("/api/jordan-reyes/connect/return?sig=");
})) process.exit(1);
NODE
then
  echo "  ok   account creation and onboarding link parameters"
else
  echo "  FAIL account creation and onboarding link parameters"
  FAIL=1
fi

SECOND_CODE=$(curl -sS -o "$TMP_DIR/onboard-second.json" -w '%{http_code}' -X POST "$BASE/api/jordan-reyes/connect/onboard" -H "authorization: Bearer $ADMIN_TOKEN")
SECOND_ACCOUNT_ID=$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).accountId||"")' "$TMP_DIR/onboard-second.json")
check "second onboarding returns existing account" "$SECOND_ACCOUNT_ID" "$ACCOUNT_ID"
if node -e 'const fs=require("fs");const r=fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean).map(JSON.parse);process.exit(r.filter(x=>x.method==="POST"&&x.path==="/v1/accounts").length===1?0:1)' "$MOCK_LOG"; then
  echo "  ok   account creation remains idempotent"
else
  echo "  FAIL account creation remains idempotent"
  FAIL=1
fi

echo "3. status and signed onboarding callbacks"
STATUS_CODE=$(curl -sS -o "$TMP_DIR/status.json" -w '%{http_code}' "$BASE/api/jordan-reyes/connect/status" -H "authorization: Bearer $ADMIN_TOKEN")
check "Jordan status endpoint responds" "$STATUS_CODE" "200"
if node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(s.ready===false&&s.status.cardPayments==="inactive"&&s.status.currentlyDue.length>0?0:1)' "$TMP_DIR/status.json"; then
  echo "  ok   not-ready status includes outstanding requirements"
else
  echo "  FAIL not-ready status includes outstanding requirements"
  FAIL=1
fi
BAD_SIG_CODE=$(curl -sS -o "$TMP_DIR/bad-refresh.json" -w '%{http_code}' "$BASE/api/jordan-reyes/connect/refresh?sig=bad")
if [ "$BAD_SIG_CODE" = "403" ]; then
  echo "  ok   bad refresh signature is rejected"
elif [[ "$BAD_SIG_CODE" = "404" && "$BASE" =~ ^https?://(localhost|127\.0\.0\.1)(:[0-9]+)?/?$ ]] &&
     grep -Fq '"error":"Tenant not found."' "$TMP_DIR/bad-refresh.json"; then
  echo "  ok   bad refresh signature is rejected (Netlify Dev fallback after handler 403)"
else
  check "bad refresh signature is rejected" "$BAD_SIG_CODE" "403"
fi
GOOD_SIG=$(node - "$MOCK_LOG" <<'NODE'
const fs = require("fs");
const rows = fs.readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean).map(JSON.parse);
const row = rows.find((r) => r.path === "/v1/account_links");
process.stdout.write(new URL(row.body.refresh_url).searchParams.get("sig") || "");
NODE
)
REFRESH_CODE=$(curl -sS -D "$TMP_DIR/refresh.headers" -o /dev/null -w '%{http_code}' "$BASE/api/jordan-reyes/connect/refresh?sig=$GOOD_SIG")
check "valid refresh signature redirects" "$REFRESH_CODE" "302"
if grep -qi 'location: https://connect\.stripe\.com/setup/mock/' "$TMP_DIR/refresh.headers"; then echo "  ok   refresh creates a fresh Stripe link"; else echo "  FAIL refresh creates a fresh Stripe link"; FAIL=1; fi
RETURN_CODE=$(curl -sS -o "$TMP_DIR/return.html" -w '%{http_code}' "$BASE/api/jordan-reyes/connect/return?sig=$GOOD_SIG")
check "not-ready return page responds" "$RETURN_CODE" "200"
if grep -Fq "Stripe still needs more details" "$TMP_DIR/return.html" && grep -qi 'cache-control: no-store' <(curl -sS -D - -o /dev/null "$BASE/api/jordan-reyes/connect/return?sig=$GOOD_SIG"); then
  echo "  ok   return page explains missing details and is not cached"
else
  echo "  FAIL return page explains missing details and is not cached"
  FAIL=1
fi

READY_CODE=$(curl -sS -o "$TMP_DIR/mock-ready.json" -w '%{http_code}' -X POST "$MOCK_BASE/__mock/accounts/$ACCOUNT_ID/ready")
check "mock control marks account ready" "$READY_CODE" "200"
if node -e 'const fs=require("fs");const r=fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean).map(JSON.parse);process.exit(r.some(x=>x.path.startsWith("/__mock/"))?1:0)' "$MOCK_LOG"; then
  echo "  ok   mock control calls are not logged"
else
  echo "  FAIL mock control calls are not logged"
  FAIL=1
fi
STATUS_CODE=$(curl -sS -o "$TMP_DIR/status-ready.json" -w '%{http_code}' "$BASE/api/jordan-reyes/connect/status" -H "authorization: Bearer $ADMIN_TOKEN")
check "ready status endpoint responds" "$STATUS_CODE" "200"
if node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(s.ready===true&&s.status.cardPayments==="active"&&s.status.currentlyDue.length===0?0:1)' "$TMP_DIR/status-ready.json"; then
  echo "  ok   mock readiness transition is visible"
else
  echo "  FAIL mock readiness transition is visible"
  FAIL=1
fi
RETURN_CODE=$(curl -sS -o "$TMP_DIR/return-ready.html" -w '%{http_code}' "$BASE/api/jordan-reyes/connect/return?sig=$GOOD_SIG")
check "ready return page responds" "$RETURN_CODE" "200"
if grep -Fq "Sponsors can bid" "$TMP_DIR/return-ready.html"; then echo "  ok   ready return page confirms bidding can open"; else echo "  FAIL ready return page confirms bidding can open"; FAIL=1; fi

echo "4. direct-charge invoice behavior"
JORDAN_CODE=$(curl -sS -o "$TMP_DIR/jordan-bid.json" -w '%{http_code}' -X POST "$BASE/api/jordan-reyes/bids" -H 'content-type: application/json' -H "x-preview-token: $PREVIEW_TOKEN" -d "$JORDAN_BODY")
check "ready Jordan bid is accepted" "$JORDAN_CODE" "200"
JORDAN_LOCK='{"id":"TR-R1","type":"lock","amount":0,"company":"Jordan Lock Co","name":"Jordan Locker","email":"jordan-lock@example.test"}'
JORDAN_LOCK_CODE=$(curl -sS -o "$TMP_DIR/jordan-lock.json" -w '%{http_code}' -X POST "$BASE/api/jordan-reyes/bids" -H 'content-type: application/json' -H "x-preview-token: $PREVIEW_TOKEN" -d "$JORDAN_LOCK")
check "ready Jordan lock succeeds" "$JORDAN_LOCK_CODE" "200"
FIXTURE_LOCK='{"id":"SB-R1","type":"lock","amount":0,"company":"Fixture Lock Co","name":"Fixture Locker","email":"fixture-lock@example.test"}'
FIXTURE_LOCK_CODE=$(curl -sS -o "$TMP_DIR/fixture-lock.json" -w '%{http_code}' -X POST "$BASE/api/platform-fixture/bids" -H 'content-type: application/json' -d "$FIXTURE_LOCK")
check "platform fixture lock succeeds" "$FIXTURE_LOCK_CODE" "200"
if node - "$MOCK_LOG" "$ACCOUNT_ID" <<'NODE'
const fs = require("fs");
const [file, accountId] = process.argv.slice(2);
const rows = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);
const searches = rows.filter((r) => r.method === "GET" && r.path === "/v1/customers/search");
const customers = rows.filter((r) => r.method === "POST" && r.path === "/v1/customers");
const invoices = rows.filter((r) => r.method === "POST" && r.path === "/v1/invoices");
const invoiceItems = rows.filter((r) => r.method === "POST" && r.path === "/v1/invoiceitems");
const finalizes = rows.filter((r) => r.method === "POST" && /^\/v1\/invoices\/in_\d+\/finalize$/.test(r.path));
const jordan = invoices.find((r) => r.body?.["metadata[tenant]"] === "jordan-reyes");
const fixture = invoices.find((r) => r.body?.["metadata[tenant]"] === "platform-fixture");
const jordanCustomer = customers.find((r) => r.body?.["metadata[tenant]"] === "jordan-reyes");
const fixtureCustomer = customers.find((r) => r.body?.["metadata[tenant]"] === "platform-fixture");
const jordanItem = invoiceItems.find((r) => r.body?.["metadata[tenant]"] === "jordan-reyes");
const fixtureItem = invoiceItems.find((r) => r.body?.["metadata[tenant]"] === "platform-fixture");
if (searches.length !== 2 || !jordanCustomer || !fixtureCustomer || !jordan || !fixture ||
    !jordanItem || !fixtureItem || finalizes.length !== 2) process.exit(1);
if ([searches[0], jordanCustomer, jordan, jordanItem, finalizes[0]].some((r) => r.stripeAccount !== accountId)) process.exit(1);
if ([searches[1], fixtureCustomer, fixture, fixtureItem, finalizes[1]].some((r) => r.stripeAccount !== null)) process.exit(1);
if (jordan.body?.application_fee_amount !== "15000" ||
    jordan.body?.["metadata[connected_account]"] !== accountId ||
    jordan.body?.["metadata[platform_fee_percent]"] !== "10" ||
    Object.hasOwn(jordan.body || {}, "transfer_data[destination]")) process.exit(1);
if (Object.hasOwn(fixture.body || {}, "transfer_data[destination]") ||
    Object.hasOwn(fixture.body || {}, "application_fee_amount") ||
    Object.hasOwn(fixture.body || {}, "metadata[connected_account]") ||
    Object.hasOwn(fixture.body || {}, "metadata[platform_fee_percent]")) process.exit(1);
NODE
then
  echo "  ok   Connect Stripe calls are account-scoped with a 10% fee; fixture stays platform-only"
else
  echo "  FAIL Connect vs platform Stripe call parameters"
  FAIL=1
fi

if [ "$FAIL" -eq 0 ]; then
  echo "CONNECT TEST PASSED"
else
  echo "CONNECT TEST FAILED"
  exit 1
fi
