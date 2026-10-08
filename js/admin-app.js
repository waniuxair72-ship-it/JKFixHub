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

import {
  getAdminOverviewStats,
  getAdminWorkers,
  updateAdminWorkerStatus,
  getAdminCustomers,
  getAdminRequests,
  getAdminReports,
  updateAdminReportStatus,
  getAdminReviews,
  updateAdminReviewStatus,
  getAdminSecurityEvents,
  getAdminAuditLogs
} from "./firestore-service.js";

import { initializeAdminCanvas } from "./admin-canvas.js";

// ----------------------------------------------------------------------------
// Architectural Constants
// ----------------------------------------------------------------------------
const NAV_GROUPS = [
  {
    category: "COMMAND",
    items: [
      { id: "overview", label: "Overview", icon: "📊" }
    ]
  },
  {
    category: "OPERATIONS",
    items: [
      { id: "workers", label: "Workers", icon: "🛠️" },
      { id: "customers", label: "Customers", icon: "👥" },
      { id: "requests", label: "Requests", icon: "📋" }
    ]
  },
  {
    category: "TRUST & SAFETY",
    items: [
      { id: "reports", label: "Reports", icon: "🚨" },
      { id: "reviews", label: "Reviews", icon: "⭐" },
      { id: "trust-safety", label: "Trust & Safety Hub", icon: "🛡️" }
    ]
  },
  {
    category: "SYSTEM",
    items: [
      { id: "security", label: "Security & Abuse", icon: "🔒" },
      { id: "audit", label: "Audit Log", icon: "📜" },
      { id: "settings", label: "Platform Architecture", icon: "⚙️" }
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
let currentAdmin = null;

const tabFilterState = {
  workers: { query: "", status: "all", verification: "all", district: "all" },
  customers: { query: "", verification: "all", district: "all" },
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
  activeTab = (tabId === "dashboard") ? "overview" : tabId;
  if (filterOptions && tabFilterState[activeTab]) {
    Object.assign(tabFilterState[activeTab], filterOptions);
  }
  // Close mobile drawer if open
  const sidebar = document.getElementById("adminSidebar");
  const overlay = document.getElementById("adminSidebarOverlay");
  if (sidebar) sidebar.classList.remove("nav-open");
  if (overlay) overlay.classList.remove("active");
  renderActiveView();
}

// ----------------------------------------------------------------------------
// View Rendering Dispatcher
// ----------------------------------------------------------------------------
async function renderActiveView() {
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
  });

  const loadingWrap = document.createElement("div");
  loadingWrap.className = "admin-empty-state";
  const loadingText = document.createElement("p");
  loadingText.textContent = "Loading live data...";
  loadingWrap.appendChild(loadingText);
  container.appendChild(loadingWrap);

  switch (effectiveTab) {
    case "overview":
    case "dashboard":
      await renderOverviewView(container);
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
    case "reports":
      await renderReportsView(container);
      break;
    case "reviews":
      await renderReviewsView(container);
      break;
    case "trust-safety":
      await renderTrustSafetyView(container);
      break;
    case "security":
      await renderSecurityView(container);
      break;
    case "audit":
      await renderAuditLogView(container);
      break;
    case "settings":
      await renderSettingsView(container);
      break;
    default:
      await renderOverviewView(container);
  }
}

// ----------------------------------------------------------------------------
// 1. COMMAND: Overview (Command Center)
// ----------------------------------------------------------------------------
async function renderOverviewView(container) {
  const [stats, auditLogs] = await Promise.all([
    getAdminOverviewStats(),
    getAdminAuditLogs()
  ]);

  container.replaceChildren();

  // Header
  const header = document.createElement("div");
  header.className = "admin-view-header";
  const titleBox = document.createElement("div");
  titleBox.className = "admin-view-title";
  const h2 = document.createElement("h2");
  h2.textContent = "Platform Command Center";
  const p = document.createElement("p");
  p.textContent = "Live operational indicators, action queues, platform health, and audit trail.";
  titleBox.appendChild(h2);
  titleBox.appendChild(p);
  header.appendChild(titleBox);
  container.appendChild(header);

  // Section: Platform Health
  const healthPanel = document.createElement("div");
  healthPanel.className = "admin-health-panel";
  const healthTitle = document.createElement("h3");
  healthTitle.textContent = "Platform Infrastructure & Security Health";
  healthPanel.appendChild(healthTitle);

  const healthGrid = document.createElement("div");
  healthGrid.className = "admin-health-grid";

  const healthItems = [
    { name: "Firebase Auth", status: "Operational (Identity Service Active)", dot: "ok" },
    { name: "Cloud Firestore", status: "Connected (Server-side RBAC Enforced)", dot: "ok" },
    { name: "Security Rules", status: "Enforced (admins/{uid} Fail-Closed)", dot: "ok" },
    { name: "Cloud Storage", status: "Pending Step 18 (Honest indicator)", dot: "warn" },
    { name: "Architecture", status: "Client SDK + Firestore Server Rules", dot: "ok" }
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
    { label: "Pending Verification", value: stats.pendingWorkerVerification, note: "Awaiting administrative review" },
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
  workerTitle.textContent = "Worker Verifications";
  workerHead.appendChild(workerTitle);
  const workerDesc = document.createElement("div");
  workerDesc.className = "admin-attention-desc";
  workerDesc.textContent = stats.pendingWorkerVerification > 0
    ? `${stats.pendingWorkerVerification} worker profile(s) awaiting identity review and discovery approval.`
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
    { title: "Worker Directory", desc: "Verify credentials, approve discovery, manage suspensions.", icon: "🛠️", tab: "workers" },
    { title: "Customer Directory", desc: "Audit registered customer accounts and verification states.", icon: "👥", tab: "customers" },
    { title: "Trust & Safety Hub", desc: "Centralized queue for reports, reviews, and abuse mitigation.", icon: "🛡️", tab: "trust-safety" },
    { title: "Platform Architecture", desc: "Inspect taxonomy, districts, infrastructure, and security settings.", icon: "⚙️", tab: "settings" }
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
  h2.textContent = "Worker Management & Credentials";
  const p = document.createElement("p");
  p.textContent = "Moderate worker onboarding, credentials, public discovery verification, and suspension status.";
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
    { val: "all", label: "All Verifications" },
    { val: "verified", label: "Verified Only" },
    { val: "pending", label: "Pending Verification" }
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
    { val: "all", label: "All Statuses" },
    { val: "active", label: "Active" },
    { val: "suspended", label: "Suspended" }
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
      // Verification
      if (vFilter === "verified" && !w.isVerified) return false;
      if (vFilter === "pending" && Boolean(w.isVerified)) return false;
      // Status
      if (sFilter === "active" && w.status === "suspended") return false;
      if (sFilter === "suspended" && w.status !== "suspended") return false;
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
    ["ID", "Name", "Service", "District", "Rating", "Status", "Verification", "Actions"].forEach((txt) => {
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
      tdId.textContent = String(w.id || "—");
      row.appendChild(tdId);

      const tdName = document.createElement("td");
      tdName.textContent = String(w.name || "Worker");
      row.appendChild(tdName);

      const tdService = document.createElement("td");
      tdService.textContent = String(w.service || "—");
      row.appendChild(tdService);

      const tdDist = document.createElement("td");
      tdDist.textContent = String(w.district || "—");
      row.appendChild(tdDist);

      const tdRating = document.createElement("td");
      tdRating.textContent = w.rating ? `★ ${w.rating}` : "—";
      row.appendChild(tdRating);

      const tdStatus = document.createElement("td");
      const statusPill = document.createElement("span");
      statusPill.className = `admin-status-pill ${w.status || "active"}`;
      statusPill.textContent = String(w.status || "active");
      tdStatus.appendChild(statusPill);
      row.appendChild(tdStatus);

      const tdVer = document.createElement("td");
      const verPill = document.createElement("span");
      verPill.className = `admin-status-pill ${w.isVerified ? "verified" : "pending"}`;
      verPill.textContent = w.isVerified ? "Verified" : "Pending";
      tdVer.appendChild(verPill);
      row.appendChild(tdVer);

      const tdActions = document.createElement("td");
      const actionsBox = document.createElement("div");
      actionsBox.className = "admin-table-actions";

      // Inspect profile
      const inspectBtn = document.createElement("button");
      inspectBtn.type = "button";
      inspectBtn.className = "admin-table-btn";
      inspectBtn.textContent = "Inspect";
      inspectBtn.onclick = () => {
        const modalContent = document.createElement("div");
        const grid = document.createElement("div");
        grid.className = "admin-detail-grid";

        grid.appendChild(createDetailItem("Worker ID", w.id));
        grid.appendChild(createDetailItem("Full Name", w.name));
        grid.appendChild(createDetailItem("Service Category", w.service));
        grid.appendChild(createDetailItem("District", w.district));
        grid.appendChild(createDetailItem("Rating", w.rating ? `★ ${w.rating}` : "No ratings yet"));
        grid.appendChild(createDetailItem("Moderation Status", w.status || "active"));
        grid.appendChild(createDetailItem("Verification", w.isVerified ? "Verified" : "Pending Verification"));
        if (w.experience) grid.appendChild(createDetailItem("Experience", `${w.experience} years`));
        if (w.phone) grid.appendChild(createDetailItem("Phone", w.phone));
        if (w.bio) grid.appendChild(createDetailItem("Professional Bio", w.bio, true));

        modalContent.appendChild(grid);

        showDetailModal({
          title: `Worker Profile: ${w.name}`,
          contentNode: modalContent,
          isWide: true
        });
      };
      actionsBox.appendChild(inspectBtn);

      // Approve verification
      if (!w.isVerified) {
        const approveBtn = document.createElement("button");
        approveBtn.type = "button";
        approveBtn.className = "admin-table-btn approve";
        approveBtn.textContent = "Approve";
        approveBtn.onclick = () => {
          showConfirmModal({
            title: "Approve Worker Verification",
            body: `Approve and verify ${w.name} (#${w.id}) for public service discovery?`,
            confirmText: "Approve Worker",
            onConfirm: async () => {
              const res = await updateAdminWorkerStatus(w.id, { isVerified: true, status: "active" }, currentAdmin.uid);
              if (res.success) {
                showToast(`Worker ${w.name} verified.`);
                w.isVerified = true;
                w.status = "active";
                renderTable();
              } else {
                showToast("Failed to approve worker.");
              }
            }
          });
        };
        actionsBox.appendChild(approveBtn);
      }

      // Suspend / Restore
      if (w.status !== "suspended") {
        const suspendBtn = document.createElement("button");
        suspendBtn.type = "button";
        suspendBtn.className = "admin-table-btn suspend";
        suspendBtn.textContent = "Suspend";
        suspendBtn.onclick = () => {
          showConfirmModal({
            title: "Suspend Worker Account",
            body: `Suspend ${w.name} (#${w.id})? They will be hidden from public discovery.`,
            confirmText: "Suspend Worker",
            onConfirm: async () => {
              const res = await updateAdminWorkerStatus(w.id, { status: "suspended" }, currentAdmin.uid);
              if (res.success) {
                showToast(`Worker ${w.name} suspended.`);
                w.status = "suspended";
                renderTable();
              } else {
                showToast("Failed to suspend worker.");
              }
            }
          });
        };
        actionsBox.appendChild(suspendBtn);
      } else {
        const restoreBtn = document.createElement("button");
        restoreBtn.type = "button";
        restoreBtn.className = "admin-table-btn approve";
        restoreBtn.textContent = "Restore";
        restoreBtn.onclick = () => {
          showConfirmModal({
            title: "Restore Worker Account",
            body: `Restore ${w.name} (#${w.id}) to active status?`,
            confirmText: "Restore Worker",
            onConfirm: async () => {
              const res = await updateAdminWorkerStatus(w.id, { status: "active" }, currentAdmin.uid);
              if (res.success) {
                showToast(`Worker ${w.name} restored.`);
                w.status = "active";
                renderTable();
              } else {
                showToast("Failed to restore worker.");
              }
            }
          });
        };
        actionsBox.appendChild(restoreBtn);
      }

      tdActions.appendChild(actionsBox);
      row.appendChild(tdActions);
      tbody.appendChild(row);
    }

    table.appendChild(tbody);
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
  const customers = await getAdminCustomers();
  container.replaceChildren();

  // Header
  const header = document.createElement("div");
  header.className = "admin-view-header";
  const titleBox = document.createElement("div");
  titleBox.className = "admin-view-title";
  const h2 = document.createElement("h2");
  h2.textContent = "Customer Accounts";
  const p = document.createElement("p");
  p.textContent = "Manage registered customer identities, email verification status, and district associations.";
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
  searchInput.placeholder = "Search customers by name, email, district, or UID...";
  searchInput.value = tabFilterState.customers.query || "";
  searchBox.appendChild(searchInput);

  const filtersBox = document.createElement("div");
  filtersBox.className = "admin-toolbar-filters";

  const verSelect = document.createElement("select");
  verSelect.className = "admin-select-input";
  [
    { val: "all", label: "All Email Verifications" },
    { val: "verified", label: "Verified Only" },
    { val: "unverified", label: "Unverified Only" }
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
    const vFilter = tabFilterState.customers.verification;
    const dFilter = tabFilterState.customers.district;

    const filtered = customers.filter((c) => {
      if (q) {
        const uidMatch = String(c.uid || c.id || "").toLowerCase().includes(q);
        const nameMatch = String(c.name || "").toLowerCase().includes(q);
        const emailMatch = String(c.email || "").toLowerCase().includes(q);
        const distMatch = String(c.district || "").toLowerCase().includes(q);
        if (!uidMatch && !nameMatch && !emailMatch && !distMatch) return false;
      }
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
    ["UID", "Name", "Email", "Email Verified", "District", "Registered", "Actions"].forEach((txt) => {
      const th = document.createElement("th");
      th.textContent = txt;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const c of filtered) {
      const row = document.createElement("tr");

      const tdUid = document.createElement("td");
      tdUid.textContent = String(c.uid ? `${c.uid.substring(0, 10)}...` : c.id);
      tdUid.title = String(c.uid || c.id);
      row.appendChild(tdUid);

      const tdName = document.createElement("td");
      tdName.textContent = String(c.name || "Customer");
      row.appendChild(tdName);

      const tdEmail = document.createElement("td");
      tdEmail.textContent = String(c.email || "—");
      row.appendChild(tdEmail);

      const tdVer = document.createElement("td");
      const verPill = document.createElement("span");
      verPill.className = `admin-status-pill ${c.emailVerified ? "verified" : "pending"}`;
      verPill.textContent = c.emailVerified ? "Verified" : "Unverified";
      tdVer.appendChild(verPill);
      row.appendChild(tdVer);

      const tdDist = document.createElement("td");
      tdDist.textContent = String(c.district || "—");
      row.appendChild(tdDist);

      const tdDate = document.createElement("td");
      tdDate.textContent = formatDateOnly(c.createdAt);
      row.appendChild(tdDate);

      const tdActions = document.createElement("td");
      const inspectBtn = document.createElement("button");
      inspectBtn.type = "button";
      inspectBtn.className = "admin-table-btn";
      inspectBtn.textContent = "Inspect";
      inspectBtn.onclick = () => {
        const modalContent = document.createElement("div");
        const grid = document.createElement("div");
        grid.className = "admin-detail-grid";

        grid.appendChild(createDetailItem("Firebase UID", c.uid || c.id, true));
        grid.appendChild(createDetailItem("Customer Name", c.name));
        grid.appendChild(createDetailItem("Email Address", c.email));
        grid.appendChild(createDetailItem("Email Verified", c.emailVerified ? "Yes (Verified)" : "No (Pending)"));
        grid.appendChild(createDetailItem("District", c.district));
        grid.appendChild(createDetailItem("Account Created", formatDateTime(c.createdAt)));
        grid.appendChild(createDetailItem("Privacy Notice", "Customer data is strictly managed in accordance with platform security and privacy policies.", true));

        modalContent.appendChild(grid);

        showDetailModal({
          title: `Customer Profile: ${c.name || "Customer"}`,
          contentNode: modalContent,
          isWide: true
        });
      };
      tdActions.appendChild(inspectBtn);
      row.appendChild(tdActions);

      tbody.appendChild(row);
    }

    table.appendChild(tbody);
    tableWrap.appendChild(table);
  };

  searchInput.addEventListener("input", (e) => {
    tabFilterState.customers.query = e.target.value;
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
    tabFilterState.customers = { query: "", verification: "all", district: "all" };
    searchInput.value = "";
    verSelect.value = "all";
    distSelect.value = "all";
    renderTable();
  });

  renderTable();
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
        if (r.notes || r.description) grid.appendChild(createDetailItem("Request Description", r.notes || r.description, true));

        // Lifecycle Timeline
        const tlWrap = document.createElement("div");
        tlWrap.className = "admin-detail-item full-width";
        const tlLbl = document.createElement("div");
        tlLbl.className = "admin-detail-label";
        tlLbl.textContent = "Request Lifecycle Timeline";
        const timeline = document.createElement("div");
        timeline.className = "admin-timeline";

        const steps = [
          { label: "Request Created", done: true },
          { label: "Technician Assignment", done: r.status === "Accepted" || r.status === "Completed" },
          { label: "Fulfillment & Completion", done: r.status === "Completed" }
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

        modalContent.appendChild(grid);

        showDetailModal({
          title: `Service Request #${r.id}`,
          contentNode: modalContent,
          isWide: true
        });
      };
      tdActions.appendChild(inspectBtn);
      row.appendChild(tdActions);

      tbody.appendChild(row);
    }

    table.appendChild(tbody);
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
  const reviews = await getAdminReviews();
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
    ["ID", "Customer", "Worker", "Rating", "Review Text", "Status", "Actions"].forEach((txt) => {
      const th = document.createElement("th");
      th.textContent = txt;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const rev of filtered) {
      const row = document.createElement("tr");

      const tdId = document.createElement("td");
      tdId.textContent = String(rev.id);
      row.appendChild(tdId);

      const tdCust = document.createElement("td");
      tdCust.textContent = String(rev.customerName || rev.customerId || "—");
      row.appendChild(tdCust);

      const tdWorker = document.createElement("td");
      tdWorker.textContent = String(rev.workerName || rev.workerId || "—");
      row.appendChild(tdWorker);

      const tdRating = document.createElement("td");
      tdRating.textContent = `★ ${rev.rating || 5}`;
      row.appendChild(tdRating);

      const tdText = document.createElement("td");
      const preview = String(rev.text || "—");
      tdText.textContent = preview.length > 50 ? `${preview.substring(0, 50)}...` : preview;
      tdText.title = preview;
      row.appendChild(tdText);

      const tdStatus = document.createElement("td");
      const stPill = document.createElement("span");
      stPill.className = `admin-status-pill ${rev.status || "published"}`;
      stPill.textContent = String(rev.status || "published");
      tdStatus.appendChild(stPill);
      row.appendChild(tdStatus);

      const tdActions = document.createElement("td");
      const actionsBox = document.createElement("div");
      actionsBox.className = "admin-table-actions";

      // Inspect review
      const inspectBtn = document.createElement("button");
      inspectBtn.type = "button";
      inspectBtn.className = "admin-table-btn";
      inspectBtn.textContent = "Inspect";
      inspectBtn.onclick = () => {
        const modalContent = document.createElement("div");
        const grid = document.createElement("div");
        grid.className = "admin-detail-grid";

        grid.appendChild(createDetailItem("Review ID", rev.id));
        grid.appendChild(createDetailItem("Rating", `★ ${rev.rating || 5}`));
        grid.appendChild(createDetailItem("Customer", rev.customerName || rev.customerId));
        grid.appendChild(createDetailItem("Worker", rev.workerName || rev.workerId));
        grid.appendChild(createDetailItem("Moderation Status", rev.status || "published"));
        grid.appendChild(createDetailItem("Submitted At", formatDateTime(rev.createdAt)));
        grid.appendChild(createDetailItem("Full Review Content", rev.text || "No commentary provided", true));
        if (rev.workerResponse) {
          grid.appendChild(createDetailItem("Worker Public Response", rev.workerResponse, true));
        }

        modalContent.appendChild(grid);

        showDetailModal({
          title: `Review Details #${rev.id}`,
          contentNode: modalContent,
          isWide: true
        });
      };
      actionsBox.appendChild(inspectBtn);

      if (rev.status !== "published") {
        const pubBtn = document.createElement("button");
        pubBtn.type = "button";
        pubBtn.className = "admin-table-btn approve";
        pubBtn.textContent = "Publish";
        pubBtn.onclick = async () => {
          const res = await updateAdminReviewStatus(rev.id, "published", currentAdmin.uid);
          if (res.success) {
            showToast("Review published.");
            rev.status = "published";
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
          const res = await updateAdminReviewStatus(rev.id, "hidden", currentAdmin.uid);
          if (res.success) {
            showToast("Review hidden from public view.");
            rev.status = "hidden";
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
      tdRating.textContent = `★ ${rev.rating || 5}`;
      row.appendChild(tdRating);

      const tdText = document.createElement("td");
      const preview = String(rev.text || "—");
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
      pubBtn.textContent = "Publish";
      pubBtn.onclick = async () => {
        const res = await updateAdminReviewStatus(rev.id, "published", currentAdmin.uid);
        if (res.success) {
          showToast("Review published.");
          renderActiveView();
        }
      };
      box.appendChild(pubBtn);

      const hideBtn = document.createElement("button");
      hideBtn.type = "button";
      hideBtn.className = "admin-table-btn suspend";
      hideBtn.textContent = "Hide";
      hideBtn.onclick = async () => {
        const res = await updateAdminReviewStatus(rev.id, "hidden", currentAdmin.uid);
        if (res.success) {
          showToast("Review hidden.");
          renderActiveView();
        }
      };
      box.appendChild(hideBtn);

      tdAct.appendChild(box);
      row.appendChild(tdAct);
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
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
  container.replaceChildren();

  // Header
  const header = document.createElement("div");
  header.className = "admin-view-header";
  const titleBox = document.createElement("div");
  titleBox.className = "admin-view-title";
  const h2 = document.createElement("h2");
  h2.textContent = "Platform Architecture & System Settings";
  const p = document.createElement("p");
  p.textContent = "Technical taxonomy, geographic coverage, cloud infrastructure status, and authorization baseline.";
  titleBox.appendChild(h2);
  titleBox.appendChild(p);
  header.appendChild(titleBox);
  container.appendChild(header);

  const grid = document.createElement("div");
  grid.className = "admin-settings-grid";

  // Card 1: Platform Identity
  const idCard = document.createElement("div");
  idCard.className = "admin-settings-card";
  const idH3 = document.createElement("h3");
  idH3.textContent = "Platform Identity & Version";
  const idP = document.createElement("p");
  idP.textContent = "Official production specifications for [JK] FixHub.";
  const idDetail = document.createElement("div");
  idDetail.className = "admin-detail-grid";
  idDetail.appendChild(createDetailItem("Platform Release", "JK FixHub 2.0 (Step 17A Command Center)"));
  idDetail.appendChild(createDetailItem("Firebase Project", "jkfixhub"));
  idDetail.appendChild(createDetailItem("Authorization Mode", "Server-Side Firestore RBAC (/admins/{uid})"));
  idDetail.appendChild(createDetailItem("Security Baseline", "Fail-Closed (Hardened Commit b56a25f)"));
  idCard.appendChild(idH3);
  idCard.appendChild(idP);
  idCard.appendChild(idDetail);
  grid.appendChild(idCard);

  // Card 2: Service Taxonomy (12 Categories)
  const taxCard = document.createElement("div");
  taxCard.className = "admin-settings-card";
  const taxH3 = document.createElement("h3");
  taxH3.textContent = "Core Service Taxonomy";
  const taxP = document.createElement("p");
  taxP.textContent = "Standardized directory service categories supported across Jammu & Kashmir.";
  const taxTags = document.createElement("div");
  taxTags.className = "admin-tag-cloud";
  CORE_CATEGORIES.forEach((cat) => {
    const t = document.createElement("span");
    t.className = "admin-tax-tag";
    t.textContent = cat;
    taxTags.appendChild(t);
  });
  taxCard.appendChild(taxH3);
  taxCard.appendChild(taxP);
  taxCard.appendChild(taxTags);
  grid.appendChild(taxCard);

  // Card 3: Geographic Coverage (20 Districts)
  const distCard = document.createElement("div");
  distCard.className = "admin-settings-card";
  const distH3 = document.createElement("h3");
  distH3.textContent = "Territorial Coverage";
  const distP = document.createElement("p");
  distP.textContent = "All 20 districts of Jammu & Kashmir actively supported for technician discovery and dispatch.";
  const distTags = document.createElement("div");
  distTags.className = "admin-tag-cloud";
  JK_DISTRICTS.forEach((dist) => {
    const t = document.createElement("span");
    t.className = "admin-tax-tag";
    t.textContent = dist;
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
  privilegedBadge.textContent = "COMMAND CENTER";

  topbarLeft.appendChild(mobileToggleBtn);
  topbarLeft.appendChild(brandLogo);
  topbarLeft.appendChild(privilegedBadge);

  const topbarCenter = document.createElement("div");
  topbarCenter.className = "admin-topbar-center";

  const secPill = document.createElement("div");
  secPill.className = "admin-security-state-pill";
  const secDot = document.createElement("span");
  secDot.className = "admin-sec-dot";
  const secText = document.createElement("span");
  secText.textContent = "SYSTEM SECURE — RBAC ACTIVE";
  secPill.appendChild(secDot);
  secPill.appendChild(secText);
  topbarCenter.appendChild(secPill);

  const topbarRight = document.createElement("div");
  topbarRight.className = "admin-topbar-right";

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

  // Mobile Drawer Toggle handlers
  const toggleDrawer = () => {
    const isOpen = nav.classList.toggle("nav-open");
    overlay.classList.toggle("active", isOpen);
  };

  const closeDrawer = () => {
    nav.classList.remove("nav-open");
    overlay.classList.remove("active");
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
    currentAdmin = adminSession;
    if (loginSection) loginSection.hidden = true;
    if (loginError) loginError.hidden = true;

    mountAdminShell(adminSession);
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
  // 0. Initialize 3D Background & Signature Layer
  initializeAdminCanvas();

  // 1. Subscribe to auth state
  subscribeAdminAuthState(handleAuthStateChange);
  initializeAdminAuth();

  // 2. Sign In Form Handler
  const loginForm = document.getElementById("adminLoginForm");
  const loginError = document.getElementById("adminLoginError");
  const loginErrorMsg = document.getElementById("adminLoginErrorMessage");
  const submitBtn = document.getElementById("adminLoginSubmit");

  if (loginForm) {
    loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = document.getElementById("adminEmailInput")?.value || "";
      const password = document.getElementById("adminPasswordInput")?.value || "";

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
