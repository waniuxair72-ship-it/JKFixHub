// ==========================================
// #ADMIN_PLATFORM_VIEWS
// ==========================================
// Modular Platform Control Centre views for [JK] FixHub Admin Panel:
// 1. Platform Controls (Maintenance, Registrations, Request Pause, Availability Summary)
// 2. Announcements System (CRUD, Publish/Pause/Archive, Audience, Priority, Expiry)
// 3. Services & Districts Management (Add/Edit/Toggle with Historical Preservation)
// 4. Live Analytics Dashboard (Real Firestore Aggregation, Charts & Breakdowns)
//
// Security:
// - Pure DOM construction (createElement + textContent); zero innerHTML injection.
// - All mutations verified through authoritative admin Firestore & Cloud Functions layer.
// - Every operational change prompts confirmation and writes an immutable /auditLogs entry.
// ==========================================

import {
  getAdminPlatformConfig,
  updateAdminPlatformConfig,
  getAdminAnnouncements,
  createAdminAnnouncement,
  updateAdminAnnouncement,
  updateAdminAnnouncementStatus,
  getAdminAnalyticsData,
  getAdminRequests,
  getAdminWorkers
} from "./firestore-service.js";
import {
  slugifyId,
  isMaintenanceCurrentlyActive
} from "./platform-config.js";

function toDatetimeLocalValue(isoStr) {
  if (!isoStr) return "";
  try {
    const d = new Date(isoStr);
    if (Number.isNaN(d.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return "";
  }
}

function fromDatetimeLocalValue(localVal) {
  if (!localVal || !String(localVal).trim()) return null;
  const d = new Date(localVal);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function createStatusPill(text, toneClass) {
  const pill = document.createElement("span");
  pill.className = `admin-status-pill ${toneClass}`;
  pill.textContent = text;
  return pill;
}

// ============================================================================
// 1. PLATFORM CONTROLS VIEW
// ============================================================================
export async function renderPlatformControlsView(container, ctx) {
  const { currentAdmin, showToast, showConfirmModal, formatDateTime, navigateToTab, updateTopbarMaintenanceBadge } = ctx;

  let config;
  try {
    config = await getAdminPlatformConfig();
  } catch (err) {
    container.replaceChildren();
    const errBox = document.createElement("div");
    errBox.className = "admin-error-state";
    const h3 = document.createElement("h3");
    h3.textContent = "Unable to Load Platform Controls";
    const p = document.createElement("p");
    p.textContent = err?.message || "Could not connect to Firestore configuration.";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "admin-btn-primary";
    retry.textContent = "Retry";
    retry.onclick = () => renderPlatformControlsView(container, ctx);
    errBox.append(h3, p, retry);
    container.appendChild(errBox);
    return;
  }

  container.replaceChildren();
  if (typeof updateTopbarMaintenanceBadge === "function") {
    updateTopbarMaintenanceBadge(config);
  }

  // Header
  const header = document.createElement("div");
  header.className = "admin-view-header";
  const titleBox = document.createElement("div");
  titleBox.className = "admin-view-title";
  const h2 = document.createElement("h2");
  h2.textContent = "Platform Control Centre";
  const sub = document.createElement("p");
  sub.textContent = "Real-time operational switches for maintenance mode, account registrations, new service requests, and availability. Every change is audited.";
  titleBox.append(h2, sub);
  header.appendChild(titleBox);
  container.appendChild(header);

  const grid = document.createElement("div");
  grid.className = "admin-controls-grid";

  // ------------------------------------------------------------------
  // A. MAINTENANCE MODE CARD
  // ------------------------------------------------------------------
  const maintCard = document.createElement("section");
  maintCard.className = "admin-control-card full-span";
  maintCard.setAttribute("aria-label", "Maintenance Mode Controls");

  const maintActive = isMaintenanceCurrentlyActive(config);
  const maintHead = document.createElement("div");
  maintHead.className = "admin-control-card-head";
  const maintHeadText = document.createElement("div");
  const maintH3 = document.createElement("h3");
  maintH3.textContent = "Maintenance Mode";
  const maintDesc = document.createElement("p");
  maintDesc.textContent = "Display a platform-wide maintenance notice to customers and workers. Administrators keep full access, and essential account/support routes remain accessible.";
  maintHeadText.append(maintH3, maintDesc);
  const maintPill = createStatusPill(
    config.maintenanceMode ? (maintActive ? "Maintenance Active" : "Scheduled") : "Operational",
    config.maintenanceMode ? "suspended" : "active"
  );
  maintHead.append(maintHeadText, maintPill);
  maintCard.appendChild(maintHead);

  const maintForm = document.createElement("form");
  maintForm.noValidate = true;

  const msgGroup = document.createElement("div");
  msgGroup.className = "admin-form-group";
  const msgLabel = document.createElement("label");
  msgLabel.htmlFor = "ctrlMaintenanceMessage";
  msgLabel.textContent = "Public Maintenance Notice Message";
  const msgInput = document.createElement("textarea");
  msgInput.id = "ctrlMaintenanceMessage";
  msgInput.rows = 2;
  msgInput.maxLength = 600;
  msgInput.value = config.maintenanceMessage || "";
  msgInput.placeholder = "Explain the maintenance window clearly for users...";
  msgGroup.append(msgLabel, msgInput);

  const schedRow = document.createElement("div");
  schedRow.className = "admin-form-row";

  const startGroup = document.createElement("div");
  startGroup.className = "admin-form-group";
  const startLabel = document.createElement("label");
  startLabel.htmlFor = "ctrlMaintenanceStart";
  startLabel.textContent = "Scheduled Start (Optional)";
  const startInput = document.createElement("input");
  startInput.id = "ctrlMaintenanceStart";
  startInput.type = "datetime-local";
  startInput.value = toDatetimeLocalValue(config.maintenanceStart);
  startGroup.append(startLabel, startInput);

  const endGroup = document.createElement("div");
  endGroup.className = "admin-form-group";
  const endLabel = document.createElement("label");
  endLabel.htmlFor = "ctrlMaintenanceEnd";
  endLabel.textContent = "Scheduled End (Optional)";
  const endInput = document.createElement("input");
  endInput.id = "ctrlMaintenanceEnd";
  endInput.type = "datetime-local";
  endInput.value = toDatetimeLocalValue(config.maintenanceEnd);
  endGroup.append(endLabel, endInput);

  schedRow.append(startGroup, endGroup);

  const maintActions = document.createElement("div");
  maintActions.className = "admin-table-actions";

  const toggleMaintBtn = document.createElement("button");
  toggleMaintBtn.type = "button";
  toggleMaintBtn.className = config.maintenanceMode ? "admin-btn-primary" : "admin-btn-danger";
  toggleMaintBtn.textContent = config.maintenanceMode ? "Disable Maintenance Mode" : "Enable Maintenance Mode";
  toggleMaintBtn.onclick = () => {
    const nextState = !config.maintenanceMode;
    const message = msgInput.value.trim() || "JK FixHub is undergoing scheduled maintenance.";
    const startIso = fromDatetimeLocalValue(startInput.value);
    const endIso = fromDatetimeLocalValue(endInput.value);
    if (startIso && endIso && Date.parse(endIso) <= Date.parse(startIso)) {
      showToast("Scheduled end time must be after start time.");
      return;
    }
    showConfirmModal({
      title: nextState ? "Enable Maintenance Mode" : "Disable Maintenance Mode",
      body: nextState
        ? "Users will immediately see the maintenance banner across JK FixHub. Administrators will keep full access to the Admin Panel. Continue?"
        : "Turn off maintenance mode and remove the public maintenance notice?",
      confirmText: nextState ? "Enable Maintenance" : "Disable Maintenance",
      onConfirm: async () => {
        const res = await updateAdminPlatformConfig(
          {
            maintenanceMode: nextState,
            maintenanceMessage: message,
            maintenanceStart: startIso,
            maintenanceEnd: endIso
          },
          currentAdmin.uid,
          {
            actionType: nextState ? "MAINTENANCE_MODE_ENABLED" : "MAINTENANCE_MODE_DISABLED",
            summary: nextState ? "Enabled platform maintenance mode" : "Disabled platform maintenance mode"
          }
        );
        if (res.success) {
          showToast(nextState ? "Maintenance mode enabled." : "Maintenance mode disabled.");
          await renderPlatformControlsView(container, ctx);
        } else {
          showToast(res.error || "Failed to update maintenance mode.");
        }
      }
    });
  };

  const saveMaintMsgBtn = document.createElement("button");
  saveMaintMsgBtn.type = "button";
  saveMaintMsgBtn.className = "admin-btn-subtle";
  saveMaintMsgBtn.textContent = "Save Message & Schedule";
  saveMaintMsgBtn.onclick = () => {
    const message = msgInput.value.trim();
    if (!message) {
      showToast("Please enter a maintenance notice message.");
      return;
    }
    const startIso = fromDatetimeLocalValue(startInput.value);
    const endIso = fromDatetimeLocalValue(endInput.value);
    if (startIso && endIso && Date.parse(endIso) <= Date.parse(startIso)) {
      showToast("Scheduled end time must be after start time.");
      return;
    }
    showConfirmModal({
      title: "Update Maintenance Notice",
      body: "Save the updated maintenance notice message and optional schedule window?",
      confirmText: "Save Changes",
      onConfirm: async () => {
        const res = await updateAdminPlatformConfig(
          {
            maintenanceMessage: message,
            maintenanceStart: startIso,
            maintenanceEnd: endIso
          },
          currentAdmin.uid,
          {
            actionType: "MAINTENANCE_NOTICE_UPDATED",
            summary: "Updated maintenance message and schedule"
          }
        );
        if (res.success) {
          showToast("Maintenance notice updated.");
          await renderPlatformControlsView(container, ctx);
        } else {
          showToast(res.error || "Failed to save maintenance settings.");
        }
      }
    });
  };

  maintActions.append(toggleMaintBtn, saveMaintMsgBtn);
  maintForm.append(msgGroup, schedRow, maintActions);
  maintCard.appendChild(maintForm);

  const maintFooter = document.createElement("div");
  maintFooter.className = "admin-control-footer";
  const maintTs = document.createElement("span");
  maintTs.textContent = `Last updated: ${formatDateTime(config.updatedAt, "Default baseline")}`;
  maintFooter.appendChild(maintTs);
  maintCard.appendChild(maintFooter);
  grid.appendChild(maintCard);

  // ------------------------------------------------------------------
  // B. REGISTRATION CONTROLS CARD
  // ------------------------------------------------------------------
  const regCard = document.createElement("section");
  regCard.className = "admin-control-card";
  regCard.setAttribute("aria-label", "Registration Controls");

  const regHead = document.createElement("div");
  regHead.className = "admin-control-card-head";
  const regHeadText = document.createElement("div");
  const regH3 = document.createElement("h3");
  regH3.textContent = "Registration Controls";
  const regDesc = document.createElement("p");
  regDesc.textContent = "Independently pause or resume new Customer and Worker signups. Enforced in both the UI and Firestore Security Rules.";
  regHeadText.append(regH3, regDesc);
  regHead.appendChild(regHeadText);
  regCard.appendChild(regHead);

  // Customer Registration Row
  const custRegRow = document.createElement("div");
  custRegRow.className = "admin-control-row";
  const custInfo = document.createElement("div");
  custInfo.className = "admin-control-row-info";
  const custTitle = document.createElement("div");
  custTitle.className = "admin-control-row-title";
  custTitle.textContent = "Customer Registration";
  custTitle.appendChild(createStatusPill(config.customerRegistrationEnabled ? "Open" : "Paused", config.customerRegistrationEnabled ? "enabled" : "disabled"));
  const custDesc = document.createElement("div");
  custDesc.className = "admin-control-row-desc";
  custDesc.textContent = config.customerRegistrationEnabled
    ? "New customers can register accounts normally."
    : "Customer account creation is blocked with a clear notice; existing customers can still sign in.";
  custInfo.append(custTitle, custDesc);

  const custBtn = document.createElement("button");
  custBtn.type = "button";
  custBtn.className = config.customerRegistrationEnabled ? "admin-btn-danger" : "admin-btn-primary";
  custBtn.textContent = config.customerRegistrationEnabled ? "Pause Customer Signup" : "Resume Customer Signup";
  custBtn.onclick = () => {
    const nextVal = !config.customerRegistrationEnabled;
    showConfirmModal({
      title: nextVal ? "Resume Customer Registration" : "Pause Customer Registration",
      body: nextVal
        ? "Allow new customer accounts to register on JK FixHub?"
        : "Pause new customer registrations? Existing customer accounts will continue working normally.",
      confirmText: nextVal ? "Resume Registration" : "Pause Registration",
      onConfirm: async () => {
        const res = await updateAdminPlatformConfig(
          { customerRegistrationEnabled: nextVal },
          currentAdmin.uid,
          {
            actionType: nextVal ? "CUSTOMER_REGISTRATION_RESUMED" : "CUSTOMER_REGISTRATION_PAUSED",
            summary: nextVal ? "Resumed customer registration" : "Paused customer registration"
          }
        );
        if (res.success) {
          showToast(nextVal ? "Customer registration resumed." : "Customer registration paused.");
          await renderPlatformControlsView(container, ctx);
        } else {
          showToast(res.error || "Failed to update customer registration setting.");
        }
      }
    });
  };
  custRegRow.append(custInfo, custBtn);
  regCard.appendChild(custRegRow);

  // Worker Registration Row
  const wrkRegRow = document.createElement("div");
  wrkRegRow.className = "admin-control-row";
  const wrkInfo = document.createElement("div");
  wrkInfo.className = "admin-control-row-info";
  const wrkTitle = document.createElement("div");
  wrkTitle.className = "admin-control-row-title";
  wrkTitle.textContent = "Worker Registration";
  wrkTitle.appendChild(createStatusPill(config.workerRegistrationEnabled ? "Open" : "Paused", config.workerRegistrationEnabled ? "enabled" : "disabled"));
  const wrkDesc = document.createElement("div");
  wrkDesc.className = "admin-control-row-desc";
  wrkDesc.textContent = config.workerRegistrationEnabled
    ? "New skilled professionals can apply and await verification."
    : "New worker onboarding is blocked; existing verified workers remain active.";
  wrkInfo.append(wrkTitle, wrkDesc);

  const wrkBtn = document.createElement("button");
  wrkBtn.type = "button";
  wrkBtn.className = config.workerRegistrationEnabled ? "admin-btn-danger" : "admin-btn-primary";
  wrkBtn.textContent = config.workerRegistrationEnabled ? "Pause Worker Signup" : "Resume Worker Signup";
  wrkBtn.onclick = () => {
    const nextVal = !config.workerRegistrationEnabled;
    showConfirmModal({
      title: nextVal ? "Resume Worker Registration" : "Pause Worker Registration",
      body: nextVal
        ? "Allow new technicians and service workers to apply on JK FixHub?"
        : "Pause new worker registrations? Existing workers can continue managing jobs.",
      confirmText: nextVal ? "Resume Registration" : "Pause Registration",
      onConfirm: async () => {
        const res = await updateAdminPlatformConfig(
          { workerRegistrationEnabled: nextVal },
          currentAdmin.uid,
          {
            actionType: nextVal ? "WORKER_REGISTRATION_RESUMED" : "WORKER_REGISTRATION_PAUSED",
            summary: nextVal ? "Resumed worker registration" : "Paused worker registration"
          }
        );
        if (res.success) {
          showToast(nextVal ? "Worker registration resumed." : "Worker registration paused.");
          await renderPlatformControlsView(container, ctx);
        } else {
          showToast(res.error || "Failed to update worker registration setting.");
        }
      }
    });
  };
  wrkRegRow.append(wrkInfo, wrkBtn);
  regCard.appendChild(wrkRegRow);
  grid.appendChild(regCard);

  // ------------------------------------------------------------------
  // C. NEW SERVICE REQUEST CONTROLS CARD
  // ------------------------------------------------------------------
  const reqCtrlCard = document.createElement("section");
  reqCtrlCard.className = "admin-control-card";
  reqCtrlCard.setAttribute("aria-label", "Service Request Creation Controls");

  const reqHead = document.createElement("div");
  reqHead.className = "admin-control-card-head";
  const reqHeadText = document.createElement("div");
  const reqH3 = document.createElement("h3");
  reqH3.textContent = "New Service Requests";
  const reqDesc = document.createElement("p");
  reqDesc.textContent = "Pause or resume new customer service requests. Existing requests and active worker jobs remain fully accessible.";
  reqHeadText.append(reqH3, reqDesc);
  reqHead.append(
    reqHeadText,
    createStatusPill(config.newRequestsEnabled ? "Accepting Requests" : "Paused", config.newRequestsEnabled ? "enabled" : "disabled")
  );
  reqCtrlCard.appendChild(reqHead);

  const pauseMsgGroup = document.createElement("div");
  pauseMsgGroup.className = "admin-form-group";
  const pauseMsgLbl = document.createElement("label");
  pauseMsgLbl.htmlFor = "ctrlNewReqPauseMsg";
  pauseMsgLbl.textContent = "Explanation Shown When Requests Are Paused";
  const pauseMsgInput = document.createElement("textarea");
  pauseMsgInput.id = "ctrlNewReqPauseMsg";
  pauseMsgInput.rows = 2;
  pauseMsgInput.maxLength = 500;
  pauseMsgInput.value = config.newRequestsPauseMessage || "";
  pauseMsgGroup.append(pauseMsgLbl, pauseMsgInput);
  reqCtrlCard.appendChild(pauseMsgGroup);

  const reqBtnRow = document.createElement("div");
  reqBtnRow.className = "admin-table-actions";
  const toggleReqBtn = document.createElement("button");
  toggleReqBtn.type = "button";
  toggleReqBtn.className = config.newRequestsEnabled ? "admin-btn-danger" : "admin-btn-primary";
  toggleReqBtn.textContent = config.newRequestsEnabled ? "Pause New Requests" : "Resume New Requests";
  toggleReqBtn.onclick = () => {
    const nextVal = !config.newRequestsEnabled;
    const msg = pauseMsgInput.value.trim() || "New service requests are temporarily paused. Existing requests remain accessible.";
    showConfirmModal({
      title: nextVal ? "Resume New Service Requests" : "Pause New Service Requests",
      body: nextVal
        ? "Allow customers to submit new service requests again?"
        : "Temporarily pause new customer service requests? Existing requests and worker completions will continue unaffected.",
      confirmText: nextVal ? "Resume Requests" : "Pause Requests",
      onConfirm: async () => {
        const res = await updateAdminPlatformConfig(
          { newRequestsEnabled: nextVal, newRequestsPauseMessage: msg },
          currentAdmin.uid,
          {
            actionType: nextVal ? "NEW_REQUESTS_RESUMED" : "NEW_REQUESTS_PAUSED",
            summary: nextVal ? "Resumed new customer service requests" : "Paused new customer service requests"
          }
        );
        if (res.success) {
          showToast(nextVal ? "New service requests resumed." : "New service requests paused.");
          await renderPlatformControlsView(container, ctx);
        } else {
          showToast(res.error || "Failed to update request control.");
        }
      }
    });
  };
  reqBtnRow.appendChild(toggleReqBtn);
  reqCtrlCard.appendChild(reqBtnRow);
  grid.appendChild(reqCtrlCard);

  // ------------------------------------------------------------------
  // D. SERVICE & DISTRICT AVAILABILITY SUMMARY CARD
  // ------------------------------------------------------------------
  const availCard = document.createElement("section");
  availCard.className = "admin-control-card full-span";
  const availHead = document.createElement("div");
  availHead.className = "admin-control-card-head";
  const availText = document.createElement("div");
  const availH3 = document.createElement("h3");
  availH3.textContent = "Service & District Availability Overview";
  const availP = document.createElement("p");
  const enabledServicesCount = config.services.filter((s) => s.enabled !== false).length;
  const enabledDistrictsCount = config.districts.filter((d) => d.enabled !== false).length;
  availP.textContent = `${enabledServicesCount} of ${config.services.length} service categories active · ${enabledDistrictsCount} of ${config.districts.length} Jammu & Kashmir districts active.`;
  availText.append(availH3, availP);

  const manageTaxonomyBtn = document.createElement("button");
  manageTaxonomyBtn.type = "button";
  manageTaxonomyBtn.className = "admin-btn-primary";
  manageTaxonomyBtn.textContent = "Manage Services & Districts →";
  manageTaxonomyBtn.onclick = () => navigateToTab("services-districts");

  availHead.append(availText, manageTaxonomyBtn);
  availCard.appendChild(availHead);

  if (config.disabledServices.length > 0 || config.disabledDistricts.length > 0) {
    const disabledInfo = document.createElement("div");
    disabledInfo.className = "admin-tag-cloud";
    config.disabledServices.forEach((s) => {
      disabledInfo.appendChild(createStatusPill(`Service Disabled: ${s}`, "disabled"));
    });
    config.disabledDistricts.forEach((d) => {
      disabledInfo.appendChild(createStatusPill(`District Disabled: ${d}`, "disabled"));
    });
    availCard.appendChild(disabledInfo);
  }
  grid.appendChild(availCard);

  container.appendChild(grid);
}

// ============================================================================
// 2. ANNOUNCEMENTS MANAGEMENT VIEW
// ============================================================================
export async function renderAnnouncementsView(container, ctx) {
  const { currentAdmin, showToast, showConfirmModal, formatDateTime } = ctx;

  let announcements = [];
  try {
    announcements = await getAdminAnnouncements();
  } catch (err) {
    container.replaceChildren();
    const errBox = document.createElement("div");
    errBox.className = "admin-error-state";
    const h3 = document.createElement("h3");
    h3.textContent = "Failed to Load Announcements";
    const p = document.createElement("p");
    p.textContent = err?.message || "Check your connection and retry.";
    errBox.append(h3, p);
    container.appendChild(errBox);
    return;
  }

  container.replaceChildren();

  let statusFilter = "all";
  let audienceFilter = "all";
  let searchQuery = "";

  const openEditorModal = (existing = null) => {
    const isEdit = Boolean(existing);
    const modalBackdrop = document.getElementById("adminActionModal");
    const modalTitle = document.getElementById("adminModalTitle");
    const modalBody = document.getElementById("adminModalBody");
    const confirmBtn = document.getElementById("adminModalConfirm");
    const cancelBtn = document.getElementById("adminModalCancel");
    const closeBtn = document.getElementById("adminModalClose");
    const modalCard = modalBackdrop ? modalBackdrop.querySelector(".admin-modal") : null;
    if (!modalBackdrop || !modalTitle || !modalBody || !confirmBtn) return;

    if (modalCard) modalCard.classList.add("wide");
    modalTitle.textContent = isEdit ? "Edit Announcement" : "Create Platform Announcement";

    const form = document.createElement("div");

    // Title
    const gTitle = document.createElement("div");
    gTitle.className = "admin-form-group";
    const lTitle = document.createElement("label");
    lTitle.htmlFor = "annTitleInput";
    lTitle.textContent = "Announcement Title *";
    const iTitle = document.createElement("input");
    iTitle.id = "annTitleInput";
    iTitle.type = "text";
    iTitle.maxLength = 140;
    iTitle.placeholder = "e.g., Winter Heater Maintenance Advisory";
    iTitle.value = existing?.title || "";
    gTitle.append(lTitle, iTitle);

    // Message
    const gMsg = document.createElement("div");
    gMsg.className = "admin-form-group";
    const lMsg = document.createElement("label");
    lMsg.htmlFor = "annMessageInput";
    lMsg.textContent = "Message *";
    const iMsg = document.createElement("textarea");
    iMsg.id = "annMessageInput";
    iMsg.rows = 4;
    iMsg.maxLength = 2000;
    iMsg.placeholder = "Write a clear, helpful message for your selected audience...";
    iMsg.value = existing?.message || "";
    gMsg.append(lMsg, iMsg);

    // Row 1: Audience & Priority
    const row1 = document.createElement("div");
    row1.className = "admin-form-row";

    const gAud = document.createElement("div");
    gAud.className = "admin-form-group";
    const lAud = document.createElement("label");
    lAud.htmlFor = "annAudienceSelect";
    lAud.textContent = "Target Audience";
    const sAud = document.createElement("select");
    sAud.id = "annAudienceSelect";
    [
      { val: "everyone", label: "Everyone (Customers & Workers)" },
      { val: "customers", label: "Customers Only" },
      { val: "workers", label: "Workers Only" }
    ].forEach((o) => {
      const opt = document.createElement("option");
      opt.value = o.val;
      opt.textContent = o.label;
      opt.selected = (existing?.audience || "everyone") === o.val;
      sAud.appendChild(opt);
    });
    gAud.append(lAud, sAud);

    const gPri = document.createElement("div");
    gPri.className = "admin-form-group";
    const lPri = document.createElement("label");
    lPri.htmlFor = "annPrioritySelect";
    lPri.textContent = "Priority Level";
    const sPri = document.createElement("select");
    sPri.id = "annPrioritySelect";
    [
      { val: "normal", label: "Normal" },
      { val: "important", label: "Important" },
      { val: "urgent", label: "Urgent" }
    ].forEach((o) => {
      const opt = document.createElement("option");
      opt.value = o.val;
      opt.textContent = o.label;
      opt.selected = (existing?.priority || "normal") === o.val;
      sPri.appendChild(opt);
    });
    gPri.append(lPri, sPri);
    row1.append(gAud, gPri);

    // Row 2: Publish & Expiry Dates
    const row2 = document.createElement("div");
    row2.className = "admin-form-row";

    const gPub = document.createElement("div");
    gPub.className = "admin-form-group";
    const lPub = document.createElement("label");
    lPub.htmlFor = "annPublishDate";
    lPub.textContent = "Publish Date & Time";
    const iPub = document.createElement("input");
    iPub.id = "annPublishDate";
    iPub.type = "datetime-local";
    iPub.value = toDatetimeLocalValue(existing?.publishAt || new Date().toISOString());
    gPub.append(lPub, iPub);

    const gExp = document.createElement("div");
    gExp.className = "admin-form-group";
    const lExp = document.createElement("label");
    lExp.htmlFor = "annExpiryDate";
    lExp.textContent = "Expiry Date & Time (Optional)";
    const iExp = document.createElement("input");
    iExp.id = "annExpiryDate";
    iExp.type = "datetime-local";
    iExp.value = toDatetimeLocalValue(existing?.expiresAt);
    gExp.append(lExp, iExp);
    row2.append(gPub, gExp);

    // Status
    const gStat = document.createElement("div");
    gStat.className = "admin-form-group";
    const lStat = document.createElement("label");
    lStat.htmlFor = "annStatusSelect";
    lStat.textContent = "Status";
    const sStat = document.createElement("select");
    sStat.id = "annStatusSelect";
    [
      { val: "draft", label: "Draft (Hidden from users)" },
      { val: "published", label: "Published (Visible to audience in dashboard)" },
      { val: "paused", label: "Paused (Temporarily hidden)" },
      { val: "archived", label: "Archived" }
    ].forEach((o) => {
      const opt = document.createElement("option");
      opt.value = o.val;
      opt.textContent = o.label;
      opt.selected = (existing?.status || "published") === o.val;
      sStat.appendChild(opt);
    });
    gStat.append(lStat, sStat);

    const errBanner = document.createElement("div");
    errBanner.className = "admin-alert-banner";
    errBanner.hidden = true;

    form.append(errBanner, gTitle, gMsg, row1, row2, gStat);
    modalBody.replaceChildren(form);
    confirmBtn.textContent = isEdit ? "Save Announcement" : "Create Announcement";
    if (cancelBtn) cancelBtn.hidden = false;
    modalBackdrop.hidden = false;
    iTitle.focus();

    const cleanup = () => {
      modalBackdrop.hidden = true;
      if (modalCard) modalCard.classList.remove("wide");
      confirmBtn.onclick = null;
      if (cancelBtn) cancelBtn.onclick = null;
      if (closeBtn) closeBtn.onclick = null;
    };

    confirmBtn.onclick = async () => {
      errBanner.hidden = true;
      const payload = {
        title: iTitle.value.trim(),
        message: iMsg.value.trim(),
        audience: sAud.value,
        priority: sPri.value,
        status: sStat.value,
        publishAt: fromDatetimeLocalValue(iPub.value) || new Date().toISOString(),
        expiresAt: fromDatetimeLocalValue(iExp.value)
      };

      confirmBtn.disabled = true;
      const res = isEdit
        ? await updateAdminAnnouncement(existing.id, payload, currentAdmin.uid)
        : await createAdminAnnouncement(payload, currentAdmin.uid);
      confirmBtn.disabled = false;

      if (!res.success) {
        errBanner.textContent = res.error || "Please check all fields.";
        errBanner.hidden = false;
        return;
      }

      cleanup();
      showToast(isEdit ? "Announcement updated." : "Announcement created.");
      await renderAnnouncementsView(container, ctx);
    };

    if (cancelBtn) cancelBtn.onclick = cleanup;
    if (closeBtn) closeBtn.onclick = cleanup;
  };

  // Header
  const header = document.createElement("div");
  header.className = "admin-view-header";
  const titleBox = document.createElement("div");
  titleBox.className = "admin-view-title";
  const h2 = document.createElement("h2");
  h2.textContent = "Announcements System";
  const sub = document.createElement("p");
  sub.textContent = "Publish inline notices inside Customer and Worker dashboards. Draft, paused, archived, and expired notices are strictly hidden from ordinary users.";
  titleBox.append(h2, sub);

  const actionsWrap = document.createElement("div");
  actionsWrap.className = "admin-view-actions";
  const newBtn = document.createElement("button");
  newBtn.type = "button";
  newBtn.className = "admin-btn-primary";
  newBtn.textContent = "+ New Announcement";
  newBtn.onclick = () => openEditorModal(null);
  actionsWrap.appendChild(newBtn);

  header.append(titleBox, actionsWrap);
  container.appendChild(header);

  // Toolbar
  const toolbar = document.createElement("div");
  toolbar.className = "admin-toolbar";
  const searchWrap = document.createElement("div");
  searchWrap.className = "admin-toolbar-search";
  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.className = "admin-search-input";
  searchInput.placeholder = "Search announcements by title or message...";
  searchWrap.appendChild(searchInput);

  const filtersWrap = document.createElement("div");
  filtersWrap.className = "admin-toolbar-filters";

  const statusSel = document.createElement("select");
  statusSel.className = "admin-select-input";
  statusSel.setAttribute("aria-label", "Filter announcements by status");
  [
    { val: "all", label: "All Statuses" },
    { val: "published", label: "Published" },
    { val: "draft", label: "Draft" },
    { val: "paused", label: "Paused" },
    { val: "expired", label: "Expired" },
    { val: "archived", label: "Archived" }
  ].forEach((o) => {
    const opt = document.createElement("option");
    opt.value = o.val;
    opt.textContent = o.label;
    statusSel.appendChild(opt);
  });

  const audSel = document.createElement("select");
  audSel.className = "admin-select-input";
  audSel.setAttribute("aria-label", "Filter announcements by audience");
  [
    { val: "all", label: "All Audiences" },
    { val: "everyone", label: "Everyone" },
    { val: "customers", label: "Customers" },
    { val: "workers", label: "Workers" }
  ].forEach((o) => {
    const opt = document.createElement("option");
    opt.value = o.val;
    opt.textContent = o.label;
    audSel.appendChild(opt);
  });

  filtersWrap.append(statusSel, audSel);
  toolbar.append(searchWrap, filtersWrap);
  container.appendChild(toolbar);

  const listWrap = document.createElement("div");
  container.appendChild(listWrap);

  const renderList = () => {
    listWrap.replaceChildren();
    const q = searchQuery.toLowerCase().trim();
    const filtered = announcements.filter((a) => {
      const eff = a.effectiveStatus || a.status || "draft";
      if (statusFilter !== "all" && eff !== statusFilter) return false;
      if (audienceFilter !== "all" && (a.audience || "everyone") !== audienceFilter) return false;
      if (q) {
        const hay = `${a.title || ""} ${a.message || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "admin-empty-state";
      const eh3 = document.createElement("h3");
      eh3.textContent = "No announcements found";
      const ep = document.createElement("p");
      ep.textContent = "Create an announcement to communicate updates cleanly inside customer or worker dashboards.";
      empty.append(eh3, ep);
      listWrap.appendChild(empty);
      return;
    }

    const cardsGrid = document.createElement("div");
    cardsGrid.className = "admin-announcement-list";

    for (const item of filtered) {
      const effStatus = item.effectiveStatus || item.status || "draft";
      const priority = item.priority || "normal";
      const card = document.createElement("article");
      card.className = `admin-announcement-card priority-${priority}`;

      const head = document.createElement("div");
      head.className = "admin-announcement-head";
      const title = document.createElement("h3");
      title.className = "admin-announcement-title";
      title.textContent = item.title || "Untitled Announcement";

      const badges = document.createElement("div");
      badges.className = "admin-announcement-badges";
      badges.appendChild(createStatusPill(effStatus, effStatus));
      badges.appendChild(createStatusPill(priority, priority));
      badges.appendChild(createStatusPill(item.audience || "everyone", "info"));

      head.append(title, badges);

      const body = document.createElement("p");
      body.className = "admin-announcement-body";
      body.textContent = item.message || "";

      const meta = document.createElement("div");
      meta.className = "admin-announcement-meta";
      const pubSpan = document.createElement("span");
      pubSpan.textContent = `Publish: ${formatDateTime(item.publishAt, "Immediate")}`;
      meta.appendChild(pubSpan);
      if (item.expiresAt) {
        const expSpan = document.createElement("span");
        expSpan.textContent = `Expires: ${formatDateTime(item.expiresAt)}`;
        meta.appendChild(expSpan);
      }

      const btnBar = document.createElement("div");
      btnBar.className = "admin-table-actions";

      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "admin-table-btn";
      editBtn.textContent = "Edit";
      editBtn.onclick = () => openEditorModal(item);
      btnBar.appendChild(editBtn);

      if (effStatus !== "published") {
        const pubBtn = document.createElement("button");
        pubBtn.type = "button";
        pubBtn.className = "admin-table-btn approve";
        pubBtn.textContent = "Publish";
        pubBtn.onclick = () => {
          showConfirmModal({
            title: "Publish Announcement",
            body: `Publish "${item.title}" to ${item.audience || "everyone"}? It will appear inline inside eligible user dashboards.`,
            confirmText: "Publish Now",
            onConfirm: async () => {
              const res = await updateAdminAnnouncementStatus(item.id, "published", currentAdmin.uid);
              if (res.success) {
                showToast("Announcement published.");
                await renderAnnouncementsView(container, ctx);
              } else {
                showToast(res.error || "Failed to publish.");
              }
            }
          });
        };
        btnBar.appendChild(pubBtn);
      }

      if (effStatus === "published") {
        const pauseBtn = document.createElement("button");
        pauseBtn.type = "button";
        pauseBtn.className = "admin-table-btn";
        pauseBtn.textContent = "Pause";
        pauseBtn.onclick = () => {
          showConfirmModal({
            title: "Pause Announcement",
            body: `Pause "${item.title}"? It will immediately stop appearing in user dashboards.`,
            confirmText: "Pause",
            onConfirm: async () => {
              const res = await updateAdminAnnouncementStatus(item.id, "paused", currentAdmin.uid);
              if (res.success) {
                showToast("Announcement paused.");
                await renderAnnouncementsView(container, ctx);
              } else {
                showToast(res.error || "Failed to pause.");
              }
            }
          });
        };
        btnBar.appendChild(pauseBtn);
      }

      if (effStatus !== "archived") {
        const archBtn = document.createElement("button");
        archBtn.type = "button";
        archBtn.className = "admin-table-btn suspend";
        archBtn.textContent = "Archive";
        archBtn.onclick = () => {
          showConfirmModal({
            title: "Archive Announcement",
            body: `Archive "${item.title}"? Archived notices are hidden from users and retained for administrative history.`,
            confirmText: "Archive",
            onConfirm: async () => {
              const res = await updateAdminAnnouncementStatus(item.id, "archived", currentAdmin.uid);
              if (res.success) {
                showToast("Announcement archived.");
                await renderAnnouncementsView(container, ctx);
              } else {
                showToast(res.error || "Failed to archive.");
              }
            }
          });
        };
        btnBar.appendChild(archBtn);
      }

      card.append(head, body, meta, btnBar);
      cardsGrid.appendChild(card);
    }

    listWrap.appendChild(cardsGrid);
  };

  searchInput.addEventListener("input", (e) => {
    searchQuery = e.target.value;
    renderList();
  });
  statusSel.addEventListener("change", (e) => {
    statusFilter = e.target.value;
    renderList();
  });
  audSel.addEventListener("change", (e) => {
    audienceFilter = e.target.value;
    renderList();
  });

  renderList();
}

// ============================================================================
// 3. SERVICES & DISTRICTS MANAGEMENT VIEW
// ============================================================================
export async function renderServicesDistrictsView(container, ctx) {
  const { currentAdmin, showToast, showConfirmModal } = ctx;

  const [config, requests, workers] = await Promise.all([
    getAdminPlatformConfig(),
    getAdminRequests(),
    getAdminWorkers()
  ]);

  container.replaceChildren();

  // Compute historical usage counts so admins see impact before toggling
  const serviceReqCounts = new Map();
  const districtReqCounts = new Map();
  for (const r of requests) {
    const sKey = String(r.service || "").trim().toLowerCase();
    if (sKey) serviceReqCounts.set(sKey, (serviceReqCounts.get(sKey) || 0) + 1);
    const dKey = String(r.district || "").trim().toLowerCase();
    if (dKey) districtReqCounts.set(dKey, (districtReqCounts.get(dKey) || 0) + 1);
  }
  const districtWorkerCounts = new Map();
  for (const w of workers) {
    const dKey = String(w.district || "").trim().toLowerCase();
    if (dKey) districtWorkerCounts.set(dKey, (districtWorkerCounts.get(dKey) || 0) + 1);
  }

  let activeSubTab = "services";

  const openServiceModal = (existing = null) => {
    const isEdit = Boolean(existing);
    const modalBackdrop = document.getElementById("adminActionModal");
    const modalTitle = document.getElementById("adminModalTitle");
    const modalBody = document.getElementById("adminModalBody");
    const confirmBtn = document.getElementById("adminModalConfirm");
    const cancelBtn = document.getElementById("adminModalCancel");
    const closeBtn = document.getElementById("adminModalClose");
    if (!modalBackdrop || !modalTitle || !modalBody || !confirmBtn) return;

    modalTitle.textContent = isEdit ? `Edit Service: ${existing.name}` : "Add Service Category";

    const wrap = document.createElement("div");
    const errBox = document.createElement("div");
    errBox.className = "admin-alert-banner";
    errBox.hidden = true;

    const gName = document.createElement("div");
    gName.className = "admin-form-group";
    const lName = document.createElement("label");
    lName.htmlFor = "svcNameInput";
    lName.textContent = "Service Category Name *";
    const iName = document.createElement("input");
    iName.id = "svcNameInput";
    iName.type = "text";
    iName.maxLength = 80;
    iName.placeholder = "e.g., Solar Inverter Repair";
    iName.value = existing?.name || "";
    gName.append(lName, iName);

    const gDesc = document.createElement("div");
    gDesc.className = "admin-form-group";
    const lDesc = document.createElement("label");
    lDesc.htmlFor = "svcDescInput";
    lDesc.textContent = "Short Description";
    const iDesc = document.createElement("textarea");
    iDesc.id = "svcDescInput";
    iDesc.rows = 2;
    iDesc.maxLength = 240;
    iDesc.placeholder = "Brief description of services covered...";
    iDesc.value = existing?.description || "";
    gDesc.append(lDesc, iDesc);

    wrap.append(errBox, gName, gDesc);
    modalBody.replaceChildren(wrap);
    confirmBtn.textContent = isEdit ? "Save Service" : "Add Service";
    if (cancelBtn) cancelBtn.hidden = false;
    modalBackdrop.hidden = false;
    iName.focus();

    const cleanup = () => {
      modalBackdrop.hidden = true;
      confirmBtn.onclick = null;
      if (cancelBtn) cancelBtn.onclick = null;
      if (closeBtn) closeBtn.onclick = null;
    };

    confirmBtn.onclick = async () => {
      const name = iName.value.trim();
      const description = iDesc.value.trim();
      if (name.length < 2 || name.length > 80) {
        errBox.textContent = "Service name must be between 2 and 80 characters.";
        errBox.hidden = false;
        return;
      }

      const duplicate = config.services.some(
        (s) => s.name.toLowerCase() === name.toLowerCase() && (!isEdit || s.id !== existing.id)
      );
      if (duplicate) {
        errBox.textContent = "A service category with this name already exists.";
        errBox.hidden = false;
        return;
      }

      const updatedServices = isEdit
        ? config.services.map((s) =>
            s.id === existing.id
              ? { ...s, name, description, updatedAt: new Date().toISOString() }
              : s
          )
        : [
            ...config.services,
            {
              id: slugifyId(name),
              name,
              description,
              enabled: true,
              updatedAt: new Date().toISOString()
            }
          ];

      confirmBtn.disabled = true;
      const res = await updateAdminPlatformConfig(
        { services: updatedServices },
        currentAdmin.uid,
        {
          actionType: isEdit ? "SERVICE_CATEGORY_EDITED" : "SERVICE_CATEGORY_ADDED",
          summary: isEdit ? `Edited service category: ${name}` : `Added service category: ${name}`
        }
      );
      confirmBtn.disabled = false;

      if (res.success) {
        cleanup();
        showToast(isEdit ? `Updated "${name}".` : `Added "${name}".`);
        await renderServicesDistrictsView(container, ctx);
      } else {
        errBox.textContent = res.error || "Failed to save service category.";
        errBox.hidden = false;
      }
    };

    if (cancelBtn) cancelBtn.onclick = cleanup;
    if (closeBtn) closeBtn.onclick = cleanup;
  };

  // Header
  const header = document.createElement("div");
  header.className = "admin-view-header";
  const titleBox = document.createElement("div");
  titleBox.className = "admin-view-title";
  const h2 = document.createElement("h2");
  h2.textContent = "Services & District Coverage";
  const sub = document.createElement("p");
  sub.textContent = "Manage active service categories and Jammu & Kashmir districts. Disabling prevents new requests while preserving all historical records.";
  titleBox.append(h2, sub);

  const actionsWrap = document.createElement("div");
  actionsWrap.className = "admin-view-actions";
  const addSvcBtn = document.createElement("button");
  addSvcBtn.type = "button";
  addSvcBtn.className = "admin-btn-primary";
  addSvcBtn.textContent = "+ Add Service Category";
  addSvcBtn.onclick = () => openServiceModal(null);
  actionsWrap.appendChild(addSvcBtn);
  header.append(titleBox, actionsWrap);
  container.appendChild(header);

  // Sub-tabs
  const subTabs = document.createElement("div");
  subTabs.className = "admin-subtabs";
  subTabs.setAttribute("role", "tablist");

  const svcTabBtn = document.createElement("button");
  svcTabBtn.type = "button";
  svcTabBtn.className = "admin-subtab-btn active";
  svcTabBtn.setAttribute("role", "tab");
  svcTabBtn.textContent = `Service Categories (${config.services.length})`;

  const distTabBtn = document.createElement("button");
  distTabBtn.type = "button";
  distTabBtn.className = "admin-subtab-btn";
  distTabBtn.setAttribute("role", "tab");
  distTabBtn.textContent = `J&K Districts (${config.districts.length})`;

  subTabs.append(svcTabBtn, distTabBtn);
  container.appendChild(subTabs);

  const panelWrap = document.createElement("div");
  container.appendChild(panelWrap);

  const renderPanel = () => {
    panelWrap.replaceChildren();
    svcTabBtn.classList.toggle("active", activeSubTab === "services");
    distTabBtn.classList.toggle("active", activeSubTab === "districts");

    if (activeSubTab === "services") {
      const grid = document.createElement("div");
      grid.className = "admin-entity-grid";

      for (const svc of config.services) {
        const isEnabled = svc.enabled !== false;
        const histCount = serviceReqCounts.get(svc.name.toLowerCase()) || 0;

        const card = document.createElement("article");
        card.className = `admin-entity-card${isEnabled ? "" : " disabled"}`;

        const top = document.createElement("div");
        top.className = "admin-entity-top";
        const nameEl = document.createElement("span");
        nameEl.className = "admin-entity-name";
        nameEl.textContent = svc.name;
        top.append(nameEl, createStatusPill(isEnabled ? "Available" : "Disabled", isEnabled ? "enabled" : "disabled"));

        const descEl = document.createElement("div");
        descEl.className = "admin-entity-desc";
        descEl.textContent = svc.description || "Standard local service category.";

        const metaEl = document.createElement("div");
        metaEl.className = "admin-entity-meta";
        metaEl.textContent = `${histCount} historical request${histCount === 1 ? "" : "s"} preserved`;

        const actions = document.createElement("div");
        actions.className = "admin-table-actions";

        const editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.className = "admin-table-btn";
        editBtn.textContent = "Edit";
        editBtn.onclick = () => openServiceModal(svc);

        const toggleBtn = document.createElement("button");
        toggleBtn.type = "button";
        toggleBtn.className = `admin-table-btn ${isEnabled ? "suspend" : "approve"}`;
        toggleBtn.textContent = isEnabled ? "Disable" : "Enable";
        toggleBtn.onclick = () => {
          showConfirmModal({
            title: isEnabled ? `Disable "${svc.name}"` : `Enable "${svc.name}"`,
            body: isEnabled
              ? `Disable "${svc.name}" for new requests? Historical requests (${histCount}) will be preserved safely and never deleted.`
              : `Re-enable "${svc.name}" so customers can submit new service requests in this category?`,
            confirmText: isEnabled ? "Disable Service" : "Enable Service",
            onConfirm: async () => {
              const nextServices = config.services.map((s) =>
                s.id === svc.id ? { ...s, enabled: !isEnabled, updatedAt: new Date().toISOString() } : s
              );
              const res = await updateAdminPlatformConfig(
                { services: nextServices },
                currentAdmin.uid,
                {
                  actionType: isEnabled ? "SERVICE_CATEGORY_DISABLED" : "SERVICE_CATEGORY_ENABLED",
                  summary: `${isEnabled ? "Disabled" : "Enabled"} service: ${svc.name}`
                }
              );
              if (res.success) {
                showToast(`Service "${svc.name}" ${isEnabled ? "disabled" : "enabled"}.`);
                await renderServicesDistrictsView(container, ctx);
              } else {
                showToast(res.error || "Failed to update service availability.");
              }
            }
          });
        };

        actions.append(editBtn, toggleBtn);
        card.append(top, descEl, metaEl, actions);
        grid.appendChild(card);
      }
      panelWrap.appendChild(grid);
    } else {
      const grid = document.createElement("div");
      grid.className = "admin-entity-grid";

      for (const dist of config.districts) {
        const isEnabled = dist.enabled !== false;
        const reqCount = districtReqCounts.get(dist.name.toLowerCase()) || 0;
        const wrkCount = districtWorkerCounts.get(dist.name.toLowerCase()) || 0;

        const card = document.createElement("article");
        card.className = `admin-entity-card${isEnabled ? "" : " disabled"}`;

        const top = document.createElement("div");
        top.className = "admin-entity-top";
        const nameEl = document.createElement("span");
        nameEl.className = "admin-entity-name";
        nameEl.textContent = dist.name;
        top.append(nameEl, createStatusPill(isEnabled ? "Active" : "Disabled", isEnabled ? "enabled" : "disabled"));

        const metaEl = document.createElement("div");
        metaEl.className = "admin-entity-meta";
        metaEl.textContent = `${wrkCount} worker${wrkCount === 1 ? "" : "s"} · ${reqCount} historical request${reqCount === 1 ? "" : "s"}`;

        const actions = document.createElement("div");
        actions.className = "admin-table-actions";

        const toggleBtn = document.createElement("button");
        toggleBtn.type = "button";
        toggleBtn.className = `admin-table-btn ${isEnabled ? "suspend" : "approve"}`;
        toggleBtn.textContent = isEnabled ? "Disable District" : "Enable District";
        toggleBtn.onclick = () => {
          showConfirmModal({
            title: isEnabled ? `Disable District: ${dist.name}` : `Enable District: ${dist.name}`,
            body: isEnabled
              ? `Disable ${dist.name} for new requests and registrations? Existing requests (${reqCount}) and worker records remain preserved.`
              : `Enable ${dist.name} across customer and worker interfaces?`,
            confirmText: isEnabled ? "Disable District" : "Enable District",
            onConfirm: async () => {
              const nextDistricts = config.districts.map((d) =>
                d.id === dist.id ? { ...d, enabled: !isEnabled, updatedAt: new Date().toISOString() } : d
              );
              const res = await updateAdminPlatformConfig(
                { districts: nextDistricts },
                currentAdmin.uid,
                {
                  actionType: isEnabled ? "DISTRICT_DISABLED" : "DISTRICT_ENABLED",
                  summary: `${isEnabled ? "Disabled" : "Enabled"} district: ${dist.name}`
                }
              );
              if (res.success) {
                showToast(`District "${dist.name}" ${isEnabled ? "disabled" : "enabled"}.`);
                await renderServicesDistrictsView(container, ctx);
              } else {
                showToast(res.error || "Failed to update district availability.");
              }
            }
          });
        };

        actions.appendChild(toggleBtn);
        card.append(top, metaEl, actions);
        grid.appendChild(card);
      }
      panelWrap.appendChild(grid);
    }
  };

  svcTabBtn.onclick = () => {
    activeSubTab = "services";
    renderPanel();
  };
  distTabBtn.onclick = () => {
    activeSubTab = "districts";
    renderPanel();
  };

  renderPanel();
}

// ============================================================================
// 4. LIVE ANALYTICS DASHBOARD VIEW
// ============================================================================
export async function renderAnalyticsView(container, ctx) {
  const { formatDateTime, applyResponsiveTableLabels } = ctx;

  let data;
  try {
    data = await getAdminAnalyticsData();
  } catch (err) {
    container.replaceChildren();
    const errBox = document.createElement("div");
    errBox.className = "admin-error-state";
    const h3 = document.createElement("h3");
    h3.textContent = "Unable to Compute Live Analytics";
    const p = document.createElement("p");
    p.textContent = err?.message || "Could not aggregate Firestore collections.";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "admin-btn-primary";
    retry.textContent = "Retry";
    retry.onclick = () => renderAnalyticsView(container, ctx);
    errBox.append(h3, p, retry);
    container.appendChild(errBox);
    return;
  }

  container.replaceChildren();

  // Header
  const header = document.createElement("div");
  header.className = "admin-view-header";
  const titleBox = document.createElement("div");
  titleBox.className = "admin-view-title";
  const h2 = document.createElement("h2");
  h2.textContent = "Platform Analytics";
  const sub = document.createElement("p");
  sub.textContent = "Live aggregated metrics computed directly from Cloud Firestore collections. Private user PII is never exposed.";
  titleBox.append(h2, sub);

  const actionsWrap = document.createElement("div");
  actionsWrap.className = "admin-view-actions";
  const refreshBtn = document.createElement("button");
  refreshBtn.type = "button";
  refreshBtn.className = "admin-btn-subtle";
  refreshBtn.textContent = "↻ Refresh Live Data";
  refreshBtn.onclick = () => renderAnalyticsView(container, ctx);
  actionsWrap.appendChild(refreshBtn);
  header.append(titleBox, actionsWrap);
  container.appendChild(header);

  // KPI Grid
  const kpiGrid = document.createElement("div");
  kpiGrid.className = "admin-metrics-grid";
  const kpis = [
    { label: "Total Customers", value: data.totalCustomers, note: `${data.suspendedCustomers} suspended` },
    { label: "Total Workers", value: data.totalWorkers, note: `${data.verifiedWorkers} verified` },
    { label: "Pending Approvals", value: data.pendingWorkerApprovals, note: "Awaiting verification", tone: data.pendingWorkerApprovals > 0 ? "warn" : "" },
    { label: "Total Requests", value: data.totalRequests, note: `${data.completionRate}% completion rate` },
    { label: "Pending Requests", value: data.pendingRequests, note: "Awaiting worker response" },
    { label: "Accepted Requests", value: data.acceptedRequests, note: "In-progress assignments" },
    { label: "Completed Requests", value: data.completedRequests, note: "Successfully fulfilled" },
    { label: "Rejected Requests", value: data.rejectedRequests, note: `${data.cancelledRequests} cancelled` }
  ];

  for (const m of kpis) {
    const card = document.createElement("div");
    card.className = "admin-metric-card";
    const lbl = document.createElement("div");
    lbl.className = "admin-metric-label";
    lbl.textContent = m.label;
    const val = document.createElement("div");
    val.className = `admin-metric-value${m.tone ? ` ${m.tone}` : ""}`;
    val.textContent = String(m.value);
    const note = document.createElement("div");
    note.className = "admin-metric-note";
    note.textContent = m.note;
    card.append(lbl, val, note);
    kpiGrid.appendChild(card);
  }
  container.appendChild(kpiGrid);

  // Breakdown Panels (Services + Districts)
  const chartsGrid = document.createElement("div");
  chartsGrid.className = "admin-analytics-grid";

  const buildBarPanel = (title, subtitle, items) => {
    const panel = document.createElement("section");
    panel.className = "admin-analytics-panel";
    const h3 = document.createElement("h3");
    h3.textContent = title;
    const p = document.createElement("p");
    p.textContent = subtitle;
    panel.append(h3, p);

    if (!items || items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "admin-empty-state";
      const ep = document.createElement("p");
      ep.textContent = "No request activity recorded yet.";
      empty.appendChild(ep);
      panel.appendChild(empty);
      return panel;
    }

    const maxCount = Math.max(...items.map((i) => i.count), 1);
    const list = document.createElement("div");
    list.className = "admin-bar-list";
    for (const item of items.slice(0, 10)) {
      const row = document.createElement("div");
      row.className = "admin-bar-row";
      const labels = document.createElement("div");
      labels.className = "admin-bar-labels";
      const nameSpan = document.createElement("span");
      nameSpan.className = "admin-bar-name";
      nameSpan.textContent = item.name;
      const valSpan = document.createElement("span");
      valSpan.className = "admin-bar-val";
      valSpan.textContent = `${item.count}`;
      labels.append(nameSpan, valSpan);

      const track = document.createElement("div");
      track.className = "admin-bar-track";
      const fill = document.createElement("div");
      fill.className = "admin-bar-fill";
      fill.style.width = `${Math.round((item.count / maxCount) * 100)}%`;
      track.appendChild(fill);

      row.append(labels, track);
      list.appendChild(row);
    }
    panel.appendChild(list);
    return panel;
  };

  chartsGrid.appendChild(
    buildBarPanel("Most Requested Services", "Service categories ranked by actual request volume.", data.serviceBreakdown)
  );
  chartsGrid.appendChild(
    buildBarPanel("District-Wise Request Activity", "Service request distribution across Jammu & Kashmir.", data.districtBreakdown)
  );
  container.appendChild(chartsGrid);

  // Recent Reports & Recent Admin Activity
  const activityGrid = document.createElement("div");
  activityGrid.className = "admin-analytics-grid";

  // Recent Reports panel
  const repPanel = document.createElement("section");
  repPanel.className = "admin-analytics-panel";
  const repH3 = document.createElement("h3");
  repH3.textContent = "Recent Safety Reports";
  const repP = document.createElement("p");
  repP.textContent = "Latest trust & safety reports (sanitized summary).";
  repPanel.append(repH3, repP);

  if (data.recentReports.length === 0) {
    const empty = document.createElement("div");
    empty.className = "admin-empty-state";
    const ep = document.createElement("p");
    ep.textContent = "No recent safety reports.";
    empty.appendChild(ep);
    repPanel.appendChild(empty);
  } else {
    const tWrap = document.createElement("div");
    tWrap.className = "admin-table-container";
    const table = document.createElement("table");
    table.className = "admin-table admin-table-responsive";
    const thead = document.createElement("thead");
    const hr = document.createElement("tr");
    ["Target", "Reason", "Status", "Reported"].forEach((txt) => {
      const th = document.createElement("th");
      th.textContent = txt;
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    const tbody = document.createElement("tbody");
    for (const rep of data.recentReports) {
      const tr = document.createElement("tr");
      const td1 = document.createElement("td");
      td1.textContent = rep.targetType;
      const td2 = document.createElement("td");
      td2.textContent = rep.reason;
      const td3 = document.createElement("td");
      td3.appendChild(createStatusPill(rep.status, rep.status));
      const td4 = document.createElement("td");
      td4.textContent = formatDateTime(rep.createdAt);
      tr.append(td1, td2, td3, td4);
      tbody.appendChild(tr);
    }
    table.append(thead, tbody);
    if (typeof applyResponsiveTableLabels === "function") applyResponsiveTableLabels(table);
    tWrap.appendChild(table);
    repPanel.appendChild(tWrap);
  }

  // Recent Admin Activity panel
  const actPanel = document.createElement("section");
  actPanel.className = "admin-analytics-panel";
  const actH3 = document.createElement("h3");
  actH3.textContent = "Recent Administrative Activity";
  const actP = document.createElement("p");
  actP.textContent = "Latest audited control actions from /auditLogs.";
  actPanel.append(actH3, actP);

  if (data.recentAuditLogs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "admin-empty-state";
    const ep = document.createElement("p");
    ep.textContent = "No administrative actions logged yet.";
    empty.appendChild(ep);
    actPanel.appendChild(empty);
  } else {
    const tWrap = document.createElement("div");
    tWrap.className = "admin-table-container";
    const table = document.createElement("table");
    table.className = "admin-table admin-table-responsive";
    const thead = document.createElement("thead");
    const hr = document.createElement("tr");
    ["Action", "Target", "Result", "Time"].forEach((txt) => {
      const th = document.createElement("th");
      th.textContent = txt;
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    const tbody = document.createElement("tbody");
    for (const log of data.recentAuditLogs) {
      const tr = document.createElement("tr");
      const td1 = document.createElement("td");
      td1.textContent = String(log.action || "OPERATION");
      const td2 = document.createElement("td");
      td2.textContent = `${log.targetType || "entity"}: ${log.targetId || "—"}`;
      const td3 = document.createElement("td");
      td3.appendChild(createStatusPill(log.result || "success", log.result === "success" ? "active" : "suspended"));
      const td4 = document.createElement("td");
      td4.textContent = formatDateTime(log.timestamp);
      tr.append(td1, td2, td3, td4);
      tbody.appendChild(tr);
    }
    table.append(thead, tbody);
    if (typeof applyResponsiveTableLabels === "function") applyResponsiveTableLabels(table);
    tWrap.appendChild(table);
    actPanel.appendChild(tWrap);
  }

  activityGrid.append(repPanel, actPanel);
  container.appendChild(activityGrid);
}
