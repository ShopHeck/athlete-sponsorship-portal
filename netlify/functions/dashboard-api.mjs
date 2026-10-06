import { getStore } from "@netlify/blobs";
import { purgeCache } from "@netlify/functions";
import { forTenant, json } from "../lib/sponsorship.mjs";
import {
  allowLoginEmail,
  readAdminSession,
  clearSessionCookie,
  consumeLoginToken,
  createLoginToken,
  dashboardEmailsFor,
  sameOrigin,
  sessionCookie,
  sessionFor
} from "../lib/dashboard-auth.mjs";
import { resolveTenantAssets } from "../lib/render.mjs";
import {
  advanceViews,
  getViewAsset,
  loadViews,
  recordViewDecision,
  startViews
} from "../lib/reference-views.mjs";
import {
  advanceBuild,
  getBuildAsset,
  loadBuild,
  startBuild
} from "../lib/model-build.mjs";
import { getLivePointer, loadReview, saveAthleteReview } from "../lib/model-review.mjs";
import { MeshyConfigurationError } from "../lib/meshy.mjs";
import { getTenant, listTenants, tenantPreviewToken } from "../lib/tenants.mjs";
import { getStarterKit } from "../lib/starter-kits.mjs";
import { loadDynamicTenant, TenantStoreError, updateDynamicTenant } from "../lib/tenant-store.mjs";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ANGLES = ["front", "back", "left", "right", "face"];
const REQUIRED_ANGLES = ["front", "back", "left", "right"];
const PHOTO_WARNINGS = new Set(["blurry", "dark", "bright", "no_person", "multiple_people", "not_full_body", "landscape"]);
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
const TIME_ZONES = new Set([
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London"
]);

export function jpegSize(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;

  let offset = 2;
  while (offset < data.length) {
    if (data[offset++] !== 0xff) continue;
    while (data[offset] === 0xff) offset++;
    const marker = data[offset++];
    if (marker === undefined) return null;
    if (marker === 0x00) continue;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > data.length) return null;

    const segmentLength = (data[offset] << 8) | data[offset + 1];
    if (segmentLength < 2 || offset + segmentLength > data.length) return null;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (segmentLength < 7) return null;
      const height = (data[offset + 3] << 8) | data[offset + 4];
      const width = (data[offset + 5] << 8) | data[offset + 6];
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += segmentLength;
  }
  return null;
}

function platformUrl(req) {
  return (process.env.PLATFORM_URL || new URL(req.url).origin).replace(/\/+$/, "");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[char]));
}

function formBody(req) {
  return (req.headers.get("content-type") || "").includes("application/x-www-form-urlencoded");
}

function redirect(location, cookie) {
  const headers = new Headers({ location, "cache-control": "no-store" });
  if (cookie) headers.append("set-cookie", cookie);
  return new Response(null, { status: 303, headers });
}

function adminAuthError(req) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return json({ error: "ADMIN_TOKEN is not configured." }, 503);
  if (req.headers.get("authorization") !== `Bearer ${token}`) return json({ error: "Unauthorized" }, 401);
  return null;
}

async function login(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "A valid email address is required." }, 400);
  }
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!EMAIL.test(email)) return json({ error: "A valid email address is required." }, 400);

  const base = platformUrl(req);
  const tenants = (await listTenants()).filter((tenant) => dashboardEmailsFor(tenant).includes(email));
  let allowed = false;
  if (tenants.length) {
    try {
      allowed = await allowLoginEmail(email);
    } catch (err) {
      console.error("Dashboard login rate limit failed", err);
    }
  }
  if (allowed) {
    for (const tenant of tenants) {
      try {
        const { nonce } = await createLoginToken(tenant.slug, email);
        const link = `${base}/dashboard/auth?token=${nonce}`;
        const services = forTenant(tenant, { portalUrl: `${base}/${tenant.slug}` });
        await services.tryEmail({
          to: email,
          subject: `Your ${tenant.athlete.displayName} sponsorship dashboard`,
          text: `Sign in to the ${tenant.athlete.displayName} sponsorship dashboard using this link:\n${link}\n\nThis link expires in 15 minutes.`,
          html: `<p>Sign in to the ${escapeHtml(tenant.athlete.displayName)} sponsorship dashboard using this link:</p><p><a href="${escapeHtml(link)}">Open dashboard</a></p><p>This link expires in 15 minutes.</p>`
        });
      } catch (err) {
        console.error("Dashboard login email failed", tenant.slug, err);
      }
    }
  }
  return json({ ok: true });
}

async function session(req) {
  const isForm = formBody(req);
  let token = "";
  try {
    const raw = await req.text();
    if (isForm) token = new URLSearchParams(raw).get("token") || "";
    else token = JSON.parse(raw).token || "";
  } catch {
    if (!isForm) return json({ error: "This sign-in link is invalid or has expired." }, 400);
  }

  const result = await consumeLoginToken(token);
  if (!result) {
    return isForm
      ? redirect("/dashboard?error=link")
      : json({ error: "This sign-in link is invalid or has expired." }, 400);
  }
  const cookie = sessionCookie(result.slug, result.email, req);
  if (isForm) return redirect(`/dashboard/${encodeURIComponent(result.slug)}`, cookie);
  const response = json({ slug: result.slug });
  response.headers.append("set-cookie", cookie);
  return response;
}

async function logout(req) {
  const cookie = clearSessionCookie(req);
  if (formBody(req)) return redirect("/dashboard", cookie);
  const response = json({ ok: true });
  response.headers.append("set-cookie", cookie);
  return response;
}

async function link(req, slug) {
  const authError = adminAuthError(req);
  if (authError) return authError;
  const tenant = await getTenant(slug);
  if (!tenant) return json({ error: "Tenant not found." }, 404);
  const email = (tenant.contact?.notifyEmail || "").trim().toLowerCase();
  if (!EMAIL.test(email)) return json({ error: "Tenant notification email is invalid." }, 400);
  const { nonce, exp } = await createLoginToken(tenant.slug, email);
  return json({
    url: `${platformUrl(req)}/dashboard/auth?token=${nonce}`,
    expiresAt: new Date(exp).toISOString()
  });
}

function placementSummary(placement, record, soldDetail) {
  const history = record?.history || [];
  const invoice = record?.invoice;
  const state = soldDetail
    ? "sold"
    : record?.locked
      ? "locked"
      : record?.closed
        ? "won"
        : history.length || record?.high
          ? "bidding"
          : "open";
  const logoUrl = soldDetail?.logo || (record?.logo
    ? `/api/${placement.slug}/logos/${placement.id}?v=${encodeURIComponent(record.logo.at || "")}`
    : null);
  return {
    id: placement.id,
    label: placement.label,
    garment: placement.garment,
    garmentLabel: placement.garmentLabel,
    side: placement.side,
    state,
    high: record?.high || 0,
    bidCount: history.length,
    lastBidAt: history.at(-1)?.at || null,
    bidder: record?.bidder ? {
      company: record.bidder.company || "",
      name: record.bidder.name || "",
      email: record.bidder.email || "",
      phone: record.bidder.phone || ""
    } : null,
    sponsor: soldDetail?.sponsor || record?.lockedBy?.company || null,
    soldSource: soldDetail?.source || null,
    soldAmount: soldDetail?.amount ?? null,
    soldNote: soldDetail?.note || null,
    invoice: invoice ? {
      status: invoice.status || null,
      number: invoice.number || null,
      url: invoice.url || null,
      amount: Number.isFinite(invoice.amount) ? invoice.amount : null,
      paidAt: invoice.paidAt || null,
      amountPaid: Number.isFinite(invoice.amountPaid) ? invoice.amountPaid : null
    } : null,
    logoUrl,
    history: history.map((entry) => ({
      at: entry.at || null,
      type: entry.type || "",
      amount: Number.isFinite(entry.amount) ? entry.amount : null,
      company: entry.company || "",
      name: entry.name || "",
      email: entry.email || "",
      phone: entry.phone || "",
      note: entry.note || ""
    }))
  };
}

function placementConfigs(tenant) {
  return tenant.garments.flatMap((garment) => garment.placements.map((placement) => ({
    ...placement,
    slug: tenant.slug,
    garment: garment.id,
    garmentLabel: garment.tab
  })));
}

async function loadOnboarding(slug) {
  const store = getStore({ name: "onboarding", consistency: "strong" });
  const [tour, checklist, previewed, shared] = await Promise.all([
    store.get(`${slug}/tour`, { type: "json" }),
    store.get(`${slug}/checklist`, { type: "json" }),
    store.get(`${slug}/previewed`, { type: "json" }),
    store.get(`${slug}/shared`, { type: "json" })
  ]);
  return {
    tourCompletedAt: tour?.at ?? null,
    checklistDismissedAt: checklist?.dismissedAt ?? null,
    previewedAt: previewed?.at ?? null,
    sharedAt: shared?.at ?? null
  };
}

async function loadStudio(tenant, progress = {}, buildProgress) {
  const store = getStore({ name: "model-studio", consistency: "strong" });
  const slug = tenant.slug;
  const [consent, kit, submission, ...photoMetadata] = await Promise.all([
    store.get(`${slug}/consent`, { type: "json" }),
    store.get(`${slug}/kit`, { type: "json" }),
    store.get(`${slug}/submission`, { type: "json" }),
    ...ANGLES.map((angle) => store.getMetadata(`${slug}/photo/${angle}`))
  ]);
  const photos = Object.fromEntries(ANGLES.map((angle, index) => {
    const metadata = photoMetadata[index]?.metadata;
    return [angle, metadata ? {
      width: metadata.width,
      height: metadata.height,
      size: metadata.size,
      warnings: metadata.warnings || [],
      at: metadata.at
      } : null];
  }));
  const live = await getLivePointer(tenant);
  const hasOwnModel = resolveTenantAssets(tenant).model?.startsWith(`/tenants/${slug}/`) === true || Boolean(live);
  const views = await loadViews(tenant, {
    submitted: Boolean(submission),
    ownModel: hasOwnModel,
    progress
  });
  const build = await loadBuild(tenant, {
    viewsStatus: views.status,
    ownModel: hasOwnModel,
    liveJobId: live?.jobId ?? null,
    progress: buildProgress
  });
  const review = await loadReview(tenant, build);
  const missing = [];
  if (!consent) missing.push("consent");
  if (!kit) missing.push("kit");
  for (const angle of REQUIRED_ANGLES) {
    if (!photos[angle]) missing.push(`photo:${angle}`);
  }
  const hasInputs = Boolean(consent || kit || photoMetadata.some(Boolean));
  return {
    status: hasOwnModel ? "ready" : submission ? "submitted" : hasInputs ? "collecting" : "not_started",
    hasOwnModel,
    consent: consent ? { acceptedAt: consent.acceptedAt, version: consent.version } : null,
    kit: kit ? { shirt: kit.shirt, shorts: kit.shorts, waistband: kit.waistband, notes: kit.notes } : null,
    photos,
    submittedAt: submission?.submittedAt ?? null,
    missing,
    views,
    build,
    review
  };
}

async function summary(req, slug) {
  const tenant = await getTenant(slug);
  if (!tenant) return json({ error: "Tenant not found." }, 404);
  if (!sessionFor(req, slug)) return json({ error: "Sign in required" }, 401);

  const base = platformUrl(req);
  const portalUrl = `${base}/${tenant.slug}`;
  const dynamicRecord = await loadDynamicTenant(slug);
  const services = forTenant(tenant, { portalUrl });
  const [record, readiness, placements, onboarding, studio] = await Promise.all([
    services.connect.record(),
    services.connect.readiness(),
    loadPlacementsForSummary(tenant, portalUrl),
    loadOnboarding(tenant.slug),
    loadStudio(tenant)
  ]);
  const status = readiness.status || record?.status || {};
  const totals = {
    placements: placements.length,
    open: placements.filter((placement) => placement.state === "open").length,
    bidding: placements.filter((placement) => placement.state === "bidding").length,
    sold: placements.filter((placement) => ["locked", "won", "sold"].includes(placement.state)).length,
    committed: placements.reduce((sum, placement) => {
      if (placement.state === "locked" || placement.state === "won") return sum + (placement.high || 0);
      if (placement.state === "sold" && placement.soldSource === "dashboard") return sum + (placement.soldAmount || 0);
      return sum;
    }, 0),
    paid: placements.reduce((sum, placement) => sum + (placement.invoice?.amountPaid || 0), 0)
  };
  const kit = dynamicRecord ? getStarterKit(dynamicRecord.kitId) : null;
  const scope = dynamicRecord
    ? tenant.status === "live" ? "copy" : "full"
    : "none";
  const previewToken = tenant.status === "draft" ? tenantPreviewToken(slug) : null;
  return json({
    tenant: {
      slug: tenant.slug,
      displayName: tenant.athlete.displayName,
      status: tenant.status,
      eventName: tenant.event.name,
      portalUrl,
      previewUrl: previewToken ? `${base}/${encodeURIComponent(slug)}?preview=${encodeURIComponent(previewToken)}` : null,
      embedCode: `<iframe src="${escapeHtml(portalUrl)}" title="${escapeHtml(tenant.copy.embedTitle)}" loading="lazy" allow="fullscreen" style="width:100%;height:900px;border:0"></iframe>`,
      currency: tenant.pricing.currency,
      accent: tenant.brand?.accent || null
    },
    settings: {
      editable: Boolean(dynamicRecord),
      scope,
      reason: scope === "none" ? "Managed by the platform team" : null,
      values: dynamicRecord ? {
        eventName: dynamicRecord.settings.eventName,
        eventDate: dynamicRecord.settings.eventDate,
        timeZone: dynamicRecord.settings.timeZone,
        deadline: dynamicRecord.settings.deadline,
        minBid: dynamicRecord.settings.minBid,
        increment: dynamicRecord.settings.increment,
        lockPrice: dynamicRecord.settings.lockPrice,
        packageName: dynamicRecord.settings.packageName,
        benefits: dynamicRecord.settings.benefits,
        intro: dynamicRecord.settings.intro,
        accent: dynamicRecord.settings.accent,
        offeredPlacementIds: dynamicRecord.settings.offeredPlacementIds
      } : {
        eventName: tenant.event.name,
        eventDate: tenant.event.date,
        timeZone: tenant.event.timeZone,
        deadline: tenant.pricing.deadline,
        minBid: tenant.pricing.minBid,
        increment: tenant.pricing.increment,
        lockPrice: tenant.pricing.lockPrice,
        packageName: tenant.packageName,
        benefits: tenant.benefits,
        intro: tenant.hero.intro,
        accent: tenant.brand?.accent || null,
        offeredPlacementIds: tenant.garments.flatMap((garment) => garment.placements.map((placement) => placement.id))
      },
      kit: kit ? {
        id: kit.id,
        name: kit.name,
        placements: kit.placements.map((placement) => ({
          id: placement.id,
          label: placement.label,
          garmentName: placement.garmentName,
          offered: dynamicRecord.settings.offeredPlacementIds.includes(placement.id)
        }))
      } : null
    },
    launch: {
      available: Boolean(dynamicRecord && tenant.status === "draft"),
      checks: dynamicRecord && tenant.status === "draft"
        ? await launchChecks(tenant, dynamicRecord, base)
        : []
    },
    pricing: {
      minBid: tenant.pricing.minBid,
      increment: tenant.pricing.increment,
      lockPrice: tenant.pricing.lockPrice,
      deadline: tenant.pricing.deadline
    },
    payments: {
      mode: tenant.payments.mode,
      feePercent: tenant.payments.feePercent ?? null,
      ready: readiness.ready,
      accountId: readiness.accountId || record?.accountId || null,
      chargesEnabled: status.chargesEnabled === true,
      payoutsEnabled: status.payoutsEnabled === true,
      detailsSubmitted: status.detailsSubmitted === true,
      currentlyDue: Array.isArray(status.currentlyDue) ? status.currentlyDue : [],
      disabledReason: status.disabledReason || null,
      deauthorized: Boolean(record?.deauthorizedAt)
    },
    totals,
    placements,
    onboarding,
    model: {
      status: studio.status,
      hasOwnModel: studio.hasOwnModel,
      photoCount: Object.values(studio.photos).filter(Boolean).length,
      submittedAt: studio.submittedAt,
      views: studio.views,
      build: studio.build,
      review: studio.review
    }
  });
}

function isDateOnly(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function eventEnd(value) {
  return Date.parse(`${value}T23:59:59.999Z`);
}

function validSettings(settings, kit) {
  const eventName = typeof settings.eventName === "string" ? settings.eventName.trim() : "";
  if (eventName.length < 1 || eventName.length > 80) return "Event name must be between 1 and 80 characters.";
  if (!isDateOnly(settings.eventDate) || settings.eventDate < todayUtc()) return "Event date must be today or later in YYYY-MM-DD format.";
  if (!TIME_ZONES.has(settings.timeZone)) return "Select an accepted timezone.";
  const deadline = Date.parse(settings.deadline);
  if (!Number.isFinite(deadline) || deadline <= Date.now()) return "Deadline must be a future ISO date.";
  if (deadline > eventEnd(settings.eventDate)) return "Deadline must be no later than the event date.";
  if (!Number.isInteger(settings.minBid) || settings.minBid < 50 || settings.minBid > 100000) return "Minimum bid must be an integer from 50 to 100000.";
  if (!Number.isInteger(settings.increment) || settings.increment < 5 || settings.increment > settings.minBid) return "Increment must be an integer from 5 through the minimum bid.";
  if (!Number.isInteger(settings.lockPrice) || settings.lockPrice <= settings.minBid || settings.lockPrice > 250000) return "Lock price must be greater than the minimum bid and at most 250000.";
  if (typeof settings.packageName !== "string" || settings.packageName.trim().length < 1 || settings.packageName.trim().length > 60) return "Package name must be between 1 and 60 characters.";
  if (!Array.isArray(settings.benefits) || settings.benefits.length < 1 || settings.benefits.length > 8 ||
      settings.benefits.some((benefit) => typeof benefit !== "string" || benefit.trim().length < 1 || benefit.trim().length > 140)) {
    return "Benefits must contain 1 to 8 non-empty items of 140 characters or fewer.";
  }
  if (typeof settings.intro !== "string" || settings.intro.length > 400) return "Intro must be 400 characters or fewer.";
  if (typeof settings.accent !== "string" || !/^#[0-9a-f]{6}$/i.test(settings.accent)) return "Accent must be a hex color such as #2f7bff.";
  if (!Array.isArray(settings.offeredPlacementIds) || settings.offeredPlacementIds.length < 1) return "Select at least one placement.";
  const placementIds = new Set(kit.placements.map((placement) => placement.id));
  if (settings.offeredPlacementIds.some((id) => typeof id !== "string" || !placementIds.has(id))) return "Select only placements from this starter kit.";
  return null;
}

export async function launchChecks(tenant, record, base) {
  const services = forTenant(tenant, { portalUrl: `${base}/${tenant.slug}` });
  let readiness;
  try {
    readiness = await services.connect.readiness();
  } catch {
    readiness = { ready: false };
  }
  const live = await getLivePointer(tenant);
  const eventDateOk = isDateOnly(record.settings.eventDate) && record.settings.eventDate >= todayUtc();
  const deadlineAt = Date.parse(record.settings.deadline);
  const deadlineOk = Number.isFinite(deadlineAt) && deadlineAt > Date.now() &&
    deadlineAt <= eventEnd(record.settings.eventDate);
  const pricingOk = Number.isInteger(record.settings.minBid) &&
    Number.isInteger(record.settings.increment) &&
    Number.isInteger(record.settings.lockPrice) &&
    record.settings.minBid >= 50 &&
    record.settings.increment >= 5 &&
    record.settings.increment <= record.settings.minBid &&
    record.settings.lockPrice > record.settings.minBid &&
    record.settings.lockPrice <= 250000;
  const placementsOk = Array.isArray(record.settings.offeredPlacementIds) && record.settings.offeredPlacementIds.length > 0;
  return [
    {
      id: "payouts",
      label: "Connect payouts ready",
      ok: readiness.ready === true,
      detail: readiness.ready ? "Your payout account is ready." : "Finish Stripe Connect setup before launch."
    },
    {
      id: "likeness",
      label: "Published 3D likeness",
      ok: Boolean(live?.jobId),
      detail: live?.jobId ? "A published athlete-specific model is ready." : "Publish your athlete-specific model before launch."
    },
    {
      id: "event-date",
      label: "Event date",
      ok: eventDateOk,
      detail: eventDateOk ? "The event date is valid." : "Choose an event date today or later."
    },
    {
      id: "deadline",
      label: "Bidding deadline",
      ok: deadlineOk,
      detail: deadlineOk ? "The deadline is before the event." : "Choose a future deadline no later than the event date."
    },
    {
      id: "pricing",
      label: "Pricing is valid",
      ok: pricingOk,
      detail: pricingOk ? "Minimum bid, increment, and lock price are valid." : "Review the pricing values."
    },
    {
      id: "placements",
      label: "At least one placement",
      ok: placementsOk,
      detail: placementsOk ? "At least one placement is offered." : "Offer at least one placement."
    }
  ];
}

async function updateSettings(req, slug) {
  const tenant = await getTenant(slug);
  if (!tenant) return json({ error: "Tenant not found." }, 404);
  const session = sessionFor(req, slug);
  if (!session) return json({ error: "Sign in required" }, 401);
  const record = await loadDynamicTenant(slug);
  if (!record) return json({ error: "Portal settings are managed by the platform team." }, 403);
  let body;
  try { body = await req.json(); } catch { return json({ error: "A valid request body is required." }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "A valid request body is required." }, 400);
  const current = record.settings;
  const copyOnly = tenant.status === "live";
  if (copyOnly && ["eventName", "eventDate", "timeZone", "deadline", "minBid", "increment", "lockPrice", "offeredPlacementIds"].some((key) =>
    Object.hasOwn(body, key) && JSON.stringify(body[key]) !== JSON.stringify(current[key]))) {
    return json({ error: "Event, pricing, dates and placements are locked after launch" }, 409);
  }
  const next = {
    ...current,
    ...Object.fromEntries(Object.entries(body).filter(([key]) => [
      "eventName", "eventDate", "timeZone", "deadline", "minBid", "increment",
      "lockPrice", "packageName", "benefits", "intro", "accent", "offeredPlacementIds"
    ].includes(key)))
  };
  const kit = getStarterKit(record.kitId);
  const error = validSettings(next, kit);
  if (error) return json({ error }, 400);
  try {
    const updated = await updateDynamicTenant(slug, (existing) => ({
      ...existing,
      settings: { ...existing.settings, ...next }
    }));
    if (copyOnly) await purgeTenantCache(slug);
    return json({ ok: true, settings: updated.settings });
  } catch (err) {
    if (err instanceof TenantStoreError && err.code === "NOT_FOUND") return json({ error: "Tenant not found." }, 404);
    console.error("Dashboard settings update failed", slug, err);
    return json({ error: "Unable to save portal settings." }, 500);
  }
}

async function purgeTenantCache(slug) {
  try {
    await purgeCache({ tags: [`tenant-${slug}`] });
  } catch (err) {
    console.error("Tenant cache purge failed", slug, err);
  }
}

async function launch(req, slug) {
  const tenant = await getTenant(slug);
  if (!tenant) return json({ error: "Tenant not found." }, 404);
  if (!sessionFor(req, slug)) return json({ error: "Sign in required" }, 401);
  const record = await loadDynamicTenant(slug);
  if (!record || tenant.status !== "draft") return json({ error: "Only dynamic draft portals can go live." }, 409);
  const checks = await launchChecks(tenant, record, platformUrl(req));
  const failures = checks.filter((check) => !check.ok);
  if (failures.length) return json({ error: "Launch checks are not complete.", checks }, 409);
  const launchedAt = new Date().toISOString();
  const updated = await updateDynamicTenant(slug, (existing) => ({
    ...existing,
    launchedAt,
    settings: { ...existing.settings, status: "live" }
  }));
  await purgeTenantCache(slug);
  const operatorEmail = process.env.OPERATOR_EMAIL;
  if (operatorEmail && process.env.RESEND_API_KEY) {
    const portalUrl = `${platformUrl(req)}/${slug}`;
    try {
      await fetch(`${process.env.RESEND_API_BASE || "https://api.resend.com"}/emails`, {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({
          from: "Athlete Sponsorship Portal <sponsors@michaelheckert.com>",
          to: [operatorEmail],
          subject: `${updated.settings.fullName} just went live`,
          text: `${updated.settings.fullName} just went live.\n\nPortal: ${portalUrl}`
        })
      });
    } catch (err) {
      console.error("Operator launch email failed", slug, err);
    }
  }
  return json({ ok: true, portalUrl: `${platformUrl(req)}/${slug}` });
}

async function loadPlacementsForSummary(tenant, portalUrl) {
  const services = forTenant(tenant, { portalUrl });
  const sold = await services.soldDetails();
  const store = getStore({ name: "bids", consistency: "strong" });
  const placements = await Promise.all(placementConfigs(tenant).map(async (placement) => {
    const record = await store.get(`${tenant.slug}/${placement.id}`, { type: "json" });
    return placementSummary(placement, record, sold.get(placement.id) || null);
  }));
  return placements;
}

function csvCell(value) {
  const raw = String(value ?? "");
  const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}

async function exportCsv(req, slug) {
  const tenant = await getTenant(slug);
  if (!tenant) return json({ error: "Tenant not found." }, 404);
  if (!sessionFor(req, slug)) return json({ error: "Sign in required" }, 401);

  const services = forTenant(tenant, { portalUrl: `${platformUrl(req)}/${tenant.slug}` });
  const store = getStore({ name: "bids", consistency: "strong" });
  const sold = await services.soldDetails();
  const rows = [[
    "placement_id", "placement_label", "at", "type", "amount", "company",
    "contact_name", "email", "phone", "note", "is_current_high", "invoice_status", "paid_at"
  ].join(",")];
  for (const placement of placementConfigs(tenant)) {
    const record = await store.get(`${tenant.slug}/${placement.id}`, { type: "json" });
    const history = record?.history || [];
    history.forEach((entry, index) => {
      rows.push([
        placement.id,
        placement.label,
        entry.at,
        entry.type,
        entry.amount,
        entry.company,
        entry.name,
        entry.email,
        entry.phone,
        entry.note,
        index === history.length - 1,
        record?.invoice?.status,
        record?.invoice?.paidAt
      ].map(csvCell).join(","));
    });
  }
  for (const [id, detail] of sold) {
    if (detail.source !== "dashboard") continue;
    const placement = placementConfigs(tenant).find((candidate) => candidate.id === id);
    if (!placement) continue;
    rows.push([
      id,
      placement.label,
      detail.at,
      "offline_sale",
      detail.amount,
      detail.sponsor,
      "",
      "",
      "",
      detail.note,
      false,
      "",
      ""
    ].map(csvCell).join(","));
  }
  return new Response(`${rows.join("\r\n")}\r\n`, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${tenant.slug}-bids.csv"`,
      "cache-control": "no-store"
    }
  });
}

async function markSold(req, slug, id) {
  const tenant = await getTenant(slug);
  if (!tenant) return json({ error: "Tenant not found." }, 404);
  if (tenant.demo) return json({ error: "Demo portals cannot change placements." }, 409);
  const session = sessionFor(req, slug);
  if (!session) return json({ error: "Sign in required" }, 401);
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }
  const sponsor = typeof body?.sponsor === "string" ? body.sponsor.trim() : "";
  if (!sponsor || sponsor.length > 120) return json({ error: "Sponsor is required and must be at most 120 characters." }, 400);
  if (body.amount !== undefined && body.amount !== null && (!Number.isInteger(body.amount) || body.amount < 0)) {
    return json({ error: "Amount must be a non-negative integer." }, 400);
  }

  const services = forTenant(tenant, { portalUrl: `${platformUrl(req)}/${tenant.slug}` });
  if (!services.isPlacementId(id)) return json({ error: "Unknown placement." }, 400);
  const sold = await services.soldDetails();
  if (sold.has(id)) return json({ error: "This placement is already sold." }, 409);
  const bidsStore = getStore({ name: "bids", consistency: "strong" });
  const record = await bidsStore.get(`${slug}/${id}`, { type: "json" });
  if (record && (record.bidder || (record.history?.length || 0) > 0 || record.locked || record.closed || record.high > 0)) {
    return json({ error: "This placement already has bids or is closed." }, 409);
  }

  const placement = tenant.garments.flatMap((garment) => garment.placements.map((entry) => ({
    ...entry,
    slug: tenant.slug,
    garment: garment.id,
    garmentLabel: garment.tab
  }))).find((entry) => entry.id === id);
  const sale = {
    sponsor,
    amount: body.amount ?? null,
    note: typeof body.note === "string" ? body.note.trim() : "",
    at: new Date().toISOString(),
    by: session.email
  };
  await getStore({ name: "sold", consistency: "strong" }).setJSON(`${slug}/${id}`, sale);
  const soldDetail = { ...sale, source: "dashboard" };
  return json({ placement: placementSummary(placement, record, soldDetail) });
}

async function releaseSale(req, slug, id) {
  const tenant = await getTenant(slug);
  if (!tenant) return json({ error: "Tenant not found." }, 404);
  if (tenant.demo) return json({ error: "Demo portals cannot change placements." }, 409);
  const session = sessionFor(req, slug);
  if (!session) return json({ error: "Sign in required" }, 401);
  if (Object.hasOwn(tenant.sold || {}, id)) {
    return json({ error: "This sale is set in the tenant config; contact support to change it." }, 409);
  }
  const store = getStore({ name: "sold", consistency: "strong" });
  const key = `${slug}/${id}`;
  const record = await store.get(key, { type: "json" });
  if (!record || record.releasedAt) return json({ error: "This placement is not sold." }, 409);
  record.releasedAt = new Date().toISOString();
  record.releasedBy = session.email;
  await store.setJSON(key, record);
  return json({ ok: true });
}

async function connectOnboard(req, slug) {
  const tenant = await getTenant(slug);
  if (!tenant) return json({ error: "Tenant not found." }, 404);
  if (tenant.demo) return json({ error: "Demo portals cannot use Stripe Connect." }, 409);
  if (!sessionFor(req, slug)) return json({ error: "Sign in required" }, 401);
  if (tenant.payments.mode !== "connect") return json({ error: "Tenant does not use Stripe Connect." }, 400);
  const services = forTenant(tenant, { portalUrl: `${platformUrl(req)}/${tenant.slug}` });
  try {
    const linkResult = await services.connect.onboardingLink();
    return json({ url: linkResult.url });
  } catch (err) {
    console.error("Dashboard Connect onboarding failed", slug, err);
    return json({ error: "Unable to create Stripe onboarding link." }, 502);
  }
}

async function updateOnboarding(req, slug) {
  const tenant = await getTenant(slug);
  if (!tenant) return json({ error: "Tenant not found." }, 404);
  const session = sessionFor(req, slug);
  if (!session) return json({ error: "Sign in required" }, 401);

  let event;
  try {
    event = (await req.json())?.event;
  } catch {
    return json({ error: "Unknown onboarding event." }, 400);
  }
  if (!["tour_completed", "portal_previewed", "portal_shared", "checklist_dismissed", "checklist_restored"].includes(event)) {
    return json({ error: "Unknown onboarding event." }, 400);
  }

  const store = getStore({ name: "onboarding", consistency: "strong" });
  const now = new Date().toISOString();
  if (event === "tour_completed") {
    const key = `${tenant.slug}/tour`;
    if (!(await store.get(key, { type: "json" }))) {
      await store.setJSON(key, { at: now, by: session.email });
    }
  } else if (event === "portal_previewed" || event === "portal_shared") {
    const name = event === "portal_previewed" ? "previewed" : "shared";
    const key = `${tenant.slug}/${name}`;
    if (!(await store.get(key, { type: "json" }))) await store.setJSON(key, { at: now });
  } else {
    const key = `${tenant.slug}/checklist`;
    await store.setJSON(key, {
      dismissedAt: event === "checklist_dismissed" ? now : null,
      updatedAt: now
    });
  }
  return json({ onboarding: await loadOnboarding(tenant.slug) });
}

async function modelAccess(req, slug, { allowAdmin = false } = {}) {
  const tenant = await getTenant(slug);
  if (!tenant) return { response: json({ error: "Tenant not found." }, 404) };
  if (tenant.demo) return { response: json({ error: "Demo portals do not support Model Studio." }, 409) };
  const session = sessionFor(req, slug);
  if (!session && !(allowAdmin && readAdminSession(req))) {
    return { response: json({ error: "Sign in required" }, 401) };
  }
  return { tenant, session };
}

async function getModel(req, slug) {
  const access = await modelAccess(req, slug);
  if (access.response) return access.response;
  let model = await loadStudio(access.tenant);
  if (model.views.status === "generating" ||
      ["building", "processing"].includes(model.build.status)) {
    try {
      let viewsProgress = {};
      let buildProgress;
      if (model.views.status === "generating") {
        viewsProgress = await advanceViews(access.tenant);
      }
      if (["building", "processing"].includes(model.build.status)) {
        const progress = await advanceBuild(access.tenant, { origin: platformUrl(req) });
        buildProgress = progress.progress;
      }
      model = await loadStudio(access.tenant, viewsProgress, buildProgress);
    } catch (error) {
      if (error instanceof MeshyConfigurationError) return json({ error: error.message }, 503);
      throw error;
    }
  }
  return json({ model });
}

async function startModelViews(req, slug) {
  const access = await modelAccess(req, slug);
  if (access.response) return access.response;
  const result = await startViews(access.tenant, access.session);
  if (result.status !== 200) return json({ error: result.error }, result.status);
  return json({ model: await loadStudio(access.tenant) });
}

async function decideModelViews(req, slug) {
  const access = await modelAccess(req, slug);
  if (access.response) return access.response;
  let body;
  try { body = await req.json(); } catch { body = null; }
  const result = await recordViewDecision(access.tenant, access.session, body);
  if (result.status !== 200) return json({ error: result.error }, result.status);
  return json({ model: await loadStudio(access.tenant) });
}

async function getModelView(req, slug, angle) {
  const access = await modelAccess(req, slug);
  if (access.response) return access.response;
  const asset = await getViewAsset(access.tenant, angle);
  if (!asset) return json({ error: "Reference view not found." }, 404);
  return new Response(asset.bytes, {
    headers: {
      "content-type": asset.contentType,
      "cache-control": "private, max-age=86400, immutable",
      "x-content-type-options": "nosniff"
    }
  });
}

async function startModelBuild(req, slug) {
  const access = await modelAccess(req, slug);
  if (access.response) return access.response;
  const result = await startBuild(access.tenant, access.session);
  if (result.status !== 200) return json({ error: result.error }, result.status);
  return json({ model: await loadStudio(access.tenant) });
}

async function getModelBuildAsset(req, slug, kind) {
  const access = await modelAccess(req, slug, { allowAdmin: true });
  if (access.response) return access.response;
  const asset = await getBuildAsset(access.tenant, kind);
  if (!asset) return json({ error: "Model asset not found." }, 404);
  return new Response(asset.bytes, {
    headers: {
      "content-type": asset.contentType,
      "cache-control": "private, max-age=86400, immutable",
      "x-content-type-options": "nosniff"
    }
  });
}

async function reviewModel(req, slug) {
  const access = await modelAccess(req, slug);
  if (access.response) return access.response;
  let body;
  try { body = await req.json(); } catch { body = null; }
  const note = body?.note === undefined
    ? ""
    : typeof body.note === "string"
      ? body.note.trim()
      : null;
  if (note === null || note.length > 500) {
    return json({ error: "Notes must be 500 characters or fewer." }, 400);
  }
  if (!["approve", "rebuild"].includes(body?.decision) || typeof body.jobId !== "string") {
    return json({ error: "Choose approve or rebuild for the current model." }, 400);
  }

  const model = await loadStudio(access.tenant);
  if (body.jobId !== model.build.jobId) {
    return json({ error: "That model is no longer current." }, 409);
  }
  if (body.decision === "approve") {
    if (!["athlete_review", "sent_back"].includes(model.review.status)) {
      return json({ error: "This model is not waiting for your approval." }, 409);
    }
    const at = new Date().toISOString();
    await saveAthleteReview(access.tenant, {
      jobId: body.jobId,
      decision: "approved",
      note,
      at,
      by: access.session.email
    });
    const operatorEmail = process.env.OPERATOR_EMAIL?.trim();
    if (operatorEmail) {
      const base = platformUrl(req);
      const services = forTenant(access.tenant, { portalUrl: `${base}/${slug}` });
      await services.tryEmail({
        to: operatorEmail,
        subject: `Model ready for sign-off: ${access.tenant.athlete.displayName}`,
        text: `The model for ${access.tenant.athlete.displayName} is ready for sign-off.\n${base}/admin/${encodeURIComponent(slug)}/studio${note ? `\n\nAthlete note: ${note}` : ""}`
      });
    }
    return json({ model: await loadStudio(access.tenant) });
  }

  if (model.review.status === "live" || model.build.status !== "ready" || model.build.attemptsLeft === 0) {
    return json({ error: "This model cannot be rebuilt right now." }, 409);
  }
  const result = await startBuild(access.tenant, access.session, { allowReady: true, note });
  if (result.status !== 200) return json({ error: result.error }, result.status);
  return json({ model: await loadStudio(access.tenant) });
}

async function saveModelConsent(req, slug) {
  const access = await modelAccess(req, slug);
  if (access.response) return access.response;
  let body;
  try { body = await req.json(); } catch { body = null; }
  if (body?.accept !== true || body?.version !== "2026-10-03") {
    return json({ error: "Accept the likeness consent to continue." }, 400);
  }
  const store = getStore({ name: "model-studio", consistency: "strong" });
  await store.setJSON(`${access.tenant.slug}/consent`, {
    acceptedAt: new Date().toISOString(),
    by: access.session.email,
    version: body.version
  });
  return json({ model: await loadStudio(access.tenant) });
}

async function saveModelKit(req, slug) {
  const access = await modelAccess(req, slug);
  if (access.response) return access.response;
  let body;
  try { body = await req.json(); } catch { body = null; }
  const color = /^#[0-9a-f]{6}$/i;
  const notes = body?.notes === undefined ? "" : typeof body.notes === "string" ? body.notes.trim() : null;
  if (![body?.shirt, body?.shorts, body?.waistband].every((value) => typeof value === "string" && color.test(value)) ||
      notes === null || notes.length > 500) {
    return json({ error: "Pick a colour for the shirt, shorts and waistband." }, 400);
  }
  const store = getStore({ name: "model-studio", consistency: "strong" });
  await store.setJSON(`${access.tenant.slug}/kit`, {
    shirt: body.shirt.toLowerCase(),
    shorts: body.shorts.toLowerCase(),
    waistband: body.waistband.toLowerCase(),
    notes,
    updatedAt: new Date().toISOString(),
    by: access.session.email
  });
  return json({ model: await loadStudio(access.tenant) });
}

async function saveModelPhoto(req, slug, angle) {
  const access = await modelAccess(req, slug);
  if (access.response) return access.response;
  if (!ANGLES.includes(angle)) return json({ error: "Unknown photo angle." }, 404);
  const store = getStore({ name: "model-studio", consistency: "strong" });
  if (!(await store.get(`${access.tenant.slug}/consent`, { type: "json" }))) {
    return json({ error: "Accept the likeness consent first." }, 409);
  }
  if (await store.get(`${access.tenant.slug}/submission`, { type: "json" })) {
    return json({ error: "Your photos have been submitted. Contact us to change them." }, 409);
  }

  let body;
  try { body = await req.json(); } catch { body = null; }
  const match = typeof body?.image === "string"
    ? body.image.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/]*={0,2})$/)
    : null;
  if (!match) return json({ error: "Upload a JPG photo." }, 400);
  const bytes = Buffer.from(match[1], "base64");
  if (bytes.length > MAX_PHOTO_BYTES) {
    return json({ error: "Photo is too large — please use one under 4 MB." }, 413);
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    return json({ error: "Upload a JPG photo." }, 400);
  }
  const dimensions = jpegSize(bytes);
  if (!dimensions) return json({ error: "Upload a JPG photo." }, 400);
  const shortEdge = Math.min(dimensions.width, dimensions.height);
  const longEdge = Math.max(dimensions.width, dimensions.height);
  if (shortEdge < 600 || longEdge > 4096) {
    return json({ error: "Photo is too small — retake it closer or at a higher resolution." }, 400);
  }
  const warnings = Array.isArray(body.warnings)
    ? body.warnings.filter((warning) => typeof warning === "string" && PHOTO_WARNINGS.has(warning)).slice(0, 6)
    : [];
  const at = new Date().toISOString();
  await store.set(`${access.tenant.slug}/photo/${angle}`, bytes, {
    metadata: {
      type: "image/jpeg",
      width: dimensions.width,
      height: dimensions.height,
      size: bytes.length,
      warnings,
      at,
      by: access.session.email
    }
  });
  return json({ model: await loadStudio(access.tenant) });
}

async function getModelPhoto(req, slug, angle) {
  const access = await modelAccess(req, slug);
  if (access.response) return access.response;
  if (!ANGLES.includes(angle)) return json({ error: "Unknown photo angle." }, 404);
  const store = getStore({ name: "model-studio", consistency: "strong" });
  const key = `${access.tenant.slug}/photo/${angle}`;
  if (!(await store.getMetadata(key))) return json({ error: "Photo not found." }, 404);
  const bytes = await store.get(key, { type: "arrayBuffer" });
  if (!bytes) return json({ error: "Photo not found." }, 404);
  return new Response(bytes, {
    headers: {
      "content-type": "image/jpeg",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff"
    }
  });
}

async function submitModel(req, slug) {
  const access = await modelAccess(req, slug);
  if (access.response) return access.response;
  const model = await loadStudio(access.tenant);
  if (model.hasOwnModel) return json({ error: "Your 3D model is already live." }, 409);
  const store = getStore({ name: "model-studio", consistency: "strong" });
  const key = `${access.tenant.slug}/submission`;
  const existing = await store.get(key, { type: "json" });
  if (existing) return json({ model });
  if (model.missing.length) return json({ error: "Finish these steps first.", missing: model.missing }, 409);
  await store.setJSON(key, { submittedAt: new Date().toISOString(), by: access.session.email });
  return json({ model: await loadStudio(access.tenant) });
}

export default async function dashboardApi(req) {
  if (!process.env.DASHBOARD_SECRET) return json({ error: "DASHBOARD_SECRET is not configured." }, 503);

  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  const adminRoute = parts.length === 4 && parts[3] === "link";
  if (req.method === "POST" && !adminRoute && !sameOrigin(req)) return json({ error: "Forbidden" }, 403);

  if (parts.length === 3 && parts[0] === "api" && parts[1] === "dashboard") {
    if (parts[2] === "login") {
      if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
      return login(req);
    }
    if (parts[2] === "session") {
      if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
      return session(req);
    }
    if (parts[2] === "logout") {
      if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
      return logout(req);
    }
  }

  if (parts.length === 4 && parts[0] === "api" && parts[1] === "dashboard" && parts[3] === "link") {
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    return link(req, parts[2]);
  }

  if (parts.length === 4 && parts[0] === "api" && parts[1] === "dashboard" && parts[3] === "onboarding") {
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    return updateOnboarding(req, parts[2]);
  }

  if (parts.length === 4 && parts[0] === "api" && parts[1] === "dashboard" &&
      parts[3] === "settings") {
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    return updateSettings(req, parts[2]);
  }

  if (parts.length === 4 && parts[0] === "api" && parts[1] === "dashboard" &&
      parts[3] === "launch") {
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    return launch(req, parts[2]);
  }

  if (parts.length === 4 && parts[0] === "api" && parts[1] === "dashboard" && parts[3] === "model") {
    if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
    return getModel(req, parts[2]);
  }

  if (parts.length === 5 && parts[0] === "api" && parts[1] === "dashboard" && parts[3] === "model") {
    if (parts[4] === "consent") {
      if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
      return saveModelConsent(req, parts[2]);
    }
    if (parts[4] === "kit") {
      if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
      return saveModelKit(req, parts[2]);
    }
    if (parts[4] === "submit") {
      if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
      return submitModel(req, parts[2]);
    }
    if (parts[4] === "review") {
      if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
      return reviewModel(req, parts[2]);
    }
  }

  if (parts.length === 6 && parts[0] === "api" && parts[1] === "dashboard" &&
      parts[3] === "model" && parts[4] === "photos") {
    if (req.method === "GET") return getModelPhoto(req, parts[2], parts[5]);
    if (req.method === "POST") return saveModelPhoto(req, parts[2], parts[5]);
    return json({ error: "Method not allowed" }, 405);
  }

  if (parts.length === 6 && parts[0] === "api" && parts[1] === "dashboard" &&
      parts[3] === "model" && parts[4] === "views") {
    const action = parts[5];
    if (action === "generate") {
      if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
      return startModelViews(req, parts[2]);
    }
    if (action === "decision") {
      if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
      return decideModelViews(req, parts[2]);
    }
    if (!["front", "back", "left", "right"].includes(action)) {
      return json({ error: "Unknown reference view." }, 404);
    }
    if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
    return getModelView(req, parts[2], action);
  }

  if (parts.length === 6 && parts[0] === "api" && parts[1] === "dashboard" &&
      parts[3] === "model" && parts[4] === "build") {
    const action = parts[5];
    if (action === "start") {
      if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
      return startModelBuild(req, parts[2]);
    }
    if (!["model.glb", "thumbnail"].includes(action)) {
      return json({ error: "Unknown model build action." }, 404);
    }
    if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
    return getModelBuildAsset(req, parts[2], action === "model.glb" ? "model" : "thumbnail");
  }

  if (parts.length === 4 && parts[0] === "api" && parts[1] === "dashboard" && parts[3] === "summary") {
    if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
    return summary(req, parts[2]);
  }

  if (parts.length === 4 && parts[0] === "api" && parts[1] === "dashboard" && parts[3] === "export.csv") {
    if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
    return exportCsv(req, parts[2]);
  }

  if (parts.length === 5 && parts[0] === "api" && parts[1] === "dashboard" &&
      parts[3] === "connect" && parts[4] === "onboard") {
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    return connectOnboard(req, parts[2]);
  }

  if (parts.length === 6 && parts[0] === "api" && parts[1] === "dashboard" &&
      parts[3] === "placements" && ["sold", "release"].includes(parts[5])) {
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    return parts[5] === "sold"
      ? markSold(req, parts[2], parts[4])
      : releaseSale(req, parts[2], parts[4]);
  }

  return json({ error: "Dashboard API route not found." }, 404);
}

export const config = {
  path: [
    "/api/dashboard/login",
    "/api/dashboard/session",
    "/api/dashboard/logout",
    "/api/dashboard/:slug/link",
    "/api/dashboard/:slug/onboarding",
    "/api/dashboard/:slug/settings",
    "/api/dashboard/:slug/launch",
    "/api/dashboard/:slug/model",
    "/api/dashboard/:slug/model/consent",
    "/api/dashboard/:slug/model/kit",
    "/api/dashboard/:slug/model/photos/:angle",
    "/api/dashboard/:slug/model/submit",
    "/api/dashboard/:slug/model/review",
    "/api/dashboard/:slug/model/views/:action",
    "/api/dashboard/:slug/model/build/:action",
    "/api/dashboard/:slug/summary",
    "/api/dashboard/:slug/export.csv",
    "/api/dashboard/:slug/connect/onboard",
    "/api/dashboard/:slug/placements/:id/sold",
    "/api/dashboard/:slug/placements/:id/release"
  ]
};
