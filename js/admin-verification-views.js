// ==========================================
// #ADMIN_VERIFICATION_VIEWS
// ==========================================
// Dedicated Admin Control Centre sections for:
// 1. Customer Verification (manual identity verification using existing profile data — NO ID images/numbers).
// 2. Verification & Badges (unified customer & worker badge management, audit history, and Pro separation).
//
// Security: Pure DOM creation (zero innerHTML), fail-closed admin writes, confirmation dialogs,
// immediate /verifiedBadges/{uid} synchronization, and immutable /auditLogs entries.
// ==========================================

import {
  getAdminCustomers,
  getAdminWorkers,
  updateAdminCustomerVerification,
  updateAdminWorkerVerification,
  backfillAdminVerifiedWorkerBadges
} from "./firestore-service.js";
import {
  VERIFICATION_STATUSES,
  isCustomerOfficiallyVerified,
  isWorkerOfficiallyVerified,
  normalizeCustomerVerification,
  normalizeWorkerVerification,
  resolveAccountTrustAndMembership
} from "./membership-schema.js";
import {
  createVerifiedCustomerBadge,
  createVerifiedWorkerBadge
} from "./badges.js";

export function formatVerificationStatusLabel(status) {
  switch (status) {
    case "Verified":
      return "Verified";
    case "Pending":
      return "Waiting for Review";
    case "Rejected":
      return "Declined";
    case "Revoked":
      return "Badge Removed";
    case "Not Verified":
      return "Not Verified";
    default:
      return String(status || "Not Verified");
  }
}

function statusToPillClass(status) {
  switch (status) {
    case "Verified":
      return "verified";
    case "Pending":
      return "pending";
    case "Rejected":
      return "rejected";
    case "Revoked":
      return "suspended";
    default:
      return "inactive";
  }
}

function createDetailRow(label, value, fullWidth = false) {
  const item = document.createElement("div");
  item.className = fullWidth ? "admin-detail-item full-width" : "admin-detail-item";
  const lbl = document.createElement("div");
  lbl.className = "admin-detail-label";
  lbl.textContent = label;
  const val = document.createElement("div");
  val.className = "admin-detail-value";
  if (value instanceof Node) {
    val.appendChild(value);
  } else {
    val.textContent = String(value ?? "—");
  }
  item.append(lbl, val);
  return item;
}

function buildHistoryTimeline(history, formatDateTime) {
  const list = Array.isArray(history) ? [...history].reverse() : [];
  if (list.length === 0) {
    const empty = document.createElement("p");
    empty.className = "admin-muted-copy";
    empty.textContent = "No review history recorded yet.";
    return empty;
  }

  const ul = document.createElement("ul");
  ul.className = "admin-verification-history";
  for (const entry of list) {
    const li = document.createElement("li");
    li.className = "admin-verification-history-item";

    const top = document.createElement("div");
    top.className = "admin-verification-history-top";
    const transition = document.createElement("strong");
    const prevText = formatVerificationStatusLabel(entry.previousStatus || "Not Verified");
    const newText = formatVerificationStatusLabel(entry.newStatus || "Updated");
    transition.textContent = `${prevText} → ${newText}`;
    const when = document.createElement("span");
    when.className = "admin-verification-history-time";
    when.textContent = formatDateTime(entry.actionAt);
    top.append(transition, when);

    const by = document.createElement("div");
    by.className = "admin-verification-history-meta";
    by.textContent = `Reviewed by: ${entry.actionBy || "system"}`;

    li.append(top, by);
    if (entry.reason || entry.note) {
      const note = document.createElement("p");
      note.className = "admin-verification-history-note";
      note.textContent = entry.reason
        ? `Reason: ${entry.reason}${entry.note && entry.note !== entry.reason ? ` · Note: ${entry.note}` : ""}`
        : `Note: ${entry.note}`;
      li.appendChild(note);
    }
    ul.appendChild(li);
  }
  return ul;
}

// ----------------------------------------------------------------------------
// SECTION A: Customer Verification
// ----------------------------------------------------------------------------
export async function renderCustomerVerificationView(container, ctx) {
  const {
    currentAdmin,
    showToast,
    showConfirmModal,
    showReasonConfirmModal,
    showDetailModal,
    formatDateTime,
    formatDateOnly,
    applyResponsiveTableLabels
  } = ctx;

  const customers = await getAdminCustomers();
  container.replaceChildren();

  const filterState = {
    query: "",
    status: "all"
  };

  // Header
  const header = document.createElement("div");
  header.className = "admin-view-header";
  const titleBox = document.createElement("div");
  titleBox.className = "admin-view-title";
  const h2 = document.createElement("h2");
  h2.textContent = "Customer Verification";
  const p = document.createElement("p");
  p.textContent = "Manually verify genuine customer accounts using existing profile details. Verified customers receive the JKFixHub Verified Customer badge.";
  titleBox.append(h2, p);
  header.appendChild(titleBox);
  container.appendChild(header);

  // Privacy safeguard banner
  const privacyNotice = document.createElement("div");
  privacyNotice.className = "admin-info-banner";
  const privacyStrong = document.createElement("strong");
  privacyStrong.textContent = "Privacy & Review Guidelines: ";
  const privacyText = document.createElement("span");
  privacyText.textContent = "Review profile details only (name, email, phone, district, and account status). Never ask for or store ID cards, government numbers, or personal documents.";
  privacyNotice.append(privacyStrong, privacyText);
  container.appendChild(privacyNotice);

  // Summary metrics
  const metricsWrap = document.createElement("div");
  metricsWrap.className = "admin-metrics-grid";
  container.appendChild(metricsWrap);

  const renderMetrics = () => {
    const counts = {
      total: customers.length,
      Verified: 0,
      Pending: 0,
      "Not Verified": 0,
      Rejected: 0,
      Revoked: 0
    };
    for (const c of customers) {
      const st = normalizeCustomerVerification(c).status;
      if (counts[st] !== undefined) counts[st]++;
    }
    const items = [
      { label: "Total Customers", value: counts.total, note: "All customer accounts" },
      { label: "Verified Customers", value: counts.Verified, note: "Active Verified Customer badge" },
      { label: "Waiting for Review", value: counts.Pending, note: "Accounts waiting for review" },
      { label: "Not Verified", value: counts["Not Verified"], note: "Accounts not yet reviewed" },
      { label: "Declined or Removed", value: counts.Rejected + counts.Revoked, note: "Applications declined or badges removed" }
    ];
    metricsWrap.replaceChildren(
      ...items.map((m) => {
        const card = document.createElement("div");
        card.className = "admin-metric-card";
        const lbl = document.createElement("div");
        lbl.className = "admin-metric-label";
        lbl.textContent = m.label;
        const val = document.createElement("div");
        val.className = "admin-metric-value";
        val.textContent = String(m.value);
        const note = document.createElement("div");
        note.className = "admin-metric-note";
        note.textContent = m.note;
        card.append(lbl, val, note);
        return card;
      })
    );
  };

  // Toolbar
  const toolbar = document.createElement("div");
  toolbar.className = "admin-toolbar";

  const searchBox = document.createElement("div");
  searchBox.className = "admin-toolbar-search";
  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.id = "adminCustomerVerifSearch";
  searchInput.className = "admin-search-input";
  searchInput.placeholder = "Search by name, email, or ID...";
  searchBox.appendChild(searchInput);

  const filtersBox = document.createElement("div");
  filtersBox.className = "admin-toolbar-filters";

  const statusSelect = document.createElement("select");
  statusSelect.id = "adminCustomerVerifStatusFilter";
  statusSelect.className = "admin-select-input";
  const statusOptions = [
    { val: "all", label: "All Verification Statuses" },
    ...VERIFICATION_STATUSES.map((s) => ({ val: s, label: formatVerificationStatusLabel(s) }))
  ];
  for (const opt of statusOptions) {
    const o = document.createElement("option");
    o.value = opt.val;
    o.textContent = opt.label;
    statusSelect.appendChild(o);
  }

  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "admin-btn-subtle";
  resetBtn.textContent = "Reset";

  filtersBox.append(statusSelect, resetBtn);
  toolbar.append(searchBox, filtersBox);
  container.appendChild(toolbar);

  const tableWrap = document.createElement("div");
  tableWrap.className = "admin-table-container";
  container.appendChild(tableWrap);

  const openCustomerReviewModal = (customer) => {
    const cv = normalizeCustomerVerification(customer);
    const uid = customer.uid || customer.id;
    const modalContent = document.createElement("div");
    modalContent.className = "admin-verification-modal-body";

    const grid = document.createElement("div");
    grid.className = "admin-detail-grid";

    const badgePreview = cv.status === "Verified"
      ? createVerifiedCustomerBadge({ fullName: true })
      : "No badge displayed (Not Verified)";

    grid.append(
      createDetailRow("Customer ID", uid, true),
      createDetailRow("Full Name", customer.name || "Customer"),
      createDetailRow("Badge Preview", badgePreview),
      createDetailRow("Email", customer.email || "Not provided"),
      createDetailRow("Email Confirmed", customer.emailVerified ? "Yes (Confirmed)" : "No (Unconfirmed)"),
      createDetailRow("Phone", customer.phone || "Not provided"),
      createDetailRow("District", customer.district || "—"),
      createDetailRow("Account Status", customer.status === "suspended" ? "Suspended" : "Active"),
      createDetailRow("Verification", formatVerificationStatusLabel(cv.status)),
      createDetailRow("Joined Date", formatDateTime(customer.createdAt)),
      createDetailRow("Verified On", cv.verifiedAt ? formatDateTime(cv.verifiedAt) : "—"),
      createDetailRow("Verified By (Admin ID)", cv.verifiedBy || "—")
    );

    if (cv.rejectionReason) {
      grid.appendChild(createDetailRow("Reason for Declining (Staff Only)", cv.rejectionReason, true));
    }

    // Internal note editor
    const noteSection = document.createElement("div");
    noteSection.className = "admin-detail-item full-width";
    const noteLbl = document.createElement("label");
    noteLbl.className = "admin-detail-label";
    noteLbl.htmlFor = "adminCustVerifInternalNote";
    noteLbl.textContent = "Staff Notes (Private — not visible to customers)";
    const noteArea = document.createElement("textarea");
    noteArea.id = "adminCustVerifInternalNote";
    noteArea.className = "admin-textarea";
    noteArea.rows = 3;
    noteArea.maxLength = 500;
    noteArea.placeholder = "Write review notes for your team...";
    noteArea.value = cv.internalNote || "";
    noteSection.append(noteLbl, noteArea);
    grid.appendChild(noteSection);

    // Action bar inside detail modal
    const actionsRow = document.createElement("div");
    actionsRow.className = "admin-detail-item full-width";
    const actionsLabel = document.createElement("div");
    actionsLabel.className = "admin-detail-label";
    actionsLabel.textContent = "Review Actions";
    const btns = document.createElement("div");
    btns.className = "admin-table-actions";
    btns.style.marginTop = "8px";

    const runUpdate = async (newStatus, extra = {}) => {
      const res = await updateAdminCustomerVerification(uid, newStatus, currentAdmin.uid, {
        internalNote: noteArea.value.trim(),
        ...extra
      });
      if (res.success) {
        customer.customerVerification = res.customerVerification;
        customer.isVerified = newStatus === "Verified";
        showToast(`Customer verification updated to ${formatVerificationStatusLabel(newStatus)}.`);
        const modalBackdrop = document.getElementById("adminActionModal");
        if (modalBackdrop) modalBackdrop.hidden = true;
        renderMetrics();
        renderTable();
      } else {
        showToast(res.error || "Failed to update customer verification.");
      }
    };

    if (cv.status !== "Verified") {
      const approveBtn = document.createElement("button");
      approveBtn.type = "button";
      approveBtn.className = "admin-table-btn approve";
      approveBtn.textContent = "✓ Approve & Give Badge";
      approveBtn.onclick = () => {
        showConfirmModal({
          title: `Approve Customer: ${customer.name || "Customer"}`,
          body: `Give the official JKFixHub Verified Customer badge to ${customer.name || uid}? This will display the badge on their profile, reviews, requests, and chat.`,
          confirmText: "Approve Customer",
          onConfirm: () => runUpdate("Verified")
        });
      };
      btns.appendChild(approveBtn);
    }

    if (cv.status !== "Pending" && cv.status !== "Verified") {
      const pendBtn = document.createElement("button");
      pendBtn.type = "button";
      pendBtn.className = "admin-table-btn";
      pendBtn.textContent = "Mark Waiting for Review";
      pendBtn.onclick = () => runUpdate("Pending");
      btns.appendChild(pendBtn);
    }

    if (cv.status !== "Rejected" && cv.status !== "Verified") {
      const rejectBtn = document.createElement("button");
      rejectBtn.type = "button";
      rejectBtn.className = "admin-table-btn suspend";
      rejectBtn.textContent = "✕ Decline";
      rejectBtn.onclick = () => {
        showReasonConfirmModal({
          title: `Decline Customer Verification: ${customer.name || "Customer"}`,
          description: "Provide an internal reason for declining verification. This is saved in the record history.",
          reasonLabel: "Reason for Declining (required)",
          placeholder: "e.g., Incomplete profile information or unverified contact details...",
          required: true,
          confirmText: "Decline Verification",
          onConfirm: (reason) => runUpdate("Rejected", { rejectionReason: reason })
        });
      };
      btns.appendChild(rejectBtn);
    }

    if (cv.status === "Verified") {
      const revokeBtn = document.createElement("button");
      revokeBtn.type = "button";
      revokeBtn.className = "admin-table-btn suspend";
      revokeBtn.textContent = "⊘ Remove Badge";
      revokeBtn.onclick = () => {
        showReasonConfirmModal({
          title: `Remove Verified Customer Badge: ${customer.name || "Customer"}`,
          description: "Removing this badge takes it away immediately from the customer's profile, reviews, and requests across the website.",
          reasonLabel: "Reason for Removal (optional)",
          placeholder: "e.g., Account review or policy concern...",
          required: false,
          confirmText: "Remove Badge",
          onConfirm: (reason) => runUpdate("Revoked", { internalNote: reason || noteArea.value.trim() })
        });
      };
      btns.appendChild(revokeBtn);
    }

    const saveNoteBtn = document.createElement("button");
    saveNoteBtn.type = "button";
    saveNoteBtn.className = "admin-table-btn";
    saveNoteBtn.textContent = "Save Note";
    saveNoteBtn.onclick = () => runUpdate(cv.status);
    btns.appendChild(saveNoteBtn);

    actionsRow.append(actionsLabel, btns);
    grid.appendChild(actionsRow);

    // History timeline
    const histWrap = document.createElement("div");
    histWrap.className = "admin-detail-item full-width";
    const histLbl = document.createElement("div");
    histLbl.className = "admin-detail-label";
    histLbl.textContent = `Review History (${Array.isArray(cv.history) ? cv.history.length : 0})`;
    histWrap.append(histLbl, buildHistoryTimeline(cv.history, formatDateTime));
    grid.appendChild(histWrap);

    modalContent.appendChild(grid);

    showDetailModal({
      title: `Customer Verification: ${customer.name || "Customer"}`,
      contentNode: modalContent,
      isWide: true
    });
  };

  const renderTable = () => {
    tableWrap.replaceChildren();
    const q = filterState.query.trim().toLowerCase();
    const stFilter = filterState.status;

    const filtered = customers.filter((c) => {
      const cv = normalizeCustomerVerification(c);
      if (stFilter !== "all" && cv.status !== stFilter) return false;
      if (q) {
        const hay = [c.name, c.email, c.uid, c.id, c.district].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "admin-empty-state";
      const h3 = document.createElement("h3");
      h3.textContent = "No customers match this filter";
      const sub = document.createElement("p");
      sub.textContent = "Try adjusting the verification status filter or search query.";
      empty.append(h3, sub);
      tableWrap.appendChild(empty);
      return;
    }

    const table = document.createElement("table");
    table.className = "admin-table";
    const thead = document.createElement("thead");
    const hr = document.createElement("tr");
    ["Customer", "Contact Details", "District", "Verification", "Last Updated", "Admin Notes", "Actions"].forEach((txt) => {
      const th = document.createElement("th");
      th.textContent = txt;
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const c of filtered) {
      const cv = normalizeCustomerVerification(c);
      const uid = c.uid || c.id;
      const tr = document.createElement("tr");

      const tdName = document.createElement("td");
      const nameWrap = document.createElement("div");
      nameWrap.className = "admin-identity-cell";
      const nameStrong = document.createElement("strong");
      nameStrong.textContent = c.name || "Customer";
      nameWrap.appendChild(nameStrong);
      if (cv.status === "Verified") {
        nameWrap.appendChild(createVerifiedCustomerBadge({ compact: true }));
      }
      const uidSmall = document.createElement("div");
      uidSmall.className = "admin-cell-sub";
      uidSmall.textContent = uid;
      tdName.append(nameWrap, uidSmall);
      tr.appendChild(tdName);

      const tdContact = document.createElement("td");
      tdContact.textContent = [c.email, c.phone].filter(Boolean).join(" · ") || "—";
      tr.appendChild(tdContact);

      const tdDist = document.createElement("td");
      tdDist.textContent = c.district || "—";
      tr.appendChild(tdDist);

      const tdStatus = document.createElement("td");
      const pill = document.createElement("span");
      pill.className = `admin-status-pill ${statusToPillClass(cv.status)}`;
      pill.textContent = formatVerificationStatusLabel(cv.status);
      tdStatus.appendChild(pill);
      tr.appendChild(tdStatus);

      const tdDate = document.createElement("td");
      tdDate.textContent = cv.updatedAt ? formatDateOnly(cv.updatedAt) : formatDateOnly(c.createdAt);
      tr.appendChild(tdDate);

      const tdNote = document.createElement("td");
      const noteText = cv.rejectionReason || cv.internalNote || "—";
      tdNote.textContent = noteText.length > 36 ? `${noteText.slice(0, 36)}…` : noteText;
      tdNote.title = noteText;
      tr.appendChild(tdNote);

      const tdActions = document.createElement("td");
      const actBox = document.createElement("div");
      actBox.className = "admin-table-actions";

      const reviewBtn = document.createElement("button");
      reviewBtn.type = "button";
      reviewBtn.className = "admin-table-btn";
      reviewBtn.textContent = "View Details";
      reviewBtn.onclick = () => openCustomerReviewModal(c);
      actBox.appendChild(reviewBtn);

      if (cv.status !== "Verified") {
        const quickApprove = document.createElement("button");
        quickApprove.type = "button";
        quickApprove.className = "admin-table-btn approve";
        quickApprove.textContent = "Approve";
        quickApprove.onclick = () => {
          showConfirmModal({
            title: `Approve Customer: ${c.name || "Customer"}`,
            body: `Verify ${c.name || uid} and give them the JKFixHub Verified Customer badge?`,
            confirmText: "Approve Customer",
            onConfirm: async () => {
              const res = await updateAdminCustomerVerification(uid, "Verified", currentAdmin.uid, {
                internalNote: "Approved via Customer Verification queue"
              });
              if (res.success) {
                c.customerVerification = res.customerVerification;
                c.isVerified = true;
                showToast(`${c.name || "Customer"} approved.`);
                renderMetrics();
                renderTable();
              } else {
                showToast(res.error || "Failed to verify customer.");
              }
            }
          });
        };
        actBox.appendChild(quickApprove);
      } else {
        const quickRevoke = document.createElement("button");
        quickRevoke.type = "button";
        quickRevoke.className = "admin-table-btn suspend";
        quickRevoke.textContent = "Remove Badge";
        quickRevoke.onclick = () => {
          showReasonConfirmModal({
            title: `Remove Customer Badge: ${c.name || "Customer"}`,
            description: "Removing the badge takes it away immediately across the website.",
            reasonLabel: "Reason (saved in history)",
            placeholder: "Optional staff reason...",
            required: false,
            confirmText: "Remove Badge",
            onConfirm: async (reason) => {
              const res = await updateAdminCustomerVerification(uid, "Revoked", currentAdmin.uid, {
                internalNote: reason || "Revoked via Customer Verification queue"
              });
              if (res.success) {
                c.customerVerification = res.customerVerification;
                c.isVerified = false;
                showToast(`Verified Customer badge removed for ${c.name || uid}.`);
                renderMetrics();
                renderTable();
              } else {
                showToast(res.error || "Failed to revoke badge.");
              }
            }
          });
        };
        actBox.appendChild(quickRevoke);
      }

      tdActions.appendChild(actBox);
      tr.appendChild(tdActions);
      tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    applyResponsiveTableLabels(table);
    tableWrap.appendChild(table);
  };

  searchInput.addEventListener("input", (e) => {
    filterState.query = e.target.value;
    renderTable();
  });
  statusSelect.addEventListener("change", (e) => {
    filterState.status = e.target.value;
    renderTable();
  });
  resetBtn.addEventListener("click", () => {
    filterState.query = "";
    filterState.status = "all";
    searchInput.value = "";
    statusSelect.value = "all";
    renderTable();
  });

  renderMetrics();
  renderTable();
}

// ----------------------------------------------------------------------------
// SECTION B: Verification & Badges (Unified Customer & Worker Badge Center)
// ----------------------------------------------------------------------------
export async function renderVerificationBadgesView(container, ctx) {
  const {
    currentAdmin,
    showToast,
    showReasonConfirmModal,
    showDetailModal,
    formatDateTime,
    formatDateOnly,
    applyResponsiveTableLabels
  } = ctx;

  const [customers, workers] = await Promise.all([
    getAdminCustomers(),
    getAdminWorkers()
  ]);
  container.replaceChildren();

  const buildRecords = () => {
    const list = [];
    for (const c of customers) {
      const cv = normalizeCustomerVerification(c);
      const trust = resolveAccountTrustAndMembership(c, "customer");
      list.push({
        uid: c.uid || c.id,
        role: "customer",
        name: c.name || "Customer",
        email: c.email || null,
        phone: c.phone || null,
        district: c.district || null,
        service: null,
        accountStatus: c.status || "active",
        verificationStatus: cv.status,
        isVerified: isCustomerOfficiallyVerified(c),
        verifiedAt: cv.verifiedAt,
        verifiedBy: cv.verifiedBy,
        updatedAt: cv.updatedAt,
        internalNote: cv.internalNote || "",
        history: Array.isArray(cv.history) ? cv.history : [],
        trust,
        raw: c
      });
    }
    for (const w of workers) {
      const wv = normalizeWorkerVerification(w);
      const trust = resolveAccountTrustAndMembership(w, "worker");
      list.push({
        uid: w.uid || w.id,
        role: "worker",
        name: w.name || "Worker",
        email: w.email || null,
        phone: w.phone || null,
        district: w.district || null,
        service: w.service || null,
        accountStatus: w.status || "pending",
        verificationStatus: wv.status,
        isVerified: isWorkerOfficiallyVerified(w),
        verifiedAt: wv.verifiedAt,
        verifiedBy: wv.verifiedBy,
        updatedAt: wv.updatedAt,
        internalNote: wv.internalNote || w.adminNotes || "",
        history: Array.isArray(wv.history) ? wv.history : [],
        trust,
        raw: w
      });
    }
    return list;
  };

  let records = buildRecords();
  const filterState = {
    query: "",
    role: "all",
    status: "all"
  };

  // Header
  const header = document.createElement("div");
  header.className = "admin-view-header";
  const titleBox = document.createElement("div");
  titleBox.className = "admin-view-title";
  const h2 = document.createElement("h2");
  h2.textContent = "Verification & Badges";
  const p = document.createElement("p");
  p.textContent = "Manage trust badges for customers and service workers with an automatic record of all changes.";
  titleBox.append(h2, p);
  header.appendChild(titleBox);
  container.appendChild(header);

  // Badge Legend & Future Pro Separation Card
  const legendCard = document.createElement("div");
  legendCard.className = "admin-badge-legend-card";

  const legendCol1 = document.createElement("div");
  legendCol1.className = "admin-badge-legend-col";
  const l1Title = document.createElement("strong");
  l1Title.textContent = "Official Verification Badges";
  const badgeShowcase = document.createElement("div");
  badgeShowcase.className = "admin-badge-showcase";
  badgeShowcase.append(
    createVerifiedCustomerBadge({ fullName: true }),
    createVerifiedWorkerBadge({ fullName: true })
  );
  const l1Desc = document.createElement("p");
  l1Desc.className = "admin-muted-copy";
  l1Desc.textContent = "Badges are granted and removed only by platform administrators. Accounts that are waiting or not verified never show a badge.";
  legendCol1.append(l1Title, badgeShowcase, l1Desc);

  const legendCol2 = document.createElement("div");
  legendCol2.className = "admin-badge-legend-col";
  const l2Title = document.createElement("strong");
  l2Title.textContent = "Future Pro Membership (Separate from Verification)";
  const l2Desc = document.createElement("p");
  l2Desc.className = "admin-muted-copy";
  l2Desc.textContent = "Verification is based strictly on quality and identity checks. Future paid plans or subscriptions will never buy a verification badge or alter search rankings.";
  legendCol2.append(l2Title, l2Desc);

  legendCard.append(legendCol1, legendCol2);
  container.appendChild(legendCard);

  // Toolbar
  const toolbar = document.createElement("div");
  toolbar.className = "admin-toolbar";

  const searchBox = document.createElement("div");
  searchBox.className = "admin-toolbar-search";
  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.id = "adminBadgesSearch";
  searchInput.className = "admin-search-input";
  searchInput.placeholder = "Search by name, email, ID, district, or service...";
  searchBox.appendChild(searchInput);

  const filtersBox = document.createElement("div");
  filtersBox.className = "admin-toolbar-filters";

  const roleSelect = document.createElement("select");
  roleSelect.id = "adminBadgesRoleFilter";
  roleSelect.className = "admin-select-input";
  [
    { val: "all", label: "All Roles" },
    { val: "customer", label: "Customers" },
    { val: "worker", label: "Workers" }
  ].forEach((opt) => {
    const o = document.createElement("option");
    o.value = opt.val;
    o.textContent = opt.label;
    roleSelect.appendChild(o);
  });

  const statusSelect = document.createElement("select");
  statusSelect.id = "adminBadgesStatusFilter";
  statusSelect.className = "admin-select-input";
  [
    { val: "all", label: "All Verification Statuses" },
    ...VERIFICATION_STATUSES.map((s) => ({
      val: s,
      label: s === "Verified" ? "Verified (Badge Active)" : formatVerificationStatusLabel(s)
    }))
  ].forEach((opt) => {
    const o = document.createElement("option");
    o.value = opt.val;
    o.textContent = opt.label;
    statusSelect.appendChild(o);
  });

  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "admin-btn-subtle";
  resetBtn.textContent = "Reset";

  // Admin-only safe, idempotent, dry-run-first backfill button for pre-existing verified workers
  const backfillBtn = document.createElement("button");
  backfillBtn.type = "button";
  backfillBtn.id = "adminBackfillWorkerBadgesBtn";
  backfillBtn.className = "admin-btn-subtle";
  backfillBtn.textContent = "Update Existing Accounts";
  backfillBtn.title = "Check and update badge records for already-approved workers";
  backfillBtn.onclick = async () => {
    backfillBtn.disabled = true;
    try {
      const preview = await backfillAdminVerifiedWorkerBadges(currentAdmin.uid, { dryRun: true });
      if (!preview.success) {
        showToast(preview.error || "Update preview failed.");
        return;
      }
      const totalChanges =
        preview.badgesToCreate.length +
        preview.workerMetaToBackfill.length +
        preview.staleBadgesToDelete.length +
        preview.staleFlagsToRepair.length;
      if (totalChanges === 0) {
        showToast(`All ${preview.totalWorkersScanned} worker accounts are already up to date.`);
        return;
      }
      ctx.showConfirmModal({
        title: "Confirm Badge Update for Existing Workers",
        body: `Checked ${preview.totalWorkersScanned} worker accounts: ${preview.badgesToCreate.length} badge(s) to add, ${preview.workerMetaToBackfill.length} record(s) to update, and ${preview.staleBadgesToDelete.length} outdated badge(s) to clean up. Do you want to proceed?`,
        confirmText: "Update Accounts",
        onConfirm: async () => {
          const exec = await backfillAdminVerifiedWorkerBadges(currentAdmin.uid, { dryRun: false });
          if (exec.success) {
            showToast(`Done: ${exec.badgesToCreate.length} badge(s) added, ${exec.staleBadgesToDelete.length} outdated badge(s) cleaned up.`);
            await renderVerificationBadgesView(container, ctx);
          } else {
            showToast(exec.error || "Could not complete account update.");
          }
        }
      });
    } finally {
      backfillBtn.disabled = false;
    }
  };

  filtersBox.append(roleSelect, statusSelect, resetBtn, backfillBtn);
  toolbar.append(searchBox, filtersBox);
  container.appendChild(toolbar);

  const tableWrap = document.createElement("div");
  tableWrap.className = "admin-table-container";
  container.appendChild(tableWrap);

  const applyGrantOrRevoke = async (rec, targetStatus, note) => {
    if (rec.role === "customer") {
      const res = await updateAdminCustomerVerification(rec.uid, targetStatus, currentAdmin.uid, {
        internalNote: note
      });
      if (res.success) {
        rec.raw.customerVerification = res.customerVerification;
        rec.raw.isVerified = targetStatus === "Verified";
        records = buildRecords();
        showToast(
          targetStatus === "Verified"
            ? `Granted JKFixHub Verified Customer badge to ${rec.name}.`
            : `Removed Verified Customer badge for ${rec.name}.`
        );
        renderTable();
      } else {
        showToast(res.error || "Failed to update customer badge.");
      }
    } else {
      const res = await updateAdminWorkerVerification(rec.uid, targetStatus, currentAdmin.uid, {
        internalNote: note
      });
      if (res.success) {
        rec.raw.workerVerification = res.workerVerification;
        rec.raw.isVerified = res.isVerified;
        if (targetStatus === "Verified" && (!rec.raw.status || rec.raw.status === "pending")) {
          rec.raw.status = "active";
        }
        records = buildRecords();
        showToast(
          targetStatus === "Verified"
            ? `Granted JKFixHub Verified Professional badge to ${rec.name}.`
            : `Removed Verified Professional badge for ${rec.name}.`
        );
        renderTable();
      } else {
        showToast(res.error || "Failed to update worker badge.");
      }
    }
  };

  const openBadgeInspectModal = (rec) => {
    const modalContent = document.createElement("div");
    const grid = document.createElement("div");
    grid.className = "admin-detail-grid";

    const badgeNode = rec.isVerified
      ? (rec.role === "customer"
        ? createVerifiedCustomerBadge({ fullName: true })
        : createVerifiedWorkerBadge({ fullName: true }))
      : "None (Not Verified)";

    grid.append(
      createDetailRow("Account ID", rec.uid, true),
      createDetailRow("Full Name", rec.name),
      createDetailRow("Account Role", rec.role === "customer" ? "Customer" : "Service Worker"),
      createDetailRow("Current Badge", badgeNode),
      createDetailRow("Verification", formatVerificationStatusLabel(rec.verificationStatus)),
      createDetailRow("Contact Details", [rec.email, rec.phone].filter(Boolean).join(" · ") || "—"),
      createDetailRow("District", rec.district || "—"),
      createDetailRow("Membership Tier (Separate Pro)", `${rec.trust.membership.tier} (${rec.trust.membership.status})`),
      createDetailRow("Promotional Placement", rec.trust.promotionalPlacement.enabled ? "Active" : "Standard (Organic search)"),
      createDetailRow("Verified On", rec.verifiedAt ? formatDateTime(rec.verifiedAt) : "—"),
      createDetailRow("Verified By (Admin ID)", rec.verifiedBy || "—"),
      createDetailRow("Staff Notes", rec.internalNote || "—", true)
    );

    const histWrap = document.createElement("div");
    histWrap.className = "admin-detail-item full-width";
    const histLbl = document.createElement("div");
    histLbl.className = "admin-detail-label";
    histLbl.textContent = `Badge History (${rec.history.length})`;
    histWrap.append(histLbl, buildHistoryTimeline(rec.history, formatDateTime));
    grid.appendChild(histWrap);

    modalContent.appendChild(grid);
    showDetailModal({
      title: `Account Badge Details: ${rec.name}`,
      contentNode: modalContent,
      isWide: true
    });
  };

  const renderTable = () => {
    tableWrap.replaceChildren();
    const q = filterState.query.trim().toLowerCase();

    const filtered = records.filter((r) => {
      if (filterState.role !== "all" && r.role !== filterState.role) return false;
      if (filterState.status !== "all" && r.verificationStatus !== filterState.status) return false;
      if (q) {
        const hay = [r.name, r.email, r.uid, r.district, r.service, r.role].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "admin-empty-state";
      const h3 = document.createElement("h3");
      h3.textContent = "No accounts match this filter";
      const sub = document.createElement("p");
      sub.textContent = "Adjust the role, badge status, or search query to inspect accounts.";
      empty.append(h3, sub);
      tableWrap.appendChild(empty);
      return;
    }

    const table = document.createElement("table");
    table.className = "admin-table";
    const thead = document.createElement("thead");
    const hr = document.createElement("tr");
    ["Account & Badge", "Role", "District & Service", "Verification", "Last Updated", "Actions"].forEach((txt) => {
      const th = document.createElement("th");
      th.textContent = txt;
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const rec of filtered) {
      const tr = document.createElement("tr");

      const tdAcc = document.createElement("td");
      const wrap = document.createElement("div");
      wrap.className = "admin-identity-cell";
      const nm = document.createElement("strong");
      nm.textContent = rec.name;
      wrap.appendChild(nm);
      if (rec.isVerified) {
        wrap.appendChild(
          rec.role === "customer"
            ? createVerifiedCustomerBadge({ compact: true })
            : createVerifiedWorkerBadge({ compact: true })
        );
      }
      const sub = document.createElement("div");
      sub.className = "admin-cell-sub";
      sub.textContent = [rec.email, rec.uid].filter(Boolean).join(" · ");
      tdAcc.append(wrap, sub);
      tr.appendChild(tdAcc);

      const tdRole = document.createElement("td");
      tdRole.textContent = rec.role === "customer" ? "Customer" : "Worker";
      tr.appendChild(tdRole);

      const tdMeta = document.createElement("td");
      tdMeta.textContent = [rec.district, rec.service].filter(Boolean).join(" · ") || "—";
      tr.appendChild(tdMeta);

      const tdStatus = document.createElement("td");
      const pill = document.createElement("span");
      pill.className = `admin-status-pill ${statusToPillClass(rec.verificationStatus)}`;
      pill.textContent = formatVerificationStatusLabel(rec.verificationStatus);
      tdStatus.appendChild(pill);
      tr.appendChild(tdStatus);

      const tdLast = document.createElement("td");
      const lastEntry = rec.history.length > 0 ? rec.history[rec.history.length - 1] : null;
      tdLast.textContent = lastEntry
        ? `${formatDateOnly(lastEntry.actionAt)} (${lastEntry.actionBy || "admin"})`
        : (rec.verifiedAt ? formatDateOnly(rec.verifiedAt) : "—");
      tr.appendChild(tdLast);

      const tdActions = document.createElement("td");
      const box = document.createElement("div");
      box.className = "admin-table-actions";

      const inspectBtn = document.createElement("button");
      inspectBtn.type = "button";
      inspectBtn.className = "admin-table-btn";
      inspectBtn.textContent = "View Details";
      inspectBtn.onclick = () => openBadgeInspectModal(rec);
      box.appendChild(inspectBtn);

      const badgeLabel = rec.role === "customer"
        ? "Verified Customer"
        : "Verified Professional";

      if (!rec.isVerified) {
        const grantBtn = document.createElement("button");
        grantBtn.type = "button";
        grantBtn.className = "admin-table-btn approve";
        grantBtn.textContent = "Give Badge";
        grantBtn.onclick = () => {
          showReasonConfirmModal({
            title: `Give ${badgeLabel} Badge`,
            description: `Give the official ${badgeLabel} badge to ${rec.name} (${rec.uid})? This badge will appear on their public profile, reviews, and service listings.`,
            reasonLabel: "Staff Note (optional)",
            placeholder: "e.g., Profile review completed...",
            required: false,
            confirmText: "Give Badge",
            onConfirm: (note) => applyGrantOrRevoke(rec, "Verified", note || "Granted via Verification & Badges")
          });
        };
        box.appendChild(grantBtn);
      } else {
        const revokeBtn = document.createElement("button");
        revokeBtn.type = "button";
        revokeBtn.className = "admin-table-btn suspend";
        revokeBtn.textContent = "Remove Badge";
        revokeBtn.onclick = () => {
          showReasonConfirmModal({
            title: `Remove ${badgeLabel} Badge`,
            description: `Remove the ${badgeLabel} badge from ${rec.name} (${rec.uid})? The badge will immediately disappear across the entire website.`,
            reasonLabel: "Reason for removal (optional)",
            placeholder: "e.g., Account review or policy issue...",
            required: false,
            confirmText: "Remove Badge",
            onConfirm: (note) => applyGrantOrRevoke(rec, "Revoked", note || "Revoked via Verification & Badges")
          });
        };
        box.appendChild(revokeBtn);
      }

      tdActions.appendChild(box);
      tr.appendChild(tdActions);
      tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    applyResponsiveTableLabels(table);
    tableWrap.appendChild(table);
  };

  searchInput.addEventListener("input", (e) => {
    filterState.query = e.target.value;
    renderTable();
  });
  roleSelect.addEventListener("change", (e) => {
    filterState.role = e.target.value;
    renderTable();
  });
  statusSelect.addEventListener("change", (e) => {
    filterState.status = e.target.value;
    renderTable();
  });
  resetBtn.addEventListener("click", () => {
    filterState.query = "";
    filterState.role = "all";
    filterState.status = "all";
    searchInput.value = "";
    roleSelect.value = "all";
    statusSelect.value = "all";
    renderTable();
  });

  renderTable();
}
