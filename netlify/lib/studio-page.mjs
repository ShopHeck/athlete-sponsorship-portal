import platform from "./platform.generated.json";
import { loadReviewState } from "./model-review.mjs";
import { renderPortal } from "./render.mjs";

const notFoundHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Studio preview not found</title></head>
<body><main><h1>Studio preview not found</h1></main></body></html>`;

function secureHeaders() {
  return new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "frame-ancestors 'none'",
    "referrer-policy": "same-origin",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex"
  });
}

export async function renderStudioPage(req, tenant, mode) {
  const { build, review } = await loadReviewState(tenant);
  if (build.status !== "ready" && !review.live) {
    return new Response(notFoundHtml, { status: 404, headers: secureHeaders() });
  }
  const jobId = build.status === "ready" ? build.jobId : review.live?.jobId;
  if (!jobId) return new Response(notFoundHtml, { status: 404, headers: secureHeaders() });

  const url = new URL(req.url);
  const base = (process.env.PLATFORM_URL || url.origin).replace(/\/+$/, "");
  const config = {
    ...tenant,
    model: `/api/dashboard/${encodeURIComponent(tenant.slug)}/model/build/model.glb?v=${encodeURIComponent(jobId)}`,
    studio: {
      mode,
      slug: tenant.slug,
      jobId,
      review,
      attemptsLeft: build.attemptsLeft,
      displayName: tenant.athlete.displayName
    }
  };
  delete config.previewToken;
  const html = renderPortal(config, {
    template: platform.template,
    version: platform.version,
    portalUrl: `${base}/${tenant.slug}`
  });
  return new Response(html, { headers: secureHeaders() });
}
