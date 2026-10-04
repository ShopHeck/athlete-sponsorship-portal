const view = document.body.dataset.view;
const slug = document.body.dataset.slug;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (res.status === 401) {
    window.location.assign("/dashboard");
    throw new Error("Sign in required");
  }
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

/* ------------------------------------------------------------- sign in */
if (view === "login") {
  const form = document.getElementById("loginForm");
  const status = document.getElementById("loginStatus");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = form.email.value.trim();
    const button = form.querySelector("button");
    status.hidden = false;
    status.className = "notice";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      status.classList.add("notice-error");
      status.textContent = "Enter a valid email address.";
      return;
    }
    button.disabled = true;
    status.textContent = "Sending…";
    try {
      const res = await fetch("/api/dashboard/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email })
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || "Something went wrong.");
      status.classList.add("notice-ok");
      status.textContent = `If ${email} is registered to a portal, a sign-in link is on its way. Check your inbox; it expires in 15 minutes.`;
    } catch (err) {
      status.classList.add("notice-error");
      status.textContent = err.message;
    } finally {
      button.disabled = false;
    }
  });
}

/* ----------------------------------------------------------- dashboard */
const STATE_LABELS = { open: "Open", bidding: "Bidding", locked: "Locked", won: "Won", sold: "Sold" };
let summary = null;
let filter = "all";
let money = (amount) => `$${Math.round(amount || 0).toLocaleString("en-US")}`;
const when = (iso) => iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—";
const dash = document.getElementById("dash");

function toast(message, kind = "ok") {
  const node = el("div", { class: `toast toast-${kind}`, role: "status", text: message });
  document.body.append(node);
  setTimeout(() => node.remove(), 4000);
}

async function load() {
  try {
    summary = await api(`/api/dashboard/${encodeURIComponent(slug)}/summary`);
    const formatter = new Intl.NumberFormat("en-US", { style: "currency", currency: (summary.tenant.currency || "usd").toUpperCase(), maximumFractionDigits: 0 });
    money = (amount) => formatter.format(Math.round(amount || 0));
    render();
    maybeWelcome();
  } catch (err) {
    if (err.message === "Sign in required") return;
    dash.replaceChildren(el("p", { class: "notice notice-error", role: "alert", text: `Couldn't load your dashboard: ${err.message}` }),
      el("button", { class: "btn", type: "button", onclick: load, text: "Try again" }));
  } finally {
    dash.setAttribute("aria-busy", "false");
  }
}

function stat(label, value, sub) {
  return el("div", { class: "stat" }, el("span", { class: "stat-label", text: label }), el("strong", { text: value }), sub ? el("small", { text: sub }) : null);
}

function renderStats() {
  const { totals, pricing } = summary;
  const deadline = new Date(pricing.deadline);
  const closed = Date.now() > deadline.getTime();
  return el("section", { class: "stats", "aria-label": "Totals", "data-tour": "stats" },
    stat("Committed", money(totals.committed), `${money(totals.paid)} paid`),
    stat("Sold", `${totals.sold} / ${totals.placements}`, `${totals.open} open`),
    stat("Live bidding", String(totals.bidding), `from ${money(pricing.minBid)} · +${money(pricing.increment)}`),
    stat(closed ? "Bidding closed" : "Bidding closes", new Date(`${pricing.deadline.slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }), `Lock It Now ${money(pricing.lockPrice)}`));
}

function renderPayments() {
  const p = summary.payments;
  if (p.mode !== "connect") {
    return el("section", { class: "card", "data-tour": "payouts" }, el("h2", { text: "Payouts" }),
      el("p", { class: "muted", text: "Sponsor invoices are issued by the platform's Stripe account." }));
  }
  let badge, text;
  if (p.deauthorized) { badge = ["bad", "Disconnected"]; text = "Your Stripe account was disconnected, so bidding is paused. Reconnect to reopen it."; }
  else if (p.ready) { badge = ["ok", "Ready"]; text = `Sponsors pay your Stripe account directly. The platform fee is ${p.feePercent}%.`; }
  else if (p.accountId) { badge = ["warn", "Action needed"]; text = p.currentlyDue?.length ? `Stripe still needs ${p.currentlyDue.length} item${p.currentlyDue.length === 1 ? "" : "s"} before sponsors can bid.` : "Stripe is reviewing your details. Bidding opens once payments are enabled."; }
  else { badge = ["warn", "Not started"]; text = "Set up Stripe payouts so sponsors can bid and pay you directly."; }
  const button = p.ready ? null : el("button", {
    class: "btn btn-primary", type: "button", text: p.accountId ? "Continue Stripe setup" : "Set up payouts",
    onclick: (event) => startPayouts(event.currentTarget)
  });
  return el("section", { class: "card", "data-tour": "payouts" },
    el("div", { class: "card-head" }, el("h2", { text: "Payouts" }), el("span", { class: `badge badge-${badge[0]}`, text: badge[1] })),
    el("p", { class: "muted", text }), button);
}

function renderModel() {
  const model = summary.model || {};
  const viewsStatus = model.views?.status;
  const buildStatus = model.build?.status;
  const reviewStatus = model.review?.status;
  const badge = viewsStatus === "generating"
    ? ["warn", "Generating views"]
    : viewsStatus === "review"
      ? ["accent", "Approve your views"]
      : ["failed", "rejected"].includes(viewsStatus)
        ? ["warn", "Views need attention"]
        : ["building", "processing"].includes(buildStatus)
          ? ["warn", "Building your model"]
          : reviewStatus === "athlete_review"
            ? ["accent", "Review your model"]
            : reviewStatus === "operator_review"
              ? ["warn", "With our team for sign-off"]
              : reviewStatus === "sent_back"
                ? ["warn", "Changes requested"]
                : reviewStatus === "live"
                  ? ["ok", "Model live"]
                  : buildStatus === "ready"
                    ? ["accent", "Model ready"]
            : model.status === "ready"
              ? ["ok", "Live"]
              : model.status === "submitted"
                ? ["warn", "In production"]
                : model.status === "collecting"
                  ? ["warn", `${model.photoCount || 0} of 5 photos`]
                  : ["warn", "Not started"];
  const studioUrl = `/dashboard/${encodeURIComponent(summary.tenant.slug)}/model/studio`;
  const reviewCopy = {
    athlete_review: "Your model is ready for a private review.",
    operator_review: "Your model is with our team for sign-off.",
    sent_back: "Changes were requested on your model.",
    live: "Your approved model is live."
  }[reviewStatus];
  return el("section", { class: "card", "data-tour": "model" },
    el("div", { class: "card-head" }, el("h2", { text: "Your 3D likeness" }), el("span", { class: `badge badge-${badge[0]}`, text: badge[1] })),
    el("p", { class: "muted", text: "Sponsors see a 360° 3D model of you. Take 5 quick photos and we'll build it." }),
    reviewCopy ? el("p", { class: "muted", text: reviewCopy }) : null,
    el("a", {
      class: "btn btn-primary",
      href: ["athlete_review", "operator_review", "sent_back", "live"].includes(reviewStatus)
        ? studioUrl
        : `/dashboard/${encodeURIComponent(summary.tenant.slug)}/model`,
      text: reviewStatus === "athlete_review"
        ? "Open preview"
        : ["operator_review", "sent_back", "live"].includes(reviewStatus)
          ? "Open studio preview"
          : viewsStatus === "review"
            ? "Approve your views"
            : ["failed", "rejected"].includes(viewsStatus)
              ? "Open model studio"
              : buildStatus === "ready"
                ? "See your model"
                : model.status === "collecting" ? "Continue" : "Open model studio"
    }));
}

async function startPayouts(button) {
  if (button) button.disabled = true;
  try {
    const { url } = await api(`/api/dashboard/${encodeURIComponent(slug)}/connect/onboard`, { method: "POST" });
    window.location.assign(url);
  } catch (err) {
    toast(err.message, "error");
    if (button) button.disabled = false;
  }
}

function renderShare() {
  const { tenant } = summary;
  const copy = (value, label) => async (event) => {
    try {
      await navigator.clipboard.writeText(value);
      toast(`${label} copied`);
      if (tenant.status === "live") track("portal_shared");
    }
    catch { event.currentTarget.previousElementSibling?.select?.(); toast("Press Ctrl/Cmd+C to copy", "error"); }
  };
  return el("section", { class: "card", "data-tour": "share" },
    el("div", { class: "card-head" }, el("h2", { text: "Share & embed" }),
      tenant.status !== "live" ? el("span", { class: "badge badge-warn", text: tenant.status === "draft" ? "Draft — not public yet" : "Closed" }) : el("span", { class: "badge badge-ok", text: "Live" })),
    el("label", { for: "portalLink", text: "Portal link" }),
    el("div", { class: "copy-row" }, el("input", { id: "portalLink", readonly: true, value: tenant.portalUrl }), el("button", { class: "btn", type: "button", text: "Copy", onclick: copy(tenant.portalUrl, "Link") })),
    el("label", { for: "embedCode", text: "Website embed" }),
    el("div", { class: "copy-row" }, el("textarea", { id: "embedCode", readonly: true, rows: "3" }, tenant.embedCode), el("button", { class: "btn", type: "button", text: "Copy", onclick: copy(tenant.embedCode, "Embed code") })));
}

function placementStatus(p) {
  if (p.state === "sold") return p.sponsor || "Sold";
  if (p.state === "locked" || p.state === "won") return p.bidder?.company || "—";
  if (p.state === "bidding") return p.bidder?.company || "—";
  return "No bids yet";
}

function invoiceCell(p) {
  if (!p.invoice) return el("span", { class: "muted", text: p.state === "locked" || p.state === "won" ? "Pending" : "—" });
  if (p.invoice.paidAt) return el("span", { class: "badge badge-ok", text: `Paid ${money(p.invoice.amountPaid ?? p.invoice.amount)}` });
  if (p.invoice.status === "sent") return p.invoice.url
    ? el("a", { href: p.invoice.url, target: "_blank", rel: "noopener", text: `Sent ${p.invoice.number || ""}`.trim() })
    : el("span", { text: "Sent" });
  return el("span", { class: "badge badge-bad", text: p.invoice.status === "failed" ? "Failed — retrying" : "Not created" });
}

function contactBlock(c) {
  if (!c) return null;
  return el("div", { class: "contact" },
    el("strong", { text: c.company }), el("span", { text: c.name }),
    c.email ? el("a", { href: `mailto:${c.email}`, text: c.email }) : null,
    c.phone ? el("a", { href: `tel:${c.phone.replace(/[^\d+]/g, "")}`, text: c.phone }) : null);
}

function renderDetail(p) {
  const actions = [];
  if (p.state === "open") actions.push(el("button", { class: "btn", type: "button", text: "Mark as sold offline", onclick: () => openSoldDialog(p) }));
  if (p.state === "sold" && p.soldSource === "dashboard") actions.push(el("button", { class: "btn btn-danger", type: "button", text: "Release placement", onclick: () => release(p) }));
  if (p.state === "sold" && p.soldSource === "config") actions.push(el("p", { class: "muted small", text: "This sale is part of your portal setup. Contact support to change it." }));
  const history = p.history?.length
    ? el("table", { class: "history" },
        el("thead", {}, el("tr", {}, ["When", "Type", "Amount", "Sponsor", "Contact", "Note"].map((h) => el("th", { scope: "col", text: h })))),
        el("tbody", {}, [...p.history].reverse().map((h) => el("tr", {},
          el("td", { text: when(h.at) }), el("td", { text: h.type === "lock" ? "Lock It Now" : "Bid" }), el("td", { class: "num", text: money(h.amount) }),
          el("td", { text: h.company }), el("td", {}, contactBlock({ company: h.name, email: h.email, phone: h.phone })), el("td", { class: "note", text: h.note || "" })))))
    : el("p", { class: "muted", text: p.state === "sold" ? `Sold to ${p.sponsor}${p.soldAmount != null ? ` for ${money(p.soldAmount)}` : ""}.${p.soldNote ? ` ${p.soldNote}` : ""}` : "No bids yet." });
  return el("div", { class: "detail" },
    p.logoUrl ? el("img", { class: "logo-preview", src: p.logoUrl, alt: `${p.bidder?.company || "Sponsor"} logo` }) : null,
    el("div", { class: "detail-body" }, (p.state === "bidding" || p.state === "locked" || p.state === "won") ? el("div", {}, el("h3", { text: p.state === "bidding" ? "Current high bidder" : "Winning sponsor" }), contactBlock(p.bidder)) : null,
      history, actions.length ? el("div", { class: "actions" }, actions) : null));
}

function renderPlacements() {
  const counts = { all: summary.placements.length };
  for (const p of summary.placements) counts[p.state] = (counts[p.state] || 0) + 1;
  const tabs = ["all", "open", "bidding", "locked", "won", "sold"].filter((key) => key === "all" || counts[key]);
  const rows = summary.placements.filter((p) => filter === "all" || p.state === filter);
  const groups = new Map();
  for (const p of rows) {
    if (!groups.has(p.garmentLabel)) groups.set(p.garmentLabel, []);
    groups.get(p.garmentLabel).push(p);
  }
  return el("section", { class: "card card-wide", "data-tour": "placements" },
    el("div", { class: "card-head" }, el("h2", { text: "Placements" }),
      el("div", { class: "filters", "data-tour": "filters", role: "tablist", "aria-label": "Filter placements" }, tabs.map((key) => el("button", {
        type: "button", role: "tab", class: `chip${filter === key ? " is-active" : ""}`, "aria-selected": String(filter === key),
        text: `${key === "all" ? "All" : STATE_LABELS[key]} ${counts[key]}`, onclick: () => { filter = key; render(); }
      })))),
    rows.length ? [...groups].map(([label, list]) => el("div", { class: "group" }, el("h3", { class: "group-title", text: label }),
      el("ul", { class: "placements" }, list.map((p) => el("li", {}, el("details", {},
        el("summary", {},
          el("span", { class: "pid", text: p.id }),
          el("span", { class: "plabel" }, el("strong", { text: p.label }), el("small", { text: placementStatus(p) })),
          el("span", { class: `state state-${p.state}`, text: STATE_LABELS[p.state] }),
          el("span", { class: "amount num", text: p.state === "sold" ? (p.soldAmount != null ? money(p.soldAmount) : "—") : p.high ? money(p.high) : "—" }),
          el("span", { class: "bids", text: p.bidCount ? `${p.bidCount} bid${p.bidCount === 1 ? "" : "s"}` : "" }),
          el("span", { class: "invoice" }, invoiceCell(p))),
        renderDetail(p))))))) : el("p", { class: "muted", text: "No placements match this filter." }));
}

function render() {
  const checklist = renderChecklist();
  const showGuide = !checklist && summary.onboarding?.checklistDismissedAt && !setupComplete();
  dash.replaceChildren(
    el("div", { class: "dash-head" }, el("div", {}, el("p", { class: "eyebrow", text: summary.tenant.eventName }), el("h1", { text: "Sponsorship dashboard" })),
      el("div", { class: "head-actions" },
        showGuide ? el("button", { class: "btn btn-ghost", type: "button", text: "Show setup guide", onclick: () => track("checklist_restored") }) : null,
        el("button", { class: "btn btn-ghost", type: "button", text: "Refresh", onclick: load }))),
    checklist,
    renderStats(),
    el("div", { class: "grid" }, renderPayments(), renderModel(), renderShare()),
    renderPlacements());
}

function openSoldDialog(p) {
  const dialog = el("dialog", { class: "modal", "aria-labelledby": "soldTitle" });
  const error = el("p", { class: "notice notice-error", role: "alert", hidden: true });
  const form = el("form", { class: "stack", method: "dialog", novalidate: true },
    el("h2", { id: "soldTitle", text: `Mark ${p.id} as sold` }),
    el("p", { class: "muted", text: `${p.label}. The placement shows as taken on your portal and stops accepting bids.` }),
    el("label", { for: "soldSponsor", text: "Sponsor name" }), el("input", { id: "soldSponsor", name: "sponsor", required: true, maxlength: "120", autocomplete: "off" }),
    el("label", { for: "soldAmount", text: "Amount (optional)" }), el("input", { id: "soldAmount", name: "amount", type: "number", min: "0", step: "1", inputmode: "numeric" }),
    el("label", { for: "soldNote", text: "Note (optional)" }), el("textarea", { id: "soldNote", name: "note", rows: "2", maxlength: "500" }),
    error,
    el("div", { class: "actions" },
      el("button", { class: "btn btn-ghost", type: "button", text: "Cancel", onclick: () => dialog.close() }),
      el("button", { class: "btn btn-primary", type: "submit", text: "Mark as sold" })));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const sponsor = form.sponsor.value.trim();
    const amountRaw = form.amount.value.trim();
    if (!sponsor) { error.hidden = false; error.textContent = "Enter the sponsor's name."; return; }
    if (amountRaw && !(Number.isInteger(Number(amountRaw)) && Number(amountRaw) >= 0)) { error.hidden = false; error.textContent = "Amount must be a whole number."; return; }
    form.querySelector("[type=submit]").disabled = true;
    try {
      await api(`/api/dashboard/${encodeURIComponent(slug)}/placements/${encodeURIComponent(p.id)}/sold`, {
        method: "POST", body: { sponsor, ...(amountRaw ? { amount: Number(amountRaw) } : {}), note: form.note.value.trim() }
      });
      dialog.close();
      toast(`${p.id} marked as sold`);
      await load();
    } catch (err) {
      error.hidden = false; error.textContent = err.message;
      form.querySelector("[type=submit]").disabled = false;
    }
  });
  dialog.append(form);
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  form.sponsor.focus();
}

async function release(p) {
  if (!window.confirm(`Release ${p.id} (${p.sponsor})? It will reopen for bidding on your portal.`)) return;
  try {
    await api(`/api/dashboard/${encodeURIComponent(slug)}/placements/${encodeURIComponent(p.id)}/release`, { method: "POST" });
    toast(`${p.id} released`);
    await load();
  } catch (err) { toast(err.message, "error"); }
}

/* ---------------------------------------------------------- onboarding */
const SKIP_KEY = `asp-tour-skipped:${slug}`;
let welcomed = false;

async function track(event) {
  try {
    const res = await api(`/api/dashboard/${encodeURIComponent(slug)}/onboarding`, { method: "POST", body: { event } });
    const before = JSON.stringify(summary.onboarding || {});
    summary.onboarding = res.onboarding;
    if (JSON.stringify(res.onboarding) !== before) render();
    return true;
  } catch (err) {
    if (event === "checklist_dismissed" || event === "checklist_restored") toast(err.message, "error");
    return false;
  }
}

function setupSteps() {
  const { payments, onboarding = {}, totals, tenant, model = {} } = summary;
  const connect = payments.mode === "connect";
  const modelDone = model.status === "ready" || model.status === "submitted";
  return [
    {
      id: "payouts",
      done: connect ? payments.ready : true,
      title: connect ? "Connect your Stripe account" : "Payments are handled for you",
      body: connect
        ? "Sponsors pay you directly. Bidding opens as soon as Stripe enables your account."
        : "Sponsor invoices are created and sent automatically when a placement is won.",
      action: connect && !payments.ready ? { label: payments.accountId ? "Continue setup" : "Set up payouts", run: (b) => startPayouts(b) } : null
    },
    {
      id: "model",
      done: modelDone,
      title: "Create your 3D likeness",
      body: modelDone
        ? model.status === "ready" ? "Your 3D likeness is live on your portal." : "Your photos are submitted and your 3D model is in production."
        : "Take 5 guided photos on your phone — we turn them into your 3D model.",
      action: { label: "Open model studio", run: () => { window.location.assign(`/dashboard/${encodeURIComponent(tenant.slug)}/model`); } }
    },
    {
      id: "preview",
      done: Boolean(onboarding.previewedAt),
      title: "See your 3D portal",
      body: tenant.status === "draft"
        ? "Your 360° portal goes public once it's approved. You can preview it from the link we sent you."
        : "Spin the 360° model and preview a logo on your kit the way sponsors will.",
      action: tenant.status === "draft" ? null : { label: "Open portal", run: () => { window.open(tenant.portalUrl, "_blank", "noopener"); track("portal_previewed"); } }
    },
    {
      id: "share",
      done: Boolean(onboarding.sharedAt),
      title: "Share your link or embed it",
      body: tenant.status === "draft"
        ? "Your link and embed start working once your portal is approved and goes live."
        : "Paste one line of code into your website, or send the link to sponsors.",
      action: tenant.status === "draft" ? null : { label: "Go to embed", run: () => focusTarget("share", "#embedCode") }
    },
    {
      id: "tour",
      done: Boolean(onboarding.tourCompletedAt),
      title: "Take the 1-minute tour",
      body: "See what every part of the dashboard does.",
      action: { label: "Start tour", run: () => startTour() }
    },
    {
      id: "sponsor",
      done: totals.bidding + totals.sold > 0,
      title: "Land your first sponsor",
      body: "The first bid or sale shows up here instantly, with the sponsor's contact details.",
      action: null
    }
  ];
}

const setupComplete = () => setupSteps().every((step) => step.done);

function renderChecklist() {
  if (summary.onboarding?.checklistDismissedAt) return null;
  const steps = setupSteps();
  const done = steps.filter((step) => step.done).length;
  if (done === steps.length) return null;
  const pct = Math.round((done / steps.length) * 100);
  return el("section", { class: "card checklist", "aria-labelledby": "setupTitle", "data-tour": "checklist" },
    el("div", { class: "card-head" },
      el("div", {}, el("h2", { id: "setupTitle", text: "Get set up" }), el("p", { class: "muted small", text: `${done} of ${steps.length} done` })),
      el("button", { class: "btn btn-ghost", type: "button", text: "Hide", "aria-label": "Hide setup guide", onclick: () => track("checklist_dismissed") })),
    el("div", { class: "progress", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(pct), "aria-label": "Setup progress" },
      el("span", { style: `width:${pct}%` })),
    el("ol", { class: "steps" }, steps.map((step) => el("li", { class: `step${step.done ? " is-done" : ""}` },
      el("span", { class: "step-mark", "aria-hidden": "true", text: step.done ? "✓" : "" }),
      el("div", { class: "step-copy" },
        el("strong", {}, step.title, step.done ? el("span", { class: "visually-hidden", text: " (done)" }) : null),
        el("span", { class: "muted small", text: step.body })),
      !step.done && step.action ? el("button", { class: "btn", type: "button", text: step.action.label, onclick: (event) => step.action.run(event.currentTarget) }) : null))));
}

function focusTarget(name, selector) {
  const target = document.querySelector(`[data-tour="${name}"]`);
  target?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "center" });
  const field = selector ? document.querySelector(selector) : null;
  if (field) setTimeout(() => { field.focus(); field.select?.(); }, 350);
}

const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const FEATURES = [
  ["360° 3D portal", "Sponsors spin a 3D model of you in your fight kit and preview their logo on the exact spot before they bid."],
  ["Live auction + Lock It Now", "Every placement runs its own auction with a reserve and increments. Sponsors who don't want to wait can buy it outright."],
  ["Money goes straight to you", "Sponsors pay your own Stripe account. Invoices go out automatically when a placement is won."],
  ["Embed anywhere", "One line of code puts the full portal on your website, link-in-bio or press kit."]
];

function maybeWelcome() {
  if (welcomed || summary.onboarding?.tourCompletedAt) return;
  try { if (sessionStorage.getItem(SKIP_KEY)) return; } catch { /* storage unavailable */ }
  welcomed = true;
  const first = summary.tenant.displayName ? summary.tenant.displayName.split(/\s+/)[0] : "";
  const name = first ? first.charAt(0) + first.slice(1).toLowerCase() : "";
  const dialog = el("dialog", { class: "modal welcome", "aria-labelledby": "welcomeTitle" });
  const skip = () => {
    try { sessionStorage.setItem(SKIP_KEY, "1"); } catch { /* storage unavailable */ }
    dialog.close();
  };
  dialog.append(
    el("p", { class: "eyebrow", text: "Welcome" }),
    el("h2", { id: "welcomeTitle", text: name ? `Welcome to your sponsorship dashboard, ${name}` : "Welcome to your sponsorship dashboard" }),
    el("p", { class: "muted", text: "This is where you track every bid, every sponsor and every payment for your portal. Here's what sets it apart:" }),
    el("ul", { class: "features" }, FEATURES.map(([title, body]) => el("li", {}, el("strong", { text: title }), el("span", { text: body })))),
    el("div", { class: "actions" },
      el("button", { class: "btn btn-ghost", type: "button", text: "Skip for now", onclick: skip }),
      el("button", { class: "btn btn-primary", type: "button", text: "Show me around", onclick: () => { dialog.close(); startTour(); } })));
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); skip(); });
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  dialog.querySelector(".btn-primary").focus();
}

function tourSteps() {
  const connect = summary.payments.mode === "connect";
  const fee = summary.payments.feePercent;
  return [
    { target: "stats", title: "Your numbers, live", body: "Committed revenue, placements sold, active auctions and your bidding deadline. They update the moment a sponsor bids or pays." },
    {
      target: "payouts", title: connect ? "Paid directly, not through us" : "Invoicing on autopilot",
      body: connect
        ? `Sponsors pay your own Stripe account, so the money is yours from the start${fee != null ? ` and our ${fee}% fee is taken automatically` : ""}. Bidding stays paused until Stripe can accept payments for you.`
        : "When a placement is won or locked, the sponsor gets a Stripe invoice automatically and you get an email when it's paid."
    },
    { target: "model", title: "Your 3D likeness", body: "Snap 5 guided photos and we'll build the hyper-realistic 3D model sponsors spin on your portal. Each photo is checked instantly so you only shoot once." },
    { target: "share", title: "Embed it anywhere", body: "Copy your link for sponsors and DMs, or paste the embed code into your website. The full 3D portal works on phones and desktops." },
    { target: "placements", title: "Every placement, every bidder", body: "Each logo spot on your kit runs its own auction. Open a row to see the high bidder's contact details, bid history, their uploaded logo and invoice status." },
    { target: "filters", title: "Closed a deal yourself?", body: "Filter to Open and choose \"Mark as sold offline\". The spot shows as taken on your portal right away and stops taking bids. You can release it later." },
    { target: "portal", title: "See what sponsors see", body: "Open your portal to spin the 360° model and try a logo on any placement, exactly as sponsors do." },
    { target: "export", title: "Your sponsor list, yours to keep", body: "Download every bid and sponsor contact as a spreadsheet for follow-ups, thank-yous and next fight's pitch." },
    { target: "tour", title: "That's it", body: "Replay this tour any time from here. Good luck with sponsors!" }
  ].filter((step) => document.querySelector(`[data-tour="${step.target}"]`));
}

let tour = null;

function startTour() {
  if (tour) return;
  const steps = tourSteps();
  if (!steps.length) return;
  const returnFocus = document.activeElement;
  const overlay = el("div", { class: "tour", "data-tour-overlay": "" });
  const hole = el("div", { class: "tour-hole", "aria-hidden": "true" });
  const pop = el("div", { class: "tour-pop", role: "dialog", "aria-modal": "true", "aria-labelledby": "tourTitle", "aria-describedby": "tourBody" });
  overlay.append(hole, pop);
  document.body.append(overlay);
  document.body.classList.add("touring");
  tour = { index: 0, steps, overlay, hole, pop, returnFocus };

  const place = () => {
    if (!tour) return;
    const target = document.querySelector(`[data-tour="${tour.steps[tour.index].target}"]`);
    if (!target) return;
    const r = target.getBoundingClientRect();
    const pad = 8;
    Object.assign(hole.style, { top: `${r.top - pad}px`, left: `${r.left - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    let top = r.bottom + pad + 12;
    if (top + ph > vh - 12) top = r.top - pad - 12 - ph;
    if (top < 12) top = Math.max(12, Math.min(vh - ph - 12, r.top + 12));
    const left = Math.max(12, Math.min(vw - pw - 12, r.left + r.width / 2 - pw / 2));
    Object.assign(pop.style, { top: `${top}px`, left: `${left}px` });
  };

  const show = (index) => {
    tour.index = index;
    const step = tour.steps[index];
    const last = index === tour.steps.length - 1;
    pop.replaceChildren(
      el("p", { class: "tour-count", text: `${index + 1} of ${tour.steps.length}` }),
      el("h2", { id: "tourTitle", text: step.title }),
      el("p", { id: "tourBody", text: step.body }),
      el("div", { class: "actions" },
        last ? null : el("button", { class: "btn btn-ghost tour-skip", type: "button", text: "Skip tour", onclick: () => endTour(false) }),
        index ? el("button", { class: "btn", type: "button", text: "Back", onclick: () => show(index - 1) }) : null,
        el("button", { class: "btn btn-primary", type: "button", text: last ? "Finish" : "Next", onclick: () => last ? endTour(true) : show(index + 1) })));
    const target = document.querySelector(`[data-tour="${step.target}"]`);
    target.scrollIntoView({ behavior: "auto", block: "center", inline: "nearest" });
    place();
    pop.querySelector(".btn-primary").focus();
  };

  const onKey = (event) => {
    if (!tour) return;
    if (event.key === "Escape") { event.preventDefault(); endTour(false); }
    else if (event.key === "ArrowRight" && tour.index < tour.steps.length - 1) show(tour.index + 1);
    else if (event.key === "ArrowLeft" && tour.index > 0) show(tour.index - 1);
    else if (event.key === "Tab") {
      const buttons = [...pop.querySelectorAll("button")];
      const at = buttons.indexOf(document.activeElement);
      event.preventDefault();
      buttons[(at + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus();
    }
  };
  tour.cleanup = () => {
    window.removeEventListener("resize", place);
    window.removeEventListener("scroll", place, true);
    document.removeEventListener("keydown", onKey, true);
  };
  window.addEventListener("resize", place);
  window.addEventListener("scroll", place, true);
  document.addEventListener("keydown", onKey, true);
  show(0);
}

async function endTour(completed) {
  if (!tour) return;
  const { overlay, cleanup, returnFocus } = tour;
  cleanup();
  overlay.remove();
  document.body.classList.remove("touring");
  tour = null;
  if (!completed) {
    try { sessionStorage.setItem(SKIP_KEY, "1"); } catch { /* storage unavailable */ }
  } else if (await track("tour_completed")) {
    try { sessionStorage.setItem(SKIP_KEY, "1"); } catch { /* storage unavailable */ }
    toast("You're all set");
  } else toast("Couldn't save your tour progress. Try again from Take the tour.", "error");
  if (returnFocus instanceof HTMLElement && document.contains(returnFocus)) returnFocus.focus();
}

/* -------------------------------------------------------- model studio */
const PHOTO_ANGLES = {
  front: { title: "Front", instruction: "Face the camera, arms slightly away from your body." },
  back: { title: "Back", instruction: "Turn around, arms slightly away from your body." },
  left: { title: "Left side", instruction: "Turn left and show your full side." },
  right: { title: "Right side", instruction: "Turn right and show your full side." },
  face: { title: "Face close-up", instruction: "Take a clear, straight-on photo of your face." }
};
const PHOTO_WARNING_COPY = {
  blurry: "Looks blurry — hold still or tap to focus.",
  dark: "Too dark — move to brighter, even light.",
  bright: "Overexposed — avoid direct sun or a bright window behind you.",
  landscape: "Turn your phone upright.",
  no_person: "We couldn't find a person in this photo.",
  multiple_people: "Only you should be in the photo.",
  not_full_body: "Get your whole body in frame, head to feet."
};
const MODEL_MISSING_COPY = {
  consent: "Likeness consent",
  kit: "Kit colours",
  "photo:front": "Front photo",
  "photo:back": "Back photo",
  "photo:left": "Left-side photo",
  "photo:right": "Right-side photo"
};
let modelStudio = null;
let modelStudioSummary = null;
const modelPhotoDrafts = {};
let poseLandmarkerPromise = null;
let viewPollTimer = null;
let viewGenerateBusy = false;
let viewDecisionBusy = false;
let viewRegenerateOpen = false;
let viewFeedback = "";
let buildStartBusy = false;
const REFERENCE_ANGLES = ["front", "back", "left", "right"];
const REFERENCE_LABELS = { front: "Front", back: "Back", left: "Left", right: "Right" };

function modelDate(value) {
  return value ? new Date(value).toLocaleDateString() : "";
}

function svgEl(tag, attrs = {}, ...children) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) if (value) node.setAttribute(key, value);
  node.append(...children);
  return node;
}

function poseIcon(angle) {
  const common = { fill: "none", stroke: "currentColor", "stroke-width": "2.5", "stroke-linecap": "round", "stroke-linejoin": "round" };
  if (angle === "face") {
    return svgEl("svg", { ...common, class: "pose-icon", viewBox: "0 0 48 48", "aria-hidden": "true" },
      svgEl("circle", { cx: "24", cy: "23", r: "17" }),
      svgEl("path", { d: "M18 21h.1M30 21h.1M19 30c3 3 7 3 10 0" }));
  }
  if (angle === "left" || angle === "right") {
    const flip = angle === "right" ? "translate(48 0) scale(-1 1)" : "";
    return svgEl("svg", { ...common, class: "pose-icon", viewBox: "0 0 48 72", "aria-hidden": "true" },
      svgEl("g", { transform: flip },
        svgEl("circle", { cx: "21", cy: "10", r: "5" }),
        svgEl("path", { d: "M21 16l4 25m-3-18-8 7m8-7 8 5m-6 13-8 20m8-20 11 19" })));
  }
  if (angle === "back") {
    return svgEl("svg", { ...common, class: "pose-icon", viewBox: "0 0 48 72", "aria-hidden": "true" },
      svgEl("circle", { cx: "24", cy: "10", r: "5" }),
      svgEl("path", { d: "M24 16v25M13 24h22M24 41 15 62m9-21 9 21M17 26l7 5 7-5M18 31l6 4 6-4" }));
  }
  return svgEl("svg", { ...common, class: "pose-icon", viewBox: "0 0 48 72", "aria-hidden": "true" },
    svgEl("circle", { cx: "24", cy: "10", r: "5" }),
    svgEl("path", { d: "M24 16v25M13 24h22M24 41 15 62m9-21 9 21" }));
}

function photoMetrics(canvas) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  const gray = new Float32Array(canvas.width * canvas.height);
  let brightness = 0;
  for (let pixel = 0; pixel < gray.length; pixel++) {
    const i = pixel * 4;
    const luma = data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722;
    gray[pixel] = luma;
    brightness += luma;
  }
  let laplacian = 0;
  let laplacianSquared = 0;
  let count = 0;
  for (let y = 1; y < canvas.height - 1; y++) {
    for (let x = 1; x < canvas.width - 1; x++) {
      const i = y * canvas.width + x;
      const value = gray[i - canvas.width - 1] + gray[i - canvas.width] + gray[i - canvas.width + 1] +
        gray[i - 1] + gray[i + 1] + gray[i + canvas.width - 1] + gray[i + canvas.width] +
        gray[i + canvas.width + 1] - 8 * gray[i];
      laplacian += value;
      laplacianSquared += value * value;
      count++;
    }
  }
  const mean = laplacian / Math.max(1, count);
  return {
    brightness: brightness / Math.max(1, gray.length),
    blurVariance: laplacianSquared / Math.max(1, count) - mean * mean
  };
}

async function getPoseLandmarker() {
  if (!poseLandmarkerPromise) {
    poseLandmarkerPromise = (async () => {
      try {
        const { FilesetResolver, PoseLandmarker } = await import("/vendor/mediapipe/vision_bundle.mjs");
        const fileset = await FilesetResolver.forVisionTasks("/vendor/mediapipe/wasm");
        return await PoseLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: "/models/pose_landmarker_lite.task", delegate: "CPU" },
          runningMode: "IMAGE",
          numPoses: 2
        });
      } catch (error) {
        console.warn("MediaPipe pose checks unavailable; skipping pose checks.", error);
        return null;
      }
    })();
  }
  return poseLandmarkerPromise;
}

async function poseWarning(canvas, angle) {
  const landmarker = await getPoseLandmarker();
  if (!landmarker) return null;
  try {
    const poses = landmarker.detect(canvas).landmarks || [];
    if (!poses.length) return "no_person";
    if (poses.length > 1) return "multiple_people";
    const points = poses[0];
    const required = angle === "back" ? [11, 12, 27, 28] : [0, 27, 28];
    const fullBody = required.every((index) => {
      const point = points[index];
      return point && point.visibility >= 0.5 && point.y >= 0.02 && point.y <= 0.98;
    });
    return fullBody ? null : "not_full_body";
  } catch (error) {
    console.warn("MediaPipe pose checks unavailable; skipping pose checks.", error);
    return null;
  }
}

function blobDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function prepareModelPhoto(angle, file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return { error: "We couldn't read this photo. Use a JPG or PNG (iPhone: Settings → Camera → Formats → Most Compatible)." };
  }
  const shortEdge = Math.min(bitmap.width, bitmap.height);
  if (shortEdge < 720) {
    bitmap.close();
    return { error: "Photo is too small — retake it closer or at a higher resolution." };
  }
  const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const jpeg = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
  if (!jpeg) return { error: "We couldn't read this photo. Try another JPG or PNG." };

  const checkCanvas = document.createElement("canvas");
  const checkScale = 512 / Math.max(width, height);
  checkCanvas.width = Math.max(1, Math.round(width * checkScale));
  checkCanvas.height = Math.max(1, Math.round(height * checkScale));
  checkCanvas.getContext("2d").drawImage(canvas, 0, 0, checkCanvas.width, checkCanvas.height);
  const metrics = photoMetrics(checkCanvas);
  const warnings = [];
  if (metrics.blurVariance < 60) warnings.push("blurry");
  if (metrics.brightness < 40) warnings.push("dark");
  if (metrics.brightness > 215) warnings.push("bright");
  if (angle !== "face") {
    if (width >= height) warnings.push("landscape");
    const pose = await poseWarning(checkCanvas, angle);
    if (pose) warnings.push(pose);
  }
  return { blob: jpeg, dataUrl: await blobDataUrl(jpeg), previewUrl: URL.createObjectURL(jpeg), warnings };
}

async function uploadModelPhoto(angle, draft) {
  draft.uploading = true;
  draft.error = "";
  renderModelStudio();
  try {
    const result = await api(`/api/dashboard/${encodeURIComponent(slug)}/model/photos/${angle}`, {
      method: "POST",
      body: { image: draft.dataUrl, warnings: draft.warnings }
    });
    modelStudio = result.model;
    URL.revokeObjectURL(draft.previewUrl);
    delete modelPhotoDrafts[angle];
    renderModelStudio();
  } catch (error) {
    draft.uploading = false;
    draft.error = error.message;
    toast(error.message, "error");
    renderModelStudio();
  }
}

async function chooseModelPhoto(angle, file) {
  const previous = modelPhotoDrafts[angle];
  if (previous?.previewUrl) URL.revokeObjectURL(previous.previewUrl);
  const result = await prepareModelPhoto(angle, file);
  if (result.error) {
    modelPhotoDrafts[angle] = { error: result.error, warnings: [] };
    renderModelStudio();
    return;
  }
  modelPhotoDrafts[angle] = result;
  renderModelStudio();
  if (!result.warnings.length) uploadModelPhoto(angle, result);
}

function renderPhotoTile(angle, disabled) {
  const info = PHOTO_ANGLES[angle];
  const photo = modelStudio.photos?.[angle];
  const draft = modelPhotoDrafts[angle];
  const tile = el("article", { class: "photo-tile" });
  const input = el("input", {
    id: `photo-${angle}-input`,
    class: "visually-hidden",
    type: "file",
    accept: "image/*",
    disabled,
    "aria-label": `Choose ${info.title.toLowerCase()} photo`
  });
  const picker = el("button", {
    class: "btn",
    type: "button",
    disabled,
    text: photo ? "Replace" : "Take or choose photo",
    onclick: () => input.click()
  });
  input.addEventListener("change", (event) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file) chooseModelPhoto(angle, file);
  });
  const imageUrl = draft?.previewUrl || (photo
    ? `/api/dashboard/${encodeURIComponent(slug)}/model/photos/${angle}?v=${encodeURIComponent(photo.at || "")}`
    : "");
  tile.append(...[
    el("div", { class: "photo-tile-head" }, poseIcon(angle), el("div", {}, el("h3", { text: info.title }), el("p", { class: "muted small", text: info.instruction }))),
    imageUrl ? el("img", { class: "photo-thumbnail", src: imageUrl, alt: `${info.title} photo` }) : null,
    photo && !draft ? el("p", { class: "photo-result", text: photo.warnings?.length ? `! ${photo.warnings.length} warning${photo.warnings.length === 1 ? "" : "s"}` : "✓ Photo ready" }) : null,
    draft?.error ? el("p", { class: "notice notice-error photo-message", role: "alert", text: draft.error }) : null,
    draft?.warnings?.length ? el("ul", { class: "photo-warnings" }, draft.warnings.map((warning) => el("li", { text: PHOTO_WARNING_COPY[warning] }))) : null,
    input,
    el("div", { class: "photo-actions" },
      draft?.warnings?.length && !draft.uploading
        ? el("button", { class: "btn", type: "button", disabled, text: "Retake", onclick: () => input.click() })
        : null,
      draft?.warnings?.length && !draft.uploading
        ? el("button", { class: "btn btn-primary", type: "button", disabled, text: "Use this photo anyway", onclick: () => uploadModelPhoto(angle, draft) })
        : null,
      draft?.error && draft.dataUrl && !draft.warnings?.length && !draft.uploading
        ? el("button", { class: "btn btn-primary", type: "button", disabled, text: "Retry upload", onclick: () => uploadModelPhoto(angle, draft) })
        : null,
      draft?.uploading
        ? el("button", { class: "btn btn-primary", type: "button", disabled: true, text: "Uploading…" })
        : (!draft?.warnings?.length || !draft.dataUrl) && !draft?.uploading ? picker : null)
  ].filter(Boolean));
  return tile;
}

function renderConsentSection(readOnly) {
  const section = el("section", { class: "card model-section", "aria-labelledby": "consentHeading" },
    el("p", { class: "eyebrow", text: "01 · CONSENT" }),
    el("h2", { id: "consentHeading", text: "Likeness consent" }));
  if (modelStudio.consent) {
    section.append(el("p", { class: "notice notice-ok", text: `Consent recorded ${modelDate(modelStudio.consent.acceptedAt)}` }));
    return section;
  }
  const checkbox = el("input", { type: "checkbox", required: true, disabled: readOnly });
  const button = el("button", { class: "btn btn-primary", type: "submit", disabled: true, text: "Save and continue" });
  const form = el("form", { class: "consent-form" },
    el("label", { class: "consent-label" }, checkbox,
      el("span", { text: "I'm the athlete in these photos (or authorised to act for them). I consent to these photos being used to create a 3D likeness of me that will appear on my public sponsorship portal. I can ask for it to be removed at any time." })),
    button);
  checkbox.addEventListener("change", () => { button.disabled = !checkbox.checked || readOnly; });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!checkbox.checked) return;
    button.disabled = true;
    try {
      const result = await api(`/api/dashboard/${encodeURIComponent(slug)}/model/consent`, {
        method: "POST",
        body: { accept: true, version: "2026-10-03" }
      });
      modelStudio = result.model;
      renderModelStudio();
    } catch (error) {
      button.disabled = false;
      toast(error.message, "error");
    }
  });
  section.append(form);
  return section;
}

function renderPhotosSection(readOnly) {
  const enabled = Boolean(modelStudio.consent) && !readOnly;
  return el("section", { class: `card model-section${enabled ? "" : " is-disabled"}`, "aria-labelledby": "photosHeading" },
    el("p", { class: "eyebrow", text: "02 · PHOTOS" }),
    el("h2", { id: "photosHeading", text: "Five guided photos" }),
    el("p", { class: "model-tips", text: "Stand 2–3 m from the camera, phone at chest height. Plain background, even light, no hat. Wear your fight kit or fitted clothes. Arms slightly away from your body." }),
    !modelStudio.consent ? el("p", { class: "muted", text: "Save your likeness consent to unlock photo uploads." }) : null,
    el("div", { class: "photo-grid" }, Object.keys(PHOTO_ANGLES).map((angle) => renderPhotoTile(angle, !enabled))));
}

function renderKitSection(readOnly) {
  const saved = modelStudio.kit || {};
  const shirt = el("input", { type: "color", name: "shirt", value: saved.shirt || "#111111", disabled: readOnly });
  const shorts = el("input", { type: "color", name: "shorts", value: saved.shorts || "#111111", disabled: readOnly });
  const waistband = el("input", { type: "color", name: "waistband", value: saved.waistband || "#ffffff", disabled: readOnly });
  const notes = el("textarea", {
    name: "notes",
    rows: "3",
    maxlength: "500",
    placeholder: "Anything we should know (e.g. tattoos, hairstyle on fight night)",
    disabled: readOnly
  }, saved.notes || "");
  const form = el("form", { class: "kit-form" },
    el("div", { class: "kit-colors" },
      ...[[shirt, "Shirt"], [shorts, "Shorts"], [waistband, "Waistband"]].map(([input, label]) =>
        el("label", { class: "kit-color" }, el("span", { text: label }), input)),
    ),
    el("div", { class: "kit-swatch-row" },
      el("span", { class: "muted small", text: "Quick swatch" }),
      el("button", {
        class: "kit-swatch",
        type: "button",
        style: `--swatch:${modelStudioSummary?.tenant?.accent || "#ff6a1a"}`,
        disabled: readOnly,
        onclick: () => { shirt.value = modelStudioSummary?.tenant?.accent || "#ff6a1a"; }
      }, el("span", { class: "kit-swatch-dot" }), el("span", { text: "Use portal accent for shirt" }))),
    el("label", { for: "kitNotes", text: "Notes" }),
    notes,
    el("button", { class: "btn btn-primary", type: "submit", disabled: readOnly, text: "Save kit colours" }));
  notes.id = "kitNotes";
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector("[type=submit]");
    button.disabled = true;
    try {
      const result = await api(`/api/dashboard/${encodeURIComponent(slug)}/model/kit`, {
        method: "POST",
        body: { shirt: shirt.value, shorts: shorts.value, waistband: waistband.value, notes: notes.value }
      });
      modelStudio = result.model;
      renderModelStudio();
    } catch (error) {
      toast(error.message, "error");
      button.disabled = false;
    }
  });
  return el("section", { class: "card model-section", "aria-labelledby": "kitHeading" },
    el("p", { class: "eyebrow", text: "03 · KIT COLOURS" }),
    el("h2", { id: "kitHeading", text: "Match your fight kit" }),
    form);
}

function renderReviewSection(readOnly) {
  const missing = modelStudio.missing || [];
  const button = el("button", {
    class: "btn btn-primary",
    type: "button",
    disabled: readOnly || missing.length > 0,
    text: "Submit for 3D build",
    onclick: async (event) => {
      event.currentTarget.disabled = true;
      event.currentTarget.textContent = "Submitting…";
      try {
        const result = await api(`/api/dashboard/${encodeURIComponent(slug)}/model/submit`, { method: "POST" });
        modelStudio = result.model;
        renderModelStudio();
        if (modelStudio.views?.status === "not_started") await requestGenerateViews();
      } catch (error) {
        toast(error.message, "error");
        renderModelStudio();
      }
    }
  });
  return el("section", { class: "card model-section", "aria-labelledby": "reviewHeading" },
    el("p", { class: "eyebrow", text: "04 · REVIEW & SUBMIT" }),
    el("h2", { id: "reviewHeading", text: "Ready for your 3D build?" }),
    readOnly
      ? el("p", { class: "notice notice-ok", text: `Submitted ${modelDate(modelStudio.submittedAt)}. We'll build your 3D model and email you when it's ready to preview — usually within 1–2 days.` })
      : missing.length
        ? el("ul", { class: "missing-list" }, missing.map((item) => el("li", { text: MODEL_MISSING_COPY[item] || item })))
        : el("p", { class: "notice notice-ok", text: "Everything is ready to submit." }),
    readOnly ? null : button);
}

function stopViewPolling() {
  if (viewPollTimer) clearTimeout(viewPollTimer);
  viewPollTimer = null;
}

function scheduleViewPoll() {
  stopViewPolling();
  const viewsGenerating = modelStudio?.views?.status === "generating";
  const buildPending = ["building", "processing"].includes(modelStudio?.build?.status);
  if (view !== "model" || (!viewsGenerating && !buildPending)) return;
  viewPollTimer = setTimeout(async () => {
    viewPollTimer = null;
    const stillPolling = modelStudio?.views?.status === "generating" ||
      ["building", "processing"].includes(modelStudio?.build?.status);
    if (view !== "model" || !stillPolling) return;
    try {
      const result = await api(`/api/dashboard/${encodeURIComponent(slug)}/model`);
      modelStudio = result.model;
      renderModelStudio();
    } catch (error) {
      console.warn("Reference-view polling failed.", error);
      scheduleViewPoll();
    }
  }, buildPending ? 5000 : 4000);
}

function renderReferenceGrid() {
  return el("div", { class: "view-grid" }, REFERENCE_ANGLES.map((angle) => {
    const src = `/api/dashboard/${encodeURIComponent(slug)}/model/views/${angle}?v=${encodeURIComponent(modelStudio.views.jobId || "")}`;
    return el("article", { class: "view-card" },
      el("h3", { text: REFERENCE_LABELS[angle] }),
      el("a", {
        class: "view-image-link",
        href: src,
        target: "_blank",
        rel: "noopener noreferrer",
        "aria-label": `Open full-size ${REFERENCE_LABELS[angle].toLowerCase()} reference view`
      }, el("img", { class: "view-image", src, alt: `${REFERENCE_LABELS[angle]} reference view` })));
  }));
}

async function requestGenerateViews() {
  if (viewGenerateBusy) return;
  viewGenerateBusy = true;
  renderModelStudio();
  try {
    const result = await api(`/api/dashboard/${encodeURIComponent(slug)}/model/views/generate`, { method: "POST" });
    modelStudio = result.model;
    viewRegenerateOpen = false;
    viewFeedback = "";
  } catch (error) {
    toast(error.message, "error");
  } finally {
    viewGenerateBusy = false;
    renderModelStudio();
  }
}

async function submitReferenceDecision(decision) {
  if (viewDecisionBusy) return;
  viewDecisionBusy = true;
  renderModelStudio();
  try {
    const result = await api(`/api/dashboard/${encodeURIComponent(slug)}/model/views/decision`, {
      method: "POST",
      body: {
        jobId: modelStudio.views.jobId,
        decision,
        feedback: decision === "reject" ? viewFeedback : ""
      }
    });
    modelStudio = result.model;
    viewRegenerateOpen = false;
    renderModelStudio();
    if (decision === "reject") await requestGenerateViews();
    else await requestBuildStart();
  } catch (error) {
    toast(error.message, "error");
  } finally {
    viewDecisionBusy = false;
    renderModelStudio();
  }
}

function renderViewsSection() {
  const views = modelStudio.views;
  if (!views || views.status === "locked") return null;
  const section = el("section", { class: "card model-section reference-views", "aria-labelledby": "viewsHeading" },
    el("p", { class: "eyebrow", text: "05 · APPROVE YOUR VIEWS" }),
    el("h2", { id: "viewsHeading", text: "Check your reference views" }));

  if (views.status === "not_started") {
    section.append(
      el("p", { text: "We turn your photos into clean front, back and side views in your kit colours. Takes about a minute." }),
      el("button", {
        class: "btn btn-primary",
        type: "button",
        disabled: viewGenerateBusy,
        text: viewGenerateBusy ? "Generating…" : "Generate my views",
        onclick: requestGenerateViews
      }));
  } else if (views.status === "generating") {
    section.append(
      el("p", { class: "muted", text: "You can leave this page — we'll keep working on them." }),
      el("div", { class: "view-grid" }, REFERENCE_ANGLES.map((angle) => {
        const state = views.angles?.[angle] || { progress: 0, status: "pending" };
        const progress = Math.round(state.progress || 0);
        return el("article", { class: "view-placeholder" },
          el("h3", { text: REFERENCE_LABELS[angle] }),
          el("div", { class: "view-progress", role: "progressbar", "aria-valuenow": String(progress), "aria-valuemin": "0", "aria-valuemax": "100" },
            el("span", { style: `width:${progress}%` })),
          el("p", { class: "muted small", text: state.status === "failed" ? "Could not generate" : `${progress}%` }));
      })));
  } else if (views.status === "review") {
    section.append(renderReferenceGrid(),
      el("p", { class: "view-checklist", text: "Your face · Your tattoos · Your build · Kit colours" }),
      el("div", { class: "view-actions" },
        el("button", {
          class: "btn btn-primary",
          type: "button",
          disabled: viewDecisionBusy,
          text: viewDecisionBusy ? "Saving…" : "Approve these views",
          onclick: () => submitReferenceDecision("approve")
        }),
        views.attemptsLeft > 0
          ? el("button", {
            class: "btn",
            type: "button",
            disabled: viewDecisionBusy,
            text: "Something's off — regenerate",
            onclick: () => { viewRegenerateOpen = true; renderModelStudio(); }
          })
          : null),
      views.attemptsLeft > 0
        ? el("p", { class: "muted small", text: `${views.attemptsLeft} ${views.attemptsLeft === 1 ? "regeneration" : "regenerations"} left` })
        : el("p", { class: "notice notice-warn", text: "No regenerations left — if something's off, contact us and we'll fix it by hand." }));
    if (viewRegenerateOpen && views.attemptsLeft > 0) {
      const feedback = el("textarea", {
        rows: "3",
        maxlength: "500",
        placeholder: "What should we fix? (optional)"
      }, viewFeedback);
      feedback.addEventListener("input", () => { viewFeedback = feedback.value; });
      section.append(el("label", { class: "view-feedback-label" }, "Tell us what's off", feedback),
        el("button", {
          class: "btn btn-primary",
          type: "button",
          disabled: viewDecisionBusy || viewGenerateBusy,
          text: viewDecisionBusy || viewGenerateBusy ? "Regenerating…" : "Reject & regenerate",
          onclick: () => submitReferenceDecision("reject")
        }));
    }
  } else if (views.status === "approved") {
    section.append(renderReferenceGrid(),
      el("p", { class: "notice notice-ok", text: "Approved. Next we build your 3D model." }));
  } else if (views.status === "failed") {
    section.append(el("p", { class: "notice notice-error", role: "alert", text: "We couldn't create all your views this time. Please try again." }));
    if (views.attemptsLeft > 0) {
      section.append(el("button", {
        class: "btn btn-primary",
        type: "button",
        disabled: viewGenerateBusy,
        text: viewGenerateBusy ? "Generating…" : "Try again",
        onclick: requestGenerateViews
      }));
    } else {
      section.append(el("p", { class: "notice notice-warn", text: "You've used all 3 generations — contact us and we'll fix it by hand." }));
    }
  } else if (views.status === "rejected") {
    section.append(el("p", { class: "notice notice-warn", text: "These views were rejected." }));
    if (views.attemptsLeft > 0) {
      section.append(el("button", {
        class: "btn btn-primary",
        type: "button",
        disabled: viewGenerateBusy,
        text: viewGenerateBusy ? "Generating…" : "Generate my views",
        onclick: requestGenerateViews
      }));
    } else {
      section.append(el("p", { class: "notice notice-warn", text: "You've used all 3 generations — contact us and we'll fix it by hand." }));
    }
  }
  return section;
}

async function requestBuildStart() {
  if (buildStartBusy) return;
  buildStartBusy = true;
  renderModelStudio();
  try {
    const result = await api(`/api/dashboard/${encodeURIComponent(slug)}/model/build/start`, { method: "POST" });
    modelStudio = result.model;
  } catch (error) {
    toast(error.message, "error");
  } finally {
    buildStartBusy = false;
    renderModelStudio();
  }
}

function renderBuildSection() {
  const build = modelStudio.build;
  if (!build || build.status === "locked") return null;
  const section = el("section", { class: "card model-section model-build", "aria-labelledby": "buildHeading" },
    el("p", { class: "eyebrow", text: "06 · YOUR 3D MODEL" }),
    el("h2", { id: "buildHeading", text: "Build your 3D model" }));

  if (build.status === "not_started") {
    section.append(
      el("p", { text: "We turn your approved views into a full 3D model of you. Takes about 3–6 minutes." }),
      el("button", {
        class: "btn btn-primary",
        type: "button",
        disabled: buildStartBusy,
        text: buildStartBusy ? "Starting…" : "Build my 3D model",
        onclick: requestBuildStart
      }));
  } else if (build.status === "building") {
    const progress = Math.round(build.progress || 0);
    section.append(
      el("div", {
        class: "build-progress",
        role: "progressbar",
        "aria-valuenow": String(progress),
        "aria-valuemin": "0",
        "aria-valuemax": "100"
      }, el("span", { style: `width:${progress}%` })),
      el("p", { class: "muted", text: "Building your 3D model — usually 3–6 minutes. You can leave this page; we'll email you when it's ready." }));
  } else if (build.status === "processing") {
    section.append(
      el("div", { class: "build-progress is-indeterminate", role: "progressbar", "aria-valuetext": "Optimising your model for the web" },
        el("span")),
      el("p", { class: "muted", text: "Optimising your model for the web…" }));
  } else if (build.status === "ready") {
    if (build.jobId) {
      section.append(el("img", {
        class: "build-thumbnail",
        src: `/api/dashboard/${encodeURIComponent(slug)}/model/build/thumbnail?v=${encodeURIComponent(build.jobId)}`,
        alt: "Thumbnail of your 3D model"
      }));
    }
    const reviewCopy = {
      athlete_review: "Your model is ready for a private review.",
      operator_review: "Your model is with our team for sign-off.",
      sent_back: `Changes requested: ${modelStudio.review?.operator?.note || "Please review the note in your private preview."}`,
      live: "Your model is live on your portal."
    }[modelStudio.review?.status] || "Your 3D model is built and ready for review.";
    section.append(
      el("p", { class: "notice notice-ok", text: reviewCopy }),
      el("a", {
        class: "btn btn-primary",
        href: `/dashboard/${encodeURIComponent(slug)}/model/studio`,
        text: "Open studio preview"
      }));
  } else if (build.status === "failed") {
    section.append(el("p", { class: "notice notice-error", role: "alert", text: "Something went wrong building your model." }));
    if (build.attemptsLeft > 0) {
      section.append(el("button", {
        class: "btn btn-primary",
        type: "button",
        disabled: buildStartBusy,
        text: buildStartBusy ? "Starting…" : "Try again",
        onclick: requestBuildStart
      }));
    } else {
      section.append(el("p", { class: "notice notice-warn", text: "Contact us and we'll finish it by hand." }));
    }
  }
  return section;
}

function renderModelStudio() {
  const root = document.getElementById("modelStudio");
  if (!root || !modelStudio) return;
  root.setAttribute("aria-busy", "false");
  if (modelStudio.status === "ready" && !modelStudio.build?.jobId) {
    stopViewPolling();
    root.replaceChildren(el("section", { class: "card model-ready" },
      el("p", { class: "model-ready-copy", text: "Your 3D model is live on your portal." }),
      el("a", { class: "btn btn-primary", href: `/${encodeURIComponent(slug)}`, text: "View portal" })));
    return;
  }
  const readOnly = Boolean(modelStudio.submittedAt);
  root.replaceChildren(...[
    el("div", { class: "dash-head model-heading" }, el("div", {},
      el("p", { class: "eyebrow", text: "3D MODEL STUDIO" }),
      el("h1", { text: "Build your 3D likeness" }))),
    renderConsentSection(readOnly),
    renderPhotosSection(readOnly),
    renderKitSection(readOnly),
    renderReviewSection(readOnly),
    renderViewsSection(),
    renderBuildSection()
  ].filter(Boolean));
  scheduleViewPoll();
}

async function loadModelStudio() {
  const root = document.getElementById("modelStudio");
  if (!root) return;
  try {
    const [result, dashboard] = await Promise.all([
      api(`/api/dashboard/${encodeURIComponent(slug)}/model`),
      api(`/api/dashboard/${encodeURIComponent(slug)}/summary`)
    ]);
    modelStudio = result.model;
    modelStudioSummary = dashboard;
    renderModelStudio();
  } catch (error) {
    if (error.message === "Sign in required") return;
    root.replaceChildren(el("p", { class: "notice notice-error", role: "alert", text: `Couldn't load the model studio: ${error.message}` }),
      el("button", { class: "btn", type: "button", text: "Try again", onclick: loadModelStudio }));
  } finally {
    root.setAttribute("aria-busy", "false");
  }
}

if (view === "dashboard") {
  document.getElementById("tourBtn")?.addEventListener("click", () => summary && startTour());
  document.getElementById("viewPortal")?.addEventListener("click", () => summary?.tenant.status === "live" && track("portal_previewed"));
  load();
} else if (view === "model") {
  window.addEventListener("pagehide", stopViewPolling);
  loadModelStudio();
}
