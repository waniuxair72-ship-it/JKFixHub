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
const { recalculateAndPersistWorkerRating } = require("./review-logic");

const ALLOWED_WORKER_STATUSES = Object.freeze(["active", "suspended", "pending", "rejected"]);
const ALLOWED_CUSTOMER_STATUSES = Object.freeze(["active", "suspended"]);
const ALLOWED_REPORT_STATUSES = Object.freeze(["under_review", "resolved", "dismissed"]);
const ALLOWED_REVIEW_STATUSES = Object.freeze(["published", "hidden", "flagged"]);
const ALLOWED_ANNOUNCEMENT_AUDIENCES = Object.freeze(["customers", "workers", "everyone"]);
const ALLOWED_ANNOUNCEMENT_PRIORITIES = Object.freeze(["normal", "important", "urgent"]);
const ALLOWED_ANNOUNCEMENT_STATUSES = Object.freeze(["draft", "published", "paused", "archived", "expired"]);
const NO_EXPIRY_MS = 8640000000000000;

const SERVICE_SYNONYMS = Object.freeze({
  plumber: "Plumbing",
  plumbing: "Plumbing",
  carpenter: "Carpentry",
  carpentry: "Carpentry",
  electrician: "Electrician",
  electrical: "Electrician",
  "electrical repair": "Electrician",
  appliance: "Appliance repair",
  "appliance repair": "Appliance repair",
  "washing machine": "Washing Machine Repair",
  "washing machine repair": "Washing Machine Repair",
  refrigerator: "Refrigerator Repair",
  "refrigerator repair": "Refrigerator Repair",
  fridge: "Refrigerator Repair",
  "fridge repair": "Refrigerator Repair",
  heater: "Heater Repair",
  "heater repair": "Heater Repair",
  "tv repair": "TV / Electronics Repair",
  "electronics repair": "TV / Electronics Repair",
  electronics: "TV / Electronics Repair",
  "tv / electronics repair": "TV / Electronics Repair",
  "tv & electronics repair": "TV / Electronics Repair",
  "tv & electronics": "TV / Electronics Repair"
});

function expandDisabledServices(services) {
  const disabledSet = new Set();
  for (const s of services || []) {
    if (!s || s.enabled !== false || typeof s.name !== "string") continue;
    const lower = s.name.trim().toLowerCase();
    const canonical = (SERVICE_SYNONYMS[lower] || s.name.trim()).toLowerCase();
    if (lower) disabledSet.add(lower);
    if (canonical) disabledSet.add(canonical);
    for (const [alias, target] of Object.entries(SERVICE_SYNONYMS)) {
      if (target.toLowerCase() === lower || target.toLowerCase() === canonical) {
        disabledSet.add(alias.toLowerCase());
      }
    }
  }
  return [...disabledSet];
}

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

  const { workerId, status, isVerified, reason, adminNotes } = request.data || {};
  validateEntityId(workerId, "worker");

  const updates = {
    updatedAt: FieldValue.serverTimestamp(),
    lastModeratedBy: adminRecord.uid
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

  const note = String(adminNotes || reason || "").trim().slice(0, 500);
  if (note) {
    updates.adminNotes = note;
  }

  if (updates.status === undefined && updates.isVerified === undefined) {
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

  const prevData = snap.data() || {};
  const previousStatus = prevData.status || "pending";
  const previousVerified = Boolean(prevData.isVerified);

  // Idempotency guard: if worker is already in exact requested status & verification state, skip redundant write/log
  const statusSame = updates.status === undefined || updates.status === previousStatus;
  const verifiedSame = updates.isVerified === undefined || updates.isVerified === previousVerified;
  if (statusSame && verifiedSame && !note) {
    return { success: true, workerId, alreadyInState: true, updates: {} };
  }

  await workerRef.update(updates);

  const action = updates.isVerified === true
    ? "WORKER_APPROVED"
    : updates.status === "suspended"
    ? "WORKER_SUSPENDED"
    : updates.status === "rejected"
    ? "WORKER_REJECTED"
    : updates.status === "active"
    ? "WORKER_REACTIVATED"
    : "WORKER_STATUS_UPDATED";

  await recordAuditEvent(db, {
    actorUid: adminRecord.uid,
    action,
    targetType: "worker",
    targetId: workerId,
    result: "success",
    details: {
      previousStatus,
      previousVerified,
      newStatus: updates.status ?? previousStatus,
      newVerified: updates.isVerified ?? previousVerified,
      ...(note ? { reason: note } : {})
    }
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

  const previousStatus = snap.data()?.status || "open";
  const note = request.data?.note ? String(request.data.note).slice(0, 500) : null;

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
    details: {
      previousStatus,
      newStatus: status,
      ...(note ? { note } : {})
    }
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

  const prevData = snap.data() || {};
  const previousStatus = prevData.status || "published";
  const note = request.data?.note ? String(request.data.note).trim().slice(0, 500) : null;
  const nowIso = new Date().toISOString();
  const prevHistory = Array.isArray(prevData.moderationHistory) ? prevData.moderationHistory : [];
  const nextHistory = [
    ...prevHistory,
    {
      previousStatus,
      newStatus: status,
      moderatedBy: adminRecord.uid,
      moderatedAt: nowIso,
      ...(note ? { note } : {})
    }
  ];

  const updates = {
    status,
    moderatedAt: FieldValue.serverTimestamp(),
    moderatedBy: adminRecord.uid,
    moderationHistory: nextHistory,
    ...(note ? { moderationNote: note } : {}),
    updatedAt: FieldValue.serverTimestamp()
  };

  await reviewRef.update(updates);

  // Recalculate worker aggregate rating immediately whenever a review is hidden, restored, or flagged
  const workerUid = prevData.workerUid || prevData.workerId || null;
  const ratingSummary = workerUid
    ? await recalculateAndPersistWorkerRating(db, workerUid)
    : null;

  await recordAuditEvent(db, {
    actorUid: adminRecord.uid,
    action: "REVIEW_MODERATED",
    targetType: "review",
    targetId: reviewId,
    result: "success",
    details: {
      previousStatus,
      newStatus: status,
      workerUid,
      ...(ratingSummary ? { newWorkerRating: ratingSummary.rating, newReviewCount: ratingSummary.reviewCount } : {}),
      ...(note ? { note } : {})
    }
  });

  return { success: true, reviewId, status, ratingSummary };
}

/**
 * Admin: Suspend or reactivate a customer account without deleting historical records.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {object} request
 */
async function adminUpdateCustomerStatus(db, request) {
  let adminRecord;
  try {
    adminRecord = await assertActiveAdmin(db, request);
  } catch (err) {
    await recordSecurityEvent(db, {
      type: "UNAUTHORIZED_ADMIN_ACTION",
      actorUid: request?.auth?.uid || null,
      targetType: "customer",
      severity: "High",
      details: { operation: "adminUpdateCustomerStatus" }
    });
    throw err;
  }

  const { customerId, status, reason } = request.data || {};
  validateEntityId(customerId, "customer");

  if (!ALLOWED_CUSTOMER_STATUSES.includes(status)) {
    throw new HttpsError(
      "invalid-argument",
      `Invalid customer status. Allowed: ${ALLOWED_CUSTOMER_STATUSES.join(", ")}.`
    );
  }

  const userRef = db.collection("users").doc(String(customerId));
  const snap = await userRef.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", `Customer #${customerId} not found.`);
  }

  const prevData = snap.data() || {};
  if (prevData.role && prevData.role !== "customer") {
    throw new HttpsError("failed-precondition", "Target account is not a customer account.");
  }

  const previousStatus = prevData.status || "active";
  const cleanReason = String(reason || "").trim().slice(0, 500);

  // Idempotency guard: avoid overwriting original suspendedAt or duplicating audit logs
  if (previousStatus === status) {
    return { success: true, customerId, previousStatus, newStatus: status, alreadyInState: true };
  }

  const nowIso = new Date().toISOString();

  const updates = {
    status,
    updatedAt: FieldValue.serverTimestamp(),
    lastModeratedBy: adminRecord.uid
  };

  if (status === "suspended") {
    updates.suspensionReason = cleanReason || "Suspended by platform administration.";
    updates.suspendedAt = nowIso;
    updates.suspendedBy = adminRecord.uid;
  } else {
    updates.suspensionReason = null;
    updates.reactivatedAt = nowIso;
    updates.reactivatedBy = adminRecord.uid;
  }

  await userRef.update(updates);

  const action = status === "suspended" ? "CUSTOMER_SUSPENDED" : "CUSTOMER_REACTIVATED";
  await recordAuditEvent(db, {
    actorUid: adminRecord.uid,
    action,
    targetType: "customer",
    targetId: customerId,
    result: "success",
    details: {
      previousStatus,
      newStatus: status,
      reason: cleanReason || (status === "suspended" ? "Administrative suspension" : "Account reactivated")
    }
  });

  return { success: true, customerId, previousStatus, newStatus: status };
}

/**
 * Admin: Update Platform Control Centre configuration (/platformConfig/public).
 * Writes ONLY minimal public fields to /platformConfig/public and logs full change details to /auditLogs.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {object} request
 */
async function adminUpdatePlatformConfig(db, request) {
  let adminRecord;
  try {
    adminRecord = await assertActiveAdmin(db, request);
  } catch (err) {
    await recordSecurityEvent(db, {
      type: "UNAUTHORIZED_ADMIN_ACTION",
      actorUid: request?.auth?.uid || null,
      targetType: "platform_config",
      severity: "High",
      details: { operation: "adminUpdatePlatformConfig" }
    });
    throw err;
  }

  const { patch, actionType, summary } = request.data || {};
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new HttpsError("invalid-argument", "Platform configuration patch object is required.");
  }

  const configRef = db.collection("platformConfig").doc("public");
  const snap = await configRef.get();
  const prev = snap.exists ? (snap.data() || {}) : {};

  const allowedUpdates = {};
  const previousValues = {};

  if (patch.maintenanceMode !== undefined) {
    if (typeof patch.maintenanceMode !== "boolean") {
      throw new HttpsError("invalid-argument", "maintenanceMode must be a boolean.");
    }
    previousValues.maintenanceMode = Boolean(prev.maintenanceMode);
    allowedUpdates.maintenanceMode = patch.maintenanceMode;
  }

  if (patch.maintenanceMessage !== undefined) {
    const msg = String(patch.maintenanceMessage || "").trim().slice(0, 600);
    previousValues.maintenanceMessage = prev.maintenanceMessage || null;
    allowedUpdates.maintenanceMessage = msg || "JK FixHub is undergoing scheduled maintenance.";
  }

  if (patch.maintenanceStart !== undefined) {
    previousValues.maintenanceStart = prev.maintenanceStart || null;
    if (patch.maintenanceStart === null || patch.maintenanceStart === "") {
      allowedUpdates.maintenanceStart = null;
    } else {
      const startMs = Date.parse(String(patch.maintenanceStart));
      if (Number.isNaN(startMs)) {
        throw new HttpsError("invalid-argument", "Invalid maintenanceStart timestamp.");
      }
      allowedUpdates.maintenanceStart = new Date(startMs).toISOString();
    }
  }

  if (patch.maintenanceEnd !== undefined) {
    previousValues.maintenanceEnd = prev.maintenanceEnd || null;
    if (patch.maintenanceEnd === null || patch.maintenanceEnd === "") {
      allowedUpdates.maintenanceEnd = null;
    } else {
      const endMs = Date.parse(String(patch.maintenanceEnd));
      if (Number.isNaN(endMs)) {
        throw new HttpsError("invalid-argument", "Invalid maintenanceEnd timestamp.");
      }
      allowedUpdates.maintenanceEnd = new Date(endMs).toISOString();
    }
  }

  const effStart = allowedUpdates.maintenanceStart !== undefined ? allowedUpdates.maintenanceStart : (prev.maintenanceStart || null);
  const effEnd = allowedUpdates.maintenanceEnd !== undefined ? allowedUpdates.maintenanceEnd : (prev.maintenanceEnd || null);
  if (effStart && effEnd && Date.parse(effEnd) <= Date.parse(effStart)) {
    throw new HttpsError("invalid-argument", "maintenanceEnd must be after maintenanceStart.");
  }

  if (patch.customerRegistrationEnabled !== undefined) {
    if (typeof patch.customerRegistrationEnabled !== "boolean") {
      throw new HttpsError("invalid-argument", "customerRegistrationEnabled must be a boolean.");
    }
    previousValues.customerRegistrationEnabled = prev.customerRegistrationEnabled !== false;
    allowedUpdates.customerRegistrationEnabled = patch.customerRegistrationEnabled;
  }

  if (patch.workerRegistrationEnabled !== undefined) {
    if (typeof patch.workerRegistrationEnabled !== "boolean") {
      throw new HttpsError("invalid-argument", "workerRegistrationEnabled must be a boolean.");
    }
    previousValues.workerRegistrationEnabled = prev.workerRegistrationEnabled !== false;
    allowedUpdates.workerRegistrationEnabled = patch.workerRegistrationEnabled;
  }

  if (patch.newRequestsEnabled !== undefined) {
    if (typeof patch.newRequestsEnabled !== "boolean") {
      throw new HttpsError("invalid-argument", "newRequestsEnabled must be a boolean.");
    }
    previousValues.newRequestsEnabled = prev.newRequestsEnabled !== false;
    allowedUpdates.newRequestsEnabled = patch.newRequestsEnabled;
  }

  if (patch.newRequestsPauseMessage !== undefined) {
    const msg = String(patch.newRequestsPauseMessage || "").trim().slice(0, 500);
    previousValues.newRequestsPauseMessage = prev.newRequestsPauseMessage || null;
    allowedUpdates.newRequestsPauseMessage = msg || "New service requests are temporarily paused.";
  }

  if (patch.services !== undefined) {
    if (!Array.isArray(patch.services) || patch.services.length === 0 || patch.services.length > 100) {
      throw new HttpsError("invalid-argument", "services must be a non-empty array (max 100).");
    }
    const sanitizedServices = patch.services.map((s) => {
      if (!s || typeof s.name !== "string" || !s.name.trim() || s.name.trim().length > 80) {
        throw new HttpsError("invalid-argument", "Each service must have a valid name (1-80 chars).");
      }
      const name = s.name.trim();
      const id = String(s.id || name.toLowerCase().replace(/[^a-z0-9]+/g, "-")).slice(0, 80);
      return {
        id,
        name,
        description: String(s.description || "").trim().slice(0, 240),
        enabled: s.enabled !== false,
        updatedAt: new Date().toISOString()
      };
    });
    previousValues.disabledServices = prev.disabledServices || [];
    allowedUpdates.services = sanitizedServices;
    allowedUpdates.disabledServices = expandDisabledServices(sanitizedServices);
  }

  if (patch.districts !== undefined) {
    if (!Array.isArray(patch.districts) || patch.districts.length === 0 || patch.districts.length > 100) {
      throw new HttpsError("invalid-argument", "districts must be a non-empty array (max 100).");
    }
    const sanitizedDistricts = patch.districts.map((d) => {
      if (!d || typeof d.name !== "string" || !d.name.trim() || d.name.trim().length > 80) {
        throw new HttpsError("invalid-argument", "Each district must have a valid name.");
      }
      const name = d.name.trim();
      const id = String(d.id || name.toLowerCase().replace(/[^a-z0-9]+/g, "-")).slice(0, 80);
      return {
        id,
        name,
        enabled: d.enabled !== false,
        updatedAt: new Date().toISOString()
      };
    });
    previousValues.disabledDistricts = prev.disabledDistricts || [];
    allowedUpdates.districts = sanitizedDistricts;
    allowedUpdates.disabledDistricts = sanitizedDistricts
      .filter((d) => !d.enabled)
      .map((d) => d.name.toLowerCase());
  }

  if (Object.keys(allowedUpdates).length === 0) {
    throw new HttpsError("invalid-argument", "No valid platform configuration fields provided.");
  }

  allowedUpdates.updatedAt = new Date().toISOString();

  await configRef.set(allowedUpdates, { merge: true });

  const auditAction = typeof actionType === "string" && actionType.trim()
    ? actionType.trim().slice(0, 64)
    : "PLATFORM_CONFIG_UPDATED";

  await recordAuditEvent(db, {
    actorUid: adminRecord.uid,
    action: auditAction,
    targetType: "platform_config",
    targetId: "public",
    result: "success",
    details: {
      previousValues,
      newValues: allowedUpdates,
      ...(summary ? { summary: String(summary).slice(0, 300) } : {})
    }
  });

  return { success: true, updatedAt: allowedUpdates.updatedAt, config: allowedUpdates };
}

/**
 * Admin: Create, update, publish, pause, archive, or delete platform announcements.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {object} request
 */
async function adminManageAnnouncement(db, request) {
  let adminRecord;
  try {
    adminRecord = await assertActiveAdmin(db, request);
  } catch (err) {
    await recordSecurityEvent(db, {
      type: "UNAUTHORIZED_ADMIN_ACTION",
      actorUid: request?.auth?.uid || null,
      targetType: "announcement",
      severity: "High",
      details: { operation: "adminManageAnnouncement" }
    });
    throw err;
  }

  const { operation, announcementId, payload } = request.data || {};
  const validOps = ["create", "update", "status", "delete"];
  if (!validOps.includes(operation)) {
    throw new HttpsError("invalid-argument", `Invalid operation. Allowed: ${validOps.join(", ")}.`);
  }

  const nowIso = new Date().toISOString();

  if (operation === "delete") {
    validateEntityId(announcementId, "announcement");
    const ref = db.collection("announcements").doc(String(announcementId));
    const snap = await ref.get();
    if (!snap.exists) {
      throw new HttpsError("not-found", "Announcement not found.");
    }
    const prev = snap.data() || {};
    await ref.delete();
    await recordAuditEvent(db, {
      actorUid: adminRecord.uid,
      action: "ANNOUNCEMENT_DELETED",
      targetType: "announcement",
      targetId: announcementId,
      result: "success",
      details: { previousTitle: prev.title || null, previousStatus: prev.status || null }
    });
    return { success: true, announcementId };
  }

  if (operation === "status") {
    validateEntityId(announcementId, "announcement");
    const newStatus = payload?.status;
    if (!ALLOWED_ANNOUNCEMENT_STATUSES.includes(newStatus)) {
      throw new HttpsError("invalid-argument", `Invalid announcement status '${newStatus}'.`);
    }
    const ref = db.collection("announcements").doc(String(announcementId));
    const snap = await ref.get();
    if (!snap.exists) {
      throw new HttpsError("not-found", "Announcement not found.");
    }
    const prev = snap.data() || {};
    const statusUpdate = {
      status: newStatus,
      updatedAt: nowIso,
      updatedBy: adminRecord.uid
    };
    if (newStatus === "published" && !prev.publishAt) {
      statusUpdate.publishAt = nowIso;
      statusUpdate.publishAtMs = Date.now();
    }
    await ref.update(statusUpdate);
    await recordAuditEvent(db, {
      actorUid: adminRecord.uid,
      action: `ANNOUNCEMENT_${newStatus.toUpperCase()}`,
      targetType: "announcement",
      targetId: announcementId,
      result: "success",
      details: { title: prev.title || null, previousStatus: prev.status || "draft", newStatus }
    });
    return { success: true, announcementId, status: newStatus };
  }

  // Create or Update
  const data = payload || {};
  const title = String(data.title || "").trim();
  const message = String(data.message || "").trim();
  const audience = String(data.audience || "everyone").toLowerCase();
  const priority = String(data.priority || "normal").toLowerCase();
  const status = String(data.status || "draft").toLowerCase();

  if (title.length < 3 || title.length > 140) {
    throw new HttpsError("invalid-argument", "Announcement title must be between 3 and 140 characters.");
  }
  if (message.length < 5 || message.length > 2000) {
    throw new HttpsError("invalid-argument", "Announcement message must be between 5 and 2000 characters.");
  }
  if (!ALLOWED_ANNOUNCEMENT_AUDIENCES.includes(audience)) {
    throw new HttpsError("invalid-argument", "Invalid audience.");
  }
  if (!ALLOWED_ANNOUNCEMENT_PRIORITIES.includes(priority)) {
    throw new HttpsError("invalid-argument", "Invalid priority.");
  }
  if (!ALLOWED_ANNOUNCEMENT_STATUSES.includes(status)) {
    throw new HttpsError("invalid-argument", "Invalid status.");
  }

  const publishAt = data.publishAt ? String(data.publishAt).trim() : nowIso;
  const publishAtMs = Date.parse(publishAt);
  if (Number.isNaN(publishAtMs)) {
    throw new HttpsError("invalid-argument", "Invalid publish date.");
  }

  let expiresAt = null;
  let expiresAtMs = NO_EXPIRY_MS;
  if (data.expiresAt && String(data.expiresAt).trim()) {
    expiresAt = String(data.expiresAt).trim();
    expiresAtMs = Date.parse(expiresAt);
    if (Number.isNaN(expiresAtMs)) {
      throw new HttpsError("invalid-argument", "Invalid expiry date.");
    }
    if (expiresAtMs <= publishAtMs) {
      throw new HttpsError("invalid-argument", "Expiry date must be after the publish date.");
    }
    expiresAt = new Date(expiresAtMs).toISOString();
  }

  const docData = {
    title,
    message,
    audience,
    priority,
    status,
    publishAt: new Date(publishAtMs).toISOString(),
    publishAtMs,
    expiresAt,
    expiresAtMs,
    updatedAt: nowIso,
    updatedBy: adminRecord.uid
  };

  if (operation === "create") {
    docData.createdAt = nowIso;
    docData.createdBy = adminRecord.uid;
    const addedRef = await db.collection("announcements").add(docData);
    await recordAuditEvent(db, {
      actorUid: adminRecord.uid,
      action: status === "published" ? "ANNOUNCEMENT_PUBLISHED" : "ANNOUNCEMENT_CREATED",
      targetType: "announcement",
      targetId: addedRef.id,
      result: "success",
      details: { title, audience, priority, status }
    });
    return { success: true, announcementId: addedRef.id, announcement: { id: addedRef.id, ...docData } };
  }

  // Update existing
  validateEntityId(announcementId, "announcement");
  const ref = db.collection("announcements").doc(String(announcementId));
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Announcement not found.");
  }
  const prev = snap.data() || {};
  await ref.update(docData);
  await recordAuditEvent(db, {
    actorUid: adminRecord.uid,
    action: "ANNOUNCEMENT_EDITED",
    targetType: "announcement",
    targetId: announcementId,
    result: "success",
    details: {
      previousStatus: prev.status || null,
      newStatus: status,
      title,
      audience,
      priority
    }
  });
  return { success: true, announcementId, announcement: { id: announcementId, ...docData } };
}

module.exports = {
  ALLOWED_WORKER_STATUSES,
  ALLOWED_CUSTOMER_STATUSES,
  ALLOWED_REPORT_STATUSES,
  ALLOWED_REVIEW_STATUSES,
  ALLOWED_ANNOUNCEMENT_AUDIENCES,
  ALLOWED_ANNOUNCEMENT_PRIORITIES,
  ALLOWED_ANNOUNCEMENT_STATUSES,
  validateEntityId,
  adminUpdateWorkerStatus,
  adminUpdateCustomerStatus,
  adminUpdatePlatformConfig,
  adminManageAnnouncement,
  adminModerateReport,
  adminModerateReview
};
