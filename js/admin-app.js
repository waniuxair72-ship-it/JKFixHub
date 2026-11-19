// ==========================================
// #ADMIN_APP
// ==========================================
// Dedicated Application Controller & Command Center for [JK] FixHub Admin Panel.
//
// Security Design:
// 1. Strictly authenticated via Firebase Auth + Firestore /admins/{uid} verification.
// 2. Pure DOM manipulation (document.createElement, textContent); zero unsafe string injection.
// 3. Every administrative action generates a real audit trail record in /auditLogs.
// 4. Role tampering in client memory does not compromise backend database security.
// 5. Fail-closed architecture: no content or navigation rendered without verified admin session.
// ==========================================

import {
  signInAdmin,
  signOutAdmin,
  getAdminSession,
  hasAdminCapability,
  subscribeAdminAuthState,
  initializeAdminAuth
} from "./admin-auth.js";

import { shouldConnectToEmulator } from "./firebase-config.js";

import {
  getAdminOverviewStats,
  getAdminWorkers,
  updateAdminWorkerStatus,
  getAdminCustomers,
  subscribeToAdminCustomers,
  updateAdminCustomerStatus,
  getAdminRequests,
  updateAdminRequestStatus,
  getAdminReports,
  updateAdminReportStatus,
  getAdminReviews,
  updateAdminReviewStatus,
  getAdminSecurityEvents,
  getAdminAuditLogs,
  getAdminPlatformConfig
} from "./firestore-service.js";

import {
  renderPlatformControlsView,
  renderAnnouncementsView,
  renderServicesDistrictsView,
  renderAnalyticsView
} from "./admin-platform-views.js";

import {
  renderCustomerVerificationView,
  renderVerificationBadgesView
} from "./admin-verification-views.js";

import {
  createVerifiedCustomerBadge,
  createVerifiedWorkerBadge
} from "./badges.js";
import {
  isWorkerOfficiallyVerified,
  normalizeCustomerVerification
} from "./membership-schema.js";

import { isMaintenanceCurrentlyActive } from "./platform-config.js";
import { initializeTheme } from "./theme.js";
import { initializeAdminCanvas } from "./admin-canvas.js";

// ----------------------------------------------------------------------------
// Architectural Constants (11-Section Platform Control Centre)
// ----------------------------------------------------------------------------
const NAV_GROUPS = [
  {
    category: "COMMAND",
    items: [
      { id: "overview", label: "Overview", icon: "📊" },
      { id: "analytics", label: "Analytics", icon: "📈" }
    ]
  },
  {
    category: "OPERATIONS",
    items: [
      { id: "customers", label: "Customers", icon: "👥" },
      { id: "workers", label: "Workers", icon: "🛠️" },
      { id: "requests", label: "Service Requests", icon: "📋" }
    ]
  },
  {
    category: "PLATFORM",
    items: [
      { id: "announcements", label: "Announcements", icon: "📢" },
      { id: "platform-controls", label: "Platform Controls", icon: "🎛️" },
      { id: "services-districts", label: "Services and Districts", icon: "🗺️" }
    ]
  },
  {
    category: "TRUST & SAFETY",
    items: [
      { id: "customer-verification", label: "Customer Verification", icon: "🪪" },
      { id: "verification-badges", label: "Verification & Badges", icon: "🏅" },
      { id: "reports-moderation", label: "Reports and Moderation", icon: "🛡️" }
    ]
  },
  {
    category: "SYSTEM",
    items: [
      { id: "security-audit", label: "Security and Audit Logs", icon: "🔒" },
      { id: "settings", label: "Settings", icon: "⚙️" }
    ]
  }
];

const JK_DISTRICTS = [
  "Anantnag", "Bandipora", "Baramulla", "Budgam", "Doda",
  "Ganderbal", "Jammu", "Kathua", "Kishtwar", "Kulgam",
  "Kupwara", "Poonch", "Pulwama", "Rajouri", "Ramban",
  "Reasi", "Samba", "Shopian", "Srinagar", "Udhampur"
];

const CORE_CATEGORIES = [
  "Electrical", "Plumbing", "Carpentry", "Painting",
  "Appliance Repair", "HVAC", "Cleaning", "Masonry",
  "Pest Control", "Roofing", "Landscaping", "General Maintenance"
];

// ----------------------------------------------------------------------------
// Runtime State
// ----------------------------------------------------------------------------
let activeTab = "overview";
let activeReportsSubTab = "reports";
let activeSecuritySubTab = "security";
let currentAdmin = null;

const tabFilterState = {
  workers: { query: "", status: "all", verification: "all", district: "all" },
  customers: { query: "", status: "all", verification: "all", district: "all" },
  requests: { query: "", status: "all" },
  reports: { query: "", status: "all" },
  reviews: { query: "", status: "all", rating: "all" },
  security: { query: "", severity: "all" },
  audit: { query: "", result: "all" }
};

// ----------------------------------------------------------------------------
// Utility Helpers & Modals
// ----------------------------------------------------------------------------
function showToast(message) {
  const toast = document.getElementById("adminToast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("show");
  setTimeout(() => {
    toast.classList.remove("show");
  }, 3200);
}

function showConfirmModal({ title, body, confirmText = "Confirm", onConfirm }) {
  const modalBackdrop = document.getElementById("adminActionModal");
  const modalTitle = document.getElementById("adminModalTitle");
  const modalBody = document.getElementById("adminModalBody");
  const confirmBtn = document.getElementById("adminModalConfirm");
  const cancelBtn = document.getElementById("adminModalCancel");
  const closeBtn = document.getElementById("adminModalClose");
  const modalCard = modalBackdrop ? modalBackdrop.querySelector(".admin-modal") : null;

  if (!modalBackdrop || !modalTitle || !modalBody || !confirmBtn) return;

  if (modalCard) modalCard.classList.remove("wide");
  modalTitle.textContent = title;
  modalBody.textContent = body;
  confirmBtn.textContent = confirmText;
  if (cancelBtn) cancelBtn.hidden = false;
  modalBackdrop.hidden = false;

  const cleanup = () => {
    modalBackdrop.hidden = true;
    confirmBtn.onclick = null;
    if (cancelBtn) cancelBtn.onclick = null;
    if (closeBtn) closeBtn.onclick = null;
  };

  confirmBtn.onclick = async () => {
    cleanup();
    if (typeof onConfirm === "function") {
      await onConfirm();
    }
  };

  if (cancelBtn) cancelBtn.onclick = cleanup;
  if (closeBtn) closeBtn.onclick = cleanup;
}

function showReasonConfirmModal({ title, description, reasonLabel = "Reason (recorded in audit log)", placeholder = "Enter reason...", required = false, confirmText = "Confirm", onConfirm }) {
  const modalBackdrop = document.getElementById("adminActionModal");
  const modalTitle = document.getElementById("adminModalTitle");
  const modalBody = document.getElementById("adminModalBody");
  const confirmBtn = document.getElementById("adminModalConfirm");
  const cancelBtn = document.getElementById("adminModalCancel");
  const closeBtn = document.getElementById("adminModalClose");
  const modalCard = modalBackdrop ? modalBackdrop.querySelector(".admin-modal") : null;

  if (!modalBackdrop || !modalTitle || !modalBody || !confirmBtn) return;
  if (modalCard) modalCard.classList.remove("wide");

  modalTitle.textContent = title;
  const wrap = document.createElement("div");
  const descEl = document.createElement("p");
  descEl.style.marginTop = "0";
  descEl.textContent = description;

  const errEl = document.createElement("div");
  errEl.className = "admin-alert-banner";
  errEl.hidden = true;

  const grp = document.createElement("div");
  grp.className = "admin-form-group";
  const lbl = document.createElement("label");
  lbl.htmlFor = "adminActionReasonInput";
  lbl.textContent = reasonLabel;
  const textarea = document.createElement("textarea");
  textarea.id = "adminActionReasonInput";
  textarea.rows = 3;
  textarea.maxLength = 500;
  textarea.placeholder = placeholder;
  grp.append(lbl, textarea);

  wrap.append(descEl, errEl, grp);
  modalBody.replaceChildren(wrap);
  confirmBtn.textContent = confirmText;
  if (cancelBtn) cancelBtn.hidden = false;
  modalBackdrop.hidden = false;
  textarea.focus();

  const cleanup = () => {
    modalBackdrop.hidden = true;
    confirmBtn.onclick = null;
    if (cancelBtn) cancelBtn.onclick = null;
    if (closeBtn) closeBtn.onclick = null;
  };

  confirmBtn.onclick = async () => {
    const val = textarea.value.trim();
    if (required && val.length < 3) {
      errEl.textContent = "Please provide a brief reason (at least 3 characters).";
      errEl.hidden = false;
      textarea.focus();
      return;
    }
    cleanup();
    if (typeof onConfirm === "function") {
      await onConfirm(val);
    }
  };

  if (cancelBtn) cancelBtn.onclick = cleanup;
  if (closeBtn) closeBtn.onclick = cleanup;
}

function applyResponsiveTableLabels(table) {
  if (!table) return;
  table.classList.add("admin-table-responsive");
  const headers = Array.from(table.querySelectorAll("thead th")).map((th) => th.textContent.trim());
  table.querySelectorAll("tbody tr").forEach((tr) => {
    Array.from(tr.children).forEach((td, idx) => {
      if (headers[idx] && !td.getAttribute("data-label")) {
        td.setAttribute("data-label", headers[idx]);
      }
    });
  });
}

function updateTopbarMaintenanceBadge(config) {
  const pill = document.getElementById("adminTopbarSecurityPill");
  const text = document.getElementById("adminTopbarSecurityText");
  if (!pill || !text) return;
  const active = isMaintenanceCurrentlyActive(config);
  pill.classList.toggle("maintenance-on", active);
  text.textContent = active ? "MAINTENANCE MODE ACTIVE" : "SYSTEM SECURE — RBAC ACTIVE";
}

function showDetailModal({ title, contentNode, isWide = true }) {
  const modalBackdrop = document.getElementById("adminActionModal");
  const modalTitle = document.getElementById("adminModalTitle");
  const modalBody = document.getElementById("adminModalBody");
  const confirmBtn = document.getElementById("adminModalConfirm");
  const cancelBtn = document.getElementById("adminModalCancel");
  const closeBtn = document.getElementById("adminModalClose");
  const modalCard = modalBackdrop ? modalBackdrop.querySelector(".admin-modal") : null;

  if (!modalBackdrop || !modalTitle || !modalBody || !confirmBtn) return;

  if (modalCard) modalCard.classList.toggle("wide", Boolean(isWide));
  modalTitle.textContent = title;
  modalBody.replaceChildren(contentNode);
  confirmBtn.textContent = "Close";
  if (cancelBtn) cancelBtn.hidden = true;
  modalBackdrop.hidden = false;

  const cleanup = () => {
    modalBackdrop.hidden = true;
    if (cancelBtn) cancelBtn.hidden = false;
    if (modalCard) modalCard.classList.remove("wide");
    confirmBtn.onclick = null;
    if (closeBtn) closeBtn.onclick = null;
  };

  confirmBtn.onclick = cleanup;
  if (closeBtn) closeBtn.onclick = cleanup;
}

function createDetailItem(label, value, fullWidth = false) {
  const item = document.createElement("div");
  item.className = fullWidth ? "admin-detail-item full-width" : "admin-detail-item";
  const lbl = document.createElement("div");
  lbl.className = "admin-detail-label";
  lbl.textContent = label;
  const val = document.createElement("div");
  val.className = "admin-detail-value";
  if (value instanceof HTMLElement) {
    val.appendChild(value);
  } else {
    val.textContent = String(value ?? "—");
  }
  item.appendChild(lbl);
  item.appendChild(val);
  return item;
}

/**
 * Safely parses any date/timestamp representation into a valid JS Date object.
 * Handles:
 * - Firestore Timestamp instances (.toDate(), .toMillis())
 * - Firestore Timestamp objects ({ seconds, nanoseconds }, { _seconds, _nanoseconds })
 * - ISO-8601 / UTC strings
 * - Epoch millisecond and second numbers
 * - Native Date objects
 * Returns null if missing, empty, or unparseable.
 *
 * @param {*} raw
 * @returns {Date|null}
 */
function parseDate(raw) {
  if (raw === null || raw === undefined || raw === "") return null;

  if (raw instanceof Date) {
    return isNaN(raw.getTime()) ? null : raw;
  }

  if (typeof raw.toDate === "function") {
    try {
      const d = raw.toDate();
      return (d instanceof Date && !isNaN(d.getTime())) ? d : null;
    } catch {
      // Fall through
    }
  }

  if (typeof raw.toMillis === "function") {
    try {
      const ms = raw.toMillis();
      if (typeof ms === "number" && !isNaN(ms)) {
        const d = new Date(ms);
        return isNaN(d.getTime()) ? null : d;
      }
    } catch {
      // Fall through
    }
  }

  if (typeof raw === "object") {
    const sec = typeof raw.seconds === "number" ? raw.seconds : (typeof raw._seconds === "number" ? raw._seconds : null);
    const nsec = typeof raw.nanoseconds === "number" ? raw.nanoseconds : (typeof raw._nanoseconds === "number" ? raw._nanoseconds : 0);
    if (sec !== null && !isNaN(sec)) {
      const d = new Date(sec * 1000 + Math.floor(nsec / 1e6));
      return isNaN(d.getTime()) ? null : d;
    }
  }

  if (typeof raw === "number" && !isNaN(raw)) {
    const d = new Date(raw < 1e11 ? raw * 1000 : raw);
    return isNaN(d.getTime()) ? null : d;
  }

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) {
      const num = Number(trimmed);
      if (!isNaN(num)) {
        const d = new Date(num < 1e11 ? num * 1000 : num);
        if (!isNaN(d.getTime())) return d;
      }
    }
    const d = new Date(trimmed);
    return isNaN(d.getTime()) ? null : d;
  }

  return null;
}

/**
 * Formats any timestamp representation into a clean human-readable date and time.
 * Returns an honest fallback ("Unknown time") if the timestamp is missing or unparseable.
 * Never produces "Invalid Date".
 *
 * @param {*} raw
 * @param {string} [fallback="Unknown time"]
 * @returns {string}
 */
function formatDateTime(raw, fallback = "Unknown time") {
  const d = parseDate(raw);
  if (!d) return fallback;
  return d.toLocaleString();
}

/**
 * Formats any timestamp representation into a clean date-only string.
 * Returns an honest fallback ("Unknown date") if the timestamp is missing or unparseable.
 * Never produces "Invalid Date".
 *
 * @param {*} raw
 * @param {string} [fallback="Unknown date"]
 * @returns {string}
 */
function formatDateOnly(raw, fallback = "Unknown date") {
  const d = parseDate(raw);
  if (!d) return fallback;
  return d.toLocaleDateString();
}

function navigateToTab(tabId, filterOptions = null) {
  let targetTab = (tabId === "dashboard") ? "overview" : tabId;
  if (targetTab === "reports" || targetTab === "reviews" || targetTab === "trust-safety") {
    activeReportsSubTab = targetTab;
    if (filterOptions && tabFilterState[targetTab]) {
      Object.assign(tabFilterState[targetTab], filterOptions);
    }
    targetTab = "reports-moderation";
  } else if (targetTab === "security" || targetTab === "audit") {
    activeSecuritySubTab = targetTab;
    if (filterOptions && tabFilterState[targetTab]) {
      Object.assign(tabFilterState[targetTab], filterOptions);
    }
    targetTab = "security-audit";
  } else if (filterOptions && tabFilterState[targetTab]) {
    Object.assign(tabFilterState[targetTab], filterOptions);
  }
  activeTab = targetTab;

  // Close mobile drawer if open
  const sidebar = document.getElementById("adminSidebar");
  const overlay = document.getElementById("adminSidebarOverlay");
  const toggleBtn = document.getElementById("adminNavToggleBtn");
  if (sidebar) sidebar.classList.remove("nav-open");
  if (overlay) overlay.classList.remove("active");
  if (toggleBtn) toggleBtn.setAttribute("aria-expanded", "false");
  renderActiveView();
}

function getPlatformViewContext() {
  return {
    currentAdmin,
    showToast,
    showConfirmModal,
    showReasonConfirmModal,
    showDetailModal,
    formatDateTime,
    formatDateOnly,
    navigateToTab,
    applyResponsiveTableLabels,
    updateTopbarMaintenanceBadge
  };
}

async function renderReportsModerationView(container) {
  container.replaceChildren();
  const subTabs = document.createElement("div");
  subTabs.className = "admin-subtabs";
  subTabs.setAttribute("role", "tablist");
  subTabs.setAttribute("aria-label", "Reports and Moderation sections");

  const tabs = [
    { id: "reports", label: "🚨 Reports Queue" },
    { id: "reviews", label: "⭐ Reviews Moderation" },
    { id: "trust-safety", label: "🛡️ Trust & Safety Hub" }
  ];

  const subContent = document.createElement("div");
  const renderSub = async () => {
    subTabs.querySelectorAll(".admin-subtab-btn").forEach((b) => {
      const isAct = b.dataset.subTab === activeReportsSubTab;
      b.classList.toggle("active", isAct);
      b.setAttribute("aria-selected", isAct ? "true" : "false");
    });
    subContent.replaceChildren();
    const loading = document.createElement("div");
    loading.className = "admin-loading-state";
    const sp = document.createElement("div");
    sp.className = "admin-loading-spinner";
    const lp = document.createElement("p");
    lp.textContent = "Loading moderation data...";
    loading.append(sp, lp);
    subContent.appendChild(loading);

    if (activeReportsSubTab === "reviews") {
      await renderReviewsView(subContent);
    } else if (activeReportsSubTab === "trust-safety") {
      await renderTrustSafetyView(subContent);
    } else {
      await renderReportsView(subContent);
    }
    subContent.querySelectorAll("table.admin-table").forEach(applyResponsiveTableLabels);
  };

  for (const t of tabs) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `admin-subtab-btn${t.id === activeReportsSubTab ? " active" : ""}`;
    btn.dataset.subTab = t.id;
    btn.setAttribute("role", "tab");
    btn.textContent = t.label;
    btn.onclick = () => {
      activeReportsSubTab = t.id;
      renderSub();
    };
    subTabs.appendChild(btn);
  }

  container.append(subTabs, subContent);
  await renderSub();
}

async function renderSecurityAuditView(container) {
  container.replaceChildren();
  const subTabs = document.createElement("div");
  subTabs.className = "admin-subtabs";
  subTabs.setAttribute("role", "tablist");
  subTabs.setAttribute("aria-label", "Security and Audit Log sections");

  const tabs = [
    { id: "security", label: "🔒 Security Signals" },
    { id: "audit", label: "📜 Immutable Audit Log" }
  ];

  const subContent = document.createElement("div");
  const renderSub = async () => {
    subTabs.querySelectorAll(".admin-subtab-btn").forEach((b) => {
      const isAct = b.dataset.subTab === activeSecuritySubTab;
      b.classList.toggle("active", isAct);
      b.setAttribute("aria-selected", isAct ? "true" : "false");
    });
    subContent.replaceChildren();
    const loading = document.createElement("div");
    loading.className = "admin-loading-state";
    const sp = document.createElement("div");
    sp.className = "admin-loading-spinner";
    const lp = document.createElement("p");
    lp.textContent = "Loading security records...";
    loading.append(sp, lp);
    subContent.appendChild(loading);

    if (activeSecuritySubTab === "audit") {
      await renderAuditLogView(subContent);
    } else {
      await renderSecurityView(subContent);
    }
    subContent.querySelectorAll("table.admin-table").forEach(applyResponsiveTableLabels);
  };

  for (const t of tabs) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `admin-subtab-btn${t.id === activeSecuritySubTab ? " active" : ""}`;
    btn.dataset.subTab = t.id;
    btn.setAttribute("role", "tab");
    btn.textContent = t.label;
    btn.onclick = () => {
      activeSecuritySubTab = t.id;
      renderSub();
    };
    subTabs.appendChild(btn);
  }

  container.append(subTabs, subContent);
  await renderSub();
}

// ----------------------------------------------------------------------------
// View Rendering Dispatcher
// ----------------------------------------------------------------------------
let activeCustomersUnsubscribe = null;

async function renderActiveView() {
  if (typeof activeCustomersUnsubscribe === "function") {
    try { activeCustomersUnsubscribe(); } catch (_) {}
    activeCustomersUnsubscribe = null;
  }

  if (!currentAdmin || currentAdmin.role !== "admin" || currentAdmin.active !== true) {
    unmountAdminShell();
    return;
  }

  const container = document.getElementById("adminMainContent");
  if (!container) return;

  container.replaceChildren();

  // Highlight active tab in navigation
  const effectiveTab = (activeTab === "dashboard") ? "overview" : activeTab;
  document.querySelectorAll(".admin-nav-item").forEach((btn) => {
    const isCurrent = btn.dataset.adminTab === effectiveTab ||
      (effectiveTab === "overview" && btn.dataset.adminTab === "dashboard");
    btn.classList.toggle("active", isCurrent);
    if (isCurrent) {
      btn.setAttribute("aria-current", "page");
    } else {
      btn.removeAttribute("aria-current");
    }
  });

  const loadingWrap = document.createElement("div");
  loadingWrap.className = "admin-loading-state";
  const spinner = document.createElement("div");
  spinner.className = "admin-loading-spinner";
  const loadingText = document.createElement("p");
  loadingText.textContent = "Loading live platform data...";
  loadingWrap.append(spinner, loadingText);
  container.appendChild(loadingWrap);

  try {
    switch (effectiveTab) {
      case "overview":
      case "dashboard":
        await renderOverviewView(container);
        break;
      case "analytics":
        await renderAnalyticsView(container, getPlatformViewContext());
        break;
      case "workers":
        await renderWorkersView(container);
        break;
      case "customers":
        await renderCustomersView(container);
        break;
      case "requests":
        await renderRequestsView(container);
        break;
      case "announcements":
        await renderAnnouncementsView(container, getPlatformViewContext());
        break;
      case "platform-controls":
        await renderPlatformControlsView(container, getPlatformViewContext());
        break;
      case "services-districts":
        await renderServicesDistrictsView(container, getPlatformViewContext());
        break;
      case "customer-verification":
        await renderCustomerVerificationView(container, getPlatformViewContext());
        break;
      case "verification-badges":
        await renderVerificationBadgesView(container, getPlatformViewContext());
        break;
      case "reports-moderation":
      case "reports":
      case "reviews":
      case "trust-safety":
        await renderReportsModerationView(container);
        break;
      case "security-audit":
      case "security":
      case "audit":
        await renderSecurityAuditView(container);
        break;
      case "settings":
        await renderSettingsView(container);
        break;
      default:
        await renderOverviewView(container);
    }
    container.querySelectorAll("table.admin-table").forEach(applyResponsiveTableLabels);
  } catch (err) {
    console.error("[JKFixHub Admin] View render error:", err);
    container.replaceChildren();
    const errBox = document.createElement("div");
    errBox.className = "admin-error-state";
    const h3 = document.createElement("h3");
    h3.textContent = "Could not load this section";
    const ep = document.createElement("p");
    ep.textContent = err?.message || "A connection error occurred while reading live data.";
    const retryBtn = document.createElement("button");
    retryBtn.type = "button";
    retryBtn.className = "admin-btn-primary";
    retryBtn.textContent = "Retry";
    retryBtn.onclick = () => renderActiveView();
    errBox.append(h3, ep, retryBtn);
    container.appendChild(errBox);
  }
}

// ----------------------------------------------------------------------------
// 1. COMMAND: Overview (Command Center)
// ----------------------------------------------------------------------------
async function renderOverviewView(container) {
  const [stats, auditLogs, platformConfig] = await Promise.all([
    getAdminOverviewStats(),
    getAdminAuditLogs(),
    getAdminPlatformConfig()
  ]);

  updateTopbarMaintenanceBadge(platformConfig);
  container.replaceChildren();

  // Header
  const header = document.createElement("div");
  header.className = "admin-view-header";
  const titleBox = document.createElement("div");
  titleBox.className = "admin-view-title";
  const h2 = document.createElement("h2");
  h2.textContent = "Platform Control Centre";
  const p = document.createElement("p");
  p.textContent = "Live operational indicators, platform switches, priority queues, and immutable audit trail.";
  titleBox.appendChild(h2);
  titleBox.appendChild(p);
  header.appendChild(titleBox);
  container.appendChild(header);

  // Section: Live Platform Operational Status
  const healthPanel = document.createElement("div");
  healthPanel.className = "admin-health-panel";
  const healthTitle = document.createElement("h3");
  healthTitle.textContent = "Live Platform Operational Status";
  healthPanel.appendChild(healthTitle);

  const healthGrid = document.createElement("div");
  healthGrid.className = "admin-health-grid";

  const maintOn = isMaintenanceCurrentlyActive(platformConfig);
  const healthItems = [
    {
      name: "Maintenance Mode",
      status: maintOn ? "ACTIVE — Public notice visible" : "Inactive (Normal operations)",
      dot: maintOn ? "warn" : "ok"
    },
    {
      name: "Customer Signup",
      status: platformConfig.customerRegistrationEnabled ? "Open for registrations" : "PAUSED by Admin",
      dot: platformConfig.customerRegistrationEnabled ? "ok" : "warn"
    },
    {
      name: "Worker Signup",
      status: platformConfig.workerRegistrationEnabled ? "Open for onboarding" : "PAUSED by Admin",
      dot: platformConfig.workerRegistrationEnabled ? "ok" : "warn"
    },
    {
      name: "New Requests",
      status: platformConfig.newRequestsEnabled ? "Accepting customer requests" : "PAUSED by Admin",
      dot: platformConfig.newRequestsEnabled ? "ok" : "warn"
    },
    {
      name: "Security & RBAC",
      status: "Enforced (/admins/{uid} Fail-Closed)",
      dot: "ok"
    }
  ];

  for (const item of healthItems) {
    const el = document.createElement("div");
    el.className = "admin-health-item";

    const dot = document.createElement("span");
    dot.className = `admin-health-dot ${item.dot}`;

    const info = document.createElement("div");
    info.className = "admin-health-info";
    const name = document.createElement("span");
    name.className = "admin-health-name";
    name.textContent = item.name;
    const st = document.createElement("span");
    st.className = "admin-health-status";
    st.textContent = item.status;
    info.appendChild(name);
    info.appendChild(st);

    el.appendChild(dot);
    el.appendChild(info);
    healthGrid.appendChild(el);
  }
  healthPanel.appendChild(healthGrid);
  container.appendChild(healthPanel);

  // Section: Metrics Grid
  const metricsGrid = document.createElement("div");
  metricsGrid.className = "admin-metrics-grid";

  const metrics = [
    { label: "Total Customers", value: stats.totalCustomers, note: "Registered customer accounts" },
    { label: "Total Workers", value: stats.totalWorkers, note: "Directory service professionals" },
    { label: "Waiting for Review", value: stats.pendingWorkerVerification, note: "Worker profiles waiting for review" },
    { label: "Active Requests", value: stats.activeRequests, note: "Pending or Accepted status" },
    { label: "Completed Requests", value: stats.completedRequests, note: "Successfully fulfilled" },
    { label: "Open Reports", value: stats.openReports, note: "Trust & Safety inquiries" },
    { label: "Reported Reviews", value: stats.reportedReviews, note: "Flagged customer feedback" },
    { label: "Security Signals", value: stats.securityEvents, note: "Logged security signals" }
  ];

  for (const m of metrics) {
    const card = document.createElement("div");
    card.className = "admin-metric-card";

    const label = document.createElement("div");
    label.className = "admin-metric-label";
    label.textContent = m.label;

    const val = document.createElement("div");
    val.className = "admin-metric-value";
    val.textContent = String(m.value);

    const note = document.createElement("div");
    note.className = "admin-metric-note";
    note.textContent = m.note;

    card.appendChild(label);
    card.appendChild(val);
    card.appendChild(note);
    metricsGrid.appendChild(card);
  }
  container.appendChild(metricsGrid);

  // Section: Attention Queues / Action Required
  const actionHeading = document.createElement("div");
  actionHeading.className = "admin-section-heading";
  const actionH3 = document.createElement("h3");
  actionH3.textContent = "Action Required & Priority Queues";
  const actionSub = document.createElement("p");
  actionSub.textContent = "Operational bottlenecks requiring administrative action.";
  actionHeading.appendChild(actionH3);
  actionHeading.appendChild(actionSub);
  container.appendChild(actionHeading);

  const attentionGrid = document.createElement("div");
  attentionGrid.className = "admin-attention-grid";

  // 1. Worker Verifications Queue
  const workerCard = document.createElement("div");
  workerCard.className = `admin-attention-card${stats.pendingWorkerVerification > 0 ? " urgent" : ""}`;
  const workerHead = document.createElement("div");
  workerHead.className = "admin-attention-header";
  const workerTitle = document.createElement("span");
  workerTitle.className = "admin-attention-title";
  workerTitle.textContent = "Workers Waiting for Review";
  workerHead.appendChild(workerTitle);
  const workerDesc = document.createElement("div");
  workerDesc.className = "admin-attention-desc";
  workerDesc.textContent = stats.pendingWorkerVerification > 0
    ? `${stats.pendingWorkerVerification} worker profile(s) waiting for review before appearing on the website.`
    : "All registered workers are currently verified or reviewed.";
  const workerFooter = document.createElement("div");
  workerFooter.className = "admin-attention-footer";
  const workerCount = document.createElement("span");
  workerCount.className = `admin-attention-count${stats.pendingWorkerVerification > 0 ? " warn" : ""}`;
  workerCount.textContent = String(stats.pendingWorkerVerification);
  const workerBtn = document.createElement("button");
  workerBtn.type = "button";
  workerBtn.className = "admin-table-btn";
  workerBtn.textContent = "Review Workers →";
  workerBtn.onclick = () => navigateToTab("workers", { verification: "pending" });
  workerFooter.appendChild(workerCount);
  workerFooter.appendChild(workerBtn);
  workerCard.appendChild(workerHead);
  workerCard.appendChild(workerDesc);
  workerCard.appendChild(workerFooter);
  attentionGrid.appendChild(workerCard);

  // 2. Incident Reports Queue
  const repCard = document.createElement("div");
  repCard.className = `admin-attention-card${stats.openReports > 0 ? " urgent" : ""}`;
  const repHead = document.createElement("div");
  repHead.className = "admin-attention-header";
  const repTitle = document.createElement("span");
  repTitle.className = "admin-attention-title";
  repTitle.textContent = "Open Safety Reports";
  repHead.appendChild(repTitle);
  const repDesc = document.createElement("div");
  repDesc.className = "admin-attention-desc";
  repDesc.textContent = stats.openReports > 0
    ? `${stats.openReports} trust & safety report(s) requiring review or resolution.`
    : "Zero pending safety reports currently active.";
  const repFooter = document.createElement("div");
  repFooter.className = "admin-attention-footer";
  const repCount = document.createElement("span");
  repCount.className = `admin-attention-count${stats.openReports > 0 ? " alert" : ""}`;
  repCount.textContent = String(stats.openReports);
  const repBtn = document.createElement("button");
  repBtn.type = "button";
  repBtn.className = "admin-table-btn";
  repBtn.textContent = "Inspect Reports →";
  repBtn.onclick = () => navigateToTab("reports", { status: "pending" });
  repFooter.appendChild(repCount);
  repFooter.appendChild(repBtn);
  repCard.appendChild(repHead);
  repCard.appendChild(repDesc);
  repCard.appendChild(repFooter);
  attentionGrid.appendChild(repCard);

  // 3. Flagged Reviews Queue
  const revCard = document.createElement("div");
  revCard.className = `admin-attention-card${stats.reportedReviews > 0 ? " urgent" : ""}`;
  const revHead = document.createElement("div");
  revHead.className = "admin-attention-header";
  const revTitle = document.createElement("span");
  revTitle.className = "admin-attention-title";
  revTitle.textContent = "Flagged Reviews";
  revHead.appendChild(revTitle);
  const revDesc = document.createElement("div");
  revDesc.className = "admin-attention-desc";
  revDesc.textContent = stats.reportedReviews > 0
    ? `${stats.reportedReviews} customer review(s) flagged for potential abuse or conduct violation.`
    : "No customer reviews currently flagged.";
  const revFooter = document.createElement("div");
  revFooter.className = "admin-attention-footer";
  const revCount = document.createElement("span");
  revCount.className = `admin-attention-count${stats.reportedReviews > 0 ? " warn" : ""}`;
  revCount.textContent = String(stats.reportedReviews);
  const revBtn = document.createElement("button");
  revBtn.type = "button";
  revBtn.className = "admin-table-btn";
  revBtn.textContent = "Audit Reviews →";
  revBtn.onclick = () => navigateToTab("reviews", { status: "flagged" });
  revFooter.appendChild(revCount);
  revFooter.appendChild(revBtn);
  revCard.appendChild(revHead);
  revCard.appendChild(revDesc);
  revCard.appendChild(revFooter);
  attentionGrid.appendChild(revCard);

  // 4. Security Signals Queue
  const secCard = document.createElement("div");
  secCard.className = `admin-attention-card${stats.securityEvents > 0 ? " urgent" : ""}`;
  const secHead = document.createElement("div");
  secHead.className = "admin-attention-header";
  const secTitle = document.createElement("span");
  secTitle.className = "admin-attention-title";
  secTitle.textContent = "Security Signals";
  secHead.appendChild(secTitle);
  const secDesc = document.createElement("div");
  secDesc.className = "admin-attention-desc";
  secDesc.textContent = stats.securityEvents > 0
    ? `${stats.securityEvents} security signal(s) logged by client rate-limits and abuse detectors.`
    : "Zero security anomalies logged.";
  const secFooter = document.createElement("div");
  secFooter.className = "admin-attention-footer";
  const secCount = document.createElement("span");
  secCount.className = `admin-attention-count${stats.securityEvents > 0 ? " alert" : ""}`;
  secCount.textContent = String(stats.securityEvents);
  const secBtn = document.createElement("button");
  secBtn.type = "button";
  secBtn.className = "admin-table-btn";
  secBtn.textContent = "View Signals →";
  secBtn.onclick = () => navigateToTab("security");
  secFooter.appendChild(secCount);
  secFooter.appendChild(secBtn);
  secCard.appendChild(secHead);
  secCard.appendChild(secDesc);
  secCard.appendChild(secFooter);
  attentionGrid.appendChild(secCard);

  container.appendChild(attentionGrid);

  // Section: Quick Actions
  const qaHeading = document.createElement("div");
  qaHeading.className = "admin-section-heading";
  const qaH3 = document.createElement("h3");
  qaH3.textContent = "Quick Actions";
  qaHeading.appendChild(qaH3);
  container.appendChild(qaHeading);

  const qaGrid = document.createElement("div");
  qaGrid.className = "admin-quick-actions-grid";

  const quickActions = [
    { title: "Platform Controls", desc: "Maintenance mode, registration switches & request pause.", icon: "🎛️", tab: "platform-controls" },
    { title: "Announcements", desc: "Publish inline notices for customers or workers.", icon: "📢", tab: "announcements" },
    { title: "Services & Districts", desc: "Manage active service categories and J&K districts.", icon: "🗺️", tab: "services-districts" },
    { title: "Live Analytics", desc: "Real request breakdowns, top services & district activity.", icon: "📈", tab: "analytics" }
  ];

  for (const qa of quickActions) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "admin-quick-action-card";
    const icon = document.createElement("span");
    icon.className = "admin-quick-action-icon";
    icon.textContent = qa.icon;
    const textWrap = document.createElement("div");
    textWrap.className = "admin-quick-action-text";
    const title = document.createElement("span");
    title.className = "admin-quick-action-title";
    title.textContent = qa.title;
    const desc = document.createElement("span");
    desc.className = "admin-quick-action-desc";
    desc.textContent = qa.desc;
    textWrap.appendChild(title);
    textWrap.appendChild(desc);
    card.appendChild(icon);
    card.appendChild(textWrap);
    card.onclick = () => navigateToTab(qa.tab);
    qaGrid.appendChild(card);
  }
  container.appendChild(qaGrid);

  // Section: Recent Platform Activity (Audit Trail)
  const actHeading = document.createElement("div");
  actHeading.className = "admin-section-heading";
  const actH3 = document.createElement("h3");
  actH3.textContent = "Recent Platform Activity";
  const actBtn = document.createElement("button");
  actBtn.type = "button";
  actBtn.className = "admin-btn-subtle";
  actBtn.textContent = "View Full Audit Trail →";
  actBtn.onclick = () => navigateToTab("audit");
  actHeading.appendChild(actH3);
  actHeading.appendChild(actBtn);
  container.appendChild(actHeading);

  if (auditLogs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "admin-empty-state";
    const sub = document.createElement("p");
    sub.textContent = "No administrative operations recorded in the audit log yet.";
    empty.appendChild(sub);
    container.appendChild(empty);
  } else {
    const tableWrap = document.createElement("div");
    tableWrap.className = "admin-table-container";
    const table = document.createElement("table");
    table.className = "admin-table";
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    ["Timestamp", "Admin UID", "Action", "Target", "Result"].forEach((txt) => {
      const th = document.createElement("th");
      th.textContent = txt;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const log of auditLogs.slice(0, 6)) {
      const row = document.createElement("tr");

      const tdTime = document.createElement("td");
      tdTime.textContent = formatDateTime(log.timestamp);
      row.appendChild(tdTime);

      const tdAdmin = document.createElement("td");
      tdAdmin.textContent = log.adminUid ? `${log.adminUid.substring(0, 8)}...` : "system";
      tdAdmin.title = String(log.adminUid || "system");
      row.appendChild(tdAdmin);

      const tdAct = document.createElement("td");
      tdAct.textContent = String(log.action || "OPERATION");
      row.appendChild(tdAct);

      const tdTarget = document.createElement("td");
      tdTarget.textContent = `${log.targetType || "entity"}: #${log.targetId || "—"}`;
      row.appendChild(tdTarget);

      const tdRes = document.createElement("td");
      const resPill = document.createElement("span");
      resPill.className = `admin-status-pill ${log.result === "success" ? "active" : "suspended"}`;
      resPill.textContent = String(log.result || "success");
      tdRes.appendChild(resPill);
      row.appendChild(tdRes);

      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    applyResponsiveTableLabels(table);
    tableWrap.appendChild(table);
    container.appendChild(tableWrap);
  }
}

// ----------------------------------------------------------------------------
// 2. OPERATIONS: Workers
// ----------------------------------------------------------------------------
async function renderWorkersView(container) {
  const workers = await getAdminWorkers();
  container.replaceChildren();

  // Header
  const header = document.createElement("div");
  header.className = "admin-view-header";
  const titleBox = document.createElement("div");
  titleBox.className = "admin-view-title";
  const h2 = document.createElement("h2");
  h2.textContent = "Service Workers";
  const p = document.createElement("p");
  p.textContent = "Review and manage service workers, approve new profiles, and manage account statuses.";
  titleBox.appendChild(h2);
  titleBox.appendChild(p);
  header.appendChild(titleBox);
  container.appendChild(header);

  // Toolbar (Search & Filters)
  const toolbar = document.createElement("div");
  toolbar.className = "admin-toolbar";

  const searchBox = document.createElement("div");
  searchBox.className = "admin-toolbar-search";
  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.className = "admin-search-input";
  searchInput.placeholder = "Search workers by name, service, district, or ID...";
  searchInput.value = tabFilterState.workers.query || "";
  searchBox.appendChild(searchInput);

  const filtersBox = document.createElement("div");
  filtersBox.className = "admin-toolbar-filters";

  // Verification filter
  const verSelect = document.createElement("select");
  verSelect.className = "admin-select-input";
  [
    { val: "all", label: "All Verification Statuses" },
    { val: "verified", label: "Verified Only" },
    { val: "pending", label: "Waiting for Review" }
  ].forEach((opt) => {
    const o = document.createElement("option");
    o.value = opt.val;
    o.textContent = opt.label;
    o.selected = tabFilterState.workers.verification === opt.val;
    verSelect.appendChild(o);
  });

  // Status filter
  const stSelect = document.createElement("select");
  stSelect.className = "admin-select-input";
  [
    { val: "all", label: "All Account Statuses" },
    { val: "pending", label: "Waiting for Review" },
    { val: "active", label: "Active" },
    { val: "suspended", label: "Suspended" },
    { val: "rejected", label: "Declined" }
  ].forEach((opt) => {
    const o = document.createElement("option");
    o.value = opt.val;
    o.textContent = opt.label;
    o.selected = tabFilterState.workers.status === opt.val;
    stSelect.appendChild(o);
  });

  // District filter
  const distSelect = document.createElement("select");
  distSelect.className = "admin-select-input";
  const allDistOpt = document.createElement("option");
  allDistOpt.value = "all";
  allDistOpt.textContent = "All Districts";
  distSelect.appendChild(allDistOpt);
  JK_DISTRICTS.forEach((d) => {
    const o = document.createElement("option");
    o.value = d;
    o.textContent = d;
    o.selected = tabFilterState.workers.district === d;
    distSelect.appendChild(o);
  });

  // Reset button
  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "admin-btn-subtle";
  resetBtn.textContent = "Reset";

  filtersBox.appendChild(verSelect);
  filtersBox.appendChild(stSelect);
  filtersBox.appendChild(distSelect);
  filtersBox.appendChild(resetBtn);

  toolbar.appendChild(searchBox);
  toolbar.appendChild(filtersBox);
  container.appendChild(toolbar);

  // Content container
  const tableWrap = document.createElement("div");
  tableWrap.className = "admin-table-container";
  container.appendChild(tableWrap);

  const renderTable = () => {
    tableWrap.replaceChildren();

    const q = (tabFilterState.workers.query || "").toLowerCase().trim();
    const vFilter = tabFilterState.workers.verification;
    const sFilter = tabFilterState.workers.status;
    const dFilter = tabFilterState.workers.district;

    const filtered = workers.filter((w) => {
      // Query filter
      if (q) {
        const idMatch = String(w.id || "").toLowerCase().includes(q);
        const nameMatch = String(w.name || "").toLowerCase().includes(q);
        const serviceMatch = String(w.service || "").toLowerCase().includes(q);
        const distMatch = String(w.district || "").toLowerCase().includes(q);
        if (!idMatch && !nameMatch && !serviceMatch && !distMatch) return false;
      }
      // Verification (canonical fail-closed check against stale isVerified)
      const wVer = isWorkerOfficiallyVerified(w);
      if (vFilter === "verified" && !wVer) return false;
      if (vFilter === "pending" && wVer) return false;
      // Status
      if (sFilter !== "all" && String(w.status || "").toLowerCase() !== sFilter.toLowerCase()) return false;
      // District
      if (dFilter !== "all" && String(w.district || "").toLowerCase() !== dFilter.toLowerCase()) return false;

      return true;
    });

    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "admin-empty-state";
      const h3 = document.createElement("h3");
      h3.textContent = "No workers match the filters";
      const sub = document.createElement("p");
      sub.textContent = "Adjust your search keywords or filter criteria to see results.";
      empty.appendChild(h3);
      empty.appendChild(sub);
      tableWrap.appendChild(empty);
      return;
    }

    const table = document.createElement("table");
    table.className = "admin-table";

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    ["ID", "Name", "Service", "District", "Rating", "Account Status", "Verification", "Actions"].forEach((txt) => {
      const th = document.createElement("th");
      th.textContent = txt;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const w of filtered) {
      const row = document.createElement("tr");

      const tdId = document.createElement("td");
      tdId.textContent = String(w.id ? `${w.id.substring(0, 10)}...` : "—");
      tdId.title = String(w.id || "—");
      row.appendChild(tdId);

      const wVerified = isWorkerOfficiallyVerified(w);
      const tdName = document.createElement("td");
      const nameWrap = document.createElement("div");
      nameWrap.className = "admin-identity-cell";
      const nameTxt = document.createElement("span");
      nameTxt.textContent = String(w.name || "Worker");
      nameWrap.appendChild(nameTxt);
      if (wVerified) {
        nameWrap.appendChild(createVerifiedWorkerBadge({ compact: true }));
      }
      tdName.appendChild(nameWrap);
      row.appendChild(tdName);

      const tdService = document.createElement("td");
      tdService.textContent = String(w.service || "—");
      row.appendChild(tdService);

      const tdDist = document.createElement("td");
      tdDist.textContent = String(w.district || "—");
      row.appendChild(tdDist);

      const tdRating = document.createElement("td");
      const wRevCount = typeof w.reviewCount === "number" && w.reviewCount > 0 ? w.reviewCount : 0;
      const wRatingNum = Number(w.rating);
      const hasValidWorkerRating = wRevCount > 0 && !Number.isNaN(wRatingNum) && wRatingNum >= 1 && wRatingNum <= 5;
      const wVwCount = typeof w.verifiedWorkCount === "number" ? w.verifiedWorkCount : null;
      const wUvCount = typeof w.unverifiedCount === "number" ? w.unverifiedCount : null;
      tdRating.textContent = hasValidWorkerRating
        ? (wVwCount !== null && wUvCount !== null && (wVwCount > 0 || wUvCount > 0)
          ? `★ ${wRatingNum.toFixed(1)} (${wRevCount} · ${wVwCount}V/${wUvCount}U)`
          : `★ ${wRatingNum.toFixed(1)} (${wRevCount})`)
        : "No ratings yet";
      row.appendChild(tdRating);

      const tdStatus = document.createElement("td");
      const statusPill = document.createElement("span");
      statusPill.className = `admin-status-pill ${w.status || "pending"}`;
      const statusTextMap = {
        pending: "Waiting for Review",
        active: "Active",
        suspended: "Suspended",
        rejected: "Declined"
      };
      statusPill.textContent = statusTextMap[w.status] || String(w.status || "Waiting for Review");
      tdStatus.appendChild(statusPill);
      row.appendChild(tdStatus);

      const tdVer = document.createElement("td");
      const verPill = document.createElement("span");
      verPill.className = `admin-status-pill ${wVerified ? "verified" : "pending"}`;
      verPill.textContent = wVerified ? "Verified" : (w.workerVerification?.status === "Rejected" ? "Declined" : "Waiting for Review");
      tdVer.appendChild(verPill);
      row.appendChild(tdVer);

      const tdActions = document.createElement("td");
      const actionsBox = document.createElement("div");
      actionsBox.className = "admin-table-actions";

      // 1. Inspect profile modal (enriched with real request metrics & complaints)
      const inspectBtn = document.createElement("button");
      inspectBtn.type = "button";
      inspectBtn.className = "admin-table-btn";
      inspectBtn.textContent = "View Details";
      inspectBtn.onclick = async () => {
        const [allRequests, allReports] = await Promise.all([
          getAdminRequests(),
          getAdminReports()
        ]);
        const workerReqs = allRequests.filter(
          (r) => String(r.workerUid || r.workerId || "") === String(w.id)
        );
        const completedCount = workerReqs.filter((r) => r.status === "Completed").length;
        const rejectedCount = workerReqs.filter((r) => r.status === "Rejected").length;
        const acceptedCount = workerReqs.filter((r) => r.status === "Accepted").length;
        const pendingCount = workerReqs.filter((r) => r.status === "Pending").length;
        const workerComplaints = allReports.filter(
          (rep) => String(rep.targetId || "") === String(w.id)
        );

        const modalContent = document.createElement("div");
        const grid = document.createElement("div");
        grid.className = "admin-detail-grid";

        grid.appendChild(createDetailItem("Worker ID", w.id, true));
        grid.appendChild(createDetailItem("Full Name", w.name));
        grid.appendChild(createDetailItem("Service", Array.isArray(w.services) && w.services.length ? w.services.join(", ") : (w.service || "—")));
        grid.appendChild(createDetailItem("District", w.district || "—"));
        grid.appendChild(createDetailItem("Rating & Reviews", hasValidWorkerRating ? `★ ${wRatingNum.toFixed(1)} (${wRevCount} ${wRevCount === 1 ? "review" : "reviews"})` : "New Worker · No ratings yet"));
        grid.appendChild(createDetailItem("Account Status", statusTextMap[w.status] || String(w.status || "Waiting for Review")));
        grid.appendChild(createDetailItem("Verification", wVerified ? "Verified" : "Waiting for Review"));
        grid.appendChild(createDetailItem("Service Requests", `${workerReqs.length} total (${completedCount} done · ${acceptedCount} in progress · ${pendingCount} waiting · ${rejectedCount} declined)`, true));
        grid.appendChild(createDetailItem("Complaints / Reports", workerComplaints.length > 0 ? `${workerComplaints.length} report(s): ${workerComplaints.slice(0, 3).map((r) => `${r.reason || "Safety"} (${r.status || "open"})`).join("; ")}` : "No complaints reported", true));
        const expDisplay = w.experience ? (String(w.experience).toLowerCase().includes("year") ? w.experience : `${w.experience} years`) : "—";
        grid.appendChild(createDetailItem("Experience", expDisplay));
        grid.appendChild(createDetailItem("Email", w.email || "—"));
        grid.appendChild(createDetailItem("Phone", w.phone || "—"));
        if (w.createdAt) grid.appendChild(createDetailItem("Joined Date", formatDateTime(w.createdAt)));
        if (w.adminNotes) grid.appendChild(createDetailItem("Staff Note", w.adminNotes, true));
        if (w.bio) grid.appendChild(createDetailItem("About Worker", w.bio, true));
        grid.appendChild(createDetailItem(
          "Privacy Notice",
          "Worker contact details are kept private. Suspending a worker hides them from search results while preserving all past service requests and customer reviews.",
          true
        ));

        // Administrative Moderation Controls inside detail modal
        const modWrap = document.createElement("div");
        modWrap.className = "admin-detail-item full-width";
        const modLbl = document.createElement("div");
        modLbl.className = "admin-detail-label";
        modLbl.textContent = "Account Actions";
        modWrap.appendChild(modLbl);

        const modButtons = document.createElement("div");
        modButtons.className = "admin-table-actions";
        modButtons.style.marginTop = "8px";

        if (!isWorkerOfficiallyVerified(w) || w.status === "pending") {
          const mApprove = document.createElement("button");
          mApprove.type = "button";
          mApprove.className = "admin-table-btn approve";
          mApprove.textContent = "✓ Approve & Show on Website";
          mApprove.onclick = async () => {
            const res = await updateAdminWorkerStatus(w.id, { isVerified: true, status: "active" }, currentAdmin.uid, { reason: "Moderator approved from detail inspection" });
            if (res.success) {
              showToast(`Worker ${w.name} verified and published.`);
              w.isVerified = true;
              w.status = "active";
              if (res.workerVerification) w.workerVerification = res.workerVerification;
              const modalBackdrop = document.getElementById("adminActionModal");
              if (modalBackdrop) modalBackdrop.hidden = true;
              renderTable();
            } else {
              showToast(res.error || "Failed to approve worker.");
            }
          };
          modButtons.appendChild(mApprove);

          const mReject = document.createElement("button");
          mReject.type = "button";
          mReject.className = "admin-table-btn suspend";
          mReject.textContent = "✕ Decline Application";
          mReject.onclick = async () => {
            const res = await updateAdminWorkerStatus(w.id, { isVerified: false, status: "rejected" }, currentAdmin.uid, { reason: "Moderator rejected from detail inspection" });
            if (res.success) {
              showToast(`Worker ${w.name} application declined.`);
              w.isVerified = false;
              w.status = "rejected";
              if (res.workerVerification) w.workerVerification = res.workerVerification;
              const modalBackdrop = document.getElementById("adminActionModal");
              if (modalBackdrop) modalBackdrop.hidden = true;
              renderTable();
            } else {
              showToast(res.error || "Failed to decline worker application.");
            }
          };
          modButtons.appendChild(mReject);
        } else if (w.status === "active") {
          const mSuspend = document.createElement("button");
          mSuspend.type = "button";
          mSuspend.className = "admin-table-btn suspend";
          mSuspend.textContent = "✕ Suspend Account";
          mSuspend.onclick = async () => {
            const res = await updateAdminWorkerStatus(w.id, { status: "suspended" }, currentAdmin.uid, { reason: "Moderator suspended from detail inspection" });
            if (res.success) {
              showToast(`Worker ${w.name} suspended from search results.`);
              w.status = "suspended";
              const modalBackdrop = document.getElementById("adminActionModal");
              if (modalBackdrop) modalBackdrop.hidden = true;
              renderTable();
            } else {
              showToast(res.error || "Failed to suspend worker.");
            }
          };
          modButtons.appendChild(mSuspend);
        } else if (w.status === "suspended") {
          const mRestore = document.createElement("button");
          mRestore.type = "button";
          mRestore.className = "admin-table-btn approve";
          mRestore.textContent = "↺ Restore Account";
          mRestore.onclick = async () => {
            const res = await updateAdminWorkerStatus(w.id, { status: "active" }, currentAdmin.uid, { reason: "Moderator restored from detail inspection" });
            if (res.success) {
              showToast(`Worker ${w.name} restored to active status.`);
              w.status = "active";
              const modalBackdrop = document.getElementById("adminActionModal");
              if (modalBackdrop) modalBackdrop.hidden = true;
              renderTable();
            } else {
              showToast(res.error || "Failed to restore worker.");
            }
          };
          modButtons.appendChild(mRestore);
        } else if (w.status === "rejected") {
          const mReopen = document.createElement("button");
          mReopen.type = "button";
          mReopen.className = "admin-table-btn approve";
          mReopen.textContent = "↺ Reopen for Review";
          mReopen.onclick = async () => {
            const res = await updateAdminWorkerStatus(w.id, { isVerified: false, status: "pending" }, currentAdmin.uid, { reason: "Moderator reopened application" });
            if (res.success) {
              showToast(`Worker ${w.name} application reopened for review.`);
              w.isVerified = false;
              w.status = "pending";
              const modalBackdrop = document.getElementById("adminActionModal");
              if (modalBackdrop) modalBackdrop.hidden = true;
              renderTable();
            } else {
              showToast(res.error || "Failed to reopen application.");
            }
          };
          modButtons.appendChild(mReopen);
        }

        modWrap.appendChild(modButtons);
        grid.appendChild(modWrap);

        modalContent.appendChild(grid);

        showDetailModal({
          title: `Worker Profile: ${w.name}`,
          contentNode: modalContent,
          isWide: true
        });
      };
      actionsBox.appendChild(inspectBtn);

      // 2. Contextual table-level actions
      if (!isWorkerOfficiallyVerified(w) || w.status === "pending") {
        const approveBtn = document.createElement("button");
        approveBtn.type = "button";
        approveBtn.className = "admin-table-btn approve";
        approveBtn.textContent = "Approve";
        approveBtn.title = "Approve profile and publish on website";
        approveBtn.onclick = () => {
          showConfirmModal({
            title: "Approve Worker Profile",
            body: `Approve ${w.name} (#${w.id})? Their profile and services will immediately appear in search results on the website.`,
            confirmText: "Approve Worker",
            onConfirm: async () => {
              const res = await updateAdminWorkerStatus(w.id, { isVerified: true, status: "active" }, currentAdmin.uid, { reason: "Admin approved verification" });
              if (res.success) {
                showToast(`Worker ${w.name} verified and active.`);
                w.isVerified = true;
                w.status = "active";
                if (res.workerVerification) w.workerVerification = res.workerVerification;
                renderTable();
              } else {
                showToast(res.error || "Failed to approve worker.");
              }
            }
          });
        };
        actionsBox.appendChild(approveBtn);

        const rejectBtn = document.createElement("button");
        rejectBtn.type = "button";
        rejectBtn.className = "admin-table-btn suspend";
        rejectBtn.textContent = "Decline";
        rejectBtn.title = "Decline application";
        rejectBtn.onclick = () => {
          showConfirmModal({
            title: "Decline Worker Application",
            body: `Decline application for ${w.name} (#${w.id})? They will remain hidden from the website.`,
            confirmText: "Decline Application",
            onConfirm: async () => {
              const res = await updateAdminWorkerStatus(w.id, { isVerified: false, status: "rejected" }, currentAdmin.uid, { reason: "Admin rejected application" });
              if (res.success) {
                showToast(`Worker ${w.name} application declined.`);
                w.isVerified = false;
                w.status = "rejected";
                if (res.workerVerification) w.workerVerification = res.workerVerification;
                renderTable();
              } else {
                showToast(res.error || "Failed to decline application.");
              }
            }
          });
        };
        actionsBox.appendChild(rejectBtn);
      } else if (w.status === "active") {
        const suspendBtn = document.createElement("button");
        suspendBtn.type = "button";
        suspendBtn.className = "admin-table-btn suspend";
        suspendBtn.textContent = "Suspend";
        suspendBtn.title = "Suspend account and hide from website";
        suspendBtn.onclick = () => {
          showConfirmModal({
            title: "Suspend Worker Account",
            body: `Suspend ${w.name} (#${w.id})? They will be hidden from search results immediately while preserving their past records.`,
            confirmText: "Suspend Worker",
            onConfirm: async () => {
              const res = await updateAdminWorkerStatus(w.id, { status: "suspended" }, currentAdmin.uid, { reason: "Admin suspended account" });
              if (res.success) {
                showToast(`Worker ${w.name} suspended.`);
                w.status = "suspended";
                renderTable();
              } else {
                showToast(res.error || "Failed to suspend worker.");
              }
            }
          });
        };
        actionsBox.appendChild(suspendBtn);
      } else if (w.status === "suspended") {
        const restoreBtn = document.createElement("button");
        restoreBtn.type = "button";
        restoreBtn.className = "admin-table-btn approve";
        restoreBtn.textContent = "Restore";
        restoreBtn.title = "Restore account to active on website";
        restoreBtn.onclick = () => {
          showConfirmModal({
            title: "Restore Worker Account",
            body: `Restore ${w.name} (#${w.id}) to active? Their profile will appear in search results again.`,
            confirmText: "Restore Worker",
            onConfirm: async () => {
              const res = await updateAdminWorkerStatus(w.id, { status: "active" }, currentAdmin.uid, { reason: "Admin restored account" });
              if (res.success) {
                showToast(`Worker ${w.name} restored.`);
                w.status = "active";
                renderTable();
              } else {
                showToast(res.error || "Failed to restore worker.");
              }
            }
          });
        };
        actionsBox.appendChild(restoreBtn);
      } else if (w.status === "rejected") {
        const reopenBtn = document.createElement("button");
        reopenBtn.type = "button";
        reopenBtn.className = "admin-table-btn approve";
        reopenBtn.textContent = "Reopen";
        reopenBtn.title = "Reopen application for review";
        reopenBtn.onclick = () => {
          showConfirmModal({
            title: "Reopen Worker Application",
            body: `Reopen application for ${w.name} (#${w.id}) so it can be reviewed again?`,
            confirmText: "Reopen Application",
            onConfirm: async () => {
              const res = await updateAdminWorkerStatus(w.id, { isVerified: false, status: "pending" }, currentAdmin.uid, { reason: "Admin reopened application" });
              if (res.success) {
                showToast(`Worker ${w.name} application reopened.`);
                w.isVerified = false;
                w.status = "pending";
                if (res.workerVerification) w.workerVerification = res.workerVerification;
                renderTable();
              } else {
                showToast(res.error || "Failed to reopen application.");
              }
            }
          });
        };
        actionsBox.appendChild(reopenBtn);
      }

      tdActions.appendChild(actionsBox);
      row.appendChild(tdActions);
      tbody.appendChild(row);
    }

    table.appendChild(tbody);
    applyResponsiveTableLabels(table);
    tableWrap.appendChild(table);
  };

  // Event listeners for toolbar
  searchInput.addEventListener("input", (e) => {
    tabFilterState.workers.query = e.target.value;
    renderTable();
  });

  verSelect.addEventListener("change", (e) => {
    tabFilterState.workers.verification = e.target.value;
    renderTable();
  });

  stSelect.addEventListener("change", (e) => {
    tabFilterState.workers.status = e.target.value;
    renderTable();
  });

  distSelect.addEventListener("change", (e) => {
    tabFilterState.workers.district = e.target.value;
    renderTable();
  });

  resetBtn.addEventListener("click", () => {
    tabFilterState.workers = { query: "", status: "all", verification: "all", district: "all" };
    searchInput.value = "";
    verSelect.value = "all";
    stSelect.value = "all";
    distSelect.value = "all";
    renderTable();
  });

  renderTable();
}

// ----------------------------------------------------------------------------
// 3. OPERATIONS: Customers
// ----------------------------------------------------------------------------
async function renderCustomersView(container) {
  let customers = await getAdminCustomers();
  container.replaceChildren();

  // Header
  const header = document.createElement("div");
  header.className = "admin-view-header";
  const titleBox = document.createElement("div");
  titleBox.className = "admin-view-title";
  const h2 = document.createElement("h2");
  h2.textContent = "Customer Accounts";
  const p = document.createElement("p");
  p.textContent = "View customer accounts, contact details, email verification, and account status.";
  titleBox.appendChild(h2);
  titleBox.appendChild(p);
  header.appendChild(titleBox);
  container.appendChild(header);

  // Toolbar
  const toolbar = document.createElement("div");
  toolbar.className = "admin-toolbar";

  const searchBox = document.createElement("div");
  searchBox.className = "admin-toolbar-search";
  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.className = "admin-search-input";
  searchInput.placeholder = "Search customers by name, phone, email, district, or UID...";
  searchInput.value = tabFilterState.customers.query || "";
  searchBox.appendChild(searchInput);

  const filtersBox = document.createElement("div");
  filtersBox.className = "admin-toolbar-filters";

  const statusSelect = document.createElement("select");
  statusSelect.className = "admin-select-input";
  statusSelect.setAttribute("aria-label", "Filter customers by account status");
  [
    { val: "all", label: "All Account Statuses" },
    { val: "active", label: "Active Only" },
    { val: "suspended", label: "Suspended Only" }
  ].forEach((opt) => {
    const o = document.createElement("option");
    o.value = opt.val;
    o.textContent = opt.label;
    o.selected = (tabFilterState.customers.status || "all") === opt.val;
    statusSelect.appendChild(o);
  });

  const verSelect = document.createElement("select");
  verSelect.className = "admin-select-input";
  [
    { val: "all", label: "All Email Statuses" },
    { val: "verified", label: "Email Confirmed" },
    { val: "unverified", label: "Email Unconfirmed" }
  ].forEach((opt) => {
    const o = document.createElement("option");
    o.value = opt.val;
    o.textContent = opt.label;
    o.selected = tabFilterState.customers.verification === opt.val;
    verSelect.appendChild(o);
  });

  const distSelect = document.createElement("select");
  distSelect.className = "admin-select-input";
  const allDistOpt = document.createElement("option");
  allDistOpt.value = "all";
  allDistOpt.textContent = "All Districts";
  distSelect.appendChild(allDistOpt);
  JK_DISTRICTS.forEach((d) => {
    const o = document.createElement("option");
    o.value = d;
    o.textContent = d;
    o.selected = tabFilterState.customers.district === d;
    distSelect.appendChild(o);
  });

  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "admin-btn-subtle";
  resetBtn.textContent = "Reset";

  filtersBox.appendChild(statusSelect);
  filtersBox.appendChild(verSelect);
  filtersBox.appendChild(distSelect);
  filtersBox.appendChild(resetBtn);

  toolbar.appendChild(searchBox);
  toolbar.appendChild(filtersBox);
  container.appendChild(toolbar);

  const tableWrap = document.createElement("div");
  tableWrap.className = "admin-table-container";
  container.appendChild(tableWrap);

  const renderTable = () => {
    tableWrap.replaceChildren();

    const q = (tabFilterState.customers.query || "").toLowerCase().trim();
    const sFilter = tabFilterState.customers.status || "all";
    const vFilter = tabFilterState.customers.verification;
    const dFilter = tabFilterState.customers.district;

    const filtered = customers.filter((c) => {
      const accStatus = c.status || "active";
      if (q) {
        const uidMatch = String(c.uid || c.id || "").toLowerCase().includes(q);
        const nameMatch = String(c.name || "").toLowerCase().includes(q);
        const phoneMatch = String(c.phone || "").toLowerCase().includes(q);
        const emailMatch = String(c.email || "").toLowerCase().includes(q);
        const distMatch = String(c.district || "").toLowerCase().includes(q);
        if (!uidMatch && !nameMatch && !phoneMatch && !emailMatch && !distMatch) return false;
      }
      if (sFilter !== "all" && accStatus !== sFilter) return false;
      if (vFilter === "verified" && !c.emailVerified) return false;
      if (vFilter === "unverified" && Boolean(c.emailVerified)) return false;
      if (dFilter !== "all" && String(c.district || "").toLowerCase() !== dFilter.toLowerCase()) return false;
      return true;
    });

    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "admin-empty-state";
      const h3 = document.createElement("h3");
      h3.textContent = "No customer accounts found";
      const sub = document.createElement("p");
      sub.textContent = "No registered customers match the specified criteria.";
      empty.appendChild(h3);
      empty.appendChild(sub);
      tableWrap.appendChild(empty);
      return;
    }

    const table = document.createElement("table");
    table.className = "admin-table";

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    ["Customer", "Contact Details", "District", "Account Status", "Email Confirmed", "Joined Date", "Actions"].forEach((txt) => {
      const th = document.createElement("th");
      th.textContent = txt;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const c of filtered) {
      const accStatus = c.status || "active";
      const row = document.createElement("tr");

      const tdName = document.createElement("td");
      const cvNorm = normalizeCustomerVerification(c);
      const cNameWrap = document.createElement("div");
      cNameWrap.className = "admin-identity-cell";
      const cNameTxt = document.createElement("span");
      cNameTxt.textContent = String(c.name || "Customer");
      cNameWrap.appendChild(cNameTxt);
      if (cvNorm.status === "Verified") {
        cNameWrap.appendChild(createVerifiedCustomerBadge({ compact: true }));
      }
      tdName.appendChild(cNameWrap);
      tdName.title = String(c.uid || c.id);
      row.appendChild(tdName);

      const tdContact = document.createElement("td");
      tdContact.textContent = [c.email, c.phone].filter(Boolean).join(" · ") || "—";
      row.appendChild(tdContact);

      const tdDist = document.createElement("td");
      tdDist.textContent = String(c.district || "—");
      row.appendChild(tdDist);

      const tdStatus = document.createElement("td");
      const statusPill = document.createElement("span");
      statusPill.className = `admin-status-pill ${accStatus === "suspended" ? "suspended" : "active"}`;
      statusPill.textContent = accStatus === "suspended" ? "Suspended" : "Active";
      tdStatus.appendChild(statusPill);
      row.appendChild(tdStatus);

      const tdVer = document.createElement("td");
      const verPill = document.createElement("span");
      verPill.className = `admin-status-pill ${c.emailVerified ? "verified" : "pending"}`;
      verPill.textContent = c.emailVerified ? "Confirmed" : "Unconfirmed";
      tdVer.appendChild(verPill);
      row.appendChild(tdVer);

      const tdDate = document.createElement("td");
      tdDate.textContent = formatDateOnly(c.createdAt);
      row.appendChild(tdDate);

      const tdActions = document.createElement("td");
      const actionsBox = document.createElement("div");
      actionsBox.className = "admin-table-actions";

      const inspectBtn = document.createElement("button");
      inspectBtn.type = "button";
      inspectBtn.className = "admin-table-btn";
      inspectBtn.textContent = "View Details";
      inspectBtn.onclick = async () => {
        const [allRequests, allReports] = await Promise.all([
          getAdminRequests(),
          getAdminReports()
        ]);
        const custUid = c.uid || c.id;
        const custRequests = allRequests.filter((r) => String(r.customerId || "") === String(custUid));
        const custReports = allReports.filter(
          (rep) => String(rep.targetId || "") === String(custUid) || String(rep.reporterUid || "") === String(custUid)
        );

        const modalContent = document.createElement("div");
        const grid = document.createElement("div");
        grid.className = "admin-detail-grid";

        grid.appendChild(createDetailItem("Customer ID", custUid, true));
        grid.appendChild(createDetailItem("Name", c.name));
        grid.appendChild(createDetailItem("Account Status", accStatus === "suspended" ? "Suspended" : "Active"));
        grid.appendChild(createDetailItem("Phone", c.phone || "Not provided"));
        grid.appendChild(createDetailItem("Email", c.email || "Not provided"));
        grid.appendChild(createDetailItem("Email Confirmed", c.emailVerified ? "Yes (Confirmed)" : "No (Unconfirmed)"));
        grid.appendChild(createDetailItem("Identity Verification", formatVerificationStatusLabel(normalizeCustomerVerification(c).status)));
        grid.appendChild(createDetailItem("District", c.district || "—"));
        grid.appendChild(createDetailItem("Joined Date", formatDateTime(c.createdAt)));
        if (accStatus === "suspended") {
          grid.appendChild(createDetailItem("Reason for Suspension", c.suspensionReason || "Administrative restriction", true));
          if (c.suspendedAt) grid.appendChild(createDetailItem("Suspended On", formatDateTime(c.suspendedAt)));
          if (c.suspendedBy) grid.appendChild(createDetailItem("Suspended By (Admin ID)", c.suspendedBy));
        }

        const reqSummary = custRequests.length > 0
          ? `${custRequests.length} request(s): ` +
            custRequests.slice(0, 5).map((r) => `${r.service || "Service"} (${r.status || "Pending"})`).join(", ")
          : "No service requests recorded.";
        grid.appendChild(createDetailItem("Service Request History", reqSummary, true));

        const repSummary = custReports.length > 0
          ? `${custReports.length} report(s): ` +
            custReports.slice(0, 4).map((r) => `${r.reason || "Report"} (${r.status || "open"})`).join("; ")
          : "No reports associated with this account.";
        grid.appendChild(createDetailItem("Relevant Safety Reports", repSummary, true));

        grid.appendChild(createDetailItem(
          "Account Safety Policy",
          "Suspending an account prevents new requests or logins while keeping past records intact. Account deletion is managed separately by customer request.",
          true
        ));

        modalContent.appendChild(grid);

        showDetailModal({
          title: `Customer Profile: ${c.name || "Customer"}`,
          contentNode: modalContent,
          isWide: true
        });
      };
      actionsBox.appendChild(inspectBtn);

      if (accStatus !== "suspended") {
        const suspendBtn = document.createElement("button");
        suspendBtn.type = "button";
        suspendBtn.className = "admin-table-btn suspend";
        suspendBtn.textContent = "Suspend";
        suspendBtn.onclick = () => {
          showReasonConfirmModal({
            title: `Suspend Customer: ${c.name || "Customer"}`,
            description: "Suspending this customer prevents new service requests and displays an account restriction notice. All historical records are safely preserved.",
            reasonLabel: "Suspension Reason (required, logged in audit trail)",
            placeholder: "e.g., Repeated abusive conduct or policy violation...",
            required: true,
            confirmText: "Suspend Account",
            onConfirm: async (reason) => {
              const res = await updateAdminCustomerStatus(c.uid || c.id, "suspended", currentAdmin.uid, reason);
              if (res.success) {
                c.status = "suspended";
                c.suspensionReason = reason;
                c.suspendedAt = new Date().toISOString();
                c.suspendedBy = currentAdmin.uid;
                showToast(`Customer ${c.name || "account"} suspended.`);
                renderTable();
              } else {
                showToast(res.error || "Failed to suspend customer.");
              }
            }
          });
        };
        actionsBox.appendChild(suspendBtn);
      } else {
        const reactivateBtn = document.createElement("button");
        reactivateBtn.type = "button";
        reactivateBtn.className = "admin-table-btn approve";
        reactivateBtn.textContent = "Reactivate";
        reactivateBtn.onclick = () => {
          showReasonConfirmModal({
            title: `Reactivate Customer: ${c.name || "Customer"}`,
            description: "Restore full customer account access and remove the suspension restriction?",
            reasonLabel: "Reactivation Note (optional)",
            placeholder: "e.g., Appeal approved / issue resolved...",
            required: false,
            confirmText: "Reactivate Account",
            onConfirm: async (reason) => {
              const res = await updateAdminCustomerStatus(c.uid || c.id, "active", currentAdmin.uid, reason);
              if (res.success) {
                c.status = "active";
                c.suspensionReason = null;
                showToast(`Customer ${c.name || "account"} reactivated.`);
                renderTable();
              } else {
                showToast(res.error || "Failed to reactivate customer.");
              }
            }
          });
        };
        actionsBox.appendChild(reactivateBtn);
      }

      tdActions.appendChild(actionsBox);
      row.appendChild(tdActions);

      tbody.appendChild(row);
    }

    table.appendChild(tbody);
    applyResponsiveTableLabels(table);
    tableWrap.appendChild(table);
  };

  searchInput.addEventListener("input", (e) => {
    tabFilterState.customers.query = e.target.value;
    renderTable();
  });

  statusSelect.addEventListener("change", (e) => {
    tabFilterState.customers.status = e.target.value;
    renderTable();
  });

  verSelect.addEventListener("change", (e) => {
    tabFilterState.customers.verification = e.target.value;
    renderTable();
  });

  distSelect.addEventListener("change", (e) => {
    tabFilterState.customers.district = e.target.value;
    renderTable();
  });

  resetBtn.addEventListener("click", () => {
    tabFilterState.customers = { query: "", status: "all", verification: "all", district: "all" };
    searchInput.value = "";
    statusSelect.value = "all";
    verSelect.value = "all";
    distSelect.value = "all";
    renderTable();
  });

  renderTable();

  // Attach real-time listener for continuous live customer updates
  try {
    activeCustomersUnsubscribe = await subscribeToAdminCustomers((updatedCustomers) => {
      customers = updatedCustomers;
      renderTable();
    });
  } catch (err) {
    console.warn("[JKFixHub Admin] Real-time customer subscription notice:", err?.message || err);
  }
}

// ----------------------------------------------------------------------------
// 4. OPERATIONS: Requests
// ----------------------------------------------------------------------------
async function renderRequestsView(container) {
  const requests = await getAdminRequests();
  container.replaceChildren();

  // Header
  const header = document.createElement("div");
  header.className = "admin-view-header";
  const titleBox = document.createElement("div");
  titleBox.className = "admin-view-title";
  const h2 = document.createElement("h2");
  h2.textContent = "Service Request Fulfillment";
  const p = document.createElement("p");
  p.textContent = "Platform-wide service requests, customer requirements, assigned technicians, and status tracking.";
  titleBox.appendChild(h2);
  titleBox.appendChild(p);
  header.appendChild(titleBox);
  container.appendChild(header);

  // Toolbar
  const toolbar = document.createElement("div");
  toolbar.className = "admin-toolbar";

  const searchBox = document.createElement("div");
  searchBox.className = "admin-toolbar-search";
  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.className = "admin-search-input";
  searchInput.placeholder = "Search requests by ID, customer, worker, service, or district...";
  searchInput.value = tabFilterState.requests.query || "";
  searchBox.appendChild(searchInput);

  const filtersBox = document.createElement("div");
  filtersBox.className = "admin-toolbar-filters";

  const stSelect = document.createElement("select");
  stSelect.className = "admin-select-input";
  [
    { val: "all", label: "All Request Statuses" },
    { val: "Pending", label: "Pending" },
    { val: "Accepted", label: "Accepted" },
    { val: "Completed", label: "Completed" },
    { val: "Cancelled", label: "Cancelled" },
    { val: "Rejected", label: "Rejected" }
  ].forEach((opt) => {
    const o = document.createElement("option");
    o.value = opt.val;
    o.textContent = opt.label;
    o.selected = tabFilterState.requests.status === opt.val;
    stSelect.appendChild(o);
  });

  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "admin-btn-subtle";
  resetBtn.textContent = "Reset";

  filtersBox.appendChild(stSelect);
  filtersBox.appendChild(resetBtn);

  toolbar.appendChild(searchBox);
  toolbar.appendChild(filtersBox);
  container.appendChild(toolbar);

  const tableWrap = document.createElement("div");
  tableWrap.className = "admin-table-container";
  container.appendChild(tableWrap);

  const renderTable = () => {
    tableWrap.replaceChildren();

    const q = (tabFilterState.requests.query || "").toLowerCase().trim();
    const sFilter = tabFilterState.requests.status;

    const filtered = requests.filter((r) => {
      if (q) {
        const idMatch = String(r.id || "").toLowerCase().includes(q);
        const custMatch = String(r.customerName || r.customerId || "").toLowerCase().includes(q);
        const workerMatch = String(r.workerName || r.workerId || "").toLowerCase().includes(q);
        const serviceMatch = String(r.service || "").toLowerCase().includes(q);
        const distMatch = String(r.district || "").toLowerCase().includes(q);
        if (!idMatch && !custMatch && !workerMatch && !serviceMatch && !distMatch) return false;
      }
      if (sFilter !== "all" && String(r.status || "").toLowerCase() !== sFilter.toLowerCase()) return false;
      return true;
    });

    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "admin-empty-state";
      const h3 = document.createElement("h3");
      h3.textContent = "No service requests found";
      const sub = document.createElement("p");
      sub.textContent = "No requests match the current search or status filter.";
      empty.appendChild(h3);
      empty.appendChild(sub);
      tableWrap.appendChild(empty);
      return;
    }

    const table = document.createElement("table");
    table.className = "admin-table";

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    ["Request ID", "Customer", "Worker", "Service", "District", "Status", "Date", "Actions"].forEach((txt) => {
      const th = document.createElement("th");
      th.textContent = txt;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const r of filtered) {
      const row = document.createElement("tr");

      const tdId = document.createElement("td");
      tdId.textContent = String(r.id);
      row.appendChild(tdId);

      const tdCust = document.createElement("td");
      tdCust.textContent = String(r.customerName || r.customerId || "—");
      row.appendChild(tdCust);

      const tdWorker = document.createElement("td");
      tdWorker.textContent = String(r.workerName || r.workerId || "—");
      row.appendChild(tdWorker);

      const tdService = document.createElement("td");
      tdService.textContent = String(r.service || "—");
      row.appendChild(tdService);

      const tdDist = document.createElement("td");
      tdDist.textContent = String(r.district || "—");
      row.appendChild(tdDist);

      const tdStatus = document.createElement("td");
      const stPill = document.createElement("span");
      const statusClass = (r.status || "pending").toLowerCase();
      stPill.className = `admin-status-pill ${statusClass}`;
      stPill.textContent = String(r.status || "Pending");
      tdStatus.appendChild(stPill);
      row.appendChild(tdStatus);

      const tdDate = document.createElement("td");
      tdDate.textContent = formatDateOnly(r.createdAt);
      row.appendChild(tdDate);

      const tdActions = document.createElement("td");
      const actionsBox = document.createElement("div");
      actionsBox.className = "admin-table-actions";

      // 1. Inspect & Details Modal
      const inspectBtn = document.createElement("button");
      inspectBtn.type = "button";
      inspectBtn.className = "admin-table-btn";
      inspectBtn.textContent = "Inspect";
      inspectBtn.onclick = () => {
        const modalContent = document.createElement("div");
        const grid = document.createElement("div");
        grid.className = "admin-detail-grid";

        grid.appendChild(createDetailItem("Request ID", r.id));
        grid.appendChild(createDetailItem("Current Status", r.status || "Pending"));
        grid.appendChild(createDetailItem("Service Category", r.service));
        grid.appendChild(createDetailItem("District", r.district));
        grid.appendChild(createDetailItem("Customer", r.customerName || r.customerId));
        grid.appendChild(createDetailItem("Assigned Worker", r.workerName || r.workerId));
        if (r.date) grid.appendChild(createDetailItem("Scheduled Date", r.date));
        grid.appendChild(createDetailItem("Created At", formatDateTime(r.createdAt)));
        if (r.updatedAt) grid.appendChild(createDetailItem("Last Updated", formatDateTime(r.updatedAt)));
        if (r.adminNotes) grid.appendChild(createDetailItem("Administrative Notes", r.adminNotes, true));
        if (r.notes || r.description) grid.appendChild(createDetailItem("Customer Description", r.notes || r.description, true));

        // Lifecycle Timeline
        const tlWrap = document.createElement("div");
        tlWrap.className = "admin-detail-item full-width";
        const tlLbl = document.createElement("div");
        tlLbl.className = "admin-detail-label";
        tlLbl.textContent = "Request Lifecycle Timeline";
        const timeline = document.createElement("div");
        timeline.className = "admin-timeline";

        const isAcceptedOrBeyond = ["Accepted", "Completed"].includes(r.status);
        const isCompleted = r.status === "Completed";
        const isTerminated = ["Cancelled", "Rejected"].includes(r.status);

        const steps = [
          { label: "Request Created", done: true },
          { label: isTerminated ? `Terminated (${r.status})` : "Technician Assignment", done: isAcceptedOrBeyond || isTerminated },
          { label: "Fulfillment & Completion", done: isCompleted }
        ];

        steps.forEach((step) => {
          const s = document.createElement("div");
          s.className = `admin-timeline-step${step.done ? " completed" : " pending"}`;
          const title = document.createElement("div");
          title.className = "admin-timeline-title";
          title.textContent = step.label;
          s.appendChild(title);
          timeline.appendChild(s);
        });

        tlWrap.appendChild(tlLbl);
        tlWrap.appendChild(timeline);
        grid.appendChild(tlWrap);

        // Administrative Moderation Controls inside detail modal
        const modWrap = document.createElement("div");
        modWrap.className = "admin-detail-item full-width";
        const modLbl = document.createElement("div");
        modLbl.className = "admin-detail-label";
        modLbl.textContent = "Administrative Moderation Actions";
        modWrap.appendChild(modLbl);

        const modButtons = document.createElement("div");
        modButtons.className = "admin-table-actions";
        modButtons.style.marginTop = "8px";

        if (r.status !== "Completed" && !isTerminated) {
          const mComplete = document.createElement("button");
          mComplete.type = "button";
          mComplete.className = "admin-table-btn approve";
          mComplete.textContent = "✓ Mark Completed";
          mComplete.onclick = async () => {
            const res = await updateAdminRequestStatus(r.id, "Completed", currentAdmin.uid, { reason: "Moderator marked Completed from detail inspection" });
            if (res.success) {
              showToast(`Request #${r.id} marked Completed.`);
              r.status = "Completed";
              const modalBackdrop = document.getElementById("adminActionModal");
              if (modalBackdrop) modalBackdrop.hidden = true;
              renderTable();
            } else {
              showToast(res.error || "Failed to update request.");
            }
          };
          modButtons.appendChild(mComplete);
        }

        if (r.status === "Pending") {
          const mAccept = document.createElement("button");
          mAccept.type = "button";
          mAccept.className = "admin-table-btn approve";
          mAccept.textContent = "✓ Accept on Worker Behalf";
          mAccept.onclick = async () => {
            const res = await updateAdminRequestStatus(r.id, "Accepted", currentAdmin.uid, { reason: "Moderator accepted on technician behalf" });
            if (res.success) {
              showToast(`Request #${r.id} accepted. Chat enabled.`);
              r.status = "Accepted";
              const modalBackdrop = document.getElementById("adminActionModal");
              if (modalBackdrop) modalBackdrop.hidden = true;
              renderTable();
            } else {
              showToast(res.error || "Failed to accept request.");
            }
          };
          modButtons.appendChild(mAccept);
        }

        if (!isTerminated) {
          const mCancel = document.createElement("button");
          mCancel.type = "button";
          mCancel.className = "admin-table-btn suspend";
          mCancel.textContent = "✕ Cancel Request";
          mCancel.onclick = async () => {
            const res = await updateAdminRequestStatus(r.id, "Cancelled", currentAdmin.uid, { reason: "Moderator cancelled from detail inspection" });
            if (res.success) {
              showToast(`Request #${r.id} cancelled.`);
              r.status = "Cancelled";
              const modalBackdrop = document.getElementById("adminActionModal");
              if (modalBackdrop) modalBackdrop.hidden = true;
              renderTable();
            } else {
              showToast(res.error || "Failed to cancel request.");
            }
          };
          modButtons.appendChild(mCancel);
        }

        if (isTerminated) {
          const mReopen = document.createElement("button");
          mReopen.type = "button";
          mReopen.className = "admin-table-btn approve";
          mReopen.textContent = "↺ Reopen as Pending";
          mReopen.onclick = async () => {
            const res = await updateAdminRequestStatus(r.id, "Pending", currentAdmin.uid, { reason: "Moderator reopened from detail inspection" });
            if (res.success) {
              showToast(`Request #${r.id} reopened as Pending.`);
              r.status = "Pending";
              const modalBackdrop = document.getElementById("adminActionModal");
              if (modalBackdrop) modalBackdrop.hidden = true;
              renderTable();
            } else {
              showToast(res.error || "Failed to reopen request.");
            }
          };
          modButtons.appendChild(mReopen);
        }

        modWrap.appendChild(modButtons);
        grid.appendChild(modWrap);

        modalContent.appendChild(grid);

        showDetailModal({
          title: `Service Request #${r.id}`,
          contentNode: modalContent,
          isWide: true
        });
      };
      actionsBox.appendChild(inspectBtn);

      // 2. Table-level contextual action buttons
      if (r.status === "Pending") {
        const acceptBtn = document.createElement("button");
        acceptBtn.type = "button";
        acceptBtn.className = "admin-table-btn approve";
        acceptBtn.textContent = "Accept";
        acceptBtn.title = "Dispatch / Accept request on assigned technician's behalf";
        acceptBtn.onclick = () => {
          showConfirmModal({
            title: `Accept Request #${r.id}`,
            body: `Administratively accept Request #${r.id} on behalf of ${r.workerName || "assigned technician"}? This will activate the private chat channel.`,
            confirmText: "Accept Request",
            onConfirm: async () => {
              const res = await updateAdminRequestStatus(r.id, "Accepted", currentAdmin.uid, { reason: "Admin accepted from request fulfillment queue" });
              if (res.success) {
                showToast(`Request #${r.id} accepted. Chat enabled.`);
                r.status = "Accepted";
                renderTable();
              } else {
                showToast(res.error || "Failed to accept request.");
              }
            }
          });
        };
        actionsBox.appendChild(acceptBtn);

        const cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "admin-table-btn suspend";
        cancelBtn.textContent = "Cancel";
        cancelBtn.title = "Cancel pending request";
        cancelBtn.onclick = () => {
          showConfirmModal({
            title: `Cancel Request #${r.id}`,
            body: `Administratively cancel pending Request #${r.id} for ${r.customerName || "Customer"}?`,
            confirmText: "Cancel Request",
            onConfirm: async () => {
              const res = await updateAdminRequestStatus(r.id, "Cancelled", currentAdmin.uid, { reason: "Admin cancelled from request fulfillment queue" });
              if (res.success) {
                showToast(`Request #${r.id} cancelled.`);
                r.status = "Cancelled";
                renderTable();
              } else {
                showToast(res.error || "Failed to cancel request.");
              }
            }
          });
        };
        actionsBox.appendChild(cancelBtn);
      } else if (r.status === "Accepted") {
        const completeBtn = document.createElement("button");
        completeBtn.type = "button";
        completeBtn.className = "admin-table-btn approve";
        completeBtn.textContent = "Complete";
        completeBtn.title = "Mark request successfully fulfilled";
        completeBtn.onclick = () => {
          showConfirmModal({
            title: `Complete Request #${r.id}`,
            body: `Mark Request #${r.id} as fulfilled and completed for ${r.customerName || "Customer"}?`,
            confirmText: "Mark Completed",
            onConfirm: async () => {
              const res = await updateAdminRequestStatus(r.id, "Completed", currentAdmin.uid, { reason: "Admin marked fulfilled" });
              if (res.success) {
                showToast(`Request #${r.id} completed.`);
                r.status = "Completed";
                renderTable();
              } else {
                showToast(res.error || "Failed to complete request.");
              }
            }
          });
        };
        actionsBox.appendChild(completeBtn);

        const cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "admin-table-btn suspend";
        cancelBtn.textContent = "Cancel";
        cancelBtn.title = "Cancel active request and lock chat";
        cancelBtn.onclick = () => {
          showConfirmModal({
            title: `Cancel Active Request #${r.id}`,
            body: `Cancel active Request #${r.id}? In-app chat between customer and worker will be deactivated.`,
            confirmText: "Cancel Request",
            onConfirm: async () => {
              const res = await updateAdminRequestStatus(r.id, "Cancelled", currentAdmin.uid, { reason: "Admin cancelled active request" });
              if (res.success) {
                showToast(`Request #${r.id} cancelled.`);
                r.status = "Cancelled";
                renderTable();
              } else {
                showToast(res.error || "Failed to cancel request.");
              }
            }
          });
        };
        actionsBox.appendChild(cancelBtn);
      } else if (r.status === "Cancelled" || r.status === "Rejected") {
        const reopenBtn = document.createElement("button");
        reopenBtn.type = "button";
        reopenBtn.className = "admin-table-btn approve";
        reopenBtn.textContent = "Reopen";
        reopenBtn.title = "Reopen request to Pending status";
        reopenBtn.onclick = () => {
          showConfirmModal({
            title: `Reopen Request #${r.id}`,
            body: `Reopen Request #${r.id} and return it to Pending status for fulfillment?`,
            confirmText: "Reopen as Pending",
            onConfirm: async () => {
              const res = await updateAdminRequestStatus(r.id, "Pending", currentAdmin.uid, { reason: "Admin reopened request" });
              if (res.success) {
                showToast(`Request #${r.id} reopened as Pending.`);
                r.status = "Pending";
                renderTable();
              } else {
                showToast(res.error || "Failed to reopen request.");
              }
            }
          });
        };
        actionsBox.appendChild(reopenBtn);
      }

      tdActions.appendChild(actionsBox);
      row.appendChild(tdActions);

      tbody.appendChild(row);
    }

    table.appendChild(tbody);
    applyResponsiveTableLabels(table);
    tableWrap.appendChild(table);
  };

  searchInput.addEventListener("input", (e) => {
    tabFilterState.requests.query = e.target.value;
    renderTable();
  });

  stSelect.addEventListener("change", (e) => {
    tabFilterState.requests.status = e.target.value;
    renderTable();
  });

  resetBtn.addEventListener("click", () => {
    tabFilterState.requests = { query: "", status: "all" };
    searchInput.value = "";
    stSelect.value = "all";
    renderTable();
  });

  renderTable();
}

// ----------------------------------------------------------------------------
// 5. TRUST & SAFETY: Reports
// ----------------------------------------------------------------------------
async function renderReportsView(container) {
  const reports = await getAdminReports();
  container.replaceChildren();

  // Header
  const header = document.createElement("div");
  header.className = "admin-view-header";
  const titleBox = document.createElement("div");
  titleBox.className = "admin-view-title";
  const h2 = document.createElement("h2");
  h2.textContent = "Trust & Safety Incident Reports";
  const p = document.createElement("p");
  p.textContent = "Review safety reports regarding workers, customers, reviews, and conduct violations.";
  titleBox.appendChild(h2);
  titleBox.appendChild(p);
  header.appendChild(titleBox);
  container.appendChild(header);

  // Toolbar
  const toolbar = document.createElement("div");
  toolbar.className = "admin-toolbar";

  const searchBox = document.createElement("div");
  searchBox.className = "admin-toolbar-search";
  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.className = "admin-search-input";
  searchInput.placeholder = "Search reports by ID, reason, or target...";
  searchInput.value = tabFilterState.reports.query || "";
  searchBox.appendChild(searchInput);

  const filtersBox = document.createElement("div");
  filtersBox.className = "admin-toolbar-filters";

  const stSelect = document.createElement("select");
  stSelect.className = "admin-select-input";
  [
    { val: "all", label: "All Statuses" },
    { val: "pending", label: "Pending" },
    { val: "under_review", label: "Under Review" },
    { val: "resolved", label: "Resolved" },
    { val: "dismissed", label: "Dismissed" }
  ].forEach((opt) => {
    const o = document.createElement("option");
    o.value = opt.val;
    o.textContent = opt.label;
    o.selected = tabFilterState.reports.status === opt.val;
    stSelect.appendChild(o);
  });

  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "admin-btn-subtle";
  resetBtn.textContent = "Reset";

  filtersBox.appendChild(stSelect);
  filtersBox.appendChild(resetBtn);

  toolbar.appendChild(searchBox);
  toolbar.appendChild(filtersBox);
  container.appendChild(toolbar);

  const tableWrap = document.createElement("div");
  tableWrap.className = "admin-table-container";
  container.appendChild(tableWrap);

  const renderTable = () => {
    tableWrap.replaceChildren();

    const q = (tabFilterState.reports.query || "").toLowerCase().trim();
    const sFilter = tabFilterState.reports.status;

    const filtered = reports.filter((rep) => {
      if (q) {
        const idMatch = String(rep.id || "").toLowerCase().includes(q);
        const reasonMatch = String(rep.reason || "").toLowerCase().includes(q);
        const targetMatch = String(rep.targetId || rep.targetType || "").toLowerCase().includes(q);
        if (!idMatch && !reasonMatch && !targetMatch) return false;
      }
      if (sFilter !== "all" && String(rep.status || "pending").toLowerCase() !== sFilter.toLowerCase()) return false;
      return true;
    });

    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "admin-empty-state";
      const h3 = document.createElement("h3");
      h3.textContent = "No active safety reports";
      const sub = document.createElement("p");
      sub.textContent = "No safety reports match the current filter.";
      empty.appendChild(h3);
      empty.appendChild(sub);
      tableWrap.appendChild(empty);
      return;
    }

    const table = document.createElement("table");
    table.className = "admin-table";

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    ["ID", "Target", "Reason", "Status", "Reported At", "Actions"].forEach((txt) => {
      const th = document.createElement("th");
      th.textContent = txt;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const rep of filtered) {
      const row = document.createElement("tr");

      const tdId = document.createElement("td");
      tdId.textContent = String(rep.id);
      row.appendChild(tdId);

      const tdTarget = document.createElement("td");
      tdTarget.textContent = `${rep.targetType || "entity"}: #${rep.targetId || "—"}`;
      row.appendChild(tdTarget);

      const tdReason = document.createElement("td");
      tdReason.textContent = String(rep.reason || "Safety issue");
      row.appendChild(tdReason);

      const tdStatus = document.createElement("td");
      const stPill = document.createElement("span");
      stPill.className = `admin-status-pill ${rep.status || "pending"}`;
      stPill.textContent = String(rep.status || "pending");
      tdStatus.appendChild(stPill);
      row.appendChild(tdStatus);

      const tdDate = document.createElement("td");
      tdDate.textContent = formatDateOnly(rep.createdAt);
      row.appendChild(tdDate);

      const tdActions = document.createElement("td");
      const actionsBox = document.createElement("div");
      actionsBox.className = "admin-table-actions";

      // Inspect modal
      const inspectBtn = document.createElement("button");
      inspectBtn.type = "button";
      inspectBtn.className = "admin-table-btn";
      inspectBtn.textContent = "Inspect";
      inspectBtn.onclick = () => {
        const modalContent = document.createElement("div");
        const grid = document.createElement("div");
        grid.className = "admin-detail-grid";

        grid.appendChild(createDetailItem("Report ID", rep.id));
        grid.appendChild(createDetailItem("Status", rep.status || "pending"));
        grid.appendChild(createDetailItem("Target Entity", `${rep.targetType}: #${rep.targetId}`));
        grid.appendChild(createDetailItem("Reported At", formatDateTime(rep.createdAt)));
        grid.appendChild(createDetailItem("Report Reason", rep.reason, true));
        if (rep.reporterId) grid.appendChild(createDetailItem("Reporter UID", rep.reporterId));
        if (rep.details) grid.appendChild(createDetailItem("Additional Context", JSON.stringify(rep.details, null, 2), true));

        modalContent.appendChild(grid);

        showDetailModal({
          title: `Incident Report #${rep.id}`,
          contentNode: modalContent,
          isWide: true
        });
      };
      actionsBox.appendChild(inspectBtn);

      if (rep.status !== "under_review" && rep.status !== "resolved") {
        const reviewBtn = document.createElement("button");
        reviewBtn.type = "button";
        reviewBtn.className = "admin-table-btn";
        reviewBtn.textContent = "Under Review";
        reviewBtn.onclick = async () => {
          const res = await updateAdminReportStatus(rep.id, "under_review", currentAdmin.uid);
          if (res.success) {
            showToast("Report marked under review.");
            rep.status = "under_review";
            renderTable();
          }
        };
        actionsBox.appendChild(reviewBtn);
      }

      if (rep.status !== "resolved") {
        const resolveBtn = document.createElement("button");
        resolveBtn.type = "button";
        resolveBtn.className = "admin-table-btn approve";
        resolveBtn.textContent = "Resolve";
        resolveBtn.onclick = () => {
          showConfirmModal({
            title: "Resolve Incident Report",
            body: `Mark report #${rep.id} as resolved?`,
            confirmText: "Mark Resolved",
            onConfirm: async () => {
              const res = await updateAdminReportStatus(rep.id, "resolved", currentAdmin.uid);
              if (res.success) {
                showToast("Report resolved.");
                rep.status = "resolved";
                renderTable();
              }
            }
          });
        };
        actionsBox.appendChild(resolveBtn);
      }

      if (rep.status !== "dismissed") {
        const dismissBtn = document.createElement("button");
        dismissBtn.type = "button";
        dismissBtn.className = "admin-table-btn suspend";
        dismissBtn.textContent = "Dismiss";
        dismissBtn.onclick = () => {
          showConfirmModal({
            title: "Dismiss Incident Report",
            body: `Dismiss report #${rep.id}?`,
            confirmText: "Dismiss Report",
            onConfirm: async () => {
              const res = await updateAdminReportStatus(rep.id, "dismissed", currentAdmin.uid);
              if (res.success) {
                showToast("Report dismissed.");
                rep.status = "dismissed";
                renderTable();
              }
            }
          });
        };
        actionsBox.appendChild(dismissBtn);
      }

      tdActions.appendChild(actionsBox);
      row.appendChild(tdActions);
      tbody.appendChild(row);
    }

    table.appendChild(tbody);
    applyResponsiveTableLabels(table);
    tableWrap.appendChild(table);
  };

  searchInput.addEventListener("input", (e) => {
    tabFilterState.reports.query = e.target.value;
    renderTable();
  });

  stSelect.addEventListener("change", (e) => {
    tabFilterState.reports.status = e.target.value;
    renderTable();
  });

  resetBtn.addEventListener("click", () => {
    tabFilterState.reports = { query: "", status: "all" };
    searchInput.value = "";
    stSelect.value = "all";
    renderTable();
  });

  renderTable();
}

// ----------------------------------------------------------------------------
// 6. TRUST & SAFETY: Reviews
// ----------------------------------------------------------------------------
async function renderReviewsView(container) {
  const [reviews, allReports] = await Promise.all([
    getAdminReviews(),
    getAdminReports().catch(() => [])
  ]);
  const reportsByReviewId = new Map();
  for (const rep of allReports || []) {
    if (rep && rep.targetType === "review" && rep.targetId) {
      const key = String(rep.targetId);
      if (!reportsByReviewId.has(key)) reportsByReviewId.set(key, []);
      reportsByReviewId.get(key).push(rep);
    }
  }
  container.replaceChildren();

  // Header
  const header = document.createElement("div");
  header.className = "admin-view-header";
  const titleBox = document.createElement("div");
  titleBox.className = "admin-view-title";
  const h2 = document.createElement("h2");
  h2.textContent = "Customer Review Moderation";
  const p = document.createElement("p");
  p.textContent = "Audit customer ratings, review commentary, abuse signals, and worker public reputations.";
  titleBox.appendChild(h2);
  titleBox.appendChild(p);
  header.appendChild(titleBox);
  container.appendChild(header);

  // Toolbar
  const toolbar = document.createElement("div");
  toolbar.className = "admin-toolbar";

  const searchBox = document.createElement("div");
  searchBox.className = "admin-toolbar-search";
  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.className = "admin-search-input";
  searchInput.placeholder = "Search reviews by text, customer, worker, or ID...";
  searchInput.value = tabFilterState.reviews.query || "";
  searchBox.appendChild(searchInput);

  const filtersBox = document.createElement("div");
  filtersBox.className = "admin-toolbar-filters";

  const stSelect = document.createElement("select");
  stSelect.className = "admin-select-input";
  [
    { val: "all", label: "All Moderation States" },
    { val: "published", label: "Published" },
    { val: "hidden", label: "Hidden" },
    { val: "flagged", label: "Flagged" }
  ].forEach((opt) => {
    const o = document.createElement("option");
    o.value = opt.val;
    o.textContent = opt.label;
    o.selected = tabFilterState.reviews.status === opt.val;
    stSelect.appendChild(o);
  });

  const ratingSelect = document.createElement("select");
  ratingSelect.className = "admin-select-input";
  [
    { val: "all", label: "All Ratings" },
    { val: "5", label: "5 Stars" },
    { val: "4", label: "4 Stars" },
    { val: "3", label: "3 Stars" },
    { val: "2", label: "2 Stars" },
    { val: "1", label: "1 Star" }
  ].forEach((opt) => {
    const o = document.createElement("option");
    o.value = opt.val;
    o.textContent = opt.label;
    o.selected = tabFilterState.reviews.rating === opt.val;
    ratingSelect.appendChild(o);
  });

  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "admin-btn-subtle";
  resetBtn.textContent = "Reset";

  filtersBox.appendChild(stSelect);
  filtersBox.appendChild(ratingSelect);
  filtersBox.appendChild(resetBtn);

  toolbar.appendChild(searchBox);
  toolbar.appendChild(filtersBox);
  container.appendChild(toolbar);

  const tableWrap = document.createElement("div");
  tableWrap.className = "admin-table-container";
  container.appendChild(tableWrap);

  const renderTable = () => {
    tableWrap.replaceChildren();

    const q = (tabFilterState.reviews.query || "").toLowerCase().trim();
    const sFilter = tabFilterState.reviews.status;
    const rFilter = tabFilterState.reviews.rating;

    const filtered = reviews.filter((rev) => {
      if (q) {
        const idMatch = String(rev.id || "").toLowerCase().includes(q);
        const textMatch = String(rev.text || "").toLowerCase().includes(q);
        const custMatch = String(rev.customerName || rev.customerId || "").toLowerCase().includes(q);
        const workerMatch = String(rev.workerName || rev.workerId || "").toLowerCase().includes(q);
        if (!idMatch && !textMatch && !custMatch && !workerMatch) return false;
      }
      if (sFilter !== "all" && String(rev.status || "published").toLowerCase() !== sFilter.toLowerCase()) return false;
      if (rFilter !== "all" && String(rev.rating) !== rFilter) return false;
      return true;
    });

    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "admin-empty-state";
      const h3 = document.createElement("h3");
      h3.textContent = "No customer reviews found";
      const sub = document.createElement("p");
      sub.textContent = "No reviews match the current search or moderation filters.";
      empty.appendChild(h3);
      empty.appendChild(sub);
      tableWrap.appendChild(empty);
      return;
    }

    const table = document.createElement("table");
    table.className = "admin-table";

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    ["Request / ID", "Type", "Customer", "Worker", "Rating", "Review & Tags", "Reports", "Submitted", "Status", "Actions"].forEach((txt) => {
      const th = document.createElement("th");
      th.textContent = txt;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const rev of filtered) {
      const row = document.createElement("tr");
      const linkedReports = reportsByReviewId.get(String(rev.id)) || [];
      const ratingNum = Number(rev.rating);
      const validRatingStr = Number.isInteger(ratingNum) && ratingNum >= 1 && ratingNum <= 5
        ? `★ ${ratingNum}.0`
        : "—";
      const isVerifiedWorkRev = rev.reviewType === "unverified_experience"
        ? false
        : (rev.reviewType === "verified_work" || rev.verifiedService === true || Boolean(rev.requestId));
      const revTypeLabel = isVerifiedWorkRev ? "Verified Work" : "Unverified Experience";

      const tdId = document.createElement("td");
      tdId.textContent = String(rev.requestId || rev.id);
      row.appendChild(tdId);

      const tdType = document.createElement("td");
      const typePill = document.createElement("span");
      typePill.className = `admin-status-pill ${isVerifiedWorkRev ? "verified" : "pending"}`;
      typePill.textContent = revTypeLabel;
      tdType.appendChild(typePill);
      row.appendChild(tdType);

      const tdCust = document.createElement("td");
      tdCust.textContent = String(rev.customerName || rev.customerId || "—");
      row.appendChild(tdCust);

      const tdWorker = document.createElement("td");
      tdWorker.textContent = String(rev.workerName || rev.workerId || "—");
      row.appendChild(tdWorker);

      const tdRating = document.createElement("td");
      tdRating.textContent = validRatingStr;
      row.appendChild(tdRating);

      const tdText = document.createElement("td");
      const rawText = String(rev.text || "").trim();
      const tagSummary = Array.isArray(rev.tags) && rev.tags.length > 0 ? `[${rev.tags.join(", ")}] ` : "";
      const preview = `${tagSummary}${rawText || "No written commentary"}`;
      tdText.textContent = preview.length > 56 ? `${preview.substring(0, 56)}...` : preview;
      tdText.title = preview;
      row.appendChild(tdText);

      const tdReports = document.createElement("td");
      tdReports.textContent = linkedReports.length > 0 ? `${linkedReports.length} report${linkedReports.length === 1 ? "" : "s"}` : "0";
      row.appendChild(tdReports);

      const tdDate = document.createElement("td");
      tdDate.textContent = formatDateTime(rev.createdAt);
      row.appendChild(tdDate);

      const tdStatus = document.createElement("td");
      const stPill = document.createElement("span");
      stPill.className = `admin-status-pill ${rev.status || "published"}`;
      stPill.textContent = String(rev.status || "published");
      tdStatus.appendChild(stPill);
      row.appendChild(tdStatus);

      const tdActions = document.createElement("td");
      const actionsBox = document.createElement("div");
      actionsBox.className = "admin-table-actions";

      // Inspect review with full context, worker reply, reports, edit & moderation history
      const inspectBtn = document.createElement("button");
      inspectBtn.type = "button";
      inspectBtn.className = "admin-table-btn";
      inspectBtn.textContent = "Inspect";
      inspectBtn.onclick = () => {
        const modalContent = document.createElement("div");
        const grid = document.createElement("div");
        grid.className = "admin-detail-grid";

        grid.appendChild(createDetailItem("Review ID", rev.id));
        grid.appendChild(createDetailItem("Review Type", revTypeLabel));
        grid.appendChild(createDetailItem("Related Service Request", rev.requestId || "None (General Feedback)"));
        grid.appendChild(createDetailItem("Rating", validRatingStr));
        grid.appendChild(createDetailItem("Publication Status", rev.status || "published"));
        grid.appendChild(createDetailItem("Customer", `${rev.customerName || "Customer"} (${rev.customerId || "—"})`));
        grid.appendChild(createDetailItem("Worker", `${rev.workerName || "Worker"} (${rev.workerUid || rev.workerId || "—"})`));
        grid.appendChild(createDetailItem("Submitted At", formatDateTime(rev.createdAt)));
        if (Array.isArray(rev.tags) && rev.tags.length > 0) {
          grid.appendChild(createDetailItem("Experience Tags", rev.tags.join(", ")));
        }
        grid.appendChild(createDetailItem("Full Review Content", rawText || "Rated without written commentary.", true));

        const workerReplyText = rev.workerReply || rev.workerResponse || null;
        if (workerReplyText) {
          const replyMeta = rev.workerReplyAt ? ` (${formatDateTime(rev.workerReplyAt)})` : "";
          grid.appendChild(createDetailItem(`Worker Public Response${replyMeta}`, workerReplyText, true));
        } else {
          grid.appendChild(createDetailItem("Worker Public Response", "No worker response posted.", true));
        }

        if (Array.isArray(rev.editHistory) && rev.editHistory.length > 0) {
          const editSummary = rev.editHistory
            .map((e, i) => `#${i + 1} (${formatDateTime(e.editedAt)}): ★ ${e.previousRating} — "${e.previousText || ""}"`)
            .join("\n");
          grid.appendChild(createDetailItem(`Customer Edit History (${rev.editHistory.length})`, editSummary, true));
        }

        if (linkedReports.length > 0) {
          const repSummary = linkedReports
            .map((r) => `[${r.status || "open"}] ${r.reason || "reported"} by ${r.reporterUid || "user"}: ${r.description || "No details"}`)
            .join("\n");
          grid.appendChild(createDetailItem(`Linked Customer Reports (${linkedReports.length})`, repSummary, true));
        } else {
          grid.appendChild(createDetailItem("Linked Customer Reports", "No customer reports filed against this review.", true));
        }

        const modHistory = Array.isArray(rev.moderationHistory) ? rev.moderationHistory : [];
        if (modHistory.length > 0) {
          const histText = modHistory
            .map((m) => `${formatDateTime(m.moderatedAt)} · ${m.previousStatus} → ${m.newStatus} by ${m.moderatedBy}${m.note ? ` (${m.note})` : ""}`)
            .join("\n");
          grid.appendChild(createDetailItem(`Moderation History (${modHistory.length})`, histText, true));
        } else if (rev.moderatedAt) {
          grid.appendChild(createDetailItem("Last Moderated", `${formatDateTime(rev.moderatedAt)} by ${rev.moderatedBy || "admin"}`, true));
        } else {
          grid.appendChild(createDetailItem("Moderation History", "No moderation actions recorded.", true));
        }

        modalContent.appendChild(grid);

        showDetailModal({
          title: `Review Inspection #${rev.id}`,
          contentNode: modalContent,
          isWide: true
        });
      };
      actionsBox.appendChild(inspectBtn);

      if (rev.status !== "published") {
        const pubBtn = document.createElement("button");
        pubBtn.type = "button";
        pubBtn.className = "admin-table-btn approve";
        pubBtn.textContent = "Restore";
        pubBtn.onclick = async () => {
          const res = await updateAdminReviewStatus(rev.id, "published", currentAdmin.uid, "Restored by administrator");
          if (res.success) {
            showToast("Review restored & worker rating recalculated.");
            rev.status = "published";
            if (Array.isArray(res.moderationHistory)) rev.moderationHistory = res.moderationHistory;
            renderTable();
          }
        };
        actionsBox.appendChild(pubBtn);
      }

      if (rev.status !== "hidden") {
        const hideBtn = document.createElement("button");
        hideBtn.type = "button";
        hideBtn.className = "admin-table-btn suspend";
        hideBtn.textContent = "Hide";
        hideBtn.onclick = async () => {
          const res = await updateAdminReviewStatus(rev.id, "hidden", currentAdmin.uid, "Hidden by administrator");
          if (res.success) {
            showToast("Review hidden & worker rating recalculated.");
            rev.status = "hidden";
            if (Array.isArray(res.moderationHistory)) rev.moderationHistory = res.moderationHistory;
            renderTable();
          }
        };
        actionsBox.appendChild(hideBtn);
      }

      tdActions.appendChild(actionsBox);
      row.appendChild(tdActions);
      tbody.appendChild(row);
    }

    table.appendChild(tbody);
    applyResponsiveTableLabels(table);
    tableWrap.appendChild(table);
  };

  searchInput.addEventListener("input", (e) => {
    tabFilterState.reviews.query = e.target.value;
    renderTable();
  });

  stSelect.addEventListener("change", (e) => {
    tabFilterState.reviews.status = e.target.value;
    renderTable();
  });

  ratingSelect.addEventListener("change", (e) => {
    tabFilterState.reviews.rating = e.target.value;
    renderTable();
  });

  resetBtn.addEventListener("click", () => {
    tabFilterState.reviews = { query: "", status: "all", rating: "all" };
    searchInput.value = "";
    stSelect.value = "all";
    ratingSelect.value = "all";
    renderTable();
  });

  renderTable();
}

// ----------------------------------------------------------------------------
// 7. TRUST & SAFETY: Trust & Safety Hub
// ----------------------------------------------------------------------------
async function renderTrustSafetyView(container) {
  const [reports, reviews, events] = await Promise.all([
    getAdminReports(),
    getAdminReviews(),
    getAdminSecurityEvents()
  ]);

  container.replaceChildren();

  // Header
  const header = document.createElement("div");
  header.className = "admin-view-header";
  const titleBox = document.createElement("div");
  titleBox.className = "admin-view-title";
  const h2 = document.createElement("h2");
  h2.textContent = "Trust & Safety Command Hub";
  const p = document.createElement("p");
  p.textContent = "Integrated platform integrity operations: open incident queues, review moderation, and abuse mitigation.";
  titleBox.appendChild(h2);
  titleBox.appendChild(p);
  header.appendChild(titleBox);
  container.appendChild(header);

  // Summary Metrics
  const openReports = reports.filter((r) => r.status !== "resolved" && r.status !== "dismissed");
  const flaggedReviews = reviews.filter((r) => r.status === "flagged" || r.status === "hidden");

  const summaryGrid = document.createElement("div");
  summaryGrid.className = "admin-metrics-grid";

  const summaryItems = [
    { label: "Active Safety Reports", value: openReports.length, note: "Incident inquiries requiring action" },
    { label: "Flagged Reviews", value: flaggedReviews.length, note: "Questionable or hidden customer ratings" },
    { label: "Security Signals", value: events.length, note: "Logged anomalous requests or rate limits" }
  ];

  for (const item of summaryItems) {
    const card = document.createElement("div");
    card.className = "admin-metric-card";
    const lbl = document.createElement("div");
    lbl.className = "admin-metric-label";
    lbl.textContent = item.label;
    const val = document.createElement("div");
    val.className = "admin-metric-value";
    val.textContent = String(item.value);
    const note = document.createElement("div");
    note.className = "admin-metric-note";
    note.textContent = item.note;
    card.appendChild(lbl);
    card.appendChild(val);
    card.appendChild(note);
    summaryGrid.appendChild(card);
  }
  container.appendChild(summaryGrid);

  // Section 1: Open Safety Reports Action Queue
  const repHeading = document.createElement("div");
  repHeading.className = "admin-section-heading";
  const repH3 = document.createElement("h3");
  repH3.textContent = "Open Safety Inquiries Queue";
  const repBtn = document.createElement("button");
  repBtn.type = "button";
  repBtn.className = "admin-btn-subtle";
  repBtn.textContent = "Manage All Reports →";
  repBtn.onclick = () => navigateToTab("reports");
  repHeading.appendChild(repH3);
  repHeading.appendChild(repBtn);
  container.appendChild(repHeading);

  if (openReports.length === 0) {
    const empty = document.createElement("div");
    empty.className = "admin-empty-state";
    const sub = document.createElement("p");
    sub.textContent = "No open incident reports currently awaiting review.";
    empty.appendChild(sub);
    container.appendChild(empty);
  } else {
    const tableWrap = document.createElement("div");
    tableWrap.className = "admin-table-container";
    const table = document.createElement("table");
    table.className = "admin-table";
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    ["ID", "Target", "Reason", "Status", "Quick Actions"].forEach((txt) => {
      const th = document.createElement("th");
      th.textContent = txt;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const rep of openReports.slice(0, 5)) {
      const row = document.createElement("tr");

      const tdId = document.createElement("td");
      tdId.textContent = String(rep.id);
      row.appendChild(tdId);

      const tdTarget = document.createElement("td");
      tdTarget.textContent = `${rep.targetType}: #${rep.targetId}`;
      row.appendChild(tdTarget);

      const tdReason = document.createElement("td");
      tdReason.textContent = String(rep.reason || "Safety issue");
      row.appendChild(tdReason);

      const tdStatus = document.createElement("td");
      const stPill = document.createElement("span");
      stPill.className = `admin-status-pill ${rep.status || "pending"}`;
      stPill.textContent = String(rep.status || "pending");
      tdStatus.appendChild(stPill);
      row.appendChild(tdStatus);

      const tdAct = document.createElement("td");
      const box = document.createElement("div");
      box.className = "admin-table-actions";

      const resolveBtn = document.createElement("button");
      resolveBtn.type = "button";
      resolveBtn.className = "admin-table-btn approve";
      resolveBtn.textContent = "Resolve";
      resolveBtn.onclick = async () => {
        const res = await updateAdminReportStatus(rep.id, "resolved", currentAdmin.uid);
        if (res.success) {
          showToast("Report resolved.");
          renderActiveView();
        }
      };
      box.appendChild(resolveBtn);

      const dismissBtn = document.createElement("button");
      dismissBtn.type = "button";
      dismissBtn.className = "admin-table-btn suspend";
      dismissBtn.textContent = "Dismiss";
      dismissBtn.onclick = async () => {
        const res = await updateAdminReportStatus(rep.id, "dismissed", currentAdmin.uid);
        if (res.success) {
          showToast("Report dismissed.");
          renderActiveView();
        }
      };
      box.appendChild(dismissBtn);

      tdAct.appendChild(box);
      row.appendChild(tdAct);
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    applyResponsiveTableLabels(table);
    tableWrap.appendChild(table);
    container.appendChild(tableWrap);
  }

  // Section 2: Flagged Reviews Action Queue
  const revHeading = document.createElement("div");
  revHeading.className = "admin-section-heading";
  const revH3 = document.createElement("h3");
  revH3.textContent = "Flagged & Hidden Reviews Queue";
  const revBtn = document.createElement("button");
  revBtn.type = "button";
  revBtn.className = "admin-btn-subtle";
  revBtn.textContent = "Manage All Reviews →";
  revBtn.onclick = () => navigateToTab("reviews");
  revHeading.appendChild(revH3);
  revHeading.appendChild(revBtn);
  container.appendChild(revHeading);

  if (flaggedReviews.length === 0) {
    const empty = document.createElement("div");
    empty.className = "admin-empty-state";
    const sub = document.createElement("p");
    sub.textContent = "No reviews currently flagged or awaiting moderation.";
    empty.appendChild(sub);
    container.appendChild(empty);
  } else {
    const tableWrap = document.createElement("div");
    tableWrap.className = "admin-table-container";
    const table = document.createElement("table");
    table.className = "admin-table";
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    ["ID", "Worker", "Rating", "Review Excerpt", "Status", "Quick Actions"].forEach((txt) => {
      const th = document.createElement("th");
      th.textContent = txt;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const rev of flaggedReviews.slice(0, 5)) {
      const row = document.createElement("tr");

      const tdId = document.createElement("td");
      tdId.textContent = String(rev.id);
      row.appendChild(tdId);

      const tdWorker = document.createElement("td");
      tdWorker.textContent = String(rev.workerName || rev.workerId || "—");
      row.appendChild(tdWorker);

      const tdRating = document.createElement("td");
      const rVal = Number(rev.rating);
      tdRating.textContent = Number.isInteger(rVal) && rVal >= 1 && rVal <= 5 ? `★ ${rVal}.0` : "—";
      row.appendChild(tdRating);

      const tdText = document.createElement("td");
      const preview = String(rev.text || "No written commentary");
      tdText.textContent = preview.length > 40 ? `${preview.substring(0, 40)}...` : preview;
      row.appendChild(tdText);

      const tdStatus = document.createElement("td");
      const stPill = document.createElement("span");
      stPill.className = `admin-status-pill ${rev.status || "flagged"}`;
      stPill.textContent = String(rev.status || "flagged");
      tdStatus.appendChild(stPill);
      row.appendChild(tdStatus);

      const tdAct = document.createElement("td");
      const box = document.createElement("div");
      box.className = "admin-table-actions";

      const pubBtn = document.createElement("button");
      pubBtn.type = "button";
      pubBtn.className = "admin-table-btn approve";
      pubBtn.textContent = "Restore";
      pubBtn.onclick = async () => {
        const res = await updateAdminReviewStatus(rev.id, "published", currentAdmin.uid, "Restored from flagged queue");
        if (res.success) {
          showToast("Review restored & rating recalculated.");
          renderActiveView();
        }
      };
      box.appendChild(pubBtn);

      const hideBtn = document.createElement("button");
      hideBtn.type = "button";
      hideBtn.className = "admin-table-btn suspend";
      hideBtn.textContent = "Hide";
      hideBtn.onclick = async () => {
        const res = await updateAdminReviewStatus(rev.id, "hidden", currentAdmin.uid, "Hidden from flagged queue");
        if (res.success) {
          showToast("Review hidden & rating recalculated.");
          renderActiveView();
        }
      };
      box.appendChild(hideBtn);

      tdAct.appendChild(box);
      row.appendChild(tdAct);
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    applyResponsiveTableLabels(table);
    tableWrap.appendChild(table);
    container.appendChild(tableWrap);
  }

  // Section 3: Abuse Prevention Controls & Policy Summary
  const abuseHeading = document.createElement("div");
  abuseHeading.className = "admin-section-heading";
  const abuseH3 = document.createElement("h3");
  abuseH3.textContent = "Platform Abuse Defense Controls";
  abuseHeading.appendChild(abuseH3);
  container.appendChild(abuseHeading);

  const abuseGrid = document.createElement("div");
  abuseGrid.className = "admin-settings-grid";

  const abuseControls = [
    {
      title: "Request Throttling & Rate Limits",
      desc: "Client-side and security rule thresholds enforce maximum request velocities (5 requests/minute for sensitive actions) to prevent denial of service and automated scraping."
    },
    {
      title: "Authentication Rate Limiting",
      desc: "Exponential backoff delays and temporary account locks apply on successive failed login attempts, guarding admin and user identities against brute force attacks."
    },
    {
      title: "Content Sanitization & XSS Defense",
      desc: "Zero innerHTML policy across user, worker, and admin interfaces. All text commentary and review contents are rendered via safe native textContent DOM nodes."
    },
    {
      title: "Immutable Operational Audit Trail",
      desc: "All approval, suspension, resolution, and status changes generate an append-only audit record in Cloud Firestore with the operator's verified Firebase UID and timestamp."
    }
  ];

  for (const c of abuseControls) {
    const card = document.createElement("div");
    card.className = "admin-settings-card";
    const h4 = document.createElement("h3");
    h4.textContent = c.title;
    const bodyP = document.createElement("p");
    bodyP.textContent = c.desc;
    card.appendChild(h4);
    card.appendChild(bodyP);
    abuseGrid.appendChild(card);
  }
  container.appendChild(abuseGrid);
}

// ----------------------------------------------------------------------------
// 8. SYSTEM: Security & Abuse
// ----------------------------------------------------------------------------
async function renderSecurityView(container) {
  const events = await getAdminSecurityEvents();
  container.replaceChildren();

  // Header
  const header = document.createElement("div");
  header.className = "admin-view-header";
  const titleBox = document.createElement("div");
  titleBox.className = "admin-view-title";
  const h2 = document.createElement("h2");
  h2.textContent = "Security & Abuse Signals";
  const p = document.createElement("p");
  p.textContent = "Real-time security signals, suspicious request detections, and client integrity logs.";
  titleBox.appendChild(h2);
  titleBox.appendChild(p);
  header.appendChild(titleBox);
  container.appendChild(header);

  // Toolbar
  const toolbar = document.createElement("div");
  toolbar.className = "admin-toolbar";

  const searchBox = document.createElement("div");
  searchBox.className = "admin-toolbar-search";
  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.className = "admin-search-input";
  searchInput.placeholder = "Search security signals by type, actor, or ID...";
  searchInput.value = tabFilterState.security.query || "";
  searchBox.appendChild(searchInput);

  const filtersBox = document.createElement("div");
  filtersBox.className = "admin-toolbar-filters";

  const sevSelect = document.createElement("select");
  sevSelect.className = "admin-select-input";
  [
    { val: "all", label: "All Severities" },
    { val: "high", label: "High Severity" },
    { val: "medium", label: "Medium Severity" },
    { val: "low", label: "Low Severity" }
  ].forEach((opt) => {
    const o = document.createElement("option");
    o.value = opt.val;
    o.textContent = opt.label;
    o.selected = tabFilterState.security.severity === opt.val;
    sevSelect.appendChild(o);
  });

  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "admin-btn-subtle";
  resetBtn.textContent = "Reset";

  filtersBox.appendChild(sevSelect);
  filtersBox.appendChild(resetBtn);

  toolbar.appendChild(searchBox);
  toolbar.appendChild(filtersBox);
  container.appendChild(toolbar);

  const tableWrap = document.createElement("div");
  tableWrap.className = "admin-table-container";
  container.appendChild(tableWrap);

  const renderTable = () => {
    tableWrap.replaceChildren();

    const q = (tabFilterState.security.query || "").toLowerCase().trim();
    const sFilter = tabFilterState.security.severity;

    const filtered = events.filter((ev) => {
      if (q) {
        const idMatch = String(ev.id || "").toLowerCase().includes(q);
        const typeMatch = String(ev.type || ev.action || "").toLowerCase().includes(q);
        const actorMatch = String(ev.role || ev.actor || "").toLowerCase().includes(q);
        if (!idMatch && !typeMatch && !actorMatch) return false;
      }
      if (sFilter !== "all" && String(ev.severity || "medium").toLowerCase() !== sFilter.toLowerCase()) return false;
      return true;
    });

    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "admin-empty-state";
      const h3 = document.createElement("h3");
      h3.textContent = "No security events recorded";
      const sub = document.createElement("p");
      sub.textContent = "No anomalous or suspicious activities have been flagged.";
      empty.appendChild(h3);
      empty.appendChild(sub);
      tableWrap.appendChild(empty);
      return;
    }

    const table = document.createElement("table");
    table.className = "admin-table";

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    ["Event ID", "Type", "Severity", "Actor / Role", "Timestamp", "Actions"].forEach((txt) => {
      const th = document.createElement("th");
      th.textContent = txt;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const ev of filtered) {
      const row = document.createElement("tr");

      const tdId = document.createElement("td");
      tdId.textContent = String(ev.id);
      row.appendChild(tdId);

      const tdType = document.createElement("td");
      tdType.textContent = String(ev.type || ev.action || "SECURITY_SIGNAL");
      row.appendChild(tdType);

      const tdSev = document.createElement("td");
      const sevPill = document.createElement("span");
      const sevClass = (ev.severity || "medium").toLowerCase();
      sevPill.className = `admin-status-pill ${sevClass === "high" ? "suspended" : "pending"}`;
      sevPill.textContent = String(ev.severity || "Medium");
      tdSev.appendChild(sevPill);
      row.appendChild(tdSev);

      const tdActor = document.createElement("td");
      tdActor.textContent = String(ev.role || ev.actor || "anonymous");
      row.appendChild(tdActor);

      const tdTime = document.createElement("td");
      tdTime.textContent = formatDateTime(ev.timestamp);
      row.appendChild(tdTime);

      const tdActions = document.createElement("td");
      const inspectBtn = document.createElement("button");
      inspectBtn.type = "button";
      inspectBtn.className = "admin-table-btn";
      inspectBtn.textContent = "Inspect";
      inspectBtn.onclick = () => {
        const modalContent = document.createElement("div");
        const grid = document.createElement("div");
        grid.className = "admin-detail-grid";

        grid.appendChild(createDetailItem("Event ID", ev.id));
        grid.appendChild(createDetailItem("Signal Type", ev.type || ev.action || "SECURITY_SIGNAL"));
        grid.appendChild(createDetailItem("Severity Level", ev.severity || "Medium"));
        grid.appendChild(createDetailItem("Actor / Role", ev.role || ev.actor || "anonymous"));
        grid.appendChild(createDetailItem("Detected At", formatDateTime(ev.timestamp)));
        grid.appendChild(createDetailItem("Action Taken", ev.actionTaken || "Logged to audit trail"));

        // Raw Payload
        const preWrap = document.createElement("div");
        preWrap.className = "admin-detail-item full-width";
        const preLbl = document.createElement("div");
        preLbl.className = "admin-detail-label";
        preLbl.textContent = "Event Payload Data";
        const pre = document.createElement("pre");
        pre.className = "admin-detail-pre";
        pre.textContent = JSON.stringify(ev, null, 2);
        preWrap.appendChild(preLbl);
        preWrap.appendChild(pre);
        grid.appendChild(preWrap);

        modalContent.appendChild(grid);

        showDetailModal({
          title: `Security Signal #${ev.id}`,
          contentNode: modalContent,
          isWide: true
        });
      };
      tdActions.appendChild(inspectBtn);
      row.appendChild(tdActions);

      tbody.appendChild(row);
    }

    table.appendChild(tbody);
    applyResponsiveTableLabels(table);
    tableWrap.appendChild(table);
  };

  searchInput.addEventListener("input", (e) => {
    tabFilterState.security.query = e.target.value;
    renderTable();
  });

  sevSelect.addEventListener("change", (e) => {
    tabFilterState.security.severity = e.target.value;
    renderTable();
  });

  resetBtn.addEventListener("click", () => {
    tabFilterState.security = { query: "", severity: "all" };
    searchInput.value = "";
    sevSelect.value = "all";
    renderTable();
  });

  renderTable();
}

// ----------------------------------------------------------------------------
// 9. SYSTEM: Audit Log
// ----------------------------------------------------------------------------
async function renderAuditLogView(container) {
  const logs = await getAdminAuditLogs();
  container.replaceChildren();

  // Header
  const header = document.createElement("div");
  header.className = "admin-view-header";
  const titleBox = document.createElement("div");
  titleBox.className = "admin-view-title";
  const h2 = document.createElement("h2");
  h2.textContent = "Administrative Audit Trail";
  const p = document.createElement("p");
  p.textContent = "Append-only, immutable record of privileged management operations.";
  titleBox.appendChild(h2);
  titleBox.appendChild(p);
  header.appendChild(titleBox);
  container.appendChild(header);

  // Toolbar
  const toolbar = document.createElement("div");
  toolbar.className = "admin-toolbar";

  const searchBox = document.createElement("div");
  searchBox.className = "admin-toolbar-search";
  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.className = "admin-search-input";
  searchInput.placeholder = "Search audit log by action, admin UID, or target...";
  searchInput.value = tabFilterState.audit.query || "";
  searchBox.appendChild(searchInput);

  const filtersBox = document.createElement("div");
  filtersBox.className = "admin-toolbar-filters";

  const resSelect = document.createElement("select");
  resSelect.className = "admin-select-input";
  [
    { val: "all", label: "All Results" },
    { val: "success", label: "Success Only" },
    { val: "failure", label: "Failure Only" }
  ].forEach((opt) => {
    const o = document.createElement("option");
    o.value = opt.val;
    o.textContent = opt.label;
    o.selected = tabFilterState.audit.result === opt.val;
    resSelect.appendChild(o);
  });

  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "admin-btn-subtle";
  resetBtn.textContent = "Reset";

  filtersBox.appendChild(resSelect);
  filtersBox.appendChild(resetBtn);

  toolbar.appendChild(searchBox);
  toolbar.appendChild(filtersBox);
  container.appendChild(toolbar);

  const tableWrap = document.createElement("div");
  tableWrap.className = "admin-table-container";
  container.appendChild(tableWrap);

  const renderTable = () => {
    tableWrap.replaceChildren();

    const q = (tabFilterState.audit.query || "").toLowerCase().trim();
    const rFilter = tabFilterState.audit.result;

    const filtered = logs.filter((log) => {
      if (q) {
        const actMatch = String(log.action || "").toLowerCase().includes(q);
        const adminMatch = String(log.adminUid || "").toLowerCase().includes(q);
        const targetMatch = String(log.targetId || log.targetType || "").toLowerCase().includes(q);
        if (!actMatch && !adminMatch && !targetMatch) return false;
      }
      if (rFilter !== "all" && String(log.result || "success").toLowerCase() !== rFilter.toLowerCase()) return false;
      return true;
    });

    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "admin-empty-state";
      const h3 = document.createElement("h3");
      h3.textContent = "No audit log entries match";
      const sub = document.createElement("p");
      sub.textContent = "No administrative operations match the current filter.";
      empty.appendChild(h3);
      empty.appendChild(sub);
      tableWrap.appendChild(empty);
      return;
    }

    const table = document.createElement("table");
    table.className = "admin-table";

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    ["Timestamp", "Admin UID", "Action", "Target", "Result", "Actions"].forEach((txt) => {
      const th = document.createElement("th");
      th.textContent = txt;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const log of filtered) {
      const row = document.createElement("tr");

      const tdTime = document.createElement("td");
      tdTime.textContent = formatDateTime(log.timestamp);
      row.appendChild(tdTime);

      const tdAdmin = document.createElement("td");
      tdAdmin.textContent = String(log.adminUid ? `${log.adminUid.substring(0, 8)}...` : "system");
      tdAdmin.title = String(log.adminUid || "system");
      row.appendChild(tdAdmin);

      const tdAct = document.createElement("td");
      tdAct.textContent = String(log.action || "UNKNOWN_ACTION");
      row.appendChild(tdAct);

      const tdTarget = document.createElement("td");
      tdTarget.textContent = `${log.targetType || "entity"}: #${log.targetId || "—"}`;
      row.appendChild(tdTarget);

      const tdRes = document.createElement("td");
      const resPill = document.createElement("span");
      resPill.className = `admin-status-pill ${log.result === "success" ? "active" : "suspended"}`;
      resPill.textContent = String(log.result || "success");
      tdRes.appendChild(resPill);
      row.appendChild(tdRes);

      const tdActions = document.createElement("td");
      const inspectBtn = document.createElement("button");
      inspectBtn.type = "button";
      inspectBtn.className = "admin-table-btn";
      inspectBtn.textContent = "Inspect";
      inspectBtn.onclick = () => {
        const modalContent = document.createElement("div");
        const grid = document.createElement("div");
        grid.className = "admin-detail-grid";

        grid.appendChild(createDetailItem("Log Entry ID", log.id || "Immutable Doc"));
        grid.appendChild(createDetailItem("Operation Action", log.action));
        grid.appendChild(createDetailItem("Admin UID", log.adminUid));
        grid.appendChild(createDetailItem("Target Entity", `${log.targetType}: #${log.targetId}`));
        grid.appendChild(createDetailItem("Result Outcome", log.result));
        grid.appendChild(createDetailItem("Timestamp", formatDateTime(log.timestamp)));

        if (log.details && Object.keys(log.details).length > 0) {
          const preWrap = document.createElement("div");
          preWrap.className = "admin-detail-item full-width";
          const preLbl = document.createElement("div");
          preLbl.className = "admin-detail-label";
          preLbl.textContent = "Operation Metadata & Changes";
          const pre = document.createElement("pre");
          pre.className = "admin-detail-pre";
          pre.textContent = JSON.stringify(log.details, null, 2);
          preWrap.appendChild(preLbl);
          preWrap.appendChild(pre);
          grid.appendChild(preWrap);
        }

        modalContent.appendChild(grid);

        showDetailModal({
          title: `Audit Entry: ${log.action}`,
          contentNode: modalContent,
          isWide: true
        });
      };
      tdActions.appendChild(inspectBtn);
      row.appendChild(tdActions);

      tbody.appendChild(row);
    }

    table.appendChild(tbody);
    applyResponsiveTableLabels(table);
    tableWrap.appendChild(table);
  };

  searchInput.addEventListener("input", (e) => {
    tabFilterState.audit.query = e.target.value;
    renderTable();
  });

  resSelect.addEventListener("change", (e) => {
    tabFilterState.audit.result = e.target.value;
    renderTable();
  });

  resetBtn.addEventListener("click", () => {
    tabFilterState.audit = { query: "", result: "all" };
    searchInput.value = "";
    resSelect.value = "all";
    renderTable();
  });

  renderTable();
}

// ----------------------------------------------------------------------------
// 10. SYSTEM: Platform Architecture & Settings
// ----------------------------------------------------------------------------
async function renderSettingsView(container) {
  const liveConfig = await getAdminPlatformConfig();
  container.replaceChildren();

  // Header
  const header = document.createElement("div");
  header.className = "admin-view-header";
  const titleBox = document.createElement("div");
  titleBox.className = "admin-view-title";
  const h2 = document.createElement("h2");
  h2.textContent = "Settings & Platform Architecture";
  const p = document.createElement("p");
  p.textContent = "Appearance preferences, active taxonomy summary, cloud infrastructure status, and authorization baseline.";
  titleBox.appendChild(h2);
  titleBox.appendChild(p);
  header.appendChild(titleBox);
  container.appendChild(header);

  const grid = document.createElement("div");
  grid.className = "admin-settings-grid";

  // Card 0: Appearance / Theme Preference
  const themeCard = document.createElement("div");
  themeCard.className = "admin-settings-card";
  const themeH3 = document.createElement("h3");
  themeH3.textContent = "Admin Interface Theme";
  const themeP = document.createElement("p");
  themeP.textContent = "Switch cleanly between high-contrast Light Mode and obsidian-forest Dark Mode.";
  const themeBtns = document.createElement("div");
  themeBtns.className = "admin-table-actions";
  const lightBtn = document.createElement("button");
  lightBtn.type = "button";
  lightBtn.className = "admin-btn-subtle";
  lightBtn.setAttribute("data-theme-choice", "light");
  lightBtn.textContent = "☀️ Light Theme";
  const darkBtn = document.createElement("button");
  darkBtn.type = "button";
  darkBtn.className = "admin-btn-subtle";
  darkBtn.setAttribute("data-theme-choice", "dark");
  darkBtn.textContent = "🌙 Dark Theme";
  themeBtns.append(lightBtn, darkBtn);
  themeCard.append(themeH3, themeP, themeBtns);
  grid.appendChild(themeCard);

  // Card 1: Platform Identity
  const idCard = document.createElement("div");
  idCard.className = "admin-settings-card";
  const idH3 = document.createElement("h3");
  idH3.textContent = "Platform Identity & Version";
  const idP = document.createElement("p");
  idP.textContent = "Official production specifications for [JK] FixHub.";
  const idDetail = document.createElement("div");
  idDetail.className = "admin-detail-grid";
  idDetail.appendChild(createDetailItem("Platform Release", "JK FixHub 2.0 (Platform Control Centre)"));
  idDetail.appendChild(createDetailItem("Firebase Project", "jkfixhub"));
  idDetail.appendChild(createDetailItem("Authorization Mode", "Server-Side Firestore RBAC (/admins/{uid})"));
  idDetail.appendChild(createDetailItem("Security Baseline", "Fail-Closed + Immutable Audit Logs"));
  idCard.appendChild(idH3);
  idCard.appendChild(idP);
  idCard.appendChild(idDetail);
  grid.appendChild(idCard);

  // Card 2: Service Taxonomy (Live Configured Services)
  const taxCard = document.createElement("div");
  taxCard.className = "admin-settings-card";
  const taxH3 = document.createElement("h3");
  taxH3.textContent = `Configured Services (${liveConfig.services.length})`;
  const taxP = document.createElement("p");
  taxP.textContent = "Managed dynamically via Services and Districts. Disabled services preserve historical requests.";
  const taxTags = document.createElement("div");
  taxTags.className = "admin-tag-cloud";
  liveConfig.services.forEach((svc) => {
    const t = document.createElement("span");
    t.className = `admin-status-pill ${svc.enabled !== false ? "enabled" : "disabled"}`;
    t.textContent = svc.enabled !== false ? svc.name : `${svc.name} (Off)`;
    taxTags.appendChild(t);
  });
  taxCard.appendChild(taxH3);
  taxCard.appendChild(taxP);
  taxCard.appendChild(taxTags);
  grid.appendChild(taxCard);

  // Card 3: Geographic Coverage (Live Districts)
  const distCard = document.createElement("div");
  distCard.className = "admin-settings-card";
  const distH3 = document.createElement("h3");
  distH3.textContent = `Territorial Coverage (${liveConfig.districts.length} Districts)`;
  const distP = document.createElement("p");
  distP.textContent = "Active Jammu & Kashmir operational districts managed in Services and Districts.";
  const distTags = document.createElement("div");
  distTags.className = "admin-tag-cloud";
  liveConfig.districts.forEach((dist) => {
    const t = document.createElement("span");
    t.className = `admin-status-pill ${dist.enabled !== false ? "enabled" : "disabled"}`;
    t.textContent = dist.enabled !== false ? dist.name : `${dist.name} (Off)`;
    distTags.appendChild(t);
  });
  distCard.appendChild(distH3);
  distCard.appendChild(distP);
  distCard.appendChild(distTags);
  grid.appendChild(distCard);

  // Card 4: Cloud Infrastructure Status
  const infraCard = document.createElement("div");
  infraCard.className = "admin-settings-card";
  const infraH3 = document.createElement("h3");
  infraH3.textContent = "Cloud Infrastructure & Backend State";
  const infraP = document.createElement("p");
  infraP.textContent = "Status of connected Firebase backend resources.";
  const infraDetail = document.createElement("div");
  infraDetail.className = "admin-detail-grid";
  infraDetail.appendChild(createDetailItem("Firebase Authentication", "Active (Email/Password, Email Verification)"));
  infraDetail.appendChild(createDetailItem("Cloud Firestore", "Active (Multi-region production database)"));
  infraDetail.appendChild(createDetailItem("Cloud Storage", "Pending Step 18 (Honest indicator, not configured)"));
  infraDetail.appendChild(createDetailItem("Push Notifications", "In-App Polling / Web Notifications"));
  infraCard.appendChild(infraH3);
  infraCard.appendChild(infraP);
  infraCard.appendChild(infraDetail);
  grid.appendChild(infraCard);

  // Card 5: Security Architecture Policy
  const secCard = document.createElement("div");
  secCard.className = "admin-settings-card";
  const secH3 = document.createElement("h3");
  secH3.textContent = "Security & Access Control Architecture";
  const secP = document.createElement("p");
  secP.textContent = "Security policies governing client and administrator privileges.";
  const secDetail = document.createElement("div");
  secDetail.className = "admin-detail-grid";
  secDetail.appendChild(createDetailItem("Firestore Security Rules", "Compiled & Released (Strict Server-Side Enforcement)"));
  secDetail.appendChild(createDetailItem("Admin Document Gate", "admins/{request.auth.uid} document required"));
  secDetail.appendChild(createDetailItem("Session Revocation", "Immediate sign-out on auth state change or role denial"));
  secDetail.appendChild(createDetailItem("Audit Logging", "Server Timestamp, Admin UID, Immutable /auditLogs records"));
  secCard.appendChild(secH3);
  secCard.appendChild(secP);
  secCard.appendChild(secDetail);
  grid.appendChild(secCard);

  container.appendChild(grid);
}

// ----------------------------------------------------------------------------
// Application Lifecycle, Dynamic Shell Mounting & Event Binding
// ----------------------------------------------------------------------------
function mountAdminShell(adminSession) {
  const appSection = document.getElementById("adminAppSection");
  if (!appSection) return;

  // Clear container and attach privileged layout
  appSection.replaceChildren();
  appSection.className = "admin-shell";
  appSection.hidden = false;

  // 1. Topbar
  const header = document.createElement("header");
  header.className = "admin-topbar";

  const topbarLeft = document.createElement("div");
  topbarLeft.className = "admin-topbar-left";

  // Mobile drawer toggle button
  const mobileToggleBtn = document.createElement("button");
  mobileToggleBtn.id = "adminNavToggleBtn";
  mobileToggleBtn.type = "button";
  mobileToggleBtn.className = "admin-mobile-toggle";
  mobileToggleBtn.setAttribute("aria-label", "Toggle navigation menu");
  mobileToggleBtn.setAttribute("aria-controls", "adminSidebar");
  mobileToggleBtn.setAttribute("aria-expanded", "false");
  mobileToggleBtn.textContent = "☰";

  const brandLogo = document.createElement("div");
  brandLogo.className = "admin-brand-logo";

  const brandMark = document.createElement("span");
  brandMark.className = "admin-brand-mark";
  brandMark.textContent = "JK";

  const brandTitle = document.createElement("span");
  brandTitle.className = "admin-brand-title";
  brandTitle.textContent = "FixHub";

  brandLogo.appendChild(brandMark);
  brandLogo.appendChild(brandTitle);

  const privilegedBadge = document.createElement("span");
  privilegedBadge.className = "admin-badge-privileged";
  privilegedBadge.textContent = "CONTROL CENTRE";

  topbarLeft.appendChild(mobileToggleBtn);
  topbarLeft.appendChild(brandLogo);
  topbarLeft.appendChild(privilegedBadge);

  const topbarCenter = document.createElement("div");
  topbarCenter.className = "admin-topbar-center";

  const secPill = document.createElement("div");
  secPill.id = "adminTopbarSecurityPill";
  secPill.className = "admin-security-state-pill";
  const secDot = document.createElement("span");
  secDot.className = "admin-sec-dot";
  const secText = document.createElement("span");
  secText.id = "adminTopbarSecurityText";
  secText.textContent = "SYSTEM SECURE — RBAC ACTIVE";
  secPill.appendChild(secDot);
  secPill.appendChild(secText);
  topbarCenter.appendChild(secPill);

  const topbarRight = document.createElement("div");
  topbarRight.className = "admin-topbar-right";

  const themeToggleBtn = document.createElement("button");
  themeToggleBtn.id = "adminThemeToggleBtn";
  themeToggleBtn.type = "button";
  themeToggleBtn.className = "admin-theme-toggle-btn";
  themeToggleBtn.setAttribute("data-theme-toggle", "");
  themeToggleBtn.setAttribute("aria-label", "Toggle light and dark theme");
  themeToggleBtn.title = "Switch Light / Dark theme";
  themeToggleBtn.textContent = "🌓";

  const sessionBadge = document.createElement("div");
  sessionBadge.className = "admin-session-badge";

  const statusDot = document.createElement("span");
  statusDot.className = "admin-status-dot";

  const identityDisplay = document.createElement("span");
  identityDisplay.id = "adminIdentityDisplay";
  identityDisplay.textContent = `${adminSession.displayName || "Administrator"} (${adminSession.email || adminSession.uid})`;

  sessionBadge.appendChild(statusDot);
  sessionBadge.appendChild(identityDisplay);

  const signOutBtn = document.createElement("button");
  signOutBtn.id = "adminSignOutBtn";
  signOutBtn.type = "button";
  signOutBtn.className = "admin-btn-subtle";
  signOutBtn.textContent = "Sign Out";
  signOutBtn.addEventListener("click", async () => {
    await signOutAdmin();
    showToast("Signed out from administration session.");
  });

  topbarRight.appendChild(themeToggleBtn);
  topbarRight.appendChild(sessionBadge);
  topbarRight.appendChild(signOutBtn);

  header.appendChild(topbarLeft);
  header.appendChild(topbarCenter);
  header.appendChild(topbarRight);

  // 2. Main Layout (Sidebar Drawer + Overlay + Content)
  const layout = document.createElement("div");
  layout.className = "admin-layout";

  // Backdrop overlay for mobile drawer
  const overlay = document.createElement("div");
  overlay.id = "adminSidebarOverlay";
  overlay.className = "admin-sidebar-overlay";

  // Sidebar Navigation Drawer
  const nav = document.createElement("nav");
  nav.id = "adminSidebar";
  nav.className = "admin-sidebar";
  nav.setAttribute("aria-label", "Admin Navigation");

  // Drawer mobile header
  const drawerHeader = document.createElement("div");
  drawerHeader.className = "admin-drawer-header";
  const drawerTitle = document.createElement("span");
  drawerTitle.className = "admin-drawer-title";
  drawerTitle.textContent = "Navigation";
  const drawerCloseBtn = document.createElement("button");
  drawerCloseBtn.type = "button";
  drawerCloseBtn.className = "admin-drawer-close";
  drawerCloseBtn.setAttribute("aria-label", "Close navigation drawer");
  drawerCloseBtn.textContent = "×";
  drawerHeader.appendChild(drawerTitle);
  drawerHeader.appendChild(drawerCloseBtn);
  nav.appendChild(drawerHeader);

  // Grouped Navigation
  NAV_GROUPS.forEach((group) => {
    const groupEl = document.createElement("div");
    groupEl.className = "admin-nav-group";

    const groupTitle = document.createElement("div");
    groupTitle.className = "admin-nav-group-title";
    groupTitle.textContent = group.category;
    groupEl.appendChild(groupTitle);

    const itemsBox = document.createElement("div");
    itemsBox.className = "admin-nav-group-items";

    group.items.forEach((item) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `admin-nav-item${item.id === activeTab ? " active" : ""}`;
      btn.dataset.adminTab = item.id;

      const iconSpan = document.createElement("span");
      iconSpan.className = "admin-nav-icon";
      iconSpan.textContent = item.icon;

      const labelSpan = document.createElement("span");
      labelSpan.className = "admin-nav-label";
      labelSpan.textContent = item.label;

      btn.appendChild(iconSpan);
      btn.appendChild(labelSpan);

      btn.addEventListener("click", () => {
        if (!currentAdmin || currentAdmin.role !== "admin" || currentAdmin.active !== true) return;
        navigateToTab(item.id);
      });

      itemsBox.appendChild(btn);
    });

    groupEl.appendChild(itemsBox);
    nav.appendChild(groupEl);
  });

  // Founder / Developer Credit & Platform Handle
  const sidebarCredit = document.createElement("div");
  sidebarCredit.className = "admin-sidebar-credit";
  const creditText = document.createElement("span");
  creditText.textContent = "Developed by Uz4ir7";
  const igLink = document.createElement("a");
  igLink.href = "https://www.instagram.com/jkfixhub/";
  igLink.target = "_blank";
  igLink.rel = "noopener noreferrer";
  igLink.className = "admin-social-link";
  igLink.title = "Official Instagram @jkfixhub";
  igLink.textContent = "@jkfixhub";
  sidebarCredit.appendChild(creditText);
  sidebarCredit.appendChild(document.createTextNode(" · "));
  sidebarCredit.appendChild(igLink);
  nav.appendChild(sidebarCredit);

  // Mobile Drawer Toggle handlers
  const toggleDrawer = () => {
    const isOpen = nav.classList.toggle("nav-open");
    overlay.classList.toggle("active", isOpen);
    mobileToggleBtn.setAttribute("aria-expanded", isOpen ? "true" : "false");
  };

  const closeDrawer = () => {
    nav.classList.remove("nav-open");
    overlay.classList.remove("active");
    mobileToggleBtn.setAttribute("aria-expanded", "false");
  };

  mobileToggleBtn.addEventListener("click", toggleDrawer);
  overlay.addEventListener("click", closeDrawer);
  drawerCloseBtn.addEventListener("click", closeDrawer);

  // Main Content Area
  const mainContent = document.createElement("main");
  mainContent.className = "admin-content";
  mainContent.id = "adminMainContent";

  layout.appendChild(overlay);
  layout.appendChild(nav);
  layout.appendChild(mainContent);

  appSection.appendChild(header);
  appSection.appendChild(layout);

  renderActiveView();
}

function unmountAdminShell() {
  const appSection = document.getElementById("adminAppSection");
  if (appSection) {
    appSection.replaceChildren();
    appSection.className = "";
    appSection.hidden = true;
  }
  activeTab = "overview";
}

function handleAuthStateChange(adminSession, meta = {}) {
  const loginSection = document.getElementById("adminLoginSection");
  const authLoading = document.getElementById("adminAuthLoading");
  const loginError = document.getElementById("adminLoginError");
  const loginErrorMsg = document.getElementById("adminLoginErrorMessage");

  // 1. Loading verification in progress
  if (meta?.isVerifying) {
    if (authLoading) authLoading.hidden = false;
    if (loginSection) loginSection.hidden = true;
    unmountAdminShell();
    return;
  }

  // Hide loading screen when check resolves
  if (authLoading) authLoading.hidden = true;

  // 2. Authorized Admin
  if (adminSession && adminSession.role === "admin" && adminSession.active === true) {
    const appSection = document.getElementById("adminAppSection");
    const isAlreadyMounted = currentAdmin?.uid === adminSession.uid &&
      appSection &&
      !appSection.hidden &&
      Boolean(document.getElementById("adminMainContent"));

    currentAdmin = adminSession;
    if (loginSection) loginSection.hidden = true;
    if (loginError) loginError.hidden = true;

    if (!isAlreadyMounted) {
      mountAdminShell(adminSession);
    }
    return;
  }

  // 3. Unauthenticated or Denied Non-Admin
  currentAdmin = null;
  unmountAdminShell();

  if (loginSection) loginSection.hidden = false;

  if (meta?.error) {
    if (loginError && loginErrorMsg) {
      loginErrorMsg.textContent = meta.error;
      loginError.hidden = false;
    }
  }
}

function initializeAdminApp() {
  // 0. Initialize Dual-Theme Controller & 3D Background Stage
  initializeTheme();
  initializeAdminCanvas();

  // Keyboard Accessibility: Escape closes open action modal or mobile drawer
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const modalBackdrop = document.getElementById("adminActionModal");
    if (modalBackdrop && !modalBackdrop.hidden) {
      modalBackdrop.hidden = true;
      return;
    }
    const sidebar = document.getElementById("adminSidebar");
    const overlay = document.getElementById("adminSidebarOverlay");
    const toggleBtn = document.getElementById("adminNavToggleBtn");
    if (sidebar && sidebar.classList.contains("nav-open")) {
      sidebar.classList.remove("nav-open");
      if (overlay) overlay.classList.remove("active");
      if (toggleBtn) toggleBtn.setAttribute("aria-expanded", "false");
    }
  });

  // 1. Subscribe to auth state
  subscribeAdminAuthState(handleAuthStateChange);
  initializeAdminAuth();

  // 2. Sign In Form Handler
  const loginForm = document.getElementById("adminLoginForm");
  const loginError = document.getElementById("adminLoginError");
  const loginErrorMsg = document.getElementById("adminLoginErrorMessage");
  const submitBtn = document.getElementById("adminLoginSubmit");
  const emulatorToggle = document.getElementById("adminEmulatorToggle");

  if (emulatorToggle) {
    if (shouldConnectToEmulator()) {
      emulatorToggle.checked = true;
    }
    emulatorToggle.addEventListener("change", () => {
      if (emulatorToggle.checked) {
        try {
          sessionStorage.setItem("jkfixhub_use_emulator", "true");
          localStorage.setItem("jkfixhub_use_emulator", "true");
        } catch (_) {}
        if (typeof window !== "undefined") {
          window.__JKFIXHUB_USE_EMULATOR__ = true;
        }
      } else {
        try {
          sessionStorage.removeItem("jkfixhub_use_emulator");
          localStorage.removeItem("jkfixhub_use_emulator");
        } catch (_) {}
        if (typeof window !== "undefined") {
          window.__JKFIXHUB_USE_EMULATOR__ = false;
        }
      }
    });
  }

  if (loginForm) {
    loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = document.getElementById("adminEmailInput")?.value || "";
      const password = document.getElementById("adminPasswordInput")?.value || "";

      if (emulatorToggle && emulatorToggle.checked) {
        if (typeof window !== "undefined") {
          window.__JKFIXHUB_USE_EMULATOR__ = true;
        }
        try {
          sessionStorage.setItem("jkfixhub_use_emulator", "true");
          localStorage.setItem("jkfixhub_use_emulator", "true");
        } catch (_) {}
      }

      if (loginError) loginError.hidden = true;
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = "Verifying...";
      }

      const res = await signInAdmin(email, password);

      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = "ENTER COMMAND CENTER";
      }

      if (!res.success) {
        if (loginError && loginErrorMsg) {
          loginErrorMsg.textContent = res.error || "Access unavailable. This area is restricted to authorized administrators.";
          loginError.hidden = false;
        }
      }
    });
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeAdminApp);
} else {
  initializeAdminApp();
}
