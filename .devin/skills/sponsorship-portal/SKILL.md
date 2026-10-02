---
name: sponsorship-portal
description: Build, configure, launch and operate a 360° athlete sponsorship portal — a 3D placement picker with live bidding, Lock It Now buy-outs, Stripe invoicing and Resend email — from the heck-sponsor-360 template. Use when a fighter, athlete, team or event wants to sell logo placements on their kit, when setting up a new portal for a client, when changing placements/pricing/copy on an existing portal, when launching (Netlify, Stripe, Resend, domain, embed), or when operating one (reading bids, closing the auction, invoicing winners, resetting a placement).
---

# Sponsorship portal playbook

This repository is the reference implementation (Michael "King Killer" Heckert, BKFC Clearwater) and the
template resold to other athletes. Work through the phases in order and skip what the user has already done.
Read a reference file when you reach the phase that needs it; do not guess env var names, placement IDs or copy.

| Reference (`reference/`) | Read it for |
| --- | --- |
| `intake.md` | Client questionnaire and delivery checklist — Phase 0 |
| `configuration.md` | Tenant JSON schema, placements, sold sponsors, copy, env vars, brand, poster/backdrop recipe, 3D model requirements, embed snippet — Phase 1 |
| `launch-checklist.md` | Netlify / Resend / Stripe / domain setup, the real dry run, distribution, operations runbook — Phases 3–4 |
| `gotchas.md` | Every trap hit on the original build, with cause and fix — read before debugging anything |

## How the product works (30-second model)

- `public/` is a static site: three.js (import map, unpkg) renders the athlete GLB; each placement is a rectangle
  in metres projected onto the garment as a decal. Bidding UI, logo preview, poster backdrop, embed mode.
- `netlify/functions/`: `bids.mjs` (GET public summary / POST bid or lock), `logo.mjs` (bidder logos),
  `close-auction.mjs` (daily: invoices winners after the deadline, retries failed invoices),
  `admin-close.mjs` (`POST /api/close-auction`, bearer `ADMIN_TOKEN`, `?force=1` closes early).
- `portal.config.json`: the default tenant's identity, event, placements, pricing, ring, brand, sold sponsors, and copy.
- `scripts/build.mjs`: renders the selected tenant config into the static page and function bundle before Netlify builds.
- `netlify/lib/sponsorship.mjs`: tenant settings with environment overrides, placement labels, Stripe + Resend helpers.
- Netlify Blobs: store `bids` (one JSON record per placement with history and invoice state) and `logos`.
- Money: bids are non-binding until `BID_DEADLINE`. Lock It Now (or a bid ≥ `LOCK_PRICE`) creates a Stripe
  customer + finalised `send_invoice` invoice due on receipt and emails the sponsor a pay link via Resend.
  Stripe's own emails stay off; nothing is charged in the browser. Invoice state is saved on the record, so
  re-runs never double-invoice.
- `scripts/build.mjs` also cache-busts `styles.css` / `app.js` per deploy.

## Phase 0 — Intake

Complete `reference/intake.md` with the client. Minimum before code: athlete/event names and date; garments and
the placement list with physical sizes; pre-sold sponsors and logo files; pricing (`MIN_BID`, `BID_INCREMENT`,
`LOCK_PRICE`, `BID_DEADLINE` with timezone); benefits list; brand colours; portal domain; confirmed access to the
client's **own** Stripe and Resend accounts; the owner-notification inbox.

## Phase 1 — New portal from the template

```bash
gh repo create <org>/<athlete>-sponsor-portal --private --clone --template ShopHeck/heck-sponsor-360
cd <athlete>-sponsor-portal && npm install
```
Then, in this order (details and file paths in `reference/configuration.md`):
1. **Tenant config** → create one JSON file from `portal.config.json`; set `PORTAL_CONFIG` to its path when building.
2. **3D model** → put `public/assets/models/<athlete>.glb` in the repo and set `model` in the tenant JSON. Scale and
   facing are normalised automatically; check the FRONT view after loading. `?model=` remains available as an override.
3. **Placements** → edit `garments[].placements` in the tenant JSON. IDs, labels, geometry, sold inventory, and the server allowlist are generated from this one source; do not edit application or function code for a new tenant.
4. **Pre-sold sponsors** → add entries to the JSON `sold` map and store logos in `public/assets/sponsors/`.
5. **Copy** → configure `seo`, `hero`, `event`, `benefits`, and `copy` in the tenant JSON.
6. **Brand and ring** → set `brand` and `ring` in the tenant JSON; `poster: null` removes the poster UI and backdrop.
7. **Poster / backdrop / share image** → ffmpeg recipe in `reference/configuration.md` into `public/assets/backdrop/`.
8. **Pricing and deadline** → set `pricing` in the tenant JSON; `MIN_BID`, `BID_INCREMENT`, `LOCK_PRICE`, and `BID_DEADLINE` environment variables override those defaults.

Build before previewing: `npm run build` (or `PORTAL_CONFIG=examples/demo-athlete.json npm run build`), then `npx netlify dev` (Blobs runs in a local sandbox). Small PRs, each based on `main`.

## Phase 2 — Local end-to-end test (no real money, no real email)

```bash
node scripts/mock-services.mjs &                      # fake Stripe + Resend on :4242
STRIPE_SECRET_KEY=sk_test_mock STRIPE_API_BASE=http://127.0.0.1:4242 \
RESEND_API_KEY=re_mock RESEND_API_BASE=http://127.0.0.1:4242 \
NOTIFY_EMAIL=owner@example.test PORTAL_URL=http://localhost:8888 ADMIN_TOKEN=devtoken \
npx netlify dev --offline --port 8888 &
scripts/smoke-test.sh http://localhost:8888 <OPEN-ID-A> <OPEN-ID-B>   # must print SMOKE TEST PASSED
```
Then open the page and confirm: it lands on an OPEN placement; a lock shows the pay link; a reload keeps LOCKED
and the uploaded logo. `FAIL_INVOICE=1 node scripts/mock-services.mjs` exercises failure → owner alert → retry.
Reset the local sandbox between runs with `rm -rf .netlify/blobs-serve`.

## Phase 3 — Launch

Follow `reference/launch-checklist.md` sections A–E exactly. Highlights: link the Netlify site to the repo and
deploy only through Git; secrets via `netlify env:set KEY value --secret --context production deploy-preview
branch-deploy`; Resend domain verified (DKIM + SPF) and `NOTIFY_FROM` set; Stripe test key first, live key after
the dry run; portal DNS record **DNS only** if Cloudflare; CSP `frame-ancestors` includes the marketing site.
Finish with the **real dry run** (lock with the client's email → invoice + emails arrive → void in Stripe →
`netlify blobs:delete bids <ID>` and `logos <ID>`).

## Phase 4 — Operate

Use the runbook table in `reference/launch-checklist.md` → Operations. The daily job handles the deadline;
the admin endpoint runs it on demand. Bids and contact details live in Netlify → Blobs → `bids`.

## Rules carried over from the original build

- Base every PR on `main`; never stack PRs (a stacked PR merged into its feature branch silently misses `main`).
- After a merge, confirm the Git build is live (`curl` for a string from the change) before reporting done.
- Placement IDs and labels are configured only in the tenant JSON; the build generates the frontend inventory and server allowlist.
- Secrets never appear in chat or commits; set them straight into Netlify with `--secret`.
- Deleting Blobs records is destructive: confirm the ID with the owner and back it up first
  (`netlify blobs:get bids <ID> > backup.json`).
- Real sends (test email, test lock) are real-world side effects: confirm first, use the owner's own address.
- Address every automated PR-review comment (fix or justify, reply on the thread) before calling a PR mergeable.

## Notes per environment

- **Devin / Claude Code / Codex CLI**: you can run everything above directly. Prefer the smoke test over manual curl.
- **Claude.ai / ChatGPT (no shell)**: act as the architect — run the intake, then hand the operator exact
  commands, file diffs and checklist items from the references, and ask for outputs to verify each step.
