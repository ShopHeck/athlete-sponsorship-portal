# Athlete Sponsorship Portal

Config-driven, embeddable 360° sponsorship placement portal. `portal.config.json` is the committed Michael
Heckert/BKFC Clearwater tenant; build another athlete by selecting a different JSON file without editing code.

## Inventory

The selected tenant's garments, placement geometry and labels, sponsor inventory, prices, ring, branding and copy
are all configured in its JSON file. Michael's config contains the existing 28-placement inventory.

The build renders `src/index.template.html` to `public/index.html` and generates the server config bundle. The
generated files are ignored by Git.

## Run locally

```bash
npm install
npm run build
npx netlify dev
# open http://localhost:8888/
```

To build the included fictional Jordan Reyes demo instead:

```bash
PORTAL_CONFIG=examples/demo-athlete.json npm run build
```

## Reusing this for another athlete or event

This repo is the template for the sponsorship-portal service. The playbook lives in
`.devin/skills/sponsorship-portal/` (`SKILL.md` plus `reference/intake.md`, `configuration.md`,
`launch-checklist.md`, `gotchas.md`). Inside this repo it is discovered automatically by **Devin**
(`.devin/skills`), **Claude Code** (`.claude/skills`, symlink) and **Codex CLI** (`.agents/skills`, symlink; see also
`AGENTS.md`). Start a new portal with
`gh repo create <org>/<athlete>-sponsor-portal --private --clone --template ShopHeck/heck-sponsor-360`.

To install it globally or hand it to a client, run `scripts/package-skill.sh` → `dist/skill/`:
`sponsorship-portal-skill.zip` (upload to Claude.ai Skills, or unzip into `~/.claude/skills`, `~/.agents/skills`,
`~/.config/devin/skills`) and `chatgpt/` (Custom GPT instructions ≤ 8000 chars + knowledge files). `dist/skill/INSTALL.md`
has the per-tool steps.

### Local end-to-end test (no real Stripe or email)

```sh
npm run build                              # build the selected tenant first
node scripts/mock-services.mjs &          # fake Stripe + Resend on :4242
STRIPE_SECRET_KEY=sk_test_mock STRIPE_API_BASE=http://127.0.0.1:4242 \
RESEND_API_KEY=re_mock RESEND_API_BASE=http://127.0.0.1:4242 \
NOTIFY_EMAIL=owner@example.test PORTAL_URL=http://localhost:8888 ADMIN_TOKEN=devtoken \
npx netlify dev --offline --port 8888 &
scripts/smoke-test.sh http://localhost:8888 SB-R1 TF-12   # two OPEN placement ids
```

Choose open IDs from the selected config's `garments[].placements`, excluding entries in `sold`.

## Deploy

Deploy on Netlify: the build generates the static page and function config, and the bidding API is a Netlify
Function (`netlify/functions/bids.mjs`, served at `/api/bids`) backed by Netlify Blobs. `netlify.toml` configures
both. Run locally with `npm install && npm run build && npx netlify dev`.

### Bidding

Open placements accept bids using the selected tenant's `pricing.minBid`, `pricing.increment`, and
`pricing.lockPrice` values. Environment variables can override those defaults. Bids and locks are stored per
placement in the `bids` Blobs store (company, contact, email, phone, note, full history); the public API only
exposes the high bid, bidder company and count.

**Logos** — a logo uploaded before bidding is downscaled in the browser (max 800px PNG) and sent with the bid. It is stored in the `logos` Blobs store (one key per placement, 1.5 MB cap, PNG/JPG/WebP only), served at `/api/logos/:id`, and rendered on the model and detail card once the placement is locked or won. A new high bidder without artwork clears the previous bidder's logo.

**Emails (Resend)** — the bidder gets a confirmation, the previous high bidder an "outbid" notice, and the
configured portal owner a copy of everything.

**Invoices (Stripe)** — no card is taken in the portal. Instead:

- **Lock it now** (or a bid ≥ `$2,500`) creates a Stripe customer + finalised invoice for the lock price, *due on receipt*, and emails the sponsor a **Pay invoice** link (Stripe's hosted invoice page) via Resend. The same link is shown in the portal right after locking. Stripe itself does not send email.
- **Auction winners** — `netlify/functions/close-auction.mjs` runs daily; once `BID_DEADLINE` has passed it marks each open placement with bids as closed and invoices the high bidder the same way. It also retries any lock whose invoice failed. Trigger it manually (or force-close early) with `curl -X POST -H "authorization: Bearer $ADMIN_TOKEN" https://<site>/api/close-auction[?force=1]`; locally, `npx netlify functions:invoke close-auction`.
- Every invoice is recorded on the placement (`invoice.id/url/status`) so re-runs never double-invoice. Failures email the configured owner with the Stripe error.

Environment variables (Netlify → Site configuration → Environment variables):

| Variable | Purpose |
| --- | --- |
| `STRIPE_SECRET_KEY` | **Required for invoicing.** `sk_live_…` in production; use `sk_test_…` locally. |
| `RESEND_API_KEY` | **Required for email.** |
| `PORTAL_CONFIG` | Selects a tenant config at build time; defaults to `portal.config.json`. |
| `NOTIFY_FROM` | Resend sender; defaults to `contact.notifyFrom` in the tenant config. |
| `NOTIFY_EMAIL` | Owner inbox and sponsor-email reply-to; defaults to `contact.notifyEmail`. |
| `PORTAL_URL` | Public portal URL used in emails; defaults to the tenant's `portalUrl` (Netlify's `URL` is also supported). |
| `ADMIN_TOKEN` | Enables `POST /api/close-auction` for manual runs. |
| `MIN_BID`, `BID_INCREMENT`, `LOCK_PRICE`, `BID_DEADLINE`, `EVENT_NAME` | Optional overrides for tenant `pricing` and `event.name`. |

For local testing set `STRIPE_API_BASE` / `RESEND_API_BASE` to point the functions at a mock server.

## Fight poster & share image

`public/assets/backdrop/` holds the optimised poster set configured in the tenant's `poster` object: stage images,
poster card, and social share image. Setting `poster` to `null` removes the poster card/dialog, stage backdrop,
preload, and poster-based OG image.

## Embed on teamheck.netlify.app

Once hosted, paste this where the portal should appear (the "Embed portal" button in the app generates the same snippet):

```html
<iframe src="https://heck-sponsor-360.netlify.app/" title="Michael Heckert sponsorship portal" loading="lazy" allow="fullscreen" style="width:100%;height:900px;border:0"></iframe>
```

When framed, the portal switches to an embed layout (fixed stage height, no "Embed portal" button) and posts its document height to the host as `{ type: "heck-portal-height", height }`. To make the iframe grow with the content instead of scrolling internally, add on the host page:

```html
<script>
addEventListener("message", (e) => {
  if (e.origin !== "https://heck-sponsor-360.netlify.app" || e.data?.type !== "heck-portal-height") return;
  document.querySelector('iframe[src^="https://heck-sponsor-360.netlify.app"]').style.height = e.data.height + "px";
});
</script>
```

## 3D viewer

The stage is a real-time three.js (WebGL) scene loaded from the unpkg import map in the HTML template. The selected
tenant's `model` path identifies its textured full-body GLB. Every placement is a `DecalGeometry` patch projected
onto the mesh surface (clickable, raycast-selected, and textured with the uploaded logo). Placement coordinates
and labels live in the tenant JSON.

### Swapping the model

The existing Heckert mesh is an AI approximation, not a scan. To replace it with a photogrammetry capture (Polycam /
Luma AI) or an artist-made GLB, drop the file in `public/assets/models/` and set its path in the tenant JSON (or
use `?model=assets/models/<file>.glb` to preview an override). The GLB is scaled to 1.86 m, centred on the floor
and auto-flipped to face +Z; placements are re-projected onto the surface, so a model in a similar stance can
reuse the existing geometry.

## Reference photography

`process_assets.py` converts the supplied 12-angle photography (`IMG_1267–IMG_1278`) into the WebP frames in `assets/processed/`. They are reference material for the model's build and shorts design and are not used by the viewer.

## Sold placements (confirmed sponsors)

Confirmed sponsors are listed in the selected tenant's `sold` map, keyed by placement ID. Each entry names the
sponsor and points to a logo file (transparent PNG or SVG, roughly the aspect ratio of the placement) stored in
`public/assets/sponsors/`:

```json
{ "sold": { "SF-R1": { "sponsor": "HKA USA", "logo": "assets/sponsors/hka-usa.png" } } }
```

Sold placements render the sponsor's logo directly on the garment, show `SOLD` in the inventory and selection card, and cannot be previewed or requested. Sleeve IDs (`TS-0x`) mark both sleeves. Delete an entry to reopen the placement.
