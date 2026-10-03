import { createHmac, randomUUID } from "node:crypto";
import { getStore } from "@netlify/blobs";
import { forTenant } from "./sponsorship.mjs";
import { dashboardEmailsFor } from "./dashboard-auth.mjs";
import { resolveTenantAssets } from "./render.mjs";
import {
  createMultiImageTo3D,
  downloadAsset,
  downloadModel,
  getMultiImageTo3D,
  isMeshyConfigured,
  MeshyConfigurationError,
  MeshyRequestError
} from "./meshy.mjs";
import { getViewAsset, loadViews } from "./reference-views.mjs";
import { optimizeGlb } from "./optimize-glb.mjs";

export const MAX_BUILD_ATTEMPTS = 3;

const TASK_CREATION_TIMEOUT_MS = 5 * 60 * 1000;
const MESHY_TIMEOUT_MS = 30 * 60 * 1000;
const PROCESSING_TIMEOUT_MS = 16 * 60 * 1000;
const SETTINGS_VERSION = "2026-10-03";
const ANGLES = ["front", "back", "left", "right"];

const storeForTenant = () => getStore({ name: "model-studio", consistency: "strong" });
const jobKey = (slug) => `${slug}/build/job`;
const processingKey = (slug, jobId) => `${slug}/build/${jobId}/processing`;
const modelKey = (slug, jobId) => `${slug}/build/${jobId}/model.glb`;
const thumbnailKey = (slug, jobId) => `${slug}/build/${jobId}/thumbnail`;
const errorKey = (slug, jobId) => `${slug}/build/${jobId}/error`;
const hasOwnModel = (tenant) =>
  resolveTenantAssets(tenant).model?.startsWith(`/tenants/${tenant.slug}/`) === true;

function ageOf(value) {
  const startedAt = Date.parse(value);
  return Number.isFinite(startedAt) ? Date.now() - startedAt : 0;
}

function clampedProgress(progress) {
  return Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) : 0;
}

export async function loadBuild(tenant, {
  viewsStatus,
  ownModel = hasOwnModel(tenant),
  progress
} = {}) {
  const store = storeForTenant();
  const slug = tenant.slug;
  const [job, viewsJob] = await Promise.all([
    store.get(jobKey(slug), { type: "json" }),
    store.get(`${slug}/views/job`, { type: "json" })
  ]);
  const attempt = job?.attempt || 0;
  const shared = {
    jobId: job?.id ?? null,
    attempt,
    attemptsLeft: Math.max(0, MAX_BUILD_ATTEMPTS - attempt),
    startedAt: job?.startedAt ?? null,
    progress: clampedProgress(progress),
    model: null
  };
  if (viewsStatus !== "approved" || ownModel) return { status: "locked", ...shared };
  if (!job || job.viewsJobId !== viewsJob?.id) return { status: "not_started", ...shared };

  const [processing, model, error] = await Promise.all([
    store.get(processingKey(slug, job.id), { type: "json" }),
    store.getMetadata(modelKey(slug, job.id)),
    store.get(errorKey(slug, job.id), { type: "json" })
  ]);
  let status;
  if (model) {
    status = "ready";
  } else if (error) {
    status = "failed";
  } else if (processing) {
    status = "processing";
  } else if (!job.taskId && ageOf(job.startedAt) > TASK_CREATION_TIMEOUT_MS) {
    status = "failed";
  } else {
    status = "building";
  }
  return {
    status,
    ...shared,
    progress: status === "processing" ? 100 : shared.progress,
    model: model ? {
      bytes: model.metadata?.bytes ?? model.size ?? 0,
      triangles: model.metadata?.triangles ?? 0,
      warnings: model.metadata?.warnings ?? []
    } : null
  };
}

async function approvedViews(tenant) {
  const store = storeForTenant();
  const submission = await store.get(`${tenant.slug}/submission`, { type: "json" });
  const views = await loadViews(tenant, { submitted: Boolean(submission) });
  return views.status === "approved" ? views : null;
}

export async function startBuild(tenant, session) {
  const views = await approvedViews(tenant);
  if (!views) return { status: 409, error: "Approve your reference views first." };

  const build = await loadBuild(tenant, {
    viewsStatus: views.status,
    ownModel: hasOwnModel(tenant)
  });
  if (["building", "processing", "ready"].includes(build.status)) {
    return { status: 200 };
  }
  if (build.attempt >= MAX_BUILD_ATTEMPTS) {
    return { status: 409, error: "You've used all 3 build attempts — contact us and we'll finish it by hand." };
  }
  if (!isMeshyConfigured()) {
    return { status: 503, error: "3D model building isn't configured." };
  }

  const store = storeForTenant();
  const previousJob = await store.get(jobKey(tenant.slug), { type: "json" });
  const job = {
    id: randomUUID(),
    attempt: (previousJob?.attempt || 0) + 1,
    startedAt: new Date().toISOString(),
    by: session.email,
    viewsJobId: views.jobId,
    taskId: null,
    settingsVersion: SETTINGS_VERSION
  };
  await store.setJSON(jobKey(tenant.slug), job);
  const currentJob = await store.get(jobKey(tenant.slug), { type: "json" });
  if (currentJob?.id !== job.id) return { status: 200 };

  try {
    const imageUrls = await Promise.all(ANGLES.map(async (angle) => {
      const asset = await getViewAsset(tenant, angle);
      if (!asset) throw new Error(`Approved ${angle} view is unavailable.`);
      return `data:${asset.contentType};base64,${Buffer.from(asset.bytes).toString("base64")}`;
    }));
    const taskId = await createMultiImageTo3D({ imageUrls });
    const latestJob = await store.get(jobKey(tenant.slug), { type: "json" });
    if (latestJob?.id === job.id) {
      await store.setJSON(jobKey(tenant.slug), { ...job, taskId });
    }
  } catch (error) {
    console.error("Meshy multi-image-to-3D creation failed.", {
      slug: tenant.slug,
      status: error?.status ?? null,
      message: error?.providerMessage || error?.message || "Unknown Meshy error"
    });
    await store.setJSON(errorKey(tenant.slug, job.id), {
      message: error?.providerMessage || error?.message || "Meshy task creation failed.",
      at: new Date().toISOString()
    });
  }
  return { status: 200 };
}

async function kickBackground(origin, slug, jobId) {
  const secret = process.env.DASHBOARD_SECRET;
  if (!secret) throw new Error("DASHBOARD_SECRET is not configured.");
  const signature = createHmac("sha256", secret).update(`${slug}.${jobId}`).digest("hex");
  const base = origin.replace(/\/+$/, "");
  const response = await fetch(`${base}/.netlify/functions/model-build-background`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-build-signature": signature
    },
    body: JSON.stringify({ slug, jobId }),
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) {
    throw new Error(`Background model build returned ${response.status}.`);
  }
}

async function storeBuildError(store, slug, jobId, message) {
  await store.setJSON(errorKey(slug, jobId), { message, at: new Date().toISOString() });
}

export async function advanceBuild(tenant, { origin }) {
  if (!isMeshyConfigured()) throw new MeshyConfigurationError();
  const store = storeForTenant();
  const slug = tenant.slug;
  const job = await store.get(jobKey(slug), { type: "json" });
  if (!job?.id) return {};
  const [model, error, processing] = await Promise.all([
    store.getMetadata(modelKey(slug, job.id)),
    store.get(errorKey(slug, job.id), { type: "json" }),
    store.get(processingKey(slug, job.id), { type: "json" })
  ]);
  if (model || error) return {};

  if (processing) {
    if (ageOf(processing.at) <= PROCESSING_TIMEOUT_MS) return {};
    if (processing.kicks < 2) {
      const nextProcessing = { at: new Date().toISOString(), kicks: processing.kicks + 1 };
      await store.setJSON(processingKey(slug, job.id), nextProcessing);
      try {
        await kickBackground(origin, slug, job.id);
      } catch (kickError) {
        console.error("Model build background retry failed.", {
          slug,
          jobId: job.id,
          message: kickError?.message || "Unknown background error"
        });
      }
    } else {
      await storeBuildError(store, slug, job.id, "Model optimisation timed out.");
    }
    return {};
  }

  if (!job.taskId) {
    if (ageOf(job.startedAt) > TASK_CREATION_TIMEOUT_MS) {
      await storeBuildError(store, slug, job.id, "Meshy task creation timed out.");
    }
    return {};
  }

  if (ageOf(job.startedAt) > MESHY_TIMEOUT_MS) {
    await storeBuildError(store, slug, job.id, "Meshy task timed out.");
    return {};
  }

  try {
    const task = await getMultiImageTo3D(job.taskId);
    const status = String(task?.status || "").toUpperCase();
    if (status === "SUCCEEDED") {
      const latestJob = await store.get(jobKey(slug), { type: "json" });
      if (latestJob?.id !== job.id) return {};
      await store.setJSON(processingKey(slug, job.id), { at: new Date().toISOString(), kicks: 1 });
      try {
        await kickBackground(origin, slug, job.id);
      } catch (kickError) {
        console.error("Model build background trigger failed.", {
          slug,
          jobId: job.id,
          message: kickError?.message || "Unknown background error"
        });
      }
    } else if (["FAILED", "CANCELED", "EXPIRED"].includes(status)) {
      await storeBuildError(
        store,
        slug,
        job.id,
        task?.task_error?.message || `Meshy task ${status.toLowerCase()}.`
      );
    } else {
      return { progress: clampedProgress(Number(task?.progress)) };
    }
  } catch (error) {
    console.error("Meshy multi-image-to-3D polling failed.", {
      slug,
      jobId: job.id,
      taskId: job.taskId,
      status: error?.status ?? null,
      message: error?.providerMessage || error?.message || "Unknown Meshy error"
    });
    if (error instanceof MeshyRequestError &&
        error.status >= 400 && error.status < 500 &&
        error.status !== 408 && error.status !== 429) {
      await storeBuildError(store, slug, job.id, error.providerMessage || error.message);
    }
  }
  return {};
}

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

export async function getBuildAsset(tenant, kind) {
  if (!["model", "thumbnail"].includes(kind)) return null;
  const store = storeForTenant();
  const job = await store.get(jobKey(tenant.slug), { type: "json" });
  if (!job?.id) return null;
  const key = kind === "model" ? modelKey(tenant.slug, job.id) : thumbnailKey(tenant.slug, job.id);
  const metadata = await store.getMetadata(key);
  if (!metadata) return null;
  const bytes = await store.get(key, { type: "arrayBuffer" });
  if (!bytes) return null;
  return {
    bytes,
    contentType: metadata.metadata?.contentType || (kind === "model" ? "model/gltf-binary" : "image/png")
  };
}
