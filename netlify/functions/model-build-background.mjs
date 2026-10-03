import { hasValidBuildSignature } from "../lib/build-signature.mjs";
import { getTenant } from "../lib/tenants.mjs";
import { processBuild } from "../lib/model-build.mjs";

export default async function modelBuildBackground(req) {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  let body;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  if (!hasValidBuildSignature(body, req.headers.get("x-build-signature"))) {
    return new Response("Unauthorized", { status: 401 });
  }
  const tenant = await getTenant(body.slug);
  if (!tenant) return new Response("Tenant not found", { status: 404 });
  await processBuild(tenant, body.jobId, { origin: new URL(req.url).origin });
  return new Response("ok");
}
