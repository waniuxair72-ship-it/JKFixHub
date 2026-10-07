// ==========================================
// #ADMIN_APP
// ==========================================
// Dedicated Application Controller for [JK] FixHub Admin Panel.
//
// Security Design:
// 1. Strictly authenticated via Firebase Auth + Firestore /admins/{uid} verification.
// 2. Pure DOM manipulation (document.createElement, textContent); zero unsafe string injection.
// 3. Every administrative action generates a real audit trail record in /auditLogs.
// 4. Role tampering in client memory does not compromise backend database security.
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

let activeTab = "dashboard";
let currentAdmin = null;

// ----------------------------------------------------------------------------
// Utility Helpers
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

  if (!modalBackdrop || !modalTitle || !modalBody || !confirmBtn) return;

  modalTitle.textContent = title;
  modalBody.textContent = body;
  confirmBtn.textContent = confirmText;
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

// ----------------------------------------------------------------------------
// View Rendering Engine
// ----------------------------------------------------------------------------
async function renderActiveView() {
  const container = document.getElementById("adminMainContent");
  if (!container) return;

  container.replaceChildren();

  // Highlight active tab
  document.querySelectorAll(".admin-nav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.adminTab === activeTab);
  });

  const loadingWrap = document.createElement("div");
  loadingWrap.className = "admin-empty-state";
  const loadingText = document.createElement("p");
  loadingText.textContent = "Loading live data...";
  loadingWrap.appendChild(loadingText);
  container.appendChild(loadingWrap);

  switch (activeTab) {
    case "dashboard":
      await renderDashboardView(container);
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
    case "security":
      await renderSecurityView(container);
      break;
    case "audit":
      await renderAuditLogView(container);
      break;
    default:
      await renderDashboardView(container);
  }
}

// ----------------------------------------------------------------------------
// 1. Dashboard / Overview View
// ----------------------------------------------------------------------------
async function renderDashboardView(container) {
  const stats = await getAdminOverviewStats();
  container.replaceChildren();

  const header = document.createElement("div");
  header.className = "admin-view-header";
  const titleBox = document.createElement("div");
  titleBox.className = "admin-view-title";
  const h2 = document.createElement("h2");
  h2.textContent = "Platform Overview";
  const p = document.createElement("p");
  p.textContent = "Live operational indicators and system statistics.";
  titleBox.appendChild(h2);
  titleBox.appendChild(p);
  header.appendChild(titleBox);
  container.appendChild(header);

  const grid = document.createElement("div");
  grid.className = "admin-metrics-grid";

  const metrics = [
    { label: "Total Customers", value: stats.totalCustomers, note: "Registered customer accounts" },
    { label: "Total Workers", value: stats.totalWorkers, note: "Directory service professionals" },
    { label: "Pending Verification", value: stats.pendingWorkerVerification, note: "Awaiting administrative review" },
    { label: "Active Requests", value: stats.activeRequests, note: "Pending or Accepted status" },
    { label: "Completed Requests", value: stats.completedRequests, note: "Successfully fulfilled" },
    { label: "Open Reports", value: stats.openReports, note: "Trust & Safety inquiries" },
    { label: "Reported Reviews", value: stats.reportedReviews, note: "Flagged customer feedback" },
    { label: "Security Events", value: stats.securityEvents, note: "Logged security signals" }
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
    grid.appendChild(card);
  }

  container.appendChild(grid);
}

// ----------------------------------------------------------------------------
// 2. Workers View
// ----------------------------------------------------------------------------
async function renderWorkersView(container) {
  const workers = await getAdminWorkers();
  container.replaceChildren();

  const header = document.createElement("div");
  header.className = "admin-view-header";
  const titleBox = document.createElement("div");
  titleBox.className = "admin-view-title";
  const h2 = document.createElement("h2");
  h2.textContent = "Worker Management";
  const p = document.createElement("p");
  p.textContent = "Moderate worker onboarding, credentials, verification, and suspension status.";
  titleBox.appendChild(h2);
  titleBox.appendChild(p);
  header.appendChild(titleBox);
  container.appendChild(header);

  if (workers.length === 0) {
    const empty = document.createElement("div");
    empty.className = "admin-empty-state";
    const h3 = document.createElement("h3");
    h3.textContent = "No worker profiles found";
    const sub = document.createElement("p");
    sub.textContent = "No registered workers are currently in the Firestore database.";
    empty.appendChild(h3);
    empty.appendChild(sub);
    container.appendChild(empty);
    return;
  }

  const tableWrap = document.createElement("div");
  tableWrap.className = "admin-table-container";

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
  for (const w of workers) {
    const row = document.createElement("tr");

    // ID
    const tdId = document.createElement("td");
    tdId.textContent = String(w.id || "—");
    row.appendChild(tdId);

    // Name
    const tdName = document.createElement("td");
    tdName.textContent = String(w.name || "Worker");
    row.appendChild(tdName);

    // Service
    const tdService = document.createElement("td");
    tdService.textContent = String(w.service || "—");
    row.appendChild(tdService);

    // District
    const tdDist = document.createElement("td");
    tdDist.textContent = String(w.district || "—");
    row.appendChild(tdDist);

    // Rating
    const tdRating = document.createElement("td");
    tdRating.textContent = w.rating ? `★ ${w.rating}` : "—";
    row.appendChild(tdRating);

    // Status
    const tdStatus = document.createElement("td");
    const statusPill = document.createElement("span");
    statusPill.className = `admin-status-pill ${w.status || "active"}`;
    statusPill.textContent = String(w.status || "active");
    tdStatus.appendChild(statusPill);
    row.appendChild(tdStatus);

    // Verification
    const tdVer = document.createElement("td");
    const verPill = document.createElement("span");
    verPill.className = `admin-status-pill ${w.isVerified ? "verified" : "pending"}`;
    verPill.textContent = w.isVerified ? "Verified" : "Pending";
    tdVer.appendChild(verPill);
    row.appendChild(tdVer);

    // Actions
    const tdActions = document.createElement("td");
    const actionsBox = document.createElement("div");
    actionsBox.className = "admin-table-actions";

    if (!w.isVerified) {
      const approveBtn = document.createElement("button");
      approveBtn.type = "button";
      approveBtn.className = "admin-table-btn approve";
      approveBtn.textContent = "Approve";
      approveBtn.onclick = () => {
        showConfirmModal({
          title: "Approve Worker",
          body: `Approve and verify ${w.name} (#${w.id}) for public service discovery?`,
          confirmText: "Approve Worker",
          onConfirm: async () => {
            const res = await updateAdminWorkerStatus(w.id, { isVerified: true, status: "active" }, currentAdmin.uid);
            if (res.success) {
              showToast(`Worker ${w.name} approved.`);
              renderActiveView();
            } else {
              showToast("Failed to approve worker.");
            }
          }
        });
      };
      actionsBox.appendChild(approveBtn);
    }

    if (w.status !== "suspended") {
      const suspendBtn = document.createElement("button");
      suspendBtn.type = "button";
      suspendBtn.className = "admin-table-btn suspend";
      suspendBtn.textContent = "Suspend";
      suspendBtn.onclick = () => {
        showConfirmModal({
          title: "Suspend Worker",
          body: `Suspend ${w.name} (#${w.id})? They will be hidden from public discovery.`,
          confirmText: "Suspend Worker",
          onConfirm: async () => {
            const res = await updateAdminWorkerStatus(w.id, { status: "suspended" }, currentAdmin.uid);
            if (res.success) {
              showToast(`Worker ${w.name} suspended.`);
              renderActiveView();
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
          title: "Restore Worker",
          body: `Restore ${w.name} (#${w.id}) to active status?`,
          confirmText: "Restore Worker",
          onConfirm: async () => {
            const res = await updateAdminWorkerStatus(w.id, { status: "active" }, currentAdmin.uid);
            if (res.success) {
              showToast(`Worker ${w.name} restored.`);
              renderActiveView();
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
  container.appendChild(tableWrap);
}

// ----------------------------------------------------------------------------
// 3. Customers View
// ----------------------------------------------------------------------------
async function renderCustomersView(container) {
  const customers = await getAdminCustomers();
  container.replaceChildren();

  const header = document.createElement("div");
  header.className = "admin-view-header";
  const titleBox = document.createElement("div");
  titleBox.className = "admin-view-title";
  const h2 = document.createElement("h2");
  h2.textContent = "Customer Accounts";
  const p = document.createElement("p");
  p.textContent = "Manage registered customer identities and verification status.";
  titleBox.appendChild(h2);
  titleBox.appendChild(p);
  header.appendChild(titleBox);
  container.appendChild(header);

  if (customers.length === 0) {
    const empty = document.createElement("div");
    empty.className = "admin-empty-state";
    const h3 = document.createElement("h3");
    h3.textContent = "No customer accounts found";
    const sub = document.createElement("p");
    sub.textContent = "No registered customer records currently exist in Firestore.";
    empty.appendChild(h3);
    empty.appendChild(sub);
    container.appendChild(empty);
    return;
  }

  const tableWrap = document.createElement("div");
  tableWrap.className = "admin-table-container";

  const table = document.createElement("table");
  table.className = "admin-table";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["UID", "Name", "Email", "Email Verified", "District", "Registered"].forEach((txt) => {
    const th = document.createElement("th");
    th.textContent = txt;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const c of customers) {
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
    tdDate.textContent = c.createdAt ? new Date(c.createdAt).toLocaleDateString() : "—";
    row.appendChild(tdDate);

    tbody.appendChild(row);
  }

  table.appendChild(tbody);
  tableWrap.appendChild(table);
  container.appendChild(tableWrap);
}

// ----------------------------------------------------------------------------
// 4. Requests View
// ----------------------------------------------------------------------------
async function renderRequestsView(container) {
  const requests = await getAdminRequests();
  container.replaceChildren();

  const header = document.createElement("div");
  header.className = "admin-view-header";
  const titleBox = document.createElement("div");
  titleBox.className = "admin-view-title";
  const h2 = document.createElement("h2");
  h2.textContent = "Service Requests";
  const p = document.createElement("p");
  p.textContent = "Platform-wide service requests and fulfillment tracking.";
  titleBox.appendChild(h2);
  titleBox.appendChild(p);
  header.appendChild(titleBox);
  container.appendChild(header);

  if (requests.length === 0) {
    const empty = document.createElement("div");
    empty.className = "admin-empty-state";
    const h3 = document.createElement("h3");
    h3.textContent = "No service requests found";
    const sub = document.createElement("p");
    sub.textContent = "No service requests have been submitted yet.";
    empty.appendChild(h3);
    empty.appendChild(sub);
    container.appendChild(empty);
    return;
  }

  const tableWrap = document.createElement("div");
  tableWrap.className = "admin-table-container";

  const table = document.createElement("table");
  table.className = "admin-table";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["Request ID", "Customer", "Worker", "Service", "District", "Status", "Date"].forEach((txt) => {
    const th = document.createElement("th");
    th.textContent = txt;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const r of requests) {
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
    tdDate.textContent = r.createdAt ? new Date(r.createdAt).toLocaleDateString() : "—";
    row.appendChild(tdDate);

    tbody.appendChild(row);
  }

  table.appendChild(tbody);
  tableWrap.appendChild(table);
  container.appendChild(tableWrap);
}

// ----------------------------------------------------------------------------
// 5. Reports View
// ----------------------------------------------------------------------------
async function renderReportsView(container) {
  const reports = await getAdminReports();
  container.replaceChildren();

  const header = document.createElement("div");
  header.className = "admin-view-header";
  const titleBox = document.createElement("div");
  titleBox.className = "admin-view-title";
  const h2 = document.createElement("h2");
  h2.textContent = "Trust & Safety Reports";
  const p = document.createElement("p");
  p.textContent = "Review safety reports regarding workers, customers, reviews, and conduct.";
  titleBox.appendChild(h2);
  titleBox.appendChild(p);
  header.appendChild(titleBox);
  container.appendChild(header);

  if (reports.length === 0) {
    const empty = document.createElement("div");
    empty.className = "admin-empty-state";
    const h3 = document.createElement("h3");
    h3.textContent = "No active safety reports";
    const sub = document.createElement("p");
    sub.textContent = "There are currently no trust & safety incident reports.";
    empty.appendChild(h3);
    empty.appendChild(sub);
    container.appendChild(empty);
    return;
  }

  const tableWrap = document.createElement("div");
  tableWrap.className = "admin-table-container";

  const table = document.createElement("table");
  table.className = "admin-table";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["ID", "Target Type", "Reason", "Status", "Reported At", "Actions"].forEach((txt) => {
    const th = document.createElement("th");
    th.textContent = txt;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const rep of reports) {
    const row = document.createElement("tr");

    const tdId = document.createElement("td");
    tdId.textContent = String(rep.id);
    row.appendChild(tdId);

    const tdTarget = document.createElement("td");
    tdTarget.textContent = `${rep.targetType || "user"}: #${rep.targetId || "—"}`;
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
    tdDate.textContent = rep.createdAt ? new Date(rep.createdAt).toLocaleDateString() : "—";
    row.appendChild(tdDate);

    const tdActions = document.createElement("td");
    const actionsBox = document.createElement("div");
    actionsBox.className = "admin-table-actions";

    if (rep.status !== "under_review" && rep.status !== "resolved") {
      const reviewBtn = document.createElement("button");
      reviewBtn.type = "button";
      reviewBtn.className = "admin-table-btn";
      reviewBtn.textContent = "Under Review";
      reviewBtn.onclick = async () => {
        const res = await updateAdminReportStatus(rep.id, "under_review", currentAdmin.uid);
        if (res.success) {
          showToast("Report marked under review.");
          renderActiveView();
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
          title: "Resolve Report",
          body: `Mark report #${rep.id} as resolved?`,
          confirmText: "Mark Resolved",
          onConfirm: async () => {
            const res = await updateAdminReportStatus(rep.id, "resolved", currentAdmin.uid);
            if (res.success) {
              showToast("Report resolved.");
              renderActiveView();
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
      dismissBtn.onclick = async () => {
        const res = await updateAdminReportStatus(rep.id, "dismissed", currentAdmin.uid);
        if (res.success) {
          showToast("Report dismissed.");
          renderActiveView();
        }
      };
      actionsBox.appendChild(dismissBtn);
    }

    tdActions.appendChild(actionsBox);
    row.appendChild(tdActions);
    tbody.appendChild(row);
  }

  table.appendChild(tbody);
  tableWrap.appendChild(table);
  container.appendChild(tableWrap);
}

// ----------------------------------------------------------------------------
// 6. Reviews View
// ----------------------------------------------------------------------------
async function renderReviewsView(container) {
  const reviews = await getAdminReviews();
  container.replaceChildren();

  const header = document.createElement("div");
  header.className = "admin-view-header";
  const titleBox = document.createElement("div");
  titleBox.className = "admin-view-title";
  const h2 = document.createElement("h2");
  h2.textContent = "Review Moderation";
  const p = document.createElement("p");
  p.textContent = "Audit customer reviews, ratings, and worker responses.";
  titleBox.appendChild(h2);
  titleBox.appendChild(p);
  header.appendChild(titleBox);
  container.appendChild(header);

  if (reviews.length === 0) {
    const empty = document.createElement("div");
    empty.className = "admin-empty-state";
    const h3 = document.createElement("h3");
    h3.textContent = "No customer reviews found";
    const sub = document.createElement("p");
    sub.textContent = "No customer reviews exist in the database.";
    empty.appendChild(h3);
    empty.appendChild(sub);
    container.appendChild(empty);
    return;
  }

  const tableWrap = document.createElement("div");
  tableWrap.className = "admin-table-container";

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
  for (const rev of reviews) {
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

    if (rev.status !== "published") {
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
          renderActiveView();
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
  container.appendChild(tableWrap);
}

// ----------------------------------------------------------------------------
// 7. Security & Abuse View
// ----------------------------------------------------------------------------
async function renderSecurityView(container) {
  const events = await getAdminSecurityEvents();
  container.replaceChildren();

  const header = document.createElement("div");
  header.className = "admin-view-header";
  const titleBox = document.createElement("div");
  titleBox.className = "admin-view-title";
  const h2 = document.createElement("h2");
  h2.textContent = "Security & Abuse Signals";
  const p = document.createElement("p");
  p.textContent = "Real-time security signals and anomalous request detections.";
  titleBox.appendChild(h2);
  titleBox.appendChild(p);
  header.appendChild(titleBox);
  container.appendChild(header);

  if (events.length === 0) {
    const empty = document.createElement("div");
    empty.className = "admin-empty-state";
    const h3 = document.createElement("h3");
    h3.textContent = "No security events recorded";
    const sub = document.createElement("p");
    sub.textContent = "No anomalous or suspicious activities have been flagged.";
    empty.appendChild(h3);
    empty.appendChild(sub);
    container.appendChild(empty);
    return;
  }

  const tableWrap = document.createElement("div");
  tableWrap.className = "admin-table-container";

  const table = document.createElement("table");
  table.className = "admin-table";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["Event ID", "Type", "Severity", "Actor / Role", "Timestamp"].forEach((txt) => {
    const th = document.createElement("th");
    th.textContent = txt;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const ev of events) {
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
    tdTime.textContent = ev.timestamp ? new Date(ev.timestamp).toLocaleString() : "—";
    row.appendChild(tdTime);

    tbody.appendChild(row);
  }

  table.appendChild(tbody);
  tableWrap.appendChild(table);
  container.appendChild(tableWrap);
}

// ----------------------------------------------------------------------------
// 8. Audit Log View
// ----------------------------------------------------------------------------
async function renderAuditLogView(container) {
  const logs = await getAdminAuditLogs();
  container.replaceChildren();

  const header = document.createElement("div");
  header.className = "admin-view-header";
  const titleBox = document.createElement("div");
  titleBox.className = "admin-view-title";
  const h2 = document.createElement("h2");
  h2.textContent = "Administrative Audit Log";
  const p = document.createElement("p");
  p.textContent = "Append-only, immutable record of privileged management operations.";
  titleBox.appendChild(h2);
  titleBox.appendChild(p);
  header.appendChild(titleBox);
  container.appendChild(header);

  if (logs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "admin-empty-state";
    const h3 = document.createElement("h3");
    h3.textContent = "No audit log entries";
    const sub = document.createElement("p");
    sub.textContent = "No administrative operations have been performed yet.";
    empty.appendChild(h3);
    empty.appendChild(sub);
    container.appendChild(empty);
    return;
  }

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
  for (const log of logs) {
    const row = document.createElement("tr");

    const tdTime = document.createElement("td");
    tdTime.textContent = log.timestamp ? new Date(log.timestamp).toLocaleString() : "—";
    row.appendChild(tdTime);

    const tdAdmin = document.createElement("td");
    tdAdmin.textContent = String(log.adminUid ? `${log.adminUid.substring(0, 8)}...` : "system");
    tdAdmin.title = String(log.adminUid || "system");
    row.appendChild(tdAdmin);

    const tdAct = document.createElement("td");
    tdAct.textContent = String(log.action || "UNKNOWN_ACTION");
    row.appendChild(tdAct);

    const tdTarget = document.createElement("td");
    tdTarget.textContent = `${log.targetType || "entity"}: ${log.targetId || "—"}`;
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

// ----------------------------------------------------------------------------
// Application Lifecycle & Event Binding
// ----------------------------------------------------------------------------
function handleAuthStateChange(adminSession) {
  const loginSection = document.getElementById("adminLoginSection");
  const appSection = document.getElementById("adminAppSection");
  const identityDisplay = document.getElementById("adminIdentityDisplay");

  currentAdmin = adminSession;

  if (adminSession) {
    if (loginSection) loginSection.hidden = true;
    if (appSection) appSection.hidden = false;

    if (identityDisplay) {
      identityDisplay.textContent = `${adminSession.displayName || "Administrator"} (${adminSession.email || adminSession.uid})`;
    }

    renderActiveView();
  } else {
    if (loginSection) loginSection.hidden = false;
    if (appSection) appSection.hidden = true;
  }
}

function initializeAdminApp() {
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
        submitBtn.textContent = "Sign In to Admin Panel";
      }

      if (!res.success) {
        if (loginError && loginErrorMsg) {
          loginErrorMsg.textContent = res.error || "Access unavailable. This area is restricted to authorized administrators.";
          loginError.hidden = false;
        }
      }
    });
  }

  // 3. Sign Out Button
  const signOutBtn = document.getElementById("adminSignOutBtn");
  if (signOutBtn) {
    signOutBtn.addEventListener("click", async () => {
      await signOutAdmin();
      showToast("Signed out from administration session.");
    });
  }

  // 4. Tab Navigation Click Delegation
  document.addEventListener("click", (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;

    const navBtn = target.closest(".admin-nav-item");
    if (navBtn && navBtn.dataset.adminTab) {
      activeTab = navBtn.dataset.adminTab;
      renderActiveView();
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeAdminApp);
} else {
  initializeAdminApp();
}
