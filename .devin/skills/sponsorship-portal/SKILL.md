---
name: sponsorship-portal
description: Build, configure, launch and operate a multi-tenant 360° athlete sponsorship portal with a 3D placement picker, live bidding, Lock It Now, Stripe invoicing and Resend email.
---

# Sponsorship portal playbook

This repository is the multi-tenant platform for athlete sponsorship portals. Work through the phases in order and
skip what the user has already completed. Read the relevant reference before editing configuration or launching.

| Reference (`reference/`) | Read it for |
| --- | --- |
| `intake.md` | Client questionnaire and delivery checklist — Phase 0 |
| `configuration.md` | Tenant JSON, placements, sold sponsors, assets, copy, branding, ring and model setup — Phase 1 |
| `launch-checklist.md` | Tenant preview, Netlify, Stripe, Resend, domain, embed, and operations — Phases 2–4 |
| `gotchas.md` | Known build, API, and operational traps |

## How the platform works

- `tenants/<slug>.json` contains each tenant's identity, event, status, placements, pricing, payment mode, ring,
  branding, sponsors, copy, and contact details.
- `public/tenants/<slug>/` contains that tenant's model, poster, and sponsor artwork. Relative paths resolve within
  this directory.
- `scripts/build.mjs` validates every tenant and bundles the configs and page template for Netlify Functions.
- `netlify/functions/portal.mjs` renders each page at `/<slug>`. Draft tenants require the preview token; live and
  closed tenants receive tenant-specific CSP and cache headers.
- Bid and logo routes are `/api/<slug>/bids` and `/api/<slug>/logos/<id>`. Blobs stores are shared by name but keys
  are tenant-prefixed (`<slug>/<placementId>`).
- Stripe events arrive at `/api/stripe/webhook`; signed events update Connect readiness and invoice payment state.
- Dashboard APIs are `/api/dashboard/login`, `/api/dashboard/session`, `/api/dashboard/logout`,
  `/api/dashboard/:slug/link`, `/api/dashboard/:slug/summary`, `/api/dashboard/:slug/export.csv`,
  `/api/dashboard/:slug/placements/:id/{sold,release}`, `/api/dashboard/:slug/connect/onboard`, and
  `/api/dashboard/:slug/onboarding`, `/api/dashboard/:slug/model`, `/api/dashboard/:slug/model/consent`,
  `/api/dashboard/:slug/model/kit`, `/api/dashboard/:slug/model/photos/:angle` (GET/POST), and
  `/api/dashboard/:slug/model/submit`, `/api/dashboard/:slug/model/views/generate`, `/api/dashboard/:slug/model/views/decision`,
  `/api/dashboard/:slug/model/views/:angle`, `/api/dashboard/:slug/model/build/{start,model.glb,thumbnail}`,
  and `/api/dashboard/:slug/model/review`. Athlete studio pages use `/dashboard/:slug/model/studio`.
  Operator pages and APIs are `/admin`, `/admin/:slug/studio`, `/api/admin/session`, `/api/admin/logout`,
  `/api/admin/reviews`, and `/api/admin/:slug/model/{publish,send-back,unpublish}`. Published models are served
  from `/api/:slug/model.glb?v=<job-id>`; draft tenants require the preview token.
  Onboarding progress is stored per tenant in the `onboarding` Blobs store. Model Studio Phase A collects consent,
  kit colours and photos; Phase B generates reference views for athlete approval; Phase C builds and optimizes a
  private GLB only from approved views. Phase D adds the authenticated private studio, athlete approval/rebuild,
  operator review, publish/send-back/unpublish, and versioned public live-model serving without tenant JSON edits.
  The strong-consistency `model-studio` Blobs store uses `<slug>/consent`, `<slug>/kit`,
  `<slug>/photo/<angle>`, `<slug>/submission`, `<slug>/views/job`, `<slug>/views/<job-id>/<angle>`,
  `<slug>/views/<job-id>/errors/<angle>`, `<slug>/views/decision`, `<slug>/build/job`,
  `<slug>/build/<job-id>/processing`, `<slug>/build/<job-id>/model.glb`, `<slug>/build/<job-id>/thumbnail`,
  `<slug>/build/<job-id>/error`, `<slug>/review/athlete`, `<slug>/review/operator`, `<slug>/live/current`, and
  `<slug>/live/<job-id>/model.glb`. Reference generation and 3D builds use `MESHY_API_KEY` and `MESHY_API_BASE`;
  automated tests must override both to the local fake Meshy service. `OPERATOR_EMAIL` is optional and receives
  sign-off notifications. The `model-build-background` function alone externalizes `sharp` and `draco3dgltf`.
  Authenticated summaries and exports also work for draft tenants; all routes require `DASHBOARD_SECRET`,
  and POST requests require a same-origin `Origin`.
- Connect tenants use `/api/<slug>/connect/onboard` and `/api/<slug>/connect/status`; their direct-charge invoices
  are created on the athlete's Stripe account. Bidding stays closed until charges are enabled and the
  `card_payments` capability is active. Account creation requests both `card_payments` and `transfers` because
  Stripe requires both for this controller combination.
- A tenant may use a `demo` block instead of `showcase` for an interactive prospect preview. Demo pages keep every
  placement and local logo preview available, but bids, locks, Connect onboarding, dashboard sales, Model Studio
  changes, and close-auction invoicing are blocked server-side.
- `netlify/lib/sponsorship.mjs` exports `forTenant(config, { portalUrl })`, which closes email, invoice, pricing,
  and placement helpers over one tenant.
- The scheduled job processes every non-draft tenant; the admin close endpoint may process all non-draft tenants or
  one selected tenant.

## Phase 0 — Intake

Complete `reference/intake.md` with the client. Collect the athlete and event details, garments and placement
geometry, sold sponsors and artwork, pricing and deadline, branding, model/poster assets, embed origins, the
owner-notification inbox, and access to the client's Stripe and Resend accounts.

## Phase 1 — Configure a tenant

1. Add `tenants/<slug>.json`, with a lowercase slug that matches the filename. Start with `"status": "draft"`.
2. Add tenant-specific files under `public/tenants/<slug>/` and use relative asset paths in the config.
3. Define every placement in `garments[].placements`. IDs must be unique within the tenant and no longer than
   eight characters; the build generates the server allowlist and email labels from this data.
4. Add confirmed placements and their logos to the config's `sold` map.
5. Configure athlete, event, SEO, hero, benefits, copy, contact, pricing, required `payments` mode, brand, ring, and optional poster values.
   Pricing, deadlines, event names, and notification inboxes come from tenant config, not per-site overrides.
6. Run `npm run build`. Preview `/<slug>?preview=$PREVIEW_TOKEN`; the page sends the token in `x-preview-token`
   on bid API requests and in the query string on logo image requests. After review, switch the tenant to `"live"`
   and rebuild.

Draft previews run the normal bid/lock flow. Those bids are real Blobs records scoped to the draft tenant, and can
send real emails or create invoices if production services are configured. Use mocks or approved test recipients;
the scheduled close job skips drafts.

For schema and path details, follow `reference/configuration.md`.

## Phase 2 — Local integration test

Use only mock Stripe and Resend credentials:

```bash
MOCK_PORT=4343 node scripts/mock-services.mjs
PREVIEW_TOKEN=devpreview ADMIN_TOKEN=devtoken PLATFORM_URL=http://localhost:8890 \
STRIPE_SECRET_KEY=sk_test_mock STRIPE_API_BASE=http://127.0.0.1:4343 \
STRIPE_WEBHOOK_SECRET=whsec_platform_test STRIPE_CONNECT_WEBHOOK_SECRET=whsec_connect_test \
DASHBOARD_SECRET=devdashboard OPERATOR_EMAIL=ops@example.test \
RESEND_API_KEY=re_mock RESEND_API_BASE=http://127.0.0.1:4343 \
MESHY_API_KEY=mock_key MESHY_API_BASE=http://127.0.0.1:4343 \
npx netlify dev --offline --port 8890
scripts/smoke-test.sh http://localhost:8890 <slug> <OPEN-ID-A> <OPEN-ID-B>
scripts/tenant-test.sh http://localhost:8890
scripts/connect-test.sh http://localhost:8890
scripts/webhook-test.sh http://localhost:8890
scripts/dashboard-test.sh http://localhost:8890
scripts/studio-test.sh http://localhost:8890
```

Reset the local Blobs sandbox and restart the mock service before each test run with `rm -rf .netlify/blobs-serve`.
The dashboard integration test prints `DASHBOARD TEST PASSED`; configure `DASHBOARD_SECRET` as a Netlify secret
for deployed dashboard APIs.
Never run test locks or real emails against production without the owner's explicit confirmation.

## Phase 3 — Launch

Follow `reference/launch-checklist.md` for the tenant's Netlify site, production credentials, domain, frame origins,
and host embed. For Connect tenants, onboard the athlete through the admin endpoint and confirm status is ready
before accepting bids. Connect customers and invoices are scoped to the athlete's account; the athlete pays Stripe
fees and bears refund and chargeback exposure. Confirm the draft preview, switch to live only after approval, then
smoke-test the live page and tenant API.

## Phase 4 — Operate

Use `/api/<slug>/bids` for that tenant's public bid summary. `POST /api/close-auction` requires `ADMIN_TOKEN`;
pass `?tenant=<slug>` to process one non-draft tenant or omit it to process every non-draft tenant. Confirm with
the owner before deleting Blobs records or sending a real test email.
