/**
 * @file request-lifecycle.js
 * @description Trusted service request lifecycle management and status transition enforcement.
 *
 * Security Principles:
 * 1. Strict finite-state machine transitions:
 *    - Pending -> Accepted  (Assigned Worker only)
 *    - Pending -> Rejected  (Assigned Worker only)
 *    - Pending -> Cancelled (Requesting Customer only)
 *    - Accepted -> Completed (Assigned Worker only)
 * 2. Reject arbitrary jumps (e.g. Pending -> Completed).
 * 3. Never trust client-supplied customerId or workerId. Read authoritative Firestore document.
 * 4. Record audit logs for valid transitions; record security events for denied attempts.
 */

const { HttpsError } = require("firebase-functions/v2/https");
const { FieldValue } = require("firebase-admin/firestore");
const {
  assertAuthenticated,
  assertAssignedWorker,
  assertRequestOwner
} = require("./auth-helpers");
const { recordAuditEvent, recordSecurityEvent } = require("./audit-logger");

const VALID_STATUSES = Object.freeze([
  "Pending",
  "Accepted",
  "Rejected",
  "Completed",
  "Cancelled"
]);

/**
 * Validates request ID format to prevent path traversal or injection.
 * @param {string} requestId
 */
function validateRequestId(requestId) {
  if (
    !requestId ||
    typeof requestId !== "string" ||
    requestId.trim().length === 0 ||
    requestId.length > 128 ||
    /[/\\.\0]/.test(requestId)
  ) {
    throw new HttpsError(
      "invalid-argument",
      "Invalid or malformed request identifier."
    );
  }
}

/**
 * Helper to fetch authoritative request document from Firestore.
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} requestId
 * @returns {Promise<{ ref: FirebaseFirestore.DocumentReference, data: object }>}
 */
async function fetchAuthoritativeRequest(db, requestId) {
  validateRequestId(requestId);
  const reqRef = db.collection("requests").doc(requestId);
  const snap = await reqRef.get();

  if (!snap.exists) {
    throw new HttpsError("not-found", `Service request #${requestId} not found.`);
  }

  return { ref: reqRef, data: snap.data() };
}

/**
 * Transition: Pending -> Accepted
 * Caller must be the assigned worker.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {object} request - Functions v2 callable request.
 */
async function acceptRequest(db, request) {
  const uid = assertAuthenticated(request);
  const { requestId } = request.data || {};
  const { ref, data } = await fetchAuthoritativeRequest(db, requestId);

  // Idempotency check: already Accepted
  if (data.status === "Accepted") {
    return {
      success: true,
      requestId,
      status: "Accepted",
      message: "Request is already accepted."
    };
  }

  // Authorization check: must be assigned worker
  try {
    assertAssignedWorker(data, uid);
  } catch (err) {
    await recordSecurityEvent(db, {
      type: "UNAUTHORIZED_WORKER_ACTION",
      actorUid: uid,
      targetType: "request",
      targetId: requestId,
      severity: "High",
      details: { attempt: "accept", caller: uid, assigned: data.workerUid || data.workerId }
    });
    throw err;
  }

  // State machine check: must be Pending
  if (data.status !== "Pending") {
    await recordSecurityEvent(db, {
      type: "INVALID_STATUS_TRANSITION",
      actorUid: uid,
      targetType: "request",
      targetId: requestId,
      severity: "Medium",
      details: { attempt: "accept", currentStatus: data.status, expected: "Pending" }
    });
    throw new HttpsError(
      "failed-precondition",
      `Cannot accept request in '${data.status}' status. Only 'Pending' requests may be accepted.`
    );
  }

  const updates = {
    status: "Accepted",
    acceptedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  };

  await ref.update(updates);

  await recordAuditEvent(db, {
    actorUid: uid,
    action: "REQUEST_ACCEPTED",
    targetType: "request",
    targetId: requestId,
    result: "success",
    details: { previousStatus: "Pending", newStatus: "Accepted" }
  });

  return { success: true, requestId, status: "Accepted" };
}

/**
 * Transition: Pending -> Rejected
 * Caller must be the assigned worker.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {object} request
 */
async function rejectRequest(db, request) {
  const uid = assertAuthenticated(request);
  const { requestId, reason } = request.data || {};
  const { ref, data } = await fetchAuthoritativeRequest(db, requestId);

  if (data.status === "Rejected") {
    return {
      success: true,
      requestId,
      status: "Rejected",
      message: "Request is already rejected."
    };
  }

  try {
    assertAssignedWorker(data, uid);
  } catch (err) {
    await recordSecurityEvent(db, {
      type: "UNAUTHORIZED_WORKER_ACTION",
      actorUid: uid,
      targetType: "request",
      targetId: requestId,
      severity: "High",
      details: { attempt: "reject", caller: uid, assigned: data.workerUid || data.workerId }
    });
    throw err;
  }

  if (data.status !== "Pending") {
    await recordSecurityEvent(db, {
      type: "INVALID_STATUS_TRANSITION",
      actorUid: uid,
      targetType: "request",
      targetId: requestId,
      severity: "Medium",
      details: { attempt: "reject", currentStatus: data.status, expected: "Pending" }
    });
    throw new HttpsError(
      "failed-precondition",
      `Cannot reject request in '${data.status}' status. Only 'Pending' requests may be rejected.`
    );
  }

  const updates = {
    status: "Rejected",
    rejectedAt: FieldValue.serverTimestamp(),
    rejectReason: typeof reason === "string" ? reason.slice(0, 500) : "Worker declined",
    updatedAt: FieldValue.serverTimestamp()
  };

  await ref.update(updates);

  await recordAuditEvent(db, {
    actorUid: uid,
    action: "REQUEST_REJECTED",
    targetType: "request",
    targetId: requestId,
    result: "success",
    details: { previousStatus: "Pending", newStatus: "Rejected" }
  });

  return { success: true, requestId, status: "Rejected" };
}

/**
 * Transition: Accepted -> Completed
 * Caller must be the assigned worker.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {object} request
 */
async function completeRequest(db, request) {
  const uid = assertAuthenticated(request);
  const { requestId } = request.data || {};
  const { ref, data } = await fetchAuthoritativeRequest(db, requestId);

  if (data.status === "Completed") {
    return {
      success: true,
      requestId,
      status: "Completed",
      message: "Request is already completed."
    };
  }

  try {
    assertAssignedWorker(data, uid);
  } catch (err) {
    await recordSecurityEvent(db, {
      type: "UNAUTHORIZED_WORKER_ACTION",
      actorUid: uid,
      targetType: "request",
      targetId: requestId,
      severity: "High",
      details: { attempt: "complete", caller: uid, assigned: data.workerUid || data.workerId }
    });
    throw err;
  }

  if (data.status !== "Accepted") {
    await recordSecurityEvent(db, {
      type: "INVALID_STATUS_TRANSITION",
      actorUid: uid,
      targetType: "request",
      targetId: requestId,
      severity: "Medium",
      details: { attempt: "complete", currentStatus: data.status, expected: "Accepted" }
    });
    throw new HttpsError(
      "failed-precondition",
      `Cannot complete request in '${data.status}' status. Request must be 'Accepted' before completion.`
    );
  }

  const updates = {
    status: "Completed",
    completedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  };

  await ref.update(updates);

  await recordAuditEvent(db, {
    actorUid: uid,
    action: "REQUEST_COMPLETED",
    targetType: "request",
    targetId: requestId,
    result: "success",
    details: { previousStatus: "Accepted", newStatus: "Completed" }
  });

  return { success: true, requestId, status: "Completed" };
}

/**
 * Transition: Pending -> Cancelled
 * Caller must be the requesting customer.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {object} request
 */
async function cancelRequest(db, request) {
  const uid = assertAuthenticated(request);
  const { requestId, reason } = request.data || {};
  const { ref, data } = await fetchAuthoritativeRequest(db, requestId);

  if (data.status === "Cancelled") {
    return {
      success: true,
      requestId,
      status: "Cancelled",
      message: "Request is already cancelled."
    };
  }

  try {
    assertRequestOwner(data, uid);
  } catch (err) {
    await recordSecurityEvent(db, {
      type: "UNAUTHORIZED_CUSTOMER_ACTION",
      actorUid: uid,
      targetType: "request",
      targetId: requestId,
      severity: "High",
      details: { attempt: "cancel", caller: uid, owner: data.customerId }
    });
    throw err;
  }

  if (data.status !== "Pending") {
    await recordSecurityEvent(db, {
      type: "INVALID_STATUS_TRANSITION",
      actorUid: uid,
      targetType: "request",
      targetId: requestId,
      severity: "Medium",
      details: { attempt: "cancel", currentStatus: data.status, expected: "Pending" }
    });
    throw new HttpsError(
      "failed-precondition",
      `Cannot cancel request in '${data.status}' status. Only 'Pending' requests can be cancelled by customers.`
    );
  }

  const updates = {
    status: "Cancelled",
    cancelledAt: FieldValue.serverTimestamp(),
    cancelReason: typeof reason === "string" ? reason.slice(0, 500) : "Customer cancelled",
    updatedAt: FieldValue.serverTimestamp()
  };

  await ref.update(updates);

  await recordAuditEvent(db, {
    actorUid: uid,
    action: "REQUEST_CANCELLED",
    targetType: "request",
    targetId: requestId,
    result: "success",
    details: { previousStatus: "Pending", newStatus: "Cancelled" }
  });

  return { success: true, requestId, status: "Cancelled" };
}

module.exports = {
  VALID_STATUSES,
  validateRequestId,
  fetchAuthoritativeRequest,
  acceptRequest,
  rejectRequest,
  completeRequest,
  cancelRequest
};
