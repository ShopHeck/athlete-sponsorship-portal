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
    queue.replaceChildren(...reviews.map((entry) => {
      const card = element("article", "card admin-review-card");
      const header = element("div", "card-head");
      header.append(element("h2", "", entry.displayName));
      header.append(element("span", `badge badge-${entry.review?.status === "operator_review" ? "accent" : "warn"}`, entry.review?.status || "locked"));
      card.append(header);
      card.append(element("p", "muted", `${entry.slug} · ${entry.tenantStatus} · ${entry.build?.attempt || 0} build attempts`));
      if (entry.build?.jobId) card.append(element("p", "muted small", `Build ${entry.build.attempt}; ${entry.build.attemptsLeft} attempts left`));
      if (entry.review?.status !== "locked" && entry.build?.jobId) {
        const link = element("a", "btn btn-primary", "Open studio preview");
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
