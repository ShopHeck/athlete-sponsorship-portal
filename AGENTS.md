# athlete-sponsorship-portal — agent notes

Multi-tenant platform for 360° athlete sponsorship portals (3D placement picker, live bidding, Lock It Now,
Stripe invoicing, Resend email). Tenant pages are served at
`https://athletes.michaelheckert.com/<slug>`.

**Playbook:** `.devin/skills/sponsorship-portal/SKILL.md` (also linked from `.claude/skills/` and
`.agents/skills/`). Read it before building a new portal, changing placements/pricing/copy, launching or
operating one. `reference/gotchas.md` first when debugging.

## Commands
- Build and validate every tenant: `npm run build`
- Unit tests (no server needed): `node --test scripts/*.test.mjs`; one file or test:
  `node --test --test-name-pattern="<name>" scripts/motion.test.mjs`. `npm test` is a stub; do not use it.
- Dev server (functions + Blobs sandbox): run `npm run build` first, then `npx netlify dev --offline --port 8890`
- End-to-end test, no real Stripe/Resend/Meshy:
  First build the test-only tenant registry with `INCLUDE_TEST_TENANTS=1 npm run build`.
  `MOCK_PORT=4343 node scripts/mock-services.mjs &` then `npx netlify dev --offline --port 8890` with
  `STRIPE_SECRET_KEY=sk_test_mock`, `RESEND_API_KEY=re_mock`,
  `STRIPE_API_BASE`/`RESEND_API_BASE=http://127.0.0.1:4343`, `PLATFORM_URL=http://localhost:8890`,
  `PREVIEW_TOKEN=devpreview`, `ADMIN_TOKEN=devtoken`, `STRIPE_WEBHOOK_SECRET=whsec_platform_test`, and
  `STRIPE_CONNECT_WEBHOOK_SECRET=whsec_connect_test`, `DASHBOARD_SECRET=devdashboard`,
  `OPERATOR_EMAIL=ops@example.test`, `MESHY_API_KEY=mock_key`, and
  `MESHY_API_BASE=http://127.0.0.1:4343` (see `scripts/smoke-test.sh` header), then
  `scripts/smoke-test.sh http://localhost:8890 platform-fixture SB-R1 TF-12` and
  `scripts/tenant-test.sh http://localhost:8890` and
  `scripts/connect-test.sh http://localhost:8890` and
  `scripts/webhook-test.sh http://localhost:8890` and
  `scripts/dashboard-test.sh http://localhost:8890` and
  `scripts/selfserve-test.sh http://localhost:8890` and
  `scripts/studio-test.sh http://localhost:8890` and
  `scripts/apply-test.sh http://localhost:8890`
  → must print `SMOKE TEST PASSED`, `TENANT TEST PASSED`, `CONNECT TEST PASSED`, `WEBHOOK TEST PASSED`,
  `DASHBOARD TEST PASSED`, `SELFSERVE TEST PASSED`, `STUDIO TEST PASSED`, and `APPLY TEST PASSED`.
  Reset the sandbox with `rm -rf .netlify/blobs-serve` and restart the mock service before each script.
- Syntax check: `for f in public/*.js netlify/lib/*.mjs netlify/functions/*.mjs scripts/*.mjs; do node --check "$f" || exit 1; done; for f in scripts/*.sh; do bash -n "$f" || exit 1; done`
- Package the skill for Claude / Codex / ChatGPT: `scripts/package-skill.sh` → `dist/skill/`
- Production deploys happen from Git (`main`) via Netlify; do not `netlify deploy` a linked site.

## Architecture
- **No framework, no frontend bundler.** Netlify Functions (`netlify/functions/*.mjs`, esbuild) each declare their
  own route via `export const config = { path }`; `netlify.toml` has no redirects. The browser loads plain ES
  modules from `public/`; `three` and MediaPipe are copied into the ignored `public/vendor/` by the build.
- **Static tenant registry.** `scripts/build.mjs` validates `tenants/*.json` with `netlify/lib/validate.mjs`,
  smoke-renders each, and writes the ignored `netlify/lib/platform.generated.json` (configs + `src/index.template.html`).
  Functions import that file, so rebuild after any tenant, template or validator change.
  `INCLUDE_TEST_TENANTS=1` also pulls in `scripts/fixtures/tenants/` (e.g. `platform-fixture`).
- **Dynamic (self-serve) tenants.** `netlify/lib/tenant-store.mjs` stores athlete settings plus a starter `kitId`;
  `starter-kits.mjs` `materializeConfig` expands them into a full config that passes the same `validateConfig`.
  `netlify/lib/tenants.mjs` `getTenant` resolves static first, then dynamic; `resolveTenantForApi` applies
  draft/preview-token rules for API handlers.
- **Rendering.** `portal.mjs` → `render.mjs` fills the `{{…}}` template and inlines the tenant config as
  `#portal-config`. `public/app.js` is the Three.js viewer and bid UI; `arena.js` builds ring styles, `motion.js`
  handles rigged clips and skinned decals. `dashboard.js`, `studio.js`, `admin.js` drive the athlete and operator UIs.
- **Sponsorship logic.** `netlify/lib/sponsorship.mjs` `forTenant(config)` returns tenant-bound bid/lock/invoice/
  email handlers (Stripe and Resend over raw `fetch`, base URLs overridable for mocks). `connect.mjs` decides
  platform vs. connected account. `lib/close-auction.mjs` is shared by the `@daily` `close-auction` function and
  the admin `/api/close-auction` endpoint.
- **Model Studio.** `dashboard-api.mjs` drives `reference-views.mjs` (Meshy image generation, athlete approval) →
  `model-build.mjs` `startBuild`, which POSTs to `model-build-background` signed with `x-build-signature`
  (HMAC of `DASHBOARD_SECRET`) → `model-build-process.mjs` (`optimize-glb`, `rig-animations`, `skin-cleanup`) →
  `model-review.mjs` publishes a live pointer served by `live-model.mjs`.
- **Auth.** `netlify/lib/dashboard-auth.mjs` owns emailed login tokens, athlete and admin session cookies, and the
  same-origin check.
- **Tests.** The `scripts/*-test.sh` suites are curl-based black-box tests against `netlify dev`;
  `scripts/mock-services.mjs` fakes Stripe, Resend and Meshy (`/__mock/...` control endpoints).

## Rules
- Base PRs on `main`; never stack. Verify the Netlify build is live after merging.
- Placement IDs and labels live only in `tenants/<slug>.json` under `garments[].placements`; the build generates the server allowlist and labels from these configs.
- Add a tenant with `tenants/<slug>.json` and `public/tenants/<slug>/` assets. Set `status` to `draft`, preview with `?preview=$PREVIEW_TOKEN`, and change it to `live` after approval. Draft preview pages pass the token to bid APIs; preview bids are real records scoped to that tenant.
- Optional `ring.style` selects `"ropes"` (default), `"octagon"`, `"boxing"`, or `"mat"`; `ring.backdrop` supplies a tenant arena image when no poster is configured. Mat rings accept two optional hex `matColors`.
- A tenant with a `demo` block is a read-only showcase: bidding, locking, Connect onboarding, dashboard sales, Model Studio changes, and auction invoicing are disabled server-side.
- Every tenant config requires `payments.mode` (`platform` or `connect`); Connect mode also sets `feePercent` and optional two-letter country. Connect uses direct charges; account creation requests `card_payments` and `transfers` because Stripe requires both. Bidding stays closed until charges are enabled and `card_payments` is active.
- `POST /api/apply` stores founding-athlete applications in the strong-consistency `applications` Blobs store;
  hourly rate-limit keys contain only a SHA-256 hash of the client IP.
- Self-serve tenants are stored in the strong-consistency `tenants` Blobs store under `tenant/<slug>`. Static tenants
  win conflicts; draft previews use slug-bound HMAC tokens, and athletes press Go live after launch checks pass.
  Event, pricing, dates and placements are locked after launch.
  Per-slug writes are serialized within an instance; cross-instance races are not prevented.
  Placement removal and bid/sale creation each write first and then recheck the other store, so a placement with activity cannot be removed.
- Dynamic dashboard settings may rename kit placements and select an arena/backdrop; placement IDs and geometry stay
  kit-defined. Poster variants and offline-sale sponsor logos are stored in the strong-consistency `tenant-assets`
  Blobs store under tenant-prefixed keys; poster metadata is written only by poster endpoints.
- Tenant API routes are `/api/<slug>/bids`, `/api/<slug>/logos/<id>`, and `/api/<slug>/connect/{onboard,status}`;
  public dynamic poster assets use `/api/<slug>/poster/:variant?v=<version>` and offline-sale sponsor logos use
  `/api/<slug>/sponsor-logos/:id`;
  Stripe webhooks use `/api/stripe/webhook`. Dashboard APIs are `/api/dashboard/login`, `/session`, `/logout`,
  `/:slug/link`, `/:slug/summary`, `/:slug/export.csv`, `/:slug/placements/:id/{sold,release}`, and
  `/:slug/connect/onboard`, `/:slug/model`, `/:slug/model/{consent,kit,submit}`,
  `/:slug/model/photos/:angle`, `/:slug/model/views/{generate,decision,:angle}`,
  `/:slug/model/build/{start,model.glb,thumbnail}`, `/:slug/model/review`, `/:slug/settings`,
  `/:slug/poster/:variant`, `/:slug/poster`, `/:slug/poster/remove`, and
  `/:slug/launch`; they require
  `DASHBOARD_SECRET`, and POSTs require a same-origin `Origin`. Athlete previews are at
  `/dashboard/:slug/model/studio`. Operator pages and APIs are `/admin`, `/admin/:slug/studio`,
  `/api/admin/session`, `/api/admin/logout`, `/api/admin/reviews`, `/api/admin/applications`,
  `/api/admin/applications/:id/{create,dismiss}`, and
  `/api/admin/:slug/model/{publish,send-back,unpublish}`. Versioned public models use
  `/api/:slug/model.glb?v=<job-id>`. Model Studio Phases B–D use `MESHY_API_KEY` and optional `MESHY_API_BASE`
  (default `https://api.meshy.ai`); local tests must override both to use the fake Meshy service. Phase C builds
  only from approved views and stores GLBs privately. Phase D stores athlete/operator review records and
  published-model pointers/assets in the strong-consistency `model-studio` Blobs store; publishing does not edit
  tenant JSON. The `model-build-background` function alone externalizes `sharp` and `draco3dgltf`; dashboard-api,
  portal, and admin functions must not bundle them. Blobs records are tenant-prefixed.
- Secrets only via `netlify env:set … --secret`; never in chat, code or commits. Set `DASHBOARD_SECRET` and
  `MESHY_API_KEY` as Netlify secrets for deployed dashboard and Model Studio APIs. `OPERATOR_EMAIL` is optional
  and receives athlete model-approval notifications.
- Blobs deletions are destructive: confirm the placement ID and back up first.
- Real test emails / locks need explicit confirmation and the owner's own address.
- Address every automated PR-review comment before calling a PR mergeable.
