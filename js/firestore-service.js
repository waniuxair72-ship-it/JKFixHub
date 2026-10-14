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

// In-memory session cache for overview stats
let cachedOverviewStats = null;
let statsCachedAt = 0;
const STATS_CACHE_TTL_MS = 25000;
let inflightStatsPromise = null;

export function invalidateAdminStatsCache() {
  cachedOverviewStats = null;
  statsCachedAt = 0;
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

  const now = Date.now();
  if (cachedOverviewStats && now - statsCachedAt < STATS_CACHE_TTL_MS) {
    return { ...cachedOverviewStats };
  }

  if (inflightStatsPromise) {
    return inflightStatsPromise;
  }

  inflightStatsPromise = (async () => {
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

      cachedOverviewStats = { ...stats };
      statsCachedAt = Date.now();
      return stats;
    } catch (err) {
      console.warn("[JKFixHub Admin] Could not retrieve overview metrics:", err?.message || err);
      return stats;
    } finally {
      inflightStatsPromise = null;
    }
  })();

  return inflightStatsPromise;
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

    const workersSnap = await methods.getDocs(methods.collection(db, "workers"));
    let usersSnap = null;
    try {
      usersSnap = await methods.getDocs(methods.collection(db, "users"));
    } catch (_) {}

    const contactMap = new Map();
    const userWorkerMap = new Map();
    if (usersSnap && typeof usersSnap.forEach === "function") {
      usersSnap.forEach((uDoc) => {
        const u = typeof uDoc.data === "function" ? uDoc.data() : uDoc.data;
        if (u) {
          contactMap.set(uDoc.id, { email: u.email || null, phone: u.phone || null });
          if (u.role === "worker") {
            userWorkerMap.set(uDoc.id, u);
          }
        }
      });
    }

    const workers = [];
    workersSnap.forEach((doc) => {
      const data = (typeof doc.data === "function" ? doc.data() : doc.data) || {};
      const contact = contactMap.get(doc.id) || {};
      workers.push({
        id: doc.id,
        ...data,
        isVerified: Boolean(data.isVerified),
        status: data.status || (data.isVerified ? "active" : "pending"),
        email: data.email || contact.email || null,
        phone: data.phone || contact.phone || null
      });
    });

    // Also defensively include any registered users with role: 'worker' missing from workers collection
    userWorkerMap.forEach((u, uid) => {
      if (!workers.some((w) => w.id === uid)) {
        workers.push({
          id: uid,
          uid: uid,
          name: u.name || "Worker",
          district: u.district || "Srinagar",
          service: u.service || "General Maintenance",
          experience: u.experience || "1 year",
          availability: "Available",
          rating: "5.0",
          reviewCount: 0,
          isVerified: false,
          status: "pending",
          createdAt: u.createdAt || null,
          email: u.email || null,
          phone: u.phone || null
        });
      }
    });

    return workers;
  } catch (err) {
    console.warn("[JKFixHub Admin] Workers fetch failed:", err?.message || err);
    return [];
  }
}

/**
 * Updates worker moderation status or verification with authoritative admin checks,
 * strict privacy data separation (never stores email/phone in /workers), and immutable audit logs.
 *
 * @param {string} workerId
 * @param {object} updates - e.g. { status: "active", isVerified: true }
 * @param {string} adminUid
 * @param {object} [options={}] - Optional reason or adminNotes
 * @returns {Promise<{ success: boolean, error: string|null, previousStatus?: string, newStatus?: string, isVerified?: boolean }>}
 */
export async function updateAdminWorkerStatus(workerId, updates, adminUid, { reason = "", adminNotes = "" } = {}) {
  if (!isSessionAuthorizedAdmin()) {
    return { success: false, error: "Access unavailable. This area is restricted to authorized administrators." };
  }

  if (!workerId || typeof workerId !== "string" || !workerId.trim()) {
    return { success: false, error: "Worker ID is required." };
  }

  if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
    return { success: false, error: "Invalid worker updates payload." };
  }

  const validStatuses = ["pending", "active", "suspended", "rejected"];
  if (updates.status !== undefined && !validStatuses.includes(updates.status)) {
    return { success: false, error: `Invalid worker status '${updates.status}'.` };
  }

  try {
    const { db } = await initializeFirestoreClient();
    const methods = await getFirestoreMethods();
    if (!db || !methods || (typeof methods.updateDoc !== "function" && typeof methods.setDoc !== "function")) {
      return { success: false, error: "Firestore unavailable" };
    }

    const workerRef = methods.doc(db, "workers", String(workerId).trim());

    // Retrieve previous state for accurate audit logging if getDoc is available
    let previousStatus = "unknown";
    let previousVerified = false;
    let existingDoc = false;
    if (typeof methods.getDoc === "function") {
      try {
        const snap = await methods.getDoc(workerRef);
        if (snap && (typeof snap.exists === "function" ? snap.exists() : snap.exists)) {
          existingDoc = true;
          const d = (typeof snap.data === "function" ? snap.data() : snap.data) || {};
          previousStatus = d.status || "unknown";
          previousVerified = Boolean(d.isVerified);
        }
      } catch (_) {}
    }

    // Strictly enforce privacy data separation: NEVER write email or phone to /workers
    const cleanUpdates = { ...updates };
    delete cleanUpdates.email;
    delete cleanUpdates.phone;

    cleanUpdates.updatedAt = new Date().toISOString();
    cleanUpdates.lastModeratedBy = adminUid;

    const note = (adminNotes || reason || "").trim();
    if (note) {
      cleanUpdates.adminNotes = note;
    }

    // Determine specific audit action
    let auditAction = "WORKER_STATUS_UPDATED";
    if (cleanUpdates.isVerified === true && (cleanUpdates.status === "active" || cleanUpdates.status === undefined)) {
      auditAction = "WORKER_APPROVED";
    } else if (cleanUpdates.status === "suspended") {
      auditAction = "WORKER_SUSPENDED";
    } else if (cleanUpdates.status === "active") {
      auditAction = "WORKER_RESTORED";
    } else if (cleanUpdates.status === "rejected") {
      auditAction = "WORKER_REJECTED";
    } else if (cleanUpdates.status === "pending") {
      auditAction = "WORKER_PENDING_RESET";
    }

    // Perform database write
    if (typeof methods.updateDoc === "function" && existingDoc) {
      await methods.updateDoc(workerRef, cleanUpdates);
    } else if (typeof methods.setDoc === "function") {
      await methods.setDoc(workerRef, cleanUpdates, { merge: true });
    } else if (typeof methods.updateDoc === "function") {
      await methods.updateDoc(workerRef, cleanUpdates);
    }

    await recordAdminAuditLog({
      adminUid,
      action: auditAction,
      targetType: "worker",
      targetId: String(workerId).trim(),
      result: "success",
      details: {
        previousStatus,
        previousVerified,
        newStatus: cleanUpdates.status ?? previousStatus,
        newVerified: cleanUpdates.isVerified ?? previousVerified,
        reason: note || "Administrative moderation"
      }
    });

    invalidateAdminStatsCache();
    return {
      success: true,
      error: null,
      previousStatus,
      newStatus: cleanUpdates.status ?? previousStatus,
      isVerified: cleanUpdates.isVerified ?? previousVerified
    };
  } catch (err) {
    console.error("[JKFixHub Admin] Worker status update failed:", err?.message || err);
    return { success: false, error: err?.message || "Failed to update worker status." };
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
      const data = typeof doc.data === "function" ? doc.data() : doc.data;
      requests.push({ id: doc.id, ...data });
    });
    return requests;
  } catch (err) {
    console.warn("[JKFixHub Admin] Requests fetch failed:", err?.message || err);
    return [];
  }
}

/**
 * Administratively moderates or updates a service request lifecycle status.
 *
 * @param {string} requestId - Target request document ID.
 * @param {string} newStatus - "Pending" | "Accepted" | "Completed" | "Cancelled" | "Rejected"
 * @param {string} adminUid - Authenticated administrator UID.
 * @param {object} [options={}] - Optional reason or adminNotes.
 * @returns {Promise<{ success: boolean, error: string|null, previousStatus?: string, newStatus?: string }>}
 */
export async function updateAdminRequestStatus(requestId, newStatus, adminUid, { reason = "", adminNotes = "" } = {}) {
  if (!isSessionAuthorizedAdmin()) {
    return { success: false, error: "Access unavailable. This area is restricted to authorized administrators." };
  }

  const validStatuses = ["Pending", "Accepted", "Completed", "Cancelled", "Rejected"];
  if (!requestId || !newStatus || !validStatuses.includes(newStatus)) {
    return { success: false, error: `Invalid request status '${newStatus}'.` };
  }

  try {
    const { db } = await initializeFirestoreClient();
    const methods = await getFirestoreMethods();
    if (!db || !methods || typeof methods.doc !== "function" || typeof methods.updateDoc !== "function") {
      return { success: false, error: "Firestore client unavailable." };
    }

    const requestRef = methods.doc(db, "requests", String(requestId));

    let previousStatus = "Unknown";
    let customerId = null;
    let workerUid = null;
    if (typeof methods.getDoc === "function") {
      try {
        const snap = await methods.getDoc(requestRef);
        if (snap && (typeof snap.exists === "function" ? snap.exists() : snap.exists)) {
          const data = (typeof snap.data === "function" ? snap.data() : snap.data) || {};
          previousStatus = data.status || "Unknown";
          customerId = data.customerId || null;
          workerUid = data.workerUid || null;
        }
      } catch (_) {}
    }

    const updates = {
      status: newStatus,
      updatedAt: new Date().toISOString(),
      lastModeratedBy: adminUid
    };

    const note = (adminNotes || reason || "").trim();
    if (note) {
      updates.adminNotes = note;
    }

    await methods.updateDoc(requestRef, updates);

    await recordAdminAuditLog({
      adminUid,
      action: `REQUEST_${newStatus.toUpperCase()}`,
      targetType: "request",
      targetId: String(requestId),
      result: "success",
      details: {
        previousStatus,
        newStatus,
        reason: note || "Administrative moderation",
        customerId,
        workerUid
      }
    });

    invalidateAdminStatsCache();
    return { success: true, error: null, previousStatus, newStatus };
  } catch (err) {
    console.error("[JKFixHub Admin] Request moderation failed:", err?.message || err);
    return { success: false, error: err?.message || "Failed to update service request status." };
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

    invalidateAdminStatsCache();
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

    invalidateAdminStatsCache();
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

/**
 * Loads real worker profiles from Firestore /workers collection for public customer discovery.
 * Sanitizes data to never expose private worker information (phone numbers, email).
 * Filters out suspended or inactive accounts.
 * @returns {Promise<Array<object>>}
 */
export async function getPublicWorkers({ throwOnError = false } = {}) {
  try {
    const { db } = await initializeFirestoreClient();
    const methods = await getFirestoreMethods();
    if (!db || !methods || typeof methods.getDocs !== "function" || typeof methods.collection !== "function") {
      if (throwOnError) throw new Error("Firestore client or methods unavailable.");
      return [];
    }

    if (typeof methods.query !== "function" || typeof methods.where !== "function") {
      console.warn("[JKFixHub Discovery] Query constraints unavailable. Public discovery deferred.");
      if (throwOnError) throw new Error("Query constraints unavailable.");
      return [];
    }

    const workersCol = methods.collection(db, "workers");
    const q = methods.query(
      workersCol,
      methods.where("isVerified", "==", true),
      methods.where("status", "==", "active")
    );

    const snap = await methods.getDocs(q);
    const workers = [];
    snap.forEach((doc) => {
      if (!doc || typeof doc.id !== "string" || !doc.id.trim()) return;

      const data = typeof doc.data === "function" ? doc.data() : doc.data;
      if (!data || typeof data !== "object" || Array.isArray(data)) return;

      // Approval gating: strictly verified AND active
      if (data.isVerified !== true || data.status !== "active") return;

      // Malformed profile checks: must have valid string name, service, and district
      if (typeof data.name !== "string" || !data.name.trim()) return;
      if (typeof data.service !== "string" || !data.service.trim()) return;
      if (typeof data.district !== "string" || !data.district.trim()) return;

      const name = data.name.trim();
      const service = data.service.trim();
      const district = data.district.trim();
      const initials = typeof data.initials === "string" && data.initials.trim()
        ? data.initials.trim()
        : name.split(/\s+/).map((p) => p[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() || "SP";
      const experience = typeof data.experience === "string" && data.experience.trim() ? data.experience.trim() : "Experienced";
      const availability = typeof data.availability === "string" && data.availability.trim() ? data.availability.trim() : "Available";
      const rating = typeof data.rating === "string" || typeof data.rating === "number" ? String(data.rating) : "5.0";
      const reviewCount = typeof data.reviewCount === "number" ? data.reviewCount : 0;
      const isVerified = true;
      const status = "active";
      const services = Array.isArray(data.services) && data.services.length
        ? data.services.join(", ")
        : service;
      const about = typeof data.about === "string" && data.about.trim()
        ? data.about.trim()
        : `${experience} specialist providing reliable ${service.toLowerCase()} services in ${district}.`;

      workers.push({
        id: doc.id,
        uid: doc.id,
        name,
        initials,
        service,
        services,
        district,
        experience,
        availability,
        rating,
        reviewCount,
        isVerified,
        status,
        about,
        isDemo: false
      });
    });
    return workers;
  } catch (err) {
    console.warn("[JKFixHub Discovery] Real workers fetch notice:", err?.message || err);
    if (throwOnError) throw err;
    return [];
  }
}

/**
 * Creates a real service request document in Cloud Firestore /requests/{requestId}.
 * Initial status is strictly "Pending".
 *
 * @param {object} requestData
 * @param {string} requestData.customerId - Authenticated customer UID.
 * @param {string} requestData.customerName - Customer name.
 * @param {string} requestData.workerUid - Assigned worker UID.
 * @param {string} [requestData.workerId] - Worker ID (matches workerUid).
 * @param {string} requestData.workerName - Assigned worker name.
 * @param {string} requestData.service - Requested service category.
 * @param {string} requestData.district - Operational district.
 * @param {string} requestData.problemDescription - Description of the issue.
 * @param {string} requestData.customerLocation - Customer location/area.
 * @param {string} [requestData.preferredTime] - Preferred timing.
 * @param {string} [requestData.status] - Initial status (must be "Pending").
 * @param {string} [requestData.createdAt] - Creation timestamp.
 * @returns {Promise<{ success: boolean, requestId: string|null, request: object|null, error: string|null }>}
 */
export async function createFirestoreServiceRequest(requestData) {
  const customerId = requestData?.customerId || requestData?.customerUid;
  const workerUid = requestData?.workerUid || requestData?.workerId;
  const problemDescription = requestData?.problemDescription || requestData?.description;
  const customerLocation = requestData?.customerLocation || requestData?.location || "";
  const customerName = requestData?.customerName;
  const workerName = requestData?.workerName;
  const workerId = requestData?.workerId || workerUid;
  const service = requestData?.service;
  const district = requestData?.district;
  const preferredTime = requestData?.preferredTime || "As soon as possible";
  const status = requestData?.status || "Pending";
  const createdAt = requestData?.createdAt || new Date().toISOString();

  if (!customerId || !workerUid || !customerName || !service || !problemDescription) {
    return {
      success: false,
      requestId: null,
      request: null,
      error: "Missing required service request fields."
    };
  }

  const generateId = () => `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  const finalRequestId = requestData.requestId || requestData.id || generateId();

  const docPayload = {
    id: finalRequestId,
    requestId: finalRequestId,
    customerId: String(customerId),
    customerName: String(customerName).trim(),
    workerUid: String(workerUid),
    workerId: String(workerId || workerUid),
    workerName: String(workerName).trim(),
    service: String(service).trim(),
    district: String(district).trim(),
    problemDescription: String(problemDescription).trim(),
    description: String(problemDescription).trim(),
    customerLocation: String(customerLocation || "").trim(),
    location: String(customerLocation || "").trim(),
    preferredTime: String(preferredTime),
    status: "Pending",
    createdAt,
    submittedAt: createdAt,
    updatedAt: createdAt
  };

  try {
    const { db } = await initializeFirestoreClient();
    const methods = await getFirestoreMethods();

    if (db && methods && typeof methods.collection === "function" && typeof methods.setDoc === "function") {
      const docRef = methods.doc(db, "requests", finalRequestId);
      await methods.setDoc(docRef, docPayload);

      return {
        success: true,
        requestId: finalRequestId,
        request: docPayload,
        error: null
      };
    }

    return {
      success: false,
      requestId: null,
      request: null,
      error: "Service request database is unavailable. Please check your connection and try again."
    };
  } catch (err) {
    console.warn("[JKFixHub Request] Direct Firestore write encountered:", err?.message || err);
    if (err?.code === "permission-denied") {
      return {
        success: false,
        requestId: null,
        request: null,
        error: "Permission denied. Ensure you are authenticated as a customer."
      };
    }
    return {
      success: false,
      requestId: null,
      request: null,
      error: err?.message || "Failed to submit service request. Please try again."
    };
  }
}

/**
 * Loads service requests assigned to a worker from Cloud Firestore /requests.
 * Queries where workerUid == workerUid to satisfy Firestore Security Rules.
 *
 * @param {string} workerUid - Authenticated worker's UID.
 * @returns {Promise<Array<object>>}
 */
export async function getWorkerFirestoreRequests(workerUid) {
  if (!workerUid || typeof workerUid !== "string") return [];

  try {
    const { db } = await initializeFirestoreClient();
    const methods = await getFirestoreMethods();

    if (!db || !methods || typeof methods.collection !== "function") return [];

    const colRef = methods.collection(db, "requests");
    const q = methods.query(
      colRef,
      methods.where("workerUid", "==", workerUid)
    );

    const snapshot = await methods.getDocs(q);
    const requests = [];

    snapshot.forEach((doc) => {
      const data = doc.data();
      if (!data) return;
      requests.push({
        id: doc.id,
        requestId: data.requestId || doc.id,
        ...data
      });
    });

    requests.sort((a, b) => {
      const timeA = new Date(a.createdAt || 0).getTime();
      const timeB = new Date(b.createdAt || 0).getTime();
      return timeB - timeA;
    });

    return requests;
  } catch (err) {
    console.warn("[JKFixHub Worker Dashboard] Requests fetch error:", err?.message || err);
    return [];
  }
}

/**
 * Loads service requests submitted by a customer from Cloud Firestore /requests.
 * Queries where customerId == customerUid to satisfy Firestore Security Rules.
 *
 * @param {string} customerUid - Authenticated customer's UID.
 * @returns {Promise<Array<object>>}
 */
export async function getCustomerFirestoreRequests(customerUid) {
  if (!customerUid || typeof customerUid !== "string") return [];

  try {
    const { db } = await initializeFirestoreClient();
    const methods = await getFirestoreMethods();

    if (!db || !methods || typeof methods.collection !== "function") return [];

    const colRef = methods.collection(db, "requests");
    const q = methods.query(
      colRef,
      methods.where("customerId", "==", customerUid)
    );

    const snapshot = await methods.getDocs(q);
    const requests = [];

    snapshot.forEach((doc) => {
      const data = doc.data();
      if (!data) return;
      requests.push({
        id: doc.id,
        requestId: data.requestId || doc.id,
        ...data
      });
    });

    requests.sort((a, b) => {
      const timeA = new Date(a.createdAt || 0).getTime();
      const timeB = new Date(b.createdAt || 0).getTime();
      return timeB - timeA;
    });

    return requests;
  } catch (err) {
    console.warn("[JKFixHub Customer] Requests fetch error:", err?.message || err);
    return [];
  }
}

/**
 * Updates the status of a service request in Cloud Firestore.
 * Enforces strict finite-state machine transitions:
 * - Worker: Pending -> Accepted, Pending -> Rejected, Accepted -> Completed
 * - Customer: Pending -> Cancelled
 * Rejects invalid jumps or replaying already resolved requests.
 *
 * @param {string} requestId - Request document ID.
 * @param {"Accepted"|"Rejected"|"Cancelled"|"Completed"} newStatus - Target status.
 * @param {string} actorUid - Authenticated UID of the actor.
 * @returns {Promise<{ success: boolean, requestId: string, status: string|null, error: string|null }>}
 */
export async function updateFirestoreRequestStatus(requestId, newStatus, actorUid) {
  if (!requestId || !newStatus || !actorUid) {
    return { success: false, requestId, status: null, error: "Missing required parameters." };
  }

  if (!["Accepted", "Rejected", "Cancelled", "Completed"].includes(newStatus)) {
    return { success: false, requestId, status: null, error: `Invalid status transition to ${newStatus}.` };
  }

  try {
    const { db } = await initializeFirestoreClient();
    const methods = await getFirestoreMethods();

    if (!db || !methods || typeof methods.doc !== "function" || typeof methods.getDoc !== "function") {
      return { success: false, requestId, status: null, error: "Firestore client unavailable." };
    }

    const docRef = methods.doc(db, "requests", requestId);
    const docSnap = await methods.getDoc(docRef);

    if (!docSnap.exists()) {
      return { success: false, requestId, status: null, error: `Request #${requestId} not found.` };
    }

    const currentData = docSnap.data();

    // Authorization checks
    if (newStatus === "Accepted" || newStatus === "Rejected" || newStatus === "Completed") {
      if (currentData.workerUid !== actorUid) {
        return {
          success: false,
          requestId,
          status: currentData.status,
          error: "Unauthorized: You are not the worker assigned to this request."
        };
      }
    } else if (newStatus === "Cancelled") {
      if (currentData.customerId !== actorUid) {
        return {
          success: false,
          requestId,
          status: currentData.status,
          error: "Unauthorized: You are not the customer who created this request."
        };
      }
    }

    // Idempotency: Already in requested state
    if (currentData.status === newStatus) {
      return { success: true, requestId, status: newStatus, error: null };
    }

    // State machine guard:
    // - Worker completing must transition from "Accepted"
    // - Worker accepting/rejecting or customer cancelling must transition from "Pending"
    if (newStatus === "Completed") {
      if (currentData.status !== "Accepted") {
        return {
          success: false,
          requestId,
          status: currentData.status,
          error: `Cannot complete request in "${currentData.status}" status. Request must be "Accepted" before completion.`
        };
      }
    } else {
      if (currentData.status !== "Pending") {
        return {
          success: false,
          requestId,
          status: currentData.status,
          error: `Cannot transition request from "${currentData.status}" to "${newStatus}". Only Pending requests can be updated.`
        };
      }
    }

    const nowIso = new Date().toISOString();
    const updatePayload = {
      status: newStatus,
      updatedAt: nowIso
    };
    if (newStatus === "Accepted") {
      updatePayload.acceptedAt = nowIso;
    } else if (newStatus === "Rejected") {
      updatePayload.rejectedAt = nowIso;
    } else if (newStatus === "Completed") {
      updatePayload.completedAt = nowIso;
    } else if (newStatus === "Cancelled") {
      updatePayload.cancelledAt = nowIso;
    }

    await methods.updateDoc(docRef, updatePayload);

    return {
      success: true,
      requestId,
      status: newStatus,
      error: null
    };
  } catch (err) {
    console.warn("[JKFixHub Request Lifecycle] Status update error:", err?.message || err);
    if (err?.code === "permission-denied") {
      let friendlyError = "Permission denied. You are not authorized to update this request.";
      if (newStatus === "Cancelled") {
        friendlyError = "Unable to cancel request. It may have already been accepted or is no longer pending.";
      } else if (newStatus === "Accepted" || newStatus === "Rejected") {
        friendlyError = "Unable to update request. It may have already been cancelled or is not assigned to you.";
      } else if (newStatus === "Completed") {
        friendlyError = "Unable to complete request. Only the assigned professional can complete an accepted request.";
      }
      return {
        success: false,
        requestId,
        status: null,
        error: friendlyError
      };
    }
    return {
      success: false,
      requestId,
      status: null,
      error: err?.message || "Failed to update request status in Firestore."
    };
  }
}

// ==========================================
// #REALTIME_REQUEST_SUBSCRIPTIONS
// ==========================================

const activeRequestSubscriptions = new Map();
const activeChatSubscriptions = new Map();
const activeWorkerSubscriptions = new Map();

/**
 * Returns total count of active real-time listeners across requests, chats, and worker dashboards.
 * @returns {number}
 */
export function getActiveFirestoreListenersCount() {
  return activeRequestSubscriptions.size + activeChatSubscriptions.size + activeWorkerSubscriptions.size;
}

/**
 * Subscribes to real-time updates for a single request document in Cloud Firestore.
 * Automatically cleans up any previous listener for the same requestId to prevent duplication.
 *
 * @param {string} requestId - Request document ID.
 * @param {Function} onUpdate - Callback invoked with doc data on change.
 * @param {Function} [onError] - Optional error callback.
 * @returns {Promise<Function>} Resolves to an unsubscribe function.
 */
export async function subscribeToFirestoreRequest(requestId, onUpdate, onError) {
  if (!requestId || typeof onUpdate !== "function") {
    return () => {};
  }

  // Deduplicate: Clean up existing listener for this requestId if any
  if (activeRequestSubscriptions.has(requestId)) {
    try {
      const oldUnsub = activeRequestSubscriptions.get(requestId);
      if (typeof oldUnsub === "function") oldUnsub();
    } catch (err) {
      console.warn(`[JKFixHub Realtime] Error cleaning up previous listener for ${requestId}:`, err);
    }
    activeRequestSubscriptions.delete(requestId);
  }

  let isCleanedUp = false;

  const cleanup = (actualUnsubscribe) => {
    if (isCleanedUp) return;
    isCleanedUp = true;
    activeRequestSubscriptions.delete(requestId);
    if (typeof actualUnsubscribe === "function") {
      try {
        actualUnsubscribe();
      } catch (err) {
        console.warn(`[JKFixHub Realtime] Error during unsubscribe for ${requestId}:`, err);
      }
    }
  };

  try {
    const { db } = await initializeFirestoreClient();
    const methods = await getFirestoreMethods();

    if (!db || !methods || typeof methods.doc !== "function" || typeof methods.onSnapshot !== "function") {
      console.warn("[JKFixHub Realtime] Firestore onSnapshot method unavailable.");
      return () => {};
    }

    const docRef = methods.doc(db, "requests", requestId);

    const actualUnsubscribe = methods.onSnapshot(
      docRef,
      (docSnap) => {
        if (isCleanedUp || !docSnap) return;
        const exists = typeof docSnap.exists === "function" ? docSnap.exists() : Boolean(docSnap.data);
        if (exists) {
          const rawData = typeof docSnap.data === "function" ? docSnap.data() : docSnap;
          if (rawData) {
            onUpdate({
              id: docSnap.id || requestId,
              requestId: rawData.requestId || docSnap.id || requestId,
              ...rawData
            });
          }
        }
      },
      (err) => {
        console.warn(`[JKFixHub Realtime] Error listening to request ${requestId}:`, err?.message || err);
        if (typeof onError === "function") onError(err);
      }
    );

    const unsubWrapper = () => cleanup(actualUnsubscribe);

    if (isCleanedUp) {
      if (typeof actualUnsubscribe === "function") actualUnsubscribe();
      return () => {};
    }

    activeRequestSubscriptions.set(requestId, unsubWrapper);
    return unsubWrapper;
  } catch (err) {
    console.warn(`[JKFixHub Realtime] Failed to subscribe to request ${requestId}:`, err?.message || err);
    return () => {};
  }
}

/**
 * Stops and clears any active Firestore subscription for a specific worker.
 * @param {string} workerUid
 */
export function unsubscribeWorkerFirestoreRequests(workerUid) {
  if (!workerUid) return;
  const workerKey = String(workerUid);
  if (activeWorkerSubscriptions.has(workerKey)) {
    try {
      const unsub = activeWorkerSubscriptions.get(workerKey);
      if (typeof unsub === "function") unsub();
    } catch (err) {
      console.warn(`[JKFixHub Worker Realtime] Error stopping listener for ${workerKey}:`, err);
    }
    activeWorkerSubscriptions.delete(workerKey);
  }
}

/**
 * Subscribes to real-time updates for service requests assigned to an authenticated worker.
 * Queries Firestore /requests where workerUid == workerUid.
 * Deduplicates active listeners for the worker and returns an unsubscribe function.
 *
 * @param {string} workerUid - Authenticated worker UID.
 * @param {Function} onUpdate - Callback invoked with Array<object> of updated requests.
 * @param {Function} [onError] - Optional callback invoked on listener errors or permission failures.
 * @returns {Promise<Function>} Resolves to an unsubscribe function.
 */
export async function subscribeToWorkerFirestoreRequests(workerUid, onUpdate, onError) {
  if (!workerUid || typeof onUpdate !== "function") {
    return () => {};
  }

  const workerKey = String(workerUid);

  // Deduplicate: Clean up existing listener for this worker if any
  unsubscribeWorkerFirestoreRequests(workerKey);

  let isCleanedUp = false;

  const cleanup = (actualUnsubscribe) => {
    if (isCleanedUp) return;
    isCleanedUp = true;
    activeWorkerSubscriptions.delete(workerKey);
    if (typeof actualUnsubscribe === "function") {
      try {
        actualUnsubscribe();
      } catch (err) {
        console.warn(`[JKFixHub Worker Realtime] Error during unsubscribe for ${workerKey}:`, err);
      }
    }
  };

  try {
    const { db } = await initializeFirestoreClient();
    const methods = await getFirestoreMethods();

    if (
      !db ||
      !methods ||
      typeof methods.collection !== "function" ||
      typeof methods.query !== "function" ||
      typeof methods.where !== "function" ||
      typeof methods.onSnapshot !== "function"
    ) {
      console.warn("[JKFixHub Worker Realtime] Firestore onSnapshot or query methods unavailable.");
      if (typeof onError === "function") {
        onError(new Error("Real-time requests service is currently unavailable."));
      }
      return () => {};
    }

    const colRef = methods.collection(db, "requests");
    const q = methods.query(colRef, methods.where("workerUid", "==", workerKey));

    const actualUnsubscribe = methods.onSnapshot(
      q,
      (snapshot) => {
        if (isCleanedUp || !snapshot) return;
        const requests = [];
        if (typeof snapshot.forEach === "function") {
          snapshot.forEach((doc) => {
            const data = typeof doc.data === "function" ? doc.data() : doc;
            if (!data) return;
            requests.push({
              id: doc.id,
              requestId: data.requestId || doc.id,
              ...data
            });
          });
        }
        requests.sort((a, b) => {
          if (a.status === "Pending" && b.status !== "Pending") return -1;
          if (a.status !== "Pending" && b.status === "Pending") return 1;
          return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
        });
        onUpdate(requests);
      },
      (err) => {
        console.warn(`[JKFixHub Worker Realtime] Error listening to requests for worker ${workerKey}:`, err?.message || err);
        if (typeof onError === "function") onError(err);
      }
    );

    const unsubWrapper = () => cleanup(actualUnsubscribe);

    if (isCleanedUp) {
      if (typeof actualUnsubscribe === "function") actualUnsubscribe();
      return () => {};
    }

    activeWorkerSubscriptions.set(workerKey, unsubWrapper);
    return unsubWrapper;
  } catch (err) {
    console.warn(`[JKFixHub Worker Realtime] Failed to subscribe to worker ${workerKey}:`, err?.message || err);
    if (typeof onError === "function") onError(err);
    return () => {};
  }
}

/**
 * Retrieves a single service request by its ID from Firestore /requests/{requestId}.
 *
 * @param {string} requestId - Unique ID of request.
 * @returns {Promise<object|null>}
 */
export async function getFirestoreRequestById(requestId) {
  if (!requestId) return null;
  try {
    const { db } = await initializeFirestoreClient();
    const methods = await getFirestoreMethods();
    if (!db || !methods || typeof methods.doc !== "function" || typeof methods.getDoc !== "function") {
      return null;
    }
    const docRef = methods.doc(db, "requests", requestId);
    const snap = await methods.getDoc(docRef);
    if (!snap || (typeof snap.exists === "function" ? !snap.exists() : !snap.exists)) {
      return null;
    }
    const data = typeof snap.data === "function" ? snap.data() : snap;
    return {
      id: snap.id || requestId,
      requestId: data.requestId || snap.id || requestId,
      ...data
    };
  } catch (err) {
    console.warn(`[JKFixHub Chat] Error fetching request #${requestId}:`, err?.message || err);
    return null;
  }
}

/**
 * Ensures a private Firestore conversation document exists under /chats/{chatId}.
 * The chatId is deterministically requestId.
 *
 * @param {object} requestData - The service request document.
 * @param {string} actorUid - Authenticated UID (customer or worker).
 * @returns {Promise<{ success: boolean, conversation: object|null, error: string|null }>}
 */
export async function getOrCreateFirestoreConversation(requestData, actorUid) {
  if (!requestData || !requestData.id) {
    return { success: false, conversation: null, error: "Invalid request data for chat." };
  }

  const chatId = String(requestData.id);
  const customerId = requestData.customerId || requestData.customerUid;
  const workerUid = requestData.workerUid || requestData.workerId;

  if (!customerId || !workerUid) {
    return { success: false, conversation: null, error: "Missing customer or worker identifier." };
  }

  if (actorUid && actorUid !== customerId && actorUid !== workerUid) {
    return { success: false, conversation: null, error: "Unauthorized: You are not a participant in this conversation." };
  }

  const conversationPayload = {
    id: chatId,
    requestId: chatId,
    customerId,
    customerUid: customerId,
    customerName: requestData.customerName || "Customer",
    workerId: workerUid,
    workerUid,
    workerName: requestData.workerName || "Worker",
    service: requestData.service || "",
    district: requestData.district || "",
    participants: [customerId, workerUid],
    status: "active",
    createdAt: requestData.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  try {
    const { db } = await initializeFirestoreClient();
    const methods = await getFirestoreMethods();

    if (!db || !methods || typeof methods.doc !== "function" || typeof methods.getDoc !== "function" || typeof methods.setDoc !== "function") {
      return { success: false, conversation: null, error: "Firestore service is unavailable." };
    }

    const docRef = methods.doc(db, "chats", chatId);
    const docSnap = await methods.getDoc(docRef);

    if (docSnap && (typeof docSnap.exists === "function" ? docSnap.exists() : docSnap.exists)) {
      const data = typeof docSnap.data === "function" ? docSnap.data() : docSnap;
      return {
        success: true,
        conversation: {
          id: docSnap.id || chatId,
          ...data
        },
        error: null
      };
    }

    await methods.setDoc(docRef, conversationPayload);
    return {
      success: true,
      conversation: conversationPayload,
      error: null
    };
  } catch (err) {
    console.warn(`[JKFixHub Chat] Conversation get/create error for ${chatId}:`, err?.message || err);
    return {
      success: false,
      conversation: null,
      error: "Failed to access or create chat conversation."
    };
  }
}

/**
 * Writes a new chat message into /chats/{chatId}/messages/{messageId}.
 *
 * @param {object} params
 * @param {string} params.chatId - The conversation ID (requestId).
 * @param {string} params.text - The message body.
 * @param {string} params.senderUid - The sender UID (must equal auth UID).
 * @param {string} params.senderName - The sender's display name.
 * @param {"customer"|"worker"} params.senderRole - The sender's role.
 * @returns {Promise<{ success: boolean, message: object|null, error: string|null }>}
 */
export async function sendFirestoreChatMessage({ chatId, text, senderUid, senderName, senderRole }) {
  if (!chatId || !text || !senderUid) {
    return { success: false, message: null, error: "Missing required chat message parameters." };
  }

  const messagePayload = {
    chatId,
    senderId: senderUid,
    senderUid: senderUid,
    senderName: senderName || "User",
    senderRole: senderRole || "customer",
    text: text.trim(),
    createdAt: new Date().toISOString()
  };

  try {
    const { db } = await initializeFirestoreClient();
    const methods = await getFirestoreMethods();

    if (!db || !methods || typeof methods.collection !== "function" || typeof methods.addDoc !== "function") {
      return { success: false, message: null, error: "Firestore service is unavailable." };
    }

    const messagesCol = methods.collection(db, "chats", chatId, "messages");
    const docRef = await methods.addDoc(messagesCol, messagePayload);

    try {
      if (typeof methods.updateDoc === "function") {
        const chatDocRef = methods.doc(db, "chats", chatId);
        await methods.updateDoc(chatDocRef, {
          updatedAt: new Date().toISOString(),
          lastMessageText: text.trim()
        });
      }
    } catch (_) {}

    return {
      success: true,
      message: {
        id: docRef.id,
        ...messagePayload
      },
      error: null
    };
  } catch (err) {
    console.warn(`[JKFixHub Chat] Error sending message to ${chatId}:`, err?.message || err);
    return {
      success: false,
      message: null,
      error: "Failed to send message."
    };
  }
}

/**
 * Subscribes to real-time chat messages for /chats/{chatId}/messages.
 *
 * @param {string} chatId - Conversation ID.
 * @param {Function} onUpdate - Callback with sorted Array of message objects.
 * @param {Function} [onError] - Callback on error.
 * @returns {Promise<Function>} Unsubscribe function.
 */
export async function subscribeToFirestoreChatMessages(chatId, onUpdate, onError) {
  if (!chatId || typeof onUpdate !== "function") {
    return () => {};
  }

  if (activeChatSubscriptions.has(chatId)) {
    try {
      const prev = activeChatSubscriptions.get(chatId);
      if (typeof prev === "function") prev();
    } catch (err) {
      console.warn(`[JKFixHub Chat] Error cleaning up previous listener for ${chatId}:`, err);
    }
    activeChatSubscriptions.delete(chatId);
  }

  let isCleanedUp = false;

  const cleanup = (actualUnsubscribe) => {
    if (isCleanedUp) return;
    isCleanedUp = true;
    activeChatSubscriptions.delete(chatId);
    if (typeof actualUnsubscribe === "function") {
      try {
        actualUnsubscribe();
      } catch (err) {
        console.warn(`[JKFixHub Chat] Error during chat unsubscribe for ${chatId}:`, err);
      }
    }
  };

  try {
    const { db } = await initializeFirestoreClient();
    const methods = await getFirestoreMethods();

    if (!db || !methods || typeof methods.collection !== "function" || typeof methods.onSnapshot !== "function") {
      if (typeof onError === "function") {
        onError(new Error("Firestore service is unavailable."));
      }
      return () => {};
    }

    const messagesCol = methods.collection(db, "chats", chatId, "messages");

    const actualUnsubscribe = methods.onSnapshot(
      messagesCol,
      (snapshot) => {
        if (isCleanedUp || !snapshot) return;
        const messages = [];
        if (typeof snapshot.forEach === "function") {
          snapshot.forEach((doc) => {
            const data = typeof doc.data === "function" ? doc.data() : doc;
            if (data) {
              messages.push({
                id: doc.id,
                ...data
              });
            }
          });
        }
        messages.sort((a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime());
        onUpdate(messages);
      },
      (err) => {
        console.warn(`[JKFixHub Chat] Error listening to messages for ${chatId}:`, err?.message || err);
        if (typeof onError === "function") onError(err);
      }
    );

    const unsubWrapper = () => cleanup(actualUnsubscribe);

    if (isCleanedUp) {
      if (typeof actualUnsubscribe === "function") actualUnsubscribe();
      return () => {};
    }

    activeChatSubscriptions.set(chatId, unsubWrapper);
    return unsubWrapper;
  } catch (err) {
    console.warn(`[JKFixHub Chat] Failed to subscribe to chat ${chatId}:`, err?.message || err);
    if (typeof onError === "function") onError(err);
    return () => {};
  }
}

/**
 * Unsubscribes all active Firestore real-time listeners across the application.
 * Called on user logout or session reset.
 */
export function unsubscribeAllFirestoreListeners() {
  for (const [id, unsub] of activeRequestSubscriptions.entries()) {
    try {
      if (typeof unsub === "function") unsub();
    } catch (err) {
      console.warn(`[JKFixHub Realtime] Error cleaning up listener for ${id}:`, err);
    }
  }
  activeRequestSubscriptions.clear();

  for (const [id, unsub] of activeChatSubscriptions.entries()) {
    try {
      if (typeof unsub === "function") unsub();
    } catch (err) {
      console.warn(`[JKFixHub Chat] Error cleaning up chat listener for ${id}:`, err);
    }
  }
  activeChatSubscriptions.clear();

  for (const [id, unsub] of activeWorkerSubscriptions.entries()) {
    try {
      if (typeof unsub === "function") unsub();
    } catch (err) {
      console.warn(`[JKFixHub Worker Realtime] Error cleaning up worker listener for ${id}:`, err);
    }
  }
  activeWorkerSubscriptions.clear();
}

// ==========================================
// #SAFETY_REPORTS_PERSISTENCE
// ==========================================

/**
 * Creates and persists a Trust & Safety report in Cloud Firestore /reports collection.
 * Validates reporter identity, target type, and sanitized report content.
 *
 * @param {object} reportData
 * @param {string} reportData.reporterUid - Authenticated reporter UID.
 * @param {string} reportData.targetType - "worker" | "customer" | "review" | "message"
 * @param {string} reportData.targetId - ID of the reported entity
 * @param {string} reportData.reason - Incident reason code
 * @param {string} reportData.description - Detailed incident explanation
 * @returns {Promise<{ success: boolean, reportId: string|null, report: object|null, error: string|null }>}
 */
export async function createFirestoreReport(reportData) {
  const reporterUid = reportData?.reporterUid || reportData?.reporterId;
  const targetType = reportData?.targetType;
  const targetId = reportData?.targetId;
  const reason = reportData?.reason;
  const description = reportData?.description;

  if (!reporterUid || !targetType || !targetId || !reason || !description) {
    return {
      success: false,
      reportId: null,
      report: null,
      error: "Missing required safety report fields."
    };
  }

  const allowedTargetTypes = ["worker", "customer", "review", "message"];
  if (!allowedTargetTypes.includes(targetType)) {
    return {
      success: false,
      reportId: null,
      report: null,
      error: "Invalid report target type."
    };
  }

  const cleanDescription = String(description).trim();
  if (cleanDescription.length < 5 || cleanDescription.length > 2000) {
    return {
      success: false,
      reportId: null,
      report: null,
      error: "Report description must be between 5 and 2,000 characters."
    };
  }

  const generateId = () => `rep-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  const finalReportId = reportData.id || reportData.reportId || generateId();

  const docPayload = {
    id: finalReportId,
    reportId: finalReportId,
    reporterUid: String(reporterUid),
    reporterId: String(reporterUid),
    targetType: String(targetType),
    targetId: String(targetId).trim(),
    reason: String(reason).trim(),
    description: cleanDescription,
    status: "open",
    createdAt: new Date().toISOString(),
    resolvedAt: null,
    resolvedBy: null
  };

  try {
    const { db } = await initializeFirestoreClient();
    const methods = await getFirestoreMethods();

    if (db && methods && typeof methods.collection === "function" && typeof methods.setDoc === "function") {
      const docRef = methods.doc(db, "reports", finalReportId);
      await methods.setDoc(docRef, docPayload);

      return {
        success: true,
        reportId: finalReportId,
        report: docPayload,
        error: null
      };
    }

    return {
      success: false,
      reportId: null,
      report: null,
      error: "Trust & Safety database is unavailable. Please check your connection and try again."
    };
  } catch (err) {
    console.warn("[JKFixHub Report] Direct Firestore write encountered:", err?.message || err);
    if (err?.code === "permission-denied") {
      return {
        success: false,
        reportId: null,
        report: null,
        error: "Permission denied. Ensure you are signed in to submit a safety report."
      };
    }
    return {
      success: false,
      reportId: null,
      report: null,
      error: err?.message || "Failed to submit safety report. Please try again."
    };
  }
}

// ==========================================
// #CUSTOMER_REVIEWS_PERSISTENCE
// ==========================================

/**
 * Creates and persists a customer review in Cloud Firestore /reviews collection.
 * Enforces that:
 * - Reviewer is the authenticated customer who created the request.
 * - Underlying service request authoritatively has status "Completed".
 * - Exactly one review per request (idempotent / duplicate prevention).
 * - Rating is strictly bounded between 1 and 5.
 *
 * @param {object} reviewData
 * @param {string} reviewData.customerId - Authenticated customer UID.
 * @param {string} reviewData.requestId - ID of the completed service request.
 * @param {number} reviewData.rating - Integer rating 1 to 5.
 * @param {string} reviewData.text - Review commentary.
 * @returns {Promise<{ success: boolean, reviewId: string|null, review: object|null, error: string|null }>}
 */
export async function createFirestoreReview(reviewData) {
  const customerId = reviewData?.customerId || reviewData?.customerUid;
  const requestId = reviewData?.requestId;
  const rating = Number(reviewData?.rating);
  const text = typeof reviewData?.text === "string" ? reviewData.text.trim() : "";

  if (!customerId || !requestId || !Number.isInteger(rating) || rating < 1 || rating > 5 || !text) {
    return {
      success: false,
      reviewId: null,
      review: null,
      error: "Missing or invalid review fields (rating must be an integer between 1 and 5)."
    };
  }

  try {
    const { db } = await initializeFirestoreClient();
    const methods = await getFirestoreMethods();

    if (!db || !methods || typeof methods.doc !== "function" || typeof methods.getDoc !== "function" || typeof methods.setDoc !== "function") {
      return {
        success: false,
        reviewId: null,
        review: null,
        error: "Reviews database is unavailable. Please check your connection and try again."
      };
    }

    // 1. Authoritatively fetch the underlying service request from Firestore
    const reqRef = methods.doc(db, "requests", requestId);
    const reqSnap = await methods.getDoc(reqRef);

    if (!reqSnap.exists()) {
      return {
        success: false,
        reviewId: null,
        review: null,
        error: `Service request #${requestId} not found.`
      };
    }

    const requestDoc = reqSnap.data();

    // 2. Ownership check: caller must be the customer on the request
    if (requestDoc.customerId !== customerId) {
      return {
        success: false,
        reviewId: null,
        review: null,
        error: "Unauthorized: You can only submit reviews for your own service requests."
      };
    }

    // 3. Completion check: request must be Completed
    if (requestDoc.status !== "Completed") {
      return {
        success: false,
        reviewId: null,
        review: null,
        error: `Reviews can only be submitted for completed service requests. Current status: "${requestDoc.status}".`
      };
    }

    // 4. Duplicate check: verify no review exists for this request
    const finalReviewId = reviewData.reviewId || reviewData.id || requestId;
    const reviewRef = methods.doc(db, "reviews", finalReviewId);
    const existingSnap = await methods.getDoc(reviewRef);

    if (existingSnap.exists()) {
      return {
        success: false,
        reviewId: finalReviewId,
        review: existingSnap.data(),
        error: "A review has already been submitted for this service request."
      };
    }

    const workerId = requestDoc.workerUid || requestDoc.workerId || reviewData.workerId || null;
    const workerName = requestDoc.workerName || reviewData.workerName || "Service Professional";
    const customerName = requestDoc.customerName || reviewData.customerName || "Customer";

    const docPayload = {
      id: finalReviewId,
      reviewId: finalReviewId,
      requestId,
      customerId: String(customerId),
      customerName: String(customerName).trim(),
      workerUid: String(workerId),
      workerId: String(workerId),
      workerName: String(workerName).trim(),
      rating,
      text,
      status: "published",
      createdAt: new Date().toISOString(),
      updatedAt: null,
      workerReply: null,
      workerReplyAt: null
    };

    await methods.setDoc(reviewRef, docPayload);

    return {
      success: true,
      reviewId: finalReviewId,
      review: docPayload,
      error: null
    };
  } catch (err) {
    console.warn("[JKFixHub Review] Direct Firestore write encountered:", err?.message || err);
    if (err?.code === "permission-denied") {
      return {
        success: false,
        reviewId: null,
        review: null,
        error: "Permission denied. Reviews may only be submitted by the verified customer for completed requests."
      };
    }
    return {
      success: false,
      reviewId: null,
      review: null,
      error: err?.message || "Failed to submit review. Please try again."
    };
  }
}

/**
 * Loads published customer reviews for a given worker from Cloud Firestore.
 * @param {string|number} workerId
 * @returns {Promise<Array<object>>}
 */
export async function getWorkerFirestoreReviews(workerId) {
  if (!workerId) return [];

  try {
    const { db } = await initializeFirestoreClient();
    const methods = await getFirestoreMethods();

    if (!db || !methods || typeof methods.collection !== "function") return [];

    const colRef = methods.collection(db, "reviews");
    let snapshot;
    if (typeof methods.query === "function" && typeof methods.where === "function") {
      const q = methods.query(
        colRef,
        methods.where("workerUid", "==", String(workerId)),
        methods.where("status", "==", "published")
      );
      snapshot = await methods.getDocs(q);
    } else {
      snapshot = await methods.getDocs(colRef);
    }

    const reviews = [];
    if (snapshot && typeof snapshot.forEach === "function") {
      snapshot.forEach((doc) => {
        const data = typeof doc.data === "function" ? doc.data() : doc;
        if (!data) return;
        if (String(data.workerUid) === String(workerId) || String(data.workerId) === String(workerId)) {
          if (data.status === "published") {
            reviews.push({ id: doc.id, ...data });
          }
        }
      });
    }

    reviews.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
    return reviews;
  } catch (err) {
    console.warn("[JKFixHub Review] Worker reviews fetch error:", err?.message || err);
    throw err;
  }
}

/**
 * Adds or updates a worker reply to a customer review in Cloud Firestore.
 * @param {string} reviewId
 * @param {string} replyText
 * @param {string} workerUid
 * @returns {Promise<{ success: boolean, error: string|null }>}
 */
export async function addFirestoreWorkerReviewReply(reviewId, replyText, workerUid) {
  if (!reviewId || !replyText || !workerUid) {
    return { success: false, error: "Missing required parameters." };
  }

  try {
    const { db } = await initializeFirestoreClient();
    const methods = await getFirestoreMethods();

    if (!db || !methods || typeof methods.doc !== "function" || typeof methods.updateDoc !== "function") {
      return { success: false, error: "Reviews database unavailable." };
    }

    const reviewRef = methods.doc(db, "reviews", String(reviewId));
    const nowIso = new Date().toISOString();

    await methods.updateDoc(reviewRef, {
      workerReply: String(replyText).trim(),
      workerReplyAt: nowIso,
      updatedAt: nowIso
    });

    return { success: true, error: null };
  } catch (err) {
    console.warn("[JKFixHub Review] Worker reply update error:", err?.message || err);
    return { success: false, error: err?.message || "Failed to update review reply." };
  }
}

/**
 * Fetches a single review by its review document ID from Cloud Firestore.
 * @param {string} reviewId
 * @returns {Promise<object|null>}
 */
export async function getFirestoreReviewById(reviewId) {
  if (!reviewId) return null;

  try {
    const { db } = await initializeFirestoreClient();
    const methods = await getFirestoreMethods();

    if (!db || !methods || typeof methods.doc !== "function" || typeof methods.getDoc !== "function") {
      return null;
    }

    const reviewRef = methods.doc(db, "reviews", String(reviewId));
    const snap = await methods.getDoc(reviewRef);
    if (!snap.exists()) return null;

    const data = typeof snap.data === "function" ? snap.data() : snap;
    return { id: snap.id, ...data };
  } catch (err) {
    console.warn("[JKFixHub Review] Fetch review by ID error:", err?.message || err);
    return null;
  }
}

/**
 * Fetches a review associated with a service request ID from Cloud Firestore.
 * Checks direct ID matches (requestId, rev-<requestId>) and queries by requestId field.
 * @param {string} requestId
 * @returns {Promise<object|null>}
 */
export async function getFirestoreReviewByRequestId(requestId) {
  if (!requestId) return null;

  try {
    const { db } = await initializeFirestoreClient();
    const methods = await getFirestoreMethods();

    if (!db || !methods) return null;

    // 1. Direct document lookups (common ID patterns)
    if (typeof methods.doc === "function" && typeof methods.getDoc === "function") {
      const directRef = methods.doc(db, "reviews", String(requestId));
      const directSnap = await methods.getDoc(directRef);
      if (directSnap.exists()) {
        const data = typeof directSnap.data === "function" ? directSnap.data() : directSnap;
        return { id: directSnap.id, ...data };
      }

      const revRef = methods.doc(db, "reviews", `rev-${requestId}`);
      const revSnap = await methods.getDoc(revRef);
      if (revSnap.exists()) {
        const data = typeof revSnap.data === "function" ? revSnap.data() : revSnap;
        return { id: revSnap.id, ...data };
      }
    }

    // 2. Query by requestId field fallback
    if (typeof methods.collection === "function" && typeof methods.getDocs === "function") {
      const colRef = methods.collection(db, "reviews");
      let snapshot;
      if (typeof methods.query === "function" && typeof methods.where === "function") {
        const q = methods.query(colRef, methods.where("requestId", "==", String(requestId)));
        snapshot = await methods.getDocs(q);
      } else {
        snapshot = await methods.getDocs(colRef);
      }

      let match = null;
      if (snapshot && typeof snapshot.forEach === "function") {
        snapshot.forEach((doc) => {
          if (!match) {
            const data = typeof doc.data === "function" ? doc.data() : doc;
            if (data && String(data.requestId) === String(requestId)) {
              match = { id: doc.id, ...data };
            }
          }
        });
      }
      if (match) return match;
    }

    return null;
  } catch (err) {
    console.warn("[JKFixHub Review] Fetch review by requestId error:", err?.message || err);
    return null;
  }
}

/**
 * Loads reviews submitted by a given customer from Cloud Firestore.
 * @param {string} customerUid
 * @returns {Promise<Array<object>>}
 */
export async function getCustomerFirestoreReviews(customerUid) {
  if (!customerUid) return [];

  try {
    const { db } = await initializeFirestoreClient();
    const methods = await getFirestoreMethods();

    if (!db || !methods || typeof methods.collection !== "function") return [];

    const colRef = methods.collection(db, "reviews");
    let snapshot;
    if (typeof methods.query === "function" && typeof methods.where === "function") {
      const q = methods.query(
        colRef,
        methods.where("customerId", "==", String(customerUid))
      );
      snapshot = await methods.getDocs(q);
    } else {
      snapshot = await methods.getDocs(colRef);
    }

    const reviews = [];
    if (snapshot && typeof snapshot.forEach === "function") {
      snapshot.forEach((doc) => {
        const data = typeof doc.data === "function" ? doc.data() : doc;
        if (!data) return;
        if (String(data.customerId) === String(customerUid)) {
          reviews.push({ id: doc.id, ...data });
        }
      });
    }

    reviews.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
    return reviews;
  } catch (err) {
    console.warn("[JKFixHub Review] Customer reviews fetch error:", err?.message || err);
    return [];
  }
}
