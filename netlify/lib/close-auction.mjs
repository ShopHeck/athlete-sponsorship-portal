import { getStore } from "@netlify/blobs";
import { forTenant } from "./sponsorship.mjs";

/* ---------------------------------------------------------------------------
   Two jobs, run daily by functions/close-auction.mjs (or on demand through
   POST /api/close-auction with the ADMIN_TOKEN and optional ?tenant=<slug>):
     1. Retry any lock whose Stripe invoice failed or was skipped (any time).
     2. Once this tenant's configured deadline has passed, close every open placement that has a
        high bidder: mark it closed and invoice the winner.
   Idempotent — placements with a sent invoice are skipped.
--------------------------------------------------------------------------- */
export async function closeAuction(tenant, { portalUrl, force = false } = {}) {
  const services = forTenant(tenant, { portalUrl });
  const store = getStore({ name: "bids", consistency: "strong" });
  const prefix = `${tenant.slug}/`;
  const sold = await services.soldPlacements();
  const pastDeadline = force || Date.now() > new Date(services.DEADLINE).getTime();
  const { blobs } = await store.list({ prefix });
  const summary = { pastDeadline, stripe: services.stripeEnabled(), invoiced: [], retried: [], noBids: [], skipped: [] };

  for (const { key } of blobs) {
    const id = key.slice(prefix.length);
    if (!services.isPlacementId(id)) continue;
    const rec = await store.get(key, { type: "json" });
    if (!rec) continue;
    if (rec.invoice?.status === "sent" || sold.has(id)) { summary.skipped.push(id); continue; }

    if (rec.locked) {
      await services.invoicePlacement(store, id, rec, "lock");
      summary.retried.push({ id, company: rec.bidder.company, status: rec.invoice?.status });
      continue;
    }

    if (!pastDeadline) { summary.skipped.push(id); continue; }
    if (!rec.high || !rec.bidder) { summary.noBids.push(id); continue; }

    if (!rec.closed) {
      rec.closed = true;
      rec.closedAt = new Date().toISOString();
      await store.setJSON(key, rec);
    }
    await services.invoicePlacement(store, id, rec, "win");
    summary.invoiced.push({ id, company: rec.bidder.company, amount: rec.high, status: rec.invoice?.status });
  }
  console.log("close-auction", JSON.stringify(summary));
  return summary;
}
