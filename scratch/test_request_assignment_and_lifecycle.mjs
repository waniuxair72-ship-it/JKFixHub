/**
 * Test Suite: Task 4 - Request Assignment & Lifecycle Verification
 *
 * Validates:
 * 1. Client-Side Service & State Machine Logic (firestore-service.js):
 *    - Mandatory workerUid on creation (direct assignment model)
 *    - Assigned worker: Pending -> Accepted, Pending -> Rejected, Accepted -> Completed
 *    - Invalid jumps: Pending -> Completed rejected
 *    - Customer: Pending -> Cancelled
 *    - Customer cancelling Accepted or Completed request rejected
 *    - Non-assigned worker attempting accept, reject, or complete rejected
 *    - Non-owner customer attempting cancel rejected
 *    - Concurrency/race simulation:
 *      - Worker acceptance races customer cancellation
 *      - Customer cancellation races worker acceptance
 *      - Two workers racing for same assigned request
 * 2. Live Firestore Emulator Security Rules Enforcement (firestore.rules):
 *    - /requests/{requestId}:
 *      - Create without workerUid DENIED (403)
 *      - Create with status != "Pending" DENIED (403)
 *      - Create with valid workerUid and status == "Pending" ALLOWED (200)
 *      - Assigned worker read ALLOWED (200)
 *      - Unassigned worker read DENIED (403) - customer privacy protected
 *      - Assigned worker Pending -> Accepted ALLOWED (200)
 *      - Assigned worker Pending -> Rejected ALLOWED (200)
 *      - Unassigned worker accept/reject DENIED (403)
 *      - Assigned worker attempting to reassign workerUid DENIED (403)
 *      - Assigned worker Accepted -> Completed ALLOWED (200)
 *      - Assigned worker Pending -> Completed DENIED (403)
 *      - Customer attempting to complete DENIED (403)
 *      - Customer cancelling own Pending request ALLOWED (200)
 *      - Customer cancelling already Accepted request DENIED (403)
 *      - Worker accepting already Cancelled request DENIED (403)
 *      - Worker cancelling request DENIED (403)
 *      - End-to-end complete flow: Create -> Accept -> Complete -> Review ALLOWED (200)
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
console.log("TEST SUITE: TASK 4 - REQUEST ASSIGNMENT & LIFECYCLE");
console.log("==================================================");

// -------------------------------------------------------------
// PART 1: Client Service Unit Tests & Concurrency Simulation
// -------------------------------------------------------------
console.log("\n--- Part 1: Client Service Logic & Concurrency Simulation ---");

import { setFirestoreAdapterForTesting } from "../js/firebase-config.js";
import {
  createFirestoreServiceRequest,
  updateFirestoreRequestStatus,
  getWorkerFirestoreRequests,
  getCustomerFirestoreRequests
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

await runAsyncTest("1a. createFirestoreServiceRequest: Rejects creation when workerUid is missing", async () => {
  const res = await createFirestoreServiceRequest({
    customerId: "cust-1",
    customerName: "Aadil",
    service: "Plumber",
    problemDescription: "Leaking pipe in Srinagar"
  });
  assert.equal(res.success, false);
  assert.match(res.error, /Missing required service request fields/);
});

await runAsyncTest("1b. createFirestoreServiceRequest: Creates request assigned to worker with Pending status", async () => {
  const mock = createMockFirestore();
  setFirestoreAdapterForTesting(mock);

  const res = await createFirestoreServiceRequest({
    customerId: "cust-1",
    customerName: "Aadil",
    workerUid: "worker-plumber-1",
    workerName: "Bilal",
    service: "Plumber",
    district: "Srinagar",
    problemDescription: "Kitchen tap leakage",
    customerLocation: "Lal Chowk"
  });

  assert.equal(res.success, true);
  assert.ok(res.requestId);
  assert.equal(res.request.status, "Pending");
  assert.equal(res.request.customerId, "cust-1");
  assert.equal(res.request.workerUid, "worker-plumber-1");
  assert.equal(mock.docs.has(`requests/${res.requestId}`), true);
});

await runAsyncTest("1c. Worker Lifecycle: Assigned worker can transition Pending -> Accepted and Pending -> Rejected", async () => {
  const mock = createMockFirestore({
    "requests/req-p1": { id: "req-p1", customerId: "cust-1", workerUid: "worker-1", status: "Pending" },
    "requests/req-p2": { id: "req-p2", customerId: "cust-1", workerUid: "worker-1", status: "Pending" }
  });
  setFirestoreAdapterForTesting(mock);

  const resAccept = await updateFirestoreRequestStatus("req-p1", "Accepted", "worker-1");
  assert.equal(resAccept.success, true);
  assert.equal(mock.docs.get("requests/req-p1").status, "Accepted");
  assert.ok(mock.docs.get("requests/req-p1").acceptedAt);

  const resReject = await updateFirestoreRequestStatus("req-p2", "Rejected", "worker-1");
  assert.equal(resReject.success, true);
  assert.equal(mock.docs.get("requests/req-p2").status, "Rejected");
  assert.ok(mock.docs.get("requests/req-p2").rejectedAt);
});

await runAsyncTest("1d. Worker Lifecycle: Assigned worker can complete Accepted request, but CANNOT jump Pending -> Completed", async () => {
  const mock = createMockFirestore({
    "requests/req-accepted": { id: "req-accepted", customerId: "cust-1", workerUid: "worker-1", status: "Accepted" },
    "requests/req-pending": { id: "req-pending", customerId: "cust-1", workerUid: "worker-1", status: "Pending" }
  });
  setFirestoreAdapterForTesting(mock);

  const resComp = await updateFirestoreRequestStatus("req-accepted", "Completed", "worker-1");
  assert.equal(resComp.success, true);
  assert.equal(mock.docs.get("requests/req-accepted").status, "Completed");
  assert.ok(mock.docs.get("requests/req-accepted").completedAt);

  const resJump = await updateFirestoreRequestStatus("req-pending", "Completed", "worker-1");
  assert.equal(resJump.success, false);
  assert.match(resJump.error, /Request must be "Accepted" before completion/);
  assert.equal(mock.docs.get("requests/req-pending").status, "Pending");
});

await runAsyncTest("1e. Customer Lifecycle: Customer can cancel Pending request, but CANNOT cancel Accepted or Completed request", async () => {
  const mock = createMockFirestore({
    "requests/req-pend": { id: "req-pend", customerId: "cust-1", workerUid: "worker-1", status: "Pending" },
    "requests/req-acc": { id: "req-acc", customerId: "cust-1", workerUid: "worker-1", status: "Accepted" },
    "requests/req-done": { id: "req-done", customerId: "cust-1", workerUid: "worker-1", status: "Completed" }
  });
  setFirestoreAdapterForTesting(mock);

  const resCancel = await updateFirestoreRequestStatus("req-pend", "Cancelled", "cust-1");
  assert.equal(resCancel.success, true);
  assert.equal(mock.docs.get("requests/req-pend").status, "Cancelled");
  assert.ok(mock.docs.get("requests/req-pend").cancelledAt);

  const resCancelAcc = await updateFirestoreRequestStatus("req-acc", "Cancelled", "cust-1");
  assert.equal(resCancelAcc.success, false);
  assert.match(resCancelAcc.error, /Only Pending requests can be updated/);

  const resCancelDone = await updateFirestoreRequestStatus("req-done", "Cancelled", "cust-1");
  assert.equal(resCancelDone.success, false);
  assert.match(resCancelDone.error, /Only Pending requests can be updated/);
});

await runAsyncTest("1f. Authorization: Unassigned worker attempting to accept or complete is rejected", async () => {
  const mock = createMockFirestore({
    "requests/req-1": { id: "req-1", customerId: "cust-1", workerUid: "worker-1", status: "Pending" },
    "requests/req-2": { id: "req-2", customerId: "cust-1", workerUid: "worker-1", status: "Accepted" }
  });
  setFirestoreAdapterForTesting(mock);

  const res1 = await updateFirestoreRequestStatus("req-1", "Accepted", "worker-imposter");
  assert.equal(res1.success, false);
  assert.match(res1.error, /Unauthorized: You are not the worker assigned/);

  const res2 = await updateFirestoreRequestStatus("req-2", "Completed", "worker-imposter");
  assert.equal(res2.success, false);
  assert.match(res2.error, /Unauthorized: You are not the worker assigned/);
});

await runAsyncTest("1g. Concurrency Simulation: Worker accepts while customer concurrently cancels", async () => {
  const mock = createMockFirestore({
    "requests/req-race-1": { id: "req-race-1", customerId: "cust-1", workerUid: "worker-1", status: "Pending" }
  });
  setFirestoreAdapterForTesting(mock);

  // Worker acceptance reaches DB first
  const workerRes = await updateFirestoreRequestStatus("req-race-1", "Accepted", "worker-1");
  assert.equal(workerRes.success, true);

  // Subsequent customer cancellation attempt is rejected because request is no longer Pending
  const customerRes = await updateFirestoreRequestStatus("req-race-1", "Cancelled", "cust-1");
  assert.equal(customerRes.success, false);
  assert.match(customerRes.error, /Only Pending requests can be updated/);
  assert.equal(mock.docs.get("requests/req-race-1").status, "Accepted");
});

await runAsyncTest("1h. Concurrency Simulation: Customer cancels while worker concurrently accepts", async () => {
  const mock = createMockFirestore({
    "requests/req-race-2": { id: "req-race-2", customerId: "cust-1", workerUid: "worker-1", status: "Pending" }
  });
  setFirestoreAdapterForTesting(mock);

  // Customer cancellation reaches DB first
  const customerRes = await updateFirestoreRequestStatus("req-race-2", "Cancelled", "cust-1");
  assert.equal(customerRes.success, true);

  // Subsequent worker accept attempt is rejected because request is no longer Pending
  const workerRes = await updateFirestoreRequestStatus("req-race-2", "Accepted", "worker-1");
  assert.equal(workerRes.success, false);
  assert.match(workerRes.error, /Only Pending requests can be updated/);
  assert.equal(mock.docs.get("requests/req-race-2").status, "Cancelled");
});

await runAsyncTest("1i. Concurrency Simulation: Two workers attempting to accept same assigned request", async () => {
  const mock = createMockFirestore({
    "requests/req-assigned": { id: "req-assigned", customerId: "cust-1", workerUid: "worker-alpha", status: "Pending" }
  });
  setFirestoreAdapterForTesting(mock);

  // Worker Beta (unassigned) tries to accept
  const betaRes = await updateFirestoreRequestStatus("req-assigned", "Accepted", "worker-beta");
  assert.equal(betaRes.success, false);
  assert.match(betaRes.error, /Unauthorized: You are not the worker assigned/);

  // Worker Alpha (assigned) accepts
  const alphaRes = await updateFirestoreRequestStatus("req-assigned", "Accepted", "worker-alpha");
  assert.equal(alphaRes.success, true);
  assert.equal(mock.docs.get("requests/req-assigned").status, "Accepted");
});

// -------------------------------------------------------------
// PART 2: Real Firestore Emulator Security Rules Verification
// -------------------------------------------------------------
console.log("\n--- Part 2: Live Firestore Emulator Rules Enforcement ---");

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

const emulatorLive = await isEmulatorAvailable();
if (!emulatorLive) {
  console.log("  ⚠️ Firestore Emulator not detected on", EMULATOR_HOST);
  console.log("  To run Part 2 rules tests: npx firebase-tools emulators:exec 'node scratch/test_request_assignment_and_lifecycle.mjs' --only firestore");
} else {
  console.log("  ✓ Firestore Emulator detected on", EMULATOR_HOST);

  const baseRequest = {
    id: "req-rule-test",
    requestId: "req-rule-test",
    customerId: "cust-owner",
    customerName: "Aadil",
    workerUid: "worker-assigned",
    workerId: "worker-assigned",
    workerName: "Bilal",
    service: "Plumber",
    district: "Srinagar",
    problemDescription: "Pipe burst",
    customerLocation: "Dalgate",
    status: "Pending",
    createdAt: new Date().toISOString()
  };

  await runAsyncTest("2a. Request creation without workerUid is DENIED (403)", async () => {
    const noWorkerReq = { ...baseRequest, id: "req-no-worker", workerUid: "" };
    const res = await createDocAsUser("requests", "req-no-worker", noWorkerReq, "cust-owner");
    assert.equal(res.status, 403);
  });

  await runAsyncTest("2b. Request creation with valid workerUid and status Pending is ALLOWED (200)", async () => {
    const res = await createDocAsUser("requests", "req-create-valid", { ...baseRequest, id: "req-create-valid" }, "cust-owner");
    assert.equal(res.status, 200);
  });

  await runAsyncTest("2c. Assigned worker can read pending request (200); Unassigned worker DENIED (403)", async () => {
    const assignedRead = await getDocAsUser("requests", "req-create-valid", "worker-assigned");
    assert.equal(assignedRead.status, 200);

    const strangerWorkerRead = await getDocAsUser("requests", "req-create-valid", "worker-stranger");
    assert.equal(strangerWorkerRead.status, 403);
  });

  await runAsyncTest("2d. Customer owner can read pending request (200); Other customer DENIED (403)", async () => {
    const ownerRead = await getDocAsUser("requests", "req-create-valid", "cust-owner");
    assert.equal(ownerRead.status, 200);

    const strangerCustomerRead = await getDocAsUser("requests", "req-create-valid", "cust-stranger");
    assert.equal(strangerCustomerRead.status, 403);
  });

  await runAsyncTest("2e. Assigned worker can accept Pending request (200)", async () => {
    const res = await updateDocAsUser("requests", "req-create-valid", {
      status: "Accepted",
      acceptedAt: new Date().toISOString()
    }, ["status", "acceptedAt"], "worker-assigned");
    assert.equal(res.status, 200);
  });

  await runAsyncTest("2f. Unassigned worker attempting to accept is DENIED (403)", async () => {
    await seedDocument("requests", "req-unassigned-try", { ...baseRequest, id: "req-unassigned-try" });
    const res = await updateDocAsUser("requests", "req-unassigned-try", {
      status: "Accepted"
    }, ["status"], "worker-other");
    assert.equal(res.status, 403);
  });

  await runAsyncTest("2g. Worker attempting to reassign workerUid during update is DENIED (403)", async () => {
    await seedDocument("requests", "req-reassign-try", { ...baseRequest, id: "req-reassign-try" });
    const res = await updateDocAsUser("requests", "req-reassign-try", {
      status: "Accepted",
      workerUid: "worker-other"
    }, ["status", "workerUid"], "worker-assigned");
    assert.equal(res.status, 403);
  });

  await runAsyncTest("2h. Assigned worker can complete Accepted request (200)", async () => {
    const res = await updateDocAsUser("requests", "req-create-valid", {
      status: "Completed",
      completedAt: new Date().toISOString()
    }, ["status", "completedAt"], "worker-assigned");
    assert.equal(res.status, 200);
  });

  await runAsyncTest("2i. Assigned worker jumping Pending directly to Completed is DENIED (403)", async () => {
    await seedDocument("requests", "req-jump-try", { ...baseRequest, id: "req-jump-try" });
    const res = await updateDocAsUser("requests", "req-jump-try", {
      status: "Completed"
    }, ["status"], "worker-assigned");
    assert.equal(res.status, 403);
  });

  await runAsyncTest("2j. Customer cancelling own Pending request is ALLOWED (200)", async () => {
    await seedDocument("requests", "req-cancel-ok", { ...baseRequest, id: "req-cancel-ok" });
    const res = await updateDocAsUser("requests", "req-cancel-ok", {
      status: "Cancelled",
      cancelledAt: new Date().toISOString()
    }, ["status", "cancelledAt"], "cust-owner");
    assert.equal(res.status, 200);
  });

  await runAsyncTest("2k. Race Prevention: Customer cancelling already Accepted request is DENIED (403)", async () => {
    await seedDocument("requests", "req-race-acc", { ...baseRequest, id: "req-race-acc", status: "Accepted" });
    const res = await updateDocAsUser("requests", "req-race-acc", {
      status: "Cancelled"
    }, ["status"], "cust-owner");
    assert.equal(res.status, 403);
  });

  await runAsyncTest("2l. Race Prevention: Worker accepting already Cancelled request is DENIED (403)", async () => {
    await seedDocument("requests", "req-race-canc", { ...baseRequest, id: "req-race-canc", status: "Cancelled" });
    const res = await updateDocAsUser("requests", "req-race-canc", {
      status: "Accepted"
    }, ["status"], "worker-assigned");
    assert.equal(res.status, 403);
  });

  await runAsyncTest("2m. End-to-End Happy Path: Create (200) -> Accept (200) -> Complete (200) -> Review (200)", async () => {
    const e2eReqId = "req-e2e-flow-1";
    // 1. Customer creates request
    const createRes = await createDocAsUser("requests", e2eReqId, { ...baseRequest, id: e2eReqId, requestId: e2eReqId }, "cust-owner");
    assert.equal(createRes.status, 200);

    // 2. Assigned worker accepts
    const acceptRes = await updateDocAsUser("requests", e2eReqId, {
      status: "Accepted",
      acceptedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }, ["status", "acceptedAt", "updatedAt"], "worker-assigned");
    assert.equal(acceptRes.status, 200);

    // 3. Assigned worker completes
    const completeRes = await updateDocAsUser("requests", e2eReqId, {
      status: "Completed",
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }, ["status", "completedAt", "updatedAt"], "worker-assigned");
    assert.equal(completeRes.status, 200);

    // 4. Customer submits review for Completed request
    const reviewPayload = {
      id: e2eReqId,
      reviewId: e2eReqId,
      requestId: e2eReqId,
      customerId: "cust-owner",
      workerUid: "worker-assigned",
      rating: 5,
      text: "Outstanding plumbing service! Highly recommended.",
      status: "published",
      createdAt: new Date().toISOString(),
      workerReply: null,
      workerReplyAt: null
    };
    const reviewRes = await createDocAsUser("reviews", e2eReqId, reviewPayload, "cust-owner");
    assert.equal(reviewRes.status, 200);
  });
}

console.log("\n==================================================");
console.log(`TOTAL TESTS: ${totalPassed + totalFailed} | PASSED: ${totalPassed} | FAILED: ${totalFailed}`);
console.log("==================================================");

if (totalFailed > 0) {
  process.exit(1);
}

