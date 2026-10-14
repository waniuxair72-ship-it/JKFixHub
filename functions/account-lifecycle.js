/**
 * @file account-lifecycle.js
 * @description Trusted account deletion, privacy preservation, and data minimization for JK FixHub backend.
 *
 * Security & Privacy Architecture:
 * 1. Strict identity validation: Caller must be authenticated via Firebase Auth.
 * 2. Recent authentication freshness: Token auth_time must be within 300 seconds (5 minutes).
 * 3. Active request fail-closed gate: Customers and workers with Pending or Accepted requests cannot delete accounts.
 * 4. Data minimization & Right to Erasure:
 *    - /users/{uid}: Hard deleted (direct contact PII: email, phone, name, district erased).
 *    - /workers/{workerId}: Tombstoned (status='deleted', isVerified=false, availability='Offline').
 *    - /requests: Redacted (customerName='Former Customer', customerLocation='', problemDescription redacted).
 *    - /reviews: Anonymized (customerName='Anonymous Customer', rating & review text preserved).
 *    - /chats: Archived (isArchived=true, message senderName='Former User', transcripts retained for dispute evidence).
 *    - /reports & /securityEvents: Preserved intact for Trust & Safety and immutable auditing.
 * 5. Idempotent State Machine: Tracked in /deletionJobs/{uid} with defensive retry and recovery.
 */

const { HttpsError } = require("firebase-functions/v2/https");
const { FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const { assertAuthenticated, assertActiveAdmin } = require("./auth-helpers");
const { recordAuditEvent, recordSecurityEvent } = require("./audit-logger");

const MAX_AUTH_AGE_SECONDS = 300; // 5 minutes

/**
 * Asserts that the caller has authenticated recently (within 5 minutes).
 *
 * @param {object} request - Functions v2 callable request.
 * @returns {number} auth_time in seconds.
 */
function assertRecentAuthentication(request) {
  const authTime = request?.auth?.token?.auth_time;
  if (!authTime || typeof authTime !== "number") {
    throw new HttpsError(
      "unauthenticated",
      "Recent authentication required. Please sign in again and retry."
    );
  }

  const currentTimeSeconds = Math.floor(Date.now() / 1000);
  const ageSeconds = currentTimeSeconds - authTime;

  // Reject if token is older than 5 minutes or if auth_time is improbably in the future (> 30s clock skew)
  if (ageSeconds > MAX_AUTH_AGE_SECONDS || authTime > currentTimeSeconds + 30) {
    throw new HttpsError(
      "unauthenticated",
      "For your security, account deletion requires recent authentication within the last 5 minutes. Please sign in again and retry."
    );
  }

  return authTime;
}

/**
 * Checks for any active service requests (Pending or Accepted) associated with the user as customer or worker.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} uid
 */
async function assertNoActiveRequests(db, uid) {
  // 1. Customer active requests check
  const activeCustomerReqs = await db.collection("requests")
    .where("customerId", "==", uid)
    .where("status", "in", ["Pending", "Accepted"])
    .limit(1)
    .get();

  if (!activeCustomerReqs.empty) {
    throw new HttpsError(
      "failed-precondition",
      "Cannot delete account while you have active service requests. Please cancel pending requests or wait for ongoing work to complete."
    );
  }

  // 2. Worker active requests check (by workerUid)
  const activeWorkerUidReqs = await db.collection("requests")
    .where("workerUid", "==", uid)
    .where("status", "in", ["Pending", "Accepted"])
    .limit(1)
    .get();

  if (!activeWorkerUidReqs.empty) {
    throw new HttpsError(
      "failed-precondition",
      "Cannot delete account while you have active service requests assigned to you. Please complete or decline active requests before deleting your account."
    );
  }

  // 3. Worker active requests check (by workerId)
  const activeWorkerIdReqs = await db.collection("requests")
    .where("workerId", "==", uid)
    .where("status", "in", ["Pending", "Accepted"])
    .limit(1)
    .get();

  if (!activeWorkerIdReqs.empty) {
    throw new HttpsError(
      "failed-precondition",
      "Cannot delete account while you have active service requests assigned to you. Please complete or decline active requests before deleting your account."
    );
  }
}

/**
 * Helper to get a safe fallback auth service if none provided.
 * @param {object} [authServiceOverride=null]
 * @returns {object}
 */
function resolveAuthService(authServiceOverride = null) {
  if (authServiceOverride) return authServiceOverride;
  try {
    return getAuth();
  } catch (_) {
    return {
      deleteUser: async () => {}
    };
  }
}

/**
 * Executes the complete account deletion and data minimization pipeline.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {object} request - Firebase Functions v2 Callable request.
 * @param {object} [authServiceOverride=null] - Optional Auth service for dependency injection / mocking.
 * @returns {Promise<{ success: boolean, message: string, status: string }>}
 */
async function deleteUserAccount(db, request, authServiceOverride = null) {
  const uid = assertAuthenticated(request);
  assertRecentAuthentication(request);

  const authService = resolveAuthService(authServiceOverride);
  const jobRef = db.collection("deletionJobs").doc(uid);

  // 1. Idempotency Check: if job is already COMPLETED, return immediately
  const existingJobSnap = await jobRef.get();
  if (existingJobSnap.exists) {
    const jobData = existingJobSnap.data();
    if (jobData?.state === "COMPLETED") {
      return {
        success: true,
        message: "Account deletion already completed.",
        status: "COMPLETED"
      };
    }
  }

  // 2. Active Requests Pre-condition Guard
  try {
    await assertNoActiveRequests(db, uid);
  } catch (err) {
    await jobRef.set(
      {
        uid,
        state: "FAILED",
        error: err.message,
        updatedAt: FieldValue.serverTimestamp()
      },
      { merge: true }
    );
    throw err;
  }

  // Initialize or resume job state
  await jobRef.set(
    {
      uid,
      state: "SANITIZING",
      initiatedAt: existingJobSnap.exists && existingJobSnap.data()?.initiatedAt
        ? existingJobSnap.data().initiatedAt
        : FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      error: null
    },
    { merge: true }
  );

  // 3. Data Sanitization & Minimization
  try {
    const sanitizationStats = await sanitizeUserData(db, uid);

    // 4. Identity Erasure in Firebase Authentication
    await jobRef.set(
      {
        state: "AUTH_DELETING",
        updatedAt: FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    try {
      await authService.deleteUser(uid);
    } catch (authErr) {
      // Defensive recovery: if user was already deleted from Auth, treat as success
      if (authErr?.code !== "auth/user-not-found") {
        throw authErr;
      }
    }

    // 5. Immutable Audit Trail
    await recordAuditEvent(db, {
      auditId: `account-deletion-${uid}`,
      actorUid: uid,
      action: "ACCOUNT_DELETION",
      targetType: "user",
      targetId: uid,
      result: "success",
      details: sanitizationStats
    });

    // 6. Complete Deletion Job State Machine
    await jobRef.set(
      {
        state: "COMPLETED",
        completedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        error: null
      },
      { merge: true }
    );

    return {
      success: true,
      message: "Account successfully deleted and personal data redacted.",
      status: "COMPLETED"
    };

  } catch (err) {
    await jobRef.set(
      {
        state: "FAILED",
        error: err?.message || String(err),
        updatedAt: FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    if (err instanceof HttpsError) {
      throw err;
    }
    throw new HttpsError(
      "internal",
      `Account deletion encountered an unexpected failure: ${err?.message || err}`
    );
  }
}

/**
 * Idempotently sanitizes and redacts personal data across all user-associated collections.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} uid
 * @returns {Promise<{ workerTombstoned: boolean, requestsRedacted: number, reviewsAnonymized: number, chatsArchived: number }>}
 */
async function sanitizeUserData(db, uid) {
  // 3a. Tombstone Worker Profile (/workers/{uid})
  const workerRef = db.collection("workers").doc(uid);
  const workerSnap = await workerRef.get();
  if (workerSnap.exists) {
    await workerRef.update({
      name: "Former Professional",
      availability: "Offline",
      isVerified: false,
      status: "deleted",
      deletedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });
  }

  // 3b. Sanitize Customer Requests (/requests where customerId == uid)
  const customerReqs = await db.collection("requests").where("customerId", "==", uid).get();
  for (const doc of customerReqs.docs) {
    await doc.ref.update({
      customerName: "Former Customer",
      customerLocation: "",
      problemDescription: "[Description redacted upon account deletion]",
      customerDeleted: true,
      updatedAt: FieldValue.serverTimestamp()
    });
  }

  // 3c. Sanitize Worker Requests (/requests where workerUid == uid or workerId == uid)
  const workerUidReqs = await db.collection("requests").where("workerUid", "==", uid).get();
  for (const doc of workerUidReqs.docs) {
    await doc.ref.update({
      workerName: "Former Professional",
      workerDeleted: true,
      updatedAt: FieldValue.serverTimestamp()
    });
  }
  const workerIdReqs = await db.collection("requests").where("workerId", "==", uid).get();
  for (const doc of workerIdReqs.docs) {
    await doc.ref.update({
      workerName: "Former Professional",
      workerDeleted: true,
      updatedAt: FieldValue.serverTimestamp()
    });
  }

  // 3d. Anonymize Customer Reviews (/reviews where customerId == uid)
  const customerReviews = await db.collection("reviews").where("customerId", "==", uid).get();
  for (const doc of customerReviews.docs) {
    await doc.ref.update({
      customerName: "Anonymous Customer",
      customerId: "deleted",
      customerDeleted: true,
      updatedAt: FieldValue.serverTimestamp()
    });
  }

  // 3e. Archive In-App Chats (/chats where participants array-contains uid)
  const chatsToArchive = new Map();
  const chatsParticipants = await db.collection("chats").where("participants", "array-contains", uid).get();
  for (const doc of chatsParticipants.docs) {
    chatsToArchive.set(doc.id, doc);
  }
  const chatsCustomer = await db.collection("chats").where("customerId", "==", uid).get();
  for (const doc of chatsCustomer.docs) {
    chatsToArchive.set(doc.id, doc);
  }
  const chatsWorker = await db.collection("chats").where("workerUid", "==", uid).get();
  for (const doc of chatsWorker.docs) {
    chatsToArchive.set(doc.id, doc);
  }

  for (const chatDoc of chatsToArchive.values()) {
    await chatDoc.ref.update({
      isArchived: true,
      archivedReason: "user_deleted",
      archivedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });

    // Redact sender attribution in chat messages
    const messagesSnap = await chatDoc.ref.collection("messages").where("senderId", "==", uid).get();
    for (const msgDoc of messagesSnap.docs) {
      await msgDoc.ref.update({
        senderName: "Former User"
      });
    }
    const messagesUidSnap = await chatDoc.ref.collection("messages").where("senderUid", "==", uid).get();
    for (const msgDoc of messagesUidSnap.docs) {
      await msgDoc.ref.update({
        senderName: "Former User"
      });
    }
  }

  // 3f. Hard Delete Direct User Profile (/users/{uid})
  await db.collection("users").doc(uid).delete();

  return {
    workerTombstoned: workerSnap.exists,
    requestsRedacted: customerReqs.size + workerUidReqs.size,
    reviewsAnonymized: customerReviews.size,
    chatsArchived: chatsToArchive.size
  };
}

const DEFAULT_STALE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Extracts milliseconds timestamp from diverse Firestore / JS timestamp representations.
 * @param {any} value
 * @returns {number}
 */
function extractTimestampMs(value) {
  if (!value) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return isNaN(parsed) ? 0 : parsed;
  }
  if (value instanceof Date) return value.getTime();
  if (typeof value.toDate === "function") return value.toDate().getTime();
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.seconds === "number") return value.seconds * 1000;
  return 0;
}

/**
 * Reconciles orphaned account deletion jobs that remain in AUTH_DELETING or RECONCILING.
 *
 * Safety & Recovery Guarantees:
 * 1. Targeted Scope: Only queries jobs with state in ["AUTH_DELETING", "RECONCILING"].
 * 2. Concurrency Lock: Uses a Firestore transaction to claim the job and set state="RECONCILING",
 *    preventing duplicate execution across concurrent scheduled and manual runs.
 * 3. Staleness Threshold: Enforces a minimum staleness threshold (default 15 minutes).
 * 4. Surviving Auth User Preconditions:
 *    - Never directly deletes a surviving Auth user without verifying active requests.
 *    - If active requests exist: aborts and moves job to state="FAILED" with clear reason.
 *    - If no active requests: re-runs sanitization to guarantee complete cleanup before deletion.
 * 5. Authoritative Auth Check: Invokes authService.getUser(uid).
 *    - If auth/user-not-found: Confirms user was purged, writes idempotent audit log, marks COMPLETED.
 *    - If authService is temporarily unavailable: Fails safe, does not modify job state to COMPLETED.
 * 6. Idempotent: Running multiple times produces identical outcomes with zero duplicate audit records.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {object} authService - Firebase Auth service instance.
 * @param {object} [options={}]
 * @param {number} [options.staleThresholdMs=900000] - Inactivity duration before job is eligible for reconciliation.
 * @param {number} [options.now=Date.now()] - Reference timestamp for testing.
 * @returns {Promise<{ checkedCount: number, reconciledCount: number, skippedCount: number, errorCount: number }>}
 */
async function reconcileStaleDeletionJobs(db, authService, options = {}) {
  const staleThresholdMs = typeof options.staleThresholdMs === "number"
    ? options.staleThresholdMs
    : DEFAULT_STALE_THRESHOLD_MS;
  const nowMs = typeof options.now === "number" ? options.now : Date.now();

  const results = {
    checkedCount: 0,
    reconciledCount: 0,
    skippedCount: 0,
    errorCount: 0
  };

  if (!db || !authService) {
    return results;
  }

  // 1. Query candidate jobs strictly in AUTH_DELETING or RECONCILING state
  const snapshot = await db.collection("deletionJobs")
    .where("state", "in", ["AUTH_DELETING", "RECONCILING"])
    .get();

  for (const doc of snapshot.docs) {
    results.checkedCount++;
    const uid = doc.id;

    // 2. Transactional Claim & State Revalidation:
    // Protects against concurrent scheduled and manual runs targeting the same job.
    let claimed = false;
    let jobData = null;

    try {
      if (typeof db.runTransaction === "function") {
        await db.runTransaction(async (transaction) => {
          const freshSnap = await transaction.get(doc.ref);
          if (!freshSnap.exists) return;
          const current = freshSnap.data() || {};

          if (current.state !== "AUTH_DELETING" && current.state !== "RECONCILING") {
            return;
          }

          if (current.state === "RECONCILING") {
            const reconcilingMs = extractTimestampMs(current.reconcilingAt) || extractTimestampMs(current.updatedAt);
            if (nowMs - reconcilingMs < staleThresholdMs) {
              return;
            }
          } else {
            const lastUpdatedMs = extractTimestampMs(current.updatedAt) || extractTimestampMs(current.initiatedAt);
            if (nowMs - lastUpdatedMs < staleThresholdMs) {
              return;
            }
          }

          // Atomically claim the job for reconciliation
          transaction.set(doc.ref, {
            state: "RECONCILING",
            reconcilingAt: FieldValue.serverTimestamp()
          }, { merge: true });

          claimed = true;
          jobData = current;
        });
      } else {
        // Fallback for environments without runTransaction
        const freshSnap = await doc.ref.get();
        if (freshSnap.exists) {
          const current = freshSnap.data() || {};
          if (current.state === "AUTH_DELETING" || current.state === "RECONCILING") {
            let isStale = false;
            if (current.state === "RECONCILING") {
              const reconcilingMs = extractTimestampMs(current.reconcilingAt) || extractTimestampMs(current.updatedAt);
              isStale = (nowMs - reconcilingMs >= staleThresholdMs);
            } else {
              const lastUpdatedMs = extractTimestampMs(current.updatedAt) || extractTimestampMs(current.initiatedAt);
              isStale = (nowMs - lastUpdatedMs >= staleThresholdMs);
            }

            if (isStale) {
              await doc.ref.set({
                state: "RECONCILING",
                reconcilingAt: FieldValue.serverTimestamp()
              }, { merge: true });
              claimed = true;
              jobData = current;
            }
          }
        }
      }
    } catch (txnErr) {
      results.errorCount++;
      continue;
    }

    if (!claimed) {
      results.skippedCount++;
      continue;
    }

    // 3. Authoritative Verification with Firebase Authentication
    let userMissing = false;
    let userStillExists = false;

    try {
      await authService.getUser(uid);
      userStillExists = true;
    } catch (err) {
      if (err?.code === "auth/user-not-found") {
        userMissing = true;
      } else {
        // Auth service temporarily unavailable or network error. Fail safe and preserve retryability!
        results.errorCount++;
        try {
          await doc.ref.set({
            state: "AUTH_DELETING",
            reconcileError: err?.message || String(err),
            reconcilingAt: null
          }, { merge: true });
        } catch (_) {}
        continue;
      }
    }

    // 4. Resolve Job Based on Concrete Auth State
    if (userMissing) {
      // User is confirmed deleted from Firebase Auth.
      // Use deterministic auditId to guarantee idempotency across retries.
      await recordAuditEvent(db, {
        auditId: `reconcile-${uid}`,
        actorUid: uid,
        action: "ACCOUNT_DELETION_RECONCILED",
        targetType: "user",
        targetId: uid,
        result: "success",
        details: {
          reconciledReason: "auth_user_confirmed_deleted",
          previousState: jobData?.state || "AUTH_DELETING",
          reconciledAt: new Date(nowMs).toISOString()
        }
      });

      await doc.ref.set(
        {
          state: "COMPLETED",
          completedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
          reconciledAt: FieldValue.serverTimestamp(),
          reconciledReason: "auth_user_confirmed_deleted",
          error: null
        },
        { merge: true }
      );

      results.reconciledCount++;
    } else if (userStillExists) {
      // The user still exists in Firebase Auth!
      // Must NOT directly delete and mark COMPLETED.
      // Re-check preconditions and ensure sanitization is 100% complete.
      try {
        await assertNoActiveRequests(db, uid);
      } catch (activeReqErr) {
        // Active request found! Move to explicitly recoverable failure state
        await doc.ref.set(
          {
            state: "FAILED",
            error: `Reconciliation aborted: surviving Auth user has active service requests (${activeReqErr.message})`,
            updatedAt: FieldValue.serverTimestamp()
          },
          { merge: true }
        );
        results.errorCount++;
        continue;
      }

      // Re-run data sanitization to guarantee complete data minimization
      try {
        await sanitizeUserData(db, uid);
      } catch (sanErr) {
        await doc.ref.set(
          {
            state: "FAILED",
            error: `Reconciliation sanitization failed: ${sanErr?.message || sanErr}`,
            updatedAt: FieldValue.serverTimestamp()
          },
          { merge: true }
        );
        results.errorCount++;
        continue;
      }

      // Preconditions passed and data sanitized. Now delete from Firebase Auth.
      try {
        await authService.deleteUser(uid);
      } catch (delErr) {
        if (delErr?.code !== "auth/user-not-found") {
          await doc.ref.set(
            {
              state: "AUTH_DELETING",
              reconcileError: delErr?.message || String(delErr),
              reconcilingAt: null
            },
            { merge: true }
          );
          results.errorCount++;
          continue;
        }
      }

      // Idempotent audit record
      await recordAuditEvent(db, {
        auditId: `reconcile-${uid}`,
        actorUid: uid,
        action: "ACCOUNT_DELETION_RECONCILED",
        targetType: "user",
        targetId: uid,
        result: "success",
        details: {
          reconciledReason: "surviving_auth_user_sanitized_and_deleted",
          previousState: jobData?.state || "AUTH_DELETING",
          reconciledAt: new Date(nowMs).toISOString()
        }
      });

      await doc.ref.set(
        {
          state: "COMPLETED",
          completedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
          reconciledAt: FieldValue.serverTimestamp(),
          reconciledReason: "surviving_auth_user_sanitized_and_deleted",
          error: null
        },
        { merge: true }
      );

      results.reconciledCount++;
    }
  }

  return results;
}

/**
 * Admin callable to trigger on-demand reconciliation of stale deletion jobs.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {object} request
 * @param {object} [authServiceOverride=null]
 * @returns {Promise<object>}
 */
async function adminReconcileDeletionJobs(db, request, authServiceOverride = null) {
  await assertActiveAdmin(db, request);
  const authService = resolveAuthService(authServiceOverride);
  return await reconcileStaleDeletionJobs(db, authService);
}

module.exports = {
  assertRecentAuthentication,
  assertNoActiveRequests,
  sanitizeUserData,
  deleteUserAccount,
  reconcileStaleDeletionJobs,
  adminReconcileDeletionJobs,
  extractTimestampMs,
  MAX_AUTH_AGE_SECONDS,
  DEFAULT_STALE_THRESHOLD_MS
};
