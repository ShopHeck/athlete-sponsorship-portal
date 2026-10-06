const body = document.body;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    cache: "no-store",
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

if (body.dataset.view === "admin-login") {
  const form = document.getElementById("adminLoginForm");
  const error = document.getElementById("adminLoginError");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    error.hidden = true;
    try {
      await request("/api/admin/session", {
        method: "POST",
        body: JSON.stringify({ token: form.elements.token.value })
      });
      location.assign("/admin");
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    } finally {
      button.disabled = false;
    }
  });
}

if (body.dataset.view === "admin-queue") {
  const queue = document.getElementById("adminReviewQueue");
  const status = document.getElementById("adminQueueStatus");
  const applications = document.getElementById("adminApplications");
  const applicationsStatus = document.getElementById("adminApplicationsStatus");
  const applicationsCount = document.getElementById("adminApplicationsCount");
  const reviewLabels = {
    athlete_review: "Awaiting athlete",
    operator_review: "Ready for sign-off",
    sent_back: "Sent back",
    live: "Live",
    locked: "No build"
  };
  const reviewOrder = {
    operator_review: 0,
    sent_back: 1,
    athlete_review: 2,
    live: 3,
    locked: 4
  };
  const badgeVariants = {
    athlete_review: "warn",
    operator_review: "accent",
    sent_back: "warn",
    live: "ok",
    locked: "warn"
  };
  document.getElementById("adminLogout").addEventListener("click", async (event) => {
    event.currentTarget.disabled = true;
    try {
      await request("/api/admin/logout", { method: "POST" });
      location.assign("/admin");
    } catch (err) {
      status.textContent = err.message;
      event.currentTarget.disabled = false;
    }
  });
  const slugify = (name) => name.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 39) || "athlete";
  const futureDate = (source) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(source || "")) return source;
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + 30);
    return date.toISOString().slice(0, 10);
  };
  const renderApplication = (application, kits) => {
    const decision = application.decision?.status || "pending";
    const card = element("article", "card admin-application-card");
    const header = element("div", "card-head");
    header.append(element("h3", "", application.name));
    header.append(element("span", `badge badge-${decision === "created" ? "ok" : decision === "dismissed" ? "warn" : "accent"}`,
      decision[0].toUpperCase() + decision.slice(1)));
    card.append(header);
    card.append(element("p", "muted", `${application.email} · ${application.sport} · received ${new Date(application.receivedAt).toLocaleString()}`));
    const details = [application.phone, application.social, application.promotion, application.event, application.eventDate, application.message]
      .filter(Boolean).join(" · ");
    if (details) card.append(element("p", "muted small", details));
    if (decision !== "pending") {
      if (application.decision?.slug) {
        const links = element("p", "actions");
        const dashboard = element("a", "btn btn-ghost", "Dashboard");
        dashboard.href = `/dashboard/${encodeURIComponent(application.decision.slug)}`;
        const preview = element("a", "btn btn-ghost", "Preview");
        preview.href = `/${encodeURIComponent(application.decision.slug)}?preview=devpreview`;
        links.append(dashboard, preview);
        card.append(links);
      }
      return card;
    }
    const form = element("form", "stack admin-application-form");
    const kitMatch = kits.find((kit) => kit.sport.toLowerCase().includes(application.sport.toLowerCase().split("/")[0].trim().toLowerCase())) || kits[0];
    const options = kits.map((kit) => {
      const option = element("option", "", kit.name);
      option.value = kit.id;
      option.selected = kit.id === kitMatch?.id;
      return option;
    });
    const slug = element("input", "", "");
    slug.name = "slug"; slug.value = slugify(application.name); slug.required = true;
    const eventName = element("input", "", "");
    eventName.name = "eventName"; eventName.value = application.event || `${application.name} Fight Night`; eventName.required = true;
    const eventDate = element("input", "", "");
    eventDate.name = "eventDate"; eventDate.type = "date"; eventDate.value = futureDate(application.eventDate); eventDate.required = true;
    const kit = element("select", "", ""); kit.name = "kitId"; kit.append(...options);
    const timeZone = element("select", "", "");
    timeZone.name = "timeZone";
    ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Europe/London"]
      .forEach((zone) => { const option = element("option", "", zone); option.value = zone; timeZone.append(option); });
    const fee = element("input", "", ""); fee.name = "feePercent"; fee.type = "number"; fee.min = "1"; fee.max = "50"; fee.value = "10";
    const field = (label, input) => {
      const wrapper = element("label", "stack", label);
      wrapper.append(input);
      return wrapper;
    };
    form.append(
      field("Slug", slug),
      field("Starter kit", kit),
      field("Event name", eventName),
      field("Event date", eventDate),
      field("Timezone", timeZone),
      field("Platform fee (%)", fee)
    );
    const actions = element("div", "actions");
    const create = element("button", "btn btn-primary", "Create private portal"); create.type = "submit";
    const dismiss = element("button", "btn btn-ghost", "Dismiss"); dismiss.type = "button";
    actions.append(create, dismiss);
    form.append(actions);
    const error = element("p", "notice notice-error"); error.hidden = true;
    form.append(error);
    form.addEventListener("submit", async (event) => {
      event.preventDefault(); create.disabled = true; error.hidden = true;
      try {
        await request(`/api/admin/applications/${encodeURIComponent(application.id)}/create`, {
          method: "POST",
          body: JSON.stringify(Object.fromEntries(new FormData(form)))
        });
        await loadApplications();
      } catch (err) {
        error.textContent = err.message; error.hidden = false; create.disabled = false;
      }
    });
    dismiss.addEventListener("click", async () => {
      dismiss.disabled = true; error.hidden = true;
      try {
        await request(`/api/admin/applications/${encodeURIComponent(application.id)}/dismiss`, { method: "POST", body: "{}" });
        await loadApplications();
      } catch (err) {
        error.textContent = err.message; error.hidden = false; dismiss.disabled = false;
      }
    });
    card.append(form);
    return card;
  };
  async function loadApplications() {
    try {
      const data = await request("/api/admin/applications");
      const rows = Array.isArray(data.applications) ? data.applications : [];
      const pending = rows.filter((application) => (application.decision?.status || "pending") === "pending").length;
      applicationsCount.textContent = `${pending} pending`;
      applicationsStatus.hidden = true;
      applications.replaceChildren(...rows.map((application) => renderApplication(application, data.kits || [])));
      if (!rows.length) {
        applicationsStatus.textContent = "No athlete applications yet.";
        applicationsStatus.hidden = false;
      }
    } catch (err) {
      applicationsStatus.textContent = err.message;
      applicationsStatus.classList.add("notice-error");
    }
  }
  loadApplications();
  request("/api/admin/reviews").then((reviews) => {
    status.hidden = true;
    if (!Array.isArray(reviews) || reviews.length === 0) {
      status.textContent = "No tenant portals are configured.";
      status.hidden = false;
      return;
    }
    const ordered = [...reviews].sort((a, b) =>
      (reviewOrder[a.review?.status] ?? 5) - (reviewOrder[b.review?.status] ?? 5));
    queue.replaceChildren(...ordered.map((entry) => {
      const card = element("article", "card admin-review-card");
      const header = element("div", "card-head");
      header.append(element("h2", "", entry.displayName));
      const reviewStatus = entry.review?.status || "locked";
      header.append(element("span", `badge badge-${badgeVariants[reviewStatus] || "warn"}`,
        reviewLabels[reviewStatus] || reviewStatus));
      card.append(header);
      const attempt = Number(entry.build?.attempt) || 0;
      const attemptsLeft = Number(entry.build?.attemptsLeft) || 0;
      card.append(element("p", "muted", `${entry.slug} · ${entry.tenantStatus} · ${attempt} ${attempt === 1 ? "build attempt" : "build attempts"}`));
      if (entry.build?.jobId) {
        card.append(element("p", "muted small admin-review-meta",
          `Build ${attempt}; ${attemptsLeft} ${attemptsLeft === 1 ? "attempt" : "attempts"} left`));
      }
      const athleteApproval = entry.review?.athlete;
      if (athleteApproval?.decision === "approved") {
        const timestamp = Date.parse(athleteApproval.at);
        const approvedAt = Number.isFinite(timestamp)
          ? new Date(timestamp).toLocaleString()
          : athleteApproval.at || "time unavailable";
        card.append(element("p", "muted small admin-review-meta",
          `Approved by ${athleteApproval.by || "athlete"} · ${approvedAt}`));
        if (athleteApproval.note) {
          card.append(element("p", "muted small admin-review-note", `Athlete note: ${athleteApproval.note}`));
        }
      }
      if (reviewStatus === "sent_back" && entry.review?.operator?.note) {
        card.append(element("p", "muted small admin-review-note admin-review-note-operator",
          `Operator note: ${entry.review.operator.note}`));
      }
      if (entry.review?.status !== "locked" && entry.build?.jobId) {
        const link = element("a", `btn ${reviewStatus === "operator_review" ? "btn-primary" : "btn-ghost"}`,
          "Open studio preview");
        link.href = `/admin/${encodeURIComponent(entry.slug)}/studio`;
        card.append(link);
      }
      return card;
    }));
  }).catch((err) => {
    status.textContent = err.message;
    status.classList.add("notice-error");
  });
}
