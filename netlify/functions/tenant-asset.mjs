import { createHash } from "node:crypto";
import { getStore } from "@netlify/blobs";
import { json } from "../lib/sponsorship.mjs";
import { loadDynamicTenant } from "../lib/tenant-store.mjs";
import { resolveTenantForApi } from "../lib/tenants.mjs";

export default async function tenantAsset(req, context) {
  if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "Method not allowed" }, 405);
  const tenant = await resolveTenantForApi(req, context, { allowQueryToken: true });
  if (!tenant) return new Response("Not found", { status: 404 });

  const url = new URL(req.url);
  if (context.params?.pitchId) {
    const pitchId = context.params.pitchId;
    if (!/^[a-f0-9]{16,32}$/.test(pitchId)) return new Response("Not found", { status: 404 });
    const pitch = await getStore({ name: "pitches", consistency: "strong" }).get(`${tenant.slug}/${pitchId}`, { type: "json" });
    if (!pitch) return new Response("Not found", { status: 404 });
    if (url.pathname.includes("/pitch-logos/")) {
      if (!pitch.logo) return new Response("Not found", { status: 404 });
      const asset = await getStore({ name: "tenant-assets", consistency: "strong" })
        .getWithMetadata(`${tenant.slug}/pitch-logo/${pitchId}`, { type: "arrayBuffer" });
      if (!asset) return new Response("Not found", { status: 404 });
      return new Response(req.method === "HEAD" ? null : asset.data, {
        headers: {
          "content-type": asset.metadata?.type || pitch.logo.type || "image/png",
          "cache-control": tenant.status === "draft" ? "private, no-store" : "public, max-age=3600, must-revalidate",
          "content-security-policy": "default-src 'none'; sandbox",
          "x-content-type-options": "nosniff"
        }
      });
    }
    const previewQuery = tenant.status === "draft" && url.searchParams.get("preview")
      ? `?preview=${encodeURIComponent(url.searchParams.get("preview"))}`
      : "";
    return json({
      id: pitch.id,
      placementId: pitch.placementId,
      company: pitch.company,
      name: pitch.name || "",
      note: pitch.note || "",
      at: pitch.at,
      logoUrl: pitch.logo ? `/api/${tenant.slug}/pitch-logos/${pitch.id}${previewQuery}` : null
    });
  }

  if (context.params?.id) {
    const id = context.params.id;
    if (!tenant.garments.some((garment) => garment.placements.some((placement) => placement.id === id))) {
      return new Response("Not found", { status: 404 });
    }
    const sale = await getStore({ name: "sold", consistency: "strong" }).get(`${tenant.slug}/${id}`, { type: "json" });
    const version = url.searchParams.get("v");
    if (!sale || sale.releasedAt || !sale.logo || sale.logo.at !== version) {
      return new Response("Not found", { status: 404 });
    }
    const asset = await getStore({ name: "tenant-assets", consistency: "strong" })
      .getWithMetadata(`${tenant.slug}/sponsor-logo/${id}`, { type: "arrayBuffer" });
    if (!asset) return new Response("Not found", { status: 404 });
    return new Response(req.method === "HEAD" ? null : asset.data, {
      headers: {
        "content-type": asset.metadata?.type || sale.logo.type,
        "cache-control": tenant.status === "draft" ? "private, no-store" : "public, max-age=60, must-revalidate",
        "content-security-policy": "default-src 'none'; sandbox",
        "x-content-type-options": "nosniff"
      }
    });
  }

  const variant = context.params?.variant || "";
  if (!["card", "stage900", "stage1500", "og"].includes(variant)) return new Response("Not found", { status: 404 });
  const version = url.searchParams.get("v");
  const record = await loadDynamicTenant(tenant.slug);
  if (!record?.settings?.poster || !/^[a-f0-9]{32}$/.test(version || "") ||
      record.settings.poster.version !== version) {
    return new Response("Not found", { status: 404 });
  }
  const key = `${tenant.slug}/poster/${version}/${variant}`;
  const asset = await getStore({ name: "tenant-assets", consistency: "strong" })
    .getWithMetadata(key, { type: "arrayBuffer" });
  if (!asset) return new Response("Not found", { status: 404 });
  const digest = record.settings.poster.digests?.[variant];
  if (!digest || createHash("sha256").update(Buffer.from(asset.data)).digest("hex") !== digest) {
    return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  }

  const headers = new Headers({
    "content-type": asset.metadata?.type || "image/jpeg",
    "content-security-policy": "default-src 'none'; sandbox",
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
  return new Response(req.method === "HEAD" ? null : asset.data, { headers });
}

export const config = {
  path: [
    "/api/:slug/poster/:variant",
    "/api/:slug/sponsor-logos/:id",
    "/api/:slug/pitches/:pitchId",
    "/api/:slug/pitch-logos/:pitchId"
  ]
};
