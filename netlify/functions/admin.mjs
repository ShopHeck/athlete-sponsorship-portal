import { page } from "./dashboard.mjs";
import { readAdminSession } from "../lib/dashboard-auth.mjs";
import { renderStudioPage } from "../lib/studio-page.mjs";
import { getTenant } from "../lib/tenants.mjs";

const redirect = (location) => new Response(null, {
  status: 303,
  headers: { location, "cache-control": "no-store" }
});

function signInPage() {
  return page({
    title: "Operator sign in · Model Studio",
    script: true,
    scriptPath: "/admin.js",
    bodyAttrs: 'data-view="admin-login"',
    body: `<main class="auth-shell"><section class="auth-card">
  <p class="eyebrow">Athlete sponsorship portal</p>
  <h1>Operator sign in</h1>
  <p class="lede">Enter the operator access token to review athlete models.</p>
  <form id="adminLoginForm" class="stack" novalidate>
    <label for="adminToken">Operator token</label>
    <input id="adminToken" name="token" type="password" autocomplete="current-password" required>
    <button class="btn btn-primary" type="submit">Sign in</button>
  </form>
  <p class="notice notice-error" id="adminLoginError" role="alert" hidden></p>
</section></main>`
  });
}

function queuePage() {
  return page({
    title: "Model review queue · Operator",
    script: true,
    scriptPath: "/admin.js",
    bodyAttrs: 'data-view="admin-queue"',
    body: `<header class="topbar">
  <div class="brand"><span class="brand-mark">ASP</span>
    <span class="brand-copy"><strong>Model Studio</strong><small>OPERATOR REVIEW</small></span></div>
  <nav class="top-actions"><button class="btn btn-ghost" id="adminLogout" type="button">Sign out</button></nav>
</header>
<main class="dash">
  <div class="dash-head"><div><p class="eyebrow">MODEL STUDIO</p><h1>Review queue</h1></div></div>
  <section class="card" id="adminApplicationsSection">
    <div class="card-head"><h2>Applications</h2><span class="badge badge-accent" id="adminApplicationsCount">Loading</span></div>
    <p class="notice" id="adminApplicationsStatus" role="status">Loading applications…</p>
    <div id="adminApplications" class="stack"></div>
  </section>
  <p class="notice" id="adminQueueStatus" role="status">Loading review queue…</p>
  <div id="adminReviewQueue" class="admin-review-queue"></div>
</main>`
  });
}

export default async function admin(req, context) {
  if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
  const path = new URL(req.url).pathname.replace(/\/+$/, "") || "/";
  const session = readAdminSession(req);
  if (path === "/admin") return session ? queuePage() : signInPage();

  const slug = context.params?.slug || "";
  if (path !== `/admin/${encodeURIComponent(slug)}/studio`) {
    return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  }
  if (!session) return redirect("/admin");
  const tenant = await getTenant(slug);
  if (!tenant) return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  return renderStudioPage(req, tenant, "operator");
}

export const config = {
  path: ["/admin", "/admin/", "/admin/:slug/studio"]
};
