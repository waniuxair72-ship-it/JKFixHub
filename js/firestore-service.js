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
import {
  normalizePlatformConfig,
  setCachedPlatformConfig,
  invalidatePlatformConfigCache,
  NO_EXPIRY_MS
} from "./platform-config.js";
import {
  sanitizeReviewTags,
  REVIEW_EDIT_WINDOW_MS
} from "./security.js";

/**
 * Pure genuine rating aggregator by worker ID from published reviews only.
 * Never invents defaults, excludes non-published/invalid entries, deduplicates by requestId/id,
 * and uses exact integer-scaled half-up rounding to 1 decimal place.
 */
function aggregatePublishedReviewsByWorker(reviews) {
  const byWorker = new Map();
  const seenKeys = new Set();

  for (const r of reviews || []) {
    if (!r || typeof r !== "object") continue;
    if (r.status !== "published") continue;

    const dedupKey = r.requestId || r.id;
    if (dedupKey) {
      if (seenKeys.has(String(dedupKey))) continue;
      seenKeys.add(String(dedupKey));
    }

    const val = Number(r.rating);
    if (!Number.isInteger(val) || val < 1 || val > 5) continue;

    const workerKey = r.workerUid ? String(r.workerUid) : (r.workerId != null ? String(r.workerId) : null);
    if (!workerKey) continue;

    if (!byWorker.has(workerKey)) {
      byWorker.set(workerKey, { sum: 0, count: 0, distribution: { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 } });
    }
    const bucket = byWorker.get(workerKey);
    bucket.sum += val;
    bucket.count += 1;
    bucket.distribution[val] += 1;
  }

  const summaries = new Map();
  for (const [workerKey, bucket] of byWorker.entries()) {
    const avg = Math.round((bucket.sum * 10) / bucket.count) / 10;
    summaries.set(workerKey, {
      rating: avg,
      reviewCount: bucket.count,
      distribution: bucket.distribution
    });
  }
  return summaries;
}

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
    suspendedCustomers: 0,
    totalWorkers: 0,
    verifiedWorkers: 0,
    pendingWorkerVerification: 0,
    suspendedWorkers: 0,
    totalRequests: 0,
    pendingRequests: 0,
    acceptedRequests: 0,
    activeRequests: 0,
    completedRequests: 0,
    rejectedRequests: 0,
    cancelledRequests: 0,
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
        let verified = 0;
        let suspended = 0;
        workersSnap.forEach((doc) => {
          const d = doc.data();
          if (d.status === "suspended") suspended++;
          if (d.isVerified === true && d.status !== "suspended") verified++;
          if (d.isVerified === false || d.status === "pending") pending++;
        });
        stats.pendingWorkerVerification = pending;
        stats.verifiedWorkers = verified;
        stats.suspendedWorkers = suspended;
      } catch {}

      // Customers (from users collection where role == 'customer')
      try {
        const usersSnap = await methods.getDocs(methods.collection(db, "users"));
        let customers = 0;
        let suspendedCust = 0;
        usersSnap.forEach((doc) => {
          const d = doc.data();
          if (d.role === "customer") {
            customers++;
            if (d.status === "suspended") suspendedCust++;
          }
        });
        stats.totalCustomers = customers;
        stats.suspendedCustomers = suspendedCust;
      } catch {}

      // Requests
      try {
        const reqSnap = await methods.getDocs(methods.collection(db, "requests"));
        stats.totalRequests = reqSnap.size;
        let pending = 0;
        let accepted = 0;
        let completed = 0;
        let rejected = 0;
        let cancelled = 0;
        reqSnap.forEach((doc) => {
          const d = doc.data();
          if (d.status === "Completed") completed++;
          else if (d.status === "Accepted") accepted++;
          else if (d.status === "Pending") pending++;
          else if (d.status === "Rejected") rejected++;
          else if (d.status === "Cancelled") cancelled++;
        });
        stats.pendingRequests = pending;
        stats.acceptedRequests = accepted;
        stats.activeRequests = pending + accepted;
        stats.completedRequests = completed;
        stats.rejectedRequests = rejected;
        stats.cancelledRequests = cancelled;
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
          rating: null,
          reviewCount: 0,
          isVerified: false,
          status: "pending",
          createdAt: u.createdAt || null,
          email: u.email || null,
          phone: u.phone || null
        });
      }
    });

    // Hydrate authoritative genuine ratings from published reviews (never show fake/stale 5.0 defaults)
    try {
      const reviewsSnap = await methods.getDocs(methods.collection(db, "reviews"));
      const allRevs = [];
      reviewsSnap.forEach((d) => allRevs.push({ id: d.id, ...d.data() }));
      const ratingsByWorker = aggregatePublishedReviewsByWorker(allRevs);
      for (const w of workers) {
        const agg = ratingsByWorker.get(String(w.id));
        if (agg && agg.reviewCount > 0) {
          w.rating = agg.rating;
          w.reviewCount = agg.reviewCount;
          w.ratingDistribution = agg.distribution;
        } else {
          w.rating = null;
          w.reviewCount = 0;
          w.ratingDistribution = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
        }
      }
    } catch {
      for (const w of workers) {
        const rc = typeof w.reviewCount === "number" ? w.reviewCount : 0;
        const parsed = Number(w.rating);
        if (rc <= 0 || Number.isNaN(parsed) || parsed < 1 || parsed > 5) {
          w.rating = null;
          w.reviewCount = 0;
        }
      }
    }

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

    // Idempotency guard: if existing worker already matches requested status & isVerified without a new note, avoid duplicate audit logs
    const statusUnchanged = cleanUpdates.status === undefined || cleanUpdates.status === previousStatus;
    const verifiedUnchanged = cleanUpdates.isVerified === undefined || cleanUpdates.isVerified === previousVerified;
    if (existingDoc && statusUnchanged && verifiedUnchanged && !note) {
      return {
        success: true,
        error: null,
        previousStatus,
        newStatus: previousStatus,
        isVerified: previousVerified,
        alreadyInState: true
      };
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
          phone: data.phone || null,
          emailVerified: Boolean(data.emailVerified),
          district: data.district || null,
          status: data.status || "active",
          suspensionReason: data.suspensionReason || null,
          suspendedAt: data.suspendedAt || null,
          suspendedBy: data.suspendedBy || null,
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

let activeAdminCustomersUnsub = null;

/**
 * Subscribes to real-time customer account updates for administration via /users collection.
 *
 * @param {Function} onUpdate - Callback with Array of customer objects.
 * @param {Function} [onError] - Callback on error.
 * @returns {Promise<Function>} Unsubscribe function.
 */
export async function subscribeToAdminCustomers(onUpdate, onError) {
  if (typeof onUpdate !== "function") return () => {};
  if (!isSessionAuthorizedAdmin()) {
    if (typeof onError === "function") onError(new Error("Unauthorized admin access."));
    return () => {};
  }

  if (typeof activeAdminCustomersUnsub === "function") {
    try { activeAdminCustomersUnsub(); } catch (_) {}
    activeAdminCustomersUnsub = null;
  }

  let isCleanedUp = false;
  try {
    const { db } = await initializeFirestoreClient();
    const methods = await getFirestoreMethods();
    if (!db || !methods || typeof methods.collection !== "function" || typeof methods.onSnapshot !== "function") {
      return () => {};
    }

    const usersCol = methods.collection(db, "users");
    const actualUnsubscribe = methods.onSnapshot(
      usersCol,
      (snapshot) => {
        if (isCleanedUp || !snapshot) return;
        const customers = [];
        if (typeof snapshot.forEach === "function") {
          snapshot.forEach((doc) => {
            const data = typeof doc.data === "function" ? doc.data() : doc;
            if (data && data.role === "customer") {
              customers.push({
                id: doc.id,
                uid: data.uid || doc.id,
                name: data.name || "Customer",
                email: data.email || null,
                phone: data.phone || null,
                emailVerified: Boolean(data.emailVerified),
                district: data.district || null,
                status: data.status || "active",
                suspensionReason: data.suspensionReason || null,
                suspendedAt: data.suspendedAt || null,
                suspendedBy: data.suspendedBy || null,
                createdAt: data.createdAt || null
              });
            }
          });
        }
        onUpdate(customers);
      },
      (err) => {
        if (!isCleanedUp) {
          console.warn("[JKFixHub Admin] Customer realtime listener notice:", err?.message || err);
          if (typeof onError === "function") onError(err);
        }
      }
    );

    const unsub = () => {
      isCleanedUp = true;
      if (activeAdminCustomersUnsub === unsub) {
        activeAdminCustomersUnsub = null;
      }
      if (typeof actualUnsubscribe === "function") {
        try { actualUnsubscribe(); } catch (_) {}
      }
    };

    activeAdminCustomersUnsub = unsub;
    return unsub;
  } catch (err) {
    console.warn("[JKFixHub Admin] Failed to subscribe to customers:", err?.message || err);
    if (typeof onError === "function") onError(err);
    return () => {};
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
export async function updateAdminReportStatus(reportId, status, adminUid, note = "") {
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
    let previousStatus = "open";
    if (typeof methods.getDoc === "function") {
      try {
        const snap = await methods.getDoc(reportRef);
        if (snap.exists()) {
          previousStatus = snap.data()?.status || "open";
        }
      } catch {}
    }

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
      details: {
        previousStatus,
        newStatus: status,
        ...(note ? { note: String(note).slice(0, 500) } : {})
      }
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
/**
 * Authoritatively recalculates a worker's rating & reviewCount from published reviews
 * and updates /workers/{workerId} (admin-only write enforced by firestore.rules).
 */
export async function recalculateWorkerRatingInFirestore(workerId) {
  if (!workerId || !isSessionAuthorizedAdmin()) return null;
  try {
    const { db } = await initializeFirestoreClient();
    const methods = await getFirestoreMethods();
    if (!db || !methods || typeof methods.doc !== "function" || typeof methods.updateDoc !== "function") {
      return null;
    }

    const publishedReviews = await getWorkerFirestoreReviews(workerId);
    const summaries = aggregatePublishedReviewsByWorker(publishedReviews);
    const agg = summaries.get(String(workerId)) || {
      rating: null,
      reviewCount: 0,
      distribution: { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 }
    };

    const workerRef = methods.doc(db, "workers", String(workerId));
    await methods.updateDoc(workerRef, {
      rating: agg.rating,
      reviewCount: agg.reviewCount,
      ratingDistribution: agg.distribution,
      ratingUpdatedAt: new Date().toISOString()
    });
    return agg;
  } catch (err) {
    console.warn("[JKFixHub Admin] Worker rating sync notice:", err?.message || err);
    return null;
  }
}

export async function updateAdminReviewStatus(reviewId, status, adminUid, note = "") {
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
    let previousStatus = "published";
    let prevData = null;
    if (typeof methods.getDoc === "function") {
      try {
        const snap = await methods.getDoc(reviewRef);
        if (snap.exists()) {
          prevData = snap.data() || {};
          previousStatus = prevData.status || "published";
        }
      } catch {}
    }

    const cleanNote = String(note || "").trim().slice(0, 500);
    if (prevData && previousStatus === status && !cleanNote) {
      return { success: true, error: null, alreadyInState: true };
    }

    const nowIso = new Date().toISOString();
    const prevHistory = Array.isArray(prevData?.moderationHistory) ? prevData.moderationHistory : [];
    const nextHistory = [
      ...prevHistory,
      {
        previousStatus,
        newStatus: status,
        moderatedBy: adminUid,
        moderatedAt: nowIso,
        ...(cleanNote ? { note: cleanNote } : {})
      }
    ];

    await methods.updateDoc(reviewRef, {
      status,
      moderatedAt: nowIso,
      moderatedBy: adminUid,
      moderationHistory: nextHistory,
      ...(cleanNote ? { moderationNote: cleanNote } : {}),
      updatedAt: nowIso
    });

    const workerUid = prevData?.workerUid || (prevData?.workerId != null ? String(prevData.workerId) : null);
    const updatedRating = workerUid ? await recalculateWorkerRatingInFirestore(workerUid) : null;

    await recordAdminAuditLog({
      adminUid,
      action: "REVIEW_MODERATED",
      targetType: "review",
      targetId: reviewId,
      result: "success",
      details: {
        previousStatus,
        newStatus: status,
        ...(workerUid ? { workerUid } : {}),
        ...(updatedRating ? { newWorkerRating: updatedRating.rating, newReviewCount: updatedRating.reviewCount } : {}),
        ...(cleanNote ? { note: cleanNote } : {})
      }
    });

    invalidateAdminStatsCache();
    return { success: true, error: null, updatedRating, moderationHistory: nextHistory };
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
 * Suspends or reactivates a customer account in /users/{customerId}.
 * Preserves all historical records and logs an immutable audit entry.
 */
export async function updateAdminCustomerStatus(customerId, status, adminUid, reason = "") {
  if (!isSessionAuthorizedAdmin()) {
    return { success: false, error: "Access unavailable. This area is restricted to authorized administrators." };
  }
  if (!customerId || typeof customerId !== "string" || !customerId.trim()) {
    return { success: false, error: "Customer ID is required." };
  }
  if (status !== "active" && status !== "suspended") {
    return { success: false, error: "Invalid customer account status." };
  }

  try {
    const { db } = await initializeFirestoreClient();
    const methods = await getFirestoreMethods();
    if (!db || !methods || (typeof methods.updateDoc !== "function" && typeof methods.setDoc !== "function")) {
      return { success: false, error: "Firestore unavailable." };
    }

    const userRef = methods.doc(db, "users", customerId.trim());
    let previousStatus = "active";
    if (typeof methods.getDoc === "function") {
      try {
        const snap = await methods.getDoc(userRef);
        if (snap && (typeof snap.exists === "function" ? snap.exists() : snap.exists)) {
          const data = typeof snap.data === "function" ? snap.data() : snap.data;
          previousStatus = data?.status || "active";
        }
      } catch (_) {}
    }

    const cleanReason = String(reason || "").trim().slice(0, 500);

    // Idempotency guard: avoid overwriting suspendedAt or creating duplicate audit entries
    if (previousStatus === status) {
      return { success: true, error: null, previousStatus, newStatus: status, alreadyInState: true };
    }

    const nowIso = new Date().toISOString();
    const updates = {
      status,
      updatedAt: nowIso,
      lastModeratedBy: adminUid
    };

    if (status === "suspended") {
      updates.suspensionReason = cleanReason || "Suspended by platform administration.";
      updates.suspendedAt = nowIso;
      updates.suspendedBy = adminUid;
    } else {
      updates.suspensionReason = null;
      updates.reactivatedAt = nowIso;
      updates.reactivatedBy = adminUid;
    }

    if (typeof methods.updateDoc === "function") {
      await methods.updateDoc(userRef, updates);
    } else {
      await methods.setDoc(userRef, updates, { merge: true });
    }

    await recordAdminAuditLog({
      adminUid,
      action: status === "suspended" ? "CUSTOMER_SUSPENDED" : "CUSTOMER_REACTIVATED",
      targetType: "customer",
      targetId: customerId.trim(),
      result: "success",
      details: {
        previousStatus,
        newStatus: status,
        reason: cleanReason || (status === "suspended" ? "Administrative suspension" : "Account reactivated")
      }
    });

    invalidateAdminStatsCache();
    return { success: true, error: null, previousStatus, newStatus: status };
  } catch (err) {
    console.error("[JKFixHub Admin] Customer status update failed:", err?.message || err);
    return { success: false, error: err?.message || "Failed to update customer status." };
  }
}

/**
 * Loads the canonical platform control configuration (/platformConfig/public) for administration.
 */
export async function getAdminPlatformConfig() {
  if (!isSessionAuthorizedAdmin()) return normalizePlatformConfig(null);

  try {
    const { db } = await initializeFirestoreClient();
    const methods = await getFirestoreMethods();
    if (!db || !methods || typeof methods.doc !== "function" || typeof methods.getDoc !== "function") {
      return normalizePlatformConfig(null);
    }

    const snap = await methods.getDoc(methods.doc(db, "platformConfig", "public"));
    const exists = snap && (typeof snap.exists === "function" ? snap.exists() : Boolean(snap.exists));
    const data = exists ? (typeof snap.data === "function" ? snap.data() : snap.data) : null;
    const normalized = normalizePlatformConfig(data);
    setCachedPlatformConfig(normalized);
    return normalized;
  } catch (err) {
    console.warn("[JKFixHub Admin] Platform config fetch failed:", err?.message || err);
    return normalizePlatformConfig(null);
  }
}

/**
 * Updates /platformConfig/public with validated operational controls and records immutable audit trail.
 */
export async function updateAdminPlatformConfig(patch, adminUid, { actionType = "PLATFORM_CONFIG_UPDATED", summary = "" } = {}) {
  if (!isSessionAuthorizedAdmin()) {
    return { success: false, error: "Access unavailable. This area is restricted to authorized administrators." };
  }
  if (!patch || typeof patch !== "object") {
    return { success: false, error: "Configuration patch is required." };
  }

  try {
    const { db } = await initializeFirestoreClient();
    const methods = await getFirestoreMethods();
    if (!db || !methods || typeof methods.doc !== "function" || typeof methods.setDoc !== "function") {
      return { success: false, error: "Firestore unavailable." };
    }

    const configRef = methods.doc(db, "platformConfig", "public");
    let current = normalizePlatformConfig(null);
    if (typeof methods.getDoc === "function") {
      try {
        const snap = await methods.getDoc(configRef);
        const exists = snap && (typeof snap.exists === "function" ? snap.exists() : Boolean(snap.exists));
        if (exists) {
          current = normalizePlatformConfig(typeof snap.data === "function" ? snap.data() : snap.data);
        }
      } catch (_) {}
    }

    const merged = normalizePlatformConfig({
      ...current,
      ...patch,
      updatedAt: new Date().toISOString()
    });

    // Write ONLY minimal public operational fields (never internal secrets or admin PII)
    const publicPayload = {
      maintenanceMode: merged.maintenanceMode,
      maintenanceMessage: merged.maintenanceMessage,
      maintenanceStart: merged.maintenanceStart,
      maintenanceEnd: merged.maintenanceEnd,
      customerRegistrationEnabled: merged.customerRegistrationEnabled,
      workerRegistrationEnabled: merged.workerRegistrationEnabled,
      newRequestsEnabled: merged.newRequestsEnabled,
      newRequestsPauseMessage: merged.newRequestsPauseMessage,
      services: merged.services,
      disabledServices: merged.disabledServices,
      districts: merged.districts,
      disabledDistricts: merged.disabledDistricts,
      updatedAt: merged.updatedAt
    };

    await methods.setDoc(configRef, publicPayload, { merge: true });
    setCachedPlatformConfig(publicPayload);
    invalidatePlatformConfigCache();

    // Build concise previous vs new snapshot for audit log
    const prevSnapshot = {};
    const nextSnapshot = {};
    for (const key of Object.keys(patch)) {
      if (key === "services") {
        prevSnapshot.disabledServices = current.disabledServices;
        nextSnapshot.disabledServices = merged.disabledServices;
        nextSnapshot.totalServices = merged.services.length;
      } else if (key === "districts") {
        prevSnapshot.disabledDistricts = current.disabledDistricts;
        nextSnapshot.disabledDistricts = merged.disabledDistricts;
      } else {
        prevSnapshot[key] = current[key];
        nextSnapshot[key] = merged[key];
      }
    }

    await recordAdminAuditLog({
      adminUid,
      action: actionType,
      targetType: "platform_config",
      targetId: "public",
      result: "success",
      details: {
        previousValues: prevSnapshot,
        newValues: nextSnapshot,
        summary: summary || actionType
      }
    });

    return { success: true, error: null, config: publicPayload };
  } catch (err) {
    console.error("[JKFixHub Admin] Platform config update failed:", err?.message || err);
    return { success: false, error: err?.message || "Failed to update platform configuration." };
  }
}

/**
 * Fetches all platform announcements for admin management (draft, published, paused, archived, expired).
 */
export async function getAdminAnnouncements() {
  if (!isSessionAuthorizedAdmin()) return [];

  try {
    const { db } = await initializeFirestoreClient();
    const methods = await getFirestoreMethods();
    if (!db || !methods || typeof methods.getDocs !== "function") return [];

    const snap = await methods.getDocs(methods.collection(db, "announcements"));
    const nowMs = Date.now();
    const list = [];
    snap.forEach((doc) => {
      const data = typeof doc.data === "function" ? doc.data() : doc.data;
      const item = { id: doc.id, ...data };
      // Compute effective display status if published item has passed expiry
      if (item.status === "published" && item.expiresAtMs && nowMs >= item.expiresAtMs) {
        item.effectiveStatus = "expired";
      } else {
        item.effectiveStatus = item.status || "draft";
      }
      list.push(item);
    });
    list.sort((a, b) => getTimestampMillis(b.updatedAt || b.createdAt) - getTimestampMillis(a.updatedAt || a.createdAt));
    return list;
  } catch (err) {
    console.warn("[JKFixHub Admin] Announcements fetch failed:", err?.message || err);
    return [];
  }
}

/**
 * Creates a new platform announcement and records audit log.
 */
export async function createAdminAnnouncement(payload, adminUid) {
  if (!isSessionAuthorizedAdmin()) {
    return { success: false, error: "Access unavailable. This area is restricted to authorized administrators." };
  }

  const title = String(payload?.title || "").trim();
  const message = String(payload?.message || "").trim();
  const audience = ["customers", "workers", "everyone"].includes(payload?.audience) ? payload.audience : "everyone";
  const priority = ["normal", "important", "urgent"].includes(payload?.priority) ? payload.priority : "normal";
  const status = ["draft", "published", "paused", "archived"].includes(payload?.status) ? payload.status : "draft";

  if (title.length < 3 || title.length > 140) {
    return { success: false, error: "Title must be between 3 and 140 characters." };
  }
  if (message.length < 5 || message.length > 2000) {
    return { success: false, error: "Message must be between 5 and 2000 characters." };
  }

  const nowIso = new Date().toISOString();
  const publishAtMs = payload?.publishAt ? Date.parse(payload.publishAt) : Date.now();
  if (Number.isNaN(publishAtMs)) {
    return { success: false, error: "Invalid publish date." };
  }

  let expiresAt = null;
  let expiresAtMs = NO_EXPIRY_MS;
  if (payload?.expiresAt && String(payload.expiresAt).trim()) {
    expiresAtMs = Date.parse(payload.expiresAt);
    if (Number.isNaN(expiresAtMs)) {
      return { success: false, error: "Invalid expiry date." };
    }
    if (expiresAtMs <= publishAtMs) {
      return { success: false, error: "Expiry date must be after publish date." };
    }
    expiresAt = new Date(expiresAtMs).toISOString();
  }

  try {
    const { db } = await initializeFirestoreClient();
    const methods = await getFirestoreMethods();
    if (!db || !methods || typeof methods.addDoc !== "function") {
      return { success: false, error: "Firestore unavailable." };
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
      createdAt: nowIso,
      updatedAt: nowIso,
      createdBy: adminUid,
      updatedBy: adminUid
    };

    const ref = await methods.addDoc(methods.collection(db, "announcements"), docData);
    await recordAdminAuditLog({
      adminUid,
      action: status === "published" ? "ANNOUNCEMENT_PUBLISHED" : "ANNOUNCEMENT_CREATED",
      targetType: "announcement",
      targetId: ref?.id || "new",
      result: "success",
      details: { title, audience, priority, status }
    });

    return { success: true, error: null, id: ref?.id, announcement: { id: ref?.id, ...docData } };
  } catch (err) {
    console.error("[JKFixHub Admin] Announcement create failed:", err?.message || err);
    return { success: false, error: err?.message || "Failed to create announcement." };
  }
}

/**
 * Edits an existing platform announcement and records audit log.
 */
export async function updateAdminAnnouncement(announcementId, payload, adminUid) {
  if (!isSessionAuthorizedAdmin()) {
    return { success: false, error: "Access unavailable. This area is restricted to authorized administrators." };
  }
  if (!announcementId) {
    return { success: false, error: "Announcement ID is required." };
  }

  const title = String(payload?.title || "").trim();
  const message = String(payload?.message || "").trim();
  const audience = ["customers", "workers", "everyone"].includes(payload?.audience) ? payload.audience : "everyone";
  const priority = ["normal", "important", "urgent"].includes(payload?.priority) ? payload.priority : "normal";
  const status = ["draft", "published", "paused", "archived", "expired"].includes(payload?.status) ? payload.status : "draft";

  if (title.length < 3 || title.length > 140) {
    return { success: false, error: "Title must be between 3 and 140 characters." };
  }
  if (message.length < 5 || message.length > 2000) {
    return { success: false, error: "Message must be between 5 and 2000 characters." };
  }

  const publishAtMs = payload?.publishAt ? Date.parse(payload.publishAt) : Date.now();
  if (Number.isNaN(publishAtMs)) {
    return { success: false, error: "Invalid publish date." };
  }

  let expiresAt = null;
  let expiresAtMs = NO_EXPIRY_MS;
  if (payload?.expiresAt && String(payload.expiresAt).trim()) {
    expiresAtMs = Date.parse(payload.expiresAt);
    if (Number.isNaN(expiresAtMs)) {
      return { success: false, error: "Invalid expiry date." };
    }
    if (expiresAtMs <= publishAtMs) {
      return { success: false, error: "Expiry date must be after publish date." };
    }
    expiresAt = new Date(expiresAtMs).toISOString();
  }

  try {
    const { db } = await initializeFirestoreClient();
    const methods = await getFirestoreMethods();
    if (!db || !methods || typeof methods.doc !== "function") {
      return { success: false, error: "Firestore unavailable." };
    }

    const ref = methods.doc(db, "announcements", String(announcementId));
    let prevStatus = "draft";
    if (typeof methods.getDoc === "function") {
      try {
        const snap = await methods.getDoc(ref);
        if (snap && (typeof snap.exists === "function" ? snap.exists() : snap.exists)) {
          prevStatus = (typeof snap.data === "function" ? snap.data() : snap.data)?.status || "draft";
        }
      } catch (_) {}
    }

    const updates = {
      title,
      message,
      audience,
      priority,
      status,
      publishAt: new Date(publishAtMs).toISOString(),
      publishAtMs,
      expiresAt,
      expiresAtMs,
      updatedAt: new Date().toISOString(),
      updatedBy: adminUid
    };

    if (typeof methods.updateDoc === "function") {
      await methods.updateDoc(ref, updates);
    } else if (typeof methods.setDoc === "function") {
      await methods.setDoc(ref, updates, { merge: true });
    }

    await recordAdminAuditLog({
      adminUid,
      action: "ANNOUNCEMENT_EDITED",
      targetType: "announcement",
      targetId: String(announcementId),
      result: "success",
      details: { title, audience, priority, previousStatus: prevStatus, newStatus: status }
    });

    return { success: true, error: null };
  } catch (err) {
    console.error("[JKFixHub Admin] Announcement update failed:", err?.message || err);
    return { success: false, error: err?.message || "Failed to update announcement." };
  }
}

/**
 * Transitions an announcement's status (published, paused, archived, draft) with audit log.
 */
export async function updateAdminAnnouncementStatus(announcementId, status, adminUid) {
  if (!isSessionAuthorizedAdmin()) {
    return { success: false, error: "Access unavailable. This area is restricted to authorized administrators." };
  }
  const allowed = ["draft", "published", "paused", "archived", "expired"];
  if (!announcementId || !allowed.includes(status)) {
    return { success: false, error: "Invalid announcement status update." };
  }

  try {
    const { db } = await initializeFirestoreClient();
    const methods = await getFirestoreMethods();
    if (!db || !methods || typeof methods.doc !== "function") {
      return { success: false, error: "Firestore unavailable." };
    }

    const ref = methods.doc(db, "announcements", String(announcementId));
    let prev = {};
    if (typeof methods.getDoc === "function") {
      try {
        const snap = await methods.getDoc(ref);
        if (snap && (typeof snap.exists === "function" ? snap.exists() : snap.exists)) {
          prev = (typeof snap.data === "function" ? snap.data() : snap.data) || {};
        }
      } catch (_) {}
    }

    if (prev.status === status) {
      return { success: true, error: null, alreadyInState: true };
    }

    const nowIso = new Date().toISOString();
    const updates = {
      status,
      updatedAt: nowIso,
      updatedBy: adminUid
    };
    if (status === "published" && !prev.publishAt) {
      updates.publishAt = nowIso;
      updates.publishAtMs = Date.now();
    }

    if (typeof methods.updateDoc === "function") {
      await methods.updateDoc(ref, updates);
    } else if (typeof methods.setDoc === "function") {
      await methods.setDoc(ref, updates, { merge: true });
    }

    await recordAdminAuditLog({
      adminUid,
      action: `ANNOUNCEMENT_${status.toUpperCase()}`,
      targetType: "announcement",
      targetId: String(announcementId),
      result: "success",
      details: {
        title: prev.title || null,
        previousStatus: prev.status || "draft",
        newStatus: status
      }
    });

    return { success: true, error: null };
  } catch (err) {
    console.error("[JKFixHub Admin] Announcement status change failed:", err?.message || err);
    return { success: false, error: err?.message || "Failed to change announcement status." };
  }
}

/**
 * Aggregates live Firebase collections for the Admin Analytics Dashboard.
 * Never fabricates statistics and never exposes private PII in aggregated metrics.
 */
export async function getAdminAnalyticsData() {
  const empty = {
    totalCustomers: 0,
    activeCustomers: 0,
    suspendedCustomers: 0,
    totalWorkers: 0,
    verifiedWorkers: 0,
    pendingWorkerApprovals: 0,
    suspendedWorkers: 0,
    totalRequests: 0,
    pendingRequests: 0,
    acceptedRequests: 0,
    completedRequests: 0,
    rejectedRequests: 0,
    cancelledRequests: 0,
    serviceBreakdown: [],
    districtBreakdown: [],
    recentReports: [],
    recentAuditLogs: [],
    completionRate: 0
  };

  if (!isSessionAuthorizedAdmin()) return empty;

  try {
    const [customers, workers, requests, reports, auditLogs] = await Promise.all([
      getAdminCustomers(),
      getAdminWorkers(),
      getAdminRequests(),
      getAdminReports(),
      getAdminAuditLogs()
    ]);

    const serviceCounts = new Map();
    const districtCounts = new Map();

    let pendingRequests = 0;
    let acceptedRequests = 0;
    let completedRequests = 0;
    let rejectedRequests = 0;
    let cancelledRequests = 0;

    for (const r of requests) {
      const st = String(r.status || "Pending");
      if (st === "Pending") pendingRequests++;
      else if (st === "Accepted") acceptedRequests++;
      else if (st === "Completed") completedRequests++;
      else if (st === "Rejected") rejectedRequests++;
      else if (st === "Cancelled") cancelledRequests++;

      const svc = (r.service || "Unspecified").trim();
      serviceCounts.set(svc, (serviceCounts.get(svc) || 0) + 1);

      const dist = (r.district || "Unspecified").trim();
      districtCounts.set(dist, (districtCounts.get(dist) || 0) + 1);
    }

    const serviceBreakdown = [...serviceCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    const districtBreakdown = [...districtCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    const suspendedCustomers = customers.filter((c) => c.status === "suspended").length;
    const verifiedWorkers = workers.filter((w) => w.isVerified === true && w.status !== "suspended").length;
    const pendingWorkerApprovals = workers.filter((w) => !w.isVerified || w.status === "pending").length;
    const suspendedWorkers = workers.filter((w) => w.status === "suspended").length;

    const resolvedTotal = completedRequests + rejectedRequests + cancelledRequests;
    const completionRate = resolvedTotal > 0 ? Math.round((completedRequests / resolvedTotal) * 100) : 0;

    const sortedReports = [...reports].sort(
      (a, b) => getTimestampMillis(b.createdAt) - getTimestampMillis(a.createdAt)
    );

    return {
      totalCustomers: customers.length,
      activeCustomers: customers.length - suspendedCustomers,
      suspendedCustomers,
      totalWorkers: workers.length,
      verifiedWorkers,
      pendingWorkerApprovals,
      suspendedWorkers,
      totalRequests: requests.length,
      pendingRequests,
      acceptedRequests,
      completedRequests,
      rejectedRequests,
      cancelledRequests,
      serviceBreakdown,
      districtBreakdown,
      recentReports: sortedReports.slice(0, 6).map((r) => ({
        id: r.id,
        targetType: r.targetType || "general",
        reason: r.reason || "Safety report",
        status: r.status || "open",
        createdAt: r.createdAt || null
      })),
      recentAuditLogs: auditLogs.slice(0, 8),
      completionRate
    };
  } catch (err) {
    console.warn("[JKFixHub Admin] Analytics aggregation failed:", err?.message || err);
    return empty;
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
      const storedReviewCount = typeof data.reviewCount === "number" && data.reviewCount > 0 ? data.reviewCount : 0;
      const parsedStoredRating = Number(data.rating);
      const hasValidStoredRating = storedReviewCount > 0 && !Number.isNaN(parsedStoredRating) && parsedStoredRating >= 1 && parsedStoredRating <= 5;
      const rating = hasValidStoredRating ? Math.round(parsedStoredRating * 10) / 10 : null;
      const reviewCount = hasValidStoredRating ? storedReviewCount : 0;
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
        ratingDistribution: data.ratingDistribution || { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 },
        isVerified,
        status,
        about,
        isDemo: false
      });
    });

    // Hydrate authoritative genuine ratings directly from published /reviews documents
    // so cards/search always reflect real published customer reviews (never stale or default 5.0).
    if (workers.length > 0) {
      try {
        const reviewsQuery = methods.query(
          methods.collection(db, "reviews"),
          methods.where("status", "==", "published")
        );
        const revSnap = await methods.getDocs(reviewsQuery);
        const publishedReviews = [];
        if (revSnap && typeof revSnap.forEach === "function") {
          revSnap.forEach((d) => {
            const rData = typeof d.data === "function" ? d.data() : d;
            if (rData) publishedReviews.push({ id: d.id, ...rData });
          });
        }
        const ratingsMap = aggregatePublishedReviewsByWorker(publishedReviews);
        for (const w of workers) {
          const agg = ratingsMap.get(String(w.id));
          if (agg && agg.reviewCount > 0) {
            w.rating = agg.rating;
            w.reviewCount = agg.reviewCount;
            w.ratingDistribution = agg.distribution;
          } else {
            w.rating = null;
            w.reviewCount = 0;
            w.ratingDistribution = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
          }
        }
      } catch (revErr) {
        console.warn("[JKFixHub Discovery] Published reviews hydration notice:", revErr?.message || revErr);
      }
    }

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

    if (newStatus === "Completed" || newStatus === "Cancelled") {
      try {
        const chatDocRef = methods.doc(db, "chats", requestId);
        const chatSnap = await methods.getDoc(chatDocRef);
        if (chatSnap && (typeof chatSnap.exists === "function" ? chatSnap.exists() : chatSnap.exists)) {
          await methods.updateDoc(chatDocRef, {
            status: "archived",
            closedReason: newStatus,
            archivedAt: nowIso
          });
        }
      } catch (_) {
        // Non-fatal if chat document was not initialized
      }
    }

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

    try {
      const request = await getFirestoreRequestById(chatId);
      if (request && request.status !== "Accepted") {
        return {
          success: false,
          message: null,
          error: `Cannot send message. Service request is ${request.status || "closed"}.`
        };
      }
    } catch (_) {
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

  if (typeof activeAdminCustomersUnsub === "function") {
    try { activeAdminCustomersUnsub(); } catch (_) {}
    activeAdminCustomersUnsub = null;
  }
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

  const allowedTargetTypes = ["worker", "customer", "review", "message", "chat"];
  if (!allowedTargetTypes.includes(targetType)) {
    return {
      success: false,
      reportId: null,
      report: null,
      error: "Invalid report target type."
    };
  }

  const cleanTargetId = String(targetId).trim();
  if (cleanTargetId === String(reporterUid)) {
    return {
      success: false,
      reportId: null,
      report: null,
      error: "You cannot report your own account."
    };
  }

  if (cleanTargetId.length === 0 || cleanTargetId.length > 128 || /[/\\.\0]/.test(cleanTargetId)) {
    return {
      success: false,
      reportId: null,
      report: null,
      error: "Invalid target identifier."
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
  const tags = sanitizeReviewTags(reviewData?.tags);

  if (!customerId || !requestId || !Number.isInteger(rating) || rating < 1 || rating > 5 || text.length > 1200) {
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

    // 2b. Self-review prevention: caller cannot be the assigned worker
    if (requestDoc.workerUid === customerId || (requestDoc.workerId && String(requestDoc.workerId) === String(customerId))) {
      return {
        success: false,
        reviewId: null,
        review: null,
        error: "Workers cannot submit reviews for their own service requests."
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

    // 4. Duplicate check: verify no review exists under canonical requestId OR legacy rev-<requestId>
    const finalReviewId = requestId;
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

    try {
      const legacyRef = methods.doc(db, "reviews", `rev-${finalReviewId}`);
      const legacySnap = await methods.getDoc(legacyRef);
      if (legacySnap.exists()) {
        return {
          success: false,
          reviewId: `rev-${finalReviewId}`,
          review: legacySnap.data(),
          error: "A review has already been submitted for this service request."
        };
      }
    } catch {
      // Legacy check non-fatal
    }

    const workerId = requestDoc.workerUid || (requestDoc.workerId ? String(requestDoc.workerId) : null) || reviewData.workerId || null;
    const workerName = requestDoc.workerName || reviewData.workerName || "Service Professional";
    const customerName = requestDoc.customerName || reviewData.customerName || "Customer";
    const nowIso = new Date().toISOString();
    const nowMs = Date.now();

    const docPayload = {
      id: finalReviewId,
      reviewId: finalReviewId,
      requestId,
      customerId: String(customerId),
      customerName: String(customerName).trim(),
      workerUid: String(workerId),
      workerId: String(workerId),
      workerName: String(workerName).trim(),
      service: requestDoc.service || null,
      district: requestDoc.district || null,
      verifiedService: true,
      rating,
      text,
      tags,
      status: "published",
      createdAt: nowIso,
      createdAtMs: nowMs,
      updatedAt: null,
      editedAt: null,
      editCount: 0,
      editHistory: [],
      moderationHistory: [],
      workerReply: null,
      workerReplyAt: null,
      workerReplyUpdatedAt: null
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
        error: "Permission denied. Reviews may only be submitted by the active verified customer for completed requests."
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
 * Updates a customer's own published review within the 24-hour edit window.
 * Preserves an append-only editHistory audit trail and keeps ownership/worker identity immutable.
 * Server-side enforced by isValidCustomerReviewEdit() in firestore.rules.
 */
export async function updateFirestoreCustomerReview(reviewId, { rating, text = "", tags = [], customerId }) {
  const numRating = Number(rating);
  const cleanText = typeof text === "string" ? text.trim() : "";
  const cleanTags = sanitizeReviewTags(tags);

  if (!reviewId || !customerId || !Number.isInteger(numRating) || numRating < 1 || numRating > 5 || cleanText.length > 1200) {
    return { success: false, review: null, error: "Invalid review edit parameters." };
  }

  try {
    const { db } = await initializeFirestoreClient();
    const methods = await getFirestoreMethods();
    if (!db || !methods || typeof methods.doc !== "function" || typeof methods.getDoc !== "function" || typeof methods.updateDoc !== "function") {
      return { success: false, review: null, error: "Reviews database unavailable." };
    }

    const reviewRef = methods.doc(db, "reviews", String(reviewId));
    const snap = await methods.getDoc(reviewRef);
    if (!snap.exists()) {
      return { success: false, review: null, error: "Review not found." };
    }

    const prev = snap.data() || {};
    if (prev.customerId !== customerId) {
      return { success: false, review: null, error: "You can only edit your own review." };
    }
    if (prev.status !== "published") {
      return { success: false, review: null, error: "Moderated or hidden reviews cannot be edited." };
    }

    const createdMs = typeof prev.createdAtMs === "number"
      ? prev.createdAtMs
      : (prev.createdAt ? Date.parse(String(prev.createdAt)) : NaN);
    if (Number.isNaN(createdMs) || Date.now() > createdMs + REVIEW_EDIT_WINDOW_MS) {
      return { success: false, review: null, error: "The 24-hour edit window for this review has expired." };
    }

    const prevHistory = Array.isArray(prev.editHistory) ? prev.editHistory : [];
    if (prevHistory.length >= 10) {
      return { success: false, review: null, error: "Maximum number of edits reached for this review." };
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

    const updates = {
      rating: numRating,
      text: cleanText,
      tags: cleanTags,
      editedAt: nowIso,
      updatedAt: nowIso,
      editCount: nextHistory.length,
      editHistory: nextHistory
    };

    await methods.updateDoc(reviewRef, updates);

    return {
      success: true,
      review: { id: snap.id, ...prev, ...updates },
      error: null
    };
  } catch (err) {
    console.warn("[JKFixHub Review] Customer review edit error:", err?.message || err);
    if (err?.code === "permission-denied") {
      return { success: false, review: null, error: "Edit denied. Reviews can only be edited by the author within 24 hours of submission." };
    }
    return { success: false, review: null, error: err?.message || "Failed to update review." };
  }
}

/**
 * Loads published customer reviews for a given worker from Cloud Firestore with metadata
 * indicating whether the result came from an authoritative live Firestore query.
 * Queries both workerUid and legacy workerId fields so legitimate legacy reviews never disappear.
 *
 * @param {string|number} workerId
 * @returns {Promise<{ reviews: Array<object>, fromFirestore: boolean }>}
 */
export async function getWorkerFirestoreReviewsWithMeta(workerId) {
  if (!workerId) return { reviews: [], fromFirestore: false };

  try {
    const { db } = await initializeFirestoreClient();
    const methods = await getFirestoreMethods();

    if (!db || !methods || typeof methods.collection !== "function" || typeof methods.getDocs !== "function") {
      return { reviews: [], fromFirestore: false };
    }

    const targetId = String(workerId);
    const colRef = methods.collection(db, "reviews");
    const collectedById = new Map();

    const collectSnap = (snap) => {
      if (!snap || typeof snap.forEach !== "function") return;
      snap.forEach((doc) => {
        const data = typeof doc.data === "function" ? doc.data() : doc;
        if (!data) return;
        if (String(data.workerUid) === targetId || String(data.workerId) === targetId) {
          if (data.status === "published") {
            collectedById.set(doc.id, { id: doc.id, ...data });
          }
        }
      });
    };

    if (typeof methods.query === "function" && typeof methods.where === "function") {
      const qPrimary = methods.query(
        colRef,
        methods.where("workerUid", "==", targetId),
        methods.where("status", "==", "published")
      );
      const primarySnap = await methods.getDocs(qPrimary);
      collectSnap(primarySnap);

      // Always also query legacy workerId field so older reviews are preserved alongside newer ones
      try {
        const qLegacy = methods.query(
          colRef,
          methods.where("workerId", "==", targetId),
          methods.where("status", "==", "published")
        );
        const legacySnap = await methods.getDocs(qLegacy);
        collectSnap(legacySnap);
      } catch {
        // Legacy fallback non-fatal
      }
    } else {
      const allSnap = await methods.getDocs(colRef);
      collectSnap(allSnap);
    }

    const reviews = Array.from(collectedById.values());
    reviews.sort((a, b) => {
      const aTime = typeof a.createdAtMs === "number" ? a.createdAtMs : (Date.parse(a.createdAt || 0) || 0);
      const bTime = typeof b.createdAtMs === "number" ? b.createdAtMs : (Date.parse(b.createdAt || 0) || 0);
      return bTime - aTime;
    });
    return { reviews, fromFirestore: true };
  } catch (err) {
    console.warn("[JKFixHub Review] Worker reviews fetch error:", err?.message || err);
    throw err;
  }
}

/**
 * Loads published customer reviews for a given worker from Cloud Firestore.
 * @param {string|number} workerId
 * @returns {Promise<Array<object>>}
 */
export async function getWorkerFirestoreReviews(workerId) {
  const { reviews } = await getWorkerFirestoreReviewsWithMeta(workerId);
  return reviews;
}

/**
 * Adds or updates a worker reply to a customer review in Cloud Firestore.
 * @param {string} reviewId
 * @param {string} replyText
 * @param {string} workerUid
 * @returns {Promise<{ success: boolean, error: string|null }>}
 */
/**
 * Fetches and calculates authoritative client-side rating aggregation for a worker
 * without requiring Cloud Functions or Blaze billing.
 *
 * @param {string|number} workerId
 * @returns {Promise<{ rating: number|null, reviewCount: number, average: number, displayRating: string, reviews: Array<object> }>}
 */
export async function getAggregatedFirestoreWorkerRating(workerId) {
  const reviews = await getWorkerFirestoreReviews(workerId);
  const { calculateWorkerRating } = await import("./store.js");
  const summary = calculateWorkerRating(reviews);
  return {
    ...summary,
    reviews
  };
}

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
    let existingReplyAt = null;
    if (typeof methods.getDoc === "function") {
      try {
        const snap = await methods.getDoc(reviewRef);
        if (snap.exists()) {
          const data = snap.data() || {};
          if (data.workerReply && data.workerReplyAt) {
            existingReplyAt = data.workerReplyAt;
          }
        }
      } catch {}
    }

    const payload = existingReplyAt
      ? {
          workerReply: String(replyText).trim(),
          workerReplyAt: existingReplyAt,
          workerReplyUpdatedAt: nowIso,
          updatedAt: nowIso
        }
      : {
          workerReply: String(replyText).trim(),
          workerReplyAt: nowIso,
          updatedAt: nowIso
        };

    await methods.updateDoc(reviewRef, payload);

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
