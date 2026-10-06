# Athlete Sponsorship Portal

A multi-tenant platform for embeddable 360° athlete sponsorship portals. Each tenant has a config at
`tenants/<slug>.json` and assets under `public/tenants/<slug>/`; tenant pages are served at
`https://athletes.michaelheckert.com/<slug>`.

## Add a tenant

1. Add a uniquely named `tenants/<slug>.json` file. The filename must match its lowercase slug.
2. Add tenant-specific assets under `public/tenants/<slug>/`. Relative model, poster, and sold-logo paths resolve
   from that directory. Root-relative and HTTP URLs can be used for shared or externally hosted assets.
3. Set `"status": "draft"` and add the tenant's embed origins, athlete/event details, placements, pricing, payment
   mode, ring, branding, benefits, contact details, and copy.
4. Run `npm run build`, then preview at `/<slug>?preview=$PREVIEW_TOKEN`. After review, change status to `"live"`
   and rebuild.

Draft preview pages pass the token to bid APIs in the `x-preview-token` header; logo requests use the `preview`
query parameter. Preview bids and locks use the normal flow and persist as real Blobs records under the draft
tenant's slug, and can send normal emails/invoices if real services are configured. Use local mocks or approved
test recipients; draft tenants remain excluded from the scheduled close job.

Placement IDs and labels are defined in `garments[].placements`; IDs must be unique per tenant and no longer than
eight characters. Confirmed sponsors live in the config's `sold` map. Pricing, deadline, event, and owner inbox
values are tenant-configured rather than selected with per-site environment overrides.

## Payments

Every tenant config sets `payments.mode` to `"platform"` or `"connect"`. Michael uses the platform account; Connect
tenants must finish Stripe-hosted onboarding and have charges enabled with `card_payments` active before bids are
accepted. Connect invoices are direct charges on the athlete's Stripe account with the configured `feePercent`
application fee. The athlete pays Stripe fees and bears refunds and chargebacks; Stripe is liable for unrecoverable
negative balances. Connect athletes receive the full Stripe Dashboard. Stripe requires both `card_payments` and
`transfers` to be requested for this controller combination; the transfers capability does not change direct-charge
liability.
Use `POST /api/<slug>/connect/onboard` with the admin Bearer token to create an onboarding link, send the returned
URL to the athlete, then verify readiness with `GET /api/<slug>/connect/status`.

## Build and local development

```bash
npm install
npm run build
npx netlify dev --offline --port 8890
```

`npm run build` validates every tenant, renders each once as a smoke check, and generates the ignored
`netlify/lib/platform.generated.json` bundle. The root `public/index.html` is only a small platform placeholder;
tenant pages are rendered per request.

## Local integration tests

Build the test-only platform tenant before running the payment-flow tests; production builds omit it. Use the mock
Stripe and Resend endpoints and do not use real credentials:

```bash
INCLUDE_TEST_TENANTS=1 npm run build
MOCK_PORT=4343 node scripts/mock-services.mjs
```

In another terminal:

```bash
PREVIEW_TOKEN=devpreview ADMIN_TOKEN=devtoken PLATFORM_URL=http://localhost:8890 \
STRIPE_SECRET_KEY=sk_test_mock STRIPE_API_BASE=http://127.0.0.1:4343 \
RESEND_API_KEY=re_mock RESEND_API_BASE=http://127.0.0.1:4343 \
npx netlify dev --offline --port 8890
```

Reset only this checkout's Blobs sandbox with `rm -rf .netlify/blobs-serve` before each test:

```bash
scripts/smoke-test.sh http://localhost:8890 platform-fixture SB-R1 TF-12
scripts/tenant-test.sh http://localhost:8890
scripts/connect-test.sh http://localhost:8890
scripts/dashboard-test.sh http://localhost:8890
scripts/selfserve-test.sh http://localhost:8890
scripts/studio-test.sh http://localhost:8890
scripts/apply-test.sh http://localhost:8890
```

The smoke-test signature is `[base-url] [slug] [open-placement-A] [open-placement-B]`. Choose two IDs defined
in the tenant config, absent from its `sold` map, and with no existing local bid records.

## Runtime architecture

- `scripts/build.mjs` validates tenant configs and bundles their registry with the HTML template.
- `netlify/functions/portal.mjs` renders live or closed tenants at `/<slug>`; draft tenants require the preview
  token. A valid draft page includes the token only in its inlined config and is not cached. Draft API requests
  require the `x-preview-token` header; logo requests also accept `?preview=<token>`. A tenant-specific CSP
  controls which sites may frame its portal.
- `GET` and `POST /api/<slug>/bids` expose tenant-scoped bid data. Logo images are served from
  `/api/<slug>/logos/<id>`. Blobs stores remain named `bids` and `logos`, with keys prefixed by `<slug>/`.
- `POST /api/apply` accepts founding-athlete applications, stores them in the strong-consistency `applications`
  Blobs store, and rate-limits by a SHA-256 hash of the client IP.
- Operators review applications at `/admin`; approved athletes receive a dynamically provisioned private portal.
  Dynamic settings and athlete-controlled launch use `/api/dashboard/:slug/settings` and `/api/dashboard/:slug/launch`.
  Event, pricing, dates and placements are locked after launch.
  Dynamic tenant writes are serialized per slug within an instance; concurrent writes across instances may race.
- `POST /api/<slug>/connect/onboard` and `GET /api/<slug>/connect/status` require the admin token. Connect tenants
  cannot accept bids until charges are enabled and `card_payments` is active. Their customers and invoices live on
  the connected account and are accessed with Stripe's `Stripe-Account` header.
- `POST /api/close-auction` is admin-only. It processes every non-draft tenant, or one tenant when passed
  `?tenant=<slug>`. The scheduled daily job processes all non-draft tenants.
- Stripe creates invoice links; the portal does not charge cards. Resend sends bid confirmations, outbid notices,
  invoices, and owner notifications. Global credentials and service API bases are environment variables; tenant
  business settings stay in each tenant config.
- The frontend uses a tenant's model and placement geometry in a Three.js scene. The `heck-portal-height`
  `postMessage` type is retained for embedded hosts.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `STRIPE_SECRET_KEY` | Stripe credentials for invoice creation; use mock credentials locally. |
| `RESEND_API_KEY` | Resend credentials for email; use mock credentials locally. |
| `STRIPE_API_BASE`, `RESEND_API_BASE` | Optional service API bases, typically pointed at the mock server in tests. |
| `PLATFORM_URL` | Platform origin used to construct tenant page and API links. |
| `PREVIEW_TOKEN` | Allows draft page preview through `?preview=<token>` and draft API access via `x-preview-token` (logo URLs may use the query token). |
| `ADMIN_TOKEN` | Bearer token required for admin auction and Connect onboarding/status endpoints. |
| `NOTIFY_FROM` | Global fallback sender when a tenant does not define `contact.notifyFrom`. |

## Skill and agent references

The tenant setup and operating playbook lives in `.devin/skills/sponsorship-portal/` (`SKILL.md` and the
configuration, launch checklist, and gotchas references). `AGENTS.md` contains repository commands and rules.
Package the skill for client handoff with `scripts/package-skill.sh`.
