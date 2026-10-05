#!/usr/bin/env bash
set -u

BASE="${1:-http://localhost:8890}"
ADMIN_TOKEN="${ADMIN_TOKEN:-devtoken}"
PREVIEW_TOKEN="${PREVIEW_TOKEN:-devpreview}"
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

json_check() {
  local label="$1" file="$2" expression="$3"
  if node -e "$expression" "$file"; then
    echo "  ok   $label"
  else
    echo "  FAIL $label"
    FAIL=1
  fi
}

post_json() {
  local url="$1" body="$2" output="$3" cookie="${4:-}" origin="${5:-$BASE}"
  local -a headers=()
  if [ -n "$cookie" ]; then
    local cookie_name="asp_dash"
    [[ "$url" == */api/admin/* ]] && cookie_name="asp_admin"
    headers+=(-H "Cookie: $cookie_name=$cookie")
  fi
  LAST_CODE=$(curl -sS -o "$output" -w '%{http_code}' -X POST "$url" \
    -H "Origin: $origin" "${headers[@]}" -H 'content-type: application/json' --data-binary "$body")
}

admin_login() {
  curl -sS -o "$TMP_DIR/admin-session.json" -D "$TMP_DIR/admin-session.headers" \
    -X POST "$BASE/api/admin/session" -H "Origin: $BASE" -H 'content-type: application/json' \
    -d "{\"token\":\"$ADMIN_TOKEN\"}"
  ADMIN_COOKIE=$(awk 'tolower($1)=="set-cookie:" {sub(/^asp_admin=/,"",$2); sub(/;.*/,"",$2); gsub("\r","",$2); print $2; exit}' "$TMP_DIR/admin-session.headers")
}

create_body() {
  local slug="$1" kit="$2"
  node -e '
    const day = new Date();
    day.setUTCDate(day.getUTCDate() + 60);
    const eventDate = day.toISOString().slice(0, 10);
    process.stdout.write(JSON.stringify({
      slug: process.argv[1], kitId: process.argv[2], eventName: "Autumn Fight Night",
      eventDate, timeZone: "America/New_York", feePercent: 10
    }));
  ' "$slug" "$kit"
}

apply() {
  local name="$1" email="$2" file="$3"
  local body
  body=$(node -e '
    const day=new Date();day.setUTCDate(day.getUTCDate()+60);
    process.stdout.write(JSON.stringify({
      name:process.argv[1],email:process.argv[2],social:"@selfserve",
      sport:"Boxing",promotion:"Self-serve test",event:"Autumn Fight Night",
      eventDate:day.toISOString().slice(0,10),message:"Integration test"
    }));
  ' "$name" "$email")
  curl -sS -o "$file" -w '%{http_code}' -X POST "$BASE/api/apply" \
    -H "Origin: $BASE" -H 'content-type: application/json' --data-binary "$body"
}

login_token() {
  node - "$MOCK_LOG" "$1" <<'NODE'
const fs = require("fs");
const [file, email] = process.argv.slice(2);
const rows = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse) : [];
const message = rows.findLast((row) => row.path === "/emails" &&
  row.body?.to?.includes(email) && row.body?.subject?.includes("sponsorship dashboard"));
const match = `${message?.body?.text || ""}\n${message?.body?.html || ""}`.match(/\/dashboard\/auth\?token=([a-f0-9]{64})/);
if (!match) process.exit(1);
process.stdout.write(match[1]);
NODE
}

email_count() {
  node - "$MOCK_LOG" "$1" "$2" <<'NODE'
const fs = require("fs");
const [file, recipient, subject] = process.argv.slice(2);
const rows = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse) : [];
process.stdout.write(String(rows.filter((row) => row.path === "/emails" &&
  row.body?.to?.includes(recipient) && (!subject || row.body?.subject === subject)).length));
NODE
}

echo "1. authenticated application review and validation"
check "admin applications requires authentication" \
  "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/admin/applications")" "401"
admin_login
APP_ONE_CODE=$(apply "Avery Selfserve" "avery-selfserve@example.test" "$TMP_DIR/app-one.json")
check "first application is accepted" "$APP_ONE_CODE" "200"
APP_TWO_CODE=$(apply "Blair Selfserve" "blair-selfserve@example.test" "$TMP_DIR/app-two.json")
check "second application is accepted" "$APP_TWO_CODE" "200"
APP_THREE_CODE=$(apply "Casey Dismiss" "casey-selfserve@example.test" "$TMP_DIR/app-three.json")
check "third application is accepted" "$APP_THREE_CODE" "200"

LIST_CODE=$(curl -sS -o "$TMP_DIR/applications.json" -w '%{http_code}' \
  -H "Cookie: asp_admin=$ADMIN_COOKIE" "$BASE/api/admin/applications")
check "authenticated applications list responds" "$LIST_CODE" "200"
APP_ONE=$(node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(x.applications.find(a=>a.email==="avery-selfserve@example.test")?.id||"")' "$TMP_DIR/applications.json")
APP_TWO=$(node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(x.applications.find(a=>a.email==="blair-selfserve@example.test")?.id||"")' "$TMP_DIR/applications.json")
APP_THREE=$(node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(x.applications.find(a=>a.email==="casey-selfserve@example.test")?.id||"")' "$TMP_DIR/applications.json")
json_check "application list is newest first and pending" "$TMP_DIR/applications.json" \
  'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const expected=["boxing-trunks","boxing-trunks-top","mma-shorts-top","bkfc-shorts-shirt","gi","nogi"].sort();process.exit(x.applications[0]?.email==="casey-selfserve@example.test"&&x.applications.find(a=>a.email==="avery-selfserve@example.test")?.decision?.status==="pending"&&JSON.stringify(x.kits.map(k=>k.id).sort())===JSON.stringify(expected)?0:1)'

CREATE_BASE=$(create_body "bad" "boxing-trunks")
for slug in "Bad Slug" "demo-selfserve" "admin" "vendor"; do
  BODY=$(node -e 'const x=JSON.parse(process.argv[1]);x.slug=process.argv[2];process.stdout.write(JSON.stringify(x))' "$CREATE_BASE" "$slug")
  post_json "$BASE/api/admin/applications/$APP_ONE/create" "$BODY" "$TMP_DIR/invalid.json" "$ADMIN_COOKIE"
  check "invalid or reserved slug $slug is rejected" "$LAST_CODE" "400"
done
for pair in "michael-heckert:409" "unknown-kit:400"; do
  slug="${pair%%:*}"; expected="${pair##*:}"
  kit="boxing-trunks"; [ "$slug" = "unknown-kit" ] && kit="unknown-kit"
  BODY=$(create_body "$slug" "$kit")
  post_json "$BASE/api/admin/applications/$APP_ONE/create" "$BODY" "$TMP_DIR/invalid.json" "$ADMIN_COOKIE"
  check "slug or kit conflict $slug is rejected" "$LAST_CODE" "$expected"
done
PAST_BODY=$(node -e 'const x=JSON.parse(process.argv[1]);x.eventDate="2000-01-01";process.stdout.write(JSON.stringify(x))' "$CREATE_BASE")
post_json "$BASE/api/admin/applications/$APP_ONE/create" "$PAST_BODY" "$TMP_DIR/past.json" "$ADMIN_COOKIE"
check "past event date is rejected" "$LAST_CODE" "400"
TZ_BODY=$(node -e 'const x=JSON.parse(process.argv[1]);x.timeZone="Mars/Olympus";process.stdout.write(JSON.stringify(x))' "$CREATE_BASE")
post_json "$BASE/api/admin/applications/$APP_ONE/create" "$TZ_BODY" "$TMP_DIR/tz.json" "$ADMIN_COOKIE"
check "invalid timezone is rejected" "$LAST_CODE" "400"
FEE_BODY=$(node -e 'const x=JSON.parse(process.argv[1]);x.feePercent=51;process.stdout.write(JSON.stringify(x))' "$CREATE_BASE")
post_json "$BASE/api/admin/applications/$APP_ONE/create" "$FEE_BODY" "$TMP_DIR/fee.json" "$ADMIN_COOKIE"
check "fee outside range is rejected" "$LAST_CODE" "400"
EMPTY_EVENT_BODY=$(node -e 'const x=JSON.parse(process.argv[1]);x.eventName=" ";process.stdout.write(JSON.stringify(x))' "$CREATE_BASE")
post_json "$BASE/api/admin/applications/$APP_ONE/create" "$EMPTY_EVENT_BODY" "$TMP_DIR/event-name.json" "$ADMIN_COOKIE"
check "empty event name is rejected" "$LAST_CODE" "400"

echo "2. provisioning, private preview, and applicant dashboard"
VALID_BODY=$(create_body "avery-selfserve" "boxing-trunks")
APP_EMAILS_BEFORE=$(email_count "avery-selfserve@example.test" "Your private sponsorship portal is ready")
post_json "$BASE/api/admin/applications/$APP_ONE/create" "$VALID_BODY" "$TMP_DIR/create.json" "$ADMIN_COOKIE"
check "valid application creates a private portal" "$LAST_CODE" "201"
json_check "create response contains slug, dashboard, and preview URLs" "$TMP_DIR/create.json" \
  'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(x.slug==="avery-selfserve"&&x.dashboardUrl.endsWith("/dashboard")&&x.previewUrl.includes("preview=")?0:1)'
PREVIEW_URL=$(node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(x.previewUrl)' "$TMP_DIR/create.json")
TENANT_TOKEN=$(node -e 'process.stdout.write(new URL(process.argv[1]).searchParams.get("preview")||"")' "$PREVIEW_URL")
curl -sS -o "$TMP_DIR/created-applications.json" -D "$TMP_DIR/decisions.headers" \
  -H "Cookie: asp_admin=$ADMIN_COOKIE" "$BASE/api/admin/applications"
json_check "created decision is listed for the application" "$TMP_DIR/created-applications.json" \
  'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(x.applications.find(a=>a.email==="avery-selfserve@example.test")?.decision?.status==="created"&&x.applications.find(a=>a.email==="avery-selfserve@example.test")?.decision?.slug==="avery-selfserve"?0:1)'
check "duplicate dynamic slug is rejected" "$(post_json "$BASE/api/admin/applications/$APP_TWO/create" "$VALID_BODY" "$TMP_DIR/duplicate.json" "$ADMIN_COOKIE"; printf '%s' "$LAST_CODE")" "409"
check "repeated create for the same application is rejected" "$(post_json "$BASE/api/admin/applications/$APP_ONE/create" "$VALID_BODY" "$TMP_DIR/repeat.json" "$ADMIN_COOKIE"; printf '%s' "$LAST_CODE")" "409"
check "anonymous dynamic draft is hidden" "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/avery-selfserve")" "404"
check "global preview token renders draft" "$(curl -sS -o "$TMP_DIR/global-preview.html" -w '%{http_code}' "$BASE/avery-selfserve?preview=$PREVIEW_TOKEN")" "200"
check "tenant token renders its draft" "$(curl -sS -o "$TMP_DIR/tenant-preview.html" -D "$TMP_DIR/tenant-preview.headers" -w '%{http_code}' "$PREVIEW_URL")" "200"
if grep -Fq 'cache-control: no-store' "$TMP_DIR/tenant-preview.headers"; then
  echo "  ok   draft preview responses are not cached"
else
  echo "  FAIL draft preview responses are not cached"
  FAIL=1
fi
if grep -Fq "$TENANT_TOKEN" "$TMP_DIR/tenant-preview.html" && ! grep -Fq "$PREVIEW_TOKEN" "$TMP_DIR/tenant-preview.html"; then
  echo "  ok   tenant preview injects only its slug-bound token"
else
  echo "  FAIL tenant preview injects only its slug-bound token"
  FAIL=1
fi
if grep -Fq "$PREVIEW_TOKEN" "$TMP_DIR/global-preview.html"; then echo "  ok   global preview keeps injecting the legacy token"; else echo "  FAIL global preview keeps injecting the legacy token"; FAIL=1; fi
if grep -Eiq 'Jordan|Reyes' "$TMP_DIR/tenant-preview.html"; then echo "  FAIL dynamic portal copy excludes Jordan/Reyes"; FAIL=1; else echo "  ok   dynamic portal copy excludes Jordan/Reyes"; fi
check "applicant email is sent once" "$(email_count "avery-selfserve@example.test" "Your private sponsorship portal is ready")" "$((APP_EMAILS_BEFORE + 1))"
if node - "$MOCK_LOG" <<'NODE'
const fs=require("fs");const rows=fs.readFileSync(process.argv[2],"utf8").split("\n").filter(Boolean).map(JSON.parse);
const email=rows.findLast((r)=>r.path==="/emails"&&r.body?.to?.includes("avery-selfserve@example.test")&&r.body?.subject==="Your private sponsorship portal is ready");
process.exit(email?.body?.from==="Athlete Sponsorship Portal <sponsors@michaelheckert.com>"&&email.body?.text?.includes("http://localhost:8890/dashboard")&&!email.body?.text?.includes("/dashboard/auth?token=")?0:1);
NODE
then echo "  ok   applicant email uses the platform sender and no expiring login token"; else echo "  FAIL applicant email uses the platform sender and no expiring login token"; FAIL=1; fi

request_json_login=$(curl -sS -o "$TMP_DIR/applicant-login.json" -w '%{http_code}' -X POST "$BASE/api/dashboard/login" \
  -H "Origin: $BASE" -H 'content-type: application/json' -d '{"email":"avery-selfserve@example.test"}')
check "applicant dashboard login is accepted" "$request_json_login" "200"
ATHLETE_TOKEN=$(login_token "avery-selfserve@example.test")
SESSION_CODE=$(curl -sS -o "$TMP_DIR/athlete-session.json" -D "$TMP_DIR/athlete-session.headers" -w '%{http_code}' \
  -X POST "$BASE/api/dashboard/session" -H "Origin: $BASE" -H 'content-type: application/json' \
  -d "{\"token\":\"$ATHLETE_TOKEN\"}")
check "applicant session is created" "$SESSION_CODE" "200"
ATHLETE_COOKIE=$(awk 'tolower($1)=="set-cookie:" {sub(/^asp_dash=/,"",$2); sub(/;.*/,"",$2); gsub("\r","",$2); print $2; exit}' "$TMP_DIR/athlete-session.headers")
SUMMARY_CODE=$(curl -sS -o "$TMP_DIR/summary.json" -w '%{http_code}' -H "Cookie: asp_dash=$ATHLETE_COOKIE" "$BASE/api/dashboard/avery-selfserve/summary")
check "applicant dashboard summary loads" "$SUMMARY_CODE" "200"
json_check "draft settings are editable and payout/likeness checks fail" "$TMP_DIR/summary.json" \
  'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const c=x.launch.checks;process.exit(x.settings.scope==="full"&&x.settings.editable&&c.find(y=>y.id==="payouts")?.ok===false&&c.find(y=>y.id==="likeness")?.ok===false?0:1)'
check "applicant session cannot read another tenant" \
  "$(curl -sS -o /dev/null -w '%{http_code}' -H "Cookie: asp_dash=$ATHLETE_COOKIE" "$BASE/api/dashboard/jordan-reyes/summary")" "401"

PLACEMENT_IDS=$(node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(x.settings.kit.placements.map(p=>p.id).join(","))' "$TMP_DIR/summary.json")
FIRST_PLACEMENT="${PLACEMENT_IDS%%,*}"
REMOVED_PLACEMENT="${PLACEMENT_IDS#*,}"
EVENT_DATE=$(node -e 'const d=new Date();d.setUTCDate(d.getUTCDate()+45);process.stdout.write(d.toISOString().slice(0,10))')
GOOD_SETTINGS=$(node -e '
const ids=process.argv[1].split(",");
const day=process.argv[2];
process.stdout.write(JSON.stringify({
 eventName:"Custom Fight Night",eventDate:day,timeZone:"America/New_York",
 deadline:`${day}T22:00:00.000Z`,minBid:350,increment:25,lockPrice:1700,
 packageName:"Custom package",benefits:["Custom benefit"],intro:"Custom portal intro",
 accent:"#336699",offeredPlacementIds:[ids[0]]
}));
' "$PLACEMENT_IDS" "$EVENT_DATE")
BAD_ORIGIN_CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/dashboard/avery-selfserve/settings" \
  -H 'Origin: https://foreign.example' -H "Cookie: asp_dash=$ATHLETE_COOKIE" \
  -H 'content-type: application/json' --data-binary "$GOOD_SETTINGS")
check "wrong-origin settings update is rejected" "$BAD_ORIGIN_CODE" "403"
for kind in lock deadline past-event accent placements; do
  BAD_SETTINGS=$(node -e '
    const x=JSON.parse(process.argv[1]);
    switch(process.argv[2]){
      case "lock": x.lockPrice=x.minBid; break;
      case "deadline": x.deadline="2099-01-01T00:00:00.000Z"; break;
      case "past-event": x.eventDate="2000-01-01"; break;
      case "accent": x.accent="blue"; break;
      case "placements": x.offeredPlacementIds=[]; break;
    }
    process.stdout.write(JSON.stringify(x));
  ' "$GOOD_SETTINGS" "$kind")
  post_json "$BASE/api/dashboard/avery-selfserve/settings" "$BAD_SETTINGS" "$TMP_DIR/settings-invalid.json" "$ATHLETE_COOKIE"
  check "invalid $kind settings are rejected" "$LAST_CODE" "400"
done
PAST_DEADLINE_SETTINGS=$(node -e 'const x=JSON.parse(process.argv[1]);x.deadline="2000-01-01T00:00:00.000Z";process.stdout.write(JSON.stringify(x))' "$GOOD_SETTINGS")
post_json "$BASE/api/dashboard/avery-selfserve/settings" "$PAST_DEADLINE_SETTINGS" "$TMP_DIR/settings-past-deadline.json" "$ATHLETE_COOKIE"
check "past deadline is rejected" "$LAST_CODE" "400"
post_json "$BASE/api/dashboard/avery-selfserve/settings" "$GOOD_SETTINGS" "$TMP_DIR/settings-good.json" "$ATHLETE_COOKIE"
check "valid draft settings save" "$LAST_CODE" "200"
UPDATED_PREVIEW=$(curl -sS "$BASE/avery-selfserve?preview=$TENANT_TOKEN")
if printf '%s' "$UPDATED_PREVIEW" | grep -Fq "Custom portal intro"; then echo "  ok   updated copy appears in private preview"; else echo "  FAIL updated copy appears in private preview"; FAIL=1; fi
if printf '%s' "$UPDATED_PREVIEW" | grep -Fq "Custom Fight Night" && printf '%s' "$UPDATED_PREVIEW" | grep -Fq "#336699"; then
  echo "  ok   updated event name and derived accent appear in private preview"
else
  echo "  FAIL updated event name and derived accent appear in private preview"
  FAIL=1
fi
check "draft bids GET without a preview token is hidden" \
  "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/avery-selfserve/bids")" "404"
BIDS_CODE=$(curl -sS -o "$TMP_DIR/bids.json" -w '%{http_code}' -H "x-preview-token: $TENANT_TOKEN" "$BASE/api/avery-selfserve/bids")
check "tenant token authorizes bids GET" "$BIDS_CODE" "200"
if [ -n "$REMOVED_PLACEMENT" ] && grep -Fq "\"$REMOVED_PLACEMENT\"" "$TMP_DIR/bids.json"; then
  echo "  FAIL removed placement is absent from bids API"; FAIL=1
else
  echo "  ok   removed placement is absent from bids API"
fi

echo "3. Connect, likeness, launch, and post-launch settings"
post_json "$BASE/api/dashboard/avery-selfserve/launch" '{}' "$TMP_DIR/launch-fail.json" "$ATHLETE_COOKIE"
check "launch is blocked until checks pass" "$LAST_CODE" "409"
ONBOARD_CODE=$(curl -sS -o "$TMP_DIR/connect-onboard.json" -w '%{http_code}' -X POST \
  "$BASE/api/dashboard/avery-selfserve/connect/onboard" -H "Origin: $BASE" \
  -H "Cookie: asp_dash=$ATHLETE_COOKIE" -H 'content-type: application/json' -d '{}')
check "dynamic athlete can start Connect onboarding" "$ONBOARD_CODE" "200"
CONNECT_SUMMARY_CODE=$(curl -sS -o "$TMP_DIR/connect-summary.json" -w '%{http_code}' \
  -H "Cookie: asp_dash=$ATHLETE_COOKIE" "$BASE/api/dashboard/avery-selfserve/summary")
check "Connect account appears in the dashboard summary" "$CONNECT_SUMMARY_CODE" "200"
ACCOUNT_ID=$(node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(x.payments.accountId||"")' "$TMP_DIR/connect-summary.json")
READY_CODE=$(curl -sS -o "$TMP_DIR/mock-ready.json" -w '%{http_code}' -X POST "$MOCK_BASE/__mock/accounts/$ACCOUNT_ID/ready")
check "fake Connect account is made payout-ready" "$READY_CODE" "200"
CONNECT_STATUS_CODE=$(curl -sS -o "$TMP_DIR/connect-status-ready.json" -w '%{http_code}' \
  "$BASE/api/avery-selfserve/connect/status" -H "authorization: Bearer $ADMIN_TOKEN")
check "payout readiness refresh is accepted" "$CONNECT_STATUS_CODE" "200"
source ~/.nvm/nvm.sh
node <<'NODE'
const fs=require("fs");const path=require("path");
const slug="avery-selfserve";const root=".netlify/blobs-serve";
const key=path.join(root,"entries","unlinked","site:model-studio",slug,"live","current");
const metadata=path.join(root,"metadata","unlinked","site:model-studio",slug,"live","current");
fs.mkdirSync(path.dirname(key),{recursive:true});fs.mkdirSync(path.dirname(metadata),{recursive:true});
fs.writeFileSync(key,JSON.stringify({jobId:"selfserve-published-job",publishedAt:new Date().toISOString(),bytes:1}));
fs.writeFileSync(metadata,JSON.stringify({contentType:"application/json"}));
NODE
post_json "$BASE/api/dashboard/avery-selfserve/launch" '{}' "$TMP_DIR/launch-success.json" "$ATHLETE_COOKIE"
check "athlete launches after Connect and likeness checks pass" "$LAST_CODE" "200"
json_check "launch returns public portal URL" "$TMP_DIR/launch-success.json" \
  'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(x.ok===true&&x.portalUrl.endsWith("/avery-selfserve")?0:1)'
check "live portal is public without preview token" "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/avery-selfserve")" "200"
LIVE_SUMMARY_CODE=$(curl -sS -o "$TMP_DIR/live-summary.json" -w '%{http_code}' \
  -H "Cookie: asp_dash=$ATHLETE_COOKIE" "$BASE/api/dashboard/avery-selfserve/summary")
check "live dashboard summary loads" "$LIVE_SUMMARY_CODE" "200"
json_check "live settings scope is copy-only" "$TMP_DIR/live-summary.json" \
  'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(x.settings.scope==="copy"&&x.settings.editable?0:1)'
LOCKED_SETTINGS=$(node -e 'const x=JSON.parse(process.argv[1]);x.eventDate="2099-01-01";process.stdout.write(JSON.stringify(x))' "$GOOD_SETTINGS")
post_json "$BASE/api/dashboard/avery-selfserve/settings" "$LOCKED_SETTINGS" "$TMP_DIR/locked-settings.json" "$ATHLETE_COOKIE"
check "post-launch pricing/date/placement changes are locked" "$LAST_CODE" "409"
if grep -Fq 'Pricing, dates and placements are locked after launch' "$TMP_DIR/locked-settings.json"; then echo "  ok   locked settings return the exact conflict message"; else echo "  FAIL locked settings return the exact conflict message"; FAIL=1; fi
COPY_SETTINGS=$(node -e 'const x=JSON.parse(process.argv[1]);x.packageName="Live copy edit";x.intro="Post-launch copy is editable";process.stdout.write(JSON.stringify(x))' "$GOOD_SETTINGS")
post_json "$BASE/api/dashboard/avery-selfserve/settings" "$COPY_SETTINGS" "$TMP_DIR/copy-settings.json" "$ATHLETE_COOKIE"
check "post-launch copy edits remain allowed" "$LAST_CODE" "200"
if node - "$MOCK_LOG" <<'NODE'
const fs=require("fs");const rows=fs.readFileSync(process.argv[2],"utf8").split("\n").filter(Boolean).map(JSON.parse);
const mail=rows.find((row)=>row.path==="/emails"&&row.body?.to?.includes("ops@example.test")&&row.body?.subject==="Avery Selfserve just went live");
process.exit(mail?.body?.text?.includes("http://localhost:8890/avery-selfserve")?0:1);
NODE
then echo "  ok   operator receives the exact launch subject and portal URL"; else echo "  FAIL operator receives the exact launch subject and portal URL"; FAIL=1; fi

echo "4. tenant-bound previews and static tenant protections"
SECOND_BODY=$(create_body "blair-selfserve" "boxing-trunks")
post_json "$BASE/api/admin/applications/$APP_TWO/create" "$SECOND_BODY" "$TMP_DIR/create-two.json" "$ADMIN_COOKIE"
check "second applicant receives a separate dynamic portal" "$LAST_CODE" "201"
SECOND_PREVIEW=$(node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(x.previewUrl)' "$TMP_DIR/create-two.json")
SECOND_TOKEN=$(node -e 'process.stdout.write(new URL(process.argv[1]).searchParams.get("preview")||"")' "$SECOND_PREVIEW")
check "another tenant token cannot preview the first draft" "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/blair-selfserve?preview=$TENANT_TOKEN")" "404"

DISMISS_CODE=$(curl -sS -o "$TMP_DIR/dismiss.json" -w '%{http_code}' -X POST \
  "$BASE/api/admin/applications/$APP_THREE/dismiss" -H "Origin: $BASE" \
  -H "Cookie: asp_admin=$ADMIN_COOKIE" -H 'content-type: application/json' -d '{}')
check "operator can dismiss another application" "$DISMISS_CODE" "200"

for static_slug in jordan-reyes demo-mma-women; do
  LINK_CODE=$(curl -sS -o "$TMP_DIR/static-link.json" -w '%{http_code}' -X POST \
    "$BASE/api/dashboard/$static_slug/link" -H "Origin: $BASE" -H "authorization: Bearer $ADMIN_TOKEN" \
    -H 'content-type: application/json' -d '{}')
  check "$static_slug admin session link is created" "$LINK_CODE" "200"
  token=$(node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(new URL(x.url).searchParams.get("token")||"")' "$TMP_DIR/static-link.json")
  curl -sS -o "$TMP_DIR/static-session.json" -D "$TMP_DIR/static-session.headers" -X POST \
    "$BASE/api/dashboard/session" -H "Origin: $BASE" -H 'content-type: application/json' -d "{\"token\":\"$token\"}"
  cookie=$(awk 'tolower($1)=="set-cookie:" {sub(/^asp_dash=/,"",$2); sub(/;.*/,"",$2); gsub("\r","",$2); print $2; exit}' "$TMP_DIR/static-session.headers")
  if [ "$static_slug" = "demo-mma-women" ]; then
    STATIC_SUMMARY_CODE=$(curl -sS -o "$TMP_DIR/demo-summary.json" -w '%{http_code}' \
      -H "Cookie: asp_dash=$cookie" "$BASE/api/dashboard/$static_slug/summary")
    check "demo dashboard summary loads" "$STATIC_SUMMARY_CODE" "200"
    json_check "demo dashboard settings are read-only with the exact reason" "$TMP_DIR/demo-summary.json" \
      'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(x.settings.scope==="none"&&x.settings.reason==="Managed by the platform team"?0:1)'
  fi
  post_json "$BASE/api/dashboard/$static_slug/settings" '{}' "$TMP_DIR/static-settings.json" "$cookie"
  if [ "$LAST_CODE" = "403" ] || [ "$LAST_CODE" = "404" ]; then
    echo "  ok   $static_slug settings cannot be changed"
  else
    echo "  FAIL $static_slug settings cannot be changed (expected 403 or 404, got $LAST_CODE)"
    FAIL=1
  fi
  post_json "$BASE/api/dashboard/$static_slug/launch" '{}' "$TMP_DIR/static-launch.json" "$cookie"
  if [ "$static_slug" = "jordan-reyes" ]; then check "static Jordan cannot launch" "$LAST_CODE" "409"; fi
done
check "static Jordan draft accepts legacy preview" \
  "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/jordan-reyes?preview=$PREVIEW_TOKEN")" "200"
check "Michael static portal still renders" "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/michael-heckert")" "200"

if [ "$FAIL" -eq 0 ]; then
  echo "SELFSERVE TEST PASSED"
else
  echo "SELFSERVE TEST FAILED"
  exit 1
fi
