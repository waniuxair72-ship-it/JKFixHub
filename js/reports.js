// ==========================================
// #REPORTS_LOGIC
// ==========================================

// Prototype reporting and safety escalation flow.
// Stores reports in memory in store.js.
// Authenticated customers and workers can report workers, customers, reviews, and messages.
import { closeModal, openModal } from "./modals.js";
import {
  createReport,
  getActiveConversation,
  getCurrentUser,
  getWorkerById,
  hasReportedTarget,
  isAuthenticated
} from "./store.js";
import {
  getSafeErrorMessage,
  hasCapability,
  recordSecurityEvent,
  setTextContent,
  validateReport
} from "./security.js";

const markupPattern = /<\s*\/?\s*[a-z!][^>]*>/i;
const MAX_REPORT_LENGTH = 2000;

let initialized = false;
let activeTarget = null;
let toastHandler = null;

function updateReportCharCount() {
  const input = document.getElementById("reportDescriptionInput");
  const counter = document.getElementById("reportCharCount");
  if (input && counter) {
    setTextContent(counter, `${input.value.length}/${MAX_REPORT_LENGTH}`);
  }
}

function setReportError(message) {
  const errorEl = document.getElementById("reportFormError");
  if (errorEl) {
    setTextContent(errorEl, message);
    errorEl.hidden = !message;
  }
}

export function openReportModal({ targetType, targetId, targetLabel = "" }) {
  const user = getCurrentUser();
  if (!isAuthenticated() || !user || !hasCapability(user.role, "reportUser")) {
    recordSecurityEvent("UNAUTHORIZED_UI_ACTION", user?.role || null);
    if (toastHandler) {
      toastHandler("Please continue with a demo account to submit reports.");
    }
    openModal("authModal");
    return false;
  }

  const targetIdStr = String(targetId).trim();
  if (hasReportedTarget(targetIdStr, targetType)) {
    if (toastHandler) {
      toastHandler("You have already submitted a report for this target.");
    }
    return false;
  }

  activeTarget = {
    targetType,
    targetId: targetIdStr,
    targetLabel: targetLabel || `${targetType}: ${targetIdStr}`
  };

  const form = document.getElementById("reportForm");
  if (form) form.reset();

  setReportError("");
  setTextContent(document.getElementById("reportTargetLabel"), activeTarget.targetLabel);
  setTextContent(document.getElementById("reportTargetType"), targetType.toUpperCase());

  // Default to first reason
  const reasonSelect = document.getElementById("reportReasonSelect");
  if (reasonSelect) {
    reasonSelect.selectedIndex = 0;
  }

  updateReportCharCount();
  openModal("reportModal");
  document.getElementById("reportDescriptionInput")?.focus();
  return true;
}

function handleReportSubmit(event) {
  event.preventDefault();
  if (!activeTarget) return;

  const reasonSelect = document.getElementById("reportReasonSelect");
  const descriptionInput = document.getElementById("reportDescriptionInput");
  if (!reasonSelect || !descriptionInput) return;

  const reason = reasonSelect.value;
  const description = descriptionInput.value.trim();

  const allowedReasons = ["spam", "harassment", "scam", "inappropriate", "fake", "abusive", "other"];
  if (!allowedReasons.includes(reason)) {
    setReportError(getSafeErrorMessage("invalidReportReason"));
    return;
  }

  if (!validateReport(description) || markupPattern.test(description)) {
    if (markupPattern.test(description)) {
      recordSecurityEvent("SUSPICIOUS_INPUT", getCurrentUser()?.role || null);
    }
    setReportError(getSafeErrorMessage("invalidReport"));
    descriptionInput.focus();
    return;
  }

  try {
    createReport({
      targetType: activeTarget.targetType,
      targetId: activeTarget.targetId,
      reason,
      description
    });
  } catch (err) {
    setReportError(err.message || getSafeErrorMessage("invalidRequest"));
    return;
  }

  activeTarget = null;
  closeModal("reportModal");

  if (toastHandler) {
    toastHandler("Report received. Our moderation team will review this demo report.");
  }
}

export function handleChatReport() {
  const conversation = getActiveConversation();
  const user = getCurrentUser();
  if (!conversation || !user) return;

  if (user.role === "customer") {
    // Customer reporting the worker
    const workerId = Number(conversation.workerId.replace(/^demo-worker-/, ""));
    const worker = getWorkerById(workerId);
    openReportModal({
      targetType: "worker",
      targetId: String(workerId),
      targetLabel: worker ? `${worker.name} (${worker.service})` : conversation.workerName
    });
  } else if (user.role === "worker") {
    // Worker reporting the customer
    openReportModal({
      targetType: "customer",
      targetId: conversation.customerId,
      targetLabel: `Customer: ${conversation.customerName}`
    });
  }
}

export function initializeReports({ showToast } = {}) {
  if (initialized) return;
  initialized = true;
  toastHandler = showToast;

  const form = document.getElementById("reportForm");
  const descriptionInput = document.getElementById("reportDescriptionInput");

  if (form) form.addEventListener("submit", handleReportSubmit);
  if (descriptionInput) descriptionInput.addEventListener("input", updateReportCharCount);

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    // Chat "Report User" button
    if (target.closest("#chatReportUser")) {
      handleChatReport();
      return;
    }

    // Report review button
    const reportReviewBtn = target.closest("[data-report-review]");
    if (reportReviewBtn) {
      const reviewId = reportReviewBtn.dataset.reportReview;
      openReportModal({
        targetType: "review",
        targetId: reviewId,
        targetLabel: `Review (${reviewId})`
      });
      return;
    }

    // Worker profile report button if present
    const reportWorkerBtn = target.closest("[data-report-worker]");
    if (reportWorkerBtn) {
      const workerId = reportWorkerBtn.dataset.reportWorker;
      const worker = getWorkerById(Number(workerId));
      openReportModal({
        targetType: "worker",
        targetId: String(workerId),
        targetLabel: worker ? `${worker.name} (${worker.service})` : `Worker #${workerId}`
      });
      return;
    }
  });
}

