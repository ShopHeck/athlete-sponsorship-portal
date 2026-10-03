# Tenant launch and operations checklist

## Prepare the tenant

- [ ] Confirm the config filename matches its valid slug under `tenants/`.
- [ ] Confirm the tenant's athlete, event, placements, pricing, deadline, copy, sold map, and contact details.
- [ ] Add artwork under `public/tenants/<slug>/` and confirm all configured asset paths resolve there or are valid
      root-relative/HTTP URLs.
- [ ] Set `status` to `"draft"` and set `embedOrigins` to the exact host origins that may frame this portal.
- [ ] Run `npm run build`; fix every validation error before deploying.

## Platform and services

- [ ] Create/configure the platform's Netlify site and connect the intended repository and production branch.
- [ ] Set `PLATFORM_URL` to the public platform origin; tenant canonical and API links append `/<slug>`.
- [ ] Set a strong global `PREVIEW_TOKEN` and `ADMIN_TOKEN`.
- [ ] Set `DASHBOARD_SECRET` as a Netlify secret for dashboard session signing.
- [ ] Configure `STRIPE_SECRET_KEY` for the correct Stripe account and `RESEND_API_KEY` for a verified sender domain.
- [ ] Set a tenant's `contact.notifyFrom` and `contact.notifyEmail`. `NOTIFY_FROM` is only a global fallback sender.
- [ ] Confirm Stripe and Resend service API bases are production defaults; use mock API bases only in local tests.

## Stripe webhooks

- [ ] Create two Stripe endpoints at `<PLATFORM_URL>/api/stripe/webhook`.
- [ ] The platform-account endpoint subscribes to `invoice.paid`.
- [ ] The Connect endpoint listens to connected-account events (`connect=true`) and subscribes to
      `account.updated`, `account.application.deauthorized`, and `invoice.paid`.
- [ ] Store the endpoint signing secrets as Netlify secrets `STRIPE_WEBHOOK_SECRET` and
      `STRIPE_CONNECT_WEBHOOK_SECRET`.

## Stripe Connect onboarding

For each tenant with `payments.mode: "connect"`:

- [ ] Confirm the application fee and athlete agreement account for the athlete paying Stripe fees and bearing
      refunds and chargebacks; Stripe is liable for unrecoverable negative balances.
- [ ] Set the live `PLATFORM_URL` to the public **HTTPS** origin before onboarding.
- [ ] Start onboarding with `POST /api/<slug>/connect/onboard` and
      `Authorization: Bearer $ADMIN_TOKEN`.
- [ ] Send the returned Stripe-hosted `url` to the athlete so they can complete account setup.
- [ ] Confirm account creation requests both `card_payments` and `transfers`; Stripe requires both for this
      controller combination. Direct charges still use the athlete-liable controller settings.
- [ ] Account links expire. If an athlete returns to an expired link, use the signed `refresh_url` from the link or
      start onboarding again through the admin endpoint to create a fresh link.
- [ ] Check `GET /api/<slug>/connect/status` with the admin token. Bidding is enabled only when charges are enabled
      and `capabilities.card_payments` is `active`; otherwise it remains closed with `copy.paymentsPending`.
- [ ] Confirm invoices and customers are created on the connected athlete account with Stripe's `Stripe-Account`
      header. The athlete uses the full Stripe Dashboard.

## Preview and verify

- [ ] Deploy the tenant while it remains draft and open `/<slug>?preview=<PREVIEW_TOKEN>`.
- [ ] Confirm a request without the preview token returns 404 and the preview response has `cache-control: no-store`.
- [ ] Confirm the preview page sends `x-preview-token` on bid API requests and logo URLs carry `?preview=<PREVIEW_TOKEN>`; requests without the token remain 404.
- [ ] Treat preview bids and locks as real records under the draft tenant slug; use mocks or approved test recipients because the normal email/invoice flow can run.
- [ ] Confirm the tenant-specific CSP includes every required `embedOrigins` value.
- [ ] Verify front/back placement projection, labels, sold logos, poster, model, ring, mobile layout, and embed sizing.
- [ ] Run `scripts/smoke-test.sh <base> <slug> <OPEN-ID-A> <OPEN-ID-B>` with two available IDs.
- [ ] Run `scripts/connect-test.sh <base>` against mock Stripe and Resend before accepting Connect bids.
- [ ] Confirm the tenant-scoped bid and logo endpoints use `/api/<slug>/...` and do not expose other tenants' records.
- [ ] Verify a test bid, notification email, Stripe invoice, recipient, sender, amount, and hosted payment link with
      approved test credentials before accepting real bids.

## Go live

- [ ] Get the athlete's approval of the draft page, placement inventory, pricing, email copy, and sponsor flow.
- [ ] Change `status` to `"live"`, rebuild, and merge/deploy through the normal Git flow.
- [ ] Check `/<slug>` and `/api/<slug>/bids` on the live host; verify page headers and representative asset URLs.
- [ ] Confirm the intended host can frame the portal and the `heck-portal-height` message is handled by its iframe.
- [ ] Send the athlete the public URL, embed snippet, admin-close instructions, and bid/auction operating notes.

## Operations

| Action | Procedure |
| --- | --- |
| Mark a placement sold outside the portal | Add it to the `sold` map in `tenants/<slug>.json`, include its logo, rebuild, and merge/deploy. |
| Reopen a sold placement | Remove its entry from that tenant's `sold` map and rebuild/deploy. Back up any existing bid record first. |
| View public bids | `GET /api/<slug>/bids`; the response does not expose bidder contact details. |
| Close or retry one tenant | `POST /api/close-auction?tenant=<slug>` with `Authorization: Bearer $ADMIN_TOKEN`. |
| Close or retry all non-draft tenants | `POST /api/close-auction` with the same admin token. |
| Preview a draft | Open `/<slug>?preview=<PREVIEW_TOKEN>`; do not share the token publicly. |

Never send a real test email, create a real invoice, delete a Blobs record, or change a live placement without the
owner's explicit approval.
