// ==========================================
// #REVIEWS_LOGIC
// ==========================================

// Reviews are stored in memory in store.js.
// Only authenticated demo customers can review completed requests.
// Assigned workers can reply to their own reviews.
import { closeModal, openModal } from "./modals.js";
import {
  addWorkerReviewReply,
  createCustomerReview,
  getCustomerRequestById,
  getCurrentUser,
  getReviewById,
  getReviewByRequestId,
  getReviewsForWorker,
  isCustomer,
  isWorker
} from "./store.js";
import {
  getSafeErrorMessage,
  hasCapability,
  recordSecurityEvent,
  setTextContent,
  validateReview,
  validateText
} from "./security.js";

const markupPattern = /<\s*\/?\s*[a-z!][^>]*>/i;
const MAX_REVIEW_LENGTH = 1200;
const MAX_REPLY_LENGTH = 600;

let initialized = false;
let activeReviewRequestId = null;
let activeReplyReviewId = null;

function renderStarSymbols(rating) {
  const full = Math.max(1, Math.min(5, Math.round(rating)));
  return "★".repeat(full) + "☆".repeat(5 - full);
}

function updateReviewCharCount() {
  const input = document.getElementById("reviewTextInput");
  const counter = document.getElementById("reviewCharCount");
  if (input && counter) {
    setTextContent(counter, `${input.value.length}/${MAX_REVIEW_LENGTH}`);
  }
}

function updateReplyCharCount() {
  const input = document.getElementById("workerReplyInput");
  const counter = document.getElementById("workerReplyCharCount");
  if (input && counter) {
    setTextContent(counter, `${input.value.length}/${MAX_REPLY_LENGTH}`);
  }
}

function setReviewError(message) {
  const errorEl = document.getElementById("reviewFormError");
  if (errorEl) {
    setTextContent(errorEl, message);
    errorEl.hidden = !message;
  }
}

function setReplyError(message) {
  const errorEl = document.getElementById("workerReplyFormError");
  if (errorEl) {
    setTextContent(errorEl, message);
    errorEl.hidden = !message;
  }
}

export function openLeaveReviewModal(requestId) {
  if (!isCustomer() || !hasCapability("customer", "submitReview")) {
    recordSecurityEvent("UNAUTHORIZED_UI_ACTION", getCurrentUser()?.role || null);
    return false;
  }

  const request = getCustomerRequestById(requestId);
  if (!request || request.status !== "Completed") {
    recordSecurityEvent("INVALID_REQUEST", "customer");
    return false;
  }

  const existingReview = getReviewByRequestId(requestId);
  if (existingReview) {
    openViewReviewModal(requestId);
    return true;
  }

  activeReviewRequestId = requestId;
  const form = document.getElementById("reviewForm");
  if (form) form.reset();

  setReviewError("");
  setTextContent(document.getElementById("reviewTargetWorker"), request.workerName);
  setTextContent(document.getElementById("reviewTargetService"), request.service);
  setTextContent(document.getElementById("reviewTargetDistrict"), request.district);

  // Default to 5 stars selected
  const starInputs = document.querySelectorAll('input[name="reviewRating"]');
  starInputs.forEach((input) => {
    input.checked = input.value === "5";
  });

  updateReviewCharCount();
  closeModal("customerRequestsModal");
  closeModal("customerRequestDetailsModal");
  openModal("reviewModal");
  document.getElementById("reviewTextInput")?.focus();
  return true;
}

export function openViewReviewModal(requestId) {
  const review = getReviewByRequestId(requestId);
  if (!review) return false;

  setTextContent(document.getElementById("viewReviewWorker"), review.workerName);
  setTextContent(document.getElementById("viewReviewRating"), `${review.rating} ★ (${renderStarSymbols(review.rating)})`);
  setTextContent(document.getElementById("viewReviewDate"), new Date(review.createdAt).toLocaleDateString());
  setTextContent(document.getElementById("viewReviewText"), review.text);

  const replySection = document.getElementById("viewReviewReplySection");
  if (replySection) {
    if (review.workerReply) {
      replySection.hidden = false;
      setTextContent(document.getElementById("viewReviewWorkerReply"), review.workerReply);
      setTextContent(
        document.getElementById("viewReviewWorkerReplyDate"),
        review.workerReplyAt ? `Replied on ${new Date(review.workerReplyAt).toLocaleDateString()}` : "Worker reply"
      );
    } else {
      replySection.hidden = true;
    }
  }

  closeModal("customerRequestsModal");
  closeModal("customerRequestDetailsModal");
  openModal("reviewViewModal");
  return true;
}

export function openWorkerReplyModal(reviewId) {
  if (!isWorker() || !hasCapability("worker", "manageOwnProfile")) {
    recordSecurityEvent("UNAUTHORIZED_UI_ACTION", getCurrentUser()?.role || null);
    return false;
  }

  const review = getReviewById(reviewId);
  const user = getCurrentUser();
  if (!review || review.workerId !== user?.workerId) {
    recordSecurityEvent("UNAUTHORIZED_UI_ACTION", user?.role || null);
    return false;
  }

  activeReplyReviewId = reviewId;
  const form = document.getElementById("workerReplyForm");
  if (form) form.reset();

  setReplyError("");
  setTextContent(document.getElementById("replyTargetCustomer"), review.customerName);
  setTextContent(document.getElementById("replyTargetRating"), `${review.rating} ★`);
  setTextContent(document.getElementById("replyTargetReviewText"), review.text);

  const input = document.getElementById("workerReplyInput");
  if (input && review.workerReply) {
    input.value = review.workerReply;
  }

  updateReplyCharCount();
  closeModal("authModal");
  openModal("workerReplyModal");
  document.getElementById("workerReplyInput")?.focus();
  return true;
}

export function buildReviewCard(review, isCurrentWorker = false) {
  const card = document.createElement("article");
  const header = document.createElement("div");
  const author = document.createElement("strong");
  const meta = document.createElement("div");
  const stars = document.createElement("span");
  const date = document.createElement("time");
  const text = document.createElement("p");

  card.className = "review-card";
  card.dataset.reviewId = review.id;
  header.className = "review-card-header";
  author.className = "review-author";
  setTextContent(author, review.customerName);

  meta.className = "review-card-meta";
  stars.className = "review-rating-stars";
  setTextContent(stars, renderStarSymbols(review.rating));
  date.className = "review-date";
  setTextContent(date, new Date(review.createdAt).toLocaleDateString());
  meta.append(stars, date);
  header.append(author, meta);

  text.className = "review-text";
  setTextContent(text, review.text);
  card.append(header, text);

  if (review.workerReply) {
    const replyBox = document.createElement("div");
    const replyHeader = document.createElement("div");
    const replyAuthor = document.createElement("strong");
    const replyDate = document.createElement("time");
    const replyText = document.createElement("p");

    replyBox.className = "worker-reply-box";
    replyHeader.className = "worker-reply-header";
    setTextContent(replyAuthor, `${review.workerName} (Reply)`);
    if (review.workerReplyAt) {
      setTextContent(replyDate, new Date(review.workerReplyAt).toLocaleDateString());
    }
    replyHeader.append(replyAuthor, replyDate);

    replyText.className = "worker-reply-text";
    setTextContent(replyText, review.workerReply);
    replyBox.append(replyHeader, replyText);
    card.append(replyBox);
  }

  const actions = document.createElement("div");
  actions.className = "review-card-actions";

  if (isCurrentWorker) {
    const replyBtn = document.createElement("button");
    replyBtn.className = "button subtle";
    replyBtn.type = "button";
    replyBtn.dataset.replyReview = review.id;
    setTextContent(replyBtn, review.workerReply ? "Edit Reply" : "Reply to Review");
    actions.append(replyBtn);
  }

  const reportBtn = document.createElement("button");
  reportBtn.className = "button subtle report-action-button";
  reportBtn.type = "button";
  reportBtn.dataset.reportReview = review.id;
  setTextContent(reportBtn, "Report Review");
  actions.append(reportBtn);

  card.append(actions);
  return card;
}

export function renderWorkerReviews(workerId, container) {
  if (!container) return;
  const reviews = getReviewsForWorker(workerId);
  const user = getCurrentUser();
  const isCurrentWorker = user?.role === "worker" && user?.workerId === workerId;

  if (reviews.length === 0) {
    const empty = document.createElement("p");
    empty.className = "worker-dashboard-empty";
    setTextContent(empty, "No reviews received yet for this worker.");
    container.replaceChildren(empty);
    return;
  }

  container.replaceChildren(...reviews.map((rev) => buildReviewCard(rev, isCurrentWorker)));
}

function handleReviewFormSubmit(event) {
  event.preventDefault();
  if (!activeReviewRequestId) return;

  const ratingInput = document.querySelector('input[name="reviewRating"]:checked');
  const textInput = document.getElementById("reviewTextInput");
  if (!ratingInput || !textInput) return;

  const rating = Number(ratingInput.value);
  const text = textInput.value.trim();

  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    setReviewError(getSafeErrorMessage("invalidRating"));
    return;
  }

  if (!validateReview(text) || markupPattern.test(text)) {
    if (markupPattern.test(text)) {
      recordSecurityEvent("SUSPICIOUS_INPUT", "customer");
    }
    setReviewError(getSafeErrorMessage("invalidReview"));
    textInput.focus();
    return;
  }

  try {
    createCustomerReview({
      requestId: activeReviewRequestId,
      rating,
      text
    });
  } catch (err) {
    setReviewError(err.message || getSafeErrorMessage("invalidRequest"));
    return;
  }

  const finishedRequestId = activeReviewRequestId;
  activeReviewRequestId = null;
  closeModal("reviewModal");
  openViewReviewModal(finishedRequestId);
}

function handleWorkerReplyFormSubmit(event) {
  event.preventDefault();
  if (!activeReplyReviewId) return;

  const input = document.getElementById("workerReplyInput");
  if (!input) return;

  const replyText = input.value.trim();
  if (!validateText(replyText, { minLength: 2, maxLength: MAX_REPLY_LENGTH, allowNewlines: true }) || markupPattern.test(replyText)) {
    if (markupPattern.test(replyText)) {
      recordSecurityEvent("SUSPICIOUS_INPUT", "worker");
    }
    setReplyError(getSafeErrorMessage("invalidReply"));
    input.focus();
    return;
  }

  try {
    addWorkerReviewReply(activeReplyReviewId, replyText);
  } catch (err) {
    setReplyError(err.message || getSafeErrorMessage("invalidRequest"));
    return;
  }

  activeReplyReviewId = null;
  closeModal("workerReplyModal");
  openModal("authModal");

  // Re-render worker reviews section if open
  const user = getCurrentUser();
  if (user?.role === "worker" && user.workerId) {
    const reviewsContainer = document.getElementById("workerDashboardReviews");
    if (reviewsContainer) {
      renderWorkerReviews(user.workerId, reviewsContainer);
    }
  }
}

export function initializeReviews() {
  if (initialized) return;
  initialized = true;

  const reviewForm = document.getElementById("reviewForm");
  const replyForm = document.getElementById("workerReplyForm");
  const reviewTextInput = document.getElementById("reviewTextInput");
  const workerReplyInput = document.getElementById("workerReplyInput");

  if (reviewForm) reviewForm.addEventListener("submit", handleReviewFormSubmit);
  if (replyForm) replyForm.addEventListener("submit", handleWorkerReplyFormSubmit);
  if (reviewTextInput) reviewTextInput.addEventListener("input", updateReviewCharCount);
  if (workerReplyInput) workerReplyInput.addEventListener("input", updateReplyCharCount);

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const leaveBtn = target.closest("[data-leave-review]");
    if (leaveBtn) {
      openLeaveReviewModal(leaveBtn.dataset.leaveReview);
      return;
    }

    const viewBtn = target.closest("[data-view-review]");
    if (viewBtn) {
      openViewReviewModal(viewBtn.dataset.viewReview);
      return;
    }

    const replyBtn = target.closest("[data-reply-review]");
    if (replyBtn) {
      openWorkerReplyModal(replyBtn.dataset.replyReview);
      return;
    }

    if (target.closest("#reviewViewDone") || target.closest('[data-close="reviewViewModal"]')) {
      closeModal("reviewViewModal");
      if (isCustomer()) {
        openModal("customerRequestsModal");
      }
    }
  });
}

