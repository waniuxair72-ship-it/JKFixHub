// ==========================================
// #FIRESTORE_SERVICE
// ==========================================
// Cloud Firestore Data Access & Security Service.
//
// Core Security Principles:
// 1. All administrative operations are verified against the /admins/{uid} collection.
// 2. Client-side checks are UX only; Firestore Security Rules enforce access server-side.
// 3. Sensitive authentication tokens, passwords, and secrets are NEVER handled or stored.
// 4. Privileged actions automatically create an immutable record in /auditLogs.
// ==========================================

import {
  initializeFirestoreClient,
  getFirestoreDb,
  getFirestoreMethods
} from "./firebase-config.js";

let adminSessionProvider = null;

/**
 * Registers an authoritative admin session provider callback.
 * Ensures data queries cannot initialize or execute before an active admin session is authorized.
 *
 * @param {Function} provider - Function returning active admin session object or null.
 */
export function registerAdminSessionProvider(provider) {
  if (typeof provider === "function") {
    adminSessionProvider = provider;
  }
}

/**
 * Internal guard validating that an authorized admin session is active before querying Firestore.
 * @returns {boolean}
 */
function isSessionAuthorizedAdmin() {
  if (!adminSessionProvider || typeof adminSessionProvider !== "function") {
    return false;
  }
  const session = adminSessionProvider();
  return Boolean(
    session &&
    typeof session.uid === "string" &&
    session.role === "admin" &&
    session.active === true
  );
}

/**
 * Verifies whether a given Firebase UID corresponds to an active administrator
 * in the Cloud Firestore /admins/{uid} collection.
 *
 * @param {string} uid - Authenticated Firebase UID.
 * @returns {Promise<{ isAuthorized: boolean, adminData: object|null, error: string|null }>}
 */
export async function verifyAdminAuthorization(uid) {
  if (!uid || typeof uid !== "string") {
    return {
      isAuthorized: false,
      adminData: null,
      error: "Access unavailable. This area is restricted to authorized administrators."
    };
  }

  try {
    const { db } = await initializeFirestoreClient();
    const methods = await getFirestoreMethods();

    if (!db || !methods || typeof methods.getDoc !== "function") {
      return {
        isAuthorized: false,
        adminData: null,
        error: "Access unavailable. This area is restricted to authorized administrators."
      };
    }

    const adminRef = methods.doc(db, "admins", uid);
    const docSnap = await methods.getDoc(adminRef);

    if (!docSnap.exists() || docSnap.id !== uid) {
      return {
        isAuthorized: false,
        adminData: null,
        error: "Access unavailable. This area is restricted to authorized administrators."
      };
    }

    const data = docSnap.data();
    if (!data || data.active !== true || data.role !== "admin" || (data.uid && data.uid !== uid)) {
      return {
        isAuthorized: false,
        adminData: null,
        error: "Access unavailable. This area is restricted to authorized administrators."
      };
    }

    const adminData = {
      uid,
      email: data.email || null,
      displayName: data.displayName || "Platform Administrator",
      role: "admin",
      active: true,
      capabilities: Array.isArray(data.capabilities)
        ? data.capabilities
        : ["accessAdmin", "manageWorkers", "manageReports", "manageReviews", "viewSecurityEvents", "viewAuditLog"],
      createdAt: data.createdAt || null
    };

    return {
      isAuthorized: true,
      adminData,
      error: null
    };
  } catch (err) {
    console.error("[JKFixHub Security] Admin verification check failed:", err?.code || err?.message || err);
    return {
      isAuthorized: false,
      adminData: null,
      error: "Access unavailable. This area is restricted to authorized administrators."
    };
  }
}

/**
 * Creates an append-only audit log entry in /auditLogs collection.
 *
 * @param {object} logData
 * @param {string} logData.adminUid - Authenticated Admin UID.
 * @param {string} logData.action - Action identifier (e.g., WORKER_APPROVED).
 * @param {string} logData.targetType - Target entity type (worker, report, review).
 * @param {string} logData.targetId - ID of target entity.
 * @param {string} logData.result - Outcome (success, failure).
 * @param {object} [logData.details] - Non-sensitive context.
 * @returns {Promise<boolean>}
 */
export async function recordAdminAuditLog({ adminUid, action, targetType, targetId, result = "success", details = {} }) {
  if (!adminUid || !action) return false;

  try {
    const { db } = await initializeFirestoreClient();
    const methods = await getFirestoreMethods();
    if (!db || !methods || typeof methods.addDoc !== "function") return false;

    const auditEntry = {
      adminUid,
      action: String(action),
      targetType: String(targetType || "general"),
      targetId: String(targetId || "unknown"),
      result: String(result),
      details: typeof details === "object" && details !== null ? details : {},
      timestamp: typeof methods.serverTimestamp === "function" ? methods.serverTimestamp() : new Date().toISOString()
    };

    const auditCollection = methods.collection(db, "auditLogs");
    await methods.addDoc(auditCollection, auditEntry);
    return true;
  } catch (err) {
    console.warn("[JKFixHub Security] Audit log recording failed:", err?.message || err);
    return false;
  }
}

/**
 * Fetches overview metric counts from Firestore collections.
 * @returns {Promise<object>} Live statistics map.
 */
export async function getAdminOverviewStats() {
  const stats = {
    totalCustomers: 0,
    totalWorkers: 0,
    pendingWorkerVerification: 0,
    activeRequests: 0,
    completedRequests: 0,
    openReports: 0,
    reportedReviews: 0,
    securityEvents: 0
  };

  if (!isSessionAuthorizedAdmin()) {
    return stats;
  }

  try {
    const { db } = await initializeFirestoreClient();
    const methods = await getFirestoreMethods();
    if (!db || !methods || typeof methods.getDocs !== "function") return stats;

    // Helper for safe query snapshot
    const fetchCount = async (collName, filterField, filterVal) => {
      try {
        let collRef = methods.collection(db, collName);
        let q = collRef;
        if (filterField && filterVal !== undefined && typeof methods.where === "function" && typeof methods.query === "function") {
          q = methods.query(collRef, methods.where(filterField, "==", filterVal));
        }
        const snap = await methods.getDocs(q);
        return snap.size;
      } catch (e) {
        return 0;
      }
    };

    // Workers
    try {
      const workersSnap = await methods.getDocs(methods.collection(db, "workers"));
      stats.totalWorkers = workersSnap.size;
      let pending = 0;
      workersSnap.forEach((doc) => {
        const d = doc.data();
        if (d.isVerified === false || d.status === "pending") pending++;
      });
      stats.pendingWorkerVerification = pending;
    } catch {}

    // Customers (from users collection where role == 'customer')
    try {
      const usersSnap = await methods.getDocs(methods.collection(db, "users"));
      let customers = 0;
      usersSnap.forEach((doc) => {
        const d = doc.data();
        if (d.role === "customer") customers++;
      });
      stats.totalCustomers = customers;
    } catch {}

    // Requests
    try {
      const reqSnap = await methods.getDocs(methods.collection(db, "requests"));
      let active = 0;
      let completed = 0;
      reqSnap.forEach((doc) => {
        const d = doc.data();
        if (d.status === "Completed") completed++;
        else if (d.status === "Accepted" || d.status === "Pending") active++;
      });
      stats.activeRequests = active;
      stats.completedRequests = completed;
    } catch {}

    // Reports
    try {
      const repSnap = await methods.getDocs(methods.collection(db, "reports"));
      let open = 0;
      repSnap.forEach((doc) => {
        const d = doc.data();
        if (d.status !== "resolved" && d.status !== "dismissed") open++;
      });
      stats.openReports = open;
    } catch {}

    // Reviews (reported or flagged)
    try {
      const revSnap = await methods.getDocs(methods.collection(db, "reviews"));
      let reported = 0;
      revSnap.forEach((doc) => {
        const d = doc.data();
        if (d.status === "flagged" || d.status === "reported") reported++;
      });
      stats.reportedReviews = reported;
    } catch {}

    // Security Events
    stats.securityEvents = await fetchCount("securityEvents");

    return stats;
  } catch (err) {
    console.warn("[JKFixHub Admin] Could not retrieve overview metrics:", err?.message || err);
    return stats;
  }
}

/**
 * Fetches worker records for administration.
 * @returns {Promise<Array<object>>}
 */
export async function getAdminWorkers() {
  if (!isSessionAuthorizedAdmin()) return [];

  try {
    const { db } = await initializeFirestoreClient();
    const methods = await getFirestoreMethods();
    if (!db || !methods || typeof methods.getDocs !== "function") return [];

    const snap = await methods.getDocs(methods.collection(db, "workers"));
    const workers = [];
    snap.forEach((doc) => {
      workers.push({ id: doc.id, ...doc.data() });
    });
    return workers;
  } catch (err) {
    console.warn("[JKFixHub Admin] Workers fetch failed:", err?.message || err);
    return [];
  }
}

/**
 * Updates worker moderation status or verification.
 * @param {string} workerId
 * @param {object} updates - e.g. { status: "active", isVerified: true }
 * @param {string} adminUid
 * @returns {Promise<{ success: boolean, error: string|null }>}
 */
export async function updateAdminWorkerStatus(workerId, updates, adminUid) {
  if (!isSessionAuthorizedAdmin()) {
    return { success: false, error: "Access unavailable. This area is restricted to authorized administrators." };
  }

  try {
    const { db } = await initializeFirestoreClient();
    const methods = await getFirestoreMethods();
    if (!db || !methods || typeof methods.updateDoc !== "function") {
      return { success: false, error: "Firestore unavailable" };
    }

    const workerRef = methods.doc(db, "workers", String(workerId));
    await methods.updateDoc(workerRef, updates);

    await recordAdminAuditLog({
      adminUid,
      action: updates.isVerified ? "WORKER_APPROVED" : "WORKER_STATUS_UPDATED",
      targetType: "worker",
      targetId: workerId,
      result: "success",
      details: updates
    });

    return { success: true, error: null };
  } catch (err) {
    console.error("[JKFixHub Admin] Worker status update failed:", err?.message || err);
    return { success: false, error: "Failed to update worker status." };
  }
}

/**
 * Fetches customer profiles for administration.
 * @returns {Promise<Array<object>>}
 */
export async function getAdminCustomers() {
  if (!isSessionAuthorizedAdmin()) return [];

  try {
    const { db } = await initializeFirestoreClient();
    const methods = await getFirestoreMethods();
    if (!db || !methods || typeof methods.getDocs !== "function") return [];

    const snap = await methods.getDocs(methods.collection(db, "users"));
    const customers = [];
    snap.forEach((doc) => {
      const data = doc.data();
      if (data.role === "customer") {
        customers.push({
          id: doc.id,
          uid: data.uid || doc.id,
          name: data.name || "Customer",
          email: data.email || null,
          emailVerified: Boolean(data.emailVerified),
          district: data.district || null,
          createdAt: data.createdAt || null
        });
      }
    });
    return customers;
  } catch (err) {
    console.warn("[JKFixHub Admin] Customers fetch failed:", err?.message || err);
    return [];
  }
}

/**
 * Fetches service requests for administration.
 * @returns {Promise<Array<object>>}
 */
export async function getAdminRequests() {
  if (!isSessionAuthorizedAdmin()) return [];

  try {
    const { db } = await initializeFirestoreClient();
    const methods = await getFirestoreMethods();
    if (!db || !methods || typeof methods.getDocs !== "function") return [];

    const snap = await methods.getDocs(methods.collection(db, "requests"));
    const requests = [];
    snap.forEach((doc) => {
      requests.push({ id: doc.id, ...doc.data() });
    });
    return requests;
  } catch (err) {
    console.warn("[JKFixHub Admin] Requests fetch failed:", err?.message || err);
    return [];
  }
}

/**
 * Fetches Trust & Safety reports.
 * @returns {Promise<Array<object>>}
 */
export async function getAdminReports() {
  if (!isSessionAuthorizedAdmin()) return [];

  try {
    const { db } = await initializeFirestoreClient();
    const methods = await getFirestoreMethods();
    if (!db || !methods || typeof methods.getDocs !== "function") return [];

    const snap = await methods.getDocs(methods.collection(db, "reports"));
    const reports = [];
    snap.forEach((doc) => {
      reports.push({ id: doc.id, ...doc.data() });
    });
    return reports;
  } catch (err) {
    console.warn("[JKFixHub Admin] Reports fetch failed:", err?.message || err);
    return [];
  }
}

/**
 * Updates status of a Trust & Safety report.
 * @param {string} reportId
 * @param {string} status - "under_review" | "resolved" | "dismissed"
 * @param {string} adminUid
 * @returns {Promise<{ success: boolean, error: string|null }>}
 */
export async function updateAdminReportStatus(reportId, status, adminUid) {
  if (!isSessionAuthorizedAdmin()) {
    return { success: false, error: "Access unavailable. This area is restricted to authorized administrators." };
  }

  try {
    const { db } = await initializeFirestoreClient();
    const methods = await getFirestoreMethods();
    if (!db || !methods || typeof methods.updateDoc !== "function") {
      return { success: false, error: "Firestore unavailable" };
    }

    const reportRef = methods.doc(db, "reports", String(reportId));
    await methods.updateDoc(reportRef, {
      status,
      resolvedAt: new Date().toISOString(),
      resolvedBy: adminUid
    });

    await recordAdminAuditLog({
      adminUid,
      action: "REPORT_STATUS_UPDATED",
      targetType: "report",
      targetId: reportId,
      result: "success",
      details: { newStatus: status }
    });

    return { success: true, error: null };
  } catch (err) {
    console.error("[JKFixHub Admin] Report update failed:", err?.message || err);
    return { success: false, error: "Failed to update report status." };
  }
}

/**
 * Fetches reviews for moderation.
 * @returns {Promise<Array<object>>}
 */
export async function getAdminReviews() {
  if (!isSessionAuthorizedAdmin()) return [];

  try {
    const { db } = await initializeFirestoreClient();
    const methods = await getFirestoreMethods();
    if (!db || !methods || typeof methods.getDocs !== "function") return [];

    const snap = await methods.getDocs(methods.collection(db, "reviews"));
    const reviews = [];
    snap.forEach((doc) => {
      reviews.push({ id: doc.id, ...doc.data() });
    });
    return reviews;
  } catch (err) {
    console.warn("[JKFixHub Admin] Reviews fetch failed:", err?.message || err);
    return [];
  }
}

/**
 * Moderates review status.
 * @param {string} reviewId
 * @param {string} status - "published" | "hidden" | "flagged"
 * @param {string} adminUid
 * @returns {Promise<{ success: boolean, error: string|null }>}
 */
export async function updateAdminReviewStatus(reviewId, status, adminUid) {
  if (!isSessionAuthorizedAdmin()) {
    return { success: false, error: "Access unavailable. This area is restricted to authorized administrators." };
  }

  try {
    const { db } = await initializeFirestoreClient();
    const methods = await getFirestoreMethods();
    if (!db || !methods || typeof methods.updateDoc !== "function") {
      return { success: false, error: "Firestore unavailable" };
    }

    const reviewRef = methods.doc(db, "reviews", String(reviewId));
    await methods.updateDoc(reviewRef, {
      status,
      moderatedAt: new Date().toISOString(),
      moderatedBy: adminUid
    });

    await recordAdminAuditLog({
      adminUid,
      action: "REVIEW_MODERATED",
      targetType: "review",
      targetId: reviewId,
      result: "success",
      details: { newStatus: status }
    });

    return { success: true, error: null };
  } catch (err) {
    console.error("[JKFixHub Admin] Review moderation failed:", err?.message || err);
    return { success: false, error: "Failed to moderate review." };
  }
}

function getTimestampMillis(v) {
  if (!v) return 0;
  if (typeof v.toMillis === "function") {
    try {
      return v.toMillis();
    } catch {
      // Fall through
    }
  }
  if (typeof v.toDate === "function") {
    try {
      const d = v.toDate();
      return isNaN(d.getTime()) ? 0 : d.getTime();
    } catch {
      // Fall through
    }
  }
  if (typeof v.seconds === "number") {
    return v.seconds * 1000 + Math.floor((v.nanoseconds || 0) / 1e6);
  }
  if (typeof v._seconds === "number") {
    return v._seconds * 1000 + Math.floor((v._nanoseconds || 0) / 1e6);
  }
  if (v instanceof Date) {
    return isNaN(v.getTime()) ? 0 : v.getTime();
  }
  if (typeof v === "number" && !isNaN(v)) {
    return v < 1e11 ? v * 1000 : v;
  }
  if (typeof v === "string") {
    const t = new Date(v).getTime();
    return isNaN(t) ? 0 : t;
  }
  return 0;
}

/**
 * Fetches security events in chronological order (newest first).
 * @returns {Promise<Array<object>>}
 */
export async function getAdminSecurityEvents() {
  if (!isSessionAuthorizedAdmin()) return [];

  try {
    const { db } = await initializeFirestoreClient();
    const methods = await getFirestoreMethods();
    if (!db || !methods || typeof methods.getDocs !== "function") return [];

    const snap = await methods.getDocs(methods.collection(db, "securityEvents"));
    const events = [];
    snap.forEach((doc) => {
      events.push({ id: doc.id, ...doc.data() });
    });
    // Sort newest first
    events.sort((a, b) => getTimestampMillis(b.timestamp) - getTimestampMillis(a.timestamp));
    return events;
  } catch (err) {
    console.warn("[JKFixHub Admin] Security events fetch failed:", err?.message || err);
    return [];
  }
}

/**
 * Fetches audit log records in chronological order (newest first).
 * @returns {Promise<Array<object>>}
 */
export async function getAdminAuditLogs() {
  if (!isSessionAuthorizedAdmin()) return [];

  try {
    const { db } = await initializeFirestoreClient();
    const methods = await getFirestoreMethods();
    if (!db || !methods || typeof methods.getDocs !== "function") return [];

    const snap = await methods.getDocs(methods.collection(db, "auditLogs"));
    const logs = [];
    snap.forEach((doc) => {
      logs.push({ id: doc.id, ...doc.data() });
    });
    // Sort newest first
    logs.sort((a, b) => getTimestampMillis(b.timestamp) - getTimestampMillis(a.timestamp));
    return logs;
  } catch (err) {
    console.warn("[JKFixHub Admin] Audit logs fetch failed:", err?.message || err);
    return [];
  }
}
