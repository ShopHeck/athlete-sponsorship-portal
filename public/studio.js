const config = JSON.parse(document.getElementById("portal-config").textContent);
const studio = config.studio;
const shell = document.querySelector(".portal-shell");

if (studio && shell) {
  const review = studio.review || {};
  const bar = document.createElement("section");
  bar.className = "studio-bar";
  bar.setAttribute("aria-label", studio.mode === "operator" ? "Operator model review" : "Private model preview");
  document.body.classList.add("studio-preview");

  const copy = document.createElement("div");
  copy.className = "studio-copy";
  const eyebrow = document.createElement("p");
  eyebrow.className = "studio-eyebrow";
  eyebrow.textContent = studio.mode === "operator" ? "OPERATOR REVIEW" : "MODEL STUDIO";
  const heading = document.createElement("strong");
  heading.className = "studio-heading";
  heading.textContent = studio.mode === "operator" ? `Review ${studio.displayName}'s model` : "Private preview — only you can see this";
  const fit = document.createElement("p");
  fit.className = "studio-fit";
  fit.dataset.state = "checking";
  fit.setAttribute("aria-live", "polite");
  fit.textContent = "Checking placement fit…";
  const reviewStatus = document.createElement("p");
  reviewStatus.className = "studio-review-status";
  reviewStatus.setAttribute("aria-live", "polite");
  copy.append(eyebrow, heading, fit, reviewStatus);

  const controls = document.createElement("div");
  controls.className = "studio-controls";
  const error = document.createElement("p");
  error.className = "studio-error";
  error.setAttribute("role", "alert");
  error.hidden = true;
  const actions = document.createElement("div");
  actions.className = "studio-actions";
  controls.append(error, actions);
  bar.append(copy, controls);

  function button(label, action, className = "studio-button-primary") {
    const control = document.createElement("button");
    control.type = "button";
    control.className = `studio-button ${className}`.trim();
    control.textContent = label;
    control.addEventListener("click", action);
    actions.append(control);
    return control;
  }

  function showDialog({ title, label, required, submitText }) {
    return new Promise((resolve) => {
      const dialog = document.createElement("dialog");
      dialog.className = "studio-dialog";
      const form = document.createElement("form");
      form.method = "dialog";
      const headingNode = document.createElement("h2");
      headingNode.textContent = title;
      const noteLabel = document.createElement("label");
      noteLabel.textContent = label;
      noteLabel.htmlFor = "studio-note";
      const note = document.createElement("textarea");
      note.id = "studio-note";
      note.rows = 4;
      note.maxLength = 500;
      note.required = required;
      const counter = document.createElement("span");
      counter.className = "studio-char-count";
      counter.textContent = "0/500";
      note.addEventListener("input", () => {
        note.setCustomValidity("");
        counter.textContent = `${note.value.length}/500`;
      });
      const buttons = document.createElement("div");
      buttons.className = "studio-actions";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "studio-button studio-button-secondary";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => dialog.close("cancel"));
      const submit = document.createElement("button");
      submit.type = "submit";
      submit.className = "studio-button studio-button-primary";
      submit.textContent = submitText;
      buttons.append(cancel, submit);
      form.append(headingNode, noteLabel, note, counter, buttons);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        if (required && !note.value.trim()) {
          note.setCustomValidity("Add a note before sending this model back.");
          note.reportValidity();
          return;
        }
        dialog.close("submit");
      });
      dialog.addEventListener("close", () => {
        resolve(dialog.returnValue === "submit" ? note.value.trim() : null);
        dialog.remove();
      }, { once: true });
      dialog.append(form);
      document.body.append(dialog);
      dialog.showModal();
      note.focus();
    });
  }

  async function post(path, payload) {
    const response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
    return data;
  }

  async function runAction(control, path, payload) {
    error.hidden = true;
    actions.querySelectorAll("button").forEach((item) => { item.disabled = true; });
    reviewStatus.textContent = "Saving…";
    try {
      await post(path, payload);
      location.reload();
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
      reviewStatus.textContent = statusCopy();
      actions.querySelectorAll("button").forEach((item) => { item.disabled = false; });
      control.disabled = false;
    }
  }

  function statusCopy() {
    if (review.status === "athlete_review") return "Your model is ready for your approval.";
    if (review.status === "operator_review") return "Your model is with our team for sign-off.";
    if (review.status === "sent_back") return `Changes requested: ${review.operator?.note || "Please review and update your model."}`;
    if (review.status === "live") return "Your model is live on your portal.";
    return "Your private model preview is ready.";
  }

  function studioPath() {
    return `/api/dashboard/${encodeURIComponent(studio.slug)}/model/review`;
  }

  reviewStatus.textContent = statusCopy();
  if (studio.mode === "athlete") {
    if (["athlete_review", "sent_back"].includes(review.status)) {
      button("Approve model", (event) => runAction(event.currentTarget, studioPath(), {
        jobId: studio.jobId,
        decision: "approve"
      }));
      const rebuild = button(`Rebuild model (${studio.attemptsLeft} left)`, async (event) => {
        const control = event.currentTarget;
        const note = await showDialog({
          title: "Rebuild your model",
          label: "What would you like us to change? (optional)",
          required: false,
          submitText: "Rebuild model"
        });
        if (note === null) return;
        runAction(control, studioPath(), {
          jobId: studio.jobId,
          decision: "rebuild",
          note
        });
      }, "studio-button-secondary");
      rebuild.disabled = studio.attemptsLeft <= 0;
    }
  } else if (studio.mode === "operator") {
    if (review.status === "operator_review") {
      button("Publish to live portal", (event) => runAction(event.currentTarget,
        `/api/admin/${encodeURIComponent(studio.slug)}/model/publish`, { jobId: studio.jobId }));
      button("Send back", async (event) => {
        const control = event.currentTarget;
        const note = await showDialog({
          title: "Request a change",
          label: "Tell the athlete what needs attention.",
          required: true,
          submitText: "Send back"
        });
        if (note === null) return;
        runAction(control, `/api/admin/${encodeURIComponent(studio.slug)}/model/send-back`, {
          jobId: studio.jobId,
          note
        });
      }, "studio-button-secondary");
    } else if (review.status === "live") {
      button("Unpublish model", (event) => runAction(event.currentTarget,
        `/api/admin/${encodeURIComponent(studio.slug)}/model/unpublish`, {}), "studio-button-secondary");
    }
  }

  window.addEventListener("studio:fit", (event) => {
    const result = event.detail || {};
    if (result.error) {
      fit.dataset.state = "error";
      fit.textContent = "Placement fit could not be checked because the model did not load.";
    } else if (result.missing?.length) {
      fit.dataset.state = "attention";
      const missing = result.missing.map((item) => item.id).join(", ");
      const count = result.missing.length;
      fit.textContent = `${count} placement${count === 1 ? "" : "s"} need${count === 1 ? "s" : ""} attention: ${missing}`;
    } else {
      fit.dataset.state = "fit";
      fit.textContent = `All ${result.total ?? 0} placements fit your model`;
    }
  });

  shell.append(bar);
}
