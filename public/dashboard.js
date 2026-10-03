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
  return el("section", { class: "stats", "aria-label": "Totals" },
    stat("Committed", money(totals.committed), `${money(totals.paid)} paid`),
    stat("Sold", `${totals.sold} / ${totals.placements}`, `${totals.open} open`),
    stat("Live bidding", String(totals.bidding), `from ${money(pricing.minBid)} · +${money(pricing.increment)}`),
    stat(closed ? "Bidding closed" : "Bidding closes", new Date(`${pricing.deadline.slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }), `Lock It Now ${money(pricing.lockPrice)}`));
}

function renderPayments() {
  const p = summary.payments;
  if (p.mode !== "connect") {
    return el("section", { class: "card" }, el("h2", { text: "Payouts" }),
      el("p", { class: "muted", text: "Sponsor invoices are issued by the platform's Stripe account." }));
  }
  let badge, text;
  if (p.deauthorized) { badge = ["bad", "Disconnected"]; text = "Your Stripe account was disconnected, so bidding is paused. Reconnect to reopen it."; }
  else if (p.ready) { badge = ["ok", "Ready"]; text = `Sponsors pay your Stripe account directly. The platform fee is ${p.feePercent}%.`; }
  else if (p.accountId) { badge = ["warn", "Action needed"]; text = p.currentlyDue?.length ? `Stripe still needs ${p.currentlyDue.length} item${p.currentlyDue.length === 1 ? "" : "s"} before sponsors can bid.` : "Stripe is reviewing your details. Bidding opens once payments are enabled."; }
  else { badge = ["warn", "Not started"]; text = "Set up Stripe payouts so sponsors can bid and pay you directly."; }
  const button = p.ready ? null : el("button", {
    class: "btn btn-primary", type: "button", text: p.accountId ? "Continue Stripe setup" : "Set up payouts",
    onclick: async (event) => {
      event.currentTarget.disabled = true;
      try {
        const { url } = await api(`/api/dashboard/${encodeURIComponent(slug)}/connect/onboard`, { method: "POST" });
        window.location.assign(url);
      } catch (err) { toast(err.message, "error"); event.currentTarget.disabled = false; }
    }
  });
  return el("section", { class: "card" },
    el("div", { class: "card-head" }, el("h2", { text: "Payouts" }), el("span", { class: `badge badge-${badge[0]}`, text: badge[1] })),
    el("p", { class: "muted", text }), button);
}

function renderShare() {
  const { tenant } = summary;
  const copy = (value, label) => async (event) => {
    try { await navigator.clipboard.writeText(value); toast(`${label} copied`); }
    catch { event.currentTarget.previousElementSibling?.select?.(); toast("Press Ctrl/Cmd+C to copy", "error"); }
  };
  return el("section", { class: "card" },
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
  return el("section", { class: "card card-wide" },
    el("div", { class: "card-head" }, el("h2", { text: "Placements" }),
      el("div", { class: "filters", role: "tablist", "aria-label": "Filter placements" }, tabs.map((key) => el("button", {
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
  dash.replaceChildren(
    el("div", { class: "dash-head" }, el("div", {}, el("p", { class: "eyebrow", text: summary.tenant.eventName }), el("h1", { text: "Sponsorship dashboard" })),
      el("button", { class: "btn btn-ghost", type: "button", text: "Refresh", onclick: load })),
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

if (view === "dashboard") load();
