import { getStore } from "@netlify/blobs";
import { DEADLINE, isPlacementId, soldPlacements, invoicePlacement, stripeEnabled } from "./sponsorship.mjs";

/* ---------------------------------------------------------------------------
   Two jobs, run daily by functions/close-auction.mjs (or on demand through
   POST /api/close-auction with the ADMIN_TOKEN):
     1. Retry any lock whose Stripe invoice failed or was skipped (any time).
     2. Once BID_DEADLINE has passed, close every open placement that has a
        high bidder: mark it closed and invoice the winner.
   Idempotent — placements with a sent invoice are skipped.
--------------------------------------------------------------------------- */
export async function closeAuction(origin, { force = false } = {}) {
  const store = getStore({ name: "bids", consistency: "strong" });
  const sold = await soldPlacements(origin);
  const pastDeadline = force || Date.now() > new Date(DEADLINE).getTime();
  const { blobs } = await store.list();
  const summary = { pastDeadline, stripe: stripeEnabled(), invoiced: [], retried: [], noBids: [], skipped: [] };

  for (const { key: id } of blobs) {
    if (!isPlacementId(id)) continue;
    const rec = await store.get(id, { type: "json" });
    if (!rec) continue;
    if (rec.invoice?.status === "sent" || sold.has(id)) { summary.skipped.push(id); continue; }

    if (rec.locked) {
      await invoicePlacement(store, id, rec, "lock");
      summary.retried.push({ id, company: rec.bidder.company, status: rec.invoice?.status });
      continue;
    }

    if (!pastDeadline) { summary.skipped.push(id); continue; }
    if (!rec.high || !rec.bidder) { summary.noBids.push(id); continue; }

    if (!rec.closed) {
      rec.closed = true;
      rec.closedAt = new Date().toISOString();
      await store.setJSON(id, rec);
    }
    await invoicePlacement(store, id, rec, "win");
    summary.invoiced.push({ id, company: rec.bidder.company, amount: rec.high, status: rec.invoice?.status });
  }
  console.log("close-auction", JSON.stringify(summary));
  return summary;
}
