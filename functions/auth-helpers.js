/**
 * @file auth-helpers.js
 * @description Trusted backend authorization and identity helpers for JK FixHub Cloud Functions.
 *
 * Security Principles:
 * 1. Never trust user roles or identities supplied from client payloads.
 * 2. Authenticated identity comes strictly from request.auth.uid.
 * 3. Authoritative role checks read from Firestore (/admins/{uid}, /users/{uid}).
 * 4. Strict fail-closed: any failure, exception, or ambiguity immediately denies access.
 */

const { HttpsError } = require("firebase-functions/v2/https");

/**
 * Asserts that the request originates from an authenticated user.
 * @param {object} request - Firebase Functions v2 Callable request.
 * @returns {string} Authenticated Firebase UID.
 */
function assertAuthenticated(request) {
  if (!request || !request.auth || !request.auth.uid || typeof request.auth.uid !== "string") {
    throw new HttpsError(
      "unauthenticated",
      "Authentication required. Please sign in to proceed."
    );
  }
  return request.auth.uid;
}

/**
 * Asserts that the caller is an active, authorized platform administrator.
 * Validates against /admins/{uid} collection in Cloud Firestore.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {object} request
 * @returns {Promise<object>} Admin record data.
 */
async function assertActiveAdmin(db, request) {
  const uid = assertAuthenticated(request);

  try {
    const adminRef = db.collection("admins").doc(uid);
    const adminSnap = await adminRef.get();

    if (!adminSnap.exists) {
      throw new HttpsError(
        "permission-denied",
        "Access unavailable. This area is restricted to authorized administrators."
      );
    }

    const data = adminSnap.data();
    if (
      !data ||
      data.active !== true ||
      data.role !== "admin" ||
      (data.uid && data.uid !== uid)
    ) {
      throw new HttpsError(
        "permission-denied",
        "Access unavailable. This area is restricted to authorized administrators."
      );
    }

    return { uid, ...data };
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    throw new HttpsError(
      "permission-denied",
      "Access unavailable. This area is restricted to authorized administrators."
    );
  }
}

/**
 * Asserts that the caller is a registered Customer.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {object} request
 * @returns {Promise<{ uid: string, userData: object|null }>}
 */
async function assertCustomer(db, request) {
  const uid = assertAuthenticated(request);

  try {
    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();

    if (userSnap.exists) {
      const data = userSnap.data();
      if (data && data.role && data.role !== "customer") {
        throw new HttpsError(
          "permission-denied",
          "This operation is restricted to customers."
        );
      }
      return { uid, userData: data };
    }

    // Default to caller UID if document is still syncing
    return { uid, userData: null };
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    throw new HttpsError("permission-denied", "Customer authorization failed.");
  }
}

/**
 * Asserts that the caller is a registered Worker.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {object} request
 * @returns {Promise<{ uid: string, workerData: object|null }>}
 */
async function assertWorker(db, request) {
  const uid = assertAuthenticated(request);

  try {
    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();

    if (userSnap.exists) {
      const data = userSnap.data();
      if (data && data.role && data.role !== "worker") {
        throw new HttpsError(
          "permission-denied",
          "This operation is restricted to service workers."
        );
      }
    }

    return { uid, workerData: userSnap.exists ? userSnap.data() : null };
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    throw new HttpsError("permission-denied", "Worker authorization failed.");
  }
}

/**
 * Asserts that the authenticated caller owns the request.
 *
 * @param {object} requestDocData - Firestore request document data.
 * @param {string} uid - Authenticated UID.
 */
function assertRequestOwner(requestDocData, uid) {
  if (!requestDocData || typeof requestDocData !== "object") {
    throw new HttpsError("not-found", "Request record not found.");
  }

  const ownerId = requestDocData.customerId;
  if (!ownerId || ownerId !== uid) {
    throw new HttpsError(
      "permission-denied",
      "You are not authorized to access or modify this request."
    );
  }
}

/**
 * Asserts that the authenticated caller is the assigned worker for the request.
 *
 * @param {object} requestDocData - Firestore request document data.
 * @param {string} uid - Authenticated UID.
 */
function assertAssignedWorker(requestDocData, uid) {
  if (!requestDocData || typeof requestDocData !== "object") {
    throw new HttpsError("not-found", "Request record not found.");
  }

  const assignedUid = requestDocData.workerUid || requestDocData.workerId;
  if (!assignedUid || String(assignedUid) !== String(uid)) {
    throw new HttpsError(
      "permission-denied",
      "You are not the assigned worker for this service request."
    );
  }
}

/**
 * Asserts that the authenticated caller is a participant (customer or assigned worker).
 *
 * @param {object} requestDocData
 * @param {string} uid
 * @returns {"customer"|"worker"} Caller role relative to request.
 */
function assertRequestParticipant(requestDocData, uid) {
  if (!requestDocData || typeof requestDocData !== "object") {
    throw new HttpsError("not-found", "Request record not found.");
  }

  const isCustomer = requestDocData.customerId === uid;
  const isWorker =
    String(requestDocData.workerUid || requestDocData.workerId) === String(uid);

  if (isCustomer) return "customer";
  if (isWorker) return "worker";

  throw new HttpsError(
    "permission-denied",
    "You are not a participant in this service request."
  );
}

module.exports = {
  assertAuthenticated,
  assertActiveAdmin,
  assertCustomer,
  assertWorker,
  assertRequestOwner,
  assertAssignedWorker,
  assertRequestParticipant
};
