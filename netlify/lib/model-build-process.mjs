import { dashboardEmailsFor } from "./dashboard-auth.mjs";
import { forTenant } from "./sponsorship.mjs";
import { downloadAsset, downloadModel, getMultiImageTo3D } from "./meshy.mjs";
import { optimizeGlb } from "./optimize-glb.mjs";
import {
  errorKey,
  jobKey,
  modelKey,
  storeBuildError,
  storeForTenant,
  thumbnailKey
} from "./model-build.mjs";

export async function processBuild(tenant, jobId, { origin } = {}) {
  const slug = tenant.slug;
  const store = storeForTenant();
  const job = await store.get(jobKey(slug), { type: "json" });
  if (!job || job.id !== jobId || await store.getMetadata(modelKey(slug, jobId))) return;

  try {
    if (!job.taskId) throw new Error("The current model build has no Meshy task ID.");
    const task = await getMultiImageTo3D(job.taskId);
    if (String(task?.status || "").toUpperCase() !== "SUCCEEDED") {
      throw new Error("Meshy model task is not complete.");
    }
    const modelUrl = task.model_urls?.glb;
    if (!modelUrl) throw new Error("Meshy completed without a GLB URL.");
    const raw = await downloadModel(modelUrl);
    const optimized = await optimizeGlb(raw.bytes);
    const latestJob = await store.get(jobKey(slug), { type: "json" });
    if (latestJob?.id !== jobId || await store.getMetadata(modelKey(slug, jobId))) return;

    const at = new Date().toISOString();
    await store.set(modelKey(slug, jobId), optimized.bytes, {
      metadata: {
        contentType: "model/gltf-binary",
        at,
        bytes: optimized.bytes.length,
        rawBytes: raw.bytes.length,
        triangles: optimized.triangles,
        textureSize: optimized.textureSize,
        bounds: optimized.bounds,
        warnings: optimized.warnings
      }
    });

    if (task.thumbnail_url) {
      try {
        const thumbnail = await downloadAsset(task.thumbnail_url);
        await store.set(thumbnailKey(slug, jobId), thumbnail.bytes, {
          metadata: { contentType: thumbnail.contentType, at: new Date().toISOString() }
        });
      } catch (thumbnailError) {
        console.error("Model build thumbnail download failed.", {
          slug,
          jobId,
          message: thumbnailError?.message || "Unknown thumbnail error"
        });
      }
    }

    const base = (process.env.PLATFORM_URL || origin || "").replace(/\/+$/, "");
    const dashboardUrl = `${base}/dashboard/${encodeURIComponent(slug)}/model`;
    const services = forTenant(tenant, { portalUrl: `${base}/${slug}` });
    await services.tryEmail({
      to: dashboardEmailsFor(tenant),
      subject: "Your 3D model is ready",
      text: `Your 3D model has been built. You can check it here:\n${dashboardUrl}\n\nWe'll set up the 360° preview with your sponsor placements next.`
    });
  } catch (error) {
    console.error("Model build processing failed.", {
      slug,
      jobId,
      message: error?.providerMessage || error?.message || "Unknown model processing error"
    });
    await storeBuildError(store, slug, jobId, "We couldn't finish your 3D model.");
  }
}
