import { getLiveModelAsset, getLivePointer } from "../lib/model-review.mjs";
import { json } from "../lib/sponsorship.mjs";
import { resolveTenantForApi } from "../lib/tenants.mjs";

export default async function liveModel(req, context) {
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
  const tenant = await resolveTenantForApi(req, context, { allowQueryToken: true });
  if (!tenant) return json({ error: "Model not found." }, 404);

  const jobId = new URL(req.url).searchParams.get("v");
  const live = await getLivePointer(tenant);
  if (!live || live.jobId !== jobId) return json({ error: "Model not found." }, 404);
  const asset = await getLiveModelAsset(tenant, jobId, live);
  if (!asset) return json({ error: "Model not found." }, 404);

  const headers = new Headers({
    "content-type": asset.contentType,
    "x-content-type-options": "nosniff"
  });
  if (tenant.status === "draft") {
    headers.set("cache-control", "private, no-store");
    headers.set("netlify-cdn-cache-control", "private, no-store");
  } else {
    headers.set("cache-control", "public, max-age=31536000, immutable");
    headers.set("netlify-cdn-cache-control", "public, durable, max-age=31536000, immutable");
    headers.set("cache-tag", `tenant-${tenant.slug}`);
  }
  return new Response(asset.bytes, { headers });
}

export const config = { path: "/api/:slug/model.glb" };
