import { getStore } from "@netlify/blobs";
import {
  MIN_BID, INCREMENT, LOCK_PRICE, DEADLINE, isPlacementId, json, usd, describePlacement, soldPlacements, DASHBOARD_SITE_NAME,
  tryEmail, notifyOwner, bidConfirmationEmail, outbidEmail, invoicePlacement
} from "../lib/sponsorship.mjs";

/* ---------------------------------------------------------------------------
   Sponsor bidding for open placements.

   GET  /api/bids            → public summary per placement (no contact details)
   POST /api/bids            → { id, type: "bid" | "lock", amount?, company, name, email, phone, note? }

   Bids start at MIN_BID and must beat the current high bid by at least INCREMENT.
   "lock" buys the placement outright for LOCK_PRICE and closes bidding on it.
   Records live in the Netlify Blobs store "bids" (one key per placement) and
   are viewable in the Netlify dashboard → Blobs.

   Emails (Resend): bidder gets a confirmation, the previous high bidder an
   outbid notice, the portal owner a copy of everything. Locks are invoiced immediately
   through Stripe (see ../lib/sponsorship.mjs); auction winners are invoiced by
   the scheduled close-auction function once the deadline passes.
--------------------------------------------------------------------------- */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const publicView = (id, rec) => ({
  id,
  high: rec.high,
  company: rec.bidder?.company || null,
  count: rec.history?.length || 0,
  locked: Boolean(rec.locked),
  lockedBy: rec.locked ? rec.lockedBy?.company || null : null,
  closed: Boolean(rec.closed),
  logo: rec.logo ? `/api/logos/${id}?v=${encodeURIComponent(rec.logo.at)}` : null
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

export default async (req) => {
  const store = getStore({ name: "bids", consistency: "strong" });

  if (req.method === "GET") {
    const { blobs } = await store.list();
    const placements = {};
    await Promise.all(blobs.map(async ({ key }) => {
      const rec = await store.get(key, { type: "json" });
      if (rec) placements[key] = publicView(key, rec);
    }));
    return json({ minBid: MIN_BID, increment: INCREMENT, lockPrice: LOCK_PRICE, deadline: DEADLINE, placements });
  }

  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }

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
  if ((await soldPlacements(req.url)).has(id)) return json({ error: "This placement is already sold." }, 409);

  const rec = (await store.get(id, { type: "json" })) || { high: 0, bidder: null, history: [], locked: false };
  if (rec.locked || rec.closed) return json({ error: "This placement has been locked by another sponsor.", placement: publicView(id, rec) }, 409);

  const now = new Date().toISOString();
  const previous = rec.high ? rec.history[rec.history.length - 1] : null;
  let amount;
  if (type === "lock") {
    amount = LOCK_PRICE;
  } else {
    amount = Math.round(Number(body.amount));
    const floor = Math.max(MIN_BID, rec.high ? rec.high + INCREMENT : 0);
    if (!Number.isFinite(amount) || amount < floor) {
      return json({ error: `Bid must be at least ${usd(floor)}.`, placement: publicView(id, rec) }, 409);
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
    await getStore({ name: "logos", consistency: "strong" }).set(id, logo.bytes, { metadata: { type: logo.type, company: bidder.company, email: bidder.email, at: now } });
    rec.logo = { type: logo.type, size: logo.bytes.length, company: bidder.company, at: now };
  } else if (rec.logo && previous && previous.email !== bidder.email) {
    delete rec.logo; // a new high bidder without artwork shouldn't inherit the previous bidder's logo
  }
  await store.setJSON(id, rec);

  if (rec.locked) {
    await invoicePlacement(store, id, rec, "lock");
    if (previous && previous.email !== bidder.email) await tryEmail(outbidEmail(id, rec, previous));
    return json({ ok: true, placement: publicView(id, rec), invoiceUrl: rec.invoice?.url || null, emailed: Boolean(rec.invoice?.emailed) });
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
      logo ? `Logo: ${new URL(`/api/logos/${id}`, req.url)}` : "Logo: not uploaded",
      note ? `Note: ${note}` : "",
      previous ? `Outbid: ${previous.company} (${previous.email}) at ${usd(previous.amount)}` : "",
      `Time: ${now}`,
      "",
      "No invoice yet — the winner is invoiced automatically when bidding closes.",
      `All bids: Netlify dashboard → ${DASHBOARD_SITE_NAME} → Blobs → bids`
    ])
  ]);

  return json({ ok: true, placement: publicView(id, rec) });
};

export const config = { path: "/api/bids" };
