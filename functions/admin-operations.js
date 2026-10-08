/**
 * @file admin-operations.js
 * @description Trusted administrative operations and privileged state mutations for JK FixHub backend.
 *
 * Security Principles:
 * 1. Strict server-side verification: caller must exist in /admins/{uid} with role="admin" and active=true.
 * 2. Fail-closed: unauthorized users are immediately rejected.
 * 3. Every administrative action creates an authoritative audit record in /auditLogs.
 * 4. Immutable logs: admins cannot delete or rewrite audit records.
 */

const { HttpsError } = require("firebase-functions/v2/https");
const { FieldValue } = require("firebase-admin/firestore");
const { assertActiveAdmin } = require("./auth-helpers");
const { recordAuditEvent, recordSecurityEvent } = require("./audit-logger");

const ALLOWED_WORKER_STATUSES = Object.freeze(["active", "suspended", "pending"]);
const ALLOWED_REPORT_STATUSES = Object.freeze(["under_review", "resolved", "dismissed"]);
const ALLOWED_REVIEW_STATUSES = Object.freeze(["published", "hidden", "flagged"]);

/**
 * Validates document identifier to prevent path traversal or malformed queries.
 * @param {string} id
 * @param {string} entityName
 */
function validateEntityId(id, entityName) {
  if (
    !id ||
    typeof id !== "string" ||
    id.trim().length === 0 ||
    id.length > 128 ||
    /[/\\.\0]/.test(id)
  ) {
    throw new HttpsError(
      "invalid-argument",
      `Invalid or malformed ${entityName} identifier.`
    );
  }
}

/**
 * Admin: Update worker verification and account moderation status.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {object} request - Functions v2 callable request.
 */
async function adminUpdateWorkerStatus(db, request) {
  let adminRecord;
  try {
    adminRecord = await assertActiveAdmin(db, request);
  } catch (err) {
    await recordSecurityEvent(db, {
      type: "UNAUTHORIZED_ADMIN_ACTION",
      actorUid: request?.auth?.uid || null,
      targetType: "worker",
      severity: "High",
      details: { operation: "adminUpdateWorkerStatus" }
    });
    throw err;
  }

  const { workerId, status, isVerified } = request.data || {};
  validateEntityId(workerId, "worker");

  const updates = {
    updatedAt: FieldValue.serverTimestamp()
  };

  if (status !== undefined) {
    if (!ALLOWED_WORKER_STATUSES.includes(status)) {
      throw new HttpsError(
        "invalid-argument",
        `Invalid status. Allowed: ${ALLOWED_WORKER_STATUSES.join(", ")}.`
      );
    }
    updates.status = status;
  }

  if (isVerified !== undefined) {
    if (typeof isVerified !== "boolean") {
      throw new HttpsError(
        "invalid-argument",
        "isVerified must be a boolean."
      );
    }
    updates.isVerified = isVerified;
  }

  if (Object.keys(updates).length <= 1) {
    throw new HttpsError(
      "invalid-argument",
      "No valid status or verification updates provided."
    );
  }

  const workerRef = db.collection("workers").doc(String(workerId));
  const snap = await workerRef.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", `Worker #${workerId} not found.`);
  }

  await workerRef.update(updates);

  const action = updates.isVerified
    ? "WORKER_APPROVED"
    : updates.status === "suspended"
    ? "WORKER_SUSPENDED"
    : "WORKER_STATUS_UPDATED";

  await recordAuditEvent(db, {
    actorUid: adminRecord.uid,
    action,
    targetType: "worker",
    targetId: workerId,
    result: "success",
    details: updates
  });

  return { success: true, workerId, updates };
}

/**
 * Admin: Moderate a Trust & Safety report.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {object} request
 */
async function adminModerateReport(db, request) {
  let adminRecord;
  try {
    adminRecord = await assertActiveAdmin(db, request);
  } catch (err) {
    await recordSecurityEvent(db, {
      type: "UNAUTHORIZED_ADMIN_ACTION",
      actorUid: request?.auth?.uid || null,
      targetType: "report",
      severity: "High",
      details: { operation: "adminModerateReport" }
    });
    throw err;
  }

  const { reportId, status } = request.data || {};
  validateEntityId(reportId, "report");

  if (!ALLOWED_REPORT_STATUSES.includes(status)) {
    throw new HttpsError(
      "invalid-argument",
      `Invalid report status. Allowed: ${ALLOWED_REPORT_STATUSES.join(", ")}.`
    );
  }

  const reportRef = db.collection("reports").doc(String(reportId));
  const snap = await reportRef.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", `Report #${reportId} not found.`);
  }

  const updates = {
    status,
    resolvedAt: FieldValue.serverTimestamp(),
    resolvedBy: adminRecord.uid,
    updatedAt: FieldValue.serverTimestamp()
  };

  await reportRef.update(updates);

  await recordAuditEvent(db, {
    actorUid: adminRecord.uid,
    action: "REPORT_STATUS_UPDATED",
    targetType: "report",
    targetId: reportId,
    result: "success",
    details: { newStatus: status }
  });

  return { success: true, reportId, status };
}

/**
 * Admin: Moderate a customer review.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {object} request
 */
async function adminModerateReview(db, request) {
  let adminRecord;
  try {
    adminRecord = await assertActiveAdmin(db, request);
  } catch (err) {
    await recordSecurityEvent(db, {
      type: "UNAUTHORIZED_ADMIN_ACTION",
      actorUid: request?.auth?.uid || null,
      targetType: "review",
      severity: "High",
      details: { operation: "adminModerateReview" }
    });
    throw err;
  }

  const { reviewId, status } = request.data || {};
  validateEntityId(reviewId, "review");

  if (!ALLOWED_REVIEW_STATUSES.includes(status)) {
    throw new HttpsError(
      "invalid-argument",
      `Invalid review status. Allowed: ${ALLOWED_REVIEW_STATUSES.join(", ")}.`
    );
  }

  const reviewRef = db.collection("reviews").doc(String(reviewId));
  const snap = await reviewRef.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", `Review #${reviewId} not found.`);
  }

  const updates = {
    status,
    moderatedAt: FieldValue.serverTimestamp(),
    moderatedBy: adminRecord.uid,
    updatedAt: FieldValue.serverTimestamp()
  };

  await reviewRef.update(updates);

  await recordAuditEvent(db, {
    actorUid: adminRecord.uid,
    action: "REVIEW_MODERATED",
    targetType: "review",
    targetId: reviewId,
    result: "success",
    details: { newStatus: status }
  });

  return { success: true, reviewId, status };
}

module.exports = {
  ALLOWED_WORKER_STATUSES,
  ALLOWED_REPORT_STATUSES,
  ALLOWED_REVIEW_STATUSES,
  validateEntityId,
  adminUpdateWorkerStatus,
  adminModerateReport,
  adminModerateReview
};
