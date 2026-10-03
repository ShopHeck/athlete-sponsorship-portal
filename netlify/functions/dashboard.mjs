import platform from "../lib/platform.generated.json";
import { readSession } from "../lib/dashboard-auth.mjs";
import { getTenant } from "../lib/tenants.mjs";

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[char]));

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'"
].join("; ");

function page({ title, body, accent = "#ff6a1a", bodyAttrs = "", script = false }) {
  const version = escapeHtml(platform.version);
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <meta name="theme-color" content="#080808">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <title>${escapeHtml(title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700;800&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/dashboard.css?v=${version}">
  <style>:root{--accent:${/^#[0-9a-f]{6}$/i.test(accent) ? accent : "#ff6a1a"}}</style>
</head>
<body ${bodyAttrs}>
${body}
${script ? `<script type="module" src="/dashboard.js?v=${version}"></script>` : ""}
</body>
</html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": CSP,
      "referrer-policy": "same-origin",
      "x-content-type-options": "nosniff"
    }
  });
}

const redirect = (location) => new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });

const authShell = (inner) => `<main class="auth-shell"><section class="auth-card">
  <p class="eyebrow">Athlete sponsorship portal</p>
  ${inner}
</section></main>`;

function loginPage(url) {
  const error = url.searchParams.get("error") === "link"
    ? `<p class="notice notice-error" role="alert">That sign-in link is invalid, expired or already used. Request a new one below.</p>`
    : "";
  return page({
    title: "Athlete dashboard · Sign in",
    script: true,
    bodyAttrs: `data-view="login"`,
    body: authShell(`<h1>Athlete dashboard</h1>
  <p class="lede">Enter the email address on your sponsorship portal and we'll send you a secure sign-in link.</p>
  ${error}
  <form id="loginForm" class="stack" novalidate>
    <label for="loginEmail">Email</label>
    <input id="loginEmail" name="email" type="email" autocomplete="email" required placeholder="you@example.com">
    <button class="btn btn-primary" type="submit">Email me a sign-in link</button>
  </form>
  <p class="notice" id="loginStatus" role="status" hidden></p>`)
  });
}

function confirmPage(url) {
  const token = url.searchParams.get("token") || "";
  if (!/^[a-f0-9]{64}$/.test(token)) return redirect("/dashboard?error=link");
  return page({
    title: "Athlete dashboard · Confirm sign-in",
    body: authShell(`<h1>Confirm sign-in</h1>
  <p class="lede">Continue to open your sponsorship dashboard. This link works once and expires 15 minutes after it was sent.</p>
  <form method="post" action="/api/dashboard/session" class="stack">
    <input type="hidden" name="token" value="${escapeHtml(token)}">
    <button class="btn btn-primary" type="submit">Open my dashboard</button>
  </form>`)
  });
}

function dashboardPage(tenant) {
  const name = tenant.athlete?.displayName || tenant.slug;
  return page({
    title: `${name} · Sponsorship dashboard`,
    accent: tenant.brand?.accent,
    script: true,
    bodyAttrs: `data-view="dashboard" data-slug="${escapeHtml(tenant.slug)}"`,
    body: `<header class="topbar">
  <div class="brand"><span class="brand-mark">${escapeHtml(tenant.athlete?.brandMark || "")}</span>
    <span class="brand-copy"><strong>${escapeHtml(name)}</strong><small>SPONSORSHIP DASHBOARD</small></span></div>
  <nav class="top-actions">
    <button class="btn btn-ghost" id="tourBtn" type="button" data-tour="tour">Take the tour</button>
    <a class="btn btn-ghost" id="viewPortal" data-tour="portal" href="/${escapeHtml(tenant.slug)}" target="_blank" rel="noopener">View portal</a>
    <a class="btn btn-ghost" data-tour="export" href="/api/dashboard/${escapeHtml(tenant.slug)}/export.csv">Export CSV</a>
    <form method="post" action="/api/dashboard/logout"><button class="btn btn-ghost" type="submit">Sign out</button></form>
  </nav>
</header>
<main class="dash" id="dash" aria-busy="true">
  <p class="loading" id="loading">Loading your placements…</p>
</main>`
  });
}

export default async function dashboard(req, context) {
  if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");

  if (path === "/dashboard/auth") return confirmPage(url);

  const session = readSession(req);
  if (path === "/dashboard") {
    if (session && !url.searchParams.has("error")) return redirect(`/dashboard/${encodeURIComponent(session.slug)}`);
    return loginPage(url);
  }

  const slug = context.params?.slug || "";
  const tenant = await getTenant(slug);
  if (!tenant || !session || session.slug !== slug) return redirect("/dashboard");
  return dashboardPage(tenant);
}

export const config = { path: ["/dashboard", "/dashboard/", "/dashboard/auth", "/dashboard/:slug", "/dashboard/:slug/"] };
