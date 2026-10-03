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
