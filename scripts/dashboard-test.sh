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
  shift 3
  if node -e "$script" "$file" "$@"; then
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

mock_mesh_post_count() {
  node - "$MOCK_LOG" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const rows = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse) : [];
process.stdout.write(String(rows.filter((row) => row.method === "POST" && row.path === "/openapi/v1/image-to-image").length));
NODE
}

mock_mesh_3d_post_count() {
  node - "$MOCK_LOG" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const rows = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse) : [];
process.stdout.write(String(rows.filter((row) => row.method === "POST" && row.path === "/openapi/v1/multi-image-to-3d").length));
NODE
}

mock_mesh_task_get_count() {
  node - "$MOCK_LOG" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const rows = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse) : [];
process.stdout.write(String(rows.filter((row) => row.method === "GET" && /^\/openapi\/v1\/image-to-image\/[^/]+$/.test(row.path)).length));
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

echo "5. persistent dashboard onboarding state"
JORDAN_ONBOARDING_SUMMARY_CODE=$(curl -sS -o "$TMP_DIR/jordan-onboarding-summary.json" -w '%{http_code}' \
  -H "Cookie: asp_dash=$JORDAN_COOKIE" "$BASE/api/dashboard/jordan-reyes/summary")
check "Jordan summary includes onboarding state" "$JORDAN_ONBOARDING_SUMMARY_CODE" "200"
json_check "Jordan onboarding timestamps start null" "$TMP_DIR/jordan-onboarding-summary.json" \
  'const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).onboarding;process.exit(o&&["tourCompletedAt","checklistDismissedAt","previewedAt","sharedAt"].every((key)=>o[key]===null)?0:1)'
check "onboarding requires a matching session" "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/dashboard/jordan-reyes/onboarding" \
  -H "Origin: $BASE" -H 'content-type: application/json' -d '{"event":"tour_completed"}')" "401"
check "onboarding rejects a foreign Origin" "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/dashboard/jordan-reyes/onboarding" \
  -H 'Origin: https://foreign.example' -H "Cookie: asp_dash=$JORDAN_COOKIE" \
  -H 'content-type: application/json' -d '{"event":"tour_completed"}')" "403"
check "unknown onboarding event is rejected" "$(curl -sS -o "$TMP_DIR/onboarding-invalid.json" -w '%{http_code}' \
  -X POST "$BASE/api/dashboard/jordan-reyes/onboarding" -H "Origin: $BASE" \
  -H "Cookie: asp_dash=$JORDAN_COOKIE" -H 'content-type: application/json' -d '{"event":"unknown"}')" "400"
if grep -Fq 'Unknown onboarding event.' "$TMP_DIR/onboarding-invalid.json"; then
  echo "  ok   unknown onboarding event error is clear"
else
  echo "  FAIL unknown onboarding event error is clear"
  FAIL=1
fi
check "onboarding route rejects GET" "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/dashboard/jordan-reyes/onboarding")" "405"

TOUR_CODE=$(curl -sS -o "$TMP_DIR/tour-completed.json" -w '%{http_code}' -X POST "$BASE/api/dashboard/jordan-reyes/onboarding" \
  -H "Origin: $BASE" -H "Cookie: asp_dash=$JORDAN_COOKIE" -H 'content-type: application/json' \
  -d '{"event":"tour_completed"}')
check "tour completion is recorded" "$TOUR_CODE" "200"
json_check "tour completion timestamp is set" "$TMP_DIR/tour-completed.json" \
  'const at=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).onboarding?.tourCompletedAt;process.exit(typeof at==="string"&&Number.isFinite(Date.parse(at))?0:1)'
TOUR_FIRST=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).onboarding.tourCompletedAt)' "$TMP_DIR/tour-completed.json")
TOUR_REPEAT_CODE=$(curl -sS -o "$TMP_DIR/tour-repeat.json" -w '%{http_code}' -X POST "$BASE/api/dashboard/jordan-reyes/onboarding" \
  -H "Origin: $BASE" -H "Cookie: asp_dash=$JORDAN_COOKIE" -H 'content-type: application/json' \
  -d '{"event":"tour_completed"}')
check "repeating tour completion succeeds" "$TOUR_REPEAT_CODE" "200"
TOUR_SECOND=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).onboarding.tourCompletedAt)' "$TMP_DIR/tour-repeat.json")
check "tour completion timestamp is stable" "$TOUR_SECOND" "$TOUR_FIRST"

DISMISS_CODE=$(curl -sS -o "$TMP_DIR/checklist-dismissed.json" -w '%{http_code}' -X POST "$BASE/api/dashboard/jordan-reyes/onboarding" \
  -H "Origin: $BASE" -H "Cookie: asp_dash=$JORDAN_COOKIE" -H 'content-type: application/json' \
  -d '{"event":"checklist_dismissed"}')
check "checklist dismissal succeeds" "$DISMISS_CODE" "200"
json_check "checklist dismissal timestamp is set" "$TMP_DIR/checklist-dismissed.json" \
  'const at=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).onboarding?.checklistDismissedAt;process.exit(typeof at==="string"&&Number.isFinite(Date.parse(at))?0:1)'
RESTORE_CODE=$(curl -sS -o "$TMP_DIR/checklist-restored.json" -w '%{http_code}' -X POST "$BASE/api/dashboard/jordan-reyes/onboarding" \
  -H "Origin: $BASE" -H "Cookie: asp_dash=$JORDAN_COOKIE" -H 'content-type: application/json' \
  -d '{"event":"checklist_restored"}')
check "checklist restore succeeds" "$RESTORE_CODE" "200"
json_check "restored checklist timestamp is null" "$TMP_DIR/checklist-restored.json" \
  'process.exit(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).onboarding?.checklistDismissedAt===null?0:1)'

SHARE_CODE=$(curl -sS -o "$TMP_DIR/portal-shared.json" -w '%{http_code}' -X POST "$BASE/api/dashboard/jordan-reyes/onboarding" \
  -H "Origin: $BASE" -H "Cookie: asp_dash=$JORDAN_COOKIE" -H 'content-type: application/json' \
  -d '{"event":"portal_shared"}')
check "portal share is recorded" "$SHARE_CODE" "200"
SHARED_AT=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).onboarding.sharedAt||"")' "$TMP_DIR/portal-shared.json")
if [ -n "$SHARED_AT" ]; then echo "  ok   portal share timestamp is set"; else echo "  FAIL portal share timestamp is set"; FAIL=1; fi
JORDAN_ONBOARDING_SUMMARY_CODE=$(curl -sS -o "$TMP_DIR/jordan-onboarding-final.json" -w '%{http_code}' \
  -H "Cookie: asp_dash=$JORDAN_COOKIE" "$BASE/api/dashboard/jordan-reyes/summary")
check "onboarding summary reflects portal share" "$JORDAN_ONBOARDING_SUMMARY_CODE" "200"
if node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const y=JSON.parse(require("fs").readFileSync(process.argv[2],"utf8"));process.exit(x.onboarding?.sharedAt&&x.onboarding.sharedAt===y.onboarding?.sharedAt?0:1)' \
  "$TMP_DIR/jordan-onboarding-final.json" "$TMP_DIR/portal-shared.json"; then
  echo "  ok   summary returns the shared timestamp"
else
  echo "  FAIL summary returns the shared timestamp"
  FAIL=1
fi

curl -sS -o "$TMP_DIR/concurrent-preview.json" -w '%{http_code}' -X POST "$BASE/api/dashboard/jordan-reyes/onboarding" \
  -H "Origin: $BASE" -H "Cookie: asp_dash=$JORDAN_COOKIE" -H 'content-type: application/json' \
  -d '{"event":"portal_previewed"}' > "$TMP_DIR/concurrent-preview.code" &
PREVIEW_PID=$!
curl -sS -o "$TMP_DIR/concurrent-dismiss.json" -w '%{http_code}' -X POST "$BASE/api/dashboard/jordan-reyes/onboarding" \
  -H "Origin: $BASE" -H "Cookie: asp_dash=$JORDAN_COOKIE" -H 'content-type: application/json' \
  -d '{"event":"checklist_dismissed"}' > "$TMP_DIR/concurrent-dismiss.code" &
DISMISS_PID=$!
wait "$PREVIEW_PID"
wait "$DISMISS_PID"
check "concurrent portal preview event is accepted" "$(cat "$TMP_DIR/concurrent-preview.code")" "200"
check "concurrent checklist dismissal event is accepted" "$(cat "$TMP_DIR/concurrent-dismiss.code")" "200"
JORDAN_CONCURRENT_CODE=$(curl -sS -o "$TMP_DIR/jordan-onboarding-concurrent.json" -w '%{http_code}' \
  -H "Cookie: asp_dash=$JORDAN_COOKIE" "$BASE/api/dashboard/jordan-reyes/summary")
check "summary is available after concurrent onboarding events" "$JORDAN_CONCURRENT_CODE" "200"
json_check "concurrent onboarding fields both persist" "$TMP_DIR/jordan-onboarding-concurrent.json" \
  'const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).onboarding;process.exit(typeof o?.previewedAt==="string"&&typeof o?.checklistDismissedAt==="string"?0:1)'
RESTORE_CONCURRENT_CODE=$(curl -sS -o "$TMP_DIR/concurrent-restored.json" -w '%{http_code}' -X POST "$BASE/api/dashboard/jordan-reyes/onboarding" \
  -H "Origin: $BASE" -H "Cookie: asp_dash=$JORDAN_COOKIE" -H 'content-type: application/json' \
  -d '{"event":"checklist_restored"}')
check "checklist restores after concurrent events" "$RESTORE_CONCURRENT_CODE" "200"
JORDAN_RESTORED_CODE=$(curl -sS -o "$TMP_DIR/jordan-onboarding-restored.json" -w '%{http_code}' \
  -H "Cookie: asp_dash=$JORDAN_COOKIE" "$BASE/api/dashboard/jordan-reyes/summary")
check "summary is available after checklist restore" "$JORDAN_RESTORED_CODE" "200"
if node -e 'const before=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).onboarding;const after=JSON.parse(require("fs").readFileSync(process.argv[2],"utf8")).onboarding;process.exit(typeof before?.previewedAt==="string"&&typeof before?.sharedAt==="string"&&typeof before?.checklistDismissedAt==="string"&&after?.checklistDismissedAt===null&&after.previewedAt===before.previewedAt&&after.sharedAt===before.sharedAt?0:1)' \
  "$TMP_DIR/jordan-onboarding-concurrent.json" "$TMP_DIR/jordan-onboarding-restored.json"; then
  echo "  ok   checklist restore preserves preview and share timestamps"
else
  echo "  FAIL checklist restore preserves preview and share timestamps"
  FAIL=1
fi

check "Michael session cannot update Jordan onboarding" "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/dashboard/jordan-reyes/onboarding" \
  -H "Origin: $BASE" -H "Cookie: asp_dash=$MICHAEL_COOKIE" -H 'content-type: application/json' \
  -d '{"event":"portal_previewed"}')" "401"

echo "6. model studio"
JORDAN_MODEL_URL="$BASE/api/dashboard/jordan-reyes/model"
check "model studio requires a matching session" "$(curl -sS -o /dev/null -w '%{http_code}' "$JORDAN_MODEL_URL")" "401"
check "model studio rejects a foreign tenant session" "$(curl -sS -o /dev/null -w '%{http_code}' -H "Cookie: asp_dash=$MICHAEL_COOKIE" "$JORDAN_MODEL_URL")" "401"
check "model studio returns 404 for an unknown tenant" "$(curl -sS -o /dev/null -w '%{http_code}' -H "Cookie: asp_dash=$JORDAN_COOKIE" "$BASE/api/dashboard/no-such-tenant/model")" "404"
JORDAN_MODEL_CODE=$(curl -sS -o "$TMP_DIR/jordan-model-start.json" -w '%{http_code}' \
  -H "Cookie: asp_dash=$JORDAN_COOKIE" "$JORDAN_MODEL_URL")
check "Jordan model studio is available" "$JORDAN_MODEL_CODE" "200"
json_check "Jordan model studio starts empty" "$TMP_DIR/jordan-model-start.json" \
  'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).model;const angles=["front","back","left","right","face"];const missing=["consent","kit","photo:front","photo:back","photo:left","photo:right"];process.exit(m?.status==="not_started"&&m.hasOwnModel===false&&angles.every((a)=>m.photos?.[a]===null)&&JSON.stringify(m.missing)===JSON.stringify(missing)?0:1)'
check "model studio route rejects POST" "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$JORDAN_MODEL_URL" \
  -H "Origin: $BASE" -H "Cookie: asp_dash=$JORDAN_COOKIE")" "405"
check "model consent route rejects GET" "$(curl -sS -o /dev/null -w '%{http_code}' -H "Cookie: asp_dash=$JORDAN_COOKIE" "$JORDAN_MODEL_URL/consent")" "405"

FIXTURE_DIR="$(dirname "$0")/fixtures"
node - "$TMP_DIR" "$FIXTURE_DIR" <<'NODE'
const fs = require("fs");
const path = require("path");
const [tmp, fixtures] = process.argv.slice(2);
const jpeg = fs.readFileSync(path.join(fixtures, "photo-ok.jpg")).toString("base64");
const small = fs.readFileSync(path.join(fixtures, "photo-small.jpg")).toString("base64");
fs.writeFileSync(path.join(tmp, "photo-ok.json"), JSON.stringify({
  image: `data:image/jpeg;base64,${jpeg}`,
  warnings: ["blurry", "evil"]
}));
fs.writeFileSync(path.join(tmp, "photo-ok-clean.json"), JSON.stringify({ image: `data:image/jpeg;base64,${jpeg}` }));
fs.writeFileSync(path.join(tmp, "photo-small.json"), JSON.stringify({ image: `data:image/jpeg;base64,${small}` }));
fs.writeFileSync(path.join(tmp, "photo-png.json"), JSON.stringify({ image: `data:image/png;base64,${jpeg}` }));
fs.writeFileSync(path.join(tmp, "photo-not-jpeg.json"), JSON.stringify({ image: "data:image/jpeg;base64,bm90anBlZw==" }));
// Netlify Dev caps request streams at 6 MB; this still exceeds the API's 4 MiB image limit.
const large = Buffer.alloc(4.25 * 1024 * 1024);
large.set([0xff, 0xd8, 0xff]);
fs.writeFileSync(path.join(tmp, "photo-too-large.json"), JSON.stringify({
  image: `data:image/jpeg;base64,${large.toString("base64")}`
}));
NODE

check "photo upload requires consent" "$(curl -sS -o "$TMP_DIR/photo-before-consent.json" -w '%{http_code}' -X POST "$JORDAN_MODEL_URL/photos/front" \
  -H "Origin: $BASE" -H "Cookie: asp_dash=$JORDAN_COOKIE" -H 'content-type: application/json' \
  --data-binary "@$TMP_DIR/photo-ok-clean.json")" "409"
CONSENT_BAD_CODE=$(curl -sS -o "$TMP_DIR/consent-bad.json" -w '%{http_code}' -X POST "$JORDAN_MODEL_URL/consent" \
  -H "Origin: $BASE" -H "Cookie: asp_dash=$JORDAN_COOKIE" -H 'content-type: application/json' \
  -d '{"accept":false,"version":"2026-10-03"}')
check "invalid likeness consent is rejected" "$CONSENT_BAD_CODE" "400"
if grep -Fq 'Accept the likeness consent to continue.' "$TMP_DIR/consent-bad.json"; then
  echo "  ok   consent validation message is clear"
else
  echo "  FAIL consent validation message is clear"
  FAIL=1
fi
CONSENT_CODE=$(curl -sS -o "$TMP_DIR/consent.json" -w '%{http_code}' -X POST "$JORDAN_MODEL_URL/consent" \
  -H "Origin: $BASE" -H "Cookie: asp_dash=$JORDAN_COOKIE" -H 'content-type: application/json' \
  -d '{"accept":true,"version":"2026-10-03"}')
check "valid likeness consent is recorded" "$CONSENT_CODE" "200"
json_check "consent stores the agreed version and timestamp" "$TMP_DIR/consent.json" \
  'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).model?.consent;process.exit(c?.version==="2026-10-03"&&typeof c.acceptedAt==="string"&&Number.isFinite(Date.parse(c.acceptedAt))?0:1)'

check "unknown photo angle is rejected" "$(curl -sS -o "$TMP_DIR/photo-angle.json" -w '%{http_code}' -X POST "$JORDAN_MODEL_URL/photos/diagonal" \
  -H "Origin: $BASE" -H "Cookie: asp_dash=$JORDAN_COOKIE" -H 'content-type: application/json' \
  --data-binary "@$TMP_DIR/photo-ok-clean.json")" "404"
check "PNG data URL is rejected" "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$JORDAN_MODEL_URL/photos/front" \
  -H "Origin: $BASE" -H "Cookie: asp_dash=$JORDAN_COOKIE" -H 'content-type: application/json' \
  --data-binary "@$TMP_DIR/photo-png.json")" "400"
check "non-JPEG bytes with JPEG label are rejected" "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$JORDAN_MODEL_URL/photos/front" \
  -H "Origin: $BASE" -H "Cookie: asp_dash=$JORDAN_COOKIE" -H 'content-type: application/json' \
  --data-binary "@$TMP_DIR/photo-not-jpeg.json")" "400"
check "photo below minimum dimensions is rejected" "$(curl -sS -o "$TMP_DIR/photo-small-error.json" -w '%{http_code}' -X POST "$JORDAN_MODEL_URL/photos/front" \
  -H "Origin: $BASE" -H "Cookie: asp_dash=$JORDAN_COOKIE" -H 'content-type: application/json' \
  --data-binary "@$TMP_DIR/photo-small.json")" "400"
check "photo over four megabytes is rejected" "$(curl -sS -o "$TMP_DIR/photo-large-error.json" -w '%{http_code}' -X POST "$JORDAN_MODEL_URL/photos/front" \
  -H "Origin: $BASE" -H "Cookie: asp_dash=$JORDAN_COOKIE" -H 'content-type: application/json' \
  --data-binary "@$TMP_DIR/photo-too-large.json")" "413"
json_check "oversize rejection comes from the photo limit" "$TMP_DIR/photo-large-error.json" \
  'process.exit(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).error==="Photo is too large — please use one under 4 MB."?0:1)'

check "photo upload rejects a foreign Origin" "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$JORDAN_MODEL_URL/photos/front" \
  -H 'Origin: https://foreign.example' -H "Cookie: asp_dash=$JORDAN_COOKIE" -H 'content-type: application/json' \
  --data-binary "@$TMP_DIR/photo-ok-clean.json")" "403"
FRONT_CODE=$(curl -sS -o "$TMP_DIR/photo-front.json" -w '%{http_code}' -X POST "$JORDAN_MODEL_URL/photos/front" \
  -H "Origin: $BASE" -H "Cookie: asp_dash=$JORDAN_COOKIE" -H 'content-type: application/json' \
  --data-binary "@$TMP_DIR/photo-ok.json")
check "valid front photo is uploaded" "$FRONT_CODE" "200"
json_check "photo metadata includes dimensions and filtered warnings" "$TMP_DIR/photo-front.json" \
  'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).model?.photos?.front;process.exit(p?.width===768&&p?.height===1366&&p?.size>0&&JSON.stringify(p.warnings)===JSON.stringify(["blurry"])&&typeof p.at==="string"?0:1)'
PHOTO_GET_CODE=$(curl -sS -o "$TMP_DIR/front.jpg" -D "$TMP_DIR/front.headers" -w '%{http_code}' \
  -H "Cookie: asp_dash=$JORDAN_COOKIE" "$JORDAN_MODEL_URL/photos/front")
check "private photo GET returns stored bytes" "$PHOTO_GET_CODE" "200"
if grep -qi '^content-type: image/jpeg' "$TMP_DIR/front.headers" &&
   grep -qi '^cache-control: private, no-store' "$TMP_DIR/front.headers" &&
   grep -qi '^x-content-type-options: nosniff' "$TMP_DIR/front.headers"; then
  echo "  ok   private photo response headers are set"
else
  echo "  FAIL private photo response headers are set"
  FAIL=1
fi
check "private photo GET rejects a foreign tenant session" "$(curl -sS -o /dev/null -w '%{http_code}' \
  -H "Cookie: asp_dash=$MICHAEL_COOKIE" "$JORDAN_MODEL_URL/photos/front")" "401"

check "kit rejects an invalid hex colour" "$(curl -sS -o "$TMP_DIR/kit-bad.json" -w '%{http_code}' -X POST "$JORDAN_MODEL_URL/kit" \
  -H "Origin: $BASE" -H "Cookie: asp_dash=$JORDAN_COOKIE" -H 'content-type: application/json' \
  -d '{"shirt":"red","shorts":"#111111","waistband":"#ffffff"}')" "400"
KIT_CODE=$(curl -sS -o "$TMP_DIR/kit.json" -w '%{http_code}' -X POST "$JORDAN_MODEL_URL/kit" \
  -H "Origin: $BASE" -H "Cookie: asp_dash=$JORDAN_COOKIE" -H 'content-type: application/json' \
  -d '{"shirt":"#AABBCC","shorts":"#112233","waistband":"#FFFFFF","notes":"  tattoos and hairstyle  "}')
check "valid kit colours are saved" "$KIT_CODE" "200"
json_check "kit colours normalize and notes trim" "$TMP_DIR/kit.json" \
  'const k=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).model?.kit;process.exit(k?.shirt==="#aabbcc"&&k?.shorts==="#112233"&&k?.waistband==="#ffffff"&&k?.notes==="tattoos and hairstyle"?0:1)'

SUBMIT_MISSING_CODE=$(curl -sS -o "$TMP_DIR/submit-missing.json" -w '%{http_code}' -X POST "$JORDAN_MODEL_URL/submit" \
  -H "Origin: $BASE" -H "Cookie: asp_dash=$JORDAN_COOKIE")
check "submission requires all required photos" "$SUBMIT_MISSING_CODE" "409"
json_check "missing submit response identifies back photo" "$TMP_DIR/submit-missing.json" \
  'process.exit(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).missing?.includes("photo:back")?0:1)'
for angle in back left right; do
  check "$angle photo upload succeeds" "$(curl -sS -o "$TMP_DIR/photo-$angle.json" -w '%{http_code}' -X POST "$JORDAN_MODEL_URL/photos/$angle" \
    -H "Origin: $BASE" -H "Cookie: asp_dash=$JORDAN_COOKIE" -H 'content-type: application/json' \
    --data-binary "@$TMP_DIR/photo-ok-clean.json")" "200"
done

check "reference generation is locked before Phase A submission" "$(curl -sS -o "$TMP_DIR/views-locked.json" -w '%{http_code}' -X POST "$JORDAN_MODEL_URL/views/generate" \
  -H "Origin: $BASE" -H "Cookie: asp_dash=$JORDAN_COOKIE")" "409"

SUBMIT_CODE=$(curl -sS -o "$TMP_DIR/submit.json" -w '%{http_code}' -X POST "$JORDAN_MODEL_URL/submit" \
  -H "Origin: $BASE" -H "Cookie: asp_dash=$JORDAN_COOKIE")
check "complete model materials can be submitted" "$SUBMIT_CODE" "200"
json_check "submission is recorded" "$TMP_DIR/submit.json" \
  'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).model;process.exit(m?.status==="submitted"&&typeof m.submittedAt==="string"&&Number.isFinite(Date.parse(m.submittedAt))?0:1)'
SUBMITTED_AT=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).model.submittedAt)' "$TMP_DIR/submit.json")
SUBMIT_REPEAT_CODE=$(curl -sS -o "$TMP_DIR/submit-repeat.json" -w '%{http_code}' -X POST "$JORDAN_MODEL_URL/submit" \
  -H "Origin: $BASE" -H "Cookie: asp_dash=$JORDAN_COOKIE")
check "repeated submission is idempotent" "$SUBMIT_REPEAT_CODE" "200"
check "repeat keeps the original submitted timestamp" \
  "$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).model.submittedAt)' "$TMP_DIR/submit-repeat.json")" "$SUBMITTED_AT"
check "photo upload is locked after submission" "$(curl -sS -o "$TMP_DIR/photo-after-submit.json" -w '%{http_code}' -X POST "$JORDAN_MODEL_URL/photos/back" \
  -H "Origin: $BASE" -H "Cookie: asp_dash=$JORDAN_COOKIE" -H 'content-type: application/json' \
  --data-binary "@$TMP_DIR/photo-ok-clean.json")" "409"

JORDAN_MODEL_SUMMARY_CODE=$(curl -sS -o "$TMP_DIR/jordan-model-summary.json" -w '%{http_code}' \
  -H "Cookie: asp_dash=$JORDAN_COOKIE" "$BASE/api/dashboard/jordan-reyes/summary")
check "Jordan summary includes model status" "$JORDAN_MODEL_SUMMARY_CODE" "200"
json_check "Jordan summary counts four photos" "$TMP_DIR/jordan-model-summary.json" \
  'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).model;process.exit(m?.status==="submitted"&&m.photoCount===4?0:1)'
check "Jordan summary preserves the submitted timestamp" \
  "$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).model.submittedAt)' "$TMP_DIR/jordan-model-summary.json")" "$SUBMITTED_AT"
MICHAEL_MODEL_SUMMARY_CODE=$(curl -sS -o "$TMP_DIR/michael-model-summary.json" -w '%{http_code}' \
  -H "Cookie: asp_dash=$MICHAEL_COOKIE" "$BASE/api/dashboard/michael-heckert/summary")
check "Michael model summary is available" "$MICHAEL_MODEL_SUMMARY_CODE" "200"
json_check "Michael summary identifies the live tenant model" "$TMP_DIR/michael-model-summary.json" \
  'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).model;process.exit(m?.status==="ready"&&m.hasOwnModel===true?0:1)'
check "Michael cannot submit an already live model" "$(curl -sS -o "$TMP_DIR/michael-submit.json" -w '%{http_code}' -X POST "$BASE/api/dashboard/michael-heckert/model/submit" \
  -H "Origin: $BASE" -H "Cookie: asp_dash=$MICHAEL_COOKIE")" "409"

echo "7. reference views (fake Meshy only)"
check "3D model build is locked until views are approved" "$(curl -sS -o "$TMP_DIR/build-locked.json" -w '%{http_code}' -X POST \
  "$BASE/api/dashboard/jordan-reyes/model/build/start" -H "Origin: $BASE" -H "Cookie: asp_dash=$JORDAN_COOKIE")" "409"
MOCK_HEALTH_CODE=$(curl -sS -o "$TMP_DIR/mock-meshy-control.json" -w '%{http_code}' -X POST \
  "http://127.0.0.1:4343/__mock/meshy/fail-next")
if [ "$MOCK_HEALTH_CODE" != "200" ]; then
  echo "  FAIL SAFETY: fake Meshy is unavailable; skipping all reference-generation requests."
  echo "DASHBOARD TEST FAILED"
  exit 1
fi
MOCK_AUTH_CODE=$(curl -sS -o "$TMP_DIR/mock-meshy-auth.json" -w '%{http_code}' -X POST \
  "http://127.0.0.1:4343/openapi/v1/image-to-image" -H 'content-type: application/json' -d '{}')
check "fake Meshy rejects a missing bearer token" "$MOCK_AUTH_CODE" "401"
MOCK_POSTS_BEFORE=$(mock_mesh_post_count)
JORDAN_VIEWS_URL="$JORDAN_MODEL_URL/views"
GENERATE_ONE_CODE=$(curl -sS -o "$TMP_DIR/views-attempt-1-start.json" -w '%{http_code}' -X POST \
  "$JORDAN_VIEWS_URL/generate" -H "Origin: $BASE" -H "Cookie: asp_dash=$JORDAN_COOKIE")
check "failed reference generation starts attempt one" "$GENERATE_ONE_CODE" "200"
MOCK_POSTS_AFTER=$(mock_mesh_post_count)
if [ "$MOCK_POSTS_AFTER" -le "$MOCK_POSTS_BEFORE" ]; then
  echo "  FAIL SAFETY: no fake Meshy image-to-image POST appeared in the mock log; stopping before any more provider requests."
  echo "DASHBOARD TEST FAILED"
  exit 1
fi
json_check "first reference job is generating at attempt one" "$TMP_DIR/views-attempt-1-start.json" \
  'const v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).model?.views;process.exit(v?.status==="generating"&&v.attempt===1&&v.attemptsLeft===2&&typeof v.jobId==="string"?0:1)'
if node - "$MOCK_LOG" "$MOCK_POSTS_BEFORE" <<'NODE'
const fs = require("fs");
const [file, before] = process.argv.slice(2);
const rows = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);
const posts = rows.filter((row) => row.method === "POST" && row.path === "/openapi/v1/image-to-image").slice(Number(before));
process.exit(posts.length === 4 && posts.every(({ body }) =>
  body.ai_model === "nano-banana-pro" &&
  body.aspect_ratio === "9:16" &&
  body.remove_background === true &&
  ["#aabbcc", "#112233", "#ffffff"].every((hex) => body.prompt?.includes(hex)) &&
  !body.prompt?.includes("tattoos and hairstyle") &&
  Array.isArray(body.reference_image_urls) &&
  body.reference_image_urls.length >= 1 &&
  body.reference_image_urls.every((value) => /^data:image\/jpeg;base64,<\d+ chars>$/.test(value))
) && posts.map(({ body }) => body.reference_image_urls.length).sort().join(",") === "1,2,2,2" ? 0 : 1);
NODE
then
  echo "  ok   four fake Meshy calls use private JPEG references and kit-colour prompts"
else
  echo "  FAIL four fake Meshy calls use private JPEG references and kit-colour prompts"
  FAIL=1
fi

check "view image GET requires a matching session" "$(curl -sS -o /dev/null -w '%{http_code}' "$JORDAN_VIEWS_URL/front")" "401"
check "view image GET rejects a foreign tenant session" "$(curl -sS -o /dev/null -w '%{http_code}' \
  -H "Cookie: asp_dash=$MICHAEL_COOKIE" "$JORDAN_VIEWS_URL/front")" "401"
check "unknown tenant view GET returns 404" "$(curl -sS -o /dev/null -w '%{http_code}' \
  -H "Cookie: asp_dash=$JORDAN_COOKIE" "$BASE/api/dashboard/no-such-tenant/model/views/front")" "404"
check "unknown tenant generate POST returns 404" "$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  "$BASE/api/dashboard/no-such-tenant/model/views/generate" -H "Origin: $BASE" -H "Cookie: asp_dash=$JORDAN_COOKIE")" "404"
check "Michael cannot generate views for his existing model" "$(curl -sS -o "$TMP_DIR/michael-views-generate.json" -w '%{http_code}' -X POST \
  "$BASE/api/dashboard/michael-heckert/model/views/generate" -H "Origin: $BASE" -H "Cookie: asp_dash=$MICHAEL_COOKIE")" "409"
check "unknown view action returns 404" "$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  "$JORDAN_VIEWS_URL/unknown" -H "Origin: $BASE" -H "Cookie: asp_dash=$JORDAN_COOKIE")" "404"
check "unknown view angle returns 404" "$(curl -sS -o /dev/null -w '%{http_code}' \
  -H "Cookie: asp_dash=$JORDAN_COOKIE" "$JORDAN_VIEWS_URL/diagonal")" "404"
check "view generation rejects GET" "$(curl -sS -o /dev/null -w '%{http_code}' \
  -H "Cookie: asp_dash=$JORDAN_COOKIE" "$JORDAN_VIEWS_URL/generate")" "405"
check "view image rejects POST" "$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  "$JORDAN_VIEWS_URL/front" -H "Origin: $BASE" -H "Cookie: asp_dash=$JORDAN_COOKIE")" "405"

GENERATE_POSTS_AFTER_ONE=$(mock_mesh_post_count)
SECOND_GENERATE_CODE=$(curl -sS -o "$TMP_DIR/views-attempt-1-repeat.json" -w '%{http_code}' -X POST \
  "$JORDAN_VIEWS_URL/generate" -H "Origin: $BASE" -H "Cookie: asp_dash=$JORDAN_COOKIE")
check "generating start is idempotent" "$SECOND_GENERATE_CODE" "200"
json_check "idempotent generate returns the same job" "$TMP_DIR/views-attempt-1-repeat.json" \
  'const a=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).model?.views;const b=JSON.parse(require("fs").readFileSync(process.argv[2],"utf8")).model?.views;process.exit(a?.jobId===b?.jobId&&b.attempt===1?0:1)' \
  "$TMP_DIR/views-attempt-1-start.json"
check "idempotent start creates no extra Meshy tasks" "$(mock_mesh_post_count)" "$GENERATE_POSTS_AFTER_ONE"

TASK_GETS_BEFORE_SUMMARY=$(mock_mesh_task_get_count)
ATTEMPT_ONE_SUMMARY_CODE=$(curl -sS -o "$TMP_DIR/views-attempt-1-summary.json" -w '%{http_code}' \
  -H "Cookie: asp_dash=$JORDAN_COOKIE" "$BASE/api/dashboard/jordan-reyes/summary")
check "summary reads reference state without polling Meshy" "$ATTEMPT_ONE_SUMMARY_CODE" "200"
check "summary does not advance provider tasks" "$(mock_mesh_task_get_count)" "$TASK_GETS_BEFORE_SUMMARY"
json_check "summary reports the stored generating state" "$TMP_DIR/views-attempt-1-summary.json" \
  'process.exit(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).model?.views?.status==="generating"?0:1)'

poll_views_until() {
  local wanted="$1" output="$2" code=""
  for _ in 1 2 3 4 5 6 7 8; do
    code=$(curl -sS -o "$output" -w '%{http_code}' -H "Cookie: asp_dash=$JORDAN_COOKIE" "$JORDAN_MODEL_URL")
    [ "$code" = "200" ] || return 1
    if node -e 'process.exit(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).model?.views?.status===process.argv[2]?0:1)' "$output" "$wanted"; then
      return 0
    fi
  done
  return 1
}

if poll_views_until failed "$TMP_DIR/views-attempt-1-final.json"; then
  echo "  ok   per-angle mock failure is isolated and the first job reaches failed"
else
  echo "  FAIL per-angle mock failure is isolated and the first job reaches failed"
  FAIL=1
fi
json_check "failed job preserves its attempt and retry count" "$TMP_DIR/views-attempt-1-final.json" \
  'const v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).model?.views;process.exit(v?.status==="failed"&&v.attempt===1&&v.attemptsLeft===2&&Object.values(v.angles||{}).filter((a)=>a.status==="failed").length===1?0:1)'
if grep -Eiq 'mesh_mock_|127[.]0[.]0[.]1' "$TMP_DIR/views-attempt-1-final.json"; then
  echo "  FAIL failed view response hides Meshy task IDs and URLs"
  FAIL=1
else
  echo "  ok   failed view response hides Meshy task IDs and URLs"
fi

GENERATE_TWO_CODE=$(curl -sS -o "$TMP_DIR/views-attempt-2-start.json" -w '%{http_code}' -X POST \
  "$JORDAN_VIEWS_URL/generate" -H "Origin: $BASE" -H "Cookie: asp_dash=$JORDAN_COOKIE")
check "retry starts reference generation attempt two" "$GENERATE_TWO_CODE" "200"
json_check "second reference job increments the attempt" "$TMP_DIR/views-attempt-2-start.json" \
  'const v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).model?.views;process.exit(v?.status==="generating"&&v.attempt===2&&v.attemptsLeft===1?0:1)'
if poll_views_until review "$TMP_DIR/views-attempt-2-review.json"; then
  echo "  ok   successful mock tasks reach athlete review"
else
  echo "  FAIL successful mock tasks reach athlete review"
  FAIL=1
fi
VIEW_JOB_TWO=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).model.views.jobId)' "$TMP_DIR/views-attempt-2-review.json")
for angle in front back left right; do
  VIEW_GET_CODE=$(curl -sS -o "$TMP_DIR/view-$angle.png" -D "$TMP_DIR/view-$angle.headers" -w '%{http_code}' \
    -H "Cookie: asp_dash=$JORDAN_COOKIE" "$JORDAN_VIEWS_URL/$angle")
  check "$angle view is available as a private PNG" "$VIEW_GET_CODE" "200"
  if grep -qi '^content-type: image/png' "$TMP_DIR/view-$angle.headers" &&
     grep -qi '^cache-control: private, max-age=86400, immutable' "$TMP_DIR/view-$angle.headers"; then
    echo "  ok   $angle view response headers are private and immutable"
  else
    echo "  FAIL $angle view response headers are private and immutable"
    FAIL=1
  fi
done
check "private reference view rejects a foreign tenant session" "$(curl -sS -o /dev/null -w '%{http_code}' \
  -H "Cookie: asp_dash=$MICHAEL_COOKIE" "$JORDAN_VIEWS_URL/front")" "401"
check "wrong job ID cannot decide the current views" "$(curl -sS -o "$TMP_DIR/views-wrong-job.json" -w '%{http_code}' -X POST \
  "$JORDAN_VIEWS_URL/decision" -H "Origin: $BASE" -H "Cookie: asp_dash=$JORDAN_COOKIE" -H 'content-type: application/json' \
  -d '{"jobId":"wrong-job","decision":"approve"}')" "409"
check "invalid view decision is rejected" "$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  "$JORDAN_VIEWS_URL/decision" -H "Origin: $BASE" -H "Cookie: asp_dash=$JORDAN_COOKIE" -H 'content-type: application/json' \
  -d '{"jobId":"valid-shape","decision":"maybe"}')" "400"
REJECT_CODE=$(curl -sS -o "$TMP_DIR/views-rejected.json" -w '%{http_code}' -X POST \
  "$JORDAN_VIEWS_URL/decision" -H "Origin: $BASE" -H "Cookie: asp_dash=$JORDAN_COOKIE" -H 'content-type: application/json' \
  -d "{\"jobId\":\"$VIEW_JOB_TWO\",\"decision\":\"reject\",\"feedback\":\"  The shirt colour is wrong.  \"}")
check "athlete can reject views with feedback" "$REJECT_CODE" "200"
json_check "rejection feedback is trimmed and retained" "$TMP_DIR/views-rejected.json" \
  'const v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).model?.views;process.exit(v?.status==="rejected"&&v.decision?.feedback==="The shirt colour is wrong."?0:1)'

GENERATE_THREE_CODE=$(curl -sS -o "$TMP_DIR/views-attempt-3-start.json" -w '%{http_code}' -X POST \
  "$JORDAN_VIEWS_URL/generate" -H "Origin: $BASE" -H "Cookie: asp_dash=$JORDAN_COOKIE")
check "regeneration starts the third and final attempt" "$GENERATE_THREE_CODE" "200"
if poll_views_until review "$TMP_DIR/views-attempt-3-review.json"; then
  echo "  ok   third attempt reaches review"
else
  echo "  FAIL third attempt reaches review"
  FAIL=1
fi
json_check "third attempt has no regenerations left" "$TMP_DIR/views-attempt-3-review.json" \
  'const v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).model?.views;process.exit(v?.status==="review"&&v.attempt===3&&v.attemptsLeft===0?0:1)'
VIEW_JOB_THREE=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).model.views.jobId)' "$TMP_DIR/views-attempt-3-review.json")
APPROVE_CODE=$(curl -sS -o "$TMP_DIR/views-approved.json" -w '%{http_code}' -X POST \
  "$JORDAN_VIEWS_URL/decision" -H "Origin: $BASE" -H "Cookie: asp_dash=$JORDAN_COOKIE" -H 'content-type: application/json' \
  -d "{\"jobId\":\"$VIEW_JOB_THREE\",\"decision\":\"approve\"}")
check "athlete can approve the current views" "$APPROVE_CODE" "200"
json_check "approved views are final" "$TMP_DIR/views-approved.json" \
  'const v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).model?.views;process.exit(v?.status==="approved"&&v.decision?.decision==="approve"&&v.attemptsLeft===0?0:1)'
check "approved views cannot be regenerated" "$(curl -sS -o "$TMP_DIR/views-approved-generate.json" -w '%{http_code}' -X POST \
  "$JORDAN_VIEWS_URL/generate" -H "Origin: $BASE" -H "Cookie: asp_dash=$JORDAN_COOKIE")" "409"
check "approved decision cannot be changed" "$(curl -sS -o "$TMP_DIR/views-approved-decision.json" -w '%{http_code}' -X POST \
  "$JORDAN_VIEWS_URL/decision" -H "Origin: $BASE" -H "Cookie: asp_dash=$JORDAN_COOKIE" -H 'content-type: application/json' \
  -d "{\"jobId\":\"$VIEW_JOB_THREE\",\"decision\":\"reject\"}")" "409"
APPROVED_SUMMARY_CODE=$(curl -sS -o "$TMP_DIR/views-approved-summary.json" -w '%{http_code}' \
  -H "Cookie: asp_dash=$JORDAN_COOKIE" "$BASE/api/dashboard/jordan-reyes/summary")
check "summary includes the approved view state" "$APPROVED_SUMMARY_CODE" "200"
json_check "summary reports approved views without provider details" "$TMP_DIR/views-approved-summary.json" \
  'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).model;process.exit(m?.views?.status==="approved"&&!JSON.stringify(m.views).includes("mesh_mock")&&!JSON.stringify(m.views).includes("127.0.0.1")?0:1)'

echo "8. 3D model build (fake Meshy only)"
JORDAN_BUILD_URL="$BASE/api/dashboard/jordan-reyes/model/build"
check "build start requires a matching session" "$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  "$JORDAN_BUILD_URL/start" -H "Origin: $BASE")" "401"
check "build start rejects a foreign tenant session" "$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  "$JORDAN_BUILD_URL/start" -H "Origin: $BASE" -H "Cookie: asp_dash=$MICHAEL_COOKIE")" "401"
check "unknown tenant build start returns 404" "$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  "$BASE/api/dashboard/no-such-tenant/model/build/start" -H "Origin: $BASE" -H "Cookie: asp_dash=$JORDAN_COOKIE")" "404"
check "unknown build action returns 404" "$(curl -sS -o /dev/null -w '%{http_code}' \
  -H "Cookie: asp_dash=$JORDAN_COOKIE" "$JORDAN_BUILD_URL/unknown")" "404"
check "build start rejects GET" "$(curl -sS -o /dev/null -w '%{http_code}' \
  -H "Cookie: asp_dash=$JORDAN_COOKIE" "$JORDAN_BUILD_URL/start")" "405"
check "model asset rejects POST" "$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  "$JORDAN_BUILD_URL/model.glb" -H "Origin: $BASE" -H "Cookie: asp_dash=$JORDAN_COOKIE")" "405"
check "build start rejects a foreign Origin" "$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  "$JORDAN_BUILD_URL/start" -H 'Origin: https://foreign.example' -H "Cookie: asp_dash=$JORDAN_COOKIE")" "403"
check "model asset GET requires a matching session" "$(curl -sS -o /dev/null -w '%{http_code}' \
  "$JORDAN_BUILD_URL/model.glb")" "401"
check "model asset rejects a foreign tenant session" "$(curl -sS -o /dev/null -w '%{http_code}' \
  -H "Cookie: asp_dash=$MICHAEL_COOKIE" "$JORDAN_BUILD_URL/model.glb")" "401"
check "unknown tenant model asset returns 404" "$(curl -sS -o /dev/null -w '%{http_code}' \
  -H "Cookie: asp_dash=$JORDAN_COOKIE" "$BASE/api/dashboard/no-such-tenant/model/build/model.glb")" "404"
check "missing model asset returns 404" "$(curl -sS -o /dev/null -w '%{http_code}' \
  -H "Cookie: asp_dash=$JORDAN_COOKIE" "$JORDAN_BUILD_URL/model.glb")" "404"

MOCK_3D_AUTH_CODE=$(curl -sS -o "$TMP_DIR/mock-meshy-3d-auth.json" -w '%{http_code}' -X POST \
  "http://127.0.0.1:4343/openapi/v1/multi-image-to-3d" -H 'content-type: application/json' -d '{}')
check "fake 3D Meshy rejects a missing bearer token" "$MOCK_3D_AUTH_CODE" "401"
if DASHBOARD_SECRET=devdashboard node --input-type=module <<'NODE'
import { hasValidBuildSignature } from "./netlify/lib/build-signature.mjs";
process.exit(hasValidBuildSignature({ slug: "jordan-reyes", jobId: "invalid-signature" }, "00") ? 1 : 0);
NODE
then
  echo "  ok   build signature verifier rejects an invalid signature in-process"
else
  echo "  FAIL build signature verifier rejects an invalid signature in-process"
  FAIL=1
fi

check "fake Meshy fail-next arms for the next 3D task" "$(curl -sS -o "$TMP_DIR/mock-build-fail-next.json" -w '%{http_code}' -X POST \
  "http://127.0.0.1:4343/__mock/meshy/fail-next")" "200"
MOCK_BUILD_POSTS_BEFORE=$(mock_mesh_3d_post_count)
BUILD_START_CODE=$(curl -sS -o "$TMP_DIR/build-attempt-1-start.json" -w '%{http_code}' -X POST \
  "$JORDAN_BUILD_URL/start" -H "Origin: $BASE" -H "Cookie: asp_dash=$JORDAN_COOKIE")
check "approved views start build attempt one" "$BUILD_START_CODE" "200"
MOCK_BUILD_POSTS_AFTER=$(mock_mesh_3d_post_count)
if [ "$MOCK_BUILD_POSTS_AFTER" -le "$MOCK_BUILD_POSTS_BEFORE" ]; then
  echo "  FAIL SAFETY: no fake Meshy multi-image POST appeared in the mock log; stopping before any more provider requests."
  echo "DASHBOARD TEST FAILED"
  exit 1
fi
json_check "first build starts with a hidden-task generating state" "$TMP_DIR/build-attempt-1-start.json" \
  'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).model?.build;process.exit(b?.status==="building"&&b.attempt===1&&b.attemptsLeft===2&&typeof b.jobId==="string"&&!JSON.stringify(b).includes("mesh3d_mock")?0:1)'
if node - "$MOCK_LOG" "$MOCK_BUILD_POSTS_BEFORE" <<'NODE'
const fs = require("fs");
const [file, before] = process.argv.slice(2);
const rows = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);
const posts = rows.filter((row) => row.method === "POST" && row.path === "/openapi/v1/multi-image-to-3d").slice(Number(before));
const body = posts[0]?.body;
process.exit(posts.length === 1 &&
  body.ai_model === "meshy-7.1" &&
  body.geometry_resolution === "2k" &&
  body.should_texture === true &&
  body.texture_resolution === "4k" &&
  body.enable_pbr === false &&
  body.should_remesh === true &&
  body.topology === "triangle" &&
  body.target_polycount === 150000 &&
  Array.isArray(body.image_urls) &&
  body.image_urls.length === 4 &&
  body.image_urls.every((value) => /^data:image\/png;base64,<\d+ chars>$/.test(value))
  ? 0 : 1);
NODE
then
  echo "  ok   one multi-image task uses four private PNG views and the requested model settings"
else
  echo "  FAIL one multi-image task uses four private PNG views and the requested model settings"
  FAIL=1
fi
BUILD_DUPLICATE_CODE=$(curl -sS -o "$TMP_DIR/build-attempt-1-repeat.json" -w '%{http_code}' -X POST \
  "$JORDAN_BUILD_URL/start" -H "Origin: $BASE" -H "Cookie: asp_dash=$JORDAN_COOKIE")
check "duplicate build start is idempotent" "$BUILD_DUPLICATE_CODE" "200"
check "duplicate start creates no second 3D task" "$(mock_mesh_3d_post_count)" "$MOCK_BUILD_POSTS_AFTER"

poll_build_until() {
  local wanted="$1" output="$2" code=""
  for _ in $(seq 1 60); do
    code=$(curl -sS -o "$output" -w '%{http_code}' -H "Cookie: asp_dash=$JORDAN_COOKIE" "$BASE/api/dashboard/jordan-reyes/model")
    [ "$code" = "200" ] || return 1
    if node -e 'process.exit(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).model?.build?.status===process.argv[2]?0:1)' "$output" "$wanted"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

if poll_build_until failed "$TMP_DIR/build-attempt-1-failed.json"; then
  echo "  ok   failed mock task moves the build to failed"
else
  echo "  FAIL failed mock task moves the build to failed"
  FAIL=1
fi
json_check "failed build counts toward the three-attempt limit" "$TMP_DIR/build-attempt-1-failed.json" \
  'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).model?.build;process.exit(b?.status==="failed"&&b.attempt===1&&b.attemptsLeft===2?0:1)'
if grep -Eiq 'mesh3d_mock_|127[.]0[.]0[.]1|model_urls|taskId|signature' "$TMP_DIR/build-attempt-1-failed.json"; then
  echo "  FAIL failed build response hides task IDs, URLs and provider details"
  FAIL=1
else
  echo "  ok   failed build response hides task IDs, URLs and provider details"
fi

BUILD_RETRY_CODE=$(curl -sS -o "$TMP_DIR/build-attempt-2-start.json" -w '%{http_code}' -X POST \
  "$JORDAN_BUILD_URL/start" -H "Origin: $BASE" -H "Cookie: asp_dash=$JORDAN_COOKIE")
check "retry starts build attempt two" "$BUILD_RETRY_CODE" "200"
json_check "retry increments the build attempt" "$TMP_DIR/build-attempt-2-start.json" \
  'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).model?.build;process.exit(b?.status==="building"&&b.attempt===2&&b.attemptsLeft===1?0:1)'
if poll_build_until ready "$TMP_DIR/build-attempt-2-ready.json"; then
  echo "  ok   successful mock task is processed to ready"
else
  echo "  FAIL successful mock task is processed to ready"
  FAIL=1
fi
json_check "optimized build is ready with stats and one retry remaining" "$TMP_DIR/build-attempt-2-ready.json" \
  'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).model?.build;process.exit(b?.status==="ready"&&b.attempt===2&&b.attemptsLeft===1&&b.model?.bytes>0&&b.model?.triangles===12&&Array.isArray(b.model?.warnings)?0:1)'

MODEL_GET_CODE=$(curl -sS -o "$TMP_DIR/jordan-model.glb" -D "$TMP_DIR/jordan-model.headers" -w '%{http_code}' \
  -H "Cookie: asp_dash=$JORDAN_COOKIE" "$JORDAN_BUILD_URL/model.glb")
check "authenticated model GLB is downloadable" "$MODEL_GET_CODE" "200"
if grep -qi '^content-type: model/gltf-binary' "$TMP_DIR/jordan-model.headers" &&
   grep -qi '^cache-control: private, max-age=86400, immutable' "$TMP_DIR/jordan-model.headers" &&
   grep -qi '^x-content-type-options: nosniff' "$TMP_DIR/jordan-model.headers"; then
  echo "  ok   GLB response uses the private immutable headers"
else
  echo "  FAIL GLB response uses the private immutable headers"
  FAIL=1
fi
if node - "$TMP_DIR/jordan-model.glb" <<'NODE'
const fs = require("fs");
const bytes = fs.readFileSync(process.argv[2]);
if (bytes.subarray(0, 4).toString("ascii") !== "glTF" || bytes.length < 20) process.exit(1);
const jsonLength = bytes.readUInt32LE(12);
const document = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString("utf8").trim());
process.exit(document.extensionsUsed?.includes("KHR_draco_mesh_compression") &&
  document.extensionsUsed?.includes("EXT_texture_webp") ? 0 : 1);
NODE
then
  echo "  ok   GLB has magic bytes and Draco/WebP extensions"
else
  echo "  FAIL GLB has magic bytes and Draco/WebP extensions"
  FAIL=1
fi
check "model GLB rejects a foreign tenant session" "$(curl -sS -o /dev/null -w '%{http_code}' \
  -H "Cookie: asp_dash=$MICHAEL_COOKIE" "$JORDAN_BUILD_URL/model.glb")" "401"

THUMBNAIL_CODE=$(curl -sS -o "$TMP_DIR/jordan-model-thumbnail.png" -D "$TMP_DIR/jordan-thumbnail.headers" -w '%{http_code}' \
  -H "Cookie: asp_dash=$JORDAN_COOKIE" "$JORDAN_BUILD_URL/thumbnail")
check "best-effort model thumbnail is available" "$THUMBNAIL_CODE" "200"
if grep -qi '^content-type: image/png' "$TMP_DIR/jordan-thumbnail.headers" &&
   grep -qi '^cache-control: private, max-age=86400, immutable' "$TMP_DIR/jordan-thumbnail.headers" &&
   grep -qi '^x-content-type-options: nosniff' "$TMP_DIR/jordan-thumbnail.headers"; then
  echo "  ok   thumbnail response uses the private immutable headers"
else
  echo "  FAIL thumbnail response uses the private immutable headers"
  FAIL=1
fi

if node - "$MOCK_LOG" <<'NODE'
const fs = require("fs");
const rows = fs.readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean).map(JSON.parse);
const emails = rows.filter((row) => row.path === "/emails" &&
  row.body?.subject === "Your 3D model is ready" &&
  row.body?.to?.includes("jordan@example.test"));
process.exit(emails.length === 1 &&
  emails[0].body.text?.includes("/dashboard/jordan-reyes/model") &&
  emails[0].body.text?.includes("360° preview") ? 0 : 1);
NODE
then
  echo "  ok   exactly one ready email reaches Jordan with the dashboard link"
else
  echo "  FAIL exactly one ready email reaches Jordan with the dashboard link"
  FAIL=1
fi
JORDAN_BUILD_SUMMARY_CODE=$(curl -sS -o "$TMP_DIR/jordan-build-summary.json" -w '%{http_code}' \
  -H "Cookie: asp_dash=$JORDAN_COOKIE" "$BASE/api/dashboard/jordan-reyes/summary")
check "summary is available after the model build" "$JORDAN_BUILD_SUMMARY_CODE" "200"
json_check "dashboard summary reflects the ready build without provider details" "$TMP_DIR/jordan-build-summary.json" \
  'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).model;process.exit(m?.build?.status==="ready"&&m.build.attempt===2&&m.build.attemptsLeft===1&&!JSON.stringify(m.build).includes("mesh3d_mock")&&!JSON.stringify(m.build).includes("127.0.0.1")?0:1)'

echo "  skipped missing DASHBOARD_SECRET check (requires a server restart)"
if [ "$FAIL" -eq 0 ]; then
  echo "DASHBOARD TEST PASSED"
else
  echo "DASHBOARD TEST FAILED"
  exit 1
fi
