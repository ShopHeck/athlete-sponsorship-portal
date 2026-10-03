const DEFAULT_API_BASE = "https://api.meshy.ai";
const MAX_ASSET_BYTES = 10 * 1024 * 1024;

export class MeshyConfigurationError extends Error {
  constructor() {
    super("Reference generation isn't configured.");
    this.name = "MeshyConfigurationError";
  }
}

export class MeshyRequestError extends Error {
  constructor(status, message) {
    super(`Meshy request failed (${status}): ${message}`);
    this.name = "MeshyRequestError";
    this.status = status;
    this.providerMessage = message;
  }
}

export function isMeshyConfigured() {
  return Boolean(process.env.MESHY_API_KEY);
}

function apiBase() {
  return (process.env.MESHY_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, "");
}

async function responseMessage(response) {
  const raw = await response.text();
  if (!raw) return response.statusText || "Unknown provider error";
  try {
    const body = JSON.parse(raw);
    return body?.message || body?.error?.message || body?.error || raw;
  } catch {
    return raw;
  }
}

async function apiRequest(path, options = {}) {
  const key = process.env.MESHY_API_KEY;
  if (!key) throw new MeshyConfigurationError();
  const response = await fetch(`${apiBase()}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${key}`,
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) {
    throw new MeshyRequestError(response.status, await responseMessage(response));
  }
  return response;
}

export async function createImageToImage({ prompt, referenceImageUrls }) {
  const response = await apiRequest("/openapi/v1/image-to-image", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ai_model: "nano-banana-pro",
      prompt,
      reference_image_urls: referenceImageUrls,
      aspect_ratio: "9:16",
      remove_background: true
    })
  });
  const body = await response.json();
  if (typeof body?.result !== "string" || !body.result) {
    throw new Error("Meshy image-to-image response did not include a task ID.");
  }
  return body.result;
}

export async function getImageToImage(id) {
  let response;
  try {
    response = await apiRequest(`/openapi/v1/image-to-image/${encodeURIComponent(id)}`);
  } catch (error) {
    if (error instanceof MeshyRequestError && error.status === 404) {
      return { status: "EXPIRED", progress: 0, task_error: { message: "Task expired or not found." } };
    }
    throw error;
  }
  return response.json();
}

function allowedAssetUrl(url) {
  if (url.username || url.password) return false;
  const meshyAsset = url.protocol === "https:" &&
    (url.hostname === "assets.meshy.ai" || url.hostname.endsWith(".meshy.ai"));
  if (meshyAsset) return true;
  if (!process.env.MESHY_API_BASE) return false;
  try {
    return url.origin === new URL(process.env.MESHY_API_BASE).origin;
  } catch {
    return false;
  }
}

async function readLimited(response) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_ASSET_BYTES) {
    throw new Error("Meshy asset exceeds the 10 MB limit.");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_ASSET_BYTES) {
        await reader.cancel();
        throw new Error("Meshy asset exceeds the 10 MB limit.");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

export async function downloadAsset(assetUrl) {
  let url;
  try {
    url = new URL(assetUrl);
  } catch {
    throw new Error("Meshy returned an invalid asset URL.");
  }
  if (!allowedAssetUrl(url)) throw new Error("Meshy asset URL is not allowed.");

  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) {
    throw new MeshyRequestError(response.status, await responseMessage(response));
  }
  const contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!["image/png", "image/jpeg"].includes(contentType)) {
    throw new Error("Meshy asset must be a PNG or JPEG image.");
  }
  return { bytes: await readLimited(response), contentType };
}
