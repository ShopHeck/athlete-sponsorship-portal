# Tenant configuration

Each athlete or event has one committed JSON file at `tenants/<slug>.json`. The filename must exactly match the
config's lowercase `slug`, which follows `^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$`.

## Tenant lifecycle and platform URLs

Every config has `status: "live" | "draft" | "closed"` and `embedOrigins: string[]`. A draft page returns 404
unless the request includes `?preview=<PREVIEW_TOKEN>`. A valid preview page is not cached and includes the token
in its inlined config; it sends `x-preview-token` on bid API requests, while logo image URLs carry the token as a
query parameter. Draft API requests without a valid token return JSON 404. Live and closed pages do not include a
preview token and receive a CSP built from that tenant's `embedOrigins`.

Preview bids and locks run the normal flow and persist as real records in Blobs under the draft tenant's slug.
They can send real emails or create invoices if production services are configured; use local mocks or approved
test recipients. Draft tenants remain excluded from the scheduled close job.

`portalUrl` is not stored in tenant JSON. At request time it is derived from `PLATFORM_URL` (or the request origin)
and the slug. `publicUrl` is optional: it is the athlete's marketing page used for sponsor placement deep links.
If omitted, those links use the derived portal URL.

## Demo portals

A prospect-facing demo uses an optional `demo` object instead of `showcase`; the two fields are mutually exclusive.
`sport`, `kicker`, `headline`, `body`, and `bidNotice` must be non-empty strings. An optional CTA has a non-empty
`label` and an `href` beginning with `/` or `https://`:

```json
{
  "demo": {
    "sport": "Women's MMA",
    "kicker": "DEMO PORTAL · WOMEN'S MMA",
    "headline": "This could be your portal.",
    "body": "A fictional athlete showing how an MMA fighter's kit sells on the platform.",
    "bidNotice": "Demo portal — bidding and Lock It Now are switched off.",
    "cta": { "label": "Get a portal like this", "href": "/#apply" }
  }
}
```

Demo rendering is config-driven: the page adds a sport badge and demo panel, keeps every configured placement
visible, and allows local logo previews without saving them. The client skips bids and polling; bid POSTs return
HTTP 409 before storage or payment/email work. Configure demo tenants with platform payments. Connect onboarding,
dashboard sale changes, Model Studio writes, and close-auction invoicing are also blocked for demo tenants.

## Build and asset paths

```bash
npm run build
```

The build validates every `tenants/*.json`, renders each tenant as a smoke check, and writes the ignored
`netlify/lib/platform.generated.json` bundle. It does not generate or overwrite the root placeholder page.

Place tenant-specific artwork in `public/tenants/<slug>/`. Relative paths in `model`, `poster`, and
`sold[].logo` resolve from `/tenants/<slug>/`; root-relative paths and HTTP URLs pass through unchanged.
Tenant config is resolved before the browser receives its embedded JSON.

```text
tenants/jordan-reyes.json
public/tenants/jordan-reyes/models/...
public/tenants/jordan-reyes/backdrop/...
public/tenants/jordan-reyes/sponsors/...
```

For reuse of a shared model, use a root-relative path such as `/tenants/michael-heckert/models/heckert.glb`.
`?model=` remains available as a local preview override.

## Placements

All placement ids and labels are defined in `garments[].placements`; the build generates the server allowlist and
email/invoice labels from the config.

```json
{
  "id": "SF-L1",
  "name": "Left thigh · upper",
  "detail": "Front · left thigh",
  "label": "Front · Left thigh — upper",
  "side": "front",
  "x": -0.18,
  "y": 0.91,
  "w": 0.14,
  "h": 0.1
}
```

IDs must be unique within the tenant and no longer than eight characters. Valid sides are `front`, `back`, `left`,
and `right`. Add `mirror` when the same decal should be projected onto another side. Ordering inside each garment
is the order shown in the inventory.

## Sold sponsors

The config's `sold` map is keyed by placement ID. Store each logo in that tenant's asset directory:

```json
{
  "sold": {
    "SF-L1": {
      "sponsor": "Example Sponsor",
      "logo": "sponsors/example.png"
    }
  }
}
```

The build resolves logo paths before embedding the config. To mark a placement sold or reopen it, update the map,
rebuild, and merge the change through the platform's normal deployment flow.

## Tenant-owned values

Use tenant config for athlete and event identity, SEO, hero text, benefits, event time zone, all pricing and
deadline values, notification email and sender, brand colors, ring colors and pad text, placement inventory,
sold sponsors, and athlete/event-specific email and invoice copy. These business settings are not overridden with
per-site environment variables.

## Payments

Every tenant requires a `payments` block:

```json
{ "mode": "platform" }
```

Use platform mode when invoices stay on the platform Stripe account. A Connect tenant instead configures:

```json
{ "mode": "connect", "feePercent": 10, "country": "US" }
```

`feePercent` must be greater than 0 and no more than 50. `country` is optional and defaults to `US`; when supplied,
it must be two uppercase letters. Connect invoices are direct charges on the athlete's Stripe account and include
this application fee. The connected account pays Stripe fees and bears refunds and chargebacks; Stripe is liable
for unrecoverable negative balances. The athlete receives the full Stripe Dashboard. The required
`copy.paymentsPending` string is shown while bidding is closed pending payout setup. Bidding becomes available only
when Stripe reports charges enabled and the `card_payments` capability active. Stripe requires both `card_payments`
and `transfers` to be requested for this controller combination; `transfers` does not change the direct-charge
liability setup.

Global environment variables are reserved for platform/service operation: `STRIPE_SECRET_KEY`,
`RESEND_API_KEY`, `STRIPE_API_BASE`, `RESEND_API_BASE`, `PLATFORM_URL`, `PREVIEW_TOKEN`, and `ADMIN_TOKEN`.
`NOTIFY_FROM` is used only when a tenant does not define `contact.notifyFrom`.

## Poster and model

The optional `poster` object configures the card image, two stage backdrop sizes, share image, alt text, and copy.
Set `poster` to `null` to omit the card, dialog, backdrop, image preload, and poster-based Open Graph image.

`model` points to a GLB. For consistent decal projection, the model should have a similar stance and face +Z.
Optional `modelFacing` is `"auto"` (the default), `"positive-z"`, or `"negative-z"`; set a direction if the
automatic pose detection does not orient a model correctly. Ring configuration controls whether the arena is shown,
pad text, rope colors, corner colors, and pad color. Optional `ring.style` is `"ropes"` (the default), `"octagon"`,
`"boxing"`, or `"mat"`. `ring.backdrop` points to a tenant asset used as the stage background when there is no
poster; a configured poster takes precedence. For `"mat"` style, optional `ring.matColors` is an array of two
`#rrggbb` colors for the competition surface and border, defaulting to `["#1f3d8a", "#d9ad2b"]`.

## Adding and previewing a tenant

1. Create `tenants/<slug>.json` and `public/tenants/<slug>/`.
2. Set a valid slug, matching filename, unique placement IDs, `"status": "draft"`, and the tenant's `embedOrigins`.
3. Run `npm run build`.
4. Start Netlify Dev and preview `/<slug>?preview=$PREVIEW_TOKEN`.
5. Check placement geometry, email wording, pricing, branding, assets, CSP, bid APIs, and logo loading. Remember
   preview bids are persistent draft-tenant records. After approval, change status to `"live"` and rebuild.
