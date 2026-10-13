/**
 * Test Suite: Task 3 - Persist Safety Reports and Customer Reviews
 *
 * Validates:
 * 1. Client-Side Service & Security Logic:
 *    - createFirestoreReport validation (fields, allowed types, length bounds)
 *    - createFirestoreReport honest error handling & retry state (no fake success)
 *    - createFirestoreReview validation (ownership, completed status, rating bounds 1-5, duplicate prevention)
 *    - createFirestoreReview honest error handling
 *    - getWorkerFirestoreReviews filtering (published reviews only, sorted desc)
 *    - addFirestoreWorkerReviewReply validation
 * 2. Firestore Emulator Live Rules Enforcement:
 *    - /reports/{reportId}:
 *      - Unauthenticated create DENIED (403)
 *      - Authenticated create ALLOWED (200)
 *      - Impersonation/spoofing reporterUid DENIED (403)
 *      - Invalid targetType DENIED (403)
 *      - Setting privileged fields (status != open, resolvedAt, resolvedBy) DENIED (403)
 *      - Reporter can read own report (200); Other users DENIED (403)
 *      - Non-admin update/delete DENIED (403)
 *      - Admin read, update status, and delete ALLOWED (200)
 *    - /reviews/{reviewId}:
 *      - Unauthenticated create DENIED (403)
 *      - Non-existent request review DENIED (403)
 *      - Other customer's request review DENIED (403)
 *      - Non-Completed request review DENIED (403)
 *      - Invalid rating (< 1, > 5, non-integer) DENIED (403)
 *      - Mismatched reviewId DENIED (403)
 *      - Pre-filled worker reply or non-published status on create DENIED (403)
 *      - Valid completed request review ALLOWED (200)
 *      - Duplicate review for same request DENIED (403)
 *      - Customer altering review text, rating, or status DENIED (403)
 *      - Customer altering worker aggregate profile rating DENIED (403)
 *      - Assigned worker reply strictly updating allowed keys ALLOWED (200)
 *      - Worker altering customer rating, text, or review status DENIED (403)
 *      - Unassigned worker reply DENIED (403)
 *      - Public read of published reviews ALLOWED (200)
 *      - Non-published review hidden from public (403), readable by customer, worker, and admin (200)
 *      - Admin moderation & delete ALLOWED (200)
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

let totalPassed = 0;
let totalFailed = 0;

function runTest(description, fn) {
  try {
    fn();
    console.log(`  ✓ PASS: ${description}`);
    totalPassed++;
  } catch (err) {
    console.error(`  ✗ FAIL: ${description}`);
    console.error(`    Error: ${err.message}`);
    totalFailed++;
  }
}

async function runAsyncTest(description, fn) {
  try {
    await fn();
    console.log(`  ✓ PASS: ${description}`);
    totalPassed++;
  } catch (err) {
    console.error(`  ✗ FAIL: ${description}`);
    console.error(`    Error: ${err.message}`);
    totalFailed++;
  }
}

console.log("==================================================");
console.log("TEST SUITE: TASK 3 - SAFETY REPORTS & REVIEWS PERSISTENCE");
console.log("==================================================");

// -------------------------------------------------------------
// PART 1: Client Unit Tests (firestore-service.js)
// -------------------------------------------------------------
console.log("\n--- Part 1: Client Service Validation & Error Handling ---");

import { setFirestoreAdapterForTesting } from "../js/firebase-config.js";
import {
  createFirestoreReport,
  createFirestoreReview,
  getWorkerFirestoreReviews,
  addFirestoreWorkerReviewReply
} from "../js/firestore-service.js";

function createMockFirestore(initialDocs = {}) {
  const docs = new Map();
  for (const [key, value] of Object.entries(initialDocs)) {
    docs.set(key, JSON.parse(JSON.stringify(value)));
  }

  const adapter = {
    docs,
    doc: (db, col, id) => `${col}/${id}`,
    collection: (db, col) => col,
    getDoc: async (docPath) => ({
      exists: () => docs.has(docPath),
      data: () => (docs.has(docPath) ? JSON.parse(JSON.stringify(docs.get(docPath))) : null)
    }),
    setDoc: async (docPath, data) => {
      docs.set(docPath, JSON.parse(JSON.stringify(data)));
      return data;
    },
    updateDoc: async (docPath, updates) => {
      if (!docs.has(docPath)) throw new Error(`Document ${docPath} does not exist`);
      const current = docs.get(docPath);
      Object.assign(current, updates);
      return current;
    },
    query: (colRef, ...filters) => ({ colRef, filters }),
    where: (field, op, val) => ({ field, op, val }),
    getDocs: async (q) => {
      const col = typeof q === "string" ? q : q.colRef;
      const results = [];
      for (const [docPath, val] of docs.entries()) {
        if (docPath.startsWith(`${col}/`)) {
          let match = true;
          if (q.filters && Array.isArray(q.filters)) {
            for (const f of q.filters) {
              if (f.op === "==" && val[f.field] !== f.val) {
                match = false;
                break;
              }
            }
          }
          if (match) {
            results.push({
              id: docPath.split("/")[1],
              data: () => JSON.parse(JSON.stringify(val))
            });
          }
        }
      }
      return {
        forEach: (cb) => results.forEach(cb),
        docs: results
      };
    }
  };

  return adapter;
}

await runAsyncTest("1a. createFirestoreReport: Rejects missing required fields", async () => {
  const res1 = await createFirestoreReport({});
  assert.equal(res1.success, false);
  assert.match(res1.error, /Missing required safety report fields/);

  const res2 = await createFirestoreReport({
    reporterUid: "user-1",
    targetType: "worker",
    targetId: "worker-1",
    reason: "Inappropriate behavior",
    description: ""
  });
  assert.equal(res2.success, false);
  assert.match(res2.error, /Missing required safety report fields/);
});

await runAsyncTest("1b. createFirestoreReport: Rejects invalid targetType", async () => {
  const res = await createFirestoreReport({
    reporterUid: "user-1",
    targetType: "unsupported_entity",
    targetId: "123",
    reason: "Harassment",
    description: "Detailed report description here."
  });
  assert.equal(res.success, false);
  assert.match(res.error, /Invalid report target type/);
});

await runAsyncTest("1c. createFirestoreReport: Rejects too short or excessively long description", async () => {
  const resShort = await createFirestoreReport({
    reporterUid: "user-1",
    targetType: "worker",
    targetId: "worker-1",
    reason: "Harassment",
    description: "bad"
  });
  assert.equal(resShort.success, false);
  assert.match(resShort.error, /between 5 and 2,000 characters/);

  const resLong = await createFirestoreReport({
    reporterUid: "user-1",
    targetType: "worker",
    targetId: "worker-1",
    reason: "Harassment",
    description: "x".repeat(2001)
  });
  assert.equal(resLong.success, false);
  assert.match(resLong.error, /between 5 and 2,000 characters/);
});

await runAsyncTest("1d. createFirestoreReport: Successfully persists report with open status", async () => {
  const mock = createMockFirestore();
  setFirestoreAdapterForTesting(mock);

  const res = await createFirestoreReport({
    reporterUid: "cust-123",
    targetType: "worker",
    targetId: "work-456",
    reason: "Safety concern",
    description: "Worker was unprofessional and aggressive."
  });

  assert.equal(res.success, true);
  assert.ok(res.reportId);
  assert.equal(res.report.status, "open");
  assert.equal(res.report.resolvedAt, null);
  assert.equal(res.report.resolvedBy, null);
  assert.equal(res.report.reporterUid, "cust-123");
  assert.equal(mock.docs.has(`reports/${res.reportId}`), true);
});

await runAsyncTest("1e. createFirestoreReport: Honest error reporting on DB failure (never fake success)", async () => {
  const failingAdapter = {
    doc: () => "reports/rep-1",
    collection: () => "reports",
    setDoc: async () => {
      const err = new Error("Firestore permission denied");
      err.code = "permission-denied";
      throw err;
    }
  };
  setFirestoreAdapterForTesting(failingAdapter);

  const res = await createFirestoreReport({
    reporterUid: "cust-123",
    targetType: "worker",
    targetId: "work-456",
    reason: "Safety concern",
    description: "Worker was unprofessional and aggressive."
  });

  assert.equal(res.success, false);
  assert.equal(res.reportId, null);
  assert.match(res.error, /Permission denied/);
});

await runAsyncTest("1f. createFirestoreReview: Validates required fields and rating bounds (1-5 integer)", async () => {
  const resMissing = await createFirestoreReview({});
  assert.equal(resMissing.success, false);
  assert.match(resMissing.error, /Missing or invalid review fields/);

  const resZero = await createFirestoreReview({
    customerId: "cust-1",
    requestId: "req-1",
    rating: 0,
    text: "Decent work"
  });
  assert.equal(resZero.success, false);

  const resSix = await createFirestoreReview({
    customerId: "cust-1",
    requestId: "req-1",
    rating: 6,
    text: "Great work"
  });
  assert.equal(resSix.success, false);

  const resFloat = await createFirestoreReview({
    customerId: "cust-1",
    requestId: "req-1",
    rating: 4.5,
    text: "Great work"
  });
  assert.equal(resFloat.success, false);
});

await runAsyncTest("1g. createFirestoreReview: Rejects if underlying request not found", async () => {
  const mock = createMockFirestore();
  setFirestoreAdapterForTesting(mock);

  const res = await createFirestoreReview({
    customerId: "cust-1",
    requestId: "req-nonexistent",
    rating: 5,
    text: "Excellent service done on time."
  });

  assert.equal(res.success, false);
  assert.match(res.error, /not found/);
});

await runAsyncTest("1h. createFirestoreReview: Rejects if caller is not the request owner", async () => {
  const mock = createMockFirestore({
    "requests/req-10": {
      id: "req-10",
      customerId: "cust-owner",
      workerUid: "worker-1",
      status: "Completed"
    }
  });
  setFirestoreAdapterForTesting(mock);

  const res = await createFirestoreReview({
    customerId: "cust-imposter",
    requestId: "req-10",
    rating: 5,
    text: "Excellent service done on time."
  });

  assert.equal(res.success, false);
  assert.match(res.error, /Unauthorized/);
});

await runAsyncTest("1i. createFirestoreReview: Rejects if request status is not Completed (e.g. Pending, Accepted)", async () => {
  const mock = createMockFirestore({
    "requests/req-pending": {
      id: "req-pending",
      customerId: "cust-1",
      workerUid: "worker-1",
      status: "Pending"
    },
    "requests/req-accepted": {
      id: "req-accepted",
      customerId: "cust-1",
      workerUid: "worker-1",
      status: "Accepted"
    }
  });
  setFirestoreAdapterForTesting(mock);

  const resPending = await createFirestoreReview({
    customerId: "cust-1",
    requestId: "req-pending",
    rating: 5,
    text: "Great"
  });
  assert.equal(resPending.success, false);
  assert.match(resPending.error, /Current status: "Pending"/);

  const resAccepted = await createFirestoreReview({
    customerId: "cust-1",
    requestId: "req-accepted",
    rating: 5,
    text: "Great"
  });
  assert.equal(resAccepted.success, false);
  assert.match(resAccepted.error, /Current status: "Accepted"/);
});

await runAsyncTest("1j. createFirestoreReview: Rejects duplicate review for same request", async () => {
  const mock = createMockFirestore({
    "requests/req-dup": {
      id: "req-dup",
      customerId: "cust-1",
      workerUid: "worker-1",
      status: "Completed"
    },
    "reviews/req-dup": {
      id: "req-dup",
      requestId: "req-dup",
      customerId: "cust-1",
      rating: 5,
      text: "First review"
    }
  });
  setFirestoreAdapterForTesting(mock);

  const res = await createFirestoreReview({
    customerId: "cust-1",
    requestId: "req-dup",
    rating: 4,
    text: "Attempting duplicate review"
  });
  assert.equal(res.success, false);
  assert.match(res.error, /already been submitted/);
});

await runAsyncTest("1k. createFirestoreReview: Successfully creates review bound to completed request", async () => {
  const mock = createMockFirestore({
    "requests/req-valid": {
      id: "req-valid",
      customerId: "cust-1",
      customerName: "Aadil",
      workerUid: "worker-1",
      workerName: "Bilal",
      status: "Completed"
    }
  });
  setFirestoreAdapterForTesting(mock);

  const res = await createFirestoreReview({
    customerId: "cust-1",
    requestId: "req-valid",
    rating: 5,
    text: "Brilliant plumbing work! Arrived on time and solved the leakage cleanly."
  });

  assert.equal(res.success, true);
  assert.equal(res.reviewId, "req-valid");
  assert.equal(res.review.status, "published");
  assert.equal(res.review.rating, 5);
  assert.equal(res.review.workerReply, null);
  assert.equal(mock.docs.has("reviews/req-valid"), true);
});

await runAsyncTest("1l. getWorkerFirestoreReviews: Filters by worker and published status", async () => {
  const mock = createMockFirestore({
    "reviews/rev-1": {
      id: "rev-1",
      workerUid: "worker-target",
      status: "published",
      rating: 5,
      text: "Great",
      createdAt: "2026-10-10T10:00:00Z"
    },
    "reviews/rev-2": {
      id: "rev-2",
      workerUid: "worker-target",
      status: "hidden",
      rating: 1,
      text: "Flagged review",
      createdAt: "2026-10-11T10:00:00Z"
    },
    "reviews/rev-3": {
      id: "rev-3",
      workerUid: "worker-other",
      status: "published",
      rating: 4,
      text: "Another worker",
      createdAt: "2026-10-12T10:00:00Z"
    }
  });
  setFirestoreAdapterForTesting(mock);

  const reviews = await getWorkerFirestoreReviews("worker-target");
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].id, "rev-1");
  assert.equal(reviews[0].status, "published");
});

await runAsyncTest("1m. addFirestoreWorkerReviewReply: Updates reply text and timestamp", async () => {
  const mock = createMockFirestore({
    "reviews/rev-reply": {
      id: "rev-reply",
      workerUid: "worker-1",
      status: "published",
      rating: 5,
      text: "Great service",
      workerReply: null
    }
  });
  setFirestoreAdapterForTesting(mock);

  const res = await addFirestoreWorkerReviewReply("rev-reply", "Thank you for the kind feedback!", "worker-1");
  assert.equal(res.success, true);
  const updated = mock.docs.get("reviews/rev-reply");
  assert.equal(updated.workerReply, "Thank you for the kind feedback!");
  assert.ok(updated.workerReplyAt);
});

// -------------------------------------------------------------
// PART 2: Real Firestore Emulator Security Rules Verification
// -------------------------------------------------------------
console.log("\n--- Part 2: Live Firestore Emulator Security Rules Enforcement ---");

const EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8085";
const PROJECT_ID = process.env.GCLOUD_PROJECT || "demo-no-project";
const BASE_URL = `http://${EMULATOR_HOST}/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

async function isEmulatorAvailable() {
  try {
    const res = await fetch(`http://${EMULATOR_HOST}`);
    return res.status === 200 || res.status === 404;
  } catch {
    return false;
  }
}

function makeAuthHeader(uid, email = `${uid}@example.com`) {
  if (!uid) return {};
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    sub: uid,
    user_id: uid,
    email,
    aud: PROJECT_ID,
    iss: `https://securetoken.google.com/${PROJECT_ID}`
  })).toString("base64url");
  const token = `${header}.${payload}.`;
  return { Authorization: `Bearer ${token}` };
}

function toFirestoreFields(obj) {
  const fields = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) {
      fields[key] = { nullValue: null };
    } else if (typeof value === "string") {
      fields[key] = { stringValue: value };
    } else if (typeof value === "number") {
      fields[key] = Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
    } else if (typeof value === "boolean") {
      fields[key] = { booleanValue: value };
    } else if (Array.isArray(value)) {
      fields[key] = { arrayValue: { values: value.map((v) => ({ stringValue: String(v) })) } };
    } else if (typeof value === "object") {
      fields[key] = { mapValue: { fields: toFirestoreFields(value) } };
    }
  }
  return fields;
}

async function seedDocument(collection, docId, data) {
  const url = `${BASE_URL}/${collection}/${docId}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer owner"
    },
    body: JSON.stringify({ fields: toFirestoreFields(data) })
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to seed ${collection}/${docId}: ${res.status} ${errText}`);
  }
}

async function getDocAsUser(collection, docId, uid) {
  const url = `${BASE_URL}/${collection}/${docId}`;
  return fetch(url, {
    headers: makeAuthHeader(uid)
  });
}

async function createDocAsUser(collection, docId, data, uid) {
  const url = `${BASE_URL}/${collection}?documentId=${encodeURIComponent(docId)}`;
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...makeAuthHeader(uid)
    },
    body: JSON.stringify({ fields: toFirestoreFields(data) })
  });
}

async function updateDocAsUser(collection, docId, updates, updateMaskFields, uid) {
  const mask = updateMaskFields.map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join("&");
  const url = `${BASE_URL}/${collection}/${docId}?${mask}`;
  return fetch(url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...makeAuthHeader(uid)
    },
    body: JSON.stringify({ fields: toFirestoreFields(updates) })
  });
}

async function deleteDocAsUser(collection, docId, uid) {
  const url = `${BASE_URL}/${collection}/${docId}`;
  return fetch(url, {
    method: "DELETE",
    headers: makeAuthHeader(uid)
  });
}

const emulatorLive = await isEmulatorAvailable();
if (!emulatorLive) {
  console.log("  ⚠️ Firestore Emulator not detected on", EMULATOR_HOST);
  console.log("  To run Part 2 rules tests: npx firebase-tools emulators:exec 'node scratch/test_reports_and_reviews_persistence.mjs' --only firestore");
} else {
  console.log("  ✓ Firestore Emulator detected on", EMULATOR_HOST);

  // Setup admin membership
  await seedDocument("admins", "admin-1", {
    role: "admin",
    active: true,
    createdAt: new Date().toISOString()
  });

  // -------------------------------------------------------------
  // Section 2: Trust & Safety Reports (/reports/{reportId})
  // -------------------------------------------------------------
  console.log("\n  --- 2. Reports Security Rules ---");

  const validReportData = {
    id: "rep-live-1",
    reportId: "rep-live-1",
    reporterUid: "cust-reporter",
    targetType: "worker",
    targetId: "worker-1",
    reason: "Unprofessional conduct",
    description: "The worker arrived late and demanded excessive cash payment.",
    status: "open",
    createdAt: new Date().toISOString(),
    resolvedAt: null,
    resolvedBy: null
  };

  await runAsyncTest("2a. Unauthenticated report creation is DENIED (403)", async () => {
    const res = await createDocAsUser("reports", "rep-unauth", validReportData, null);
    assert.equal(res.status, 403);
  });

  await runAsyncTest("2b. Authenticated user can create valid report (200)", async () => {
    const res = await createDocAsUser("reports", "rep-live-1", validReportData, "cust-reporter");
    assert.equal(res.status, 200);
  });

  await runAsyncTest("2c. Spoofing reporterUid is DENIED (403)", async () => {
    const spoofedData = {
      ...validReportData,
      reporterUid: "cust-other"
    };
    const res = await createDocAsUser("reports", "rep-spoof", spoofedData, "cust-reporter");
    assert.equal(res.status, 403);
  });

  await runAsyncTest("2d. Invalid targetType is DENIED (403)", async () => {
    const invalidTarget = {
      ...validReportData,
      targetType: "system_internal"
    };
    const res = await createDocAsUser("reports", "rep-invalid-target", invalidTarget, "cust-reporter");
    assert.equal(res.status, 403);
  });

  await runAsyncTest("2e. Setting privileged status or resolution fields on create is DENIED (403)", async () => {
    const privilegedStatus = {
      ...validReportData,
      status: "resolved"
    };
    const res1 = await createDocAsUser("reports", "rep-priv-1", privilegedStatus, "cust-reporter");
    assert.equal(res1.status, 403);

    const privilegedResolvedAt = {
      ...validReportData,
      resolvedAt: new Date().toISOString(),
      resolvedBy: "admin-1"
    };
    const res2 = await createDocAsUser("reports", "rep-priv-2", privilegedResolvedAt, "cust-reporter");
    assert.equal(res2.status, 403);
  });

  await runAsyncTest("2f. Reporter can read own report (200); Other user DENIED (403)", async () => {
    const ownerRes = await getDocAsUser("reports", "rep-live-1", "cust-reporter");
    assert.equal(ownerRes.status, 200);

    const otherRes = await getDocAsUser("reports", "rep-live-1", "cust-stranger");
    assert.equal(otherRes.status, 403);
  });

  await runAsyncTest("2g. Normal user cannot update or delete report (403)", async () => {
    const resUpdate = await updateDocAsUser("reports", "rep-live-1", {
      status: "resolved"
    }, ["status"], "cust-reporter");
    assert.equal(resUpdate.status, 403);

    const resDelete = await deleteDocAsUser("reports", "rep-live-1", "cust-reporter");
    assert.equal(resDelete.status, 403);
  });

  await runAsyncTest("2h. Admin can read, update status, and delete reports (200)", async () => {
    const readRes = await getDocAsUser("reports", "rep-live-1", "admin-1");
    assert.equal(readRes.status, 200);

    const updateRes = await updateDocAsUser("reports", "rep-live-1", {
      status: "under_review",
      resolvedBy: "admin-1",
      resolvedAt: new Date().toISOString()
    }, ["status", "resolvedBy", "resolvedAt"], "admin-1");
    assert.equal(updateRes.status, 200);

    const delRes = await deleteDocAsUser("reports", "rep-live-1", "admin-1");
    assert.equal(delRes.status, 200);
  });

  // -------------------------------------------------------------
  // Section 3: Customer Reviews (/reviews/{reviewId})
  // -------------------------------------------------------------
  console.log("\n  --- 3. Reviews Security Rules ---");

  // Seed reference requests
  await seedDocument("requests", "req-completed-1", {
    id: "req-completed-1",
    customerId: "cust-reviewer",
    workerUid: "worker-plumber",
    status: "Completed",
    service: "Plumber",
    createdAt: new Date().toISOString()
  });

  await seedDocument("requests", "req-pending-1", {
    id: "req-pending-1",
    customerId: "cust-reviewer",
    workerUid: "worker-plumber",
    status: "Pending",
    service: "Plumber",
    createdAt: new Date().toISOString()
  });

  const validReview = {
    id: "req-completed-1",
    reviewId: "req-completed-1",
    requestId: "req-completed-1",
    customerId: "cust-reviewer",
    workerUid: "worker-plumber",
    rating: 5,
    text: "Excellent plumbing work done in Srinagar. Highly recommended!",
    status: "published",
    createdAt: new Date().toISOString(),
    workerReply: null,
    workerReplyAt: null
  };

  await runAsyncTest("3a. Unauthenticated review creation is DENIED (403)", async () => {
    const res = await createDocAsUser("reviews", "req-completed-1", validReview, null);
    assert.equal(res.status, 403);
  });

  await runAsyncTest("3b. Review for non-existent request is DENIED (403)", async () => {
    const ghostReview = {
      ...validReview,
      id: "req-ghost",
      reviewId: "req-ghost",
      requestId: "req-ghost"
    };
    const res = await createDocAsUser("reviews", "req-ghost", ghostReview, "cust-reviewer");
    assert.equal(res.status, 403);
  });

  await runAsyncTest("3c. Review for another customer's request is DENIED (403)", async () => {
    const imposterReview = {
      ...validReview,
      customerId: "cust-imposter"
    };
    const res = await createDocAsUser("reviews", "req-completed-1", imposterReview, "cust-imposter");
    assert.equal(res.status, 403);
  });

  await runAsyncTest("3d. Review for non-Completed request (Pending) is DENIED (403)", async () => {
    const pendingReview = {
      ...validReview,
      id: "req-pending-1",
      reviewId: "req-pending-1",
      requestId: "req-pending-1"
    };
    const res = await createDocAsUser("reviews", "req-pending-1", pendingReview, "cust-reviewer");
    assert.equal(res.status, 403);
  });

  await runAsyncTest("3e. Invalid rating (< 1, > 5, or float) is DENIED (403)", async () => {
    const resZero = await createDocAsUser("reviews", "req-completed-1", { ...validReview, rating: 0 }, "cust-reviewer");
    assert.equal(resZero.status, 403);

    const resSix = await createDocAsUser("reviews", "req-completed-1", { ...validReview, rating: 6 }, "cust-reviewer");
    assert.equal(resSix.status, 403);

    const resFloat = await createDocAsUser("reviews", "req-completed-1", { ...validReview, rating: 4.5 }, "cust-reviewer");
    assert.equal(resFloat.status, 403);
  });

  await runAsyncTest("3f. Mismatched reviewId (not matching requestId) is DENIED (403)", async () => {
    const resMismatch = await createDocAsUser("reviews", "arbitrary-id-123", validReview, "cust-reviewer");
    assert.equal(resMismatch.status, 403);
  });

  await runAsyncTest("3g. Pre-filling worker reply or non-published status on create is DENIED (403)", async () => {
    const prefillReply = {
      ...validReview,
      workerReply: "Thanks!"
    };
    const res1 = await createDocAsUser("reviews", "req-completed-1", prefillReply, "cust-reviewer");
    assert.equal(res1.status, 403);

    const hiddenStatus = {
      ...validReview,
      status: "hidden"
    };
    const res2 = await createDocAsUser("reviews", "req-completed-1", hiddenStatus, "cust-reviewer");
    assert.equal(res2.status, 403);
  });

  await runAsyncTest("3h. Valid review for Completed request is ALLOWED (200)", async () => {
    const res = await createDocAsUser("reviews", "req-completed-1", validReview, "cust-reviewer");
    assert.equal(res.status, 200);
  });

  await runAsyncTest("3i. Customer duplicate review attempt is DENIED (403)", async () => {
    // Attempting to overwrite existing review
    const duplicateData = {
      ...validReview,
      rating: 4,
      text: "Updated text attempt"
    };
    const res = await updateDocAsUser("reviews", "req-completed-1", duplicateData, ["rating", "text"], "cust-reviewer");
    assert.equal(res.status, 403);
  });

  await runAsyncTest("3j. Customer cannot alter worker profile rating or reviewCount directly (403)", async () => {
    await seedDocument("workers", "worker-plumber", {
      id: "worker-plumber",
      rating: 4.5,
      reviewCount: 10
    });
    const res = await updateDocAsUser("workers", "worker-plumber", {
      rating: 5.0,
      reviewCount: 11
    }, ["rating", "reviewCount"], "cust-reviewer");
    assert.equal(res.status, 403);
  });

  await runAsyncTest("3k. Assigned worker can reply strictly to workerReply fields (200)", async () => {
    const replyUpdate = {
      workerReply: "Thank you for trusting our plumbing service in Srinagar!",
      workerReplyAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const res = await updateDocAsUser("reviews", "req-completed-1", replyUpdate, ["workerReply", "workerReplyAt", "updatedAt"], "worker-plumber");
    assert.equal(res.status, 200);
  });

  await runAsyncTest("3l. Worker attempting to alter customer rating, text, or status is DENIED (403)", async () => {
    const tamperRating = {
      rating: 1,
      workerReply: "Thanks"
    };
    const resRating = await updateDocAsUser("reviews", "req-completed-1", tamperRating, ["rating", "workerReply"], "worker-plumber");
    assert.equal(resRating.status, 403);

    const tamperText = {
      text: "Tampered by worker",
      workerReply: "Thanks"
    };
    const resText = await updateDocAsUser("reviews", "req-completed-1", tamperText, ["text", "workerReply"], "worker-plumber");
    assert.equal(resText.status, 403);

    const tamperStatus = {
      status: "hidden",
      workerReply: "Thanks"
    };
    const resStatus = await updateDocAsUser("reviews", "req-completed-1", tamperStatus, ["status", "workerReply"], "worker-plumber");
    assert.equal(resStatus.status, 403);
  });

  await runAsyncTest("3m. Unassigned worker replying to review is DENIED (403)", async () => {
    const replyUpdate = {
      workerReply: "Imposter reply",
      workerReplyAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const res = await updateDocAsUser("reviews", "req-completed-1", replyUpdate, ["workerReply", "workerReplyAt", "updatedAt"], "worker-unrelated");
    assert.equal(res.status, 403);
  });

  await runAsyncTest("3n. Public/unauthenticated user can read published review (200)", async () => {
    const res = await getDocAsUser("reviews", "req-completed-1", null);
    assert.equal(res.status, 200);
  });

  await runAsyncTest("3o. Non-published review is hidden from public (403), readable by admin & customer (200)", async () => {
    await seedDocument("reviews", "rev-flagged", {
      id: "rev-flagged",
      requestId: "req-completed-1",
      customerId: "cust-reviewer",
      workerUid: "worker-plumber",
      rating: 1,
      text: "Flagged review",
      status: "hidden"
    });

    const publicRes = await getDocAsUser("reviews", "rev-flagged", null);
    assert.equal(publicRes.status, 403);

    const customerRes = await getDocAsUser("reviews", "rev-flagged", "cust-reviewer");
    assert.equal(customerRes.status, 200);

    const adminRes = await getDocAsUser("reviews", "rev-flagged", "admin-1");
    assert.equal(adminRes.status, 200);
  });

  await runAsyncTest("3p. Admin can moderate review status and delete review (200)", async () => {
    const updateRes = await updateDocAsUser("reviews", "req-completed-1", {
      status: "flagged"
    }, ["status"], "admin-1");
    assert.equal(updateRes.status, 200);

    const delRes = await deleteDocAsUser("reviews", "req-completed-1", "admin-1");
    assert.equal(delRes.status, 200);
  });
}

console.log("\n==================================================");
console.log(`TOTAL TESTS: ${totalPassed + totalFailed} | PASSED: ${totalPassed} | FAILED: ${totalFailed}`);
console.log("==================================================");

if (totalFailed > 0) {
  process.exit(1);
}
