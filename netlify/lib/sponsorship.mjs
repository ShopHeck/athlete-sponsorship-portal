import { getStore } from "@netlify/blobs";
import { connectForTenant } from "./connect.mjs";

const STRIPE_API = process.env.STRIPE_API_BASE || "https://api.stripe.com";
const RESEND_API = process.env.RESEND_API_BASE || "https://api.resend.com";

export const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export function forTenant(config, { portalUrl }) {
  const MIN_BID = config.pricing.minBid;
  const INCREMENT = config.pricing.increment;
  const LOCK_PRICE = config.pricing.lockPrice;
  const DEADLINE = config.pricing.deadline;
  const NOTIFY_EMAIL = config.contact.notifyEmail;
  const NOTIFY_FROM = config.contact.notifyFrom || process.env.NOTIFY_FROM;
  const EVENT_NAME = config.event.name;
  const DASHBOARD_SITE_NAME = config.copy.dashboardSiteName;
  const API_URL = new URL(portalUrl).origin;
  const placementList = config.garments.flatMap((garment) => garment.placements);
  const PLACEMENT_IDS = new Set(placementList.map((placement) => placement.id));
  const isPlacementId = (id) => PLACEMENT_IDS.has(id);
  const formatCopy = (template, values = {}) => String(template).replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_, key) => values[key] ?? "");
  const usd = (amount) => new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: config.pricing.currency.toUpperCase(),
    maximumFractionDigits: 0
  }).format(Math.round(amount));
  const describePlacement = (id) => placementList.find((placement) => placement.id === id)?.label || id;
  async function soldDetails() {
    const details = new Map();
    for (const [id, entry] of Object.entries(config.sold || {})) {
      const sponsor = typeof entry === "string" ? entry : entry?.sponsor;
      const soldEntry = entry && typeof entry === "object" ? entry : {};
      details.set(id, {
        sponsor: sponsor || "",
        amount: soldEntry.amount ?? null,
        note: soldEntry.note || "",
        at: soldEntry.at || null,
        source: "config",
        ...(soldEntry.logo ? { logo: soldEntry.logo } : {})
      });
    }

    const store = getStore({ name: "sold", consistency: "strong" });
    const prefix = `${config.slug}/`;
    const { blobs } = await store.list({ prefix });
    for (const { key } of blobs) {
      const id = key.slice(prefix.length);
      const record = await store.get(key, { type: "json" });
      if (!record || record.releasedAt || details.has(id)) continue;
      details.set(id, {
        sponsor: record.sponsor || "",
        amount: record.amount ?? null,
        note: record.note || "",
        at: record.at || null,
        source: "dashboard",
        ...(record.logo ? {
          logo: `/api/${config.slug}/sponsor-logos/${id}?v=${encodeURIComponent(record.logo.at || record.at || "")}`
        } : {})
      });
    }
    return details;
  }

  const soldPlacements = async () => new Set((await soldDetails()).keys());

  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[char]));

  async function sendEmail({ to, subject, text, html, replyTo }) {
    const key = process.env.RESEND_API_KEY;
    if (!key) return { skipped: true };
    const res = await fetch(`${RESEND_API}/emails`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: NOTIFY_FROM,
        to: Array.isArray(to) ? to : [to],
        ...(replyTo ? { reply_to: replyTo } : {}),
        subject,
        text,
        ...(html ? { html } : {})
      })
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
    return res.json();
  }

  async function tryEmail(opts) {
    try {
      return await sendEmail(opts);
    } catch (err) {
      console.error("email failed", opts.subject, err);
      return { error: String(err) };
    }
  }

  function notifyOwner(subject, lines) {
    return tryEmail({ to: NOTIFY_EMAIL, subject: `[Sponsorship] ${subject}`, text: lines.filter(Boolean).join("\n") });
  }

  function layout({ heading, intro, rows, cta, outro }) {
    const rowsHtml = rows.map(([key, value]) => `<tr><td style="padding:6px 12px 6px 0;color:#9a9a9a;white-space:nowrap">${escapeHtml(key)}</td><td style="padding:6px 0;color:#fff;font-weight:600">${escapeHtml(value)}</td></tr>`).join("");
    const ctaHtml = cta ? `<p style="margin:28px 0"><a href="${cta.href}" style="display:inline-block;background:${config.brand.accent};color:#000;font-weight:700;text-decoration:none;padding:14px 26px;border-radius:8px;font-size:16px">${escapeHtml(cta.label)}</a></p><p style="margin:0 0 20px;color:#9a9a9a;font-size:13px">${config.copy.emailOpenLink} <a href="${cta.href}" style="color:${config.brand.accent}">${cta.href}</a></p>` : "";
    return `<!doctype html><html><body style="margin:0;background:#0a0a0a;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#e8e8e8">
<div style="max-width:560px;margin:0 auto;padding:36px 24px">
  <p style="margin:0 0 6px;letter-spacing:.18em;font-size:12px;color:${config.brand.accent};font-weight:700">${escapeHtml(config.athlete.fullDisplay)} · ${escapeHtml(EVENT_NAME.toUpperCase())}</p>
  <h1 style="margin:0 0 18px;font-size:26px;line-height:1.2;color:#fff">${escapeHtml(heading)}</h1>
  <p style="margin:0 0 20px;font-size:16px;line-height:1.55">${intro}</p>
  <table style="border-collapse:collapse;font-size:15px;margin:0 0 8px">${rowsHtml}</table>
  ${ctaHtml}
  <p style="margin:0 0 20px;font-size:15px;line-height:1.55;color:#c8c8c8">${outro}</p>
  <p style="margin:0;font-size:13px;color:#777">${config.copy.emailQuestions} <a href="mailto:${NOTIFY_EMAIL}" style="color:${config.brand.accent}">${NOTIFY_EMAIL}</a>.<br>Portal: <a href="${portalUrl}" style="color:${config.brand.accent}">${portalUrl}</a></p>
</div></body></html>`;
  }

  const textBlock = (heading, intro, rows, cta, outro) =>
    [heading, "", intro, "", ...rows.map(([key, value]) => `${key}: ${value}`), "", cta ? `${cta.label}: ${cta.href}` : "", cta ? "" : null, outro, "", `${config.copy.emailQuestions} ${NOTIFY_EMAIL}.`, `Portal: ${portalUrl}`].filter((line) => line !== null).join("\n");

  const placementLink = (id) => {
    const base = config.publicUrl || portalUrl;
    return new URL(`#${id}`, base.endsWith("/") ? base : `${base}/`).href;
  };

  function formatDeadline() {
    return new Date(DEADLINE).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: config.event.timeZone,
      timeZoneName: "short"
    });
  }

  function bidConfirmationEmail(id, rec) {
    const bidder = rec.bidder;
    const rows = [
      [config.copy.placementLabel, `${id} — ${describePlacement(id)}`],
      [config.copy.yourBid, usd(rec.high)],
      [config.copy.companyLabel, bidder.company],
      [config.copy.biddingCloses, formatDeadline()]
    ];
    const intro = formatCopy(config.copy.bidReceiptIntro, { name: escapeHtml(bidder.name) });
    const outro = formatCopy(config.copy.bidReceiptOutro, { price: usd(LOCK_PRICE) });
    const cta = { href: placementLink(id), label: config.copy.emailViewPlacement };
    return {
      to: bidder.email,
      replyTo: NOTIFY_EMAIL,
      subject: formatCopy(config.copy.emailBidSubject, { id, amount: usd(rec.high) }),
      html: layout({ heading: config.copy.emailBidReceivedHeading, intro, rows, cta, outro }),
      text: textBlock(config.copy.emailBidReceivedHeading, intro.replace(/<[^>]+>/g, ""), rows, cta, outro)
    };
  }

  function outbidEmail(id, rec, previous) {
    const rows = [
      [config.copy.placementLabel, `${id} — ${describePlacement(id)}`],
      [config.copy.yourBid, usd(previous.amount)],
      [config.copy.newHighBid, usd(rec.high)],
      [config.copy.nextMinimum, usd(rec.high + INCREMENT)],
      [config.copy.biddingCloses, formatDeadline()]
    ];
    const intro = formatCopy(config.copy.outbidIntro, { name: escapeHtml(previous.name) });
    const outro = formatCopy(config.copy.outbidOutro, { price: usd(LOCK_PRICE) });
    const cta = { href: placementLink(id), label: config.copy.emailBidAgain };
    const heading = config.copy.emailOutbidHeading;
    return {
      to: previous.email,
      replyTo: NOTIFY_EMAIL,
      subject: formatCopy(config.copy.emailOutbidSubject, { id }),
      html: layout({ heading, intro, rows, cta, outro }),
      text: textBlock(heading, intro.replace(/<[^>]+>/g, ""), rows, cta, outro)
    };
  }

  function invoiceEmail(id, rec, kind) {
    const bidder = rec.bidder;
    const invoice = rec.invoice;
    const locked = kind === "lock";
    const rows = [
      [config.copy.placementLabel, `${id} — ${describePlacement(id)}`],
      [config.copy.amountDue, usd(invoice.amount)],
      [config.copy.invoiceLabel, invoice.number || invoice.id],
      [config.copy.companyLabel, bidder.company],
      [config.copy.termsLabel, config.copy.dueOnReceipt]
    ];
    const heading = locked ? config.copy.invoiceLockedHeading : config.copy.invoiceWonHeading;
    const intro = formatCopy(locked ? config.copy.invoiceLockedIntro : config.copy.invoiceWonIntro, {
      name: escapeHtml(bidder.name),
      id: escapeHtml(id),
      company: escapeHtml(bidder.company),
      amount: usd(invoice.amount)
    });
    const outro = config.copy.emailOutro;
    const cta = { href: invoice.url, label: formatCopy(config.copy.emailInvoiceButton, { amount: usd(invoice.amount) }) };
    const subject = formatCopy(locked ? config.copy.emailInvoiceLockedSubject : config.copy.emailInvoiceWonSubject, { id, amount: usd(invoice.amount) });
    return {
      to: bidder.email,
      replyTo: NOTIFY_EMAIL,
      subject,
      html: layout({ heading, intro, rows, cta, outro }),
      text: textBlock(heading, intro.replace(/<[^>]+>/g, ""), rows, cta, outro)
    };
  }

  const encodeForm = (object, prefix = "") => Object.entries(object).flatMap(([key, value]) => {
    if (value == null) return [];
    const formKey = prefix ? `${prefix}[${key}]` : key;
    return typeof value === "object" ? encodeForm(value, formKey) : [[formKey, String(value)]];
  });

  async function stripe(method, pathname, params, idempotencyKey, { stripeAccount } = {}) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
    const headers = { authorization: `Bearer ${key}` };
    if (stripeAccount) headers["stripe-account"] = stripeAccount;
    let url = `${STRIPE_API}/v1/${pathname}`;
    const init = { method, headers };
    if (method === "GET") {
      if (params) url += `?${new URLSearchParams(encodeForm(params))}`;
    } else {
      headers["content-type"] = "application/x-www-form-urlencoded";
      if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
      init.body = new URLSearchParams(encodeForm(params || {}));
    }
    const res = await fetch(url, init);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message || `Stripe ${method} ${pathname} failed (${res.status})`);
    return data;
  }

  const stripeEnabled = () => Boolean(process.env.STRIPE_SECRET_KEY);
  const connect = connectForTenant(config, { stripe, portalUrl });

  async function findOrCreateCustomer(bidder, id, stripeAccount) {
    const email = bidder.email.replace(/'/g, "\\'");
    const query = `email:'${email}' AND metadata['tenant']:'${config.slug}'`;
    const options = stripeAccount ? { stripeAccount } : undefined;
    const found = await stripe("GET", "customers/search", { query, limit: 1 }, undefined, options).catch(() => null);
    if (found?.data?.length) return found.data[0];
    return stripe("POST", "customers", {
      name: bidder.company,
      email: bidder.email,
      phone: bidder.phone || undefined,
      description: `Sponsor contact: ${bidder.name}`,
      metadata: {
        contact_name: bidder.name,
        tenant: config.slug,
        source: "athlete-sponsorship-portal",
        first_placement: id
      }
    }, `${config.slug}-cust-${id}-${bidder.email}`, options);
  }

  async function createInvoice({ id, amount, bidder, kind, at, connectAccountId }) {
    if (config.payments.mode === "connect" && !connectAccountId) {
      const readiness = await connect.readiness();
      if (!readiness.ready) throw new Error("Connected account not ready for payouts");
      connectAccountId = readiness.accountId;
    }
    const stripeAccount = config.payments.mode === "connect" ? connectAccountId : undefined;
    const stripeOptions = stripeAccount ? { stripeAccount } : undefined;
    const customer = await findOrCreateCustomer(bidder, id, stripeAccount);
    const label = describePlacement(id);
    const seed = `${config.slug}-${id}-${kind}-${amount}-${bidder.email}-${at}`.replace(/[^a-zA-Z0-9@.\-_]/g, "_").slice(0, 255);
    const tenantMetadata = { tenant: config.slug, source: "athlete-sponsorship-portal" };
    const invoiceMetadata = {
      placement: id,
      placement_label: label,
      kind,
      contact_name: bidder.name,
      contact_email: bidder.email,
      company: bidder.company,
      portal: portalUrl,
      ...tenantMetadata,
      ...(stripeAccount ? {
        connected_account: stripeAccount,
        platform_fee_percent: String(config.payments.feePercent)
      } : {})
    };
    const draft = await stripe("POST", "invoices", {
      customer: customer.id,
      collection_method: "send_invoice",
      days_until_due: 0,
      auto_advance: false,
      pending_invoice_items_behavior: "exclude",
      description: formatCopy(config.copy.invoiceDescription, {
        event: EVENT_NAME,
        id,
        label,
        action: kind === "lock" ? config.copy.invoiceLockAction : config.copy.invoiceWinningAction,
        source: config.copy.invoiceSource
      }),
      footer: config.copy.invoiceFooter,
      metadata: invoiceMetadata,
      ...(stripeAccount ? {
        application_fee_amount: connect.feeAmount(Math.round(amount * 100))
      } : {})
    }, `${seed}-inv`, stripeOptions);
    await stripe("POST", "invoiceitems", {
      customer: customer.id,
      invoice: draft.id,
      amount: Math.round(amount * 100),
      currency: config.pricing.currency,
      description: formatCopy(config.copy.invoiceItemDescription, {
        event: EVENT_NAME,
        id,
        label,
        action: kind === "lock" ? config.copy.invoiceItemLockAction : config.copy.invoiceItemWinningAction
      }),
      metadata: { placement: id, ...tenantMetadata }
    }, `${seed}-item`, stripeOptions);
    const invoice = await stripe("POST", `invoices/${draft.id}/finalize`, { auto_advance: false }, `${seed}-fin`, stripeOptions);
    return {
      id: invoice.id,
      number: invoice.number,
      url: invoice.hosted_invoice_url,
      pdf: invoice.invoice_pdf,
      amount,
      customer: customer.id,
      kind,
      status: "sent",
      at: new Date().toISOString()
    };
  }

  async function invoicePlacement(store, id, rec, kind) {
    const storageKey = `${config.slug}/${id}`;
    if (rec.invoice?.status === "sent") return rec;
    let connectReadiness;
    if (config.payments.mode === "connect") {
      try {
        connectReadiness = await connect.readiness();
      } catch (err) {
        console.error("Connect readiness check failed", config.slug, err);
        connectReadiness = { ready: false };
      }
      if (!connectReadiness.ready) {
        const bidder = rec.bidder;
        rec.invoice = {
          status: "failed",
          error: "Connected account not ready for payouts",
          kind,
          at: new Date().toISOString(),
          attempts: (rec.invoice?.attempts || 0) + 1
        };
        await store.setJSON(storageKey, rec);
        await notifyOwner(`${id} · invoice NOT created · ${bidder.company}`, [
          `Placement: ${id} — ${describePlacement(id)}`,
          `Action: ${kind === "lock" ? "LOCKED" : "WON"} for ${usd(rec.high)}`,
          `Company: ${bidder.company}`,
          `Contact: ${bidder.name} <${bidder.email}>`,
          "",
          "Connected account not ready for payouts. No invoice was created; the close-auction job will retry."
        ]);
        return rec;
      }
    }
    if (!stripeEnabled()) {
      rec.invoice = { status: "skipped", reason: "STRIPE_SECRET_KEY not set", kind, at: new Date().toISOString() };
      await store.setJSON(storageKey, rec);
      await notifyOwner(`${id} · ${kind === "lock" ? "LOCKED" : "WON"} for ${usd(rec.high)} · invoice NOT created`, [
        `Placement: ${id} — ${describePlacement(id)}`,
        `Company: ${rec.bidder.company}`,
        `Contact: ${rec.bidder.name} <${rec.bidder.email}>`,
        `Phone: ${rec.bidder.phone || "-"}`,
        "",
        "STRIPE_SECRET_KEY is not configured, so no invoice was created. Invoice this sponsor manually."
      ]);
      return rec;
    }
    const bidder = rec.bidder;
    const at = rec.lockedAt || rec.closedAt || new Date().toISOString();
    try {
      rec.invoice = await createInvoice({ id, amount: rec.high, bidder, kind, at, connectAccountId: connectReadiness?.accountId });
      await store.setJSON(storageKey, rec);
    } catch (err) {
      console.error("invoice failed", id, err);
      rec.invoice = {
        status: "failed",
        error: String(err.message || err),
        kind,
        at: new Date().toISOString(),
        attempts: (rec.invoice?.attempts || 0) + 1
      };
      await store.setJSON(storageKey, rec);
      await notifyOwner(`${id} · invoice FAILED · ${bidder.company}`, [
        `Placement: ${id} — ${describePlacement(id)}`,
        `Action: ${kind === "lock" ? "LOCKED" : "WON"} for ${usd(rec.high)}`,
        `Company: ${bidder.company}`,
        `Contact: ${bidder.name} <${bidder.email}>`,
        `Phone: ${bidder.phone || "-"}`,
        "",
        `Stripe error: ${rec.invoice.error}`,
        "The daily close-auction job will retry. Check Stripe → Invoices."
      ]);
      return rec;
    }
    const sponsorMail = await tryEmail(invoiceEmail(id, rec, kind));
    rec.invoice.emailed = !sponsorMail.error && !sponsorMail.skipped;
    await store.setJSON(storageKey, rec);
    await notifyOwner(`${id} · ${kind === "lock" ? "LOCKED" : "WON"} for ${usd(rec.high)} · invoiced · ${bidder.company}`, [
      `Placement: ${id} — ${describePlacement(id)}`,
      `Action: ${kind === "lock" ? "Lock It Now" : "Auction closed — winning bid"}`,
      `Company: ${bidder.company}`,
      `Contact: ${bidder.name} <${bidder.email}>`,
      `Phone: ${bidder.phone || "-"}`,
      rec.logo ? `Logo: ${new URL(`/api/${config.slug}/logos/${id}`, API_URL)}` : "Logo: not uploaded — request artwork",
      "",
      `Invoice ${rec.invoice.number || rec.invoice.id}: ${usd(rec.invoice.amount)} due on receipt`,
      `Sponsor pay link: ${rec.invoice.url}`,
      `Stripe dashboard: https://dashboard.stripe.com/invoices/${rec.invoice.id}`,
      rec.invoice.emailed ? "Sponsor emailed the invoice link via Resend." : "Sponsor was NOT emailed (Resend not configured or failed) — send them the pay link above.",
      "",
      `All bids: Netlify dashboard → ${DASHBOARD_SITE_NAME} → Blobs → bids`
    ]);
    return rec;
  }

  return {
    json,
    MIN_BID,
    INCREMENT,
    LOCK_PRICE,
    DEADLINE,
    EVENT_NAME,
    NOTIFY_EMAIL,
    NOTIFY_FROM,
    PLACEMENT_IDS,
    DASHBOARD_SITE_NAME,
    isPlacementId,
    describePlacement,
    soldPlacements,
    soldDetails,
    usd,
    sendEmail,
    tryEmail,
    notifyOwner,
    bidConfirmationEmail,
    outbidEmail,
    invoiceEmail,
    placementLink,
    formatDeadline,
    connect,
    stripeEnabled,
    createInvoice,
    invoicePlacement
  };
}
