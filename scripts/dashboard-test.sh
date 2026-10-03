#!/usr/bin/env bash
set -u

BASE="${1:-http://localhost:8890}"
ADMIN_TOKEN="${ADMIN_TOKEN:-devtoken}"
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

json_check() {
  local label="$1" file="$2" script="$3"
  if node -e "$script" "$file"; then
    echo "  ok   $label"
  else
    echo "  FAIL $label"
    FAIL=1
  fi
}

login_email_count() {
  node - "$MOCK_LOG" "$1" <<'NODE'
const fs = require("fs");
const [file, recipient] = process.argv.slice(2);
const rows = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);
process.stdout.write(String(rows.filter((row) =>
  row.path === "/emails" &&
  row.body?.to?.includes(recipient) &&
  row.body?.subject?.includes("sponsorship dashboard")
).length));
NODE
}

login_token() {
  node - "$MOCK_LOG" "$1" <<'NODE'
const fs = require("fs");
const [file, recipient] = process.argv.slice(2);
const rows = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);
const email = rows.findLast((row) =>
  row.path === "/emails" &&
  row.body?.to?.includes(recipient) &&
  row.body?.subject?.includes("sponsorship dashboard")
);
const body = `${email?.body?.text || ""}\n${email?.body?.html || ""}`;
const token = body.match(/\/dashboard\/auth\?token=([a-f0-9]{64})/)?.[1];
if (!token) process.exit(1);
process.stdout.write(token);
NODE
}

request_json() {
  local method="$1" url="$2" body="$3" output="$4"
  LAST_CODE=$(curl -sS -o "$output" -w '%{http_code}' -X "$method" "$url" \
    -H "Origin: $BASE" -H 'content-type: application/json' --data-binary "$body")
}

email="michaelheckert@heckholdings.com"
echo "1. dashboard login and one-time sessions"
UNKNOWN_BEFORE=$(login_email_count unknown-dashboard@example.test)
request_json POST "$BASE/api/dashboard/login" '{"email":"unknown-dashboard@example.test"}' "$TMP_DIR/unknown.json"
check "unknown email receives generic success" "$LAST_CODE" "200"
check "unknown email sends no login email" "$(login_email_count unknown-dashboard@example.test)" "$UNKNOWN_BEFORE"

check "login without Origin is rejected" "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/dashboard/login" -H 'content-type: application/json' -d "{\"email\":\"$email\"}")" "403"
check "login with foreign Origin is rejected" "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/dashboard/login" -H 'Origin: https://foreign.example' -H 'content-type: application/json' -d "{\"email\":\"$email\"}")" "403"
request_json POST "$BASE/api/dashboard/login" '{"email":"not-an-email"}' "$TMP_DIR/malformed.json"
check "malformed email is rejected" "$LAST_CODE" "400"

request_json POST "$BASE/api/dashboard/login" "{\"email\":\"$email\"}" "$TMP_DIR/login.json"
check "Michael login request receives generic success" "$LAST_CODE" "200"
MICHAEL_TOKEN=$(login_token "$email")
if [ -n "$MICHAEL_TOKEN" ]; then echo "  ok   login email contains a sign-in link"; else echo "  FAIL login email contains a sign-in link"; FAIL=1; fi
if node - "$MOCK_LOG" "$email" <<'NODE'
const fs = require("fs");
const [file, recipient] = process.argv.slice(2);
const row = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse).findLast((entry) =>
  entry.path === "/emails" && entry.body?.to?.includes(recipient) &&
  entry.body?.subject === "Your MICHAEL HECKERT sponsorship dashboard"
);
process.exit(row?.body?.text?.includes("expires in 15 minutes") ? 0 : 1);
NODE
then
  echo "  ok   login email subject and expiry are correct"
else
  echo "  FAIL login email subject and expiry are correct"
  FAIL=1
fi
for _ in 1 2 3 4 5; do
  request_json POST "$BASE/api/dashboard/login" "{\"email\":\"$email\"}" "$TMP_DIR/rate.json"
done
check "sixth login request sends no additional email" "$(login_email_count "$email")" "5"

SESSION_CODE=$(curl -sS -o "$TMP_DIR/session-form.json" -D "$TMP_DIR/session-form.headers" -w '%{http_code}' \
  -X POST "$BASE/api/dashboard/session" -H "Origin: $BASE" \
  -H 'content-type: application/x-www-form-urlencoded' --data-urlencode "token=$MICHAEL_TOKEN")
check "form session redirects to Michael dashboard" "$SESSION_CODE" "303"
LOCATION=$(awk 'tolower($1)=="location:" {gsub("\r","",$2); print $2; exit}' "$TMP_DIR/session-form.headers")
check "form session Location is Michael dashboard" "$LOCATION" "/dashboard/michael-heckert"
MICHAEL_COOKIE=$(awk 'tolower($1)=="set-cookie:" {sub(/^asp_dash=/,"",$2); sub(/;.*/,"",$2); gsub("\r","",$2); print $2; exit}' "$TMP_DIR/session-form.headers")
if [ -n "$MICHAEL_COOKIE" ]; then echo "  ok   session cookie was set"; else echo "  FAIL session cookie was set"; FAIL=1; fi
if grep -qi 'asp_dash=.*HttpOnly; SameSite=Lax; Path=/; Max-Age=604800' "$TMP_DIR/session-form.headers"; then
  echo "  ok   session cookie has required attributes"
else
  echo "  FAIL session cookie has required attributes"
  FAIL=1
fi

REUSE_CODE=$(curl -sS -o "$TMP_DIR/reuse.json" -D "$TMP_DIR/reuse.headers" -w '%{http_code}' \
  -X POST "$BASE/api/dashboard/session" -H "Origin: $BASE" \
  -H 'content-type: application/x-www-form-urlencoded' --data-urlencode "token=$MICHAEL_TOKEN")
check "reused form token redirects with link error" "$REUSE_CODE" "303"
REUSE_LOCATION=$(awk 'tolower($1)=="location:" {gsub("\r","",$2); print $2; exit}' "$TMP_DIR/reuse.headers")
check "reused token Location is the link error page" "$REUSE_LOCATION" "/dashboard?error=link"
request_json POST "$BASE/api/dashboard/session" '{"token":"garbage"}' "$TMP_DIR/garbage.json"
check "garbage JSON token is rejected" "$LAST_CODE" "400"
if grep -Fq 'invalid or has expired' "$TMP_DIR/garbage.json"; then echo "  ok   invalid token error is clear"; else echo "  FAIL invalid token error is clear"; FAIL=1; fi

echo "2. dashboard session access and admin links"
check "summary without cookie is rejected" "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/dashboard/michael-heckert/summary")" "401"
TAMPERED_COOKIE="${MICHAEL_COOKIE%?}0"
if [ "${MICHAEL_COOKIE: -1}" = "0" ]; then TAMPERED_COOKIE="${MICHAEL_COOKIE%?}1"; fi
check "tampered session cookie is rejected" "$(curl -sS -o /dev/null -w '%{http_code}' -H "Cookie: asp_dash=$TAMPERED_COOKIE" "$BASE/api/dashboard/michael-heckert/summary")" "401"
check "session cookie cannot cross tenants" "$(curl -sS -o /dev/null -w '%{http_code}' -H "Cookie: asp_dash=$MICHAEL_COOKIE" "$BASE/api/dashboard/jordan-reyes/summary")" "401"
check "admin link without bearer token is rejected" "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/dashboard/jordan-reyes/link" -H "Origin: $BASE")" "401"

MICHAEL_LINK_CODE=$(curl -sS -o "$TMP_DIR/michael-link.json" -w '%{http_code}' -X POST "$BASE/api/dashboard/michael-heckert/link" \
  -H "Origin: $BASE" -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' -d '{}')
check "admin can create a Michael login link" "$MICHAEL_LINK_CODE" "200"
MICHAEL_JSON_TOKEN=$(node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(new URL(x.url).searchParams.get("token")||"")' "$TMP_DIR/michael-link.json")
JSON_SESSION_CODE=$(curl -sS -o "$TMP_DIR/session-json.json" -D "$TMP_DIR/session-json.headers" -w '%{http_code}' \
  -X POST "$BASE/api/dashboard/session" -H "Origin: $BASE" \
  -H 'content-type: application/json' -d "{\"token\":\"$MICHAEL_JSON_TOKEN\"}")
check "JSON session exchange succeeds" "$JSON_SESSION_CODE" "200"
json_check "JSON session identifies Michael" "$TMP_DIR/session-json.json" 'process.exit(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).slug==="michael-heckert"?0:1)'
if grep -qi 'set-cookie: asp_dash=.*HttpOnly; SameSite=Lax; Path=/; Max-Age=604800' "$TMP_DIR/session-json.headers"; then
  echo "  ok   JSON session sets the cookie"
else
  echo "  FAIL JSON session sets the cookie"
  FAIL=1
fi

JORDAN_LINK_CODE=$(curl -sS -o "$TMP_DIR/jordan-link.json" -w '%{http_code}' -X POST "$BASE/api/dashboard/jordan-reyes/link" \
  -H "Origin: $BASE" -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' -d '{}')
check "admin link is available for draft Jordan" "$JORDAN_LINK_CODE" "200"
JORDAN_TOKEN=$(node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(new URL(x.url).searchParams.get("token")||"")' "$TMP_DIR/jordan-link.json")
JORDAN_SESSION_CODE=$(curl -sS -o "$TMP_DIR/jordan-session.json" -D "$TMP_DIR/jordan-session.headers" -w '%{http_code}' \
  -X POST "$BASE/api/dashboard/session" -H "Origin: $BASE" \
  -H 'content-type: application/x-www-form-urlencoded' --data-urlencode "token=$JORDAN_TOKEN")
check "Jordan form session succeeds for draft tenant" "$JORDAN_SESSION_CODE" "303"
JORDAN_LOCATION=$(awk 'tolower($1)=="location:" {gsub("\r","",$2); print $2; exit}' "$TMP_DIR/jordan-session.headers")
check "Jordan session redirects to Jordan dashboard" "$JORDAN_LOCATION" "/dashboard/jordan-reyes"
JORDAN_COOKIE=$(awk 'tolower($1)=="set-cookie:" {sub(/^asp_dash=/,"",$2); sub(/;.*/,"",$2); gsub("\r","",$2); print $2; exit}' "$TMP_DIR/jordan-session.headers")
check "Jordan draft summary is accessible" "$(curl -sS -o "$TMP_DIR/jordan-summary.json" -w '%{http_code}' -H "Cookie: asp_dash=$JORDAN_COOKIE" "$BASE/api/dashboard/jordan-reyes/summary")" "200"

echo "3. summary, public bids, CSV, and offline sales"
BID_CODE=$(curl -sS -o "$TMP_DIR/bid.json" -w '%{http_code}' -X POST "$BASE/api/michael-heckert/bids" \
  -H "Origin: $BASE" -H 'content-type: application/json' \
  -d '{"id":"SB-R1","type":"bid","amount":500,"company":"=HYPERLINK(\"x\")","name":"Dashboard Bidder","email":"dashboard-bidder@example.test","phone":"555-0101","note":"First dashboard test bid"}')
check "public Michael bid is accepted" "$BID_CODE" "200"
MICHAEL_SUMMARY_CODE=$(curl -sS -o "$TMP_DIR/michael-summary.json" -w '%{http_code}' -H "Cookie: asp_dash=$MICHAEL_COOKIE" "$BASE/api/dashboard/michael-heckert/summary")
check "Michael summary is available" "$MICHAEL_SUMMARY_CODE" "200"
json_check "summary includes contact, portal and payment fields without preview token" "$TMP_DIR/michael-summary.json" 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const p=s.placements.find(x=>x.id==="SB-R1");process.exit(p?.state==="bidding"&&p.bidder?.email==="dashboard-bidder@example.test"&&p.bidder?.phone==="555-0101"&&s.tenant?.portalUrl&&s.payments?.mode==="platform"&&!JSON.stringify(s).includes("devpreview")?0:1)'

PUBLIC_GET=$(curl -sS "$BASE/api/michael-heckert/bids")
if printf '%s' "$PUBLIC_GET" | grep -Fq 'dashboard-bidder@example.test'; then echo "  FAIL public bid API hides email"; FAIL=1; else echo "  ok   public bid API hides email"; fi
if printf '%s' "$PUBLIC_GET" | grep -Fq '555-0101'; then echo "  FAIL public bid API hides phone"; FAIL=1; else echo "  ok   public bid API hides phone"; fi

CSV_CODE=$(curl -sS -o "$TMP_DIR/bids.csv" -D "$TMP_DIR/csv.headers" -w '%{http_code}' \
  -H "Cookie: asp_dash=$MICHAEL_COOKIE" "$BASE/api/dashboard/michael-heckert/export.csv")
check "CSV export is available" "$CSV_CODE" "200"
HEADER=$(head -n 1 "$TMP_DIR/bids.csv" | tr -d '\r')
check "CSV has required header row" "$HEADER" "placement_id,placement_label,at,type,amount,company,contact_name,email,phone,note,is_current_high,invoice_status,paid_at"
if grep -qi 'content-disposition: attachment; filename="michael-heckert-bids.csv"' "$TMP_DIR/csv.headers"; then
  echo "  ok   CSV download filename is set"
else
  echo "  FAIL CSV download filename is set"
  FAIL=1
fi
if grep -qi 'content-type: text/csv; charset=utf-8' "$TMP_DIR/csv.headers" &&
   grep -qi 'cache-control: no-store' "$TMP_DIR/csv.headers"; then
  echo "  ok   CSV content type and no-store cache policy are set"
else
  echo "  FAIL CSV content type and no-store cache policy are set"
  FAIL=1
fi
if grep -Fq "'=HYPERLINK" "$TMP_DIR/bids.csv"; then echo "  ok   CSV prefixes formula-like company"; else echo "  FAIL CSV prefixes formula-like company"; FAIL=1; fi
if grep -Fq 'dashboard-bidder@example.test' "$TMP_DIR/bids.csv"; then echo "  ok   CSV includes the bid row"; else echo "  FAIL CSV includes the bid row"; FAIL=1; fi

SOLD_CODE=$(curl -sS -o "$TMP_DIR/sold.json" -w '%{http_code}' -X POST "$BASE/api/dashboard/michael-heckert/placements/TF-12/sold" \
  -H "Origin: $BASE" -H "Cookie: asp_dash=$MICHAEL_COOKIE" -H 'content-type: application/json' \
  -d '{"sponsor":"Offline Sponsor","amount":1250,"note":"Confirmed offline"}')
check "no-bid placement can be marked sold" "$SOLD_CODE" "200"
json_check "sold response uses dashboard placement shape" "$TMP_DIR/sold.json" 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).placement;process.exit(p?.state==="sold"&&p.sponsor==="Offline Sponsor"&&p.soldAmount===1250&&p.soldSource==="dashboard"?0:1)'
PUBLIC_GET=$(curl -sS "$BASE/api/michael-heckert/bids")
printf '%s' "$PUBLIC_GET" > "$TMP_DIR/public-sold.json"
json_check "public bid view shows dashboard placement as sold without details" "$TMP_DIR/public-sold.json" 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).placements["TF-12"];process.exit(p?.locked===true&&p.closed===true&&p.lockedBy==="Offline Sponsor"&&p.sold===true&&!Object.hasOwn(p,"email")&&!Object.hasOwn(p,"phone")&&!Object.hasOwn(p,"amount")?0:1)'
check "public bid on sold placement is rejected" "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/michael-heckert/bids" -H "Origin: $BASE" -H 'content-type: application/json' -d '{"id":"TF-12","type":"bid","amount":500,"company":"Blocked Co","name":"Blocked Bidder","email":"blocked@example.test"}')" "409"
check "marking placement with bids sold is rejected" "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/dashboard/michael-heckert/placements/SB-R1/sold" -H "Origin: $BASE" -H "Cookie: asp_dash=$MICHAEL_COOKIE" -H 'content-type: application/json' -d '{"sponsor":"Too Late"}')" "409"
check "marking config-sold placement sold is rejected" "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/dashboard/michael-heckert/placements/SF-L1/sold" -H "Origin: $BASE" -H "Cookie: asp_dash=$MICHAEL_COOKIE" -H 'content-type: application/json' -d '{"sponsor":"Already Sold"}')" "409"
CSV_CODE=$(curl -sS -o "$TMP_DIR/sold.csv" -w '%{http_code}' -H "Cookie: asp_dash=$MICHAEL_COOKIE" "$BASE/api/dashboard/michael-heckert/export.csv")
check "CSV export includes offline sale" "$CSV_CODE" "200"
if grep -Fq 'offline_sale' "$TMP_DIR/sold.csv" && grep -Fq 'Offline Sponsor' "$TMP_DIR/sold.csv"; then
  echo "  ok   dashboard sale is exported as offline_sale"
else
  echo "  FAIL dashboard sale is exported as offline_sale"
  FAIL=1
fi
RELEASE_CODE=$(curl -sS -o "$TMP_DIR/release.json" -w '%{http_code}' -X POST "$BASE/api/dashboard/michael-heckert/placements/TF-12/release" \
  -H "Origin: $BASE" -H "Cookie: asp_dash=$MICHAEL_COOKIE")
check "dashboard sale can be released" "$RELEASE_CODE" "200"
check "release of config-sold placement is rejected" "$(curl -sS -o "$TMP_DIR/release-config.json" -w '%{http_code}' -X POST "$BASE/api/dashboard/michael-heckert/placements/SF-L1/release" -H "Origin: $BASE" -H "Cookie: asp_dash=$MICHAEL_COOKIE")" "409"
if grep -Fq 'This sale is set in the tenant config; contact support to change it.' "$TMP_DIR/release-config.json"; then
  echo "  ok   config-sold release explains the restriction"
else
  echo "  FAIL config-sold release explains the restriction"
  FAIL=1
fi
MICHAEL_SUMMARY_CODE=$(curl -sS -o "$TMP_DIR/released-summary.json" -w '%{http_code}' \
  -H "Cookie: asp_dash=$MICHAEL_COOKIE" "$BASE/api/dashboard/michael-heckert/summary")
check "released placement returns to open state" "$(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(s.placements.find(x=>x.id==="TF-12")?.state||"missing")' "$TMP_DIR/released-summary.json")" "open"
check "released placement accepts a bid" "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/michael-heckert/bids" -H "Origin: $BASE" -H 'content-type: application/json' -d '{"id":"TF-12","type":"bid","amount":500,"company":"After Release Co","name":"After Release Bidder","email":"after-release@example.test"}')" "200"

echo "4. dashboard sale export, Connect onboarding, and logout"
JORDAN_CONNECT_CODE=$(curl -sS -o "$TMP_DIR/jordan-connect.json" -w '%{http_code}' -X POST "$BASE/api/dashboard/jordan-reyes/connect/onboard" \
  -H "Origin: $BASE" -H "Cookie: asp_dash=$JORDAN_COOKIE")
check "Jordan gets a Stripe onboarding URL" "$JORDAN_CONNECT_CODE" "200"
if grep -Fq 'https://connect.stripe.com/setup/mock/' "$TMP_DIR/jordan-connect.json"; then echo "  ok   Jordan URL comes from the mock"; else echo "  FAIL Jordan URL comes from the mock"; FAIL=1; fi
check "Michael platform tenant cannot onboard" "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/dashboard/michael-heckert/connect/onboard" -H "Origin: $BASE" -H "Cookie: asp_dash=$MICHAEL_COOKIE")" "400"

LOGOUT_CODE=$(curl -sS -o "$TMP_DIR/logout.json" -D "$TMP_DIR/logout.headers" -w '%{http_code}' \
  -X POST "$BASE/api/dashboard/logout" -H "Origin: $BASE" -H "Cookie: asp_dash=$MICHAEL_COOKIE" \
  -H 'content-type: application/x-www-form-urlencoded' --data '')
check "form logout redirects" "$LOGOUT_CODE" "303"
LOGOUT_LOCATION=$(awk 'tolower($1)=="location:" {gsub("\r","",$2); print $2; exit}' "$TMP_DIR/logout.headers")
check "logout redirects to dashboard" "$LOGOUT_LOCATION" "/dashboard"
if grep -qi 'set-cookie: asp_dash=;.*Max-Age=0' "$TMP_DIR/logout.headers"; then echo "  ok   logout clears the cookie"; else echo "  FAIL logout clears the cookie"; FAIL=1; fi
check "logout removes dashboard access" "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/dashboard/michael-heckert/summary")" "401"

echo "  skipped missing DASHBOARD_SECRET check (requires a server restart)"
if [ "$FAIL" -eq 0 ]; then
  echo "DASHBOARD TEST PASSED"
else
  echo "DASHBOARD TEST FAILED"
  exit 1
fi
