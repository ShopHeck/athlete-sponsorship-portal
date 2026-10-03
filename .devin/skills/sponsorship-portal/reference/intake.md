# Client intake — sponsorship portal

Complete this with the client before writing code. Every field maps to something in the build; blanks become
delays. Copy this file into the new project as `INTAKE.md` and fill it in.

## 1. Athlete / event
| Field | Answer | Used in |
| --- | --- | --- |
| Athlete full name + nickname | | `index.html` title/hero/footer, email header, OG tags |
| Promotion + event name (e.g. "BKFC Fight Night Clearwater") | | `EVENT_NAME` env, invoice description, emails |
| Event date + city | | header date, poster card, OG description |
| Opponent (if a fight) | | poster card copy |
| Record / one-line bio for the footer | | `.portal-footer` |
| Social handles / website | | footer, emails, OG |
| Brand colours (accent + background) | | `:root` CSS vars (`--orange`, `--bg`) |
| Fight poster (highest-res file) | | backdrop, poster card, share image |
| Logo / wordmark (SVG or PNG) | | `brand-mark`, favicon |

## 2. Garments and placements
| Field | Answer |
| --- | --- |
| Garments shown (e.g. shorts, walkout T-shirt, robe) | |
| Placement grid per garment side (front/back/sleeves), with ids and names | |
| Physical size of each placement (cm) — drives the decal w/h in metres | |
| Which placements are already sold, to whom, with logo files | |
| Any placements reserved/not for sale | |

## 3. 3D model
| Field | Answer |
| --- | --- |
| Existing GLB available? (path / who produced it) | |
| If not: reference photos (front, back, both profiles, ¾ views, face close-ups), height | |
| Garments modelled and coloured to match the real kit? | |
| Approval owner for likeness and garments | |

The 3D model is produced outside this repo (photogrammetry / Blender pipeline). The portal only needs the
finished GLB — see `configuration.md` → "3D model requirements". Athletes can also provide their own guided
reference photos at `/dashboard/<slug>/model`.

## 4. Pricing and rules
| Field | Answer | Env var |
| --- | --- | --- |
| Opening / minimum bid | | `MIN_BID` (default 500) |
| Bid increment | | `BID_INCREMENT` (50) |
| Lock It Now price (closes bidding instantly) | | `LOCK_PRICE` (2500) |
| Bidding deadline + timezone (ISO 8601 with offset) | | `BID_DEADLINE` |
| Invoice terms (default: due on receipt) | | code in `sponsorship.mjs` (`days_until_due`) |
| Currency | | `sponsorship.mjs` (`currency: "usd"`) |
| What the winning sponsor gets (benefits list) | | `index.html` `.bid-benefits`, invoice footer, email outro |
| Refund / cancellation policy text | | `bid-note` / terms copy |

## 5. Accounts and access (the client's own accounts)
| Field | Answer |
| --- | --- |
| Stripe account (name + whether live mode is activated) — who creates the restricted/secret key | |
| Resend account, sending domain to verify, sender address (e.g. `sponsors@athlete.com`) | |
| Owner notification inbox (`NOTIFY_EMAIL`) and reply-to | |
| Netlify team + who owns the site | |
| GitHub org for the repo | |
| Domain registrar / DNS provider (Cloudflare? proxied?) and who can add records | |
| Marketing site that will embed the portal (URL, platform, who deploys it) | |

## 6. Launch
| Field | Answer |
| --- | --- |
| Portal URL (e.g. `portal.athlete.com`) | |
| Go-live date; outreach plan (email list, social, embed) | |
| Who runs the dry-run lock and voids the test invoice | |
| Who handles sponsor questions (reply-to) | |

## Delivery checklist (what the client receives)
- [ ] Live portal on their domain, embedded on their marketing site
- [ ] Bidding + Lock It Now with Stripe invoices from **their** Stripe account
- [ ] Sponsor emails from **their** verified domain; owner notifications to their inbox
- [ ] Poster backdrop, poster card, social share image
- [ ] Pre-sold sponsors rendered on the model
- [ ] Daily auto-close job + admin token for manual runs (token handed over securely, never in chat)
- [ ] Ops one-pager: how to see bids (Netlify → Blobs), reset a placement, close early, invoice winners
- [ ] Repo transferred or shared with the client's org; Netlify site in their team
