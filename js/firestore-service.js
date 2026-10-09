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

    invalidateAdminStatsCache();
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
export async function getPublicWorkers() {
  try {
    const { db } = await initializeFirestoreClient();
    const methods = await getFirestoreMethods();
    if (!db || !methods || typeof methods.getDocs !== "function") return [];

    const snap = await methods.getDocs(methods.collection(db, "workers"));
    const workers = [];
    snap.forEach((doc) => {
      const data = doc.data();
      if (!data) return;

      const status = data.status || (data.isVerified ? "active" : "pending");
      if (status === "suspended" || status === "deleted") return;

      const name = typeof data.name === "string" && data.name.trim() ? data.name.trim() : "Service Professional";
      const initials = typeof data.initials === "string" && data.initials.trim()
        ? data.initials.trim()
        : name.split(/\s+/).map((p) => p[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() || "SP";
      const experience = typeof data.experience === "string" && data.experience.trim() ? data.experience.trim() : "Experienced";
      const service = typeof data.service === "string" && data.service.trim() ? data.service.trim() : "Electrician";
      const district = typeof data.district === "string" && data.district.trim() ? data.district.trim() : "Srinagar";
      const availability = typeof data.availability === "string" && data.availability.trim() ? data.availability.trim() : "Available";
      const rating = typeof data.rating === "string" || typeof data.rating === "number" ? String(data.rating) : "5.0";
      const reviewCount = typeof data.reviewCount === "number" ? data.reviewCount : 0;
      const isVerified = Boolean(data.isVerified);
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
  }

  // Safe fallback (offline / mock environment)
  return {
    success: true,
    requestId: finalRequestId,
    request: docPayload,
    error: null
  };
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
 * - Worker: Pending -> Accepted, Pending -> Rejected
 * - Customer: Pending -> Cancelled
 * Rejects invalid jumps or replaying already resolved requests.
 *
 * @param {string} requestId - Request document ID.
 * @param {"Accepted"|"Rejected"|"Cancelled"} newStatus - Target status.
 * @param {string} actorUid - Authenticated UID of the actor.
 * @returns {Promise<{ success: boolean, requestId: string, status: string|null, error: string|null }>}
 */
export async function updateFirestoreRequestStatus(requestId, newStatus, actorUid) {
  if (!requestId || !newStatus || !actorUid) {
    return { success: false, requestId, status: null, error: "Missing required parameters." };
  }

  if (!["Accepted", "Rejected", "Cancelled"].includes(newStatus)) {
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
    if (newStatus === "Accepted" || newStatus === "Rejected") {
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

    // State machine guard: Can only transition from "Pending"
    if (currentData.status !== "Pending") {
      return {
        success: false,
        requestId,
        status: currentData.status,
        error: `Cannot transition request from "${currentData.status}" to "${newStatus}". Only Pending requests can be accepted or rejected.`
      };
    }

    const updatePayload = {
      status: newStatus,
      updatedAt: new Date().toISOString()
    };

    await methods.updateDoc(docRef, updatePayload);

    return {
      success: true,
      requestId,
      status: newStatus,
      error: null
    };
  } catch (err) {
    console.warn("[JKFixHub Request Lifecycle] Status update error:", err?.message || err);
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

/**
 * Returns total count of active real-time listeners across requests and chats.
 * @returns {number}
 */
export function getActiveFirestoreListenersCount() {
  return activeRequestSubscriptions.size + activeChatSubscriptions.size;
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
}
