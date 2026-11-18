// ==========================================
// #REVIEWS_LOGIC
// ==========================================
// Genuine Customer Reviews, Verified Rating Aggregation, Limited-Time Editing,
// Experience Tags, Sorting, and Worker Replies.
//
// Integrity Principles:
// 1. Never display fake, default, or hardcoded ratings (zero-review workers show "New Worker" / "No ratings yet").
// 2. Only active customers who own a genuinely Completed request can submit one review per request.
// 3. Customers may edit their own published review within 24 hours with an append-only editHistory trail.
// 4. Assigned workers may post/edit one public reply without altering customer rating, text, or status.
// 5. Reporting a review connects to the existing admin moderation queue and never auto-hides the review.
// ==========================================

import { closeModal, openModal } from "./modals.js";
import {
  addWorkerReviewReply,
  calculateWorkerRating,
  createCustomerReview,
  editCustomerReview,
  getCustomerRequestById,
  getCurrentUser,
  getReviewById,
  getReviewByRequestId,
  getReviewsForWorker,
  isCustomer,
  isWorker,
  upsertStoredReview,
  setStoredReviews,
  replaceWorkerStoredReviews,
  syncDiscoveredWorkerRating
} from "./store.js";
import {
  getSafeErrorMessage,
  hasCapability,
  recordSecurityEvent,
  setTextContent,
  validateReview,
  validateText,
  REVIEW_RATING_LABELS,
  REVIEW_EDIT_WINDOW_MS,
  sanitizeReviewTags
} from "./security.js";
import {
  createFirestoreReview,
  updateFirestoreCustomerReview,
  addFirestoreWorkerReviewReply,
  getWorkerFirestoreReviewsWithMeta,
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

/**
 * Determines whether the currently signed-in customer can edit a review (within 24h edit window).
 *
 * @param {object} review
 * @param {object} user
 * @param {number} [nowMs=Date.now()]
 * @returns {{ eligible: boolean, remainingHours: number }}
 */
export function getReviewEditEligibility(review, user, nowMs = Date.now()) {
  if (!review || !user || user.role !== "customer" || user.status === "suspended") {
    return { eligible: false, remainingHours: 0 };
  }
  const uid = user.firebaseUid || user.uid || user.id;
  if (!uid || String(review.customerId) !== String(uid)) {
    return { eligible: false, remainingHours: 0 };
  }
  if (review.status && review.status !== "published") {
    return { eligible: false, remainingHours: 0 };
  }
  // Must have authoritative createdAtMs matching firestore.rules (legacy reviews without createdAtMs remain read-only)
  if (typeof review.createdAtMs !== "number" || Number.isNaN(review.createdAtMs)) {
    return { eligible: false, remainingHours: 0 };
  }
  const expiresMs = review.createdAtMs + REVIEW_EDIT_WINDOW_MS;
  if (nowMs > expiresMs) {
    return { eligible: false, remainingHours: 0 };
  }
  const editCount = Array.isArray(review.editHistory) ? review.editHistory.length : (review.editCount || 0);
  if (editCount >= 10) {
    return { eligible: false, remainingHours: 0 };
  }
  return {
    eligible: true,
    remainingHours: Math.max(1, Math.ceil((expiresMs - nowMs) / (60 * 60 * 1000)))
  };
}

/**
 * Sorts a list of reviews cleanly by "recent" | "highest" | "lowest".
 *
 * @param {Array<object>} reviews
 * @param {"recent"|"highest"|"lowest"} sortMode
 * @returns {Array<object>}
 */
export function sortWorkerReviews(reviews, sortMode = "recent") {
  const list = Array.isArray(reviews) ? [...reviews] : [];
  const toTime = (r) => {
    if (typeof r.createdAtMs === "number") return r.createdAtMs;
    const t = Date.parse(r.createdAt || 0);
    return Number.isNaN(t) ? 0 : t;
  };
  if (sortMode === "highest") {
    list.sort((a, b) => (Number(b.rating) || 0) - (Number(a.rating) || 0) || toTime(b) - toTime(a));
  } else if (sortMode === "lowest") {
    list.sort((a, b) => (Number(a.rating) || 0) - (Number(b.rating) || 0) || toTime(b) - toTime(a));
  } else {
    list.sort((a, b) => toTime(b) - toTime(a));
  }
  return list;
}

const markupPattern = /<\s*\/?\s*[a-z!][^>]*>/i;
const MAX_REVIEW_LENGTH = 1200;
const MAX_REPLY_LENGTH = 600;

let initialized = false;
let activeReviewRequestId = null;
let activeEditReviewId = null;
let lastSubmittedRequestId = null;
let activeReplyReviewId = null;
let activeViewedReviewId = null;
let isSubmittingReview = false;
let isSubmittingReply = false;

function renderStarSymbols(rating) {
  const full = Math.max(1, Math.min(5, Math.round(Number(rating) || 1)));
  return "★".repeat(full) + "☆".repeat(5 - full);
}

function formatReviewDate(raw) {
  if (!raw) return "";
  try {
    const d = typeof raw?.toDate === "function" ? raw.toDate() : new Date(raw);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return "";
  }
}

function updateStarSelectionUI(selectedValue) {
  const ratingVal = Math.max(1, Math.min(5, Number(selectedValue) || 5));
  const labelText = REVIEW_RATING_LABELS[ratingVal] || "Excellent";
  const labelEl = document.getElementById("reviewRatingLabel");
  if (labelEl) {
    setTextContent(labelEl, `${ratingVal} / 5 · ${labelText}`);
  }
  document.querySelectorAll('#reviewForm .star-label').forEach((lbl) => {
    const inp = lbl.querySelector('input[name="reviewRating"]');
    const v = Number(inp?.value || 0);
    lbl.classList.toggle("is-filled", v <= ratingVal);
    lbl.classList.toggle("is-current", v === ratingVal);
  });
}

function getSelectedExperienceTags() {
  const tags = [];
  document.querySelectorAll('#reviewTagsGroup [data-review-tag][aria-pressed="true"]').forEach((btn) => {
    const t = btn.getAttribute("data-review-tag");
    if (t) tags.push(t);
  });
  return sanitizeReviewTags(tags);
}

function setSelectedExperienceTags(tags = []) {
  const cleanSet = new Set(sanitizeReviewTags(tags));
  document.querySelectorAll("#reviewTagsGroup [data-review-tag]").forEach((btn) => {
    const t = btn.getAttribute("data-review-tag");
    const active = cleanSet.has(t);
    btn.setAttribute("aria-pressed", active ? "true" : "false");
    btn.classList.toggle("is-selected", active);
  });
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

function toggleReviewModalMode(showSuccess, { isEdit = false, rating = 5 } = {}) {
  const formSec = document.getElementById("reviewFormSection");
  const successSec = document.getElementById("reviewSuccessSection");
  if (formSec) formSec.hidden = Boolean(showSuccess);
  if (successSec) {
    successSec.hidden = !showSuccess;
    if (showSuccess) {
      setTextContent(
        document.getElementById("reviewSuccessHeading"),
        isEdit ? "Review updated" : "Thank you for your review"
      );
      setTextContent(
        document.getElementById("reviewSuccessMessage"),
        isEdit
          ? "Your updated review has been saved and the technician's rating has been recalculated."
          : "Your verified feedback has been published and now contributes to this technician's genuine rating."
      );
      setTextContent(
        document.getElementById("reviewSuccessRating"),
        `${renderStarSymbols(rating)} · ${rating}.0 / 5 (${REVIEW_RATING_LABELS[rating] || ""})`
      );
    }
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

  const user = getCurrentUser();
  if (user?.status === "suspended") {
    recordSecurityEvent("UNAUTHORIZED_UI_ACTION", user?.role || "customer");
    return false;
  }
  const callerUid = user?.firebaseUid || user?.uid || user?.id;
  const workerTargetUid = request.workerUid || (request.workerId ? String(request.workerId) : null);
  if (callerUid && workerTargetUid && callerUid === workerTargetUid) {
    recordSecurityEvent("UNAUTHORIZED_UI_ACTION", user?.role || null);
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
  activeEditReviewId = null;
  const form = document.getElementById("reviewForm");
  if (form) form.reset();

  toggleReviewModalMode(false);
  setReviewError("");
  setTextContent(document.getElementById("reviewModalTag"), "Verified Customer Review");
  setTextContent(document.getElementById("reviewModalTitle"), "Leave a review.");
  setTextContent(document.getElementById("reviewModalSubtitle"), "Share honest feedback on your completed service request.");
  setTextContent(document.getElementById("reviewTargetWorker"), request.workerName);
  setTextContent(document.getElementById("reviewTargetService"), request.service);
  setTextContent(document.getElementById("reviewTargetDistrict"), request.district);
  setTextContent(document.getElementById("reviewSubmitButton"), "Submit Review");
  const editNotice = document.getElementById("reviewEditNotice");
  if (editNotice) editNotice.hidden = true;

  // Default to 5 stars selected
  const starInputs = document.querySelectorAll('input[name="reviewRating"]');
  starInputs.forEach((input) => {
    input.checked = input.value === "5";
  });
  updateStarSelectionUI(5);
  setSelectedExperienceTags([]);
  updateReviewCharCount();

  closeModal("customerRequestsModal");
  closeModal("customerRequestDetailsModal");
  openModal("reviewModal");
  document.getElementById("reviewTextInput")?.focus();
  return true;
}

export async function openEditReviewModal(reviewIdOrRequestId) {
  const user = getCurrentUser();
  if (!isCustomer() || user?.status === "suspended") {
    recordSecurityEvent("UNAUTHORIZED_UI_ACTION", user?.role || null);
    return false;
  }

  let review = getReviewById(reviewIdOrRequestId) || getReviewByRequestId(reviewIdOrRequestId);
  if (!review) {
    try {
      review = await getFirestoreReviewById(reviewIdOrRequestId) || await getFirestoreReviewByRequestId(reviewIdOrRequestId);
      if (review) upsertStoredReview(review);
    } catch {}
  }
  if (!review) return false;

  const eligibility = getReviewEditEligibility(review, user);
  if (!eligibility.eligible) {
    return false;
  }

  activeReviewRequestId = review.requestId || review.id;
  activeEditReviewId = review.id;

  const form = document.getElementById("reviewForm");
  if (form) form.reset();

  toggleReviewModalMode(false);
  setReviewError("");
  setTextContent(document.getElementById("reviewModalTag"), "Edit Verified Review");
  setTextContent(document.getElementById("reviewModalTitle"), "Edit your review.");
  setTextContent(document.getElementById("reviewModalSubtitle"), "Previous versions are preserved in the audit trail.");
  setTextContent(document.getElementById("reviewTargetWorker"), review.workerName || "Service Professional");
  setTextContent(document.getElementById("reviewTargetService"), review.service || "Completed Service");
  setTextContent(document.getElementById("reviewTargetDistrict"), review.district || "Jammu & Kashmir");
  setTextContent(document.getElementById("reviewSubmitButton"), "Save Changes");

  const editNotice = document.getElementById("reviewEditNotice");
  if (editNotice) {
    setTextContent(
      editNotice,
      `Limited-time edit window: ~${eligibility.remainingHours} ${eligibility.remainingHours === 1 ? "hour" : "hours"} remaining. Request & technician identity cannot be changed.`
    );
    editNotice.hidden = false;
  }

  const currentRating = Number(review.rating) || 5;
  document.querySelectorAll('input[name="reviewRating"]').forEach((input) => {
    input.checked = Number(input.value) === currentRating;
  });
  updateStarSelectionUI(currentRating);
  setSelectedExperienceTags(review.tags || []);

  const textInput = document.getElementById("reviewTextInput");
  if (textInput) textInput.value = review.text || "";
  updateReviewCharCount();

  closeModal("reviewViewModal");
  closeModal("customerRequestsModal");
  openModal("reviewModal");
  textInput?.focus();
  return true;
}

export async function openViewReviewModal(requestId) {
  let review = getReviewByRequestId(requestId) || getReviewById(requestId);
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

  activeViewedReviewId = review.id;
  const ratingLabel = REVIEW_RATING_LABELS[Number(review.rating)] || "";
  setTextContent(document.getElementById("viewReviewWorker"), review.workerName || "Service Professional");
  setTextContent(
    document.getElementById("viewReviewRating"),
    `${renderStarSymbols(review.rating)} ${review.rating}.0${ratingLabel ? ` · ${ratingLabel}` : ""}`
  );
  setTextContent(document.getElementById("viewReviewDate"), formatReviewDate(review.createdAt));

  const editedNote = document.getElementById("viewReviewEditedNote");
  if (editedNote) {
    if (review.editedAt || (Array.isArray(review.editHistory) && review.editHistory.length > 0)) {
      const count = Array.isArray(review.editHistory) ? review.editHistory.length : (review.editCount || 1);
      setTextContent(editedNote, `Edited (${count})`);
      editedNote.hidden = false;
    } else {
      editedNote.hidden = true;
    }
  }

  const tagsWrap = document.getElementById("viewReviewTags");
  if (tagsWrap) {
    tagsWrap.replaceChildren();
    const tags = sanitizeReviewTags(review.tags || []);
    if (tags.length > 0) {
      tags.forEach((tag) => {
        const chip = document.createElement("span");
        chip.className = "review-tag-pill";
        setTextContent(chip, tag);
        tagsWrap.appendChild(chip);
      });
      tagsWrap.hidden = false;
    } else {
      tagsWrap.hidden = true;
    }
  }

  const bodyEl = document.getElementById("viewReviewText");
  if (bodyEl) {
    setTextContent(bodyEl, review.text || "Rated without additional written commentary.");
  }

  const replySection = document.getElementById("viewReviewReplySection");
  if (replySection) {
    if (review.workerReply) {
      replySection.hidden = false;
      setTextContent(document.getElementById("viewReviewWorkerReply"), review.workerReply);
      const replyDateStr = review.workerReplyAt ? formatReviewDate(review.workerReplyAt) : "";
      const editedSuffix = review.workerReplyUpdatedAt ? " · Edited" : "";
      setTextContent(
        document.getElementById("viewReviewWorkerReplyDate"),
        replyDateStr ? `Replied on ${replyDateStr}${editedSuffix}` : `Worker reply${editedSuffix}`
      );
    } else {
      replySection.hidden = true;
    }
  }

  const editBtn = document.getElementById("reviewViewEditBtn");
  if (editBtn) {
    const elig = getReviewEditEligibility(review, getCurrentUser());
    editBtn.hidden = !elig.eligible;
    if (elig.eligible) {
      editBtn.dataset.editReview = review.id;
    } else {
      delete editBtn.dataset.editReview;
    }
  }

  closeModal("customerRequestsModal");
  closeModal("customerRequestDetailsModal");
  closeModal("reviewModal");
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
  setTextContent(document.getElementById("replyTargetRating"), `${review.rating}.0 ★`);
  setTextContent(document.getElementById("replyTargetReviewText"), review.text || "Rated without written comment.");

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
  const authorWrap = document.createElement("div");
  const author = document.createElement("strong");
  const verifiedPill = document.createElement("span");
  const meta = document.createElement("div");
  const stars = document.createElement("span");
  const date = document.createElement("time");

  card.className = "review-card";
  card.dataset.reviewId = review.id;
  header.className = "review-card-header";
  authorWrap.className = "review-author-wrap";
  author.className = "review-author";
  setTextContent(author, review.customerName || "Customer");

  verifiedPill.className = "review-verified-pill";
  setTextContent(verifiedPill, "Verified Completed Service");
  authorWrap.append(author, verifiedPill);

  meta.className = "review-card-meta";
  stars.className = "review-rating-stars";
  stars.setAttribute("aria-label", `${review.rating} out of 5 stars`);
  setTextContent(stars, `${renderStarSymbols(review.rating)} ${Number(review.rating).toFixed(1)}`);
  date.className = "review-date";
  setTextContent(date, formatReviewDate(review.createdAt));
  meta.append(stars, date);

  if (review.editedAt || (Array.isArray(review.editHistory) && review.editHistory.length > 0)) {
    const editedTag = document.createElement("span");
    editedTag.className = "review-edited-pill";
    setTextContent(editedTag, "Edited");
    meta.appendChild(editedTag);
  }

  header.append(authorWrap, meta);
  card.append(header);

  // Optional experience tags
  const tags = sanitizeReviewTags(review.tags || []);
  if (tags.length > 0) {
    const tagsRow = document.createElement("div");
    tagsRow.className = "review-tags-list";
    for (const t of tags) {
      const chip = document.createElement("span");
      chip.className = "review-tag-pill";
      setTextContent(chip, t);
      tagsRow.appendChild(chip);
    }
    card.appendChild(tagsRow);
  }

  if (review.text && String(review.text).trim()) {
    const text = document.createElement("p");
    text.className = "review-text";
    setTextContent(text, review.text);
    card.appendChild(text);
  } else {
    const text = document.createElement("p");
    text.className = "review-text is-muted";
    setTextContent(text, "Verified star rating without additional written comment.");
    card.appendChild(text);
  }

  if (review.workerReply) {
    const replyBox = document.createElement("div");
    const replyHeader = document.createElement("div");
    const replyAuthor = document.createElement("strong");
    const replyDate = document.createElement("time");
    const replyText = document.createElement("p");

    replyBox.className = "worker-reply-box";
    replyHeader.className = "worker-reply-header";
    setTextContent(replyAuthor, `${review.workerName || "Service Professional"} · Worker Response`);
    const dateStr = review.workerReplyAt ? formatReviewDate(review.workerReplyAt) : "";
    const editedSuffix = review.workerReplyUpdatedAt ? " · Edited" : "";
    if (dateStr || editedSuffix) {
      setTextContent(replyDate, `${dateStr}${editedSuffix}`);
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

  const user = getCurrentUser();
  if (getReviewEditEligibility(review, user).eligible) {
    const editBtn = document.createElement("button");
    editBtn.className = "button subtle";
    editBtn.type = "button";
    editBtn.dataset.editReview = review.id;
    setTextContent(editBtn, "Edit Review");
    actions.append(editBtn);
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

function buildRatingSummaryCard(summary) {
  const summaryCard = document.createElement("div");
  summaryCard.className = "worker-reviews-aggregate-card";

  // Left score overview
  const overview = document.createElement("div");
  overview.className = "reviews-aggregate-overview";

  const avgNumber = document.createElement("span");
  avgNumber.className = "reviews-aggregate-number";
  setTextContent(avgNumber, summary.average.toFixed(1));

  const avgStars = document.createElement("span");
  avgStars.className = "reviews-aggregate-stars";
  avgStars.setAttribute("aria-label", `${summary.average.toFixed(1)} out of 5 stars`);
  setTextContent(avgStars, renderStarSymbols(summary.average));

  const countWrap = document.createElement("div");
  countWrap.className = "reviews-aggregate-count";
  setTextContent(
    countWrap,
    `Based on ${summary.reviewCount} ${summary.reviewCount === 1 ? "verified review" : "verified reviews"}`
  );

  overview.append(avgNumber, avgStars, countWrap);

  // Right 5-star distribution breakdown
  const distWrap = document.createElement("div");
  distWrap.className = "reviews-distribution";
  distWrap.setAttribute("aria-label", "Rating distribution");

  const dist = summary.distribution || { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  for (let star = 5; star >= 1; star--) {
    const count = dist[star] || 0;
    const pct = summary.reviewCount > 0 ? Math.round((count / summary.reviewCount) * 100) : 0;

    const row = document.createElement("div");
    row.className = "reviews-dist-row";

    const label = document.createElement("span");
    label.className = "reviews-dist-label";
    setTextContent(label, `${star} ★`);

    const track = document.createElement("div");
    track.className = "reviews-dist-track";
    const fill = document.createElement("div");
    fill.className = "reviews-dist-fill";
    fill.style.width = `${pct}%`;
    track.appendChild(fill);

    const countEl = document.createElement("span");
    countEl.className = "reviews-dist-count";
    setTextContent(countEl, String(count));

    row.append(label, track, countEl);
    distWrap.appendChild(row);
  }

  summaryCard.append(overview, distWrap);
  return summaryCard;
}

function buildZeroReviewEmptyState() {
  const emptyWrap = document.createElement("div");
  emptyWrap.className = "worker-reviews-empty-state";

  const pill = document.createElement("span");
  pill.className = "worker-new-badge";
  setTextContent(pill, "New Worker");

  const heading = document.createElement("strong");
  heading.className = "reviews-empty-title";
  setTextContent(heading, "No ratings yet");

  const copy = document.createElement("p");
  copy.className = "reviews-empty-copy";
  setTextContent(copy, "Be the first customer to review this worker.");

  emptyWrap.append(pill, heading, copy);
  return emptyWrap;
}

export async function renderWorkerReviews(workerId, container, options = {}) {
  if (!container) return;

  if (!workerId) {
    container.replaceChildren(buildZeroReviewEmptyState());
    if (typeof options.onSummaryUpdate === "function") {
      options.onSummaryUpdate(calculateWorkerRating([]));
    }
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
  let fromFirestore = false;
  let fetchFailed = false;

  try {
    const res = await getWorkerFirestoreReviewsWithMeta(workerId);
    firestoreReviews = Array.isArray(res?.reviews) ? res.reviews : [];
    fromFirestore = Boolean(res?.fromFirestore);
    if (fromFirestore) {
      // Authoritative live Firestore result replaces cached reviews for this worker
      // so reviews hidden by admins immediately disappear from memory & ratings.
      replaceWorkerStoredReviews(workerId, firestoreReviews);
    }
  } catch (err) {
    console.warn("[JKFixHub Review] Reviews fetch notice:", err);
    fetchFailed = true;
  }

  let allPublishedReviews;
  if (fromFirestore) {
    allPublishedReviews = firestoreReviews.filter((r) => r && r.id && r.status === "published");
  } else {
    const storedReviews = getReviewsForWorker(workerId);
    allPublishedReviews = storedReviews.filter((r) => r && r.id && (!r.status || r.status === "published"));
  }
  const summary = calculateWorkerRating(allPublishedReviews);
  syncDiscoveredWorkerRating(workerId, summary);
  if (typeof options.onSummaryUpdate === "function") {
    try {
      options.onSummaryUpdate(summary);
    } catch {}
  }

  if (allPublishedReviews.length === 0) {
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
      retryBtn.onclick = () => renderWorkerReviews(workerId, container, options);
      errorWrap.append(errorMsg, retryBtn);
      container.replaceChildren(errorWrap);
      return;
    }

    container.replaceChildren(buildZeroReviewEmptyState());
    return;
  }

  const user = getCurrentUser();
  let activeSort = options.initialSort || "recent";

  const wrapper = document.createElement("div");
  wrapper.className = "worker-reviews-shell";

  if (summary.reviewCount > 0) {
    wrapper.appendChild(buildRatingSummaryCard(summary));
  }

  // Sort toolbar
  const sortBar = document.createElement("div");
  sortBar.className = "reviews-sort-bar";

  const sortLabel = document.createElement("label");
  sortLabel.className = "reviews-sort-label";
  const sortSelectId = `reviewsSort_${String(workerId).replace(/[^a-zA-Z0-9_-]/g, "")}`;
  sortLabel.setAttribute("for", sortSelectId);
  setTextContent(sortLabel, "Sort reviews:");

  const sortSelect = document.createElement("select");
  sortSelect.id = sortSelectId;
  sortSelect.className = "reviews-sort-select";
  sortSelect.setAttribute("aria-label", "Sort customer reviews");
  [
    ["recent", "Most recent"],
    ["highest", "Highest rated"],
    ["lowest", "Lowest rated"]
  ].forEach(([val, txt]) => {
    const opt = document.createElement("option");
    opt.value = val;
    opt.selected = val === activeSort;
    setTextContent(opt, txt);
    sortSelect.appendChild(opt);
  });

  sortBar.append(sortLabel, sortSelect);
  wrapper.appendChild(sortBar);

  const cardsList = document.createElement("div");
  cardsList.className = "reviews-cards-list";
  wrapper.appendChild(cardsList);

  const mountCards = () => {
    const sorted = sortWorkerReviews(allPublishedReviews, activeSort);
    cardsList.replaceChildren(...sorted.map((rev) => buildReviewCard(rev, isReviewForWorker(rev, user))));
  };

  sortSelect.addEventListener("change", () => {
    activeSort = sortSelect.value;
    mountCards();
  });

  mountCards();
  container.replaceChildren(wrapper);
}

async function handleReviewFormSubmit(event) {
  event.preventDefault();
  if (isSubmittingReview || !activeReviewRequestId) return;

  const ratingInput = document.querySelector('input[name="reviewRating"]:checked');
  const textInput = document.getElementById("reviewTextInput");
  if (!ratingInput || !textInput) return;

  const rating = Number(ratingInput.value);
  const text = textInput.value.trim();
  const tags = getSelectedExperienceTags();

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
  if (user?.status === "suspended") {
    const reasonPart = user.suspensionReason ? ` Reason: ${user.suspensionReason}` : "";
    setReviewError(`Your account is currently suspended and cannot submit new reviews.${reasonPart}`);
    return;
  }

  const submitBtn = document.getElementById("reviewSubmitButton") || event.target?.querySelector('button[type="submit"]');
  const originalBtnText = submitBtn ? submitBtn.textContent : "Submit Review";
  const isEditing = Boolean(activeEditReviewId);

  isSubmittingReview = true;
  setReviewError("");
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = isEditing ? "Saving Changes..." : "Submitting Review...";
  }

  const finishedRequestId = activeReviewRequestId;
  const editReviewId = activeEditReviewId;

  try {
    if (isEditing) {
      let savedReview = null;
      if (user.authProvider === "firebase") {
        const res = await updateFirestoreCustomerReview(editReviewId, {
          rating,
          text,
          tags,
          customerId
        });
        if (!res.success) {
          setReviewError(res.error || "Failed to update review. Please try again.");
          return;
        }
        savedReview = res.review;
      }

      try {
        const localUpdated = editCustomerReview(editReviewId, { rating, text, tags });
        if (!savedReview) savedReview = localUpdated;
      } catch (localErr) {
        if (!savedReview) {
          setReviewError(localErr?.message || "Failed to update review.");
          return;
        }
      }

      if (savedReview) {
        upsertStoredReview(savedReview);
        const targetWrk = savedReview.workerUid || savedReview.workerId;
        if (targetWrk) {
          syncDiscoveredWorkerRating(targetWrk);
          if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("jkfixhub:ratings-updated", { detail: { workerId: String(targetWrk) } }));
          }
        }
      }
    } else {
      let savedReview = null;
      if (user.authProvider === "firebase") {
        const res = await createFirestoreReview({
          customerId,
          requestId: finishedRequestId,
          rating,
          text,
          tags
        });

        if (!res.success) {
          setReviewError(res.error || "Failed to submit review. Please try again.");
          return;
        }
        savedReview = res.review;
      }

      try {
        const localCreated = createCustomerReview({
          requestId: finishedRequestId,
          rating,
          text,
          tags
        });
        if (!savedReview) savedReview = localCreated;
      } catch (localErr) {
        if (!savedReview) {
          setReviewError(localErr?.message || "Failed to submit review.");
          return;
        }
      }

      if (savedReview) {
        upsertStoredReview(savedReview);
        const targetWrk = savedReview.workerUid || savedReview.workerId;
        if (targetWrk) {
          syncDiscoveredWorkerRating(targetWrk);
          if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("jkfixhub:ratings-updated", { detail: { workerId: String(targetWrk) } }));
          }
        }
      }
    }

    lastSubmittedRequestId = finishedRequestId;
    activeReviewRequestId = null;
    activeEditReviewId = null;
    toggleReviewModalMode(true, { isEdit: isEditing, rating });
  } catch (err) {
    setReviewError(err?.message || getSafeErrorMessage("invalidRequest"));
  } finally {
    isSubmittingReview = false;
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = originalBtnText;
    }
  }
}

async function handleWorkerReplyFormSubmit(event) {
  event.preventDefault();
  if (isSubmittingReply || !activeReplyReviewId) return;

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
  const originalBtnText = submitBtn ? submitBtn.textContent : "Publish Response";
  isSubmittingReply = true;
  setReplyError("");
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = "Saving Reply...";
  }

  const reviewIdToReply = activeReplyReviewId;

  try {
    if (user.authProvider === "firebase") {
      const res = await addFirestoreWorkerReviewReply(reviewIdToReply, replyText, workerUid);
      if (!res.success) {
        setReplyError(res.error || "Failed to save reply.");
        return;
      }
    }

    try {
      addWorkerReviewReply(reviewIdToReply, replyText);
    } catch (localErr) {
      if (user.authProvider !== "firebase") {
        setReplyError(localErr?.message || "Failed to save reply.");
        return;
      }
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
    setReplyError(err?.message || getSafeErrorMessage("invalidRequest"));
  } finally {
    isSubmittingReply = false;
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = originalBtnText;
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

  if (reviewForm) {
    reviewForm.addEventListener("submit", handleReviewFormSubmit);
    reviewForm.addEventListener("change", (evt) => {
      if (evt.target && evt.target.name === "reviewRating") {
        updateStarSelectionUI(evt.target.value);
      }
    });
  }
  if (replyForm) replyForm.addEventListener("submit", handleWorkerReplyFormSubmit);
  if (reviewTextInput) reviewTextInput.addEventListener("input", updateReviewCharCount);
  if (workerReplyInput) workerReplyInput.addEventListener("input", updateReplyCharCount);

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const tagBtn = target.closest("[data-review-tag]");
    if (tagBtn) {
      const pressed = tagBtn.getAttribute("aria-pressed") === "true";
      tagBtn.setAttribute("aria-pressed", pressed ? "false" : "true");
      tagBtn.classList.toggle("is-selected", !pressed);
      return;
    }

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

    const editBtn = target.closest("[data-edit-review]");
    if (editBtn) {
      openEditReviewModal(editBtn.dataset.editReview).catch((err) => {
        console.warn("[JKFixHub Review] openEditReviewModal error:", err);
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

    if (target.closest("#reviewSuccessViewBtn")) {
      const reqId = lastSubmittedRequestId;
      closeModal("reviewModal");
      if (reqId) {
        openViewReviewModal(reqId).catch(() => {});
      }
      return;
    }

    if (target.closest("#reviewSuccessDoneBtn")) {
      closeModal("reviewModal");
      if (isCustomer()) {
        openModal("customerRequestsModal");
      }
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
