import { createHmac, timingSafeEqual } from "node:crypto";
import { getStore } from "@netlify/blobs";

export const isConnectReady = (status) => status?.chargesEnabled === true && status?.cardPayments === "active";

export function connectForTenant(config, { stripe, portalUrl }) {
  const { slug, payments } = config;
  const mode = payments.mode;
  const store = () => getStore({ name: "connect", consistency: "strong" });

  async function record() {
    return store().get(slug, { type: "json" });
  }

  function sign(accountId) {
    const token = process.env.ADMIN_TOKEN;
    if (!token) throw new Error("ADMIN_TOKEN is not configured");
    return createHmac("sha256", token).update(`connect:${slug}:${accountId}`).digest("hex");
  }

  function verify(accountId, sig) {
    const token = process.env.ADMIN_TOKEN;
    if (!token || typeof sig !== "string" || !/^[a-f0-9]{64}$/i.test(sig)) return false;
    const expected = Buffer.from(createHmac("sha256", token).update(`connect:${slug}:${accountId}`).digest("hex"), "hex");
    const actual = Buffer.from(sig, "hex");
    return actual.length === expected.length && timingSafeEqual(expected, actual);
  }

  async function ensureAccount() {
    const existing = await record();
    if (existing?.accountId) return existing;
    const params = {
      country: payments.country || "US",
      controller: {
        fees: { payer: "account" },
        losses: { payments: "stripe" },
        requirement_collection: "stripe",
        stripe_dashboard: { type: "full" }
      },
      metadata: {
        tenant: slug,
        source: "athlete-sponsorship-portal"
      }
    };
    if (new URL(portalUrl).protocol === "https:") {
      params.business_profile = { url: portalUrl };
    }
    const account = await stripe("POST", "accounts", params, `${slug}-connect-account-direct-no-card-payments`);
    const created = { accountId: account.id, createdAt: new Date().toISOString() };
    await store().setJSON(slug, created);
    return created;
  }

  async function onboardingLink() {
    const { accountId } = await ensureAccount();
    const origin = new URL(portalUrl).origin;
    const sig = sign(accountId);
    const link = await stripe("POST", "account_links", {
      account: accountId,
      refresh_url: `${origin}/api/${slug}/connect/refresh?sig=${sig}`,
      return_url: `${origin}/api/${slug}/connect/return?sig=${sig}`,
      type: "account_onboarding"
    });
    return { url: link.url, expiresAt: link.expires_at, accountId };
  }

  async function refreshStatus() {
    const existing = await record();
    if (!existing?.accountId) return null;
    const account = await stripe("GET", `accounts/${encodeURIComponent(existing.accountId)}`);
    const status = {
      chargesEnabled: account.charges_enabled === true,
      payoutsEnabled: account.payouts_enabled === true,
      detailsSubmitted: account.details_submitted === true,
      cardPayments: account.capabilities?.card_payments || null,
      currentlyDue: account.requirements?.currently_due || [],
      disabledReason: account.requirements?.disabled_reason || null
    };
    const updated = { ...existing, status, checkedAt: new Date().toISOString() };
    await store().setJSON(slug, updated);
    return updated;
  }

  async function readiness({ maxAgeMs = 60_000 } = {}) {
    if (mode === "platform") return { mode, ready: true };
    if (!process.env.STRIPE_SECRET_KEY) {
      return { mode, ready: false, accountId: null, status: null };
    }
    let current;
    try {
      current = await record();
      if (!current?.accountId) return { mode, ready: false, accountId: null, status: null };
      if (isConnectReady(current.status)) {
        return { mode, ready: true, accountId: current.accountId, status: current.status };
      }
      const checkedAt = Date.parse(current.checkedAt || "");
      if (!current.status || !Number.isFinite(checkedAt) || Date.now() - checkedAt > maxAgeMs) {
        const updated = await refreshStatus();
        return {
          mode,
          ready: isConnectReady(updated?.status),
          accountId: updated?.accountId || current.accountId,
          status: updated?.status || null
        };
      }
      return { mode, ready: false, accountId: current.accountId, status: current.status || null };
    } catch (err) {
      console.error("Connect status refresh failed", slug, err);
      return { mode, ready: false, accountId: current?.accountId || null, status: current?.status || null };
    }
  }

  const feeAmount = (cents) => mode === "connect" ? Math.round(cents * payments.feePercent / 100) : 0;
  return { mode, feeAmount, record, ensureAccount, onboardingLink, refreshStatus, readiness, sign, verify };
}
