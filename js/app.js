// #APP_LOGIC
// Normal JKFixHub UI and application interactions live here.
// Three.js/WebGL rendering remains in scene.js.
import { initializeModalHandlers } from "./modals.js";
import { initializeNavigation } from "./navigation.js";
import { initializeSearch } from "./search.js";
import { initializeRequestFlow } from "./request.js";
import { initializeStore } from "./store.js";
import { initializeAuth } from "./auth.js";
import { setTextContent } from "./security.js";
import { initializeWorkerDashboard } from "./worker-dashboard.js";
import { initializeCustomerRequests } from "./customer-requests.js";
import { initializeChat } from "./chat.js";
import { initializeReviews } from "./reviews.js";
import { initializeReports } from "./reports.js";
import { initializeAdminDashboard } from "./admin-dashboard.js";

// ==========================================
// #UTILITY
// ==========================================
function showToast(message) {
  const toast = document.createElement("div");
  toast.className = "toast";
  setTextContent(toast, message);
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("show"));
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 220);
  }, 2200);
}

// ==========================================
// #REVEAL + POINTER
// ==========================================
function initializeRevealObserver() {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) entry.target.classList.add("visible");
    });
  }, { threshold: 0.12 });

  document.querySelectorAll(".reveal").forEach((element) => observer.observe(element));
}

function initializePointerMotion() {
  const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  if (!finePointer) return;

  document.addEventListener("pointermove", (event) => {
    const button = event.target.closest(".button, .nav-button");
    if (!button) return;
    const bounds = button.getBoundingClientRect();
    button.style.setProperty("--mag-x", `${(event.clientX - bounds.left - bounds.width / 2) * 0.055}px`);
    button.style.setProperty("--mag-y", `${(event.clientY - bounds.top - bounds.height / 2) * 0.055}px`);
  }, { passive: true });

  document.addEventListener("pointerout", (event) => {
    const button = event.target.closest(".button, .nav-button");
    if (!button || button.contains(event.relatedTarget)) return;
    button.style.removeProperty("--mag-x");
    button.style.removeProperty("--mag-y");
  });
}

function initializeApp() {
  initializeStore();
  initializeNavigation();
  initializeSearch({ showToast });
  initializeModalHandlers(showToast);
  initializeRequestFlow();
  initializeWorkerDashboard();
  initializeAuth();
  initializeCustomerRequests();
  initializeChat();
  initializeReviews();
  initializeReports({ showToast });
  initializeAdminDashboard({ showToast });
  initializeRevealObserver();
  initializePointerMotion();

  const heroSignInBtn = document.getElementById("heroSignInBtn");
  if (heroSignInBtn) {
    heroSignInBtn.addEventListener("click", () => {
      document.getElementById("authContinue")?.click();
    });
  }
}

initializeApp();
