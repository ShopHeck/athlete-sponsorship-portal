import { closeAuction } from "../lib/close-auction.mjs";
import { listTenants } from "../lib/tenants.mjs";

// Runs daily: retries failed lock invoices and, after BID_DEADLINE, invoices
// the winning bidder on every open placement. Logic lives in ../lib/close-auction.mjs.
export default async (req) => {
  const platformUrl = (process.env.PLATFORM_URL || new URL(req.url).origin).replace(/\/+$/, "");
  const tenants = (await listTenants()).filter((tenant) => tenant.status !== "draft");
  for (const tenant of tenants) {
    await closeAuction(tenant, { portalUrl: `${platformUrl}/${tenant.slug}` });
  }
  return new Response("ok");
};

export const config = { schedule: "@daily" };
