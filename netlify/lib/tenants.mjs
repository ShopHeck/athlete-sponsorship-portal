import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import platform from "./platform.generated.json";
import { resolveTenantAssets } from "./render.mjs";
import { listDynamicTenants, loadDynamicTenant } from "./tenant-store.mjs";

export async function getTenant(slug) {
  const config = platform.tenants?.[slug];
  if (config) return resolveTenantAssets(config);
  const dynamic = await loadDynamicTenant(slug);
  return dynamic?.config ? resolveTenantAssets(dynamic.config) : null;
}

export async function listTenants() {
  const staticTenants = Object.values(platform.tenants || {});
  const staticSlugs = new Set(staticTenants.map((tenant) => tenant.slug));
  const dynamicTenants = (await listDynamicTenants())
    .filter((record) => !staticSlugs.has(record.slug))
    .map((record) => record.config)
    .filter(Boolean);
  return [...staticTenants, ...dynamicTenants].map(resolveTenantAssets);
}

export function isStaticTenant(slug) {
  return Boolean(platform.tenants?.[slug]);
}

function tokenMatches(candidate, expected) {
  if (typeof candidate !== "string" || !candidate || typeof expected !== "string" || !expected) return false;
  const expectedHash = createHash("sha256").update(expected).digest();
  const candidateHash = createHash("sha256").update(candidate).digest();
  return timingSafeEqual(expectedHash, candidateHash);
}

export function tenantPreviewToken(slug) {
  const secret = process.env.DASHBOARD_SECRET;
  if (!secret || typeof slug !== "string" || !slug) return null;
  return createHmac("sha256", secret).update(`tenant-preview:${slug}`).digest("hex").slice(0, 32);
}

export function globalPreviewTokenMatches(candidate) {
  const expected = process.env.PREVIEW_TOKEN;
  return tokenMatches(candidate, expected);
}

export function previewTokenMatches(candidate, slug) {
  return globalPreviewTokenMatches(candidate) || tokenMatches(candidate, tenantPreviewToken(slug));
}

export async function resolveTenantForApi(req, context, { allowQueryToken = false } = {}) {
  const slug = context.params?.slug || "";
  const tenant = await getTenant(slug);
  if (!tenant || tenant.status !== "draft") return tenant;

  const candidates = [req.headers.get("x-preview-token")];
  if (allowQueryToken) candidates.push(new URL(req.url).searchParams.get("preview"));
  return candidates.some((candidate) => previewTokenMatches(candidate, slug)) ? tenant : null;
}
