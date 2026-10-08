/**
 * @file review-logic.js
 * @description Trusted review submission, validation, and eligibility enforcement for JK FixHub backend.
 *
 * Security Principles:
 * 1. Only authenticated customers who own the request can submit a review.
 * 2. Request status must authoritatively be "Completed" in Firestore.
 * 3. Exactly one review per eligible request (duplicate prevention).
 * 4. Rating strictly bounded to integers 1–5.
 * 5. Review text strictly validated, bounded, and sanitized against injection.
 */

const { HttpsError } = require("firebase-functions/v2/https");
const { FieldValue } = require("firebase-admin/firestore");
const { assertAuthenticated } = require("./auth-helpers");
const { validateRequestId, fetchAuthoritativeRequest } = require("./request-lifecycle");
const { recordAuditEvent, recordSecurityEvent } = require("./audit-logger");

const SCRIPT_INJECTION_PATTERN = /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi;
const HTML_TAG_PATTERN = /<\/?[a-z][\s\S]*>/i;

/**
 * Validates review submission input.
 * @param {object} data
 */
function validateReviewInput(data) {
  if (!data || typeof data !== "object") {
    throw new HttpsError("invalid-argument", "Review payload must be an object.");
  }

  const { requestId, rating, text } = data;
  validateRequestId(requestId);

  const numRating = Number(rating);
  if (!Number.isInteger(numRating) || numRating < 1 || numRating > 5) {
    throw new HttpsError(
      "invalid-argument",
      "Rating must be an integer between 1 and 5."
    );
  }

  if (typeof text !== "string") {
    throw new HttpsError("invalid-argument", "Review text must be a string.");
  }

  const trimmedText = text.trim();
  if (trimmedText.length < 5 || trimmedText.length > 1000) {
    throw new HttpsError(
      "invalid-argument",
      "Review text must be between 5 and 1,000 characters."
    );
  }

  if (SCRIPT_INJECTION_PATTERN.test(trimmedText)) {
    throw new HttpsError(
      "invalid-argument",
      "Review text contains disallowed script content."
    );
  }

  return {
    requestId: requestId.trim(),
    rating: numRating,
    cleanText: trimmedText.replace(HTML_TAG_PATTERN, "").trim()
  };
}

/**
 * Submits a validated customer review for an authoritatively completed service request.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {object} request - Functions v2 callable request.
 * @returns {Promise<{ success: boolean, reviewId: string }>}
 */
async function submitReview(db, request) {
  const uid = assertAuthenticated(request);
  const { requestId, rating, cleanText } = validateReviewInput(request.data);

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

  // 3. Verify exactly one review per request (duplicate prevention)
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
  const reviewDoc = {
    requestId,
    customerId: uid,
    customerName: requestData.customerName || "Customer",
    workerId,
    workerUid: workerId,
    workerName: requestData.workerName || "Service Professional",
    rating,
    text: cleanText,
    status: "published",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: null,
    workerReply: null,
    workerReplyAt: null
  };

  const docRef = await db.collection("reviews").add(reviewDoc);

  await recordAuditEvent(db, {
    actorUid: uid,
    action: "REVIEW_SUBMITTED",
    targetType: "review",
    targetId: docRef.id,
    result: "success",
    details: { requestId, workerId, rating }
  });

  return {
    success: true,
    reviewId: docRef.id,
    message: "Review successfully submitted."
  };
}

module.exports = {
  validateReviewInput,
  submitReview
};
