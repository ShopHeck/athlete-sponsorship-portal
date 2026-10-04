#!/usr/bin/env bash
set -u

BASE="${1:-http://localhost:8890}"
ADMIN_TOKEN="${ADMIN_TOKEN:-devtoken}"
PREVIEW_TOKEN="${PREVIEW_TOKEN:-devpreview}"
MOCK_URL="${MOCK_URL:-http://127.0.0.1:4343}"
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

request_json() {
  local method="$1" url="$2" body="$3" output="$4" cookie="${5:-}"
  local -a auth=()
  [ -n "$cookie" ] && auth=(-H "Cookie: $cookie")
  LAST_CODE=$(curl -sS -o "$output" -w '%{http_code}' -X "$method" "$url" \
    -H "Origin: $BASE" "${auth[@]}" -H 'content-type: application/json' --data-binary "$body")
}

request_json_file() {
  local method="$1" url="$2" body_file="$3" output="$4" cookie="${5:-}"
  local -a auth=()
  [ -n "$cookie" ] && auth=(-H "Cookie: $cookie")
  LAST_CODE=$(curl -sS -o "$output" -w '%{http_code}' -X "$method" "$url" \
    -H "Origin: $BASE" "${auth[@]}" -H 'content-type: application/json' --data-binary "@$body_file")
}

mock_3d_posts() {
  node - "$MOCK_LOG" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const rows = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse) : [];
process.stdout.write(String(rows.filter((row) => row.method === "POST" && row.path === "/openapi/v1/multi-image-to-3d").length));
NODE
}

email_count() {
  node - "$MOCK_LOG" "$1" "$2" <<'NODE'
const fs = require("fs");
const [file, recipient, subject] = process.argv.slice(2);
const rows = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse) : [];
process.stdout.write(String(rows.filter((row) =>
  row.path === "/emails" &&
  row.body?.to?.includes(recipient) &&
  row.body?.subject === subject
).length));
NODE
}

email_has_text() {
  node - "$MOCK_LOG" "$1" "$2" "$3" <<'NODE'
const fs = require("fs");
const [file, recipient, subject, text] = process.argv.slice(2);
const rows = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse) : [];
const email = rows.find((row) => row.path === "/emails" &&
  row.body?.to?.includes(recipient) && row.body?.subject === subject);
process.exit(email?.body?.text?.includes(text) ? 0 : 1);
NODE
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

echo "1. Jordan's private build setup (fake Meshy only)"
JORDAN_LINK_CODE=$(curl -sS -o "$TMP_DIR/jordan-link.json" -w '%{http_code}' \
  -X POST "$BASE/api/dashboard/jordan-reyes/link" -H "Origin: $BASE" \
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' -d '{}')
check "Jordan sign-in link is created" "$JORDAN_LINK_CODE" "200"
JORDAN_TOKEN=$(node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(new URL(x.url).searchParams.get("token")||"")' "$TMP_DIR/jordan-link.json")
JORDAN_SESSION_CODE=$(curl -sS -o "$TMP_DIR/jordan-session.json" -D "$TMP_DIR/jordan-session.headers" -w '%{http_code}' \
  -X POST "$BASE/api/dashboard/session" -H "Origin: $BASE" -H 'content-type: application/json' \
  -d "{\"token\":\"$JORDAN_TOKEN\"}")
check "Jordan athlete session is created" "$JORDAN_SESSION_CODE" "200"
JORDAN_COOKIE=$(awk 'tolower($1)=="set-cookie:" {sub(/^asp_dash=/,"",$2); sub(/;.*/,"",$2); gsub("\r","",$2); print $2; exit}' "$TMP_DIR/jordan-session.headers")

MICHAEL_LINK_CODE=$(curl -sS -o "$TMP_DIR/michael-link.json" -w '%{http_code}' \
  -X POST "$BASE/api/dashboard/michael-heckert/link" -H "Origin: $BASE" \
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' -d '{}')
check "Michael cross-tenant test link is created" "$MICHAEL_LINK_CODE" "200"
MICHAEL_TOKEN=$(node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(new URL(x.url).searchParams.get("token")||"")' "$TMP_DIR/michael-link.json")
MICHAEL_SESSION_CODE=$(curl -sS -o "$TMP_DIR/michael-session.json" -D "$TMP_DIR/michael-session.headers" -w '%{http_code}' \
  -X POST "$BASE/api/dashboard/session" -H "Origin: $BASE" -H 'content-type: application/json' \
  -d "{\"token\":\"$MICHAEL_TOKEN\"}")
check "Michael athlete session is created" "$MICHAEL_SESSION_CODE" "200"
MICHAEL_COOKIE=$(awk 'tolower($1)=="set-cookie:" {sub(/^asp_dash=/,"",$2); sub(/;.*/,"",$2); gsub("\r","",$2); print $2; exit}' "$TMP_DIR/michael-session.headers")

JORDAN_MODEL="$BASE/api/dashboard/jordan-reyes/model"
request_json POST "$JORDAN_MODEL/consent" '{"accept":true,"version":"2026-10-03"}' "$TMP_DIR/consent.json" "asp_dash=$JORDAN_COOKIE"
check "Jordan likeness consent is accepted" "$LAST_CODE" "200"
request_json POST "$JORDAN_MODEL/kit" '{"shirt":"#aabbcc","shorts":"#112233","waistband":"#ffffff"}' "$TMP_DIR/kit.json" "asp_dash=$JORDAN_COOKIE"
check "Jordan kit is saved" "$LAST_CODE" "200"
node - "$TMP_DIR" "$(dirname "$0")/fixtures" <<'NODE'
const fs = require("fs");
const path = require("path");
const [tmp, fixtures] = process.argv.slice(2);
const jpeg = fs.readFileSync(path.join(fixtures, "photo-ok.jpg")).toString("base64");
for (const angle of ["front", "back", "left", "right"]) {
  fs.writeFileSync(path.join(tmp, `${angle}.json`), JSON.stringify({ image: `data:image/jpeg;base64,${jpeg}` }));
}
NODE
for angle in front back left right; do
  request_json_file POST "$JORDAN_MODEL/photos/$angle" "$TMP_DIR/$angle.json" "$TMP_DIR/photo-$angle.json" "asp_dash=$JORDAN_COOKIE"
  check "Jordan $angle photo is uploaded" "$LAST_CODE" "200"
done
request_json POST "$JORDAN_MODEL/submit" '{}' "$TMP_DIR/submit.json" "asp_dash=$JORDAN_COOKIE"
check "Jordan's materials are submitted" "$LAST_CODE" "200"
request_json POST "$JORDAN_MODEL/views/generate" '{}' "$TMP_DIR/views-start.json" "asp_dash=$JORDAN_COOKIE"
check "fake Meshy reference views start" "$LAST_CODE" "200"
for _ in $(seq 1 60); do
  curl -sS -o "$TMP_DIR/views.json" -H "Cookie: asp_dash=$JORDAN_COOKIE" "$JORDAN_MODEL"
  if node -e 'process.exit(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).model?.views?.status==="review"?0:1)' "$TMP_DIR/views.json"; then break; fi
  sleep 1
done
json_check "reference views reach review" "$TMP_DIR/views.json" \
  'process.exit(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).model?.views?.status==="review"?0:1)'
VIEW_JOB=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).model.views.jobId)' "$TMP_DIR/views.json")
request_json POST "$JORDAN_MODEL/views/decision" "{\"jobId\":\"$VIEW_JOB\",\"decision\":\"approve\"}" "$TMP_DIR/views-approved.json" "asp_dash=$JORDAN_COOKIE"
check "Jordan approves the reference views" "$LAST_CODE" "200"
BUILD_POSTS_BEFORE=$(mock_3d_posts)
request_json POST "$JORDAN_MODEL/build/start" '{}' "$TMP_DIR/build-start.json" "asp_dash=$JORDAN_COOKIE"
check "approved views start one fake 3D build" "$LAST_CODE" "200"
check "first build creates exactly one Meshy task" "$(mock_3d_posts)" "$((BUILD_POSTS_BEFORE + 1))"
for _ in $(seq 1 90); do
  curl -sS -o "$TMP_DIR/model.json" -H "Cookie: asp_dash=$JORDAN_COOKIE" "$JORDAN_MODEL"
  if node -e 'process.exit(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).model?.build?.status==="ready"?0:1)' "$TMP_DIR/model.json"; then break; fi
  sleep 1
done
json_check "private 3D build reaches ready" "$TMP_DIR/model.json" \
  'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).model;process.exit(m?.build?.status==="ready"&&m.build?.jobId&&m.review?.status==="athlete_review"?0:1)'
JOB_ID=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).model.build.jobId)' "$TMP_DIR/model.json")
JORDAN_BUILD="$BASE/api/dashboard/jordan-reyes/model/build"

echo "2. Private studio and athlete approval"
STUDIO_NO_SESSION=$(curl -sS -o /dev/null -D "$TMP_DIR/studio-no-session.headers" -w '%{http_code}' \
  "$BASE/dashboard/jordan-reyes/model/studio")
check "studio redirects without a session" "$STUDIO_NO_SESSION" "303"
STUDIO_LOCATION=$(awk 'tolower($1)=="location:" {gsub("\r","",$2); print $2; exit}' "$TMP_DIR/studio-no-session.headers")
check "unauthenticated studio redirects to dashboard login" "$STUDIO_LOCATION" "/dashboard"
STUDIO_CODE=$(curl -sS -o "$TMP_DIR/athlete-studio.html" -D "$TMP_DIR/athlete-studio.headers" -w '%{http_code}' \
  -H "Cookie: asp_dash=$JORDAN_COOKIE" "$BASE/dashboard/jordan-reyes/model/studio")
check "Jordan can open the private studio page" "$STUDIO_CODE" "200"
if grep -Fq "/api/dashboard/jordan-reyes/model/build/model.glb?v=$JOB_ID" "$TMP_DIR/athlete-studio.html" &&
   grep -Fq '"studio":' "$TMP_DIR/athlete-studio.html" &&
   ! grep -Fq "$PREVIEW_TOKEN" "$TMP_DIR/athlete-studio.html"; then
  echo "  ok   studio renders the private build without embedding PREVIEW_TOKEN"
else
  echo "  FAIL studio renders the private build without embedding PREVIEW_TOKEN"
  FAIL=1
fi
if grep -qi '^cache-control: no-store' "$TMP_DIR/athlete-studio.headers" &&
   grep -qi '^x-robots-tag: noindex' "$TMP_DIR/athlete-studio.headers" &&
   grep -qi '^referrer-policy: same-origin' "$TMP_DIR/athlete-studio.headers" &&
   grep -qi "^content-security-policy: frame-ancestors 'none'" "$TMP_DIR/athlete-studio.headers"; then
  echo "  ok   studio response has private safety headers"
else
  echo "  FAIL studio response has private safety headers"
  FAIL=1
fi
check "another tenant's athlete session is redirected" "$(curl -sS -o /dev/null -w '%{http_code}' \
  -H "Cookie: asp_dash=$MICHAEL_COOKIE" "$BASE/dashboard/jordan-reyes/model/studio")" "303"
check "wrong review job is rejected" "$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  "$BASE/api/dashboard/jordan-reyes/model/review" -H "Origin: $BASE" -H "Cookie: asp_dash=$JORDAN_COOKIE" \
  -H 'content-type: application/json' -d '{"jobId":"stale","decision":"approve"}')" "409"
check "review POST requires same-origin" "$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  "$BASE/api/dashboard/jordan-reyes/model/review" -H "Cookie: asp_dash=$JORDAN_COOKIE" \
  -H 'content-type: application/json' -d "{\"jobId\":\"$JOB_ID\",\"decision\":\"approve\"}")" "403"
request_json POST "$BASE/api/dashboard/jordan-reyes/model/review" \
  "{\"jobId\":\"$JOB_ID\",\"decision\":\"approve\",\"note\":\"Looks good\"}" "$TMP_DIR/approved.json" "asp_dash=$JORDAN_COOKIE"
check "athlete approves the model" "$LAST_CODE" "200"
json_check "approval enters operator review" "$TMP_DIR/approved.json" \
  'process.exit(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).model?.review?.status==="operator_review"?0:1)'
check "operator sign-off email is sent exactly once" "$(email_count ops@example.test "Model ready for sign-off: JORDAN REYES")" "1"

echo "3. Operator auth, review queue, publish, and unpublish"
check "signed-out admin page shows sign-in" "$(curl -sS -o "$TMP_DIR/admin-signed-out.html" -w '%{http_code}' "$BASE/admin")" "200"
if grep -Fq 'adminLoginForm' "$TMP_DIR/admin-signed-out.html"; then echo "  ok   admin page renders its sign-in form"; else echo "  FAIL admin page renders its sign-in form"; FAIL=1; fi
check "admin login without Origin is rejected" "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/admin/session" \
  -H 'content-type: application/json' -d '{"token":"devtoken"}')" "403"
check "wrong admin token is rejected" "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/admin/session" \
  -H "Origin: $BASE" -H 'content-type: application/json' -d '{"token":"wrong"}')" "401"
ADMIN_SESSION_CODE=$(curl -sS -o "$TMP_DIR/admin-session.json" -D "$TMP_DIR/admin-session.headers" -w '%{http_code}' \
  -X POST "$BASE/api/admin/session" -H "Origin: $BASE" -H 'content-type: application/json' \
  -d "{\"token\":\"$ADMIN_TOKEN\"}")
check "correct operator token creates an admin session" "$ADMIN_SESSION_CODE" "200"
ADMIN_COOKIE=$(awk 'tolower($1)=="set-cookie:" {sub(/^asp_admin=/,"",$2); sub(/;.*/,"",$2); gsub("\r","",$2); print $2; exit}' "$TMP_DIR/admin-session.headers")
if grep -qi 'set-cookie: asp_admin=.*HttpOnly; SameSite=Strict; Path=/; Max-Age=43200' "$TMP_DIR/admin-session.headers"; then
  echo "  ok   admin cookie is HttpOnly, Strict and 12-hour"
else
  echo "  FAIL admin cookie is HttpOnly, Strict and 12-hour"
  FAIL=1
fi
check "athlete cookie cannot access admin reviews" "$(curl -sS -o /dev/null -w '%{http_code}' \
  -H "Cookie: asp_dash=$JORDAN_COOKIE" "$BASE/api/admin/reviews")" "401"
check "admin cookie cannot access athlete summary" "$(curl -sS -o /dev/null -w '%{http_code}' \
  -H "Cookie: asp_admin=$ADMIN_COOKIE" "$BASE/api/dashboard/jordan-reyes/summary")" "401"
ADMIN_BUILD_CODE=$(curl -sS -o "$TMP_DIR/admin-model.glb" -D "$TMP_DIR/admin-model.headers" -w '%{http_code}' \
  -H "Cookie: asp_admin=$ADMIN_COOKIE" "$JORDAN_BUILD/model.glb?v=$JOB_ID")
check "admin cookie can load the private GLB" "$ADMIN_BUILD_CODE" "200"
if [ "$(head -c 4 "$TMP_DIR/admin-model.glb")" = "glTF" ]; then echo "  ok   admin private asset is a GLB"; else echo "  FAIL admin private asset is a GLB"; FAIL=1; fi
ADMIN_STUDIO_CODE=$(curl -sS -o "$TMP_DIR/operator-studio.html" -w '%{http_code}' \
  -H "Cookie: asp_admin=$ADMIN_COOKIE" "$BASE/admin/jordan-reyes/studio")
check "operator opens the same private studio viewer" "$ADMIN_STUDIO_CODE" "200"
REVIEWS_CODE=$(curl -sS -o "$TMP_DIR/reviews.json" -w '%{http_code}' -H "Cookie: asp_admin=$ADMIN_COOKIE" "$BASE/api/admin/reviews")
check "admin review queue is available" "$REVIEWS_CODE" "200"
json_check "queue lists Jordan in operator review" "$TMP_DIR/reviews.json" \
  'const rows=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(Array.isArray(rows)&&rows.some((row)=>row.slug==="jordan-reyes"&&row.review?.status==="operator_review")?0:1)'
check "publish rejects a stale job ID" "$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  "$BASE/api/admin/jordan-reyes/model/publish" -H "Origin: $BASE" -H "Cookie: asp_admin=$ADMIN_COOKIE" \
  -H 'content-type: application/json' -d '{"jobId":"stale"}')" "409"
request_json POST "$BASE/api/admin/jordan-reyes/model/publish" "{\"jobId\":\"$JOB_ID\"}" "$TMP_DIR/published.json" "asp_admin=$ADMIN_COOKIE"
check "operator publishes the current model" "$LAST_CODE" "200"
check "live notification email reaches Jordan" "$(email_count jordan@example.test "Your 3D model is live")" "1"
check "public draft model requires its preview token" "$(curl -sS -o /dev/null -w '%{http_code}' \
  "$BASE/api/jordan-reyes/model.glb?v=$JOB_ID")" "404"
LIVE_CODE=$(curl -sS -o "$TMP_DIR/live-model.glb" -D "$TMP_DIR/live-model.headers" -w '%{http_code}' \
  "$BASE/api/jordan-reyes/model.glb?v=$JOB_ID&preview=$PREVIEW_TOKEN")
check "draft live model is available with preview token" "$LIVE_CODE" "200"
if [ "$(head -c 4 "$TMP_DIR/live-model.glb")" = "glTF" ] &&
   grep -qi '^cache-control: private, no-store' "$TMP_DIR/live-model.headers"; then
  echo "  ok   draft live-model response is GLB and private no-store"
else
  echo "  FAIL draft live-model response is GLB and private no-store"
  FAIL=1
fi
check "wrong live-model version is not found" "$(curl -sS -o /dev/null -w '%{http_code}' \
  "$BASE/api/jordan-reyes/model.glb?v=wrong&preview=$PREVIEW_TOKEN")" "404"
curl -sS -o "$TMP_DIR/jordan-preview.html" "$BASE/jordan-reyes?preview=$PREVIEW_TOKEN"
if grep -Fq "/api/jordan-reyes/model.glb?v=$JOB_ID&preview=$PREVIEW_TOKEN" "$TMP_DIR/jordan-preview.html"; then
  echo "  ok   draft portal renders the published model with preview token"
else
  echo "  FAIL draft portal renders the published model with preview token"
  FAIL=1
fi
curl -sS -o "$TMP_DIR/jordan-live-summary.json" -H "Cookie: asp_dash=$JORDAN_COOKIE" "$BASE/api/dashboard/jordan-reyes/model"
json_check "dashboard review state becomes live while build remains ready" "$TMP_DIR/jordan-live-summary.json" \
  'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).model;process.exit(m?.review?.status==="live"&&m.build?.status==="ready"&&m.build?.jobId?0:1)'
check "live model blocks a new build" "$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  "$JORDAN_BUILD/start" -H "Origin: $BASE" -H "Cookie: asp_dash=$JORDAN_COOKIE")" "409"
check "live model blocks athlete rebuild" "$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  "$BASE/api/dashboard/jordan-reyes/model/review" -H "Origin: $BASE" -H "Cookie: asp_dash=$JORDAN_COOKIE" \
  -H 'content-type: application/json' -d "{\"jobId\":\"$JOB_ID\",\"decision\":\"rebuild\"}")" "409"
curl -sS -o "$TMP_DIR/michael-portal.html" "$BASE/michael-heckert"
if grep -Fq '/tenants/michael-heckert/models/heckert.glb' "$TMP_DIR/michael-portal.html"; then
  echo "  ok   Michael portal keeps its tenant-configured model URL"
else
  echo "  FAIL Michael portal keeps its tenant-configured model URL"
  FAIL=1
fi
request_json POST "$BASE/api/admin/jordan-reyes/model/unpublish" '{}' "$TMP_DIR/unpublished.json" "asp_admin=$ADMIN_COOKIE"
check "operator unpublishes the current model" "$LAST_CODE" "200"
json_check "unpublishing returns the model to operator review" "$TMP_DIR/unpublished.json" \
  'process.exit(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).review?.status==="operator_review"?0:1)'
curl -sS -o "$TMP_DIR/jordan-unpublished-preview.html" "$BASE/jordan-reyes?preview=$PREVIEW_TOKEN"
if ! grep -Fq "/api/jordan-reyes/model.glb?v=$JOB_ID" "$TMP_DIR/jordan-unpublished-preview.html"; then
  echo "  ok   unpublish restores the tenant's configured model URL"
else
  echo "  FAIL unpublish restores the tenant's configured model URL"
  FAIL=1
fi

echo "4. Send-back and rebuild"
check "send-back requires a note" "$(curl -sS -o "$TMP_DIR/send-back-missing.json" -w '%{http_code}' -X POST \
  "$BASE/api/admin/jordan-reyes/model/send-back" -H "Origin: $BASE" -H "Cookie: asp_admin=$ADMIN_COOKIE" \
  -H 'content-type: application/json' -d "{\"jobId\":\"$JOB_ID\"}")" "400"
NOTE="Please adjust the shoulder and confirm the shorts color."
request_json POST "$BASE/api/admin/jordan-reyes/model/send-back" \
  "{\"jobId\":\"$JOB_ID\",\"note\":\"$NOTE\"}" "$TMP_DIR/send-back.json" "asp_admin=$ADMIN_COOKIE"
check "operator sends the model back with a note" "$LAST_CODE" "200"
check "send-back email reaches Jordan" "$(email_count jordan@example.test "Changes requested on your 3D model")" "1"
if email_has_text jordan@example.test "Changes requested on your 3D model" "$NOTE"; then
  echo "  ok   send-back email includes the operator note"
else
  echo "  FAIL send-back email includes the operator note"
  FAIL=1
fi
json_check "send-back status includes its note" "$TMP_DIR/send-back.json" \
  'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).review;process.exit(r?.status==="sent_back"&&r.operator?.note?.includes("shoulder")?0:1)'
BUILD_POSTS_BEFORE_REBUILD=$(mock_3d_posts)
request_json POST "$BASE/api/dashboard/jordan-reyes/model/review" \
  "{\"jobId\":\"$JOB_ID\",\"decision\":\"rebuild\",\"note\":\"$NOTE\"}" "$TMP_DIR/rebuild.json" "asp_dash=$JORDAN_COOKIE"
check "athlete starts a rebuild after send-back" "$LAST_CODE" "200"
check "rebuild creates exactly one additional fake Meshy task" "$(mock_3d_posts)" "$((BUILD_POSTS_BEFORE_REBUILD + 1))"
NEW_JOB_ID=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).model.build.jobId)' "$TMP_DIR/rebuild.json")
json_check "rebuild uses a new build attempt and job ID" "$TMP_DIR/rebuild.json" \
  'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).model;process.exit(m?.build?.status==="building"&&m.build?.attempt===2&&m.build?.attemptsLeft===1&&m.build?.jobId!==process.argv[2]?0:1)' \
  "$JOB_ID"
for _ in $(seq 1 90); do
  curl -sS -o "$TMP_DIR/rebuilt-model.json" -H "Cookie: asp_dash=$JORDAN_COOKIE" "$JORDAN_MODEL"
  if node -e 'process.exit(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).model?.build?.status==="ready"?0:1)' "$TMP_DIR/rebuilt-model.json"; then break; fi
  sleep 1
done
json_check "rebuilt model reaches ready with prior approval cleared" "$TMP_DIR/rebuilt-model.json" \
  'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).model;process.exit(m?.build?.status==="ready"&&m.build?.attempt===2&&m.build?.attemptsLeft===1&&m.build?.jobId!==process.argv[2]&&m.review?.status==="athlete_review"?0:1)' \
  "$JOB_ID"
check "rebuilt job ID changed" "$NEW_JOB_ID" "$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).model.build.jobId)' "$TMP_DIR/rebuilt-model.json")"

if [ "$FAIL" -eq 0 ]; then
  echo "STUDIO TEST PASSED"
else
  echo "STUDIO TEST FAILED"
  exit 1
fi
