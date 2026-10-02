# Configuration reference

Everything that changes from one athlete/event to the next, and where it lives.

## Environment variables (Netlify → Site configuration → Environment variables)

Set secrets with `netlify env:set KEY value --secret --context production deploy-preview branch-deploy`
(secrets cannot be read back afterwards — keep the client's copy in their password manager, not in chat).
Non-secrets: `netlify env:set KEY value`. Changes apply on the **next deploy**.

| Variable | Required | Purpose |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | for invoicing | `sk_test_…` for the dry run, `sk_live_…` for launch. Without it a lock still saves and emails the owner an "invoice NOT created" alert; the daily job invoices once the key exists. |
| `RESEND_API_KEY` | for email | Resend API key from the **client's** account. |
| `PORTAL_CONFIG` | no | Local build selection; defaults to root `portal.config.json`. Netlify builds use the committed default unless configured otherwise. |
| `NOTIFY_FROM` | no | Sender; defaults to `contact.notifyFrom` in the selected config. Domain must be verified in Resend (DKIM + SPF). `onboarding@resend.dev` only delivers to the account owner. |
| `NOTIFY_EMAIL` | no | Owner inbox for every bid/lock/invoice notification and reply-to on sponsor emails; defaults to `contact.notifyEmail`. |
| `PORTAL_URL` | no | Public portal URL used in emails/deep links; defaults to `portalUrl` in the selected config (Netlify's `URL` also remains supported). |
| `ADMIN_TOKEN` | yes | Random secret for `POST /api/close-auction`. Generate: `openssl rand -hex 24`. |
| `MIN_BID` / `BID_INCREMENT` / `LOCK_PRICE` | no | Override `pricing.minBid`, `pricing.increment`, and `pricing.lockPrice` in the selected config. |
| `BID_DEADLINE` | no | Overrides `pricing.deadline`, an ISO 8601 timestamp with offset. Bids are rejected after it; the daily job closes and invoices after it. |
| `EVENT_NAME` | no | Overrides `event.name`, used in invoice line items and email headers. |
| `STRIPE_API_BASE` / `RESEND_API_BASE` | local only | Point at `scripts/mock-services.mjs` for tests. Never set in production. |

Tenant values live in one JSON file (`portal.config.json` by default). Build the selected tenant before serving it:

```bash
npm run build
# or: PORTAL_CONFIG=examples/demo-athlete.json npm run build
npx netlify dev
```

`scripts/build.mjs` renders `src/index.template.html` to `public/index.html` and generates
`netlify/lib/portal-config.generated.json` for the functions. Both outputs are ignored by Git.

## Placements (`portal.config.json`)

Placements live in `garments[]`, in the desired tab order. Each placement has
`{ id, name, detail, label, side, x, y, w, h, mirror? }`; `side` is `front`, `back`, `left`, or `right`.
Coordinates are metres on a model normalised to 1.86 m tall, feet at y=0, facing +z.
- `x` is athlete-left positive (viewer's right from the front). Rays are cast from ±3 m on the given side and the
  hit becomes a `DecalGeometry`, so placements wrap the real garment surface. If a placement logs
  "No surface found", its x/y misses the mesh — adjust or check the model's scale.
- IDs must be unique and no longer than 8 characters (the API retains its existing ID cleaning/truncation).
  `PLACEMENT_IDS`, `isPlacementId()`, and `describePlacement()` are generated from this list; no code-side ID
  pattern or second label table should be edited.
- `mirror` projects a placement on both sides (used for matching sleeve logos).
- Placement order within each garment should be front, back, then lateral. The landing order prioritizes each
  side across garments in config order.

## Pre-sold sponsors (`portal.config.json`)

```json
{ "sold": { "SF-L1": { "sponsor": "Boxrope", "logo": "assets/sponsors/boxrope.png" } } }
```
Logos: transparent PNG/WebP, ~1024 px wide, trimmed. Dark artwork is auto-detected and shown on a light card.
A placement in `sold` is SOLD everywhere (UI and API reject bids) regardless of the Blobs store.

## Copy locations

| What | Where |
| --- | --- |
| `<title>`, meta description, OG/Twitter tags, canonical | `seo` in the tenant config |
| Header name/subtitle, lockup date, hero, benefits, footer | `athlete`, `event`, `hero`, and `benefits` in the tenant config |
| Poster card text, image and stage backdrop | `poster` in the tenant config; set it to `null` to omit the poster |
| Bid note, placement statuses, dialogs, toasts, embed instructions | `copy` in the tenant config |
| Email subjects/bodies and visual header | `copy` plus `athlete`, `event`, and `contact` in the tenant config |
| Invoice description, line item, footer and currency | `copy.invoiceDescription`, `copy.invoiceItemDescription`, `copy.invoiceFooter`, and `pricing.currency` |
| Static markup and placeholder names | `src/index.template.html` and `scripts/build.mjs` |

## Brand

Set `brand.accent` and `brand.accentDark` in the tenant config; the build injects the CSS variables used by the
site, and the same accent colors the 3D highlights and email template. Optional accent variants are also in the
config. Ring ropes, corners, pad color, pad text, and whether the arena is shown come from `ring`. The favicon
is still `public/favicon.svg`; the brand mark comes from `athlete.brandMark`.

## Poster, backdrop and share image (`public/assets/backdrop/`)

Requires `ffmpeg` and `cwebp`. From the highest-res poster (`poster.jpg`):
```bash
mkdir -p public/assets/backdrop
# poster card + lightbox
ffmpeg -y -i poster.jpg -vf "unsharp=3:3:0.4" /tmp/poster.png && cwebp -q 82 /tmp/poster.png -o public/assets/backdrop/fight-poster.webp
# stage backdrop, pre-softened and darkened (CSS adds vignette + fades) — two widths for srcset
for W in 900 1500; do ffmpeg -y -i poster.jpg -vf "scale=$W:-1:flags=lanczos,gblur=sigma=3,eq=brightness=-0.06:saturation=0.8:contrast=1.05" /tmp/stage-$W.png && cwebp -q 70 /tmp/stage-$W.png -o public/assets/backdrop/stage-$W.webp; done
# 1200x630 share image: crop the faces band (adjust crop y to the poster)
ffmpeg -y -i poster.jpg -vf "crop=iw:ih*0.42:0:ih*0.06,scale=1200:630:flags=lanczos,unsharp=3:3:0.5" -q:v 3 public/assets/backdrop/og-image.jpg
```
Keep the filenames; `poster` references the card, stage images, and share image (`srcset`, preload, OG tags).
Setting `poster` to `null` removes the card, dialog, stage backdrop, preload, and OG image. Check the backdrop's
`object-position` in `.stage-backdrop img` so faces frame the model rather than sit behind it.
Budget: backdrop ≤ 100 KB, poster ≤ 250 KB, share image ≤ 200 KB.

## 3D model requirements

- Single `.glb` at `public/assets/models/<athlete>.glb` (Draco compression supported; decoder loads from unpkg).
- Set its path in `model` in the tenant config. `?model=` can still override it for previewing.
- Wearing the actual garments in the real colours; old sponsor marks removed from textures.
- Any scale/position: the loader normalises to 1.86 m tall, feet at y = 0, centred; facing is auto-detected
  (toes protrude further than heels). If detection fails, the model is rotated 180° — check the FRONT view.
- Target ≤ 15 MB, 50–100k triangles, 2K garment textures for mobile. Test on a phone.
- Materials are forced to roughness 0.9 / metalness 0 on load.
- Produced outside this repo (photogrammetry or artist build in Blender). Approval sequence that worked:
  face → full body + garments → 360° preview → export. Keep a rollback GLB when swapping.

## Marketing-site embed

```html
<iframe src="https://PORTAL/?embed=1" title="…sponsorship portal" allow="fullscreen" scrolling="no" style="width:100%;height:900px;border:0"></iframe>
<script>
addEventListener("message", (e) => {
  if (e.origin !== "https://PORTAL" || !e.data || e.data.type !== "heck-portal-height") return;
  document.querySelector("iframe").style.height = Math.max(600, Math.min(4000, e.data.height)) + "px";
});
</script>
```
Allow the host in `netlify.toml` → `Content-Security-Policy: frame-ancestors …`. Embed mode hides the
footer embed button, stretches the 3D stage to the row, and reports the **body** height (not
`documentElement.scrollHeight`, which can never shrink below the iframe).
