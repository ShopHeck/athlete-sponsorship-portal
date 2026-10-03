// Local stand-in for Stripe + Resend + Meshy so flows can be tested without real side effects.
//
//   node scripts/mock-services.mjs                # listens on :4242, logs to .netlify/mock-log.jsonl
//   FAIL_INVOICE=1 node scripts/mock-services.mjs # every invoice creation fails (tests the retry path)
//
// Point the functions at it with STRIPE_API_BASE / RESEND_API_BASE (see scripts/smoke-test.sh).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { Document, NodeIO } from "@gltf-transform/core";

const PORT = Number(process.env.MOCK_PORT) || 4242;
const LOG = process.env.MOCK_LOG || path.join(".netlify", "mock-log.jsonl");
const FAIL_INVOICE = process.env.FAIL_INVOICE === "1";
fs.mkdirSync(path.dirname(LOG), { recursive: true });
fs.writeFileSync(LOG, "");
let n = 0;
let meshTaskCounter = 0;
let failNextMeshy = false;
let failNextMeshyPoll = false;
const accounts = new Map();
const meshTasks = new Map();
const MOCK_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGElEQVR4nGP4nyD1X6rC6D8DiPj///9/AE28CfuTPnKJAAAAAElFTkSuQmCC",
  "base64"
);

async function createMockGlb() {
  const document = new Document();
  const buffer = document.createBuffer();
  const faces = [
    [[-0.25, 0, 0.15], [0.25, 0, 0.15], [0.25, 1.8, 0.15], [-0.25, 1.8, 0.15]],
    [[0.25, 0, -0.15], [-0.25, 0, -0.15], [-0.25, 1.8, -0.15], [0.25, 1.8, -0.15]],
    [[-0.25, 0, -0.15], [-0.25, 0, 0.15], [-0.25, 1.8, 0.15], [-0.25, 1.8, -0.15]],
    [[0.25, 0, 0.15], [0.25, 0, -0.15], [0.25, 1.8, -0.15], [0.25, 1.8, 0.15]],
    [[-0.25, 0, -0.15], [0.25, 0, -0.15], [0.25, 0, 0.15], [-0.25, 0, 0.15]],
    [[-0.25, 1.8, 0.15], [0.25, 1.8, 0.15], [0.25, 1.8, -0.15], [-0.25, 1.8, -0.15]]
  ];
  const positions = [];
  const texCoords = [];
  const indices = [];
  for (const face of faces) {
    const base = positions.length / 3;
    positions.push(...face.flat());
    texCoords.push(0, 0, 1, 0, 1, 1, 0, 1);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  const positionAccessor = document.createAccessor("Mock box positions")
    .setType("VEC3")
    .setArray(new Float32Array(positions))
    .setBuffer(buffer);
  const texCoordAccessor = document.createAccessor("Mock box texture coordinates")
    .setType("VEC2")
    .setArray(new Float32Array(texCoords))
    .setBuffer(buffer);
  const indexAccessor = document.createAccessor("Mock box indices")
    .setType("SCALAR")
    .setArray(new Uint16Array(indices))
    .setBuffer(buffer);
  const texture = document.createTexture("Mock kit texture")
    .setImage(MOCK_PNG)
    .setMimeType("image/png");
  const material = document.createMaterial("Mock kit")
    .setBaseColorTexture(texture)
    .setRoughnessFactor(0.8);
  const primitive = document.createPrimitive()
    .setAttribute("POSITION", positionAccessor)
    .setAttribute("TEXCOORD_0", texCoordAccessor)
    .setIndices(indexAccessor)
    .setMaterial(material);
  const mesh = document.createMesh("Mock athlete").addPrimitive(primitive);
  document.createScene("Mock scene").addChild(document.createNode("Mock athlete").setMesh(mesh));
  return Buffer.from(await new NodeIO().writeBinary(document));
}

const MOCK_GLB = process.env.MOCK_MESHY_GLB
  ? fs.readFileSync(path.resolve(process.env.MOCK_MESHY_GLB))
  : await createMockGlb();

function redactDataUris(values) {
  return Array.isArray(values) ? values.map((value) => {
    if (typeof value !== "string") return value;
    const match = value.match(/^data:([^;,]+);base64,([\s\S]*)$/);
    return match ? `data:${match[1]};base64,<${match[2].length} chars>` : value;
  }) : values;
}

http.createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const url = new URL(req.url, "http://mock");
  const send = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  const readyControl = url.pathname.match(/^\/__mock\/accounts\/([^/]+)\/ready$/);
  if (req.method === "POST" && readyControl) {
    const account = accounts.get(decodeURIComponent(readyControl[1]));
    if (!account) return send(404, { error: "mock: unknown account" });
    account.charges_enabled = true;
    account.payouts_enabled = true;
    account.details_submitted = true;
    account.capabilities.card_payments = "active";
    account.capabilities.transfers = "active";
    account.requirements.currently_due = [];
    account.requirements.disabled_reason = null;
    return send(200, account);
  }
  const body = (req.headers["content-type"] || "").includes("json") ? JSON.parse(raw || "{}") : Object.fromEntries(new URLSearchParams(raw));
  const logBody = req.method === "POST" && url.pathname === "/openapi/v1/image-to-image"
    ? { ...body, reference_image_urls: redactDataUris(body.reference_image_urls) }
    : req.method === "POST" && url.pathname === "/openapi/v1/multi-image-to-3d"
      ? { ...body, image_urls: redactDataUris(body.image_urls) }
      : body;
  fs.appendFileSync(LOG, JSON.stringify({
    at: new Date().toISOString(),
    method: req.method,
    path: url.pathname,
    idempotency: req.headers["idempotency-key"] || null,
    stripeAccount: req.headers["stripe-account"] || null,
    body: logBody
  }) + "\n");
  n += 1;
  if (req.method === "POST" && url.pathname === "/__mock/meshy/fail-next") {
    failNextMeshy = true;
    return send(200, { ok: true });
  }
  if (req.method === "POST" && url.pathname === "/__mock/meshy/error-next-poll") {
    failNextMeshyPoll = true;
    return send(200, { ok: true });
  }
  if (req.method === "POST" && url.pathname === "/openapi/v1/image-to-image") {
    if (!/^Bearer \S+$/.test(req.headers.authorization || "")) {
      return send(401, { message: "Mock Meshy requires a bearer token." });
    }
    meshTaskCounter += 1;
    const id = `mesh_mock_${meshTaskCounter}`;
    meshTasks.set(id, { polls: 0, fail: failNextMeshy, type: "image" });
    failNextMeshy = false;
    return send(200, { result: id });
  }
  if (req.method === "POST" && url.pathname === "/openapi/v1/multi-image-to-3d") {
    if (!/^Bearer \S+$/.test(req.headers.authorization || "")) {
      return send(401, { message: "Mock Meshy requires a bearer token." });
    }
    meshTaskCounter += 1;
    const id = `mesh3d_mock_${meshTaskCounter}`;
    meshTasks.set(id, { polls: 0, fail: failNextMeshy, type: "model" });
    failNextMeshy = false;
    return send(200, { result: id });
  }
  const meshTaskMatch = url.pathname.match(/^\/openapi\/v1\/image-to-image\/([^/]+)$/);
  if (req.method === "GET" && meshTaskMatch) {
    if (!/^Bearer \S+$/.test(req.headers.authorization || "")) {
      return send(401, { message: "Mock Meshy requires a bearer token." });
    }
    const id = decodeURIComponent(meshTaskMatch[1]);
    const task = meshTasks.get(id);
    if (!task || task.type !== "image") return send(404, { message: "Mock Meshy task not found." });
    if (failNextMeshyPoll) {
      failNextMeshyPoll = false;
      return send(500, { message: "Mock transient Meshy poll error." });
    }
    task.polls += 1;
    if (task.fail) {
      return send(200, { status: "FAILED", progress: 100, task_error: { message: "Mock failure" } });
    }
    if (task.polls === 1) return send(200, { status: "PENDING", progress: 0 });
    if (task.polls === 2) return send(200, { status: "IN_PROGRESS", progress: 50 });
    return send(200, {
      status: "SUCCEEDED",
      progress: 100,
      image_urls: [`http://127.0.0.1:${PORT}/__mock/meshy/assets/${encodeURIComponent(id)}.png`]
    });
  }
  const multiImageTaskMatch = url.pathname.match(/^\/openapi\/v1\/multi-image-to-3d\/([^/]+)$/);
  if (req.method === "GET" && multiImageTaskMatch) {
    if (!/^Bearer \S+$/.test(req.headers.authorization || "")) {
      return send(401, { message: "Mock Meshy requires a bearer token." });
    }
    const id = decodeURIComponent(multiImageTaskMatch[1]);
    const task = meshTasks.get(id);
    if (!task || task.type !== "model") return send(404, { message: "Mock Meshy task not found." });
    if (failNextMeshyPoll) {
      failNextMeshyPoll = false;
      return send(500, { message: "Mock transient Meshy poll error." });
    }
    task.polls += 1;
    if (task.fail) {
      return send(200, { status: "FAILED", progress: 100, task_error: { message: "Mock failure" } });
    }
    if (task.polls === 1) return send(200, { status: "PENDING", progress: 0 });
    if (task.polls === 2) return send(200, { status: "IN_PROGRESS", progress: 40 });
    if (task.polls === 3) return send(200, { status: "IN_PROGRESS", progress: 80 });
    return send(200, {
      status: "SUCCEEDED",
      progress: 100,
      model_urls: {
        glb: `http://127.0.0.1:${PORT}/__mock/meshy/assets/${encodeURIComponent(id)}.glb`
      },
      thumbnail_url: `http://127.0.0.1:${PORT}/__mock/meshy/assets/${encodeURIComponent(id)}.png`,
      consumed_credits: 0
    });
  }
  const meshAssetMatch = url.pathname.match(/^\/__mock\/meshy\/assets\/([^/]+)\.png$/);
  if (req.method === "GET" && meshAssetMatch) {
    res.writeHead(200, {
      "content-type": "image/png",
      "content-length": MOCK_PNG.length
    });
    return res.end(MOCK_PNG);
  }
  const meshModelMatch = url.pathname.match(/^\/__mock\/meshy\/assets\/([^/]+)\.glb$/);
  if (req.method === "GET" && meshModelMatch) {
    res.writeHead(200, {
      "content-type": "model/gltf-binary",
      "content-length": MOCK_GLB.length
    });
    return res.end(MOCK_GLB);
  }
  // Resend
  if (url.pathname === "/emails") return send(200, { id: `email_${n}` });
  // Stripe
  if (req.method === "POST" && url.pathname === "/v1/accounts") {
    const account = {
      id: `acct_mock_${n}`,
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: false,
      capabilities: { card_payments: "inactive", transfers: "inactive" },
      requirements: { currently_due: ["external_account"], disabled_reason: "requirements.past_due" }
    };
    accounts.set(account.id, account);
    return send(200, account);
  }
  const accountMatch = url.pathname.match(/^\/v1\/accounts\/([^/]+)$/);
  if (req.method === "GET" && accountMatch) {
    const account = accounts.get(decodeURIComponent(accountMatch[1]));
    return account ? send(200, account) : send(404, { error: { message: "mock: unknown account" } });
  }
  if (req.method === "POST" && url.pathname === "/v1/account_links") {
    return send(200, { url: `https://connect.stripe.com/setup/mock/${n}`, expires_at: Math.floor(Date.now() / 1000) + 3600 });
  }
  if (url.pathname === "/v1/customers/search") return send(200, { data: [] });
  if (url.pathname === "/v1/customers") return send(200, { id: `cus_${n}`, email: body.email });
  if (url.pathname === "/v1/invoices") return FAIL_INVOICE ? send(400, { error: { message: "Mock failure: invoice creation disabled" } }) : send(200, { id: `in_${n}`, status: "draft" });
  if (url.pathname === "/v1/invoiceitems") return send(200, { id: `ii_${n}` });
  const finalize = url.pathname.match(/^\/v1\/invoices\/(in_\d+)\/finalize$/);
  if (finalize) return send(200, { id: finalize[1], number: `MOCK-${String(n).padStart(4, "0")}`, status: "open", hosted_invoice_url: `https://invoice.stripe.com/i/mock/${finalize[1]}`, invoice_pdf: `https://pay.stripe.com/invoice/mock/${finalize[1]}/pdf` });
  send(404, { error: { message: `mock: unknown ${req.method} ${url.pathname}` } });
}).listen(PORT, () => console.log(`mock Stripe + Resend + Meshy listening on :${PORT} — log: ${LOG}`));
