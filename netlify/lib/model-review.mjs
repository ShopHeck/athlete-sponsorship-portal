import { getStore } from "@netlify/blobs";
import { loadBuild, modelKey, storeForTenant } from "./model-build.mjs";
import { resolveTenantAssets } from "./render.mjs";
import { loadViews } from "./reference-views.mjs";

const athleteKey = (slug) => `${slug}/review/athlete`;
const operatorKey = (slug) => `${slug}/review/operator`;
const livePointerKey = (slug) => `${slug}/live/current`;
const liveAssetKey = (slug, jobId) => `${slug}/live/${jobId}/model.glb`;
const store = () => getStore({ name: "model-studio", consistency: "strong" });

export async function getLivePointer(tenant) {
  return store().get(livePointerKey(tenant.slug), { type: "json" });
}

export async function loadReview(tenant, build) {
  const reviewStore = store();
  const [storedAthlete, storedOperator, live] = await Promise.all([
    reviewStore.get(athleteKey(tenant.slug), { type: "json" }),
    reviewStore.get(operatorKey(tenant.slug), { type: "json" }),
    reviewStore.get(livePointerKey(tenant.slug), { type: "json" })
  ]);
  const jobId = live?.jobId ?? build?.jobId ?? null;
  const athlete = storedAthlete?.jobId === jobId ? storedAthlete : null;
  const operator = storedOperator?.jobId === jobId ? storedOperator : null;
  let status = "locked";
  if (live) {
    status = "live";
  } else if (build?.status === "ready") {
    if (athlete?.decision !== "approved") {
      status = "athlete_review";
    } else if (operator?.decision === "changes" &&
        Date.parse(athlete.at) <= Date.parse(operator.at)) {
      status = "sent_back";
    } else {
      status = "operator_review";
    }
  }
  return { status, jobId, athlete, operator, live };
}

export async function loadReviewState(tenant) {
  const reviewStore = storeForTenant();
  const [submission, live] = await Promise.all([
    reviewStore.get(`${tenant.slug}/submission`, { type: "json" }),
    getLivePointer(tenant)
  ]);
  const staticOwnModel = resolveTenantAssets(tenant).model?.startsWith(`/tenants/${tenant.slug}/`) === true;
  const ownModel = staticOwnModel || Boolean(live);
  const views = await loadViews(tenant, { submitted: Boolean(submission), ownModel });
  const build = await loadBuild(tenant, {
    viewsStatus: views.status,
    ownModel,
    liveJobId: live?.jobId ?? null
  });
  return { views, build, review: await loadReview(tenant, build), live };
}

export async function saveAthleteReview(tenant, review) {
  await store().setJSON(athleteKey(tenant.slug), review);
}

export async function saveOperatorReview(tenant, review) {
  await store().setJSON(operatorKey(tenant.slug), review);
}

export async function publishLiveModel(tenant, jobId) {
  const reviewStore = storeForTenant();
  const sourceKey = modelKey(tenant.slug, jobId);
  const source = await reviewStore.getMetadata(sourceKey);
  if (!source) return null;
  const bytes = await reviewStore.get(sourceKey, { type: "arrayBuffer" });
  if (!bytes) return null;

  const publishedAt = new Date().toISOString();
  const live = { jobId, publishedAt, bytes: source.size ?? bytes.byteLength };
  await reviewStore.set(liveAssetKey(tenant.slug, jobId), bytes, {
    metadata: source.metadata || { contentType: "model/gltf-binary" }
  });
  await reviewStore.setJSON(livePointerKey(tenant.slug), live);
  await reviewStore.setJSON(operatorKey(tenant.slug), {
    jobId,
    decision: "published",
    note: "",
    at: publishedAt
  });
  return live;
}

export async function unpublishLiveModel(tenant, note = "") {
  const reviewStore = storeForTenant();
  const live = await reviewStore.get(livePointerKey(tenant.slug), { type: "json" });
  if (!live) return null;
  await reviewStore.delete(livePointerKey(tenant.slug));
  await reviewStore.setJSON(operatorKey(tenant.slug), {
    jobId: live.jobId,
    decision: "unpublished",
    note,
    at: new Date().toISOString()
  });
  return live;
}

export async function getLiveModelAsset(tenant, jobId, liveRecord) {
  const reviewStore = storeForTenant();
  const live = liveRecord === undefined
    ? await reviewStore.get(livePointerKey(tenant.slug), { type: "json" })
    : liveRecord;
  if (!live || live.jobId !== jobId) return null;
  const key = liveAssetKey(tenant.slug, jobId);
  const metadata = await reviewStore.getMetadata(key);
  if (!metadata) return null;
  const bytes = await reviewStore.get(key, { type: "arrayBuffer" });
  if (!bytes) return null;
  return {
    bytes,
    contentType: metadata.metadata?.contentType || "model/gltf-binary"
  };
}
