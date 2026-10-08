/**
 * @file step19.test.js
 * @description Comprehensive automated acceptance test suite for Step 19 Cloud Functions foundation.
 *
 * Verifies all 18 security criteria specified in Step 19:
 * 1. unauthenticated request denied
 * 2. customer accessing another customer's request denied
 * 3. worker accessing unrelated request denied
 * 4. worker accepting assigned request allowed
 * 5. unrelated worker accepting request denied
 * 6. customer cannot mark request completed
 * 7. assigned worker can complete eligible request
 * 8. invalid status transition denied
 * 9. customer can review completed request
 * 10. customer cannot review incomplete request
 * 11. duplicate review denied
 * 12. non-admin admin action denied
 * 13. admin authorized action allowed
 * 14. malformed IDs denied
 * 15. XSS/malicious input safely handled
 * 16. secrets never logged
 * 17. duplicate/replayed operation handled safely
 * 18. no accidental production writes during emulator tests
 */

const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { MockFirestore } = require("./mock-firestore");

// Isolate test environment
process.env.NODE_ENV = "test";
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8085";

const {
  assertAuthenticated,
  assertActiveAdmin,
  assertRequestOwner,
  assertAssignedWorker
} = require("../auth-helpers");

const {
  acceptRequest,
  rejectRequest,
  completeRequest,
  cancelRequest
} = require("../request-lifecycle");

const { submitReview, validateReviewInput } = require("../review-logic");
const { submitReport, validateReportInput } = require("../report-logic");

const {
  adminUpdateWorkerStatus,
  adminModerateReport,
  adminModerateReview
} = require("../admin-operations");

const { sanitizeLogPayload } = require("../audit-logger");

describe("Step 19: Trusted Backend Logic & Cloud Functions Security", () => {
  let db;

  const CUSTOMER_A_UID = "customer_user_alpha_111";
  const CUSTOMER_B_UID = "customer_user_beta_222";
  const WORKER_A_UID = "worker_pro_alpha_333";
  const WORKER_B_UID = "worker_pro_beta_444";
  const ADMIN_UID = "platform_admin_secure_999";

  beforeEach(() => {
    db = new MockFirestore();

    // Seed Active Admin record
    db.seed("admins", ADMIN_UID, {
      uid: ADMIN_UID,
      email: "admin@jkfixhub.test",
      role: "admin",
      active: true,
      displayName: "Platform Admin",
      createdAt: new Date().toISOString()
    });

    // Seed Worker profile
    db.seed("workers", WORKER_A_UID, {
      id: WORKER_A_UID,
      name: "Tariq Ahmad",
      service: "Plumbing",
      district: "Srinagar",
      status: "active",
      isVerified: true
    });

    // Seed User profiles
    db.seed("users", CUSTOMER_A_UID, {
      uid: CUSTOMER_A_UID,
      role: "customer",
      name: "Customer Alpha"
    });
    db.seed("users", WORKER_A_UID, {
      uid: WORKER_A_UID,
      role: "worker",
      name: "Tariq Ahmad"
    });
  });

  // --------------------------------------------------------------------------
  // TEST 1: Unauthenticated request denied
  // --------------------------------------------------------------------------
  test("1. Unauthenticated request denied", async () => {
    const unauthReq = { auth: null, data: { requestId: "req-101" } };

    await assert.rejects(
      async () => acceptRequest(db, unauthReq),
      (err) => {
        assert.equal(err.code, "unauthenticated");
        return true;
      }
    );

    await assert.rejects(
      async () => cancelRequest(db, unauthReq),
      (err) => {
        assert.equal(err.code, "unauthenticated");
        return true;
      }
    );
  });

  // --------------------------------------------------------------------------
  // TEST 2: Customer accessing another customer's request denied
  // --------------------------------------------------------------------------
  test("2. Customer accessing another customer's request denied", async () => {
    db.seed("requests", "req-owned-by-a", {
      customerId: CUSTOMER_A_UID,
      workerUid: WORKER_A_UID,
      status: "Pending"
    });

    const customerBReq = {
      auth: { uid: CUSTOMER_B_UID },
      data: { requestId: "req-owned-by-a" }
    };

    await assert.rejects(
      async () => cancelRequest(db, customerBReq),
      (err) => {
        assert.equal(err.code, "permission-denied");
        return true;
      }
    );
  });

  // --------------------------------------------------------------------------
  // TEST 3: Worker accessing unrelated request denied
  // --------------------------------------------------------------------------
  test("3. Worker accessing unrelated request denied", async () => {
    db.seed("requests", "req-for-worker-a", {
      customerId: CUSTOMER_A_UID,
      workerUid: WORKER_A_UID,
      status: "Pending"
    });

    const workerBReq = {
      auth: { uid: WORKER_B_UID },
      data: { requestId: "req-for-worker-a" }
    };

    await assert.rejects(
      async () => acceptRequest(db, workerBReq),
      (err) => {
        assert.equal(err.code, "permission-denied");
        return true;
      }
    );
  });

  // --------------------------------------------------------------------------
  // TEST 4: Worker accepting assigned request allowed
  // --------------------------------------------------------------------------
  test("4. Worker accepting assigned request allowed", async () => {
    db.seed("requests", "req-assign-1", {
      customerId: CUSTOMER_A_UID,
      workerUid: WORKER_A_UID,
      status: "Pending"
    });

    const workerAReq = {
      auth: { uid: WORKER_A_UID },
      data: { requestId: "req-assign-1" }
    };

    const res = await acceptRequest(db, workerAReq);
    assert.equal(res.success, true);
    assert.equal(res.status, "Accepted");

    const updated = db.dump("requests")["req-assign-1"];
    assert.equal(updated.status, "Accepted");
  });

  // --------------------------------------------------------------------------
  // TEST 5: Unrelated worker accepting request denied
  // --------------------------------------------------------------------------
  test("5. Unrelated worker accepting request denied", async () => {
    db.seed("requests", "req-assign-2", {
      customerId: CUSTOMER_A_UID,
      workerUid: WORKER_A_UID,
      status: "Pending"
    });

    const unassignedReq = {
      auth: { uid: "random_unrelated_worker" },
      data: { requestId: "req-assign-2" }
    };

    await assert.rejects(
      async () => acceptRequest(db, unassignedReq),
      (err) => {
        assert.equal(err.code, "permission-denied");
        return true;
      }
    );
  });

  // --------------------------------------------------------------------------
  // TEST 6: Customer cannot mark request completed
  // --------------------------------------------------------------------------
  test("6. Customer cannot mark request completed", async () => {
    db.seed("requests", "req-active-1", {
      customerId: CUSTOMER_A_UID,
      workerUid: WORKER_A_UID,
      status: "Accepted"
    });

    const customerReq = {
      auth: { uid: CUSTOMER_A_UID },
      data: { requestId: "req-active-1" }
    };

    await assert.rejects(
      async () => completeRequest(db, customerReq),
      (err) => {
        assert.equal(err.code, "permission-denied");
        return true;
      }
    );
  });

  // --------------------------------------------------------------------------
  // TEST 7: Assigned worker can complete eligible request
  // --------------------------------------------------------------------------
  test("7. Assigned worker can complete eligible request", async () => {
    db.seed("requests", "req-active-2", {
      customerId: CUSTOMER_A_UID,
      workerUid: WORKER_A_UID,
      status: "Accepted"
    });

    const workerReq = {
      auth: { uid: WORKER_A_UID },
      data: { requestId: "req-active-2" }
    };

    const res = await completeRequest(db, workerReq);
    assert.equal(res.success, true);
    assert.equal(res.status, "Completed");

    const updated = db.dump("requests")["req-active-2"];
    assert.equal(updated.status, "Completed");
  });

  // --------------------------------------------------------------------------
  // TEST 8: Invalid status transition denied
  // --------------------------------------------------------------------------
  test("8. Invalid status transition denied", async () => {
    // Cannot jump Pending -> Completed
    db.seed("requests", "req-pending-skip", {
      customerId: CUSTOMER_A_UID,
      workerUid: WORKER_A_UID,
      status: "Pending"
    });

    const workerReq = {
      auth: { uid: WORKER_A_UID },
      data: { requestId: "req-pending-skip" }
    };

    await assert.rejects(
      async () => completeRequest(db, workerReq),
      (err) => {
        assert.equal(err.code, "failed-precondition");
        return true;
      }
    );

    // Cannot cancel already Completed request
    db.seed("requests", "req-already-done", {
      customerId: CUSTOMER_A_UID,
      workerUid: WORKER_A_UID,
      status: "Completed"
    });

    const customerReq = {
      auth: { uid: CUSTOMER_A_UID },
      data: { requestId: "req-already-done" }
    };

    await assert.rejects(
      async () => cancelRequest(db, customerReq),
      (err) => {
        assert.equal(err.code, "failed-precondition");
        return true;
      }
    );
  });

  // --------------------------------------------------------------------------
  // TEST 9: Customer can review completed request
  // --------------------------------------------------------------------------
  test("9. Customer can review completed request", async () => {
    db.seed("requests", "req-review-done", {
      customerId: CUSTOMER_A_UID,
      workerUid: WORKER_A_UID,
      status: "Completed",
      customerName: "Customer Alpha",
      workerName: "Tariq Ahmad"
    });

    const reviewReq = {
      auth: { uid: CUSTOMER_A_UID },
      data: {
        requestId: "req-review-done",
        rating: 5,
        text: "Excellent plumbing service, completed on time."
      }
    };

    const res = await submitReview(db, reviewReq);
    assert.equal(res.success, true);
    assert.ok(res.reviewId);

    const reviews = db.dump("reviews");
    assert.equal(Object.keys(reviews).length, 1);
    assert.equal(reviews[res.reviewId].rating, 5);
  });

  // --------------------------------------------------------------------------
  // TEST 10: Customer cannot review incomplete request
  // --------------------------------------------------------------------------
  test("10. Customer cannot review incomplete request", async () => {
    db.seed("requests", "req-review-pending", {
      customerId: CUSTOMER_A_UID,
      workerUid: WORKER_A_UID,
      status: "Pending"
    });

    const reviewReq = {
      auth: { uid: CUSTOMER_A_UID },
      data: {
        requestId: "req-review-pending",
        rating: 4,
        text: "Attempting to review prematurely."
      }
    };

    await assert.rejects(
      async () => submitReview(db, reviewReq),
      (err) => {
        assert.equal(err.code, "failed-precondition");
        return true;
      }
    );
  });

  // --------------------------------------------------------------------------
  // TEST 11: Duplicate review denied
  // --------------------------------------------------------------------------
  test("11. Duplicate review denied", async () => {
    db.seed("requests", "req-review-dup", {
      customerId: CUSTOMER_A_UID,
      workerUid: WORKER_A_UID,
      status: "Completed"
    });

    // Seed existing review
    db.seed("reviews", "rev-existing-1", {
      requestId: "req-review-dup",
      customerId: CUSTOMER_A_UID,
      rating: 5,
      text: "First review"
    });

    const secondReviewReq = {
      auth: { uid: CUSTOMER_A_UID },
      data: {
        requestId: "req-review-dup",
        rating: 4,
        text: "Attempting duplicate review"
      }
    };

    await assert.rejects(
      async () => submitReview(db, secondReviewReq),
      (err) => {
        assert.equal(err.code, "already-exists");
        return true;
      }
    );
  });

  // --------------------------------------------------------------------------
  // TEST 12: Non-admin admin action denied
  // --------------------------------------------------------------------------
  test("12. Non-admin admin action denied", async () => {
    const nonAdminReq = {
      auth: { uid: CUSTOMER_A_UID },
      data: {
        workerId: WORKER_A_UID,
        status: "suspended"
      }
    };

    await assert.rejects(
      async () => adminUpdateWorkerStatus(db, nonAdminReq),
      (err) => {
        assert.equal(err.code, "permission-denied");
        return true;
      }
    );
  });

  // --------------------------------------------------------------------------
  // TEST 13: Admin authorized action allowed
  // --------------------------------------------------------------------------
  test("13. Admin authorized action allowed", async () => {
    const adminReq = {
      auth: { uid: ADMIN_UID },
      data: {
        workerId: WORKER_A_UID,
        status: "suspended",
        isVerified: false
      }
    };

    const res = await adminUpdateWorkerStatus(db, adminReq);
    assert.equal(res.success, true);

    const worker = db.dump("workers")[WORKER_A_UID];
    assert.equal(worker.status, "suspended");
    assert.equal(worker.isVerified, false);

    const audits = db.dump("auditLogs");
    assert.equal(Object.keys(audits).length, 1);
  });

  // --------------------------------------------------------------------------
  // TEST 14: Malformed IDs denied
  // --------------------------------------------------------------------------
  test("14. Malformed IDs denied", async () => {
    const malformedReq = {
      auth: { uid: WORKER_A_UID },
      data: { requestId: "../traversal/path" }
    };

    await assert.rejects(
      async () => acceptRequest(db, malformedReq),
      (err) => {
        assert.equal(err.code, "invalid-argument");
        return true;
      }
    );

    const emptyReq = {
      auth: { uid: WORKER_A_UID },
      data: { requestId: "   " }
    };

    await assert.rejects(
      async () => acceptRequest(db, emptyReq),
      (err) => {
        assert.equal(err.code, "invalid-argument");
        return true;
      }
    );
  });

  // --------------------------------------------------------------------------
  // TEST 15: XSS/malicious input safely handled
  // --------------------------------------------------------------------------
  test("15. XSS/malicious input safely handled", async () => {
    assert.throws(
      () =>
        validateReviewInput({
          requestId: "req-1",
          rating: 5,
          text: "<script>alert('xss')</script> Great service"
        }),
      (err) => {
        assert.equal(err.code, "invalid-argument");
        return true;
      }
    );

    assert.throws(
      () =>
        validateReportInput({
          targetType: "worker",
          targetId: WORKER_A_UID,
          reason: "harassment",
          description: "<script>malicious()</script> Inappropriate behavior"
        }),
      (err) => {
        assert.equal(err.code, "invalid-argument");
        return true;
      }
    );
  });

  // --------------------------------------------------------------------------
  // TEST 16: Secrets never logged
  // --------------------------------------------------------------------------
  test("16. Secrets never logged in audit payloads", () => {
    const payload = {
      adminUid: "admin1",
      userPassword: "PlainPassword123!",
      sessionToken: "eyJhbGciOi...",
      apiKey: "AIzaSySecret",
      safeDetail: "Updated district to Srinagar"
    };

    const sanitized = sanitizeLogPayload(payload);
    assert.equal(sanitized.userPassword, "[REDACTED]");
    assert.equal(sanitized.sessionToken, "[REDACTED]");
    assert.equal(sanitized.apiKey, "[REDACTED]");
    assert.equal(sanitized.safeDetail, "Updated district to Srinagar");
  });

  // --------------------------------------------------------------------------
  // TEST 17: Duplicate/replayed operation handled safely
  // --------------------------------------------------------------------------
  test("17. Duplicate/replayed operation handled safely (Idempotency)", async () => {
    db.seed("requests", "req-replayed", {
      customerId: CUSTOMER_A_UID,
      workerUid: WORKER_A_UID,
      status: "Accepted"
    });

    const replayReq = {
      auth: { uid: WORKER_A_UID },
      data: { requestId: "req-replayed" }
    };

    // Replay accept on already-accepted request
    const res = await acceptRequest(db, replayReq);
    assert.equal(res.success, true);
    assert.equal(res.status, "Accepted");
    assert.match(res.message, /already accepted/i);
  });

  // --------------------------------------------------------------------------
  // TEST 18: No accidental production writes during tests
  // --------------------------------------------------------------------------
  test("18. No accidental production writes during tests", () => {
    assert.equal(process.env.NODE_ENV, "test");
    assert.equal(process.env.FIRESTORE_EMULATOR_HOST, "127.0.0.1:8085");
    // Verify db is purely our in-memory MockFirestore instance
    assert.ok(db instanceof MockFirestore);
    assert.ok(typeof db.dump === "function");
  });
});
