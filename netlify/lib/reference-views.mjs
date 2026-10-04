import { randomUUID } from "node:crypto";
import { getStore } from "@netlify/blobs";
import { resolveTenantAssets } from "./render.mjs";
import {
  createImageToImage,
  downloadAsset,
  getImageToImage,
  isMeshyConfigured,
  MeshyConfigurationError,
  MeshyRequestError
} from "./meshy.mjs";

const ANGLES = ["front", "back", "left", "right"];
const MAX_ATTEMPTS = 3;
const TASK_CREATION_TIMEOUT_MS = 5 * 60 * 1000;
const VIEW_TIMEOUT_MS = 30 * 60 * 1000;
const PROMPT_VERSION = "2026-10-03";
const PALETTE = [
  ["black", "#111111"],
  ["charcoal", "#36454f"],
  ["grey", "#808080"],
  ["white", "#ffffff"],
  ["red", "#d32f2f"],
  ["crimson", "#990f1f"],
  ["maroon", "#6d1a1a"],
  ["orange", "#ff6a1a"],
  ["gold", "#d4a017"],
  ["yellow", "#f5d90a"],
  ["green", "#2e7d32"],
  ["olive", "#6b7a2a"],
  ["teal", "#00897b"],
  ["light blue", "#64b5f6"],
  ["royal blue", "#1e4fd8"],
  ["navy", "#1a2a5a"],
  ["purple", "#6a1b9a"],
  ["pink", "#ec6fa8"],
  ["brown", "#6d4c41"],
  ["tan", "#d2b48c"]
];

const storeForTenant = () => getStore({ name: "model-studio", consistency: "strong" });
const jobKey = (slug) => `${slug}/views/job`;
const resultKey = (slug, jobId, angle) => `${slug}/views/${jobId}/${angle}`;
const errorKey = (slug, jobId, angle) => `${slug}/views/${jobId}/errors/${angle}`;

export function nearestName(hex) {
  const color = hex.replace(/^#/, "");
  const red = Number.parseInt(color.slice(0, 2), 16);
  const green = Number.parseInt(color.slice(2, 4), 16);
  const blue = Number.parseInt(color.slice(4, 6), 16);
  let nearest = PALETTE[0][0];
  let distance = Number.POSITIVE_INFINITY;
  for (const [name, value] of PALETTE) {
    const candidate = value.slice(1);
    const dr = red - Number.parseInt(candidate.slice(0, 2), 16);
    const dg = green - Number.parseInt(candidate.slice(2, 4), 16);
    const db = blue - Number.parseInt(candidate.slice(4, 6), 16);
    const nextDistance = dr * dr + dg * dg + db * db;
    if (nextDistance < distance) {
      nearest = name;
      distance = nextDistance;
    }
  }
  return nearest;
}

export function viewPrompt(angle, kit, hasFace) {
  const kitColour = (hex) => `${nearestName(hex)} (${hex.toLowerCase()})`;
  const shirt = kitColour(kit.shirt);
  const shorts = kitColour(kit.shorts);
  const waistband = kitColour(kit.waistband);
  const outfit = `Dress them in a plain ${shirt} fitted crew-neck short-sleeve T-shirt with no logos, text or graphics, and plain solid ${shorts} fight shorts with a plain ${waistband} waistband and absolutely no logos, patches or text. Keep their own footwear and any hand wraps exactly as in the photos.`;
  const identity = "Keep this exact person: same face, skin tone, hair, facial hair, tattoos, body shape, muscle definition and proportions.";
  const studio = "Full body visible head to feet, plain white background, even soft lighting, photorealistic studio photo.";

  if (angle === "front") {
    const face = hasFace ? " Image 2 is a close-up of the same person's face." : "";
    return `Image 1 is a full-body photo of an athlete facing the camera.${face} ${identity} Show them facing the camera in a neutral standing pose with arms relaxed slightly away from the torso. ${outfit} ${studio}`;
  }
  const face = hasFace ? " Image 3 is a close-up of their face." : "";
  const view = angle === "back" ? "from directly behind" : "in side profile";
  return `Image 1 shows the athlete photographed ${view}. Image 2 shows the same person from the front.${face} ${identity} Show them in exactly the camera angle, facing direction and standing pose of image 1. ${outfit} ${studio}`;
}

function hasOwnModel(tenant) {
  return resolveTenantAssets(tenant).model?.startsWith(`/tenants/${tenant.slug}/`) === true;
}

export async function loadViews(tenant, {
  submitted = false,
  ownModel = hasOwnModel(tenant),
  progress = {}
} = {}) {
  const store = storeForTenant();
  const slug = tenant.slug;
  const [job, storedDecision, live] = await Promise.all([
    store.get(jobKey(slug), { type: "json" }),
    store.get(`${slug}/views/decision`, { type: "json" }),
    store.get(`${slug}/live/current`, { type: "json" })
  ]);
  const hasTenantModel = ownModel || Boolean(live);
  const attempt = job?.attempt || 0;
  const shared = {
    jobId: job?.id ?? null,
    attempt,
    attemptsLeft: Math.max(0, MAX_ATTEMPTS - attempt),
    startedAt: job?.startedAt ?? null,
    angles: null,
    decision: storedDecision && storedDecision.jobId === job?.id ? {
      decision: storedDecision.decision,
      feedback: storedDecision.feedback,
      at: storedDecision.at
    } : null
  };
  if (!submitted || hasTenantModel) return { status: "locked", ...shared, angles: null, decision: null };
  if (!job) return { status: "not_started", ...shared, angles: null, decision: null };

  const records = await Promise.all(ANGLES.map(async (angle) => {
    const [image, error] = await Promise.all([
      store.getMetadata(resultKey(slug, job.id, angle)),
      store.get(errorKey(slug, job.id, angle), { type: "json" })
    ]);
    if (image) return [angle, { status: "ready", progress: 100, at: image.metadata?.at ?? null }];
    if (error) return [angle, { status: "failed", progress: 100, at: error.at ?? null }];
    const taskId = job.tasks?.[angle];
    const startedAt = Date.parse(job.startedAt);
    const timedOut = (taskId === null || taskId === undefined) &&
      Number.isFinite(startedAt) && Date.now() - startedAt > TASK_CREATION_TIMEOUT_MS;
    if (timedOut) return [angle, { status: "failed", progress: 100, at: null }];
    const currentProgress = progress[angle];
    return [angle, {
      status: "pending",
      progress: Number.isFinite(currentProgress) ? Math.max(0, Math.min(100, currentProgress)) : 0,
      at: null
    }];
  }));
  const angles = Object.fromEntries(records);
  const statuses = Object.values(angles).map((angle) => angle.status);
  const status = statuses.includes("pending")
    ? "generating"
    : statuses.includes("failed")
      ? "failed"
      : shared.decision?.decision === "approve"
        ? "approved"
        : shared.decision?.decision === "reject"
          ? "rejected"
          : "review";
  return { status, ...shared, angles };
}

async function privatePhotoDataUrl(store, slug, angle, optional = false) {
  const key = `${slug}/photo/${angle}`;
  if (!(await store.getMetadata(key))) {
    if (optional) return null;
    throw new Error(`Private ${angle} photo is unavailable.`);
  }
  const bytes = await store.get(key, { type: "arrayBuffer" });
  if (!bytes) {
    if (optional) return null;
    throw new Error(`Private ${angle} photo is unavailable.`);
  }
  return `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`;
}

export async function startViews(tenant, session) {
  const store = storeForTenant();
  const slug = tenant.slug;
  const submission = await store.get(`${slug}/submission`, { type: "json" });
  const views = await loadViews(tenant, { submitted: Boolean(submission) });
  if (views.status === "generating" || views.status === "review") return { status: 200 };
  if (views.status === "approved") {
    return { status: 409, error: "Your views are already approved." };
  }
  if (views.status === "locked") return { status: 409, error: "Submit your photos first." };
  if (views.attempt >= MAX_ATTEMPTS) {
    return { status: 409, error: "You've used all 3 generations — contact us and we'll fix it by hand." };
  }
  if (!isMeshyConfigured()) {
    return { status: 503, error: "Reference generation isn't configured." };
  }

  const previousJob = await store.get(jobKey(slug), { type: "json" });
  const job = {
    id: randomUUID(),
    attempt: (previousJob?.attempt || 0) + 1,
    startedAt: new Date().toISOString(),
    by: session.email,
    tasks: Object.fromEntries(ANGLES.map((angle) => [angle, null])),
    promptVersion: PROMPT_VERSION
  };
  await store.setJSON(jobKey(slug), job);
  const currentJob = await store.get(jobKey(slug), { type: "json" });
  if (currentJob?.id !== job.id) return { status: 200 };

  const kitPromise = store.get(`${slug}/kit`, { type: "json" });
  const photoCache = new Map();
  const getPhoto = (angle, optional = false) => {
    const cacheKey = `${angle}:${optional}`;
    if (!photoCache.has(cacheKey)) {
      photoCache.set(cacheKey, privatePhotoDataUrl(store, slug, angle, optional));
    }
    return photoCache.get(cacheKey);
  };
  const settled = await Promise.allSettled(ANGLES.map(async (angle) => {
    const kit = await kitPromise;
    if (!kit) throw new Error("Kit colours are unavailable.");
    const refs = angle === "front"
      ? [await getPhoto("front"), ...(await getPhoto("face", true) ? [await getPhoto("face", true)] : [])]
      : [await getPhoto(angle), await getPhoto("front"), ...(await getPhoto("face", true) ? [await getPhoto("face", true)] : [])];
    return createImageToImage({
      prompt: viewPrompt(angle, kit, refs.length === (angle === "front" ? 2 : 3)),
      referenceImageUrls: refs
    });
  }));

  const tasks = {};
  await Promise.all(settled.map(async (result, index) => {
    const angle = ANGLES[index];
    if (result.status === "fulfilled") {
      tasks[angle] = result.value;
      return;
    }
    tasks[angle] = null;
    const message = result.reason?.message || "Meshy task creation failed.";
    console.error("Meshy image-to-image creation failed.", {
      slug,
      angle,
      status: result.reason?.status ?? null,
      message
    });
    await store.setJSON(errorKey(slug, job.id, angle), { message, at: new Date().toISOString() });
  }));
  const latestJob = await store.get(jobKey(slug), { type: "json" });
  if (latestJob?.id === job.id) {
    await store.setJSON(jobKey(slug), { ...job, tasks });
  }
  return { status: 200 };
}

export async function advanceViews(tenant) {
  if (!isMeshyConfigured()) throw new MeshyConfigurationError();
  const store = storeForTenant();
  const slug = tenant.slug;
  const job = await store.get(jobKey(slug), { type: "json" });
  if (!job) return {};
  const progress = {};
  await Promise.all(ANGLES.map(async (angle) => {
    const taskId = job.tasks?.[angle];
    if (!taskId) return;
    const imageKey = resultKey(slug, job.id, angle);
    const failureKey = errorKey(slug, job.id, angle);
    const [image, failure] = await Promise.all([
      store.getMetadata(imageKey),
      store.get(failureKey, { type: "json" })
    ]);
    if (image || failure) return;
    try {
      const task = await getImageToImage(taskId);
      const status = String(task?.status || "").toUpperCase();
      const startedAt = Date.parse(job.startedAt);
      const timedOut = Number.isFinite(startedAt) && Date.now() - startedAt > VIEW_TIMEOUT_MS;
      if (status === "SUCCEEDED") {
        const assetUrl = Array.isArray(task.image_urls) ? task.image_urls[0] : null;
        if (!assetUrl) throw new Error("Meshy completed without an image URL.");
        const asset = await downloadAsset(assetUrl);
        await store.set(imageKey, asset.bytes, {
          metadata: { at: new Date().toISOString(), contentType: asset.contentType, taskId }
        });
      } else if (["FAILED", "CANCELED", "EXPIRED"].includes(status)) {
        await store.setJSON(failureKey, {
          message: task.task_error?.message || `Meshy task ${status.toLowerCase()}.`,
          at: new Date().toISOString()
        });
      } else if (timedOut) {
        await store.setJSON(failureKey, { message: "Meshy task timed out.", at: new Date().toISOString() });
      } else {
        const current = Number(task?.progress);
        progress[angle] = Number.isFinite(current) ? Math.max(0, Math.min(100, current)) : 0;
      }
    } catch (error) {
      const message = error?.message || "Meshy task polling failed.";
      console.error("Meshy image-to-image polling failed.", {
        slug,
        angle,
        taskId,
        status: error?.status ?? null,
        message
      });
      if (error instanceof MeshyRequestError &&
          error.status >= 400 && error.status < 500 &&
          error.status !== 408 && error.status !== 429) {
        await store.setJSON(failureKey, { message, at: new Date().toISOString() });
      }
    }
  }));
  return progress;
}

export async function recordViewDecision(tenant, session, body) {
  const decision = body?.decision;
  const feedback = body?.feedback === undefined
    ? ""
    : typeof body.feedback === "string" ? body.feedback.trim() : null;
  if (typeof body?.jobId !== "string" || !body.jobId ||
      !["approve", "reject"].includes(decision) ||
      feedback === null || feedback.length > 500) {
    return { status: 400, error: "Invalid view decision." };
  }

  const store = storeForTenant();
  const slug = tenant.slug;
  const submission = await store.get(`${slug}/submission`, { type: "json" });
  const views = await loadViews(tenant, { submitted: Boolean(submission) });
  if (views.status !== "review" || views.jobId !== body.jobId) {
    return { status: 409, error: "These views are not ready for a decision." };
  }
  const record = {
    jobId: body.jobId,
    decision,
    feedback,
    at: new Date().toISOString(),
    by: session.email
  };
  await store.setJSON(`${slug}/views/decision`, record);
  return { status: 200 };
}

export async function getViewAsset(tenant, angle) {
  if (!ANGLES.includes(angle)) return null;
  const store = storeForTenant();
  const job = await store.get(jobKey(tenant.slug), { type: "json" });
  if (!job?.id) return null;
  const key = resultKey(tenant.slug, job.id, angle);
  const metadata = await store.getMetadata(key);
  if (!metadata) return null;
  const bytes = await store.get(key, { type: "arrayBuffer" });
  if (!bytes) return null;
  return {
    bytes,
    contentType: metadata.metadata?.contentType || "image/png"
  };
}
