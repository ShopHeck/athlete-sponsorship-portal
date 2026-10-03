import { forTenant, json } from "../lib/sponsorship.mjs";
import { getTenant } from "../lib/tenants.mjs";
import { isConnectReady } from "../lib/connect.mjs";

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[char]));

function unauthorized(req) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return json({ error: "ADMIN_TOKEN is not configured." }, 503);
  if (req.headers.get("authorization") !== `Bearer ${token}`) return json({ error: "Unauthorized" }, 401);
  return null;
}

const forbidden = () => json({ error: "Forbidden" }, 403);

export default async function connectEndpoint(req, context) {
  const slug = context.params?.slug || "";
  const action = context.params?.action || "";
  const tenant = await getTenant(slug);
  if (!tenant) return json({ error: "Tenant not found." }, 404);
  if (tenant.payments.mode !== "connect") return json({ error: "Tenant does not use Stripe Connect." }, 400);

  const url = new URL(req.url);
  const platformUrl = (process.env.PLATFORM_URL || url.origin).replace(/\/+$/, "");
  const portalUrl = `${platformUrl}/${slug}`;
  const services = forTenant(tenant, { portalUrl });
  const { connect } = services;

  if (action === "onboard") {
    const authError = unauthorized(req);
    if (authError) return authError;
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    try {
      return json(await connect.onboardingLink());
    } catch (err) {
      console.error("Connect onboarding failed", slug, err);
      return json({ error: "Unable to create Stripe onboarding link." }, 502);
    }
  }

  if (action === "status") {
    const authError = unauthorized(req);
    if (authError) return authError;
    if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
    if (!(await connect.record())) return json({ error: "No connected account yet." }, 404);
    try {
      const updated = await connect.refreshStatus();
      const readiness = await connect.readiness();
      if (!updated) return json({ error: "No connected account yet." }, 404);
      return json({ accountId: updated.accountId, ready: readiness.ready, status: updated.status });
    } catch (err) {
      console.error("Connect status refresh failed", slug, err);
      return json({ error: "Unable to refresh Stripe account status." }, 502);
    }
  }

  if (action === "refresh" || action === "return") {
    if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
    const existing = await connect.record();
    if (!existing?.accountId || !connect.verify(existing.accountId, url.searchParams.get("sig"))) return forbidden();

    if (action === "refresh") {
      try {
        const link = await connect.onboardingLink();
        return new Response(null, { status: 302, headers: { location: link.url, "cache-control": "no-store" } });
      } catch (err) {
        console.error("Connect onboarding refresh failed", slug, err);
        return json({ error: "Unable to create Stripe onboarding link." }, 502);
      }
    }

    let updated;
    try {
      updated = await connect.refreshStatus();
    } catch (err) {
      console.error("Connect return status refresh failed", slug, err);
      updated = await connect.record();
    }
    const ready = isConnectReady(updated?.status);
    const athleteName = escapeHtml(tenant.athlete?.displayName || tenant.athlete?.firstName || slug);
    const refreshUrl = `${new URL(portalUrl).origin}/api/${encodeURIComponent(slug)}/connect/refresh?sig=${encodeURIComponent(url.searchParams.get("sig") || "")}`;
    const message = ready
      ? `<p>Payouts are set up. Sponsors can bid on ${athleteName}'s sponsorship portal.</p>`
      : `<p>Stripe still needs more details before payouts are ready.</p><p><a href="${escapeHtml(refreshUrl)}">Continue Stripe setup</a></p>`;
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Stripe payouts · ${athleteName}</title></head><body><main><h1>${athleteName}</h1>${message}</main></body></html>`;
    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
    });
  }

  return json({ error: "Connect action not found." }, 404);
}

export const config = { path: "/api/:slug/connect/:action" };
