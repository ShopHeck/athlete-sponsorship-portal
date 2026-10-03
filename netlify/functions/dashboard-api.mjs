import { getStore } from "@netlify/blobs";
import { forTenant, json } from "../lib/sponsorship.mjs";
import {
  allowLoginEmail,
  clearSessionCookie,
  consumeLoginToken,
  createLoginToken,
  dashboardEmailsFor,
  sameOrigin,
  sessionCookie,
  sessionFor
} from "../lib/dashboard-auth.mjs";
import { getTenant, listTenants } from "../lib/tenants.mjs";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  for (const tenant of await listTenants()) {
    if (!dashboardEmailsFor(tenant).includes(email)) continue;
    try {
      if (!(await allowLoginEmail(email))) continue;
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

function onboardingView(record) {
  return {
    tourCompletedAt: record?.tourCompletedAt ?? null,
    checklistDismissedAt: record?.checklistDismissedAt ?? null,
    previewedAt: record?.previewedAt ?? null,
    sharedAt: record?.sharedAt ?? null
  };
}

function loadOnboarding(slug) {
  return getStore({ name: "onboarding", consistency: "strong" }).get(slug, { type: "json" });
}

async function summary(req, slug) {
  const tenant = await getTenant(slug);
  if (!tenant) return json({ error: "Tenant not found." }, 404);
  if (!sessionFor(req, slug)) return json({ error: "Sign in required" }, 401);

  const base = platformUrl(req);
  const portalUrl = `${base}/${tenant.slug}`;
  const services = forTenant(tenant, { portalUrl });
  const [record, readiness, placements, onboardingRecord] = await Promise.all([
    services.connect.record(),
    services.connect.readiness(),
    loadPlacementsForSummary(tenant, portalUrl),
    loadOnboarding(tenant.slug)
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
  return json({
    tenant: {
      slug: tenant.slug,
      displayName: tenant.athlete.displayName,
      status: tenant.status,
      eventName: tenant.event.name,
      portalUrl,
      embedCode: `<iframe src="${escapeHtml(portalUrl)}" title="${escapeHtml(tenant.copy.embedTitle)}" loading="lazy" allow="fullscreen" style="width:100%;height:900px;border:0"></iframe>`,
      currency: tenant.pricing.currency
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
    onboarding: onboardingView(onboardingRecord)
  });
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
  const record = await store.get(tenant.slug, { type: "json" }) || {
    tourCompletedAt: null,
    tourCompletedBy: null,
    checklistDismissedAt: null,
    previewedAt: null,
    sharedAt: null,
    updatedAt: null
  };
  const now = new Date().toISOString();
  if (event === "tour_completed" && !record.tourCompletedAt) {
    record.tourCompletedAt = now;
    record.tourCompletedBy = session.email;
  } else if (event === "portal_previewed" && !record.previewedAt) {
    record.previewedAt = now;
  } else if (event === "portal_shared" && !record.sharedAt) {
    record.sharedAt = now;
  } else if (event === "checklist_dismissed") {
    record.checklistDismissedAt = now;
  } else if (event === "checklist_restored") {
    record.checklistDismissedAt = null;
  }
  record.updatedAt = now;
  await store.setJSON(tenant.slug, record);
  return json({ onboarding: onboardingView(record) });
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
    "/api/dashboard/:slug/summary",
    "/api/dashboard/:slug/export.csv",
    "/api/dashboard/:slug/connect/onboard",
    "/api/dashboard/:slug/placements/:id/sold",
    "/api/dashboard/:slug/placements/:id/release"
  ]
};
