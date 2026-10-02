#!/usr/bin/env bash
# End-to-end smoke test of the bidding API against a local `netlify dev` that is pointed at
# scripts/mock-services.mjs. Nothing real is created. Works with macOS bash 3.2.
#
#   Build the selected tenant first: npm run build (or PORTAL_CONFIG=examples/demo-athlete.json npm run build)
#   Terminal 1:  node scripts/mock-services.mjs
#   Terminal 2:  STRIPE_SECRET_KEY=sk_test_mock STRIPE_API_BASE=http://127.0.0.1:4242 \
#                RESEND_API_KEY=re_mock RESEND_API_BASE=http://127.0.0.1:4242 \
#                NOTIFY_EMAIL=owner@example.test PORTAL_URL=http://localhost:8888 ADMIN_TOKEN=devtoken \
#                npx netlify dev --offline --port 8888
#   Terminal 3:  scripts/smoke-test.sh [base-url] [open-placement-A] [open-placement-B]
#
# Pick two placements defined in the selected config, absent from its `sold` map, and with no record in
# the local Blobs sandbox (delete .netlify/blobs-serve to reset). Exit code is non-zero on any failed expectation.
set -u
BASE="${1:-http://localhost:8888}"; A="${2:-SB-R1}"; B="${3:-TF-12}"; TOKEN="${ADMIN_TOKEN:-devtoken}"
fail=0

json() { printf '{"id":"%s","type":"%s","amount":%s,"company":"%s","name":"%s","email":"%s","phone":"%s"}' "$1" "$2" "$3" "$4" "$5" "$6" "${7:-}"; }
post() { curl -s -X POST "$BASE/api/bids" -H 'content-type: application/json' -d "$1"; }
expect() { # label, output, needle
  if printf '%s' "$2" | grep -q -- "$3"; then echo "  ok   $1"; else echo "  FAIL $1 → $2"; fail=1; fi
}
bid() { # label, needle, id, type, amount, company, name, email [, phone]
  local label="$1" needle="$2"; shift 2
  local payload out
  payload=$(json "$@")
  out=$(post "$payload")
  expect "$label" "$out" "$needle"
  LAST="$out"
}

echo "1. bids"
bid "opening bid accepted"        '"high":500'            "$A" bid 500 Acme Ann ann@acme.test
bid "higher bid outbids"          '"high":600'            "$A" bid 600 Bolt Bo bo@bolt.test
bid "below-floor bid rejected"    'Bid must be at least'  "$A" bid 620 X Y x@y.test
bid "bad email rejected"          'valid email'           "$A" bid 700 X Y nope
bid "unknown placement rejected"  'Unknown placement'     ZZ-99 bid 700 X Y x@y.test
echo "2. lock"
bid "lock succeeds"               '"locked":true'         "$A" lock 0 Cobra Cy cy@cobra.test 555-0100
expect "lock returns invoice url" "$LAST" '"invoiceUrl":"https://invoice.stripe.com'
bid "bid on locked rejected"      'locked by another sponsor' "$A" bid 900 X Y x@y.test
bid "bid at lock price auto-locks" '"locked":true'        "$B" bid 2500 Delta Dee dee@delta.test
expect "auto-lock also invoiced"  "$LAST" '"invoiceUrl":"https://invoice.stripe.com'
echo "3. public view"
GET=$(curl -s "$BASE/api/bids")
expect "GET lists placement"       "$GET" "\"$A\""
expect "GET hides contact details" "$(printf '%s' "$GET" | grep -c 'cy@cobra.test')" '^0$'
echo "4. admin close"
expect "close without token → 401" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/close-auction")" '^401$'
expect "close with token runs"     "$(curl -s -X POST -H "authorization: Bearer $TOKEN" "$BASE/api/close-auction")" '"pastDeadline"'
echo "5. mock traffic"
LOG="${MOCK_LOG:-.netlify/mock-log.jsonl}"
if [ -f "$LOG" ]; then
  expect "Stripe invoices finalized (2)" "$(grep -c '/finalize' "$LOG")" '^2$'
  expect "sponsor invoice email sent"    "$(grep -c '"to":\["cy@cobra.test"\]' "$LOG")" '^[1-9]'
  expect "bid confirmation email sent"   "$(grep -c '"to":\["ann@acme.test"\]' "$LOG")" '^[1-9]'
  expect "outbid email sent"             "$(grep -c "You've been outbid" "$LOG")" '^[1-9]'
  expect "owner notified"                "$(grep -c '\[Sponsorship\]' "$LOG")" '^[1-9]'
  echo; echo "  Email subjects:"
  node -e 'const fs=require("fs");for(const l of fs.readFileSync(process.argv[1],"utf8").trim().split("\n").filter(Boolean)){const r=JSON.parse(l);if(r.path==="/emails")console.log("   ",r.body.to.join(","),"←",r.body.subject)}' "$LOG"
else
  echo "  (no mock log at $LOG — is scripts/mock-services.mjs running from the repo root?)"
fi
echo
if [ "$fail" -eq 0 ]; then echo "SMOKE TEST PASSED"; else echo "SMOKE TEST FAILED"; exit 1; fi
