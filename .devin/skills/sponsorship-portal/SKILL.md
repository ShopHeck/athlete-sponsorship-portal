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

- `tenants/<slug>.json` contains each tenant's identity, event, status, placements, pricing, ring, branding, sponsors,
  copy, and contact details.
- `public/tenants/<slug>/` contains that tenant's model, poster, and sponsor artwork. Relative paths resolve within
  this directory.
- `scripts/build.mjs` validates every tenant and bundles the configs and page template for Netlify Functions.
- `netlify/functions/portal.mjs` renders each page at `/<slug>`. Draft tenants require the preview token; live and
  closed tenants receive tenant-specific CSP and cache headers.
- Bid and logo routes are `/api/<slug>/bids` and `/api/<slug>/logos/<id>`. Blobs stores are shared by name but keys
  are tenant-prefixed (`<slug>/<placementId>`).
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
5. Configure athlete, event, SEO, hero, benefits, copy, contact, pricing, brand, ring, and optional poster values.
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
RESEND_API_KEY=re_mock RESEND_API_BASE=http://127.0.0.1:4343 \
npx netlify dev --offline --port 8890
scripts/smoke-test.sh http://localhost:8890 <slug> <OPEN-ID-A> <OPEN-ID-B>
scripts/tenant-test.sh http://localhost:8890
```

Reset the local Blobs sandbox before each test run with `rm -rf .netlify/blobs-serve`. Never run test locks or real
emails against production without the owner's explicit confirmation.

## Phase 3 — Launch

Follow `reference/launch-checklist.md` for the tenant's Netlify site, production credentials, domain, frame origins,
and host embed. Confirm the draft preview, switch to live only after approval, then smoke-test the live page and
tenant API.

## Phase 4 — Operate

Use `/api/<slug>/bids` for that tenant's public bid summary. `POST /api/close-auction` requires `ADMIN_TOKEN`;
pass `?tenant=<slug>` to process one non-draft tenant or omit it to process every non-draft tenant. Confirm with
the owner before deleting Blobs records or sending a real test email.
