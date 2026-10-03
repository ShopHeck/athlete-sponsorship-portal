# athlete-sponsorship-portal — agent notes

Multi-tenant platform for 360° athlete sponsorship portals (3D placement picker, live bidding, Lock It Now,
Stripe invoicing, Resend email). Tenant pages are served at
`https://athletes.michaelheckert.com/<slug>`.

**Playbook:** `.devin/skills/sponsorship-portal/SKILL.md` (also linked from `.claude/skills/` and
`.agents/skills/`). Read it before building a new portal, changing placements/pricing/copy, launching or
operating one. `reference/gotchas.md` first when debugging.

## Commands
- Build and validate every tenant: `npm run build`
- Dev server (functions + Blobs sandbox): run `npm run build` first, then `npx netlify dev`
- End-to-end test, no real Stripe/Resend:
  `MOCK_PORT=4343 node scripts/mock-services.mjs &` then `netlify dev` with
  `STRIPE_API_BASE`/`RESEND_API_BASE=http://127.0.0.1:4343`, `PLATFORM_URL=http://localhost:8890`,
  `PREVIEW_TOKEN=devpreview`, `ADMIN_TOKEN=devtoken`, `STRIPE_WEBHOOK_SECRET=whsec_platform_test`, and
  `STRIPE_CONNECT_WEBHOOK_SECRET=whsec_connect_test`, `DASHBOARD_SECRET=devdashboard`,
  `MESHY_API_KEY=mock_key`, and `MESHY_API_BASE=http://127.0.0.1:4343` (see `scripts/smoke-test.sh` header), then
  `scripts/smoke-test.sh http://localhost:8890 michael-heckert <OPEN-ID-A> <OPEN-ID-B>` and
  `scripts/tenant-test.sh http://localhost:8890` and
  `scripts/connect-test.sh http://localhost:8890` and
  `scripts/webhook-test.sh http://localhost:8890` and
  `scripts/dashboard-test.sh http://localhost:8890`
  → must print `SMOKE TEST PASSED`, `TENANT TEST PASSED`, `CONNECT TEST PASSED`, `WEBHOOK TEST PASSED`,
  and `DASHBOARD TEST PASSED`.
  Reset the sandbox with `rm -rf .netlify/blobs-serve` and restart the mock service before each script.
- Syntax check: `for f in public/app.js public/arena.js netlify/lib/*.mjs netlify/functions/*.mjs scripts/*.mjs; do node --check "$f" || exit 1; done; for f in scripts/*.sh; do bash -n "$f" || exit 1; done`
- Package the skill for Claude / Codex / ChatGPT: `scripts/package-skill.sh` → `dist/skill/`
- Production deploys happen from Git (`main`) via Netlify; do not `netlify deploy` a linked site.

## Rules
- Base PRs on `main`; never stack. Verify the Netlify build is live after merging.
- Placement IDs and labels live only in `tenants/<slug>.json` under `garments[].placements`; the build generates the server allowlist and labels from these configs.
- Add a tenant with `tenants/<slug>.json` and `public/tenants/<slug>/` assets. Set `status` to `draft`, preview with `?preview=$PREVIEW_TOKEN`, and change it to `live` after approval. Draft preview pages pass the token to bid APIs; preview bids are real records scoped to that tenant.
- Every tenant config requires `payments.mode` (`platform` or `connect`); Connect mode also sets `feePercent` and optional two-letter country. Connect uses direct charges; account creation requests `card_payments` and `transfers` because Stripe requires both. Bidding stays closed until charges are enabled and `card_payments` is active.
- Tenant API routes are `/api/<slug>/bids`, `/api/<slug>/logos/<id>`, and `/api/<slug>/connect/{onboard,status}`;
  Stripe webhooks use `/api/stripe/webhook`. Dashboard APIs are `/api/dashboard/login`, `/session`, `/logout`,
  `/:slug/link`, `/:slug/summary`, `/:slug/export.csv`, `/:slug/placements/:id/{sold,release}`, and
  `/:slug/connect/onboard`, `/:slug/model`, `/:slug/model/{consent,kit,submit}`,
  `/:slug/model/photos/:angle`, `/:slug/model/views/{generate,decision,:angle}`, and
  `/:slug/model/build/{start,model.glb,thumbnail}`; they require `DASHBOARD_SECRET`, and POSTs require a
  same-origin `Origin`. Model Studio Phases B–C use `MESHY_API_KEY` and optional `MESHY_API_BASE` (default
  `https://api.meshy.ai`); local tests must override both to use the fake Meshy service. Phase C builds only from
  approved views and stores GLBs privately in the `model-studio` Blobs store. The
  `model-build-background` function externalizes `sharp` and `draco3dgltf`. Blobs records are tenant-prefixed.
- Secrets only via `netlify env:set … --secret`; never in chat, code or commits. Set `DASHBOARD_SECRET` and
  `MESHY_API_KEY` as Netlify secrets for deployed dashboard and Model Studio APIs.
- Blobs deletions are destructive: confirm the placement ID and back up first.
- Real test emails / locks need explicit confirmation and the owner's own address.
- Address every automated PR-review comment before calling a PR mergeable.
