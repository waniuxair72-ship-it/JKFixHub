/**
 * @file review-logic.js
 * @description Trusted review submission, limited-time editing, genuine rating aggregation,
 * and eligibility enforcement for JK FixHub backend.
 *
 * Security Principles:
 * 1. Only authenticated active (non-suspended) customers who own the request can submit a review.
 * 2. Request status must authoritatively be "Completed" in Firestore.
 * 3. Exactly one review per eligible request (canonical deterministic doc ID == requestId).
 * 4. Rating strictly bounded to integers 1–5; never default or fabricate ratings.
 * 5. Optional written comment (0–1,200 chars) and whitelisted experience tags sanitized against injection.
 * 6. Worker aggregate ratings are always recalculated authoritatively from genuine published reviews only.
 */

const { HttpsError } = require("firebase-functions/v2/https");
const { FieldValue } = require("firebase-admin/firestore");
const { assertAuthenticated } = require("./auth-helpers");
const { validateRequestId, fetchAuthoritativeRequest } = require("./request-lifecycle");
const { recordAuditEvent, recordSecurityEvent } = require("./audit-logger");

const SCRIPT_INJECTION_PATTERN = /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi;
const HTML_TAG_PATTERN = /<\/?[a-z][\s\S]*>/gi;
const MAX_REVIEW_LENGTH = 1200;
const REVIEW_EDIT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_REVIEW_EDITS = 10;

const REVIEW_TYPES = Object.freeze({
  VERIFIED_WORK: "verified_work",
  UNVERIFIED_EXPERIENCE: "unverified_experience"
});

const REVIEW_EXPERIENCE_TAGS = Object.freeze([
  "Punctual",
  "Professional",
  "Good communication",
  "Quality work",
  "Fair pricing",
  "Friendly behaviour"
]);

function resolveReviewType(review) {
  if (!review || typeof review !== "object") return REVIEW_TYPES.VERIFIED_WORK;
  if (review.reviewType === REVIEW_TYPES.UNVERIFIED_EXPERIENCE) {
    return REVIEW_TYPES.UNVERIFIED_EXPERIENCE;
  }
  if (review.reviewType === REVIEW_TYPES.VERIFIED_WORK) {
    return REVIEW_TYPES.VERIFIED_WORK;
  }
  // Backward compatibility: legacy reviews linked to a requestId are Verified Work
  if (review.verifiedService === false && !review.requestId) {
    return REVIEW_TYPES.UNVERIFIED_EXPERIENCE;
  }
  return REVIEW_TYPES.VERIFIED_WORK;
}

/**
 * Sanitizes optional experience tags against the authoritative allowlist.
 * @param {unknown} tags
 * @returns {string[]}
 */
function sanitizeReviewTags(tags) {
  if (tags === undefined || tags === null) return [];
  if (!Array.isArray(tags)) {
    throw new HttpsError("invalid-argument", "Experience tags must be an array.");
  }
  const allowedLower = new Map(REVIEW_EXPERIENCE_TAGS.map((t) => [t.toLowerCase(), t]));
  const result = [];
  const seen = new Set();
  for (const item of tags) {
    if (typeof item !== "string") continue;
    const canonical = allowedLower.get(item.trim().toLowerCase());
    if (canonical && !seen.has(canonical)) {
      seen.add(canonical);
      result.push(canonical);
    }
  }
  return result.slice(0, REVIEW_EXPERIENCE_TAGS.length);
}

/**
 * Computes genuine worker rating aggregates from a list of reviews.
 * Excludes hidden, flagged, rejected, deleted, or malformed reviews.
 * Uses integer-scaled half-up rounding to 1 decimal place to avoid floating-point drift.
 *
 * @param {Array<object>} reviews
 * @returns {{ rating: number|null, reviewCount: number, distribution: Record<number, number> }}
 */
function calculateGenuineWorkerRating(reviews) {
  const distribution = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  if (!Array.isArray(reviews) || reviews.length === 0) {
    return {
      rating: null,
      reviewCount: 0,
      verifiedWorkCount: 0,
      verifiedWorkAverage: null,
      unverifiedCount: 0,
      distribution
    };
  }

  const seen = new Set();
  let sum = 0;
  let count = 0;
  let verifiedSum = 0;
  let verifiedCount = 0;
  let unverifiedCount = 0;

  for (const r of reviews) {
    if (!r || typeof r !== "object") continue;
    if (r.status !== "published") continue;

    const rType = resolveReviewType(r);
    const dedupKey = rType === REVIEW_TYPES.UNVERIFIED_EXPERIENCE
      ? (r.id || `unv-${r.workerUid || r.workerId}-${r.customerId}`)
      : (r.requestId || r.id);
    if (dedupKey) {
      if (seen.has(String(dedupKey))) continue;
      seen.add(String(dedupKey));
    }

    const val = Number(r.rating);
    if (!Number.isInteger(val) || val < 1 || val > 5) continue;

    sum += val;
    count += 1;
    distribution[val] += 1;
    if (rType === REVIEW_TYPES.VERIFIED_WORK) {
      verifiedSum += val;
      verifiedCount += 1;
    } else {
      unverifiedCount += 1;
    }
  }

  if (count === 0) {
    return {
      rating: null,
      reviewCount: 0,
      verifiedWorkCount: 0,
      verifiedWorkAverage: null,
      unverifiedCount: 0,
      distribution
    };
  }

  // Exact integer-scaled half-up rounding to 1 decimal place
  const average = Math.round((sum * 10) / count) / 10;
  const verifiedWorkAverage = verifiedCount > 0 ? Math.round((verifiedSum * 10) / verifiedCount) / 10 : null;
  return {
    rating: average,
    reviewCount: count,
    verifiedWorkCount: verifiedCount,
    verifiedWorkAverage,
    unverifiedCount,
    distribution
  };
}

/**
 * Authoritatively recalculates a worker's rating & reviewCount from published reviews
 * in Firestore and persists them onto /workers/{workerUid} (if the worker doc exists).
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} workerUid
 * @returns {Promise<{ rating: number|null, reviewCount: number, distribution: Record<number, number> }>}
 */
async function recalculateAndPersistWorkerRating(db, workerUid) {
  if (!db || !workerUid) {
    return { rating: null, reviewCount: 0, distribution: { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 } };
  }

  const targetId = String(workerUid);
  const collected = [];
  const seenDocIds = new Set();

  try {
    const snap = await db
      .collection("reviews")
      .where("workerUid", "==", targetId)
      .where("status", "==", "published")
      .get();

    if (snap && Array.isArray(snap.docs)) {
      for (const doc of snap.docs) {
        if (seenDocIds.has(doc.id)) continue;
        seenDocIds.add(doc.id);
        collected.push({ id: doc.id, ...doc.data() });
      }
    }
  } catch {
    // Fallback query by workerId
  }

  try {
    const legacySnap = await db
      .collection("reviews")
      .where("workerId", "==", targetId)
      .where("status", "==", "published")
      .get();

    if (legacySnap && Array.isArray(legacySnap.docs)) {
      for (const doc of legacySnap.docs) {
        if (seenDocIds.has(doc.id)) continue;
        seenDocIds.add(doc.id);
        collected.push({ id: doc.id, ...doc.data() });
      }
    }
  } catch {
    // Non-fatal fallback
  }

  const summary = calculateGenuineWorkerRating(collected);

  try {
    const workerRef = db.collection("workers").doc(targetId);
    const workerSnap = await workerRef.get();
    if (workerSnap && workerSnap.exists) {
      await workerRef.update({
        rating: summary.rating,
        reviewCount: summary.reviewCount,
        verifiedWorkCount: summary.verifiedWorkCount,
        verifiedWorkAverage: summary.verifiedWorkAverage,
        unverifiedCount: summary.unverifiedCount,
        ratingDistribution: summary.distribution,
        ratingUpdatedAt: FieldValue.serverTimestamp()
      });
    }
  } catch {
    // Worker doc may not exist in minimal unit-test mocks; calculation still returned
  }

  return summary;
}

/**
 * Validates review submission or edit input.
 * @param {object} data
 */
function validateReviewInput(data) {
  if (!data || typeof data !== "object") {
    throw new HttpsError("invalid-argument", "Review payload must be an object.");
  }

  const { requestId, rating, text = "", tags = [] } = data;
  validateRequestId(requestId);

  const numRating = Number(rating);
  if (!Number.isInteger(numRating) || numRating < 1 || numRating > 5) {
    throw new HttpsError(
      "invalid-argument",
      "Rating must be an integer between 1 and 5."
    );
  }

  if (text !== undefined && text !== null && typeof text !== "string") {
    throw new HttpsError("invalid-argument", "Review text must be a string.");
  }

  const trimmedText = typeof text === "string" ? text.trim() : "";
  if (trimmedText.length > MAX_REVIEW_LENGTH) {
    throw new HttpsError(
      "invalid-argument",
      `Review text must be ${MAX_REVIEW_LENGTH} characters or fewer.`
    );
  }

  if (SCRIPT_INJECTION_PATTERN.test(trimmedText)) {
    throw new HttpsError(
      "invalid-argument",
      "Review text contains disallowed script content."
    );
  }

  const cleanText = trimmedText.replace(HTML_TAG_PATTERN, "").trim();
  const cleanTags = sanitizeReviewTags(tags);

  return {
    requestId: requestId.trim(),
    rating: numRating,
    cleanText,
    cleanTags
  };
}

/**
 * Checks whether the calling customer account is suspended.
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} uid
 */
async function assertCustomerNotSuspended(db, uid) {
  try {
    const userSnap = await db.collection("users").doc(uid).get();
    if (userSnap && userSnap.exists && userSnap.data()?.status === "suspended") {
      throw new HttpsError(
        "permission-denied",
        "Your account is currently suspended and cannot submit or edit reviews."
      );
    }
  } catch (err) {
    if (err instanceof HttpsError) throw err;
  }
}

/**
 * Submits a validated customer review for an authoritatively completed service request.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {object} request - Functions v2 callable request.
 * @returns {Promise<{ success: boolean, reviewId: string, ratingSummary?: object }>}
 */
async function submitReview(db, request) {
  const uid = assertAuthenticated(request);
  const { requestId, rating, cleanText, cleanTags } = validateReviewInput(request.data);

  // 0. Ensure customer account is active (not suspended)
  await assertCustomerNotSuspended(db, uid);

  // Authoritatively inspect request document
  const { data: requestData } = await fetchAuthoritativeRequest(db, requestId);

  // 1. Verify customer ownership
  if (!requestData.customerId || requestData.customerId !== uid) {
    await recordSecurityEvent(db, {
      type: "UNAUTHORIZED_REVIEW_ATTEMPT",
      actorUid: uid,
      targetType: "request",
      targetId: requestId,
      severity: "High",
      details: { caller: uid, owner: requestData.customerId }
    });
    throw new HttpsError(
      "permission-denied",
      "You may only submit reviews for your own service requests."
    );
  }

  // 1b. Verify worker is not reviewing themselves
  if (requestData.workerUid === uid || (requestData.workerId && String(requestData.workerId) === String(uid))) {
    await recordSecurityEvent(db, {
      type: "SELF_REVIEW_ATTEMPT",
      actorUid: uid,
      targetType: "request",
      targetId: requestId,
      severity: "High",
      details: { caller: uid, worker: requestData.workerUid }
    });
    throw new HttpsError(
      "failed-precondition",
      "Workers cannot submit reviews for their own service requests."
    );
  }

  // 2. Verify authoritative completion
  if (requestData.status !== "Completed") {
    await recordSecurityEvent(db, {
      type: "PREMATURE_REVIEW_ATTEMPT",
      actorUid: uid,
      targetType: "request",
      targetId: requestId,
      severity: "Medium",
      details: { currentStatus: requestData.status }
    });
    throw new HttpsError(
      "failed-precondition",
      `Reviews can only be submitted for completed service requests. Current status: '${requestData.status}'.`
    );
  }

  // 3. Verify exactly one review per request (canonical ID + legacy rev- ID + query check)
  const reviewRef = db.collection("reviews").doc(requestId);
  const existingDocSnap = await reviewRef.get();
  const legacyDocSnap = await db.collection("reviews").doc(`rev-${requestId}`).get();

  if (existingDocSnap.exists || legacyDocSnap.exists) {
    await recordSecurityEvent(db, {
      type: "DUPLICATE_REVIEW_ATTEMPT",
      actorUid: uid,
      targetType: "request",
      targetId: requestId,
      severity: "Low",
      details: { existingReviewId: existingDocSnap.exists ? requestId : `rev-${requestId}` }
    });
    throw new HttpsError(
      "already-exists",
      "A review has already been submitted for this service request."
    );
  }

  const existingSnap = await db
    .collection("reviews")
    .where("requestId", "==", requestId)
    .limit(1)
    .get();

  if (!existingSnap.empty) {
    await recordSecurityEvent(db, {
      type: "DUPLICATE_REVIEW_ATTEMPT",
      actorUid: uid,
      targetType: "request",
      targetId: requestId,
      severity: "Low",
      details: { existingReviewId: existingSnap.docs[0].id }
    });
    throw new HttpsError(
      "already-exists",
      "A review has already been submitted for this service request."
    );
  }

  const workerId = requestData.workerUid || requestData.workerId || null;
  const nowMs = Date.now();
  const reviewDoc = {
    id: requestId,
    requestId,
    reviewType: REVIEW_TYPES.VERIFIED_WORK,
    customerId: uid,
    customerName: requestData.customerName || "Customer",
    workerId,
    workerUid: workerId,
    workerName: requestData.workerName || "Service Professional",
    service: requestData.service || null,
    district: requestData.district || null,
    verifiedService: true,
    rating,
    text: cleanText,
    tags: cleanTags,
    status: "published",
    createdAt: FieldValue.serverTimestamp(),
    createdAtMs: nowMs,
    updatedAt: null,
    editedAt: null,
    editCount: 0,
    editHistory: [],
    moderationHistory: [],
    workerReply: null,
    workerReplyAt: null
  };

  // Atomically create review document with deterministic requestId
  try {
    if (typeof reviewRef.create === "function") {
      await reviewRef.create(reviewDoc);
    } else {
      await reviewRef.set(reviewDoc);
    }
  } catch (err) {
    if (err.code === 6 || err.message?.includes("already exists")) {
      throw new HttpsError(
        "already-exists",
        "A review has already been submitted for this service request."
      );
    }
    throw err;
  }

  // Authoritatively recalculate worker aggregate rating from published reviews
  const ratingSummary = workerId
    ? await recalculateAndPersistWorkerRating(db, workerId)
    : null;

  await recordAuditEvent(db, {
    actorUid: uid,
    action: "REVIEW_SUBMITTED",
    targetType: "review",
    targetId: requestId,
    result: "success",
    details: { requestId, workerId, rating, tagCount: cleanTags.length }
  });

  return {
    success: true,
    reviewId: requestId,
    ratingSummary,
    message: "Review successfully submitted."
  };
}

/**
 * Submits a Type B: Unverified Experience Review (no completed request required).
 * - Requires authenticated active (non-suspended) customer (no anonymous reviews).
 * - Blocks self-reviews and duplicate unverified reviews per (customer, worker) via canonical ID.
 * - Clearly labeled as "unverified_experience" with verifiedService: false.
 */
async function submitUnverifiedReview(db, request) {
  const uid = assertAuthenticated(request);
  const data = request.data || {};
  const workerUid = typeof data.workerUid === "string" ? data.workerUid.trim() : "";
  if (!workerUid || workerUid.length > 128 || /[/\\.\0]/.test(workerUid)) {
    throw new HttpsError("invalid-argument", "Valid worker identifier is required.");
  }

  const numRating = Number(data.rating);
  if (!Number.isInteger(numRating) || numRating < 1 || numRating > 5) {
    throw new HttpsError("invalid-argument", "Rating must be an integer between 1 and 5.");
  }

  const rawText = typeof data.text === "string" ? data.text.trim() : "";
  if (rawText.length > MAX_REVIEW_LENGTH) {
    throw new HttpsError("invalid-argument", `Review text must be ${MAX_REVIEW_LENGTH} characters or fewer.`);
  }
  if (SCRIPT_INJECTION_PATTERN.test(rawText)) {
    throw new HttpsError("invalid-argument", "Review text contains disallowed script content.");
  }
  const cleanText = rawText.replace(HTML_TAG_PATTERN, "").trim();
  const cleanTags = sanitizeReviewTags(data.tags);

  await assertCustomerNotSuspended(db, uid);

  if (workerUid === uid) {
    await recordSecurityEvent(db, {
      type: "SELF_REVIEW_ATTEMPT",
      actorUid: uid,
      targetType: "worker",
      targetId: workerUid,
      severity: "High",
      details: { caller: uid, reviewType: REVIEW_TYPES.UNVERIFIED_EXPERIENCE }
    });
    throw new HttpsError("failed-precondition", "You cannot submit a review for your own profile.");
  }

  const workerSnap = await db.collection("workers").doc(workerUid).get();
  if (!workerSnap.exists) {
    throw new HttpsError("not-found", "Target worker profile not found.");
  }
  const workerData = workerSnap.data() || {};

  let customerName = "Customer";
  try {
    const userSnap = await db.collection("users").doc(uid).get();
    if (userSnap.exists && userSnap.data()?.name) {
      customerName = String(userSnap.data().name).trim();
    }
  } catch {}

  const reviewId = `unv-${workerUid}-${uid}`;
  const reviewRef = db.collection("reviews").doc(reviewId);
  const existing = await reviewRef.get();
  if (existing.exists) {
    await recordSecurityEvent(db, {
      type: "DUPLICATE_REVIEW_ATTEMPT",
      actorUid: uid,
      targetType: "worker",
      targetId: workerUid,
      severity: "Low",
      details: { existingReviewId: reviewId, reviewType: REVIEW_TYPES.UNVERIFIED_EXPERIENCE }
    });
    throw new HttpsError("already-exists", "You have already submitted an unverified experience review for this worker.");
  }

  const nowMs = Date.now();
  const reviewDoc = {
    id: reviewId,
    requestId: null,
    reviewType: REVIEW_TYPES.UNVERIFIED_EXPERIENCE,
    customerId: uid,
    customerName,
    workerId: workerUid,
    workerUid,
    workerName: workerData.name || "Service Professional",
    service: workerData.service || null,
    district: workerData.district || null,
    verifiedService: false,
    rating: numRating,
    text: cleanText,
    tags: cleanTags,
    status: "published",
    createdAt: FieldValue.serverTimestamp(),
    createdAtMs: nowMs,
    updatedAt: null,
    editedAt: null,
    editCount: 0,
    editHistory: [],
    moderationHistory: [],
    workerReply: null,
    workerReplyAt: null
  };

  try {
    if (typeof reviewRef.create === "function") {
      await reviewRef.create(reviewDoc);
    } else {
      await reviewRef.set(reviewDoc);
    }
  } catch (err) {
    if (err.code === 6 || err.message?.includes("already exists")) {
      throw new HttpsError("already-exists", "You have already submitted an unverified experience review for this worker.");
    }
    throw err;
  }

  const ratingSummary = await recalculateAndPersistWorkerRating(db, workerUid);

  await recordAuditEvent(db, {
    actorUid: uid,
    action: "UNVERIFIED_REVIEW_SUBMITTED",
    targetType: "review",
    targetId: reviewId,
    result: "success",
    details: { workerId: workerUid, rating: numRating, reviewType: REVIEW_TYPES.UNVERIFIED_EXPERIENCE }
  });

  return {
    success: true,
    reviewId,
    reviewType: REVIEW_TYPES.UNVERIFIED_EXPERIENCE,
    ratingSummary,
    message: "Unverified experience review published."
  };
}

/**
 * Allows the original customer to edit their published review (either review type) within the 24-hour edit window.
 * Preserves an immutable append-only editHistory audit trail and keeps reviewType & verifiedService immutable.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {object} request
 */
async function editReview(db, request) {
  const uid = assertAuthenticated(request);
  const data = request.data || {};
  const reviewId = String(data.reviewId || data.requestId || "").trim();
  if (!reviewId || reviewId.length > 200 || /[/\\.\0]/.test(reviewId)) {
    throw new HttpsError("invalid-argument", "Valid review identifier is required.");
  }

  const numRating = Number(data.rating);
  if (!Number.isInteger(numRating) || numRating < 1 || numRating > 5) {
    throw new HttpsError("invalid-argument", "Rating must be an integer between 1 and 5.");
  }
  const rawText = typeof data.text === "string" ? data.text.trim() : "";
  if (rawText.length > MAX_REVIEW_LENGTH) {
    throw new HttpsError("invalid-argument", `Review text must be ${MAX_REVIEW_LENGTH} characters or fewer.`);
  }
  if (SCRIPT_INJECTION_PATTERN.test(rawText)) {
    throw new HttpsError("invalid-argument", "Review text contains disallowed script content.");
  }
  const cleanText = rawText.replace(HTML_TAG_PATTERN, "").trim();
  const cleanTags = sanitizeReviewTags(data.tags);

  await assertCustomerNotSuspended(db, uid);

  const reviewRef = db.collection("reviews").doc(reviewId);
  const snap = await reviewRef.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", `Review #${reviewId} not found.`);
  }

  const prev = snap.data();
  if (prev.customerId !== uid) {
    await recordSecurityEvent(db, {
      type: "UNAUTHORIZED_REVIEW_EDIT",
      actorUid: uid,
      targetType: "review",
      targetId: reviewId,
      severity: "High",
      details: { caller: uid, owner: prev.customerId }
    });
    throw new HttpsError("permission-denied", "You can only edit your own review.");
  }

  if (prev.status !== "published") {
    throw new HttpsError("failed-precondition", "Moderated or hidden reviews cannot be edited.");
  }

  const createdMs = typeof prev.createdAtMs === "number" ? prev.createdAtMs : NaN;
  if (Number.isNaN(createdMs) || Date.now() > createdMs + REVIEW_EDIT_WINDOW_MS) {
    throw new HttpsError(
      "failed-precondition",
      "The 24-hour edit window for this review has expired."
    );
  }

  const prevHistory = Array.isArray(prev.editHistory) ? prev.editHistory : [];
  if (prevHistory.length >= MAX_REVIEW_EDITS) {
    throw new HttpsError("failed-precondition", "Maximum edit limit reached for this review.");
  }

  const nowIso = new Date().toISOString();
  const nextHistory = [
    ...prevHistory,
    {
      previousRating: prev.rating,
      previousText: prev.text || "",
      previousTags: Array.isArray(prev.tags) ? prev.tags : [],
      editedAt: nowIso
    }
  ];

  // reviewType, verifiedService, requestId, customerId, workerUid are NEVER mutated on edit
  await reviewRef.update({
    rating: numRating,
    text: cleanText,
    tags: cleanTags,
    editedAt: nowIso,
    updatedAt: FieldValue.serverTimestamp(),
    editCount: nextHistory.length,
    editHistory: nextHistory
  });

  const workerUid = prev.workerUid || prev.workerId || null;
  const ratingSummary = workerUid
    ? await recalculateAndPersistWorkerRating(db, workerUid)
    : null;

  await recordAuditEvent(db, {
    actorUid: uid,
    action: "REVIEW_EDITED",
    targetType: "review",
    targetId: reviewId,
    result: "success",
    details: {
      reviewType: resolveReviewType(prev),
      previousRating: prev.rating,
      newRating: numRating,
      editCount: nextHistory.length
    }
  });

  return {
    success: true,
    reviewId,
    ratingSummary,
    message: "Review updated successfully."
  };
}

module.exports = {
  REVIEW_TYPES,
  REVIEW_EXPERIENCE_TAGS,
  REVIEW_EDIT_WINDOW_MS,
  resolveReviewType,
  sanitizeReviewTags,
  calculateGenuineWorkerRating,
  recalculateAndPersistWorkerRating,
  validateReviewInput,
  submitReview,
  submitUnverifiedReview,
  editReview
};
