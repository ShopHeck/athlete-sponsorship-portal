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
  domain was proxied by Cloudflare, which rewrote `Cache-Control` to `max-age=14400`. Fixed by stamping
  `styles.css?v=<commit>` / `app.js?v=<commit>` at build (`scripts/stamp-assets.mjs`) and sending
  `must-revalidate` for CSS/JS. Still recommend grey-cloud DNS for Netlify hosts.
- **`netlify deploy` fails with "Cannot find module build.mjs"** on a site whose `netlify.toml` has a build
  command you don't have. Use `--no-build --dir .`.
- **A site's source is nowhere on disk / repo is stale.** Recover the exact published deploy via the API:
  `GET /api/v1/deploys/<id>/files` for the list, then each file with header
  `content-type: application/vnd.bitballoon.v1.raw` (public files can also be curled from the deploy URL, but the
  served HTML is post-processed — Netlify Forms markup differs — so take the raw copy for HTML).
- **Netlify secret env vars read back as `***`.** By design. Keep the value elsewhere at creation time.
- **Env var added to the wrong site.** Check with `netlify api getEnvVars --data '{"account_id":…,"site_id":…}'`
  per site; the CLI `env:list` only shows the linked site.

## Bidding / invoicing
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

## Frontend
- **Visitors landed on a SOLD placement ("0 of 6 available").** Default was "first shorts-front slot". Landing
  now picks the first OPEN placement in camera-facing order and waits for sold + live bids. Also: never let the
  auto-rotate visibility check select a sold slot, don't re-select mid programmatic rotation, and bound the
  initial bids wait (4 s race + 8 s abort) so a hung API can't hide the viewer.
- **Uploaded logo disappeared on refresh.** It was a browser-only object URL by design. Now rasterised to a
  ≤800 px PNG, sent with the bid, stored in Blobs `logos`, served at `/api/logos/:id`, rendered for locked/won.
- **Black block under the model inside the embed.** Embed stage was fixed 740 px while the side columns grew.
  Stage now stretches to the grid row. Also `documentElement.scrollHeight` inside an iframe is never smaller than
  the iframe, so the host frame could grow but never shrink — measure `document.body` instead.
- **Bid form and Lock button below the fold on laptops.** Standalone desktop layout is now an exact 100vh flex
  shell; the inventory list absorbs the slack and scrolls. Scoped to `min-width:821px and min-height:600px` so
  short landscape phones keep the scrolling layout.
- **Placement rejected as "Unknown placement".** IDs come from the selected tenant's `portal.config.json`;
  ensure the smoke-test IDs are not in its `sold` map.
- **Headless timing.** In headless Chromium the WebGL scene runs slowly; camera tweens take seconds, so wait
  longer after clicks before asserting rotation-dependent state.

## Process
- **Devin Review comments are usually right.** Address each on its thread (fix + reply) before declaring a PR
  mergeable; re-check for a second review round after pushing.
- **Blob deletions are destructive.** Confirm the placement ID with the owner, back up the record first.
- **Ask before real sends.** A real test email or lock is a real-world side effect — confirm, then do it with the
  owner's own address.
