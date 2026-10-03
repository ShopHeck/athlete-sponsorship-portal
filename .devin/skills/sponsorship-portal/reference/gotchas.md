# Gotchas — every trap hit while building the original portal

Check here before debugging. Each entry: symptom → cause → fix (already in the code unless marked *process*).

## Deploy and hosting
- **Merged the PR but nothing changed on the live site.** The Netlify site was not linked to Git; every earlier
  deploy had been a manual `netlify deploy`. *Process:* link the repo once, then never CLI-deploy again.
- **Feature vanished after connecting the repo.** The first Git build of `main` replaced a CLI deploy of an
  unmerged branch. *Process:* only deploy what is on `main`.
- **PR "merged" but its commit isn't on `main`.** It was stacked on another PR's branch and got merged into that
  branch. *Process:* base every PR on `main`; if you must stack, include the parent commits so merge order
  doesn't matter, and check `git branch -r --contains <sha>` after merging.
- **New HTML with old CSS/JS → broken layout (giant poster card, grey floor, undarkened backdrop).** The custom
  domain was proxied by Cloudflare, which rewrote `Cache-Control` to `max-age=14400`. Tenant pages reference
  versioned `/styles.css?v=<version>` and `/app.js?v=<version>` URLs from the generated platform bundle; retain
  the CSS/JS `must-revalidate` headers. Still recommend grey-cloud DNS for Netlify hosts.
- **`netlify deploy` fails with "Cannot find module build.mjs"** on a site whose `netlify.toml` has a build
  command you don't have. Use `--no-build --dir .`.
- **A site's source is nowhere on disk / repo is stale.** Recover the exact published deploy via the API:
  `GET /api/v1/deploys/<id>/files` for the list, then each file with header
  `content-type: application/vnd.bitballoon.v1.raw` (public files can also be curled from the deploy URL, but the
  served HTML is post-processed — Netlify Forms markup differs — so take the raw copy for HTML).
- **Netlify secret env vars read back as `***`.** By design. Keep the value elsewhere at creation time.
- **Env var added to the wrong site.** Check with `netlify api getEnvVars --data '{"account_id":…,"site_id":…}'`
  per site; the CLI `env:list` only shows the linked site.
- **Switching athletes appears to require a rebuild.** Tenant pages and APIs are selected by URL slug
  (`/<slug>` and `/api/<slug>/…`), so switching tenants does not require a separate build or server restart.
  Rebuild the platform registry after editing tenant configs; restart local Netlify Dev when it needs to reload
  that generated registry.

## Bidding / invoicing
- **Webhook signature verification fails after parsing JSON.** Stripe signs the exact request bytes. Verify
  `stripe-signature` against the raw body before parsing the event; configure both platform and Connect endpoint
  secrets.
- **Webhook event is ignored despite a valid signature.** The livemode guard accepts only events whose `livemode`
  matches whether `STRIPE_SECRET_KEY` contains `_live_`; test-key deployments ignore live events and vice versa.
- **Dashboard sign-in links were consumed by an email scanner.** Serve the sign-in link on the dashboard GET page and
  require an explicit POST confirmation; email security scanners may prefetch GET links.
- **The global `PREVIEW_TOKEN` appeared in a dashboard request or response.** It is only for draft portal APIs and
  must never be passed to or exposed by the dashboard.
- **Paid invoice was re-created by the close job.** `invoice.status === "sent"` remains the invoice retry guard.
  Record payment separately in `invoice.paidAt` (and `amountPaid`) when handling `invoice.paid`; never replace
  `"sent"` with a paid status.
- **Connect invoice finalization failed.** Direct-charge invoices and their customers must be created on the
  connected athlete account using Stripe's `Stripe-Account` header. The bid API gates bidding on charges being
  enabled plus `card_payments` being `active`.
- **Athlete's Stripe onboarding link expired.** Account links are temporary; use its signed refresh URL to issue a
  fresh Stripe-hosted link or call the admin onboarding endpoint again.
- **Who pays fees or bears payment losses?** Direct charges make the athlete the merchant of record: Stripe fees,
  refunds, and chargebacks affect the athlete's balance. With `controller.losses.payments=stripe`, Stripe is liable
  for unrecoverable negative balances. Connect athletes receive the full Stripe Dashboard.
- **Connect account has incompatible controller settings.** Stripe Dashboard type is immutable. Accounts created
  with other controller settings must be replaced with a new account; do not reuse a destination-charge/Express
  account for direct charges.
- **Connect card payments remain unavailable.** Stripe requires both `card_payments` and `transfers` to be requested
  for this controller combination. Requesting `transfers` does not turn these direct charges into destination
  charges or change the controller's liability allocation; readiness still requires `card_payments` to be active.
- **Stripe rejected an account-create retry as an idempotency mismatch.** Stripe caches idempotency keys with their
  request parameters for 24 hours. Use a new key whenever Connect account creation parameters change.
- **Every successful lock showed "Network error" in the UI even though the server saved it.** `busy.textContent =
  "Sending…"` wiped the `<span>` inside the lock button that `renderBidPanel()` writes to, so a re-render threw
  inside the `try`. Fixed with a dedicated `#lockLabel` span and a `submitBid.busy` guard.
- **Lock succeeded but no success panel / pay link.** `.selection-card.is-sold .bid-panel {display:none}` hid the
  whole bid panel — including the success block inside it — the moment the placement became locked. The success
  block now lives outside `.bid-panel`.
- **Invoice created but sponsor got no email / owner got "Sponsor was NOT emailed".** `NOTIFY_FROM` still the
  Resend default `onboarding@resend.dev`, which only delivers to the Resend account owner. Verify a domain.
- **`API key is invalid` from Resend** while probing with the key read from Netlify: it was the masked `***`
  secret, not the key. Read it from a non-secret copy or the client's vault.
- **Wrong Stripe account.** The Stripe account connected to an agent's MCP may not be the client's. The
  functions use whatever `STRIPE_SECRET_KEY` is set — confirm the account name in the dashboard before going live.
- **Test lock on production.** Fine — void the invoice in Stripe and delete the `bids`/`logos` records. The
  record was the only thing making the placement LOCKED.
- **Mock email or invoice shows the wrong athlete.** Use dummy Stripe/Resend keys and point both
  `STRIPE_API_BASE` and `RESEND_API_BASE` at the same local mock service. Inspect `.netlify/mock-log.jsonl` for
  tenant copy, sender, and invoice amounts; do not open mock invoice URLs expecting real checkout.

## Frontend
- **Visitors landed on a SOLD placement ("0 of 6 available").** Default was "first shorts-front slot". Landing
  now picks the first OPEN placement in camera-facing order and waits for sold + live bids. Also: never let the
  auto-rotate visibility check select a sold slot, don't re-select mid programmatic rotation, and bound the
  initial bids wait (4 s race + 8 s abort) so a hung API can't hide the viewer.
- **Uploaded logo disappeared on refresh.** It was a browser-only object URL by design. Now rasterised to a
  ≤800 px PNG, sent with the bid, stored in Blobs `logos` under `<slug>/<placementId>`, served at
  `/api/:slug/logos/:id`, rendered for locked/won.
- **Black block under the model inside the embed.** Embed stage was fixed 740 px while the side columns grew.
  Stage now stretches to the grid row. Also `documentElement.scrollHeight` inside an iframe is never smaller than
  the iframe, so the host frame could grow but never shrink — measure `document.body` instead.
- **Bid form and Lock button below the fold on laptops.** Standalone desktop layout is now an exact 100vh flex
  shell; the inventory list absorbs the slack and scrolls. Scoped to `min-width:821px and min-height:600px` so
  short landscape phones keep the scrolling layout.
- **Placement rejected as "Unknown placement".** IDs come from `tenants/<slug>.json`; ensure smoke-test IDs are
  defined in that tenant's config and are not in its `sold` map.
- **“Bidding unavailable offline” appears during local testing.** Netlify Dev bid GETs can intermittently time
  out, leaving bidding unavailable until the next poll succeeds. Time consecutive requests to
  `/api/<slug>/bids` before attributing the symptom; do not change frontend timeout values to mask it.
- **Draft preview bid changed tenant state.** A valid preview token authorizes the normal bid/lock flow, and its
  records persist under the draft tenant's slug; configured real email/Stripe services can still send/create.
  Use mocks or approved test recipients, and remember the scheduled close job skips drafts.
- **Local iframe is blocked by CSP.** Each tenant's `embedOrigins` controls permitted parent origins. Use a
  permitted parent to verify actual framing; a top-level `?embed` page plus a `heck-portal-height` message
  listener can separately check height messages, but does not prove the parent is allowed.
- **Headless timing.** In headless Chromium the WebGL scene runs slowly; camera tweens take seconds, so wait
  longer after clicks before asserting rotation-dependent state.

## Process
- **Devin Review comments are usually right.** Address each on its thread (fix + reply) before declaring a PR
  mergeable; re-check for a second review round after pushing.
- **Blob deletions are destructive.** Confirm the placement ID with the owner, back up the record first.
- **Ask before real sends.** A real test email or lock is a real-world side effect — confirm, then do it with the
  owner's own address.
