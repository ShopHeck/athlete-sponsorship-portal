const form = document.getElementById("applyForm");
const errorEl = document.getElementById("applyError");
const button = document.getElementById("applyButton");
const success = document.getElementById("applySuccess");
const navToggle = document.querySelector(".nav-toggle");
const primaryNav = document.getElementById("primaryNav");
if (navToggle && primaryNav) {
  navToggle.hidden = false;
  const setNavOpen = (open) => {
    primaryNav.classList.toggle("is-open", open);
    navToggle.setAttribute("aria-expanded", String(open));
    navToggle.textContent = open ? "Close" : "Menu";
  };
  navToggle.addEventListener("click", () => setNavOpen(navToggle.getAttribute("aria-expanded") !== "true"));
  primaryNav.addEventListener("click", (event) => {
    if (event.target.closest("a")) setNavOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && navToggle.getAttribute("aria-expanded") === "true") {
      setNavOpen(false);
      navToggle.focus();
    }
  });
  window.matchMedia("(min-width:1081px)").addEventListener("change", () => setNavOpen(false));
}

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorEl.hidden = true;
  let firstInvalid = null;
  for (const field of form.querySelectorAll("input,select,textarea")) {
    const invalid = !field.checkValidity();
    field.setAttribute("aria-invalid", String(invalid));
    if (invalid && !firstInvalid) firstInvalid = field;
  }
  if (firstInvalid) {
    showError("Please fill in your name, a valid email, your social handle and your sport.");
    firstInvalid.focus();
    return;
  }
  const payload = Object.fromEntries(new FormData(form));
  const ref = new URLSearchParams(location.search).get("ref");
  if (ref) payload.ref = ref;
  button.disabled = true;
  button.textContent = "Sending…";
  try {
    const response = await fetch("/api/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Something went wrong. Please try again.");
    form.hidden = true;
    success.hidden = false;
    success.scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (error) {
    showError(error.message || "Something went wrong. Please try again.");
  } finally {
    button.disabled = false;
    button.textContent = "Send application";
  }
});

form?.addEventListener("input", (event) => {
  if (event.target.getAttribute("aria-invalid") === "true" && event.target.checkValidity()) {
    event.target.setAttribute("aria-invalid", "false");
  }
});
