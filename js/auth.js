// ==========================================
// #DEMO_AUTH
// ==========================================

// This temporary frontend-only authentication boundary
// is a UX demo, not authentication or authorization.
import { openModal } from "./modals.js";
import { openWorkerDashboard } from "./worker-dashboard.js";
import {
  clearRequestState,
  clearCurrentUser,
  getCurrentUser,
  getUserRole,
  getWorkerById,
  isAuthenticated,
  resetDemoChatState,
  setCurrentUser
} from "./store.js";
import { isSupportedRole, recordSecurityEvent, setTextContent } from "./security.js";

let initialized = false;

function demoLogin(role) {
  if (!isSupportedRole(role) || role === "admin") {
    recordSecurityEvent("ROLE_CHANGE_ATTEMPT", role);
    return false;
  }

  recordSecurityEvent("LOGIN_ATTEMPT", role);
  const createdAt = new Date().toISOString();

  if (role === "customer") {
    setCurrentUser({
      id: "demo-customer",
      role: "customer",
      name: "Demo Customer",
      email: null,
      phone: null,
      photo: null,
      district: null,
      createdAt
    });
    return true;
  }

  if (role === "worker") {
    const worker = getWorkerById(1);
    if (!worker) throw new Error("The demo worker account is unavailable.");
    setCurrentUser({
      id: `demo-worker-${worker.id}`,
      role: "worker",
      workerId: worker.id,
      name: worker.name,
      email: null,
      phone: null,
      photo: null,
      district: worker.district,
      createdAt
    });
    return true;
  }

  return false;
}

function demoLogout() {
  recordSecurityEvent("LOGOUT", getUserRole());
  resetDemoChatState();
  clearCurrentUser();
  clearRequestState();
}

function updateAccountControls() {
  const continueButton = document.getElementById("authContinue");
  const accountButton = document.getElementById("authAccount");
  const dashboardButton = document.getElementById("workerDashboardButton");
  const user = getCurrentUser();
  const role = getUserRole();
  const worker = user?.role === "worker" ? getWorkerById(user.workerId) : null;

  if (continueButton) continueButton.hidden = isAuthenticated();
  if (accountButton) {
    accountButton.hidden = !isAuthenticated();
    setTextContent(accountButton, "Account");
    accountButton.setAttribute("aria-label", user ? `${worker?.name || user.name} account` : "Account");
  }
  if (dashboardButton) dashboardButton.hidden = role !== "worker";
}

function showRoleSelection() {
  const modal = document.querySelector("#authModal .modal");
  modal.classList.remove("worker-dashboard-open");
  modal.setAttribute("aria-labelledby", "authModalTitle");
  document.getElementById("authFeedback").hidden = true;
  document.getElementById("authRoleSelection").hidden = false;
  document.getElementById("authAccountView").hidden = true;
  document.getElementById("workerDashboardView").hidden = true;
}

function showAccountView() {
  const modal = document.querySelector("#authModal .modal");
  modal.classList.remove("worker-dashboard-open");
  modal.setAttribute("aria-labelledby", "authAccountTitle");
  const user = getCurrentUser();
  if (!user) {
    showRoleSelection();
    return;
  }

  document.getElementById("authRoleSelection").hidden = true;
  document.getElementById("authAccountView").hidden = false;
  document.getElementById("workerDashboardView").hidden = true;
  const worker = user.role === "worker" ? getWorkerById(user.workerId) : null;
  setTextContent(document.getElementById("authUserName"), worker?.name || user.name);
  setTextContent(document.getElementById("authUserRole"), user.role === "customer" ? "Customer demo account" : "Worker demo account");
  document.getElementById("openWorkerDashboard").hidden = user.role !== "worker";
}

export function initializeAuth() {
  const modal = document.getElementById("authModal");
  if (!modal || initialized) return;
  initialized = true;

  updateAccountControls();
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    if (target.closest("#authContinue")) {
      showRoleSelection();
      openModal("authModal");
    } else if (target.closest("#authAccount")) {
      showAccountView();
      openModal("authModal");
    } else if (target.closest("[data-auth-role]")) {
      const role = target.closest("[data-auth-role]").dataset.authRole;
      if (!demoLogin(role)) {
        const feedback = document.getElementById("authFeedback");
        setTextContent(feedback, "That demo account is not available.");
        feedback.hidden = false;
        return;
      }
      updateAccountControls();
      showAccountView();
    } else if (target.closest("#authLogout, #authLogoutFromDashboard")) {
      demoLogout();
      updateAccountControls();
      showRoleSelection();
    } else if (target.closest("#workerDashboardButton")) {
      if (openWorkerDashboard()) openModal("authModal");
    } else if (target.closest("#openWorkerDashboard")) {
      openWorkerDashboard();
    } else if (target.closest("#backToAccount")) {
      showAccountView();
    } else if (target.closest("#authBackToRoles")) {
      showRoleSelection();
    }
  });
}
