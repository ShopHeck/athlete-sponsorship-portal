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

mock_payment_email_calls() {
  if [ ! -f "$MOCK_LOG" ]; then
    printf '0'
    return
  fi
  node -e '
    const fs = require("fs");
    const rows = fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map(JSON.parse);
    process.stdout.write(String(rows.filter((row) => row.path === "/emails" || row.path.startsWith("/v1/")).length));
  ' "$MOCK_LOG"
}

echo "1. tenant page routing"
LIVE_CODE=$(curl -sS -o "$TMP_DIR/michael.html" -D "$TMP_DIR/michael.headers" -w '%{http_code}' "$BASE/michael-heckert")
check "Michael page returns 200" "$LIVE_CODE" "200"
if grep -q 'id="portal-config"' "$TMP_DIR/michael.html"; then echo "  ok   Michael HTML embeds config"; else echo "  FAIL Michael HTML embeds config"; FAIL=1; fi
if grep -qi 'teamheck\.netlify\.app' "$TMP_DIR/michael.headers"; then echo "  ok   Michael CSP allows Team Heck"; else echo "  FAIL Michael CSP allows Team Heck"; FAIL=1; fi
if grep -q '"previewToken"' "$TMP_DIR/michael.html"; then echo "  FAIL live Michael config omits previewToken"; FAIL=1; else echo "  ok   live Michael config omits previewToken"; fi
if grep -Fq "Sold out before fight night." "$TMP_DIR/michael.html"; then echo "  ok   Michael page includes case-study headline"; else echo "  FAIL Michael page includes case-study headline"; FAIL=1; fi
if grep -Fq 'class="showcase-panel"' "$TMP_DIR/michael.html"; then echo "  ok   Michael page renders showcase panel"; else echo "  FAIL Michael page renders showcase panel"; FAIL=1; fi

echo "1a. closed Michael showcase"
MICHAEL_GET=$(curl -sS "$BASE/api/michael-heckert/bids")
if printf '%s' "$MICHAEL_GET" | grep -Fq '"closed":true'; then echo "  ok   Michael bid summary is closed"; else echo "  FAIL Michael bid summary is closed"; FAIL=1; fi
MICHAEL_BID_CODE=$(curl -sS -o "$TMP_DIR/michael-bid.json" -w '%{http_code}' -X POST "$BASE/api/michael-heckert/bids" \
  -H 'content-type: application/json' -d '{"id":"SB-R1","type":"bid","amount":500,"company":"Test Co","name":"Tester","email":"tester@example.test"}')
check "Michael bid is rejected" "$MICHAEL_BID_CODE" "409"
MICHAEL_LOCK_CODE=$(curl -sS -o "$TMP_DIR/michael-lock.json" -w '%{http_code}' -X POST "$BASE/api/michael-heckert/bids" \
  -H 'content-type: application/json' -d '{"id":"TF-12","type":"lock","amount":0,"company":"Test Co","name":"Tester","email":"tester@example.test"}')
check "Michael lock is rejected" "$MICHAEL_LOCK_CODE" "409"
if grep -Fq '"error":"Sponsorship for this event has closed."' "$TMP_DIR/michael-bid.json" &&
   grep -Fq '"error":"Sponsorship for this event has closed."' "$TMP_DIR/michael-lock.json"; then
  echo "  ok   Michael closed responses use the case-study message"
else
  echo "  FAIL Michael closed responses use the case-study message"
  FAIL=1
fi
MICHAEL_AFTER=$(curl -sS "$BASE/api/michael-heckert/bids")
if printf '%s' "$MICHAEL_AFTER" | grep -Eq '"(SB-R1|TF-12)"'; then
  echo "  FAIL rejected Michael requests create no placement records"
  FAIL=1
else
  echo "  ok   rejected Michael requests create no placement records"
fi
FIXTURE_PAGE=$(curl -sS "$BASE/platform-fixture")
if printf '%s' "$FIXTURE_PAGE" | grep -Fq 'showcase-panel'; then
  echo "  FAIL platform fixture omits showcase panel"
  FAIL=1
else
  echo "  ok   platform fixture omits showcase panel"
fi

echo "1b. demo portal"
DEMO_SLUGS=(demo-mma-women demo-boxing-men demo-boxing-women demo-bjj-gi-men demo-bjj-gi-women demo-nogi-men demo-nogi-women)
for slug in "${DEMO_SLUGS[@]}"; do
  page="$TMP_DIR/$slug.html"
  code=$(curl -sS -o "$page" -w '%{http_code}' "$BASE/$slug")
  check "$slug page returns 200" "$code" "200"
  if grep -Fq 'class="is-demo"' "$page" &&
     grep -Fq 'class="demo-panel"' "$page" &&
     grep -Fq 'class="demo-badge"' "$page"; then
    echo "  ok   $slug page renders its body class, panel, and badge"
  else
    echo "  FAIL $slug page renders its body class, panel, and badge"
    FAIL=1
  fi
  if grep -Fq 'class="stage-backdrop is-arena"' "$page" &&
     grep -Fq "/tenants/$slug/arena.webp" "$page"; then
    echo "  ok   $slug page renders its configured arena backdrop"
  else
    echo "  FAIL $slug page renders its configured arena backdrop"
    FAIL=1
  fi
done

if node --input-type=module -e '
  import { readFileSync } from "node:fs";
  import { validateConfig } from "./netlify/lib/validate.mjs";
  const demo = JSON.parse(readFileSync("./tenants/demo-mma-women.json", "utf8"));
  try {
    validateConfig({ ...demo, showcase: {} });
    process.exit(1);
  } catch (error) {
    if (!error.message.includes("demo and showcase are mutually exclusive")) process.exit(1);
  }
  const invalid = JSON.parse(JSON.stringify(demo));
  delete invalid.demo.bidNotice;
  try {
    validateConfig(invalid);
    process.exit(1);
  } catch (error) {
    if (!error.message.includes("demo.bidNotice")) process.exit(1);
  }
  const invalidRing = JSON.parse(JSON.stringify(demo));
  invalidRing.ring.style = "hexagon";
  try {
    validateConfig(invalidRing);
    process.exit(1);
  } catch (error) {
    if (!error.message.includes("ring.style")) process.exit(1);
  }
  const invalidMatColors = JSON.parse(JSON.stringify(demo));
  invalidMatColors.ring.matColors = ["blue", "#ffffff"];
  try {
    validateConfig(invalidMatColors);
    process.exit(1);
  } catch (error) {
    if (!error.message.includes("ring.matColors")) process.exit(1);
  }
  const invalidModelFacing = JSON.parse(JSON.stringify(demo));
  invalidModelFacing.modelFacing = "sideways";
  try {
    validateConfig(invalidModelFacing);
    process.exit(1);
  } catch (error) {
    if (!error.message.includes("modelFacing")) process.exit(1);
  }
'; then
  echo "  ok   demo schema rejects showcase overlap, missing copy, invalid ring style/mat colors, and invalid model facing"
else
  echo "  FAIL demo schema rejects showcase overlap, missing copy, invalid ring style/mat colors, and invalid model facing"
  FAIL=1
fi

DEMO_GET=$(curl -sS "$BASE/api/demo-mma-women/bids")
if printf '%s' "$DEMO_GET" | grep -Fq '"demo":true'; then
  echo "  ok   demo bid summary marks the portal as a demo"
else
  echo "  FAIL demo bid summary marks the portal as a demo"
  FAIL=1
fi

DEMO_CALLS_BEFORE=$(mock_payment_email_calls)
DEMO_BID_CODE=$(curl -sS -o "$TMP_DIR/demo-bid.json" -w '%{http_code}' -X POST "$BASE/api/demo-mma-women/bids" \
  -H 'content-type: application/json' -d '{"id":"SF-L1","type":"bid","amount":500,"company":"Demo Test Co","name":"Demo Tester","email":"demo-tester@example.test"}')
DEMO_LOCK_CODE=$(curl -sS -o "$TMP_DIR/demo-lock.json" -w '%{http_code}' -X POST "$BASE/api/demo-mma-women/bids" \
  -H 'content-type: application/json' -d '{"id":"TF-01","type":"lock","amount":0,"company":"Demo Test Co","name":"Demo Tester","email":"demo-tester@example.test"}')
check "demo bid is rejected" "$DEMO_BID_CODE" "409"
check "demo lock is rejected" "$DEMO_LOCK_CODE" "409"
if grep -Fq '"error":"This is a demo portal — bidding is disabled."' "$TMP_DIR/demo-bid.json" &&
   grep -Fq '"error":"This is a demo portal — bidding is disabled."' "$TMP_DIR/demo-lock.json"; then
  echo "  ok   demo bid and lock use the disabled message"
else
  echo "  FAIL demo bid and lock use the disabled message"
  FAIL=1
fi
BOXING_DEMO_BID_CODE=$(curl -sS -o "$TMP_DIR/boxing-demo-bid.json" -w '%{http_code}' -X POST "$BASE/api/demo-boxing-men/bids" \
  -H 'content-type: application/json' -d '{"id":"WB-F1","type":"bid","amount":500,"company":"Demo Test Co","name":"Demo Tester","email":"demo-tester@example.test"}')
BOXING_DEMO_LOCK_CODE=$(curl -sS -o "$TMP_DIR/boxing-demo-lock.json" -w '%{http_code}' -X POST "$BASE/api/demo-boxing-men/bids" \
  -H 'content-type: application/json' -d '{"id":"SF-L1","type":"lock","amount":0,"company":"Demo Test Co","name":"Demo Tester","email":"demo-tester@example.test"}')
check "boxing demo bid is rejected" "$BOXING_DEMO_BID_CODE" "409"
check "boxing demo lock is rejected" "$BOXING_DEMO_LOCK_CODE" "409"
if grep -Fq '"error":"This is a demo portal — bidding is disabled."' "$TMP_DIR/boxing-demo-bid.json" &&
   grep -Fq '"error":"This is a demo portal — bidding is disabled."' "$TMP_DIR/boxing-demo-lock.json"; then
  echo "  ok   boxing demo bid and lock use the disabled message"
else
  echo "  FAIL boxing demo bid and lock use the disabled message"
  FAIL=1
fi

DEMO_CONNECT_CODE=$(curl -sS -o "$TMP_DIR/demo-connect.json" -w '%{http_code}' -X POST "$BASE/api/demo-mma-women/connect/onboard" \
  -H "authorization: Bearer $ADMIN_TOKEN")
check "demo Connect onboarding is rejected" "$DEMO_CONNECT_CODE" "409"
DEMO_CLOSE_CODE=$(curl -sS -o "$TMP_DIR/demo-close.json" -w '%{http_code}' -X POST \
  "$BASE/api/close-auction?tenant=demo-mma-women&force=1" -H "authorization: Bearer $ADMIN_TOKEN")
check "demo close-auction request returns 200" "$DEMO_CLOSE_CODE" "200"
if node -e '
  const result = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  process.exit(result.stripe === false && result.invoiced?.length === 0 && result.retried?.length === 0 ? 0 : 1);
' "$TMP_DIR/demo-close.json"; then
  echo "  ok   demo close-auction skips Stripe and invoices"
else
  echo "  FAIL demo close-auction skips Stripe and invoices"
  FAIL=1
fi
DEMO_AFTER=$(curl -sS "$BASE/api/demo-mma-women/bids")
if printf '%s' "$DEMO_AFTER" | node -e '
  let input = "";
  process.stdin.on("data", (chunk) => input += chunk).on("end", () => {
    try { process.exit(Object.keys(JSON.parse(input).placements || {}).length === 0 ? 0 : 1); }
    catch { process.exit(1); }
  });
'; then
  echo "  ok   rejected demo requests create no placement records"
else
  echo "  FAIL rejected demo requests create no placement records"
  FAIL=1
fi
DEMO_CALLS_AFTER=$(mock_payment_email_calls)
check "demo bids, Connect, and close make no Stripe or Resend calls" "$DEMO_CALLS_AFTER" "$DEMO_CALLS_BEFORE"

check "draft tenant hidden" "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/jordan-reyes")" "404"
PREVIEW_CODE=$(curl -sS -o "$TMP_DIR/jordan-preview.html" -w '%{http_code}' --get --data-urlencode "preview=$PREVIEW_TOKEN" "$BASE/jordan-reyes")
check "draft preview available" "$PREVIEW_CODE" "200"
if grep -Fq "\"previewToken\":\"$PREVIEW_TOKEN\"" "$TMP_DIR/jordan-preview.html"; then echo "  ok   preview config includes token"; else echo "  FAIL preview config includes token"; FAIL=1; fi
check "wrong draft preview token hidden" "$(curl -sS -o /dev/null -w '%{http_code}' --get --data-urlencode 'preview=wrong' "$BASE/jordan-reyes")" "404"
check "unknown tenant hidden" "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/nope")" "404"
check "reserved api slug hidden" "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api")" "404"
check "styles served as static asset" "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/styles.css")" "200"

echo "2. prepare Jordan Connect payouts"
ONBOARD_CODE=$(curl -sS -o "$TMP_DIR/onboard.json" -w '%{http_code}' -X POST "$BASE/api/jordan-reyes/connect/onboard" -H "authorization: Bearer $ADMIN_TOKEN")
check "Jordan onboarding starts" "$ONBOARD_CODE" "200"
ACCOUNT_ID=$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).accountId||"")' "$TMP_DIR/onboard.json")
if [[ "$ACCOUNT_ID" == acct_* ]]; then echo "  ok   mock connected account created"; else echo "  FAIL mock connected account created"; FAIL=1; fi
READY_CODE=$(curl -sS -o "$TMP_DIR/ready.json" -w '%{http_code}' -X POST "$MOCK_BASE/__mock/accounts/$ACCOUNT_ID/ready")
check "mock account marked payout-ready" "$READY_CODE" "200"
STATUS_CODE=$(curl -sS -o "$TMP_DIR/status.json" -w '%{http_code}' "$BASE/api/jordan-reyes/connect/status" -H "authorization: Bearer $ADMIN_TOKEN")
check "Jordan status refreshed" "$STATUS_CODE" "200"
if node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(s.ready===true&&s.status.cardPayments==="active"?0:1)' "$TMP_DIR/status.json"; then
  echo "  ok   Jordan Connect account is ready"
else
  echo "  FAIL Jordan Connect account is ready"
  FAIL=1
fi

echo "3. tenant-scoped bids"
JORDAN_EMAIL="tenant-jordan-test@example.test"
JORDAN_LOGO=$(node -e 'const fs=require("fs");process.stdout.write(`data:image/png;base64,${fs.readFileSync("public/tenants/michael-heckert/sponsors/boxrope.png").toString("base64")}`)')
JORDAN_BODY="{\"id\":\"TR-L1\",\"type\":\"bid\",\"amount\":250,\"company\":\"Jordan Test Co\",\"name\":\"Jordan Tester\",\"email\":\"$JORDAN_EMAIL\",\"phone\":\"\",\"logo\":\"$JORDAN_LOGO\"}"
check "Jordan GET requires preview token" "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/jordan-reyes/bids")" "404"
JORDAN_RESPONSE=$(curl -sS -X POST "$BASE/api/jordan-reyes/bids" -H 'content-type: application/json' -H "x-preview-token: $PREVIEW_TOKEN" -d "$JORDAN_BODY")
check "Jordan TR-L1 bid accepted" "$(printf '%s' "$JORDAN_RESPONSE" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).ok?"200":"invalid")}catch{process.stdout.write("invalid")}})')" "200"
JORDAN_GET=$(curl -sS -H "x-preview-token: $PREVIEW_TOKEN" "$BASE/api/jordan-reyes/bids")
FIXTURE_GET=$(curl -sS "$BASE/api/platform-fixture/bids")
if printf '%s' "$JORDAN_GET" | grep -q '"TR-L1"'; then echo "  ok   Jordan GET includes TR-L1"; else echo "  FAIL Jordan GET includes TR-L1"; FAIL=1; fi
if printf '%s' "$FIXTURE_GET" | grep -q '"TR-L1"'; then echo "  FAIL platform fixture GET excludes Jordan TR-L1"; FAIL=1; else echo "  ok   platform fixture GET excludes Jordan TR-L1"; fi
check "Jordan logo requires preview token" "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/jordan-reyes/logos/TR-L1")" "404"
check "Jordan logo accepts preview query" "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/jordan-reyes/logos/TR-L1?preview=$PREVIEW_TOKEN")" "200"
check "Jordan logo accepts preview header" "$(curl -sS -o /dev/null -w '%{http_code}' -H "x-preview-token: $PREVIEW_TOKEN" "$BASE/api/jordan-reyes/logos/TR-L1")" "200"
check "Jordan rejects Michael SF-L1" "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/jordan-reyes/bids" -H 'content-type: application/json' -H "x-preview-token: $PREVIEW_TOKEN" -d '{"id":"SF-L1","type":"bid","amount":250,"company":"Test","name":"Tester","email":"tester@example.test"}')" "400"
check "platform fixture rejects Jordan TR-L1" "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/platform-fixture/bids" -H 'content-type: application/json' -d '{"id":"TR-L1","type":"bid","amount":500,"company":"Test","name":"Tester","email":"tester@example.test"}')" "400"

if [ -f "$MOCK_LOG" ] && node -e '
  const fs = require("fs");
  const [file, recipient] = process.argv.slice(1);
  const rows = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);
  const emails = rows.filter((row) => row.path === "/emails" && row.body?.to?.includes(recipient));
  const body = JSON.stringify(emails);
  process.exit(emails.length && body.includes("Jordan") && !body.includes("Michael") ? 0 : 1);
' "$MOCK_LOG" "$JORDAN_EMAIL"; then
  echo "  ok   Jordan email contains Jordan, not Michael"
else
  echo "  FAIL Jordan email contains Jordan, not Michael"
  FAIL=1
fi

echo "4. tenant asset paths"
ASSET_PATHS=$(node -e '
  const fs = require("fs");
  const html = fs.readFileSync(process.argv[1], "utf8");
  const raw = html.match(/<script type="application\/json" id="portal-config">([\s\S]*?)<\/script>/);
  if (!raw) process.exit(1);
  const config = JSON.parse(raw[1]);
  const assets = [
    config.model,
    config.poster?.card,
    config.poster?.stage900,
    config.poster?.stage1500,
    config.poster?.ogImage,
    ...Object.values(config.sold || {}).map((entry) => entry.logo)
  ];
  const paths = [...new Set(assets.filter(Boolean))];
  if (!paths.length || paths.some((path) => !path.startsWith("/tenants/michael-heckert/"))) process.exit(1);
  process.stdout.write(paths.join("\n"));
' "$TMP_DIR/michael.html")
if [ -z "$ASSET_PATHS" ]; then
  echo "  FAIL Michael HTML has tenant-absolute asset URLs"
  FAIL=1
else
  echo "  ok   Michael HTML has tenant-absolute asset URLs"
  while IFS= read -r asset; do
    [ -z "$asset" ] && continue
    check "asset $asset returns 200" "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE$asset")" "200"
  done <<EOF
$ASSET_PATHS
EOF
fi

if [ "$FAIL" -eq 0 ]; then
  echo "TENANT TEST PASSED"
else
  echo "TENANT TEST FAILED"
  exit 1
fi
