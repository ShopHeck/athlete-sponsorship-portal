import { closeAuction } from "../lib/close-auction.mjs";
import { json } from "../lib/sponsorship.mjs";
import { getTenant, listTenants } from "../lib/tenants.mjs";

/* Manual trigger for the close-auction job (retry failed invoices, or close
   the auction early with ?force=1). Requires ADMIN_TOKEN:
     curl -X POST -H "authorization: Bearer $ADMIN_TOKEN" https://<site>/api/close-auction
--------------------------------------------------------------------------- */
export default async (req) => {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return json({ error: "ADMIN_TOKEN is not configured." }, 503);
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (req.headers.get("authorization") !== `Bearer ${token}`) return json({ error: "Unauthorized" }, 401);
  const url = new URL(req.url);
  const platformUrl = (process.env.PLATFORM_URL || url.origin).replace(/\/+$/, "");
  const options = { force: url.searchParams.get("force") === "1" };
  const requestedTenant = url.searchParams.get("tenant");
  if (requestedTenant) {
    const tenant = await getTenant(requestedTenant);
    if (!tenant || tenant.status === "draft") return json({ error: "Tenant not found." }, 404);
    return json(await closeAuction(tenant, { ...options, portalUrl: `${platformUrl}/${tenant.slug}` }));
  }

  const summaries = {};
  for (const tenant of (await listTenants()).filter((entry) => entry.status !== "draft")) {
    summaries[tenant.slug] = await closeAuction(tenant, { ...options, portalUrl: `${platformUrl}/${tenant.slug}` });
  }
  return json({ tenants: summaries });
};

export const config = { path: "/api/close-auction" };
