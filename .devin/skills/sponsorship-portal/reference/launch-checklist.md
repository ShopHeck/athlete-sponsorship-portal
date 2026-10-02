# Launch checklist and operations runbook

## A. Netlify
- [ ] Create the site in the **client's** Netlify team and link the GitHub repo (Site configuration → Build &
      deploy → Link repository, branch `main`). From now on only Git deploys — a CLI `netlify deploy` gets
      overwritten by the next Git build.
- [ ] `netlify.toml` already sets publish `public`, functions dir, esbuild, the asset-stamping build command,
      cache headers and CSP `frame-ancestors`. Add the marketing site's origin to `frame-ancestors`.
- [ ] Locally: `netlify link` to the site so `netlify env:*` and `netlify blobs:*` target it.
- [ ] Env vars (see `configuration.md`). Verify with
      `netlify api getEnvVars --data '{"account_id":"<team>","site_id":"<site>"}'` — names only, values masked.
- [ ] Confirm the scheduled function registered: `netlify functions:list` shows `close-auction` with a schedule.

## B. Resend
- [ ] Add the client's domain in Resend; publish the DKIM TXT and both SPF CNAMEs. **Receiving MX is optional**
      (only for inbound). Status `partially_verified` with DKIM+SPF verified is fine for sending.
- [ ] `NOTIFY_FROM` = `Name <sponsors@domain>`; `NOTIFY_EMAIL` = owner inbox (also reply-to).
- [ ] If the sender domain has no MX at all, mail *to* that address bounces — say so to the client.
- [ ] Send one real test (the smoke test only hits the mock): a lock during the dry run, or
      `node --input-type=module -e 'import {invoiceEmail,sendEmail} from "./netlify/lib/sponsorship.mjs"; …'`
      with `RESEND_API_KEY` in the environment. Check `GET https://api.resend.com/emails/<id>` → `delivered`.

## C. Stripe
- [ ] Use the **client's** Stripe account. Confirm the account in Stripe dashboard → Settings before setting keys
      (an agent-connected MCP account is not necessarily the client's).
- [ ] Start with `sk_test_…`, run the dry run, then swap to `sk_live_…` (`netlify env:set … --secret`).
- [ ] Invoice settings in Stripe: business name, logo, support email, and "Bank transfer" enabled if sponsors
      will pay by ACH. Stripe does not email the invoice (`auto_advance:false`); the portal's Resend email does.
- [ ] Payment terms are "due on receipt" in code (`days_until_due: 0`). Change in `createInvoice()` if needed.

## D. Domain
- [ ] Portal: CNAME `portal` → `<site>.netlify.app`. If DNS is Cloudflare, set **DNS only (grey cloud)** —
      proxying rewrites cache headers to 4 h and breaks fresh deploys (mitigated by asset stamping, but avoid).
- [ ] Add the custom domain in Netlify (or `netlify api updateSite --data '{"site_id":"…","body":{"custom_domain":"…"}}'`)
      and wait for the certificate (`netlify api showSiteTLSCertificate`).
- [ ] Set `PORTAL_URL`, `<link rel=canonical>`, `og:url`, `og:image`, `twitter:image` in `index.html` to the
      final host. Redeploy (merge).
- [ ] If a marketing site will own the "sponsors" subdomain and the portal is embedded, give the portal its
      own host (e.g. `portal.`) and repoint the embed's `src` **and** its `PORTAL_ORIGIN` check together.
- [ ] Optional vanity path (e.g. `athlete.com/portal`): a 301 at the marketing host (Cloudflare Redirect Rule,
      Netlify `_redirects`, or a line in the Worker).

## E. The real dry run (do this, every time)
1. On the live site, pick an open placement, enter the client's name/email, upload a logo, **Lock it now**.
2. Expect: success panel with pay link; sponsor email from `NOTIFY_FROM` with "Pay invoice" button; owner
   notification with Stripe dashboard link; reload shows LOCKED with the logo.
3. Stripe → Invoices → **void** the test invoice.
4. Reset: `netlify blobs:get bids <ID> > backup.json && netlify blobs:delete bids <ID> --force && netlify blobs:delete logos <ID> --force`.
   Confirm `curl https://PORTAL/api/bids` no longer lists it.
5. Verify the portal lands on an OPEN placement and the embed on the marketing site shows no gap under the model.

## F. Distribution (what worked)
- Branded host (`portal.athlete.com`), OG share image so links unfurl as the fight card.
- Deep links per placement `https://PORTAL/#SF-L1` in personal outreach ("your logo on the front-left leg").
- Embed on the marketing site + link in bio; screenshot LOCKED placements as they happen for social urgency.
- Emails already carry the deadline; the portal shows "N of M available".

## Operations

| Task | How |
| --- | --- |
| See all bids and contact details | Netlify dashboard → Blobs → `bids`, or `netlify blobs:list bids` / `netlify blobs:get bids <ID>` |
| Reopen a placement (test lock, withdrawn sponsor) | Void the invoice in Stripe, then `netlify blobs:delete bids <ID> --force` and `netlify blobs:delete logos <ID> --force` (back up first) |
| Mark a placement sold outside the portal | Add it to the tenant's `sold` map in `portal.config.json` with the logo, rebuild, and merge |
| Close the auction early / invoice winners now | `curl -X POST -H "authorization: Bearer $ADMIN_TOKEN" "https://PORTAL/api/close-auction?force=1"` |
| Retry a failed invoice | Same endpoint without `?force=1` (also runs daily automatically) |
| Change prices or deadline | `netlify env:set …` then redeploy (trigger a deploy in Netlify or merge a no-op) |
| Extend the deadline after close | Update `BID_DEADLINE`; closed placements stay closed (`closed:true` on the record) unless the record is deleted |
| Find an invoice | Owner notification email links to `dashboard.stripe.com/invoices/<id>`; also `invoice.id` on the Blobs record |
| Rotate the admin token | `netlify env:set ADMIN_TOKEN "$(openssl rand -hex 24)" --secret --context production deploy-preview branch-deploy`, redeploy, store the new value |

Invoice states on a record: `sent` (created + emailed), `failed` (Stripe error, owner alerted, daily retry),
`skipped` (no `STRIPE_SECRET_KEY` at the time — invoice manually or set the key and let the job retry).
