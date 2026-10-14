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
  isWorker,
  upsertStoredReview,
  setStoredReviews
} from "./store.js";
import {
  getSafeErrorMessage,
  hasCapability,
  recordSecurityEvent,
  setTextContent,
  validateReview,
  validateText
} from "./security.js";
import {
  createFirestoreReview,
  addFirestoreWorkerReviewReply,
  getWorkerFirestoreReviews,
  getFirestoreReviewById,
  getFirestoreReviewByRequestId
} from "./firestore-service.js";

/**
 * Authoritatively determines if a given review belongs to the authenticated worker.
 * Supports both real Firebase UIDs and legacy/demo numeric IDs.
 *
 * @param {object} review
 * @param {object} user
 * @returns {boolean}
 */
export function isReviewForWorker(review, user) {
  if (!review || !user || user.role !== "worker") return false;
  const userWorkerUids = [
    user.workerUid,
    user.firebaseUid,
    user.uid,
    user.id,
    user.workerId != null ? String(user.workerId) : null,
    user.id && user.id.startsWith("demo-worker-") ? user.id.replace("demo-worker-", "") : null
  ].filter(Boolean).map(String);

  const reviewWorkerUids = [
    review.workerUid,
    review.workerId != null ? String(review.workerId) : null
  ].filter(Boolean).map(String);

  return userWorkerUids.some((uid) => reviewWorkerUids.includes(uid));
}

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

export async function openLeaveReviewModal(requestId) {
  if (!isCustomer() || !hasCapability("customer", "submitReview")) {
    recordSecurityEvent("UNAUTHORIZED_UI_ACTION", getCurrentUser()?.role || null);
    return false;
  }

  const request = getCustomerRequestById(requestId);
  if (!request || request.status !== "Completed") {
    recordSecurityEvent("INVALID_REQUEST", "customer");
    return false;
  }

  let existingReview = getReviewByRequestId(requestId);
  if (!existingReview) {
    try {
      existingReview = await getFirestoreReviewByRequestId(requestId);
      if (existingReview) {
        upsertStoredReview(existingReview);
      }
    } catch {
      // Best-effort lookup
    }
  }

  if (existingReview) {
    await openViewReviewModal(requestId);
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

export async function openViewReviewModal(requestId) {
  let review = getReviewByRequestId(requestId);
  if (!review) {
    try {
      review = await getFirestoreReviewByRequestId(requestId);
      if (review) {
        upsertStoredReview(review);
      }
    } catch {
      // Best-effort lookup
    }
  }
  if (!review) return false;

  setTextContent(document.getElementById("viewReviewWorker"), review.workerName || "Service Professional");
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

export async function openWorkerReplyModal(reviewId) {
  if (!isWorker() || !hasCapability("worker", "manageOwnProfile")) {
    recordSecurityEvent("UNAUTHORIZED_UI_ACTION", getCurrentUser()?.role || null);
    return false;
  }

  let review = getReviewById(reviewId);
  if (!review) {
    try {
      review = await getFirestoreReviewById(reviewId);
      if (review) {
        upsertStoredReview(review);
      }
    } catch {
      // Best-effort lookup
    }
  }

  const user = getCurrentUser();
  if (!review || !isReviewForWorker(review, user)) {
    recordSecurityEvent("UNAUTHORIZED_UI_ACTION", user?.role || null);
    return false;
  }

  activeReplyReviewId = reviewId;
  const form = document.getElementById("workerReplyForm");
  if (form) form.reset();

  setReplyError("");
  setTextContent(document.getElementById("replyTargetCustomer"), review.customerName || "Customer");
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

export async function renderWorkerReviews(workerId, container) {
  if (!container) return;

  if (!workerId) {
    const empty = document.createElement("p");
    empty.className = "worker-dashboard-empty";
    setTextContent(empty, "No reviews received yet for this worker.");
    container.replaceChildren(empty);
    return;
  }

  const loading = document.createElement("div");
  loading.className = "worker-dashboard-loading";
  loading.id = "workerReviewsLoading";
  const spinner = document.createElement("div");
  spinner.className = "spinner";
  spinner.setAttribute("aria-hidden", "true");
  const loadingText = document.createElement("p");
  setTextContent(loadingText, "Loading customer reviews...");
  loading.append(spinner, loadingText);
  container.replaceChildren(loading);

  let firestoreReviews = [];
  let fetchFailed = false;

  try {
    firestoreReviews = await getWorkerFirestoreReviews(workerId);
    if (firestoreReviews && firestoreReviews.length) {
      setStoredReviews(firestoreReviews);
    }
  } catch (err) {
    console.warn("[JKFixHub Review] Reviews fetch notice:", err);
    fetchFailed = true;
  }

  const storedReviews = getReviewsForWorker(workerId);
  const reviewsMap = new Map();
  storedReviews.forEach((r) => { if (r && r.id) reviewsMap.set(r.id, r); });
  firestoreReviews.forEach((r) => { if (r && r.id) reviewsMap.set(r.id, r); });

  const allReviews = Array.from(reviewsMap.values());
  allReviews.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());

  if (allReviews.length === 0) {
    if (fetchFailed) {
      const errorWrap = document.createElement("div");
      errorWrap.className = "worker-dashboard-error";
      errorWrap.id = "workerReviewsError";
      const errorMsg = document.createElement("p");
      setTextContent(errorMsg, "Unable to load reviews. Please check your connection.");
      const retryBtn = document.createElement("button");
      retryBtn.type = "button";
      retryBtn.className = "button subtle";
      setTextContent(retryBtn, "Retry");
      retryBtn.onclick = () => renderWorkerReviews(workerId, container);
      errorWrap.append(errorMsg, retryBtn);
      container.replaceChildren(errorWrap);
      return;
    }

    const empty = document.createElement("p");
    empty.className = "worker-dashboard-empty";
    setTextContent(empty, "No reviews received yet for this worker.");
    container.replaceChildren(empty);
    return;
  }

  const user = getCurrentUser();
  container.replaceChildren(...allReviews.map((rev) => buildReviewCard(rev, isReviewForWorker(rev, user))));
}

async function handleReviewFormSubmit(event) {
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

  const user = getCurrentUser();
  const customerId = user?.firebaseUid || user?.uid || user?.id;
  if (!customerId) {
    setReviewError("Please sign in to submit a review.");
    return;
  }

  const submitBtn = event.target?.querySelector('button[type="submit"]');
  const originalBtnText = submitBtn ? submitBtn.textContent : "Submit Review";
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = "Submitting Review...";
  }

  const finishedRequestId = activeReviewRequestId;

  try {
    const res = await createFirestoreReview({
      customerId,
      requestId: finishedRequestId,
      rating,
      text
    });

    if (!res.success) {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = originalBtnText;
      }
      setReviewError(res.error || "Failed to submit review. Please try again.");
      return;
    }

    try {
      createCustomerReview({
        requestId: finishedRequestId,
        rating,
        text
      });
    } catch {
      // Local sync non-fatal
    }

    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = originalBtnText;
    }

    activeReviewRequestId = null;
    closeModal("reviewModal");
    openViewReviewModal(finishedRequestId);
  } catch (err) {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = originalBtnText;
    }
    setReviewError(err?.message || getSafeErrorMessage("invalidRequest"));
  }
}

async function handleWorkerReplyFormSubmit(event) {
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

  const user = getCurrentUser();
  const workerUid = user?.firebaseUid || user?.uid || user?.id;
  if (!workerUid) {
    setReplyError("Worker sign-in required.");
    return;
  }

  const submitBtn = event.target?.querySelector('button[type="submit"]');
  const originalBtnText = submitBtn ? submitBtn.textContent : "Submit Reply";
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = "Saving Reply...";
  }

  const reviewIdToReply = activeReplyReviewId;

  try {
    const res = await addFirestoreWorkerReviewReply(reviewIdToReply, replyText, workerUid);
    if (!res.success) {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = originalBtnText;
      }
      setReplyError(res.error || "Failed to save reply.");
      return;
    }

    try {
      addWorkerReviewReply(reviewIdToReply, replyText);
    } catch {
      // Local sync non-fatal
    }

    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = originalBtnText;
    }

    activeReplyReviewId = null;
    closeModal("workerReplyModal");
    openModal("authModal");

    // Re-render worker reviews section if open
    if (user?.role === "worker") {
      const reviewsContainer = document.getElementById("workerDashboardReviews");
      if (reviewsContainer) {
        renderWorkerReviews(workerUid, reviewsContainer);
      }
    }
  } catch (err) {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = originalBtnText;
    }
    setReplyError(err?.message || getSafeErrorMessage("invalidRequest"));
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
      openLeaveReviewModal(leaveBtn.dataset.leaveReview).catch((err) => {
        console.warn("[JKFixHub Review] openLeaveReviewModal error:", err);
      });
      return;
    }

    const viewBtn = target.closest("[data-view-review]");
    if (viewBtn) {
      openViewReviewModal(viewBtn.dataset.viewReview).catch((err) => {
        console.warn("[JKFixHub Review] openViewReviewModal error:", err);
      });
      return;
    }

    const replyBtn = target.closest("[data-reply-review]");
    if (replyBtn) {
      openWorkerReplyModal(replyBtn.dataset.replyReview).catch((err) => {
        console.warn("[JKFixHub Review] openWorkerReplyModal error:", err);
      });
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

