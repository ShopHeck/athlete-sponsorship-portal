#!/usr/bin/env bash
set -u

BASE="${1:-http://localhost:8890}"
PREVIEW_TOKEN="${PREVIEW_TOKEN:-devpreview}"
ADMIN_TOKEN="${ADMIN_TOKEN:-devtoken}"
MOCK_BASE="${MOCK_BASE:-http://127.0.0.1:4343}"
MOCK_LOG="${MOCK_LOG:-.netlify/mock-log.jsonl}"
PLATFORM_SECRET="${STRIPE_WEBHOOK_SECRET:-whsec_platform_test}"
CONNECT_SECRET="${STRIPE_CONNECT_WEBHOOK_SECRET:-whsec_connect_test}"
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

json_check() {
  local label="$1" file="$2" script="$3"
  if node -e "$script" "$file"; then
    echo "  ok   $label"
  else
    echo "  FAIL $label"
    FAIL=1
  fi
}

write_event() {
  printf '%s' "$1" > "$TMP_DIR/event.json"
}

signature() {
  node - "$1" "$2" "$3" <<'NODE'
const fs = require("fs");
const { createHmac } = require("crypto");
const [file, secret, timestamp] = process.argv.slice(2);
const raw = fs.readFileSync(file, "utf8");
const digest = createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");
process.stdout.write(`t=${timestamp},v1=${digest}`);
NODE
}

post_unsigned() {
  LAST_CODE=$(curl -sS -o "$TMP_DIR/response.json" -w '%{http_code}' -X POST "$BASE/api/stripe/webhook" \
    -H 'content-type: application/json' --data-binary @"$TMP_DIR/event.json")
  LAST_BODY=$(cat "$TMP_DIR/response.json")
}

post_signed() {
  local secret="$1" timestamp="$2" sig
  sig=$(signature "$TMP_DIR/event.json" "$secret" "$timestamp")
  LAST_CODE=$(curl -sS -o "$TMP_DIR/response.json" -w '%{http_code}' -X POST "$BASE/api/stripe/webhook" \
    -H 'content-type: application/json' -H "stripe-signature: $sig" --data-binary @"$TMP_DIR/event.json")
  LAST_BODY=$(cat "$TMP_DIR/response.json")
}

write_account_event() {
  node - "$1" "$2" "$3" "$4" <<'NODE'
const fs = require("fs");
const [file, type, accountId, tenant] = process.argv.slice(2);
const object = { id: accountId, metadata: { tenant } };
fs.writeFileSync(file, JSON.stringify({ type, livemode: false, account: accountId, data: { object } }));
NODE
}

write_invoice_event() {
  node - "$1" "$2" "$3" "$4" "$5" "$6" <<'NODE'
const fs = require("fs");
const [file, invoiceId, tenant, placement, hasAccount, accountId] = process.argv.slice(2);
const event = {
  type: "invoice.paid",
  livemode: false,
  data: {
    object: {
      id: invoiceId,
      number: `MOCK-${invoiceId}`,
      amount_paid: 150000,
      status_transitions: { paid_at: Math.floor(Date.now() / 1000) },
      metadata: { tenant, placement }
    }
  }
};
if (hasAccount === "yes") event.account = accountId;
fs.writeFileSync(file, JSON.stringify(event));
NODE
}

invoice_id() {
  node - "$MOCK_LOG" "$1" "$2" <<'NODE'
const fs = require("fs");
const [file, tenant, placement] = process.argv.slice(2);
const rows = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);
const index = rows.findIndex((row) =>
  row.method === "POST" && row.path === "/v1/invoices" &&
  row.body?.["metadata[tenant]"] === tenant &&
  row.body?.["metadata[placement]"] === placement
);
if (index < 0) process.exit(1);
process.stdout.write(`in_${index + 1}`);
NODE
}

paid_email_count() {
  node - "$MOCK_LOG" "$1" <<'NODE'
const fs = require("fs");
const [file, owner] = process.argv.slice(2);
const rows = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);
const count = rows.filter((row) =>
  row.path === "/emails" && row.body?.to?.includes(owner) && row.body?.subject?.includes("PAID")
).length;
process.stdout.write(String(count));
NODE
}

echo "1. method, signature, and livemode handling"
check "GET is rejected" "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/stripe/webhook")" "405"
write_event '{"id":"evt-test","type":"example.unknown","livemode":false,"data":{"object":{}}}'
post_unsigned
check "missing signature is rejected" "$LAST_CODE" "400"
if printf '%s' "$LAST_BODY" | grep -Fq '"error":"Invalid signature"'; then echo "  ok   missing signature error body"; else echo "  FAIL missing signature error body"; FAIL=1; fi
post_signed whsec_wrong "$(date +%s)"
check "wrong signature is rejected" "$LAST_CODE" "400"
OLD_TIMESTAMP=$(($(date +%s) - 600))
post_signed "$PLATFORM_SECRET" "$OLD_TIMESTAMP"
check "signature older than ten minutes is rejected" "$LAST_CODE" "400"
NOW=$(date +%s)
post_signed "$PLATFORM_SECRET" "$NOW"
check "platform endpoint secret is accepted" "$LAST_CODE" "200"
post_signed "$CONNECT_SECRET" "$NOW"
check "Connect endpoint secret is accepted" "$LAST_CODE" "200"
write_event '{"id":"evt-live","type":"example.live","livemode":true,"data":{"object":{}}}'
post_signed "$PLATFORM_SECRET" "$(date +%s)"
check "live event is ignored with test key" "$LAST_CODE" "200"
if printf '%s' "$LAST_BODY" | grep -Fq '"ignored":"livemode"'; then echo "  ok   live-mode guard response"; else echo "  FAIL live-mode guard response"; FAIL=1; fi

echo "2. Connect readiness refresh and account matching"
ONBOARD_CODE=$(curl -sS -o "$TMP_DIR/onboard.json" -w '%{http_code}' -X POST "$BASE/api/jordan-reyes/connect/onboard" \
  -H "authorization: Bearer $ADMIN_TOKEN")
check "Jordan can onboard" "$ONBOARD_CODE" "200"
ACCOUNT_ID=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).accountId||"")' "$TMP_DIR/onboard.json")
if [[ "$ACCOUNT_ID" == acct_mock_* ]]; then echo "  ok   mock connected account ID returned"; else echo "  FAIL mock connected account ID returned"; FAIL=1; fi
JORDAN_GET=$(curl -sS -H "x-preview-token: $PREVIEW_TOKEN" "$BASE/api/jordan-reyes/bids")
printf '%s' "$JORDAN_GET" > "$TMP_DIR/jordan-before.json"
json_check "Jordan starts not ready" "$TMP_DIR/jordan-before.json" 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(j.paymentsReady===false?0:1)'
check "mock readiness control succeeds" "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$MOCK_BASE/__mock/accounts/$ACCOUNT_ID/ready")" "200"
JORDAN_GET=$(curl -sS -H "x-preview-token: $PREVIEW_TOKEN" "$BASE/api/jordan-reyes/bids")
printf '%s' "$JORDAN_GET" > "$TMP_DIR/jordan-cached.json"
json_check "cached readiness remains false before webhook" "$TMP_DIR/jordan-cached.json" 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(j.paymentsReady===false?0:1)'
write_account_event "$TMP_DIR/account-event.json" "account.updated" "$ACCOUNT_ID" "jordan-reyes"
cp "$TMP_DIR/account-event.json" "$TMP_DIR/event.json"
post_signed "$CONNECT_SECRET" "$(date +%s)"
check "account.updated is handled" "$LAST_CODE" "200"
JORDAN_GET=$(curl -sS -H "x-preview-token: $PREVIEW_TOKEN" "$BASE/api/jordan-reyes/bids")
printf '%s' "$JORDAN_GET" > "$TMP_DIR/jordan-ready.json"
json_check "account.updated refreshes readiness immediately" "$TMP_DIR/jordan-ready.json" 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(j.paymentsReady===true?0:1)'
write_account_event "$TMP_DIR/event.json" "account.updated" "acct_wrong" "jordan-reyes"
post_signed "$CONNECT_SECRET" "$(date +%s)"
check "wrong account.updated is ignored" "$LAST_CODE" "200"
JORDAN_GET=$(curl -sS -H "x-preview-token: $PREVIEW_TOKEN" "$BASE/api/jordan-reyes/bids")
printf '%s' "$JORDAN_GET" > "$TMP_DIR/jordan-wrong-account.json"
json_check "wrong account does not change readiness" "$TMP_DIR/jordan-wrong-account.json" 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(j.paymentsReady===true?0:1)'

echo "3. paid invoices are recorded once and scoped to accounts"
JORDAN_LOCK='{"id":"TR-L1","type":"lock","amount":0,"company":"Webhook Jordan Co","name":"Jordan Tester","email":"webhook-jordan@example.test"}'
JORDAN_LOCK_CODE=$(curl -sS -o "$TMP_DIR/jordan-lock.json" -w '%{http_code}' -X POST "$BASE/api/jordan-reyes/bids" \
  -H 'content-type: application/json' -H "x-preview-token: $PREVIEW_TOKEN" -d "$JORDAN_LOCK")
check "Jordan lock creates an invoice" "$JORDAN_LOCK_CODE" "200"
JORDAN_INVOICE=$(invoice_id jordan-reyes TR-L1)
if [ -n "$JORDAN_INVOICE" ]; then echo "  ok   Jordan invoice ID found in mock log"; else echo "  FAIL Jordan invoice ID found in mock log"; FAIL=1; fi
write_invoice_event "$TMP_DIR/event.json" "$JORDAN_INVOICE" jordan-reyes TR-L1 yes "$ACCOUNT_ID"
post_signed "$CONNECT_SECRET" "$(date +%s)"
check "matching Connect invoice.paid is handled" "$LAST_CODE" "200"
JORDAN_GET=$(curl -sS -H "x-preview-token: $PREVIEW_TOKEN" "$BASE/api/jordan-reyes/bids")
printf '%s' "$JORDAN_GET" > "$TMP_DIR/jordan-paid.json"
json_check "public bid shows paid without payment details" "$TMP_DIR/jordan-paid.json" 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const p=j.placements["TR-L1"];process.exit(p?.paid===true&&!Object.hasOwn(p,"amountPaid")&&!Object.hasOwn(p,"contactEmail")?0:1)'
check "one paid owner email is sent" "$(paid_email_count jordan@example.test)" "1"
post_signed "$CONNECT_SECRET" "$(date +%s)"
check "replayed invoice.paid is handled" "$LAST_CODE" "200"
check "replay does not duplicate paid email" "$(paid_email_count jordan@example.test)" "1"

JORDAN_SECOND='{"id":"TR-L2","type":"lock","amount":0,"company":"Webhook Jordan Second Co","name":"Jordan Tester","email":"webhook-jordan-second@example.test"}'
SECOND_LOCK_CODE=$(curl -sS -o "$TMP_DIR/jordan-second-lock.json" -w '%{http_code}' -X POST "$BASE/api/jordan-reyes/bids" \
  -H 'content-type: application/json' -H "x-preview-token: $PREVIEW_TOKEN" -d "$JORDAN_SECOND")
check "second Jordan lock creates another invoice" "$SECOND_LOCK_CODE" "200"
SECOND_INVOICE=$(invoice_id jordan-reyes TR-L2)
write_invoice_event "$TMP_DIR/event.json" "$SECOND_INVOICE" jordan-reyes TR-L2 yes acct_wrong
post_signed "$CONNECT_SECRET" "$(date +%s)"
check "wrong-account invoice.paid is ignored" "$LAST_CODE" "200"
if printf '%s' "$LAST_BODY" | grep -Fq '"ignored":"account"'; then echo "  ok   wrong-account invoice response"; else echo "  FAIL wrong-account invoice response"; FAIL=1; fi
write_invoice_event "$TMP_DIR/event.json" in_wrong jordan-reyes TR-L2 yes "$ACCOUNT_ID"
post_signed "$CONNECT_SECRET" "$(date +%s)"
check "mismatched invoice ID is ignored" "$LAST_CODE" "200"
if printf '%s' "$LAST_BODY" | grep -Fq '"ignored":"invoice"'; then echo "  ok   mismatched invoice response"; else echo "  FAIL mismatched invoice response"; FAIL=1; fi
JORDAN_GET=$(curl -sS -H "x-preview-token: $PREVIEW_TOKEN" "$BASE/api/jordan-reyes/bids")
printf '%s' "$JORDAN_GET" > "$TMP_DIR/jordan-unpaid.json"
json_check "rejected Jordan events leave placement unpaid" "$TMP_DIR/jordan-unpaid.json" 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(j.placements["TR-L2"]?.paid===false?0:1)'

MICHAEL_LOCK='{"id":"SB-R1","type":"lock","amount":0,"company":"Webhook Michael Co","name":"Michael Tester","email":"webhook-michael@example.test"}'
MICHAEL_LOCK_CODE=$(curl -sS -o "$TMP_DIR/michael-lock.json" -w '%{http_code}' -X POST "$BASE/api/michael-heckert/bids" \
  -H 'content-type: application/json' -d "$MICHAEL_LOCK")
check "Michael platform lock creates an invoice" "$MICHAEL_LOCK_CODE" "200"
MICHAEL_INVOICE=$(invoice_id michael-heckert SB-R1)
write_invoice_event "$TMP_DIR/event.json" "$MICHAEL_INVOICE" michael-heckert SB-R1 yes acct_wrong
post_signed "$PLATFORM_SECRET" "$(date +%s)"
check "platform invoice event with account is ignored" "$LAST_CODE" "200"
if printf '%s' "$LAST_BODY" | grep -Fq '"ignored":"account"'; then echo "  ok   platform account mismatch response"; else echo "  FAIL platform account mismatch response"; FAIL=1; fi
write_invoice_event "$TMP_DIR/event.json" "$MICHAEL_INVOICE" michael-heckert SB-R1 no ""
post_signed "$PLATFORM_SECRET" "$(date +%s)"
check "platform invoice event without account is handled" "$LAST_CODE" "200"
MICHAEL_GET=$(curl -sS "$BASE/api/michael-heckert/bids")
printf '%s' "$MICHAEL_GET" > "$TMP_DIR/michael-paid.json"
json_check "Michael public bid shows paid" "$TMP_DIR/michael-paid.json" 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(j.placements["SB-R1"]?.paid===true?0:1)'

echo "4. deauthorization and unknown event handling"
write_account_event "$TMP_DIR/event.json" "account.application.deauthorized" "$ACCOUNT_ID" ""
post_signed "$CONNECT_SECRET" "$(date +%s)"
check "account deauthorization is handled" "$LAST_CODE" "200"
JORDAN_GET=$(curl -sS -H "x-preview-token: $PREVIEW_TOKEN" "$BASE/api/jordan-reyes/bids")
printf '%s' "$JORDAN_GET" > "$TMP_DIR/jordan-deauthorized.json"
json_check "deauthorized account is no longer ready" "$TMP_DIR/jordan-deauthorized.json" 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(j.paymentsReady===false?0:1)'
BLOCKED_CODE=$(curl -sS -o "$TMP_DIR/deauthorized-bid.json" -w '%{http_code}' -X POST "$BASE/api/jordan-reyes/bids" \
  -H 'content-type: application/json' -H "x-preview-token: $PREVIEW_TOKEN" \
  -d '{"id":"TR-R1","type":"bid","amount":250,"company":"Blocked Co","name":"Blocked Tester","email":"blocked@example.test"}')
check "bid is blocked after deauthorization" "$BLOCKED_CODE" "409"
JORDAN_GET=$(curl -sS -H "x-preview-token: $PREVIEW_TOKEN" "$BASE/api/jordan-reyes/bids")
if printf '%s' "$JORDAN_GET" | grep -q '"TR-R1"'; then echo "  FAIL deauthorized bid was not stored"; FAIL=1; else echo "  ok   deauthorized bid was not stored"; fi
write_event '{"id":"evt-future","type":"future.event.type","livemode":false,"data":{"object":{}}}'
post_signed "$PLATFORM_SECRET" "$(date +%s)"
check "unknown event type returns 200" "$LAST_CODE" "200"
if printf '%s' "$LAST_BODY" | grep -Fq '"ignored":"future.event.type"'; then echo "  ok   unknown event type is reported as ignored"; else echo "  FAIL unknown event type is reported as ignored"; FAIL=1; fi

if [ "$FAIL" -eq 0 ]; then
  echo "WEBHOOK TEST PASSED"
else
  echo "WEBHOOK TEST FAILED"
  exit 1
fi
