import { getStore } from "@netlify/blobs";
import platform from "./platform.generated.json";
import { materializeConfig, getStarterKit } from "./starter-kits.mjs";
import { RESERVED_SLUGS, SLUG_PATTERN, validateConfig } from "./validate.mjs";

const STORE_NAME = "tenants";
const keyFor = (slug) => `tenant/${slug}`;
const store = () => getStore({ name: STORE_NAME, consistency: "strong" });
const queues = new Map();

export class TenantStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TenantStoreError";
    this.code = code;
  }
}

export async function loadDynamicTenant(slug) {
  if (typeof slug !== "string" || !slug) return null;
  return store().get(keyFor(slug), { type: "json" });
}

export async function listDynamicTenants() {
  const { blobs } = await store().list({ prefix: "tenant/" });
  const records = await Promise.all(blobs.map(({ key }) => store().get(key, { type: "json" })));
  return records.filter((record) => record && typeof record.slug === "string");
}

export async function isSlugAvailable(slug) {
  if (typeof slug !== "string" || !SLUG_PATTERN.test(slug)) return { ok: false, reason: "invalid" };
  if (RESERVED_SLUGS.has(slug)) return { ok: false, reason: "reserved" };
  if (slug.startsWith("demo-")) return { ok: false, reason: "demo" };
  if (platform.tenants?.[slug]) return { ok: false, reason: "static" };
  if (await loadDynamicTenant(slug)) return { ok: false, reason: "taken" };
  return { ok: true };
}

function validateRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new TenantStoreError("INVALID_RECORD", "A tenant record is required.");
  }
  if (!record.slug || typeof record.slug !== "string") {
    throw new TenantStoreError("INVALID_SLUG", "A tenant slug is required.");
  }
  if (!getStarterKit(record.kitId)) {
    throw new TenantStoreError("UNKNOWN_KIT", `Unknown starter kit: ${record.kitId}`);
  }
  if (!record.settings || typeof record.settings !== "object" || Array.isArray(record.settings)) {
    throw new TenantStoreError("INVALID_SETTINGS", "Tenant settings are required.");
  }
}

function materializeRecord(record, previous) {
  validateRecord(record);
  const settings = { ...structuredClone(record.settings), slug: record.slug };
  const config = materializeConfig(settings, record.kitId);
  validateConfig(config, `${record.slug}.json`);
  const now = new Date().toISOString();
  return {
    slug: record.slug,
    applicationId: record.applicationId,
    kitId: record.kitId,
    settings,
    config,
    createdAt: previous?.createdAt || record.createdAt || now,
    updatedAt: now,
    launchedAt: record.launchedAt ?? previous?.launchedAt ?? null
  };
}

export async function createDynamicTenant(record) {
  validateRecord(record);
  const availability = await isSlugAvailable(record.slug);
  if (!availability.ok) {
    const code = {
      invalid: "INVALID_SLUG",
      reserved: "RESERVED_SLUG",
      demo: "DEMO_SLUG",
      static: "STATIC_TENANT",
      taken: "DYNAMIC_TENANT_EXISTS"
    }[availability.reason] || "SLUG_UNAVAILABLE";
    throw new TenantStoreError(code, `Tenant slug is unavailable: ${record.slug}`);
  }
  const next = materializeRecord(record);
  await store().setJSON(keyFor(next.slug), next);
  return next;
}

export async function updateDynamicTenant(slug, mutate) {
  const previous = queues.get(slug) || Promise.resolve();
  const current = previous.then(async () => {
    const existing = await loadDynamicTenant(slug);
    if (!existing) throw new TenantStoreError("NOT_FOUND", `Dynamic tenant not found: ${slug}`);
    const changed = await mutate(structuredClone(existing));
    const next = materializeRecord({ ...existing, ...(changed || {}), slug }, existing);
    await store().setJSON(keyFor(slug), next);
    return next;
  });
  const queued = current.catch(() => {});
  queues.set(slug, queued);
  queued.then(
    () => { if (queues.get(slug) === queued) queues.delete(slug); },
    () => { if (queues.get(slug) === queued) queues.delete(slug); }
  );
  return current;
}
