// ==========================================
// #ADMIN_DASHBOARD_AND_SECURITY
// ==========================================

// Dedicated administration module and security boundary for JKFixHub.
// This is a frontend-only prototype architecture; real production administration
// and security rules must be strictly enforced server-side via Firebase/backend.
import { closeModal, openModal } from "./modals.js";
import {
  canAccessAdmin,
  canManageReports,
  canManageReviews,
  canManageWorkers,
  canViewAuditLog,
  canViewSecurityEvents,
  getAdminAuditLogs,
  getAdminOverview,
  getAdminReports,
  getAdminRequests,
  getAdminReviews,
  getAdminSecurityOverview,
  getAdminWorkers,
  getCurrentUser,
  loginAsAdminForDemo,
  logoutAdminForDemo,
  updateReportStatusForDemo,
  updateReviewStatusForDemo,
  updateWorkerApprovalForDemo,
  updateWorkerStatusForDemo
} from "./store.js";
import {
  recordSecurityEvent,
  setTextContent
} from "./security.js";

let initialized = false;
let activeTab = "overview";
let toastHandler = null;

function formatTimestamp(isoString) {
  if (!isoString) return "—";
  try {
    const d = new Date(isoString);
    return isNaN(d.getTime()) ? String(isoString) : d.toLocaleString();
  } catch {
    return String(isoString);
  }
}

function renderBadge(text, typeClass) {
  const span = document.createElement("span");
  span.className = `admin-badge ${typeClass}`;
  setTextContent(span, text);
  return span;
}

// ------------------------------------------
// Overview Tab
// ------------------------------------------
function renderOverviewTab(container) {
  container.replaceChildren();
  if (!canAccessAdmin()) return;

  const overview = getAdminOverview();
  const grid = document.createElement("div");
  grid.className = "admin-metrics-grid";

  const metrics = [
    { label: "Total Workers", value: overview.totalWorkers, note: "Registered in system" },
    { label: "Pending Approvals", value: overview.pendingApprovals, note: "Awaiting admin check" },
    { label: "Total Requests", value: overview.totalRequests, note: "Customer service requests" },
    { label: "Open Reports", value: overview.openReports, note: "Awaiting safety review" },
    { label: "Active Abuse Flags", value: overview.activeAbuseFlags, note: "In-memory rate signals" },
    { label: "Admin Actions", value: overview.recentAdminActions, note: "Session audit entries" }
  ];

  for (const item of metrics) {
    const card = document.createElement("article");
    card.className = "admin-metric-card";
    const label = document.createElement("span");
    label.className = "admin-metric-label";
    setTextContent(label, item.label);
    const val = document.createElement("strong");
    val.className = "admin-metric-value";
    setTextContent(val, item.value);
    const note = document.createElement("small");
    note.className = "admin-metric-note";
    setTextContent(note, item.note);
    card.append(label, val, note);
    grid.append(card);
  }

  const notice = document.createElement("div");
  notice.className = "admin-notice-box";
  const noticeTitle = document.createElement("strong");
  setTextContent(noticeTitle, "Privileged Session Notice");
  const noticeText = document.createElement("p");
  setTextContent(
    noticeText,
    "You are viewing the JKFixHub administrative interface. All actions perform client-side authorization checks and record in-memory audit logs. Production admin enforcement requires Firebase custom claims and server-side Security Rules."
  );
  notice.append(noticeTitle, noticeText);

  container.append(grid, notice);
}

// ------------------------------------------
// Workers Tab
// ------------------------------------------
function renderWorkersTab(container) {
  container.replaceChildren();
  if (!canAccessAdmin()) return;

  const workers = getAdminWorkers();
  const wrapper = document.createElement("div");
  wrapper.className = "admin-table-wrapper";

  const table = document.createElement("table");
  table.className = "admin-table";
  table.setAttribute("aria-label", "Workers Management Table");

  const thead = document.createElement("thead");
  const trHead = document.createElement("tr");
  ["ID", "Worker Name", "Service", "District", "Rating", "Availability", "Verification", "Status", "Actions"].forEach((headerText) => {
    const th = document.createElement("th");
    setTextContent(th, headerText);
    trHead.append(th);
  });
  thead.append(trHead);

  const tbody = document.createElement("tbody");
  for (const worker of workers) {
    const tr = document.createElement("tr");

    const tdId = document.createElement("td");
    setTextContent(tdId, `#${worker.id}`);

    const tdName = document.createElement("td");
    const strongName = document.createElement("strong");
    setTextContent(strongName, worker.name);
    tdName.append(strongName);

    const tdService = document.createElement("td");
    setTextContent(tdService, worker.service);

    const tdDistrict = document.createElement("td");
    setTextContent(tdDistrict, worker.district);

    const tdRating = document.createElement("td");
    setTextContent(tdRating, `${worker.rating} ★`);

    const tdAvail = document.createElement("td");
    setTextContent(tdAvail, worker.availability || "Available");

    const tdVerif = document.createElement("td");
    const isVerified = worker.verificationStatus === "verified";
    tdVerif.append(renderBadge(worker.verificationStatus, isVerified ? "badge-success" : "badge-warning"));

    const tdStatus = document.createElement("td");
    const isActive = worker.accountStatus === "active";
    const isSuspended = worker.accountStatus === "suspended";
    tdStatus.append(
      renderBadge(
        worker.accountStatus,
        isActive ? "badge-success" : isSuspended ? "badge-danger" : "badge-warning"
      )
    );

    const tdActions = document.createElement("td");
    tdActions.className = "admin-actions-cell";

    if (worker.accountStatus === "suspended") {
      const restoreBtn = document.createElement("button");
      restoreBtn.type = "button";
      restoreBtn.className = "button subtle admin-btn-action";
      restoreBtn.dataset.adminRestoreWorker = String(worker.id);
      setTextContent(restoreBtn, "Restore");
      tdActions.append(restoreBtn);
    } else {
      const suspendBtn = document.createElement("button");
      suspendBtn.type = "button";
      suspendBtn.className = "button subtle admin-btn-action admin-btn-danger";
      suspendBtn.dataset.adminSuspendWorker = String(worker.id);
      setTextContent(suspendBtn, "Suspend");
      tdActions.append(suspendBtn);
    }

    if (worker.verificationStatus !== "verified") {
      const approveBtn = document.createElement("button");
      approveBtn.type = "button";
      approveBtn.className = "button primary admin-btn-action";
      approveBtn.dataset.adminApproveWorker = String(worker.id);
      setTextContent(approveBtn, "Approve");
      tdActions.append(approveBtn);
    }

    tr.append(tdId, tdName, tdService, tdDistrict, tdRating, tdAvail, tdVerif, tdStatus, tdActions);
    tbody.append(tr);
  }

  table.append(thead, tbody);
  wrapper.append(table);
  container.append(wrapper);
}

// ------------------------------------------
// Requests Tab
// ------------------------------------------
function renderRequestsTab(container) {
  container.replaceChildren();
  if (!canAccessAdmin()) return;

  const requests = getAdminRequests();
  if (requests.length === 0) {
    const empty = document.createElement("p");
    empty.className = "admin-empty-state";
    setTextContent(empty, "No customer requests recorded yet in this session.");
    container.append(empty);
    return;
  }

  const wrapper = document.createElement("div");
  wrapper.className = "admin-table-wrapper";

  const table = document.createElement("table");
  table.className = "admin-table";
  table.setAttribute("aria-label", "Customer Requests Overview Table");

  const thead = document.createElement("thead");
  const trHead = document.createElement("tr");
  ["Request ID", "Customer", "Worker", "Service", "District", "Status", "Created"].forEach((h) => {
    const th = document.createElement("th");
    setTextContent(th, h);
    trHead.append(th);
  });
  thead.append(trHead);

  const tbody = document.createElement("tbody");
  for (const req of requests) {
    const tr = document.createElement("tr");

    const tdId = document.createElement("td");
    const codeId = document.createElement("code");
    setTextContent(codeId, req.id.slice(0, 16) + "…");
    tdId.append(codeId);

    const tdCustomer = document.createElement("td");
    setTextContent(tdCustomer, req.customerName);

    const tdWorker = document.createElement("td");
    setTextContent(tdWorker, req.workerName);

    const tdService = document.createElement("td");
    setTextContent(tdService, req.service);

    const tdDistrict = document.createElement("td");
    setTextContent(tdDistrict, req.district);

    const tdStatus = document.createElement("td");
    const badgeType = req.status === "Completed" ? "badge-success" : req.status === "Accepted" ? "badge-info" : req.status === "Cancelled" ? "badge-danger" : "badge-neutral";
    tdStatus.append(renderBadge(req.status, badgeType));

    const tdCreated = document.createElement("td");
    setTextContent(tdCreated, formatTimestamp(req.createdAt));

    tr.append(tdId, tdCustomer, tdWorker, tdService, tdDistrict, tdStatus, tdCreated);
    tbody.append(tr);
  }

  table.append(thead, tbody);
  wrapper.append(table);
  container.append(wrapper);
}

// ------------------------------------------
// Reports Tab
// ------------------------------------------
function renderReportsTab(container) {
  container.replaceChildren();
  if (!canAccessAdmin()) return;

  const reports = getAdminReports();
  if (reports.length === 0) {
    const empty = document.createElement("p");
    empty.className = "admin-empty-state";
    setTextContent(empty, "No safety reports submitted yet in this session.");
    container.append(empty);
    return;
  }

  const list = document.createElement("div");
  list.className = "admin-reports-list";

  for (const report of reports) {
    const card = document.createElement("article");
    card.className = "admin-report-card";

    const header = document.createElement("div");
    header.className = "admin-report-header";

    const metaLeft = document.createElement("div");
    metaLeft.className = "admin-report-meta-left";
    const typeBadge = renderBadge(report.targetType.toUpperCase(), "badge-danger");
    const reasonSpan = document.createElement("strong");
    setTextContent(reasonSpan, `Reason: ${report.reason}`);
    metaLeft.append(typeBadge, reasonSpan);

    const statusBadge = renderBadge(
      report.status,
      report.status === "resolved" ? "badge-success" : report.status === "under_review" ? "badge-warning" : "badge-neutral"
    );
    header.append(metaLeft, statusBadge);

    const details = document.createElement("div");
    details.className = "admin-report-details";
    const targetInfo = document.createElement("p");
    setTextContent(targetInfo, `Target ID: ${report.targetId} · Reporter: ${report.reporterRole} (${report.reporterId})`);
    const dateInfo = document.createElement("time");
    setTextContent(dateInfo, `Submitted: ${formatTimestamp(report.createdAt)}`);
    details.append(targetInfo, dateInfo);

    const desc = document.createElement("blockquote");
    desc.className = "admin-report-quote";
    setTextContent(desc, report.description);

    const actions = document.createElement("div");
    actions.className = "admin-report-actions";

    if (report.status !== "under_review" && report.status !== "resolved") {
      const reviewBtn = document.createElement("button");
      reviewBtn.type = "button";
      reviewBtn.className = "button subtle admin-btn-action";
      reviewBtn.dataset.adminReportReview = report.id;
      setTextContent(reviewBtn, "Mark In Review");
      actions.append(reviewBtn);
    }

    if (report.status !== "resolved") {
      const resolveBtn = document.createElement("button");
      resolveBtn.type = "button";
      resolveBtn.className = "button primary admin-btn-action";
      resolveBtn.dataset.adminReportResolve = report.id;
      setTextContent(resolveBtn, "Resolve");
      actions.append(resolveBtn);
    }

    if (report.status !== "dismissed") {
      const dismissBtn = document.createElement("button");
      dismissBtn.type = "button";
      dismissBtn.className = "button subtle admin-btn-action admin-btn-danger";
      dismissBtn.dataset.adminReportDismiss = report.id;
      setTextContent(dismissBtn, "Dismiss");
      actions.append(dismissBtn);
    }

    card.append(header, details, desc, actions);
    list.append(card);
  }

  container.append(list);
}

// ------------------------------------------
// Reviews Tab
// ------------------------------------------
function renderReviewsTab(container) {
  container.replaceChildren();
  if (!canAccessAdmin()) return;

  const reviews = getAdminReviews();
  if (reviews.length === 0) {
    const empty = document.createElement("p");
    empty.className = "admin-empty-state";
    setTextContent(empty, "No customer reviews submitted yet in this session.");
    container.append(empty);
    return;
  }

  const list = document.createElement("div");
  list.className = "admin-reviews-list";

  for (const review of reviews) {
    const card = document.createElement("article");
    card.className = "admin-review-card";

    const header = document.createElement("div");
    header.className = "admin-review-header";

    const titleWrap = document.createElement("div");
    const author = document.createElement("strong");
    setTextContent(author, `${review.customerName} → ${review.workerName}`);
    const stars = document.createElement("span");
    stars.className = "admin-review-stars";
    setTextContent(stars, ` · ${review.rating} ★`);
    titleWrap.append(author, stars);

    const badgeWrap = document.createElement("div");
    badgeWrap.className = "admin-review-badges";
    if (review.isReported) {
      badgeWrap.append(renderBadge("REPORTED", "badge-danger"));
    }
    badgeWrap.append(
      renderBadge(
        review.status,
        review.status === "published" ? "badge-success" : review.status === "hidden" ? "badge-danger" : "badge-warning"
      )
    );
    header.append(titleWrap, badgeWrap);

    const body = document.createElement("p");
    body.className = "admin-review-body";
    setTextContent(body, review.text);

    if (review.workerReply) {
      const replyBox = document.createElement("div");
      replyBox.className = "admin-review-reply-box";
      const replyAuthor = document.createElement("strong");
      setTextContent(replyAuthor, `${review.workerName} response: `);
      const replyText = document.createElement("span");
      setTextContent(replyText, review.workerReply);
      replyBox.append(replyAuthor, replyText);
      card.append(header, body, replyBox);
    } else {
      card.append(header, body);
    }

    const actions = document.createElement("div");
    actions.className = "admin-review-actions";

    if (review.status === "hidden") {
      const restoreBtn = document.createElement("button");
      restoreBtn.type = "button";
      restoreBtn.className = "button primary admin-btn-action";
      restoreBtn.dataset.adminReviewRestore = review.id;
      setTextContent(restoreBtn, "Publish");
      actions.append(restoreBtn);
    } else {
      const hideBtn = document.createElement("button");
      hideBtn.type = "button";
      hideBtn.className = "button subtle admin-btn-action admin-btn-danger";
      hideBtn.dataset.adminReviewHide = review.id;
      setTextContent(hideBtn, "Hide Review");
      actions.append(hideBtn);
    }

    if (review.status !== "flagged") {
      const flagBtn = document.createElement("button");
      flagBtn.type = "button";
      flagBtn.className = "button subtle admin-btn-action";
      flagBtn.dataset.adminReviewFlag = review.id;
      setTextContent(flagBtn, "Flag for Review");
      actions.append(flagBtn);
    }

    card.append(actions);
    list.append(card);
  }

  container.append(list);
}

// ------------------------------------------
// Security & Abuse Tab
// ------------------------------------------
function renderSecurityTab(container) {
  container.replaceChildren();
  if (!canAccessAdmin()) return;

  const security = getAdminSecurityOverview();

  const secWrap = document.createElement("div");
  secWrap.className = "admin-security-wrap";

  // Security Events Table
  const eventsHeading = document.createElement("h3");
  eventsHeading.className = "admin-section-subtitle";
  setTextContent(eventsHeading, "Recent Security Events (bounded in-memory log)");
  secWrap.append(eventsHeading);

  if (security.events.length === 0) {
    const empty = document.createElement("p");
    empty.className = "admin-empty-state";
    setTextContent(empty, "No security events recorded.");
    secWrap.append(empty);
  } else {
    const tableWrap = document.createElement("div");
    tableWrap.className = "admin-table-wrapper";
    const table = document.createElement("table");
    table.className = "admin-table";
    const thead = document.createElement("thead");
    const trH = document.createElement("tr");
    ["Event Type", "Role Context", "Timestamp"].forEach((h) => {
      const th = document.createElement("th");
      setTextContent(th, h);
      trH.append(th);
    });
    thead.append(trH);

    const tbody = document.createElement("tbody");
    for (const ev of [...security.events].reverse()) {
      const tr = document.createElement("tr");
      const tdType = document.createElement("td");
      const isAlert = ev.type.includes("DENIED") || ev.type.includes("FAILURE") || ev.type.includes("SUSPICIOUS") || ev.type.includes("UNAUTHORIZED");
      tdType.append(renderBadge(ev.type, isAlert ? "badge-danger" : "badge-neutral"));

      const tdRole = document.createElement("td");
      setTextContent(tdRole, ev.role || "anonymous");

      const tdTime = document.createElement("td");
      setTextContent(tdTime, formatTimestamp(ev.timestamp));

      tr.append(tdType, tdRole, tdTime);
      tbody.append(tr);
    }
    table.append(thead, tbody);
    tableWrap.append(table);
    secWrap.append(tableWrap);
  }

  // Abuse Signals
  const abuseHeading = document.createElement("h3");
  abuseHeading.className = "admin-section-subtitle";
  setTextContent(abuseHeading, "Active Abuse Signals & Sliding Window Flags");
  secWrap.append(abuseHeading);

  if (security.abuseSignals.length === 0) {
    const empty = document.createElement("p");
    empty.className = "admin-empty-state";
    setTextContent(empty, "No abuse signals currently triggered.");
    secWrap.append(empty);
  } else {
    const tableWrap = document.createElement("div");
    tableWrap.className = "admin-table-wrapper";
    const table = document.createElement("table");
    table.className = "admin-table";
    const thead = document.createElement("thead");
    const trH = document.createElement("tr");
    ["User / ID", "Signal Type", "Severity", "Reason", "Timestamp"].forEach((h) => {
      const th = document.createElement("th");
      setTextContent(th, h);
      trH.append(th);
    });
    thead.append(trH);

    const tbody = document.createElement("tbody");
    for (const sig of [...security.abuseSignals].reverse()) {
      const tr = document.createElement("tr");
      const tdUser = document.createElement("td");
      setTextContent(tdUser, sig.userId);

      const tdType = document.createElement("td");
      setTextContent(tdType, sig.type);

      const tdSev = document.createElement("td");
      tdSev.append(renderBadge(sig.severity, sig.severity === "HIGH" ? "badge-danger" : sig.severity === "MEDIUM" ? "badge-warning" : "badge-neutral"));

      const tdReason = document.createElement("td");
      setTextContent(tdReason, sig.details || "Rate threshold reached");

      const tdTime = document.createElement("td");
      setTextContent(tdTime, formatTimestamp(sig.timestamp));

      tr.append(tdUser, tdType, tdSev, tdReason, tdTime);
      tbody.append(tr);
    }
    table.append(thead, tbody);
    tableWrap.append(table);
    secWrap.append(tableWrap);
  }

  container.append(secWrap);
}

// ------------------------------------------
// Audit Log Tab
// ------------------------------------------
function renderAuditTab(container) {
  container.replaceChildren();
  if (!canAccessAdmin()) return;

  const logs = getAdminAuditLogs();
  if (logs.length === 0) {
    const empty = document.createElement("p");
    empty.className = "admin-empty-state";
    setTextContent(empty, "No administrative actions recorded in this session.");
    container.append(empty);
    return;
  }

  const wrapper = document.createElement("div");
  wrapper.className = "admin-table-wrapper";

  const table = document.createElement("table");
  table.className = "admin-table";
  table.setAttribute("aria-label", "Privileged Administrative Audit Log");

  const thead = document.createElement("thead");
  const trH = document.createElement("tr");
  ["Timestamp", "Action", "Target Type", "Target ID", "Result", "Admin ID"].forEach((h) => {
    const th = document.createElement("th");
    setTextContent(th, h);
    trH.append(th);
  });
  thead.append(trH);

  const tbody = document.createElement("tbody");
  for (const log of logs) {
    const tr = document.createElement("tr");

    const tdTime = document.createElement("td");
    setTextContent(tdTime, formatTimestamp(log.timestamp));

    const tdAction = document.createElement("td");
    const codeAction = document.createElement("code");
    setTextContent(codeAction, log.action);
    tdAction.append(codeAction);

    const tdType = document.createElement("td");
    setTextContent(tdType, log.targetType);

    const tdTarget = document.createElement("td");
    setTextContent(tdTarget, log.targetId);

    const tdResult = document.createElement("td");
    tdResult.append(renderBadge(log.result, log.result === "success" || log.result === "approved" || log.result === "active" ? "badge-success" : "badge-neutral"));

    const tdAdmin = document.createElement("td");
    setTextContent(tdAdmin, log.adminId);

    tr.append(tdTime, tdAction, tdType, tdTarget, tdResult, tdAdmin);
    tbody.append(tr);
  }

  table.append(thead, tbody);
  wrapper.append(table);
  container.append(wrapper);
}

// ------------------------------------------
// Tab Switcher
// ------------------------------------------
function switchAdminTab(tabName) {
  activeTab = tabName;
  const tabs = document.querySelectorAll(".admin-tab-button");
  tabs.forEach((tab) => {
    const isSelected = tab.dataset.adminTab === tabName;
    tab.setAttribute("aria-selected", String(isSelected));
    tab.classList.toggle("active", isSelected);
  });

  const container = document.getElementById("adminTabContent");
  if (!container) return;

  switch (tabName) {
    case "workers":
      renderWorkersTab(container);
      break;
    case "requests":
      renderRequestsTab(container);
      break;
    case "reports":
      renderReportsTab(container);
      break;
    case "reviews":
      renderReviewsTab(container);
      break;
    case "security":
      renderSecurityTab(container);
      break;
    case "audit":
      renderAuditTab(container);
      break;
    case "overview":
    default:
      renderOverviewTab(container);
      break;
  }
}

// ------------------------------------------
// Public Admin Control Methods
// ------------------------------------------
export function openAdminDashboard() {
  if (!canAccessAdmin()) {
    closeModal("adminDashboardModal");
    openModal("adminAccessDeniedModal");
    return false;
  }

  const user = getCurrentUser();
  const identityEl = document.getElementById("adminSessionIdentity");
  if (identityEl && user) {
    setTextContent(identityEl, `${user.name} (${user.id})`);
  }

  switchAdminTab(activeTab || "overview");
  openModal("adminDashboardModal");
  return true;
}

export function closeAdminDashboard() {
  closeModal("adminDashboardModal");
}

export function loginAsDemoAdmin() {
  const admin = loginAsAdminForDemo();
  openAdminDashboard();
  return admin;
}

export function logoutAdmin() {
  logoutAdminForDemo();
  closeAdminDashboard();
  const accountBtn = document.getElementById("authAccount");
  const continueBtn = document.getElementById("authContinue");
  if (accountBtn) accountBtn.hidden = true;
  if (continueBtn) continueBtn.hidden = false;
  if (toastHandler) {
    toastHandler("Logged out from administrator session.");
  }
}

export { canAccessAdmin };

// ------------------------------------------
// Initialization & Click Delegations
// ------------------------------------------
export function initializeAdminDashboard(options = {}) {
  if (initialized) return;
  initialized = true;
  toastHandler = options.showToast || null;

  // Listen to hash change for direct navigation attempts
  window.addEventListener("hashchange", () => {
    if (window.location.hash === "#admin") {
      if (!canAccessAdmin()) {
        try {
          history.replaceState(null, "", window.location.pathname + window.location.search);
        } catch {}
        openModal("adminAccessDeniedModal");
        return;
      }
      openAdminDashboard();
    }
  });

  // Check initial hash on page load
  if (window.location.hash === "#admin") {
    if (!canAccessAdmin()) {
      try {
        history.replaceState(null, "", window.location.pathname + window.location.search);
      } catch {}
      openModal("adminAccessDeniedModal");
    } else {
      openAdminDashboard();
    }
  }

  // Delegated click listener for admin dashboard actions
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    // Admin Tabs
    const tabBtn = target.closest(".admin-tab-button");
    if (tabBtn && tabBtn.dataset.adminTab) {
      switchAdminTab(tabBtn.dataset.adminTab);
      return;
    }

    // Admin Logout
    if (target.closest("#adminLogoutButton")) {
      logoutAdmin();
      return;
    }

    // Worker Approval / Status
    const approveWorkerBtn = target.closest("[data-admin-approve-worker]");
    if (approveWorkerBtn) {
      const workerId = approveWorkerBtn.dataset.adminApproveWorker;
      updateWorkerApprovalForDemo(workerId, true);
      switchAdminTab(activeTab);
      if (toastHandler) toastHandler(`Worker #${workerId} approved.`);
      return;
    }

    const suspendWorkerBtn = target.closest("[data-admin-suspend-worker]");
    if (suspendWorkerBtn) {
      const workerId = suspendWorkerBtn.dataset.adminSuspendWorker;
      updateWorkerStatusForDemo(workerId, "suspended");
      switchAdminTab(activeTab);
      if (toastHandler) toastHandler(`Worker #${workerId} suspended.`);
      return;
    }

    const restoreWorkerBtn = target.closest("[data-admin-restore-worker]");
    if (restoreWorkerBtn) {
      const workerId = restoreWorkerBtn.dataset.adminRestoreWorker;
      updateWorkerStatusForDemo(workerId, "active");
      switchAdminTab(activeTab);
      if (toastHandler) toastHandler(`Worker #${workerId} restored.`);
      return;
    }

    // Report Moderation
    const reportReviewBtn = target.closest("[data-admin-report-review]");
    if (reportReviewBtn) {
      const reportId = reportReviewBtn.dataset.adminReportReview;
      updateReportStatusForDemo(reportId, "under_review");
      switchAdminTab(activeTab);
      if (toastHandler) toastHandler("Report marked under review.");
      return;
    }

    const reportResolveBtn = target.closest("[data-admin-report-resolve]");
    if (reportResolveBtn) {
      const reportId = reportResolveBtn.dataset.adminReportResolve;
      updateReportStatusForDemo(reportId, "resolved");
      switchAdminTab(activeTab);
      if (toastHandler) toastHandler("Report resolved.");
      return;
    }

    const reportDismissBtn = target.closest("[data-admin-report-dismiss]");
    if (reportDismissBtn) {
      const reportId = reportDismissBtn.dataset.adminReportDismiss;
      updateReportStatusForDemo(reportId, "dismissed");
      switchAdminTab(activeTab);
      if (toastHandler) toastHandler("Report dismissed.");
      return;
    }

    // Review Moderation
    const reviewHideBtn = target.closest("[data-admin-review-hide]");
    if (reviewHideBtn) {
      const reviewId = reviewHideBtn.dataset.adminReviewHide;
      updateReviewStatusForDemo(reviewId, "hidden");
      switchAdminTab(activeTab);
      if (toastHandler) toastHandler("Review hidden.");
      return;
    }

    const reviewRestoreBtn = target.closest("[data-admin-review-restore]");
    if (reviewRestoreBtn) {
      const reviewId = reviewRestoreBtn.dataset.adminReviewRestore;
      updateReviewStatusForDemo(reviewId, "published");
      switchAdminTab(activeTab);
      if (toastHandler) toastHandler("Review published.");
      return;
    }

    const reviewFlagBtn = target.closest("[data-admin-review-flag]");
    if (reviewFlagBtn) {
      const reviewId = reviewFlagBtn.dataset.adminReviewFlag;
      updateReviewStatusForDemo(reviewId, "flagged");
      switchAdminTab(activeTab);
      if (toastHandler) toastHandler("Review flagged.");
      return;
    }
  });
}
