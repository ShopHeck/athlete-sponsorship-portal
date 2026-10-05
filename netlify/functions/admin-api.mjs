import { createHash, timingSafeEqual } from "node:crypto";
import { purgeCache } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { json, forTenant } from "../lib/sponsorship.mjs";
import {
  adminSessionCookie,
  clearAdminCookie,
  dashboardEmailsFor,
  readAdminSession,
  sameOrigin
} from "../lib/dashboard-auth.mjs";
import { loadBuild, storeForTenant } from "../lib/model-build.mjs";
import {
  getLivePointer,
  loadReview,
  publishLiveModel,
  saveOperatorReview,
  unpublishLiveModel
} from "../lib/model-review.mjs";
import { resolveTenantAssets } from "../lib/render.mjs";
import { loadViews } from "../lib/reference-views.mjs";
import { getTenant, listTenants, tenantPreviewToken } from "../lib/tenants.mjs";
import { createDynamicTenant, isSlugAvailable, loadDynamicTenant } from "../lib/tenant-store.mjs";
import { getStarterKit, starterDefaults, STARTER_KITS } from "../lib/starter-kits.mjs";
import { SLUG_PATTERN, RESERVED_SLUGS } from "../lib/validate.mjs";

function tokenMatches(candidate, expected) {
  const candidateHash = createHash("sha256").update(candidate).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(candidateHash, expectedHash);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}

function platformUrl(req) {
  return (process.env.PLATFORM_URL || new URL(req.url).origin).replace(/\/+$/, "");
}

const applicationsStore = () => getStore({ name: "applications", consistency: "strong" });
const TIME_ZONES = new Set([
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London"
]);

async function applications(req) {
  const access = await authorize(req);
  if (access.response) return access.response;
  const { blobs } = await applicationsStore().list({ prefix: "application/" });
  const records = await Promise.all(blobs.map(({ key }) => applicationsStore().get(key, { type: "json" })));
  const rows = await Promise.all(records.filter(Boolean).map(async (record) => {
    const decision = await applicationsStore().get(`decision/${record.id}`, { type: "json" });
    return { ...record, decision: decision || { status: "pending" } };
  }));
  rows.sort((a, b) => Date.parse(b.receivedAt || "") - Date.parse(a.receivedAt || ""));
  return json({ applications: rows, kits: STARTER_KITS });
}

function applicationError(code, error) {
  return json({ error }, code);
}

function validEventDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value &&
    date.getTime() > Date.now();
}

async function applicantEmail(req, application, slug) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return;
  const base = platformUrl(req);
  const dashboardUrl = `${base}/dashboard`;
  const preview = tenantPreviewToken(slug);
  const previewUrl = preview
    ? `${base}/${encodeURIComponent(slug)}?preview=${encodeURIComponent(preview)}`
    : `${base}/${encodeURIComponent(slug)}`;
  const text = [
    `Your private portal is ready.`,
    "",
    `Sign in at ${dashboardUrl} with ${application.email}.`,
    `Preview: ${previewUrl}`,
    "",
    "You can review your settings and press Go live when the readiness checks pass."
  ].join("\n");
  const html = `<p>Your private portal is ready.</p><p><a href="${escapeHtml(previewUrl)}">Preview your portal</a></p><p>Sign in at <a href="${escapeHtml(dashboardUrl)}">${escapeHtml(dashboardUrl)}</a> with ${escapeHtml(application.email)}.</p><p>You can review your settings and press Go live when the readiness checks pass.</p>`;
  try {
    const response = await fetch(`${process.env.RESEND_API_BASE || "https://api.resend.com"}/emails`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: "Athlete Sponsorship Portal <sponsors@michaelheckert.com>",
        to: [application.email],
        subject: "Your private sponsorship portal is ready",
        text,
        html
      })
    });
    if (!response.ok) throw new Error(`Resend ${response.status}`);
  } catch (err) {
    console.error("Applicant portal email failed", application.id, err);
  }
}

async function createApplication(req, id) {
  const access = await authorize(req);
  if (access.response) return access.response;
  const application = await applicationsStore().get(`application/${id}`, { type: "json" });
  if (!application) return applicationError(404, "Application not found.");
  const existingDecision = await applicationsStore().get(`decision/${id}`, { type: "json" });
  if (existingDecision?.status === "created") return applicationError(409, "This application has already been created.");
  let body;
  try { body = await req.json(); } catch { return applicationError(400, "A valid request body is required."); }
  const slug = typeof body?.slug === "string" ? body.slug.trim() : "";
  if (!SLUG_PATTERN.test(slug)) return applicationError(400, "Slug must use lowercase letters, numbers and hyphens.");
  if (slug.startsWith("demo-")) return applicationError(400, "Demo slugs are reserved.");
  if (RESERVED_SLUGS.has(slug)) return applicationError(400, "That slug is reserved.");
  const eventName = typeof body?.eventName === "string" ? body.eventName.trim() : "";
  if (eventName.length < 1 || eventName.length > 80) return applicationError(400, "Event name must be between 1 and 80 characters.");
  const kit = getStarterKit(body?.kitId);
  if (!kit) return applicationError(400, "Unknown starter kit.");
  if (!validEventDate(body?.eventDate)) return applicationError(400, "Event date must be a future date in YYYY-MM-DD format.");
  if (!TIME_ZONES.has(body?.timeZone)) return applicationError(400, "Select an accepted timezone.");
  const feePercent = Number(body?.feePercent);
  if (!Number.isInteger(feePercent) || feePercent < 1 || feePercent > 50) {
    return applicationError(400, "Fee percent must be between 1 and 50.");
  }
  const availability = await isSlugAvailable(slug);
  if (!availability.ok) {
    if (availability.reason === "static" || availability.reason === "taken") {
      return applicationError(409, "That slug is already in use.");
    }
    return applicationError(400, "That slug is unavailable.");
  }
  const defaults = starterDefaults({
    fullName: application.name,
    eventName,
    eventDate: body.eventDate,
    minBid: kit.pricing.minBid,
    lockPrice: kit.pricing.lockPrice
  }, kit.id);
  const deadline = new Date(`${body.eventDate}T00:00:00.000Z`);
  deadline.setUTCDate(deadline.getUTCDate() - 1);
  deadline.setUTCHours(23, 59, 59, 0);
  let record;
  try {
    record = await createDynamicTenant({
      slug,
      applicationId: application.id,
      kitId: kit.id,
      settings: {
        slug,
        fullName: application.name,
        email: application.email,
        eventName,
        eventDate: body.eventDate,
        timeZone: body.timeZone,
        deadline: deadline.toISOString(),
        minBid: kit.pricing.minBid,
        increment: kit.pricing.increment,
        lockPrice: kit.pricing.lockPrice,
        packageName: defaults.packageName,
        benefits: defaults.benefits,
        intro: defaults.intro,
        accent: "#2f7bff",
        offeredPlacementIds: kit.placements.map((placement) => placement.id),
        feePercent,
        status: "draft"
      }
    });
  } catch (err) {
    if (err.code === "STATIC_TENANT" || err.code === "DYNAMIC_TENANT_EXISTS") {
      return applicationError(409, "That slug is already in use.");
    }
    if (err.code === "INVALID_SLUG" || err.code === "RESERVED_SLUG" || err.code === "DEMO_SLUG") {
      return applicationError(400, "That slug is unavailable.");
    }
    throw err;
  }
  await applicationsStore().setJSON(`decision/${application.id}`, {
    status: "created",
    slug: record.slug,
    at: new Date().toISOString()
  });
  await applicantEmail(req, application, slug);
  const preview = tenantPreviewToken(slug);
  return new Response(JSON.stringify({
    slug,
    dashboardUrl: `${platformUrl(req)}/dashboard`,
    previewUrl: preview ? `${platformUrl(req)}/${slug}?preview=${preview}` : `${platformUrl(req)}/${slug}`
  }), {
    status: 201,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}

async function dismissApplication(req, id) {
  const access = await authorize(req);
  if (access.response) return access.response;
  const application = await applicationsStore().get(`application/${id}`, { type: "json" });
  if (!application) return applicationError(404, "Application not found.");
  const existing = await applicationsStore().get(`decision/${id}`, { type: "json" });
  if (existing?.status === "created") return applicationError(409, "This application has already been created.");
  const decision = { status: "dismissed", at: new Date().toISOString() };
  await applicationsStore().setJSON(`decision/${id}`, decision);
  return json({ decision });
}

async function authorize(req) {
  if (!process.env.DASHBOARD_SECRET) {
    return { response: json({ error: "DASHBOARD_SECRET is not configured." }, 503) };
  }
  if (!readAdminSession(req)) return { response: json({ error: "Sign in required." }, 401) };
  return {};
}

async function modelState(tenant) {
  const store = storeForTenant();
  const [submission, live] = await Promise.all([
    store.get(`${tenant.slug}/submission`, { type: "json" }),
    getLivePointer(tenant)
  ]);
  const staticOwnModel = resolveTenantAssets(tenant).model?.startsWith(`/tenants/${tenant.slug}/`) === true;
  const ownModel = staticOwnModel || Boolean(live);
  const views = await loadViews(tenant, { submitted: Boolean(submission), ownModel });
  const build = await loadBuild(tenant, {
    viewsStatus: views.status,
    ownModel,
    liveJobId: live?.jobId ?? null
  });
  return { build, review: await loadReview(tenant, build) };
}

async function session(req) {
  if (!process.env.ADMIN_TOKEN || !process.env.DASHBOARD_SECRET) {
    return json({ error: "Admin sign-in is not configured." }, 503);
  }
  let body;
  try { body = await req.json(); } catch { body = null; }
  const candidate = typeof body?.token === "string" ? body.token : "";
  if (!tokenMatches(candidate, process.env.ADMIN_TOKEN)) {
    return json({ error: "Unauthorized" }, 401);
  }
  const response = json({ ok: true });
  response.headers.append("set-cookie", adminSessionCookie(req));
  return response;
}

async function reviews(req) {
  const access = await authorize(req);
  if (access.response) return access.response;
  const tenants = await Promise.all((await listTenants()).map(async (tenant) => {
    const { build, review } = await modelState(tenant);
    return {
      slug: tenant.slug,
      displayName: tenant.athlete.displayName,
      tenantStatus: tenant.status,
      review,
      build: {
        jobId: build.jobId,
        attempt: build.attempt,
        attemptsLeft: build.attemptsLeft
      }
    };
  }));
  return json(tenants);
}

async function purgeTenant(slug) {
  try {
    await purgeCache({ tags: [`tenant-${slug}`] });
  } catch (error) {
    console.error("Tenant cache purge failed.", {
      slug,
      message: error?.message || "Unknown cache purge error"
    });
  }
}

async function modelAction(req, slug, action) {
  const access = await authorize(req);
  if (access.response) return access.response;
  const tenant = await getTenant(slug);
  if (!tenant) return json({ error: "Tenant not found." }, 404);
  if (tenant.demo) return json({ error: "Demo portals do not support Model Studio." }, 409);

  let body = {};
  if (action !== "unpublish") {
    try { body = await req.json(); } catch { body = null; }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json({ error: "A valid request body is required." }, 400);
    }
  }

  const { build, review } = await modelState(tenant);
  if (action === "publish") {
    if (review.status !== "operator_review" || body.jobId !== build.jobId) {
      return json({ error: "This model is not waiting for operator sign-off." }, 409);
    }
    const live = await publishLiveModel(tenant, body.jobId);
    if (!live) return json({ error: "The model asset is no longer available." }, 409);
    await purgeTenant(slug);
    const base = platformUrl(req);
    const services = forTenant(tenant, { portalUrl: `${base}/${slug}` });
    await services.tryEmail({
      to: dashboardEmailsFor(tenant),
      subject: "Your 3D model is live",
      text: `Your 3D model is now live on your sponsorship portal:\n${base}/${encodeURIComponent(slug)}`
    });
    return json({ review: await loadReview(tenant, build) });
  }

  if (action === "send-back") {
    const note = typeof body.note === "string" ? body.note.trim() : "";
    if (!note || note.length > 500) {
      return json({ error: "A note of 500 characters or fewer is required." }, 400);
    }
    if (review.status !== "operator_review" || body.jobId !== build.jobId) {
      return json({ error: "This model is not waiting for operator sign-off." }, 409);
    }
    const at = new Date().toISOString();
    await saveOperatorReview(tenant, {
      jobId: body.jobId,
      decision: "changes",
      note,
      at
    });
    const base = platformUrl(req);
    const services = forTenant(tenant, { portalUrl: `${base}/${slug}` });
    await services.tryEmail({
      to: dashboardEmailsFor(tenant),
      subject: "Changes requested on your 3D model",
      text: `We've reviewed your 3D model and would like you to make a change:\n\n${note}\n\nOpen your private preview:\n${base}/dashboard/${encodeURIComponent(slug)}/model/studio`
    });
    return json({ review: (await modelState(tenant)).review });
  }

  if (action === "unpublish") {
    if (review.status !== "live") return json({ error: "This model is not live." }, 409);
    const live = await unpublishLiveModel(tenant);
    if (!live) return json({ error: "This model is no longer live." }, 409);
    await purgeTenant(slug);
    return json({ review: (await modelState(tenant)).review });
  }

  return json({ error: "Unknown model action." }, 404);
}

export default async function adminApi(req) {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  if (req.method === "POST" && !sameOrigin(req)) return json({ error: "Forbidden" }, 403);

  if (parts.length === 3 && parts[0] === "api" && parts[1] === "admin") {
    if (parts[2] === "session") {
      if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
      return session(req);
    }
    if (parts[2] === "logout") {
      if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
      const response = json({ ok: true });
      response.headers.append("set-cookie", clearAdminCookie(req));
      return response;
    }
    if (parts[2] === "reviews") {
      if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
      return reviews(req);
    }
    if (parts[2] === "applications") {
      if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
      return applications(req);
    }
  }

  if (parts.length === 5 && parts[0] === "api" && parts[1] === "admin" &&
      parts[2] === "applications" && ["create", "dismiss"].includes(parts[4])) {
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    return parts[4] === "create"
      ? createApplication(req, parts[3])
      : dismissApplication(req, parts[3]);
  }

  if (parts.length === 5 && parts[0] === "api" && parts[1] === "admin" &&
      parts[3] === "model" && ["publish", "send-back", "unpublish"].includes(parts[4])) {
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    return modelAction(req, parts[2], parts[4]);
  }
  return json({ error: "Admin API route not found." }, 404);
}

export const config = {
  path: [
    "/api/admin/session",
    "/api/admin/logout",
    "/api/admin/reviews",
    "/api/admin/applications",
    "/api/admin/applications/:id/create",
    "/api/admin/applications/:id/dismiss",
    "/api/admin/:slug/model/publish",
    "/api/admin/:slug/model/send-back",
    "/api/admin/:slug/model/unpublish"
  ]
};
