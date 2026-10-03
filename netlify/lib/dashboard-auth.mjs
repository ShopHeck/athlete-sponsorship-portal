import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getStore } from "@netlify/blobs";

export const SESSION_COOKIE = "asp_dash";
export const ADMIN_SESSION_COOKIE = "asp_admin";

const SESSION_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const ADMIN_SESSION_AGE_MS = 12 * 60 * 60 * 1000;
const LOGIN_TOKEN_AGE_MS = 15 * 60 * 1000;
const LOGIN_RATE_WINDOW_MS = 60 * 60 * 1000;
const LOGIN_RATE_LIMIT = 5;
const store = () => getStore({ name: "dashboard-logins", consistency: "strong" });
const rateQueues = new Map();
const tokenQueues = new Map();

function secureCookie(req) {
  return new URL(req.url).protocol === "https:" ? "; Secure" : "";
}

function sign(payload) {
  const secret = process.env.DASHBOARD_SECRET;
  if (!secret) throw new Error("DASHBOARD_SECRET is not configured.");
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function readSession(req) {
  try {
    if (!process.env.DASHBOARD_SECRET) return null;
    const cookie = req.headers.get("cookie") || "";
    const value = cookie.split(";").map((part) => part.trim())
      .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
      ?.slice(SESSION_COOKIE.length + 1);
    if (!value) return null;

    const separator = value.lastIndexOf(".");
    if (separator < 1) return null;
    const payload = value.slice(0, separator);
    const signature = value.slice(separator + 1);
    if (!/^[a-f0-9]{64}$/i.test(signature)) return null;
    const expected = Buffer.from(sign(payload), "hex");
    const actual = Buffer.from(signature, "hex");
    if (actual.length !== expected.length || !timingSafeEqual(expected, actual)) return null;

    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof session.slug !== "string" || typeof session.email !== "string" ||
        !Number.isFinite(session.exp) || session.exp <= Date.now()) return null;
    return { slug: session.slug, email: session.email, exp: session.exp };
  } catch {
    return null;
  }
}

export function sessionFor(req, slug) {
  const session = readSession(req);
  return session?.slug === slug ? session : null;
}

export function sessionCookie(slug, email, req) {
  const payload = Buffer.from(JSON.stringify({
    slug,
    email,
    exp: Date.now() + SESSION_AGE_MS
  })).toString("base64url");
  return `${SESSION_COOKIE}=${payload}.${sign(payload)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${secureCookie(req)}`;
}

export function clearSessionCookie(req) {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureCookie(req)}`;
}

export function readAdminSession(req) {
  try {
    if (!process.env.DASHBOARD_SECRET) return null;
    const cookie = req.headers.get("cookie") || "";
    const value = cookie.split(";").map((part) => part.trim())
      .find((part) => part.startsWith(`${ADMIN_SESSION_COOKIE}=`))
      ?.slice(ADMIN_SESSION_COOKIE.length + 1);
    if (!value) return null;

    const separator = value.lastIndexOf(".");
    if (separator < 1) return null;
    const payload = value.slice(0, separator);
    const signature = value.slice(separator + 1);
    if (!/^[a-f0-9]{64}$/i.test(signature)) return null;
    const expected = Buffer.from(sign(payload), "hex");
    const actual = Buffer.from(signature, "hex");
    if (actual.length !== expected.length || !timingSafeEqual(expected, actual)) return null;

    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (session.role !== "admin" || !Number.isFinite(session.exp) || session.exp <= Date.now()) return null;
    return { role: "admin", exp: session.exp };
  } catch {
    return null;
  }
}

export function adminSessionCookie(req) {
  const payload = Buffer.from(JSON.stringify({
    role: "admin",
    exp: Date.now() + ADMIN_SESSION_AGE_MS
  })).toString("base64url");
  return `${ADMIN_SESSION_COOKIE}=${payload}.${sign(payload)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secureCookie(req)}`;
}

export function clearAdminCookie(req) {
  return `${ADMIN_SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookie(req)}`;
}

export function sameOrigin(req) {
  try {
    const origin = req.headers.get("origin");
    if (!origin) return false;
    const allowed = new Set([new URL(req.url).origin]);
    if (process.env.PLATFORM_URL) allowed.add(new URL(process.env.PLATFORM_URL).origin);
    return allowed.has(origin);
  } catch {
    return false;
  }
}

export function dashboardEmailsFor(tenant) {
  const emails = [tenant.contact?.notifyEmail, ...(tenant.contact?.dashboardEmails || [])];
  return [...new Set(emails
    .filter((email) => typeof email === "string")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean))];
}

export async function createLoginToken(slug, email) {
  const nonce = randomBytes(32).toString("hex");
  const exp = Date.now() + LOGIN_TOKEN_AGE_MS;
  await store().setJSON(`token/${nonce}`, { slug, email, exp });
  return { nonce, exp };
}

export async function consumeLoginToken(nonce) {
  if (typeof nonce !== "string" || !/^[a-f0-9]{64}$/.test(nonce)) return null;
  const previous = tokenQueues.get(nonce) || Promise.resolve();
  const current = previous.then(async () => {
    const loginStore = store();
    const key = `token/${nonce}`;
    const record = await loginStore.get(key, { type: "json" });
    if (!record || Object.hasOwn(record, "usedAt") || !Number.isFinite(record.exp) || record.exp <= Date.now() ||
        typeof record.slug !== "string" || typeof record.email !== "string") return null;
    record.usedAt = Date.now();
    await loginStore.setJSON(key, record);
    return { slug: record.slug, email: record.email };
  });
  const queued = current.catch(() => {});
  tokenQueues.set(nonce, queued);
  queued.then(() => {
    if (tokenQueues.get(nonce) === queued) tokenQueues.delete(nonce);
  });
  return current;
}

export async function allowLoginEmail(email) {
  const digest = createHash("sha256").update(email).digest("hex");
  const key = `rate/${digest}`;
  const previous = rateQueues.get(key) || Promise.resolve();
  const current = previous.then(async () => {
    const loginStore = store();
    const now = Date.now();
    const existing = await loginStore.get(key, { type: "json" });
    const recent = Array.isArray(existing)
      ? existing.filter((timestamp) => Number.isFinite(timestamp) && timestamp > now - LOGIN_RATE_WINDOW_MS)
      : [];
    if (recent.length >= LOGIN_RATE_LIMIT) return false;
    recent.push(now);
    await loginStore.setJSON(key, recent);
    return true;
  });
  const queued = current.catch(() => {});
  rateQueues.set(key, queued);
  queued.then(() => {
    if (rateQueues.get(key) === queued) rateQueues.delete(key);
  });
  return current;
}
