import platform from "../lib/platform.generated.json";
import { renderPortal } from "../lib/render.mjs";
import { getTenant, previewTokenMatches } from "../lib/tenants.mjs";

const RESERVED_SLUGS = new Set(["api", "tenants", "assets", "admin", "dashboard", "static"]);
const notFoundHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Portal not found</title></head>
<body><main><h1>Portal not found</h1></main></body></html>`;

const notFound = () => new Response(notFoundHtml, {
  status: 404,
  headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
});

export default async function portal(req, context) {
  const slug = context.params?.slug || "";
  if (RESERVED_SLUGS.has(slug)) return notFound();
  const tenant = await getTenant(slug);
  if (!tenant) return notFound();

  const url = new URL(req.url);
  const previewToken = process.env.PREVIEW_TOKEN;
  const preview = tenant.status === "draft" && previewTokenMatches(url.searchParams.get("preview"));
  if (tenant.status === "draft" && !preview) return notFound();

  const platformUrl = (process.env.PLATFORM_URL || url.origin).replace(/\/+$/, "");
  const portalUrl = `${platformUrl}/${slug}`;
  const renderConfig = preview ? { ...tenant, previewToken } : tenant;
  const html = renderPortal(renderConfig, {
    template: platform.template,
    version: platform.version,
    portalUrl
  });
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": `frame-ancestors 'self' ${tenant.embedOrigins.join(" ")};`
  });

  if (preview) {
    headers.set("cache-control", "no-store");
  } else {
    headers.set("cache-control", "public, max-age=0, must-revalidate");
    headers.set("netlify-cdn-cache-control", "public, durable, s-maxage=300, stale-while-revalidate=86400");
    headers.set("cache-tag", `tenant-${slug}`);
  }
  return new Response(html, { headers });
}

export const config = { path: ["/:slug", "/:slug/"], excludedPath: ["/dashboard", "/dashboard/"], preferStatic: true };
