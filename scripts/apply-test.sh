#!/usr/bin/env bash
set -u

BASE="${1:-http://localhost:8891}"
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

operator_email_count() {
  node - "$MOCK_LOG" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const rows = fs.existsSync(file)
  ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse)
  : [];
process.stdout.write(String(rows.filter((row) =>
  row.path === "/emails" && row.body?.to?.includes("ops@example.test")
).length));
NODE
}

post_json() {
  local body="$1" output="$2" origin="${3:-$BASE}"
  curl -sS -o "$output" -w '%{http_code}' -X POST "$BASE/api/apply" \
    -H "Origin: $origin" -H 'content-type: application/json' --data-binary "$body"
}

echo "1. application route guards and notification"
GET_CODE=$(curl -sS -o "$TMP_DIR/get.json" -w '%{http_code}' "$BASE/api/apply")
check "GET is not allowed" "$GET_CODE" "405"
NO_ORIGIN_CODE=$(curl -sS -o "$TMP_DIR/no-origin.json" -w '%{http_code}' -X POST "$BASE/api/apply" \
  -H 'content-type: application/json' --data-binary '{}')
check "missing Origin is rejected" "$NO_ORIGIN_CODE" "403"
WRONG_ORIGIN_CODE=$(post_json '{}' "$TMP_DIR/wrong-origin.json" "https://foreign.example")
check "wrong Origin is rejected" "$WRONG_ORIGIN_CODE" "403"

VALID_BODY='{"name":"Morgan Fighter","email":"Morgan@Example.test","phone":"555-0101","social":"@morgan","sport":"Boxing","promotion":"Test <Team> & Co","event":"Summer Fight Night","eventDate":"2027-06-12","message":"Sponsor list <private> & notes","website":"","ref":"founding_1"}'
EMAILS_BEFORE=$(operator_email_count)
VALID_CODE=$(post_json "$VALID_BODY" "$TMP_DIR/valid.json")
check "valid application is accepted" "$VALID_CODE" "200"
EMAILS_AFTER=$(operator_email_count)
check "valid application sends one operator email" "$((EMAILS_AFTER - EMAILS_BEFORE))" "1"
if node - "$MOCK_LOG" "$EMAILS_BEFORE" <<'NODE'
const fs = require("fs");
const [file, before] = process.argv.slice(2);
const rows = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);
const emails = rows.filter((row) => row.path === "/emails" && row.body?.to?.includes("ops@example.test"));
const added = emails.slice(Number(before));
const email = added[0]?.body;
process.exit(
  added.length === 1 &&
  JSON.stringify(email.to) === JSON.stringify(["ops@example.test"]) &&
  email.reply_to === "morgan@example.test" &&
  email.subject === "Founding athlete application: Morgan Fighter (Boxing)" &&
  email.from === "Athlete Sponsorship Portal <sponsors@michaelheckert.com>" &&
  email.text?.includes("Event date: 2027-06-12") &&
  email.text?.includes("Ref: founding_1") &&
  email.html?.includes("&lt;Team&gt; &amp; Co") &&
  email.html?.includes("&lt;private&gt; &amp; notes")
    ? 0
    : 1
);
NODE
then
  echo "  ok   operator email has the expected recipient, reply-to, subject and escaped fields"
else
  echo "  FAIL operator email has the expected recipient, reply-to, subject and escaped fields"
  FAIL=1
fi

echo "2. validation, honeypot, and size limit"
MISSING_NAME='{"email":"athlete@example.test","social":"@athlete","sport":"MMA"}'
check "missing name is rejected" "$(post_json "$MISSING_NAME" "$TMP_DIR/missing-name.json")" "400"
BAD_EMAIL='{"name":"Athlete","email":"not-an-email","social":"@athlete","sport":"MMA"}'
check "invalid email is rejected" "$(post_json "$BAD_EMAIL" "$TMP_DIR/bad-email.json")" "400"
BAD_SPORT='{"name":"Athlete","email":"athlete@example.test","social":"@athlete","sport":"Wrestling"}'
check "invalid sport is rejected" "$(post_json "$BAD_SPORT" "$TMP_DIR/bad-sport.json")" "400"
BAD_DATE='{"name":"Athlete","email":"athlete@example.test","social":"@athlete","sport":"MMA","eventDate":"2027-02-29"}'
check "invalid event date is rejected" "$(post_json "$BAD_DATE" "$TMP_DIR/bad-date.json")" "400"

HONEYPOT_BODY='{"name":"Spam","email":"spam@example.test","social":"@spam","sport":"Other","website":"https://spam.example"}'
HONEYPOT_EMAILS_BEFORE=$(operator_email_count)
check "filled honeypot receives a generic success" "$(post_json "$HONEYPOT_BODY" "$TMP_DIR/honeypot.json")" "200"
check "filled honeypot sends no email" "$(operator_email_count)" "$HONEYPOT_EMAILS_BEFORE"

OVERSIZED_BODY=$(node -e 'process.stdout.write(JSON.stringify({message:"x".repeat(17000)}))')
check "oversized body is rejected" "$(post_json "$OVERSIZED_BODY" "$TMP_DIR/oversized.json")" "413"

echo "3. application rate limit"
for attempt in 2 3 4 5; do
  RATE_BODY=$(printf '{"name":"Rate Applicant %s","email":"rate-%s@example.test","social":"@rate%s","sport":"Boxing"}' "$attempt" "$attempt" "$attempt")
  RATE_CODE=$(post_json "$RATE_BODY" "$TMP_DIR/rate-$attempt.json")
  check "accepted application $attempt is within the limit" "$RATE_CODE" "200"
done
SIXTH_BODY='{"name":"Rate Applicant 6","email":"rate-6@example.test","social":"@rate6","sport":"Boxing"}'
SIXTH_CODE=$(post_json "$SIXTH_BODY" "$TMP_DIR/rate-6.json")
check "sixth application from one IP is rate-limited" "$SIXTH_CODE" "429"
if grep -Fq 'Too many applications from this connection. Please email sponsors@michaelheckert.com instead.' "$TMP_DIR/rate-6.json"; then
  echo "  ok   rate-limit response gives the contact address"
else
  echo "  FAIL rate-limit response gives the contact address"
  FAIL=1
fi

echo "4. marketing and tenant routes"
ROOT_CODE=$(curl -sS -o "$TMP_DIR/root.html" -w '%{http_code}' "$BASE/")
check "homepage returns 200" "$ROOT_CODE" "200"
if grep -Fq 'Your kit.' "$TMP_DIR/root.html"; then echo "  ok   homepage contains the marketing headline"; else echo "  FAIL homepage contains the marketing headline"; FAIL=1; fi
CSS_PATH=$(sed -n 's/.*href="\(\/marketing\.css[^"]*\)".*/\1/p' "$TMP_DIR/root.html")
if [[ "$CSS_PATH" == /marketing.css\?v=* ]]; then
  check "homepage's versioned stylesheet returns 200" "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE$CSS_PATH")" "200"
else
  echo "  FAIL homepage references a versioned stylesheet"
  FAIL=1
fi
for path in \
  /terms/ /privacy/ /robots.txt /sitemap.xml /marketing.css /marketing.js \
  /assets/marketing/feature-overview.jpg /assets/marketing/placement-closeup.webp
do
  check "$path returns 200" "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE$path")" "200"
done
check "Michael portal still returns 200" "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/michael-heckert")" "200"

if [ "$FAIL" -eq 0 ]; then
  echo "APPLY TEST PASSED"
else
  echo "APPLY TEST FAILED"
  exit 1
fi
