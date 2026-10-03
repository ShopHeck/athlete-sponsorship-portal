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
    el("div", { class: "grid" }, renderPayments(), renderShare()),
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
  const { payments, onboarding = {}, totals, tenant } = summary;
  const connect = payments.mode === "connect";
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

if (view === "dashboard") {
  document.getElementById("tourBtn")?.addEventListener("click", () => summary && startTour());
  document.getElementById("viewPortal")?.addEventListener("click", () => summary?.tenant.status === "live" && track("portal_previewed"));
  load();
}
