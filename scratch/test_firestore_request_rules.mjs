/**
 * Regression Test Suite: Task 2 - Secure Firestore Request & Security Event Rules
 *
 * Validates:
 * 1. /securityEvents rules:
 *    - Unauthenticated create denied
 *    - Role/actor spoofing denied
 *    - Privileged event injection denied
 *    - Valid authenticated client signals allowed
 *    - Non-admin read denied; admin read allowed
 *    - Updates and deletes strictly denied (immutable)
 * 2. /requests/{requestId} rules:
 *    - Unauthenticated access denied
 *    - Customer creation: must match customerId and status == "Pending"
 *    - Customer cancellation: own Pending request can be Cancelled
 *    - Customer cannot alter protected fields (customerId, workerUid, service, etc.)
 *    - Customer cannot mark Accepted or Completed
 *    - Customer cannot cancel non-Pending requests
 *    - Assigned worker: can transition Pending -> Accepted, Pending -> Rejected, Accepted -> Completed
 *    - Assigned worker: cannot jump Pending -> Completed
 *    - Assigned worker: cannot reassign workerUid or alter service/customer details
 *    - Unassigned worker: cannot accept, reject, or complete
 *    - Worker cannot cancel
 *    - Non-admin cannot delete
 *    - Admin operations preserved
 * 3. Client-side updateFirestoreRequestStatus:
 *    - Supports Completed transition from Accepted
 *    - Rejects invalid jumps or unauthorized actors
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
console.log("TEST SUITE: TASK 2 - FIRESTORE REQUEST & SECURITY EVENT RULES");
console.log("==================================================");

// -------------------------------------------------------------
// PART 1: Client Unit Tests (updateFirestoreRequestStatus)
// -------------------------------------------------------------
console.log("\n--- Part 1: Client Service Logic (updateFirestoreRequestStatus) ---");

import { setFirestoreAdapterForTesting } from "../js/firebase-config.js";
import { updateFirestoreRequestStatus } from "../js/firestore-service.js";

function createMockFirestore(initialDocs = {}) {
  const docs = new Map();
  for (const [key, value] of Object.entries(initialDocs)) {
    docs.set(key, JSON.parse(JSON.stringify(value)));
  }

  const adapter = {
    docs,
    doc: (db, col, id) => `${col}/${id}`,
    getDoc: async (path) => ({
      exists: () => docs.has(path),
      data: () => (docs.has(path) ? JSON.parse(JSON.stringify(docs.get(path))) : null)
    }),
    updateDoc: async (path, updates) => {
      if (!docs.has(path)) throw new Error(`Doc ${path} does not exist`);
      const current = docs.get(path);
      Object.assign(current, updates);
      return current;
    }
  };

  return adapter;
}

await runAsyncTest("1a. Worker transitioning Accepted -> Completed succeeds", async () => {
  const mock = createMockFirestore({
    "requests/req-101": {
      id: "req-101",
      customerId: "cust-1",
      workerUid: "worker-1",
      status: "Accepted",
      service: "Plumbing"
    }
  });

  setFirestoreAdapterForTesting(mock);

  const res = await updateFirestoreRequestStatus("req-101", "Completed", "worker-1");
  assert.equal(res.success, true);
  assert.equal(res.status, "Completed");
  assert.equal(mock.docs.get("requests/req-101").status, "Completed");
  assert.ok(mock.docs.get("requests/req-101").completedAt);
});

await runAsyncTest("1b. Worker jumping Pending -> Completed is rejected by state machine", async () => {
  const mock = createMockFirestore({
    "requests/req-102": {
      id: "req-102",
      customerId: "cust-1",
      workerUid: "worker-1",
      status: "Pending",
      service: "Plumbing"
    }
  });

  setFirestoreAdapterForTesting(mock);

  const res = await updateFirestoreRequestStatus("req-102", "Completed", "worker-1");
  assert.equal(res.success, false);
  assert.match(res.error, /Request must be "Accepted" before completion/);
  assert.equal(mock.docs.get("requests/req-102").status, "Pending");
});

await runAsyncTest("1c. Customer attempting to mark request Completed is rejected", async () => {
  const mock = createMockFirestore({
    "requests/req-103": {
      id: "req-103",
      customerId: "cust-1",
      workerUid: "worker-1",
      status: "Accepted",
      service: "Plumbing"
    }
  });

  setFirestoreAdapterForTesting(mock);

  const res = await updateFirestoreRequestStatus("req-103", "Completed", "cust-1");
  assert.equal(res.success, false);
  assert.match(res.error, /Unauthorized: You are not the worker assigned/);
  assert.equal(mock.docs.get("requests/req-103").status, "Accepted");
});

await runAsyncTest("1d. Customer cancelling Pending request succeeds and records cancelledAt", async () => {
  const mock = createMockFirestore({
    "requests/req-104": {
      id: "req-104",
      customerId: "cust-1",
      workerUid: "worker-1",
      status: "Pending",
      service: "Plumbing"
    }
  });

  setFirestoreAdapterForTesting(mock);

  const res = await updateFirestoreRequestStatus("req-104", "Cancelled", "cust-1");
  assert.equal(res.success, true);
  assert.equal(res.status, "Cancelled");
  assert.equal(mock.docs.get("requests/req-104").status, "Cancelled");
  assert.ok(mock.docs.get("requests/req-104").cancelledAt);
});

await runAsyncTest("1e. Customer cancelling already Accepted request is rejected", async () => {
  const mock = createMockFirestore({
    "requests/req-105": {
      id: "req-105",
      customerId: "cust-1",
      workerUid: "worker-1",
      status: "Accepted",
      service: "Plumbing"
    }
  });

  setFirestoreAdapterForTesting(mock);

  const res = await updateFirestoreRequestStatus("req-105", "Cancelled", "cust-1");
  assert.equal(res.success, false);
  assert.match(res.error, /Only Pending requests can be updated/);
  assert.equal(mock.docs.get("requests/req-105").status, "Accepted");
});

// -------------------------------------------------------------
// PART 2: Real Firestore Emulator Security Rules Verification
// -------------------------------------------------------------
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

// Convert plain JS object to Firestore REST document fields
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

// Admin bypass write to seed data (using Bearer owner token)
async function seedDocument(collection, docId, data) {
  const url = `${BASE_URL}/${collection}/${docId}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer owner" // Emulator bypass token
    },
    body: JSON.stringify({ fields: toFirestoreFields(data) })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Seed failed for ${collection}/${docId}: ${res.status} ${text}`);
  }
}

async function createDocAsUser(collection, docId, data, uid) {
  const url = `${BASE_URL}/${collection}?documentId=${docId}`;
  return await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...makeAuthHeader(uid)
    },
    body: JSON.stringify({ fields: toFirestoreFields(data) })
  });
}

async function updateDocAsUser(collection, docId, data, updateMask, uid) {
  const maskQuery = updateMask.map((m) => `updateMask.fieldPaths=${encodeURIComponent(m)}`).join("&");
  const url = `${BASE_URL}/${collection}/${docId}?${maskQuery}`;
  return await fetch(url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...makeAuthHeader(uid)
    },
    body: JSON.stringify({ fields: toFirestoreFields(data) })
  });
}

async function getDocAsUser(collection, docId, uid) {
  const url = `${BASE_URL}/${collection}/${docId}`;
  return await fetch(url, {
    method: "GET",
    headers: makeAuthHeader(uid)
  });
}

async function deleteDocAsUser(collection, docId, uid) {
  const url = `${BASE_URL}/${collection}/${docId}`;
  return await fetch(url, {
    method: "DELETE",
    headers: makeAuthHeader(uid)
  });
}

const emulatorLive = await isEmulatorAvailable();
if (!emulatorLive) {
  console.log("\n[Notice] Firestore Emulator not running on 127.0.0.1:8085. Skipping live emulator checks.");
  console.log("Run this suite with 'firebase emulators:exec' to run live rule assertions.\n");
} else {
  console.log("\n--- Part 2: Live Firestore Emulator Rules Verification ---");

  // Seed baseline users & admin
  await seedDocument("admins", "admin-1", { role: "admin", active: true });
  await seedDocument("users", "cust-1", { uid: "cust-1", role: "customer" });
  await seedDocument("users", "cust-2", { uid: "cust-2", role: "customer" });
  await seedDocument("users", "worker-1", { uid: "worker-1", role: "worker" });
  await seedDocument("users", "worker-2", { uid: "worker-2", role: "worker" });

  // -----------------------------------------------------------
  // /securityEvents Tests
  // -----------------------------------------------------------
  await runAsyncTest("2a. Unauthenticated create on /securityEvents is DENIED (403)", async () => {
    const res = await createDocAsUser("securityEvents", "sec-unauth-1", {
      type: "UNAUTHORIZED_UI_ACTION",
      actorUid: "cust-1"
    }, null);
    assert.equal(res.status, 403);
  });

  await runAsyncTest("2b. Authenticated user forging different actorUid on /securityEvents is DENIED (403)", async () => {
    const res = await createDocAsUser("securityEvents", "sec-spoof-1", {
      type: "UNAUTHORIZED_UI_ACTION",
      actorUid: "cust-2" // Spoofing cust-2 while logged in as cust-1
    }, "cust-1");
    assert.equal(res.status, 403);
  });

  await runAsyncTest("2c. Authenticated user creating privileged event WORKER_APPROVAL_ACTION is DENIED (403)", async () => {
    const res = await createDocAsUser("securityEvents", "sec-priv-1", {
      type: "WORKER_APPROVAL_ACTION",
      actorUid: "cust-1"
    }, "cust-1");
    assert.equal(res.status, 403);
  });

  await runAsyncTest("2d. Authenticated user creating valid client security signal UNAUTHORIZED_UI_ACTION is ALLOWED (200)", async () => {
    const res = await createDocAsUser("securityEvents", "sec-valid-1", {
      type: "UNAUTHORIZED_UI_ACTION",
      actorUid: "cust-1",
      role: "customer",
      severity: "Medium"
    }, "cust-1");
    assert.equal(res.status, 200);
  });

  await runAsyncTest("2e. Non-admin reading /securityEvents is DENIED (403)", async () => {
    const res = await getDocAsUser("securityEvents", "sec-valid-1", "cust-1");
    assert.equal(res.status, 403);
  });

  await runAsyncTest("2f. Admin reading /securityEvents is ALLOWED (200)", async () => {
    const res = await getDocAsUser("securityEvents", "sec-valid-1", "admin-1");
    assert.equal(res.status, 200);
  });

  await runAsyncTest("2g. Modifying or deleting security events is DENIED even for Admin (403)", async () => {
    const updateRes = await updateDocAsUser("securityEvents", "sec-valid-1", {
      type: "INVALID_REQUEST"
    }, ["type"], "admin-1");
    assert.equal(updateRes.status, 403);

    const delRes = await deleteDocAsUser("securityEvents", "sec-valid-1", "admin-1");
    assert.equal(delRes.status, 403);
  });

  // -----------------------------------------------------------
  // /requests/{requestId} Tests
  // -----------------------------------------------------------

  // Seed baseline requests
  const baseRequest = {
    id: "req-pending-1",
    requestId: "req-pending-1",
    customerId: "cust-1",
    customerName: "Customer One",
    workerUid: "worker-1",
    workerId: "worker-1",
    workerName: "Worker One",
    service: "Plumbing",
    district: "Srinagar",
    problemDescription: "Leaking faucet",
    status: "Pending",
    createdAt: "2026-10-13T00:00:00.000Z"
  };

  await seedDocument("requests", "req-pending-1", baseRequest);

  await seedDocument("requests", "req-accepted-1", {
    ...baseRequest,
    id: "req-accepted-1",
    requestId: "req-accepted-1",
    status: "Accepted"
  });

  await seedDocument("requests", "req-completed-1", {
    ...baseRequest,
    id: "req-completed-1",
    requestId: "req-completed-1",
    status: "Completed"
  });

  await runAsyncTest("3a. Unauthenticated read/write on /requests is DENIED (403)", async () => {
    const readRes = await getDocAsUser("requests", "req-pending-1", null);
    assert.equal(readRes.status, 403);

    const updateRes = await updateDocAsUser("requests", "req-pending-1", {
      status: "Cancelled"
    }, ["status"], null);
    assert.equal(updateRes.status, 403);
  });

  await runAsyncTest("3b. Customer creating request for another customerId is DENIED (403)", async () => {
    const res = await createDocAsUser("requests", "req-new-spoof", {
      id: "req-new-spoof",
      customerId: "cust-2", // caller is cust-1
      workerUid: "worker-1",
      service: "Plumbing",
      status: "Pending"
    }, "cust-1");
    assert.equal(res.status, 403);
  });

  await runAsyncTest("3c. Customer creating request starting directly as Completed is DENIED (403)", async () => {
    const res = await createDocAsUser("requests", "req-new-comp", {
      id: "req-new-comp",
      customerId: "cust-1",
      workerUid: "worker-1",
      service: "Plumbing",
      status: "Completed" // not Pending
    }, "cust-1");
    assert.equal(res.status, 403);
  });

  await runAsyncTest("3d. Customer creating valid Pending request for themselves is ALLOWED (200)", async () => {
    const res = await createDocAsUser("requests", "req-new-valid", {
      id: "req-new-valid",
      customerId: "cust-1",
      workerUid: "worker-1",
      service: "Plumbing",
      status: "Pending"
    }, "cust-1");
    assert.equal(res.status, 200);
  });

  await runAsyncTest("3e. Customer cancelling their own Pending request is ALLOWED (200)", async () => {
    // Seed fresh pending doc
    await seedDocument("requests", "req-cust-cancel", { ...baseRequest, id: "req-cust-cancel" });
    const res = await updateDocAsUser("requests", "req-cust-cancel", {
      status: "Cancelled",
      updatedAt: "2026-10-13T12:00:00.000Z"
    }, ["status", "updatedAt"], "cust-1");
    assert.equal(res.status, 200);
  });

  await runAsyncTest("3f. Customer attempting to cancel someone else's request is DENIED (403)", async () => {
    await seedDocument("requests", "req-other-cancel", { ...baseRequest, id: "req-other-cancel" });
    const res = await updateDocAsUser("requests", "req-other-cancel", {
      status: "Cancelled"
    }, ["status"], "cust-2"); // cust-2 is not the owner
    assert.equal(res.status, 403);
  });

  await runAsyncTest("3g. Customer attempting to alter service or workerUid while cancelling is DENIED (403)", async () => {
    await seedDocument("requests", "req-tamper-cancel", { ...baseRequest, id: "req-tamper-cancel" });
    const res = await updateDocAsUser("requests", "req-tamper-cancel", {
      status: "Cancelled",
      service: "Electrician", // tampering protected field
      workerUid: "worker-2"
    }, ["status", "service", "workerUid"], "cust-1");
    assert.equal(res.status, 403);
  });

  await runAsyncTest("3h. Customer attempting to mark request Accepted or Completed is DENIED (403)", async () => {
    await seedDocument("requests", "req-cust-cheat", { ...baseRequest, id: "req-cust-cheat" });
    const resAcc = await updateDocAsUser("requests", "req-cust-cheat", {
      status: "Accepted"
    }, ["status"], "cust-1");
    assert.equal(resAcc.status, 403);

    const resComp = await updateDocAsUser("requests", "req-cust-cheat", {
      status: "Completed"
    }, ["status"], "cust-1");
    assert.equal(resComp.status, 403);
  });

  await runAsyncTest("3i. Customer attempting to cancel already Accepted request is DENIED (403)", async () => {
    const res = await updateDocAsUser("requests", "req-accepted-1", {
      status: "Cancelled"
    }, ["status"], "cust-1");
    assert.equal(res.status, 403);
  });

  await runAsyncTest("3j. Assigned worker accepting Pending request (Pending -> Accepted) is ALLOWED (200)", async () => {
    await seedDocument("requests", "req-work-accept", { ...baseRequest, id: "req-work-accept" });
    const res = await updateDocAsUser("requests", "req-work-accept", {
      status: "Accepted",
      acceptedAt: "2026-10-13T12:00:00.000Z",
      updatedAt: "2026-10-13T12:00:00.000Z"
    }, ["status", "acceptedAt", "updatedAt"], "worker-1");
    assert.equal(res.status, 200);
  });

  await runAsyncTest("3k. Assigned worker rejecting Pending request (Pending -> Rejected) is ALLOWED (200)", async () => {
    await seedDocument("requests", "req-work-reject", { ...baseRequest, id: "req-work-reject" });
    const res = await updateDocAsUser("requests", "req-work-reject", {
      status: "Rejected",
      rejectReason: "Not available",
      updatedAt: "2026-10-13T12:00:00.000Z"
    }, ["status", "rejectReason", "updatedAt"], "worker-1");
    assert.equal(res.status, 200);
  });

  await runAsyncTest("3l. Assigned worker completing Accepted request (Accepted -> Completed) is ALLOWED (200)", async () => {
    await seedDocument("requests", "req-work-complete", { ...baseRequest, id: "req-work-complete", status: "Accepted" });
    const res = await updateDocAsUser("requests", "req-work-complete", {
      status: "Completed",
      completedAt: "2026-10-13T12:00:00.000Z",
      updatedAt: "2026-10-13T12:00:00.000Z"
    }, ["status", "completedAt", "updatedAt"], "worker-1");
    assert.equal(res.status, 200);
  });

  await runAsyncTest("3m. Assigned worker jumping Pending directly to Completed is DENIED (403)", async () => {
    await seedDocument("requests", "req-jump-comp", { ...baseRequest, id: "req-jump-comp" });
    const res = await updateDocAsUser("requests", "req-jump-comp", {
      status: "Completed",
      completedAt: "2026-10-13T12:00:00.000Z"
    }, ["status", "completedAt"], "worker-1");
    assert.equal(res.status, 403);
  });

  await runAsyncTest("3n. Unassigned worker (worker-2) attempting to accept or complete is DENIED (403)", async () => {
    await seedDocument("requests", "req-unassigned", { ...baseRequest, id: "req-unassigned" });
    const resAccept = await updateDocAsUser("requests", "req-unassigned", {
      status: "Accepted"
    }, ["status"], "worker-2");
    assert.equal(resAccept.status, 403);

    const resComp = await updateDocAsUser("requests", "req-accepted-1", {
      status: "Completed"
    }, ["status"], "worker-2");
    assert.equal(resComp.status, 403);
  });

  await runAsyncTest("3o. Worker attempting to reassign workerUid or change customerId is DENIED (403)", async () => {
    await seedDocument("requests", "req-reassign", { ...baseRequest, id: "req-reassign" });
    const res = await updateDocAsUser("requests", "req-reassign", {
      status: "Accepted",
      workerUid: "worker-2"
    }, ["status", "workerUid"], "worker-1");
    assert.equal(res.status, 403);
  });

  await runAsyncTest("3p. Worker attempting to cancel request is DENIED (403)", async () => {
    await seedDocument("requests", "req-work-cancel", { ...baseRequest, id: "req-work-cancel" });
    const res = await updateDocAsUser("requests", "req-work-cancel", {
      status: "Cancelled"
    }, ["status"], "worker-1");
    assert.equal(res.status, 403);
  });

  await runAsyncTest("3q. Unrelated user reading request is DENIED (403); Owner & Assigned Worker can read (200)", async () => {
    const unauthRead = await getDocAsUser("requests", "req-pending-1", "cust-2");
    assert.equal(unauthRead.status, 403);

    const ownerRead = await getDocAsUser("requests", "req-pending-1", "cust-1");
    assert.equal(ownerRead.status, 200);

    const workerRead = await getDocAsUser("requests", "req-pending-1", "worker-1");
    assert.equal(workerRead.status, 200);
  });

  await runAsyncTest("3r. Non-admin deleting request is DENIED (403); Admin deleting request is ALLOWED (200)", async () => {
    await seedDocument("requests", "req-delete-test", { ...baseRequest, id: "req-delete-test" });

    const custDel = await deleteDocAsUser("requests", "req-delete-test", "cust-1");
    assert.equal(custDel.status, 403);

    const workDel = await deleteDocAsUser("requests", "req-delete-test", "worker-1");
    assert.equal(workDel.status, 403);

    const adminDel = await deleteDocAsUser("requests", "req-delete-test", "admin-1");
    assert.equal(adminDel.status, 200);
  });
}

console.log("\n==================================================");
console.log(`TOTAL TESTS: ${totalPassed + totalFailed} | PASSED: ${totalPassed} | FAILED: ${totalFailed}`);
console.log("==================================================");

if (totalFailed > 0) {
  process.exit(1);
}
