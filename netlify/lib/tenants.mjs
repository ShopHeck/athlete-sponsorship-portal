import { createHash, timingSafeEqual } from "node:crypto";
import platform from "./platform.generated.json";
import { resolveTenantAssets } from "./render.mjs";

export async function getTenant(slug) {
  const config = platform.tenants?.[slug];
  return config ? resolveTenantAssets(config) : null;
}

export async function listTenants() {
  return Object.values(platform.tenants || {}).map(resolveTenantAssets);
}

export function previewTokenMatches(candidate) {
  const expected = process.env.PREVIEW_TOKEN;
  if (!expected || typeof candidate !== "string" || !candidate) return false;
  const expectedHash = createHash("sha256").update(expected).digest();
  const candidateHash = createHash("sha256").update(candidate).digest();
  return timingSafeEqual(expectedHash, candidateHash);
}

export async function resolveTenantForApi(req, context, { allowQueryToken = false } = {}) {
  const tenant = await getTenant(context.params?.slug || "");
  if (!tenant || tenant.status !== "draft") return tenant;

  const candidates = [req.headers.get("x-preview-token")];
  if (allowQueryToken) candidates.push(new URL(req.url).searchParams.get("preview"));
  return candidates.some(previewTokenMatches) ? tenant : null;
}
