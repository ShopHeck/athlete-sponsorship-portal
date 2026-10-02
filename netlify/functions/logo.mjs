import { getStore } from "@netlify/blobs";
import { isPlacementId } from "../lib/sponsorship.mjs";

// GET /api/logos/:id → the current high bidder's uploaded logo for a placement.
export default async (req, context) => {
  const id = context.params?.id || "";
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  if (!isPlacementId(id)) return new Response("Not found", { status: 404 });
  const store = getStore({ name: "logos", consistency: "strong" });
  const hit = await store.getWithMetadata(id, { type: "arrayBuffer" });
  if (!hit) return new Response("Not found", { status: 404 });
  return new Response(req.method === "HEAD" ? null : hit.data, {
    headers: {
      "content-type": hit.metadata?.type || "image/png",
      "cache-control": "public, max-age=60, must-revalidate",
      "x-content-type-options": "nosniff"
    }
  });
};

export const config = { path: "/api/logos/:id" };
