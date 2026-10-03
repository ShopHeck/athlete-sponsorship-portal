import { getStore } from "@netlify/blobs";
import { forTenant, json } from "../lib/sponsorship.mjs";
import { getTenant, listTenants } from "../lib/tenants.mjs";
import { verifyStripeSignature } from "../lib/stripe-webhook.mjs";

const ignored = (reason) => json({ ignored: reason });

export default async function stripeWebhook(req) {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const rawBody = await req.text();
  const secrets = [process.env.STRIPE_WEBHOOK_SECRET, process.env.STRIPE_CONNECT_WEBHOOK_SECRET].filter(Boolean);
  if (!secrets.length) return json({ error: "Stripe webhook secret is not configured." }, 503);
  if (!verifyStripeSignature(rawBody, req.headers.get("stripe-signature"), secrets)) {
    return json({ error: "Invalid signature" }, 400);
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ error: "Invalid event" }, 400);
  }

  const liveKey = /_live_/.test(process.env.STRIPE_SECRET_KEY || "");
  if (event.livemode !== liveKey) return ignored("livemode");

  const platformUrl = (process.env.PLATFORM_URL || new URL(req.url).origin).replace(/\/+$/, "");
  const servicesFor = (tenant) => forTenant(tenant, { portalUrl: `${platformUrl}/${tenant.slug}` });

  if (event.type === "account.updated") {
    const account = event.data?.object;
    const accountId = event.account || account?.id;
    const tenant = await getTenant(account?.metadata?.tenant || "");
    if (!tenant || tenant.payments.mode !== "connect") return ignored("tenant");
    const services = servicesFor(tenant);
    const record = await services.connect.record();
    if (!accountId || record?.accountId !== accountId) return ignored("account");
    await services.connect.refreshStatus();
    return json({ ok: true });
  }

  if (event.type === "account.application.deauthorized") {
    const accountId = event.account;
    if (!accountId) return ignored("account");
    for (const tenant of await listTenants()) {
      if (tenant.payments.mode !== "connect") continue;
      const services = servicesFor(tenant);
      const record = await services.connect.record();
      if (record?.accountId !== accountId) continue;
      await services.connect.markDeauthorized();
      return json({ ok: true });
    }
    return ignored("account");
  }

  if (event.type === "invoice.paid") {
    const invoice = event.data?.object;
    const slug = invoice?.metadata?.tenant;
    const placement = invoice?.metadata?.placement;
    const tenant = await getTenant(slug || "");
    if (!tenant || !placement) return ignored("tenant");
    const services = servicesFor(tenant);
    if (tenant.payments.mode === "connect") {
      const record = await services.connect.record();
      if (!event.account || record?.accountId !== event.account) return ignored("account");
    } else if (tenant.payments.mode === "platform") {
      if (Object.hasOwn(event, "account")) return ignored("account");
    } else {
      return ignored("tenant");
    }

    const store = getStore({ name: "bids", consistency: "strong" });
    const key = `${slug}/${placement}`;
    const record = await store.get(key, { type: "json" });
    if (!record || record.invoice?.id !== invoice.id) return ignored("invoice");
    if (record.invoice.paidAt) return json({ ok: true });

    const paidAt = new Date((invoice.status_transitions?.paid_at || Date.now() / 1000) * 1000).toISOString();
    const amountPaid = invoice.amount_paid / 100;
    record.invoice.paidAt = paidAt;
    record.invoice.amountPaid = amountPaid;
    await store.setJSON(key, record);

    const company = record.bidder?.company || "";
    await services.notifyOwner(`${placement} · PAID ${services.usd(amountPaid)} · ${company}`, [
      `Placement: ${placement} — ${services.describePlacement(placement)}`,
      `Company: ${company}`,
      `Contact: ${record.bidder?.name || ""} <${record.bidder?.email || ""}>`,
      `Invoice: ${invoice.number || invoice.id}`,
      `Amount paid: ${services.usd(amountPaid)}`
    ]);
    return json({ ok: true });
  }

  return ignored(event.type);
}

export const config = { path: "/api/stripe/webhook" };
