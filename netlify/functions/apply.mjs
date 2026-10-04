import { createHash, randomBytes } from "node:crypto";
import { getStore } from "@netlify/blobs";
import { sameOrigin } from "../lib/dashboard-auth.mjs";
import { EMAIL_PATTERN } from "../lib/validate.mjs";

const MAX_BODY_BYTES = 16 * 1024;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT = 5;
const SPORTS = new Set(["Bare knuckle", "MMA", "Boxing", "Muay Thai / kickboxing", "Jiu-jitsu / grappling", "Other"]);
const RATE_LIMIT_ERROR = "Too many applications from this connection. Please email sponsors@michaelheckert.com instead.";
const rateQueues = new Map();

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" }
});
const applicationsStore = () => getStore({ name: "applications", consistency: "strong" });
const field = (body, name) => (typeof body[name] === "string" ? body[name].trim() : "");

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

function validateApplication(body) {
  const name = field(body, "name");
  if (!name) return { error: "Name is required." };
  if (name.length > 120) return { error: "Name must be 120 characters or fewer." };

  const email = field(body, "email");
  if (!email) return { error: "Email is required." };
  if (email.length > 200) return { error: "Email must be 200 characters or fewer." };
  if (!EMAIL_PATTERN.test(email)) return { error: "Enter a valid email address." };

  const social = field(body, "social");
  if (!social) return { error: "Social handle is required." };
  if (social.length > 120) return { error: "Social handle must be 120 characters or fewer." };

  const sport = field(body, "sport");
  if (!sport) return { error: "Sport is required." };
  if (!SPORTS.has(sport)) return { error: "Select a valid sport." };

  const phone = field(body, "phone");
  if (phone.length > 40) return { error: "Phone must be 40 characters or fewer." };

  const promotion = field(body, "promotion");
  if (promotion.length > 120) return { error: "Promotion or team must be 120 characters or fewer." };

  const event = field(body, "event");
  if (event.length > 160) return { error: "Event must be 160 characters or fewer." };

  const eventDate = field(body, "eventDate");
  if (eventDate) {
    const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(eventDate)
      ? new Date(`${eventDate}T00:00:00.000Z`)
      : null;
    if (!parsedDate || !Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== eventDate) {
      return { error: "Event date must be a real date in YYYY-MM-DD format." };
    }
  }

  const message = field(body, "message");
  if (message.length > 2000) return { error: "Message must be 2000 characters or fewer." };

  const ref = field(body, "ref");
  return {
    application: {
      name,
      email: email.toLowerCase(),
      phone,
      social,
      sport,
      promotion,
      event,
      eventDate,
      message,
      ...( /^[A-Za-z0-9_-]{1,40}$/.test(ref) ? { ref } : {})
    }
  };
}

async function allowApplication(ip) {
  const digest = createHash("sha256").update(ip).digest("hex");
  const key = `rate/${digest}`;
  const previous = rateQueues.get(key) || Promise.resolve();
  const current = previous.then(async () => {
    const store = applicationsStore();
    const now = Date.now();
    const existing = await store.get(key, { type: "json" });
    const recent = Array.isArray(existing)
      ? existing.filter((timestamp) => Number.isFinite(timestamp) && timestamp > now - RATE_WINDOW_MS)
      : [];
    if (recent.length >= RATE_LIMIT) return false;
    recent.push(now);
    await store.setJSON(key, recent);
    return true;
  });
  const queued = current.catch(() => {});
  rateQueues.set(key, queued);
  queued.then(() => {
    if (rateQueues.get(key) === queued) rateQueues.delete(key);
  });
  return current;
}

function notification(record) {
  const fields = [
    ["Name", record.name],
    ["Email", record.email],
    ["Phone", record.phone],
    ["Social", record.social],
    ["Sport", record.sport],
    ["Promotion or team", record.promotion],
    ["Event", record.event],
    ["Event date", record.eventDate],
    ["Message", record.message],
    ...(record.ref ? [["Ref", record.ref]] : [])
  ];
  const text = [`Application ID: ${record.id}`, ...fields.map(([label, value]) => `${label}: ${value || "—"}`)].join("\n");
  const html = `<p><strong>Application ID:</strong> ${escapeHtml(record.id)}</p><dl>${fields
    .map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value || "—")}</dd>`)
    .join("")}</dl>`;
  return { text, html };
}

async function emailOperator(record) {
  const operatorEmail = process.env.OPERATOR_EMAIL;
  const apiKey = process.env.RESEND_API_KEY;
  if (!operatorEmail || !apiKey) return;

  const { text, html } = notification(record);
  try {
    const response = await fetch(`${process.env.RESEND_API_BASE || "https://api.resend.com"}/emails`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: "Athlete Sponsorship Portal <sponsors@michaelheckert.com>",
        to: [operatorEmail],
        reply_to: record.email,
        subject: `Founding athlete application: ${record.name} (${record.sport})`,
        text,
        html
      })
    });
    if (!response.ok) throw new Error(`Resend returned ${response.status}`);
  } catch {
    console.error("Founding athlete application email failed", record.id);
  }
}

export default async function apply(req, context = {}) {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!sameOrigin(req)) return json({ error: "Forbidden" }, 403);

  const declaredLength = Number(req.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return json({ error: "Request body is too large." }, 413);
  }

  let raw;
  try {
    raw = await req.text();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return json({ error: "Request body is too large." }, 413);
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "Request body must be a JSON object." }, 400);
  }
  if (typeof body.website === "string" && body.website.length > 0) return json({ ok: true });

  const { application, error } = validateApplication(body);
  if (error) return json({ error }, 400);

  const ip = (typeof context.ip === "string" && context.ip.trim()) ||
    req.headers.get("x-nf-client-connection-ip")?.trim() ||
    "unknown";
  if (!(await allowApplication(ip))) return json({ error: RATE_LIMIT_ERROR }, 429);

  const receivedAt = new Date().toISOString();
  const id = `${receivedAt}-${randomBytes(4).toString("hex")}`;
  const record = { ...application, receivedAt, id };
  await applicationsStore().setJSON(`application/${id}`, record);
  await emailOperator(record);
  return json({ ok: true });
}

export const config = { path: "/api/apply" };
