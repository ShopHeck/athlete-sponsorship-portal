import { getStore } from "@netlify/blobs";
import { forTenant, json } from "../lib/sponsorship.mjs";
import { resolveTenantForApi } from "../lib/tenants.mjs";

// GET /api/:slug/logos/:id → the current high bidder's uploaded logo for a placement.
export default async (req, context) => {
  const slug = context.params?.slug || "";
  const id = context.params?.id || "";
  const tenant = await resolveTenantForApi(req, context, { allowQueryToken: true });
  if (!tenant) return json({ error: "Tenant not found." }, 404);
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  const service = forTenant(tenant, {
    portalUrl: `${(process.env.PLATFORM_URL || new URL(req.url).origin).replace(/\/+$/, "")}/${slug}`
  });
  if (!service.isPlacementId(id)) return new Response("Not found", { status: 404 });
  const store = getStore({ name: "logos", consistency: "strong" });
  const hit = await store.getWithMetadata(`${slug}/${id}`, { type: "arrayBuffer" });
  if (!hit) return new Response("Not found", { status: 404 });
  return new Response(req.method === "HEAD" ? null : hit.data, {
    headers: {
      "content-type": hit.metadata?.type || "image/png",
      "cache-control": tenant.status === "draft" ? "no-store" : "public, max-age=60, must-revalidate",
      "content-security-policy": "default-src 'none'; sandbox",
      "x-content-type-options": "nosniff"
    }
  });
};

export const config = { path: "/api/:slug/logos/:id" };
