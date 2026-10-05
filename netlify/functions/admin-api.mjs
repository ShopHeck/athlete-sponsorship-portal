import { createHash, timingSafeEqual } from "node:crypto";
import { purgeCache } from "@netlify/functions";
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
import { getTenant, listTenants } from "../lib/tenants.mjs";

function tokenMatches(candidate, expected) {
  const candidateHash = createHash("sha256").update(candidate).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(candidateHash, expectedHash);
}

function platformUrl(req) {
  return (process.env.PLATFORM_URL || new URL(req.url).origin).replace(/\/+$/, "");
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
    "/api/admin/:slug/model/publish",
    "/api/admin/:slug/model/send-back",
    "/api/admin/:slug/model/unpublish"
  ]
};
