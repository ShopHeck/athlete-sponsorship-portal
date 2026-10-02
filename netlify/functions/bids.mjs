import { getStore } from "@netlify/blobs";
import { forTenant, json } from "../lib/sponsorship.mjs";
import { resolveTenantForApi } from "../lib/tenants.mjs";

/* ---------------------------------------------------------------------------
   Sponsor bidding for open placements.

   GET  /api/:slug/bids      → public summary per placement (no contact details)
   POST /api/:slug/bids      → { id, type: "bid" | "lock", amount?, company, name, email, phone, note? }

   Bids start at MIN_BID and must beat the current high bid by at least INCREMENT.
   "lock" buys the placement outright for LOCK_PRICE and closes bidding on it.
   Records live in the Netlify Blobs store "bids" under tenant-prefixed keys.

   Emails (Resend): bidder gets a confirmation, the previous high bidder an
   outbid notice, the portal owner a copy of everything. Locks are invoiced immediately
   through Stripe (see ../lib/sponsorship.mjs); auction winners are invoiced by
   the scheduled close-auction function once the deadline passes.
--------------------------------------------------------------------------- */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const publicView = (slug, id, rec) => ({
  id,
  high: rec.high,
  company: rec.bidder?.company || null,
  count: rec.history?.length || 0,
  locked: Boolean(rec.locked),
  lockedBy: rec.locked ? rec.lockedBy?.company || null : null,
  closed: Boolean(rec.closed),
  logo: rec.logo ? `/api/${slug}/logos/${id}?v=${encodeURIComponent(rec.logo.at)}` : null
});

const clean = (v, max = 120) => (typeof v === "string" ? v.trim().slice(0, max) : "");

// Optional bidder logo, sent as a data URL the browser has already downscaled.
const LOGO_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const LOGO_MAX_BYTES = 1.5 * 1024 * 1024;
function parseLogo(v) {
  if (typeof v !== "string" || !v.startsWith("data:image/")) return null;
  const m = v.match(/^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!m || !LOGO_TYPES.has(m[1])) return { error: "Logo must be a PNG, JPG or WebP image." };
  const bytes = Buffer.from(m[2], "base64");
  if (bytes.length > LOGO_MAX_BYTES) return { error: "Logo is too large — please use an image under 1.5 MB." };
  return { type: m[1], bytes };
}

export default async (req, context) => {
  const slug = context.params?.slug || "";
  const tenant = await resolveTenantForApi(req, context);
  if (!tenant) return json({ error: "Tenant not found." }, 404);
  const portalBase = (process.env.PLATFORM_URL || new URL(req.url).origin).replace(/\/+$/, "");
  const services = forTenant(tenant, { portalUrl: `${portalBase}/${slug}` });
  const {
    MIN_BID, INCREMENT, LOCK_PRICE, DEADLINE, isPlacementId, usd, describePlacement,
    soldPlacements, DASHBOARD_SITE_NAME, tryEmail, notifyOwner, bidConfirmationEmail,
    outbidEmail, invoicePlacement
  } = services;
  const store = getStore({ name: "bids", consistency: "strong" });
  const prefix = `${slug}/`;
  const storageKey = (id) => `${prefix}${id}`;

  if (req.method !== "GET" && req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (tenant.status === "closed" && req.method === "POST") return json({ error: "Bidding is closed." }, 409);

  if (req.method === "GET") {
    const { blobs } = await store.list({ prefix });
    const placements = {};
    await Promise.all(blobs.map(async ({ key }) => {
      const id = key.slice(prefix.length);
      if (!isPlacementId(id)) return;
      const rec = await store.get(key, { type: "json" });
      if (rec) placements[id] = publicView(slug, id, rec);
    }));
    return json({ minBid: MIN_BID, increment: INCREMENT, lockPrice: LOCK_PRICE, deadline: DEADLINE, placements });
  }

  let body;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
  body ||= {};

  const id = clean(body.id, 8);
  const type = body.type === "lock" ? "lock" : "bid";
  const bidder = { company: clean(body.company), name: clean(body.name), email: clean(body.email).toLowerCase(), phone: clean(body.phone, 40) };
  const note = clean(body.note, 500);

  const logo = parseLogo(body.logo);

  if (!isPlacementId(id)) return json({ error: "Unknown placement." }, 400);
  if (!bidder.company || !bidder.name) return json({ error: "Company and contact name are required." }, 400);
  if (!EMAIL.test(bidder.email)) return json({ error: "A valid email address is required." }, 400);
  if (logo?.error) return json({ error: logo.error }, 400);
  if (Date.now() > new Date(DEADLINE).getTime()) return json({ error: "Bidding has closed for this event." }, 409);
  if ((await soldPlacements()).has(id)) return json({ error: "This placement is already sold." }, 409);

  const rec = (await store.get(storageKey(id), { type: "json" })) || { high: 0, bidder: null, history: [], locked: false };
  if (rec.locked || rec.closed) return json({ error: "This placement has been locked by another sponsor.", placement: publicView(slug, id, rec) }, 409);

  const now = new Date().toISOString();
  const previous = rec.high ? rec.history[rec.history.length - 1] : null;
  let amount;
  if (type === "lock") {
    amount = LOCK_PRICE;
  } else {
    amount = Math.round(Number(body.amount));
    const floor = Math.max(MIN_BID, rec.high ? rec.high + INCREMENT : 0);
    if (!Number.isFinite(amount) || amount < floor) {
      return json({ error: `Bid must be at least ${usd(floor)}.`, placement: publicView(slug, id, rec) }, 409);
    }
    if (amount >= LOCK_PRICE) amount = LOCK_PRICE;
  }
  if (amount >= LOCK_PRICE) {
    rec.locked = true;
    rec.lockedAt = now;
    rec.lockedBy = bidder;
  }
  rec.high = amount;
  rec.bidder = bidder;
  rec.history.push({ amount, type: rec.locked ? "lock" : "bid", at: now, ...bidder, note, logo: Boolean(logo) });
  if (logo) {
    await getStore({ name: "logos", consistency: "strong" }).set(storageKey(id), logo.bytes, { metadata: { type: logo.type, company: bidder.company, email: bidder.email, at: now } });
    rec.logo = { type: logo.type, size: logo.bytes.length, company: bidder.company, at: now };
  } else if (rec.logo && previous && previous.email !== bidder.email) {
    delete rec.logo; // a new high bidder without artwork shouldn't inherit the previous bidder's logo
  }
  await store.setJSON(storageKey(id), rec);

  if (rec.locked) {
    await invoicePlacement(store, id, rec, "lock");
    if (previous && previous.email !== bidder.email) await tryEmail(outbidEmail(id, rec, previous));
    return json({ ok: true, placement: publicView(slug, id, rec), invoiceUrl: rec.invoice?.url || null, emailed: Boolean(rec.invoice?.emailed) });
  }

  const label = `New high bid ${usd(amount)}`;
  await Promise.all([
    tryEmail(bidConfirmationEmail(id, rec)),
    previous && previous.email !== bidder.email ? tryEmail(outbidEmail(id, rec, previous)) : null,
    notifyOwner(`${id} · ${label} · ${bidder.company}`, [
      `Placement: ${id} — ${describePlacement(id)}`,
      `Action: ${label}`,
      `Company: ${bidder.company}`,
      `Contact: ${bidder.name}`,
      `Email: ${bidder.email}`,
      `Phone: ${bidder.phone || "-"}`,
      logo ? `Logo: ${new URL(`/api/${slug}/logos/${id}`, req.url)}` : "Logo: not uploaded",
      note ? `Note: ${note}` : "",
      previous ? `Outbid: ${previous.company} (${previous.email}) at ${usd(previous.amount)}` : "",
      `Time: ${now}`,
      "",
      "No invoice yet — the winner is invoiced automatically when bidding closes.",
      `All bids: Netlify dashboard → ${DASHBOARD_SITE_NAME} → Blobs → bids`
    ])
  ]);

  return json({ ok: true, placement: publicView(slug, id, rec) });
};

export const config = { path: "/api/:slug/bids" };
