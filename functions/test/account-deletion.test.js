/**
 * @file account-deletion.test.js
 * @description Emulator-compatible unit & integration tests for secure account deletion and privacy redaction.
 */

const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { MockFirestore } = require("./mock-firestore");
const {
  deleteUserAccount,
  assertRecentAuthentication,
  assertNoActiveRequests,
  reconcileStaleDeletionJobs,
  adminReconcileDeletionJobs,
  DEFAULT_STALE_THRESHOLD_MS,
  MAX_AUTH_AGE_SECONDS
} = require("../account-lifecycle");

describe("Account Deletion, Privacy & Failure-Handling Architecture", () => {
  let db;
  let mockAuthService;
  let deletedAuthUids;

  beforeEach(() => {
    db = new MockFirestore();
    deletedAuthUids = [];
    mockAuthService = {
      deleteUser: async (uid) => {
        deletedAuthUids.push(uid);
      }
    };
  });

  // Helper to construct a valid callable request object
  function makeCallableRequest(uid, ageSeconds = 30) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    return {
      auth: {
        uid,
        token: {
          auth_time: nowSeconds - ageSeconds
        }
      },
      data: {}
    };
  }

  // --------------------------------------------------------------------------
  // 1. Authorization & Authentication Freshness
  // --------------------------------------------------------------------------
  describe("1. Authorization & Authentication Freshness", () => {
    test("Rejects unauthenticated caller (missing request.auth)", async () => {
      await assert.rejects(
        async () => {
          await deleteUserAccount(db, { data: {} }, mockAuthService);
        },
        {
          code: "unauthenticated"
        }
      );
    });

    test("Rejects caller missing auth_time in token", async () => {
      const request = {
        auth: {
          uid: "cust-1",
          token: {}
        },
        data: {}
      };
      await assert.rejects(
        async () => {
          await deleteUserAccount(db, request, mockAuthService);
        },
        {
          code: "unauthenticated",
          message: /Recent authentication required/
        }
      );
    });

    test("Rejects caller with stale token (auth_time > 300s)", async () => {
      const staleRequest = makeCallableRequest("cust-1", 301); // 301 seconds old
      await assert.rejects(
        async () => {
          await deleteUserAccount(db, staleRequest, mockAuthService);
        },
        {
          code: "unauthenticated",
          message: /within the last 5 minutes/
        }
      );
    });

    test("Rejects caller with future auth_time (> 30s clock skew)", async () => {
      const futureRequest = makeCallableRequest("cust-1", -60); // 60s in future
      await assert.rejects(
        async () => {
          await deleteUserAccount(db, futureRequest, mockAuthService);
        },
        {
          code: "unauthenticated",
          message: /within the last 5 minutes/
        }
      );
    });

    test("Accepts caller with fresh authentication (< 300s)", () => {
      const freshRequest = makeCallableRequest("cust-1", 45); // 45 seconds old
      const authTime = assertRecentAuthentication(freshRequest);
      assert.strictEqual(typeof authTime, "number");
    });
  });

  // --------------------------------------------------------------------------
  // 2. Active-Request Rejection (Precondition Gate)
  // --------------------------------------------------------------------------
  describe("2. Active-Request Rejection (Precondition Gate)", () => {
    test("Rejects customer deletion if they have a Pending request", async () => {
      db.seed("users", "cust-pending", { uid: "cust-pending", role: "customer", name: "Aijaz" });
      db.seed("requests", "req-1", {
        customerId: "cust-pending",
        workerUid: "worker-1",
        status: "Pending"
      });

      const request = makeCallableRequest("cust-pending");
      await assert.rejects(
        async () => {
          await deleteUserAccount(db, request, mockAuthService);
        },
        {
          code: "failed-precondition",
          message: /Cannot delete account while you have active service requests/
        }
      );

      // Verify deletionJob recorded FAILED state
      const jobSnap = await db.collection("deletionJobs").doc("cust-pending").get();
      assert.strictEqual(jobSnap.data().state, "FAILED");
      // Verify user was NOT deleted from Auth
      assert.strictEqual(deletedAuthUids.includes("cust-pending"), false);
    });

    test("Rejects customer deletion if they have an Accepted request", async () => {
      db.seed("users", "cust-accepted", { uid: "cust-accepted", role: "customer", name: "Bilal" });
      db.seed("requests", "req-2", {
        customerId: "cust-accepted",
        workerUid: "worker-1",
        status: "Accepted"
      });

      const request = makeCallableRequest("cust-accepted");
      await assert.rejects(
        async () => {
          await deleteUserAccount(db, request, mockAuthService);
        },
        {
          code: "failed-precondition",
          message: /Cannot delete account while you have active service requests/
        }
      );
    });

    test("Rejects worker deletion if assigned a Pending request", async () => {
      db.seed("users", "worker-pending", { uid: "worker-pending", role: "worker", name: "Farooq" });
      db.seed("workers", "worker-pending", { status: "active", isVerified: true, name: "Farooq" });
      db.seed("requests", "req-3", {
        customerId: "cust-9",
        workerUid: "worker-pending",
        status: "Pending"
      });

      const request = makeCallableRequest("worker-pending");
      await assert.rejects(
        async () => {
          await deleteUserAccount(db, request, mockAuthService);
        },
        {
          code: "failed-precondition",
          message: /Cannot delete account while you have active service requests assigned to you/
        }
      );
    });

    test("Rejects worker deletion if assigned an Accepted request", async () => {
      db.seed("users", "worker-accepted", { uid: "worker-accepted", role: "worker", name: "Ghulam" });
      db.seed("workers", "worker-accepted", { status: "active", isVerified: true, name: "Ghulam" });
      db.seed("requests", "req-4", {
        customerId: "cust-9",
        workerUid: "worker-accepted",
        status: "Accepted"
      });

      const request = makeCallableRequest("worker-accepted");
      await assert.rejects(
        async () => {
          await deleteUserAccount(db, request, mockAuthService);
        },
        {
          code: "failed-precondition",
          message: /Cannot delete account while you have active service requests assigned to you/
        }
      );
    });
  });

  // --------------------------------------------------------------------------
  // 3. Customer Account Deletion & Privacy Redaction
  // --------------------------------------------------------------------------
  describe("3. Customer Account Deletion & Privacy Redaction", () => {
    test("Successfully deletes customer profile and anonymizes associated records", async () => {
      const uid = "cust-valid";
      // Seed user profile
      db.seed("users", uid, {
        uid,
        role: "customer",
        name: "Zahoor Ahmad",
        email: "zahoor@example.com",
        phone: "+919906000000",
        district: "Srinagar"
      });

      // Seed completed request
      db.seed("requests", "req-101", {
        customerId: uid,
        customerName: "Zahoor Ahmad",
        customerLocation: "Rajbagh, Srinagar",
        problemDescription: "Kitchen pipe leakage under sink",
        workerUid: "worker-1",
        service: "Plumbing",
        district: "Srinagar",
        status: "Completed",
        createdAt: "2026-10-01T10:00:00Z"
      });

      // Seed customer review
      db.seed("reviews", "req-101", {
        requestId: "req-101",
        customerId: uid,
        customerName: "Zahoor Ahmad",
        workerUid: "worker-1",
        rating: 5,
        text: "Excellent plumbing work done in Srinagar!",
        workerReply: "Thank you Zahoor sahib!",
        status: "published"
      });

      // Seed chat conversation and message
      db.seed("chats", "req-101", {
        participants: [uid, "worker-1"],
        customerId: uid,
        workerUid: "worker-1",
        isArchived: false
      });
      db.seed("chats/req-101/messages", "msg-1", {
        senderId: uid,
        senderUid: uid,
        senderName: "Zahoor Ahmad",
        text: "Please visit before 2 PM"
      });

      // Seed Trust & Safety report
      db.seed("reports", "rep-1", {
        reporterUid: uid,
        targetType: "worker",
        targetId: "worker-1",
        details: "Arrived slightly late"
      });

      // Seed security event
      db.seed("securityEvents", "sec-1", {
        actorUid: uid,
        type: "LOGIN_ATTEMPT"
      });

      const request = makeCallableRequest(uid, 20);
      const result = await deleteUserAccount(db, request, mockAuthService);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.status, "COMPLETED");

      // A. /users/{uid} must be hard deleted
      const userSnap = await db.collection("users").doc(uid).get();
      assert.strictEqual(userSnap.exists, false);

      // B. /requests must have customer PII scrubbed
      const reqSnap = await db.collection("requests").doc("req-101").get();
      const reqData = reqSnap.data();
      assert.strictEqual(reqData.customerName, "Former Customer");
      assert.strictEqual(reqData.customerLocation, "");
      assert.strictEqual(reqData.problemDescription, "[Description redacted upon account deletion]");
      assert.strictEqual(reqData.customerDeleted, true);
      // Commercial fields retained
      assert.strictEqual(reqData.service, "Plumbing");
      assert.strictEqual(reqData.status, "Completed");

      // C. /reviews must be anonymized (rating & feedback preserved)
      const revSnap = await db.collection("reviews").doc("req-101").get();
      const revData = revSnap.data();
      assert.strictEqual(revData.customerName, "Anonymous Customer");
      assert.strictEqual(revData.customerId, "deleted");
      assert.strictEqual(revData.rating, 5);
      assert.strictEqual(revData.text, "Excellent plumbing work done in Srinagar!");
      assert.strictEqual(revData.workerReply, "Thank you Zahoor sahib!");

      // D. /chats must be archived and message senderName redacted
      const chatSnap = await db.collection("chats").doc("req-101").get();
      const chatData = chatSnap.data();
      assert.strictEqual(chatData.isArchived, true);
      assert.strictEqual(chatData.archivedReason, "user_deleted");

      const msgSnap = await db.collection("chats").doc("req-101").collection("messages").doc("msg-1").get();
      const msgData = msgSnap.data();
      assert.strictEqual(msgData.senderName, "Former User");
      assert.strictEqual(msgData.text, "Please visit before 2 PM"); // Text retained for dispute evidence

      // E. /reports and /securityEvents preserved intact
      const repSnap = await db.collection("reports").doc("rep-1").get();
      assert.strictEqual(repSnap.exists, true);
      assert.strictEqual(repSnap.data().details, "Arrived slightly late");

      const secSnap = await db.collection("securityEvents").doc("sec-1").get();
      assert.strictEqual(secSnap.exists, true);

      // F. Firebase Auth user purged
      assert.strictEqual(deletedAuthUids.includes(uid), true);

      // G. Deletion job recorded as COMPLETED
      const jobSnap = await db.collection("deletionJobs").doc(uid).get();
      assert.strictEqual(jobSnap.data().state, "COMPLETED");

      // H. Immutable audit log recorded
      const auditDocs = await db.collection("auditLogs").where("actorUid", "==", uid).get();
      assert.strictEqual(auditDocs.empty, false);
      assert.strictEqual(auditDocs.docs[0].data().action, "ACCOUNT_DELETION");
    });
  });

  // --------------------------------------------------------------------------
  // 4. Worker Account Deletion & Discovery Lockout
  // --------------------------------------------------------------------------
  describe("4. Worker Account Deletion & Discovery Lockout", () => {
    test("Tombstones worker profile, excludes from discovery, and redacts request workerName", async () => {
      const workerId = "worker-tariq";

      // Seed private user document
      db.seed("users", workerId, {
        uid: workerId,
        role: "worker",
        name: "Tariq Electricals",
        email: "tariq@example.com",
        phone: "+919906111222"
      });

      // Seed public worker profile
      db.seed("workers", workerId, {
        name: "Tariq Electricals",
        district: "Anantnag",
        service: "Electrician",
        status: "active",
        isVerified: true,
        availability: "Available"
      });

      // Seed completed request assigned to worker
      db.seed("requests", "req-201", {
        customerId: "cust-other",
        customerName: "Imran",
        workerUid: workerId,
        workerName: "Tariq Electricals",
        status: "Completed"
      });

      // Seed chat between customer and worker
      db.seed("chats", "req-201", {
        participants: ["cust-other", workerId],
        workerUid: workerId,
        customerId: "cust-other",
        isArchived: false
      });

      const request = makeCallableRequest(workerId, 15);
      const result = await deleteUserAccount(db, request, mockAuthService);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.status, "COMPLETED");

      // A. Private user document hard-deleted
      const userSnap = await db.collection("users").doc(workerId).get();
      assert.strictEqual(userSnap.exists, false);

      // B. Public worker document tombstoned
      const workerSnap = await db.collection("workers").doc(workerId).get();
      const workerData = workerSnap.data();
      assert.strictEqual(workerData.name, "Former Professional");
      assert.strictEqual(workerData.status, "deleted");
      assert.strictEqual(workerData.isVerified, false);
      assert.strictEqual(workerData.availability, "Offline");

      // C. Public discovery query verification
      // A query filtering for active verified workers MUST NOT return this tombstoned worker
      const activeVerifiedWorkers = await db.collection("workers")
        .where("isVerified", "==", true)
        .where("status", "==", "active")
        .get();
      const foundInDiscovery = activeVerifiedWorkers.docs.some((d) => d.id === workerId);
      assert.strictEqual(foundInDiscovery, false);

      // D. Request workerName redacted
      const reqSnap = await db.collection("requests").doc("req-201").get();
      assert.strictEqual(reqSnap.data().workerName, "Former Professional");
      assert.strictEqual(reqSnap.data().workerDeleted, true);

      // E. Chat archived
      const chatSnap = await db.collection("chats").doc("req-201").get();
      assert.strictEqual(chatSnap.data().isArchived, true);

      // F. Firebase Auth purged
      assert.strictEqual(deletedAuthUids.includes(workerId), true);
    });
  });

  // --------------------------------------------------------------------------
  // 5. Idempotency & Fault Tolerance
  // --------------------------------------------------------------------------
  describe("5. Idempotency & Fault Tolerance", () => {
    test("Re-invoking deleteUserAccount on completed job returns success immediately", async () => {
      const uid = "cust-idempotent";
      db.seed("deletionJobs", uid, {
        uid,
        state: "COMPLETED",
        completedAt: new Date().toISOString()
      });

      const request = makeCallableRequest(uid, 10);
      const result = await deleteUserAccount(db, request, mockAuthService);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.status, "COMPLETED");
      assert.strictEqual(result.message, "Account deletion already completed.");
      // Auth deletion was not needlessly called again
      assert.strictEqual(deletedAuthUids.length, 0);
    });

    test("Recovers gracefully if user was already deleted from Firebase Auth (auth/user-not-found)", async () => {
      const uid = "cust-auth-missing";
      db.seed("users", uid, { uid, role: "customer", name: "Sami" });

      // Mock auth service throws auth/user-not-found
      const throwingAuth = {
        deleteUser: async () => {
          const err = new Error("User record not found");
          err.code = "auth/user-not-found";
          throw err;
        }
      };

      const request = makeCallableRequest(uid, 25);
      const result = await deleteUserAccount(db, request, throwingAuth);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.status, "COMPLETED");

      const jobSnap = await db.collection("deletionJobs").doc(uid).get();
      assert.strictEqual(jobSnap.data().state, "COMPLETED");
    });

    test("Preserves AUTH_DELETING state and records lastError on unexpected auth service error", async () => {
      const uid = "cust-auth-error";
      db.seed("users", uid, { uid, role: "customer", name: "Irfan" });

      const badAuth = {
        deleteUser: async () => {
          const err = new Error("Internal Auth Backend Error");
          err.code = "auth/internal-error";
          throw err;
        }
      };

      const request = makeCallableRequest(uid, 10);
      await assert.rejects(
        async () => {
          await deleteUserAccount(db, request, badAuth);
        },
        {
          code: "internal",
          message: /Internal Auth Backend Error/
        }
      );

      const jobSnap = await db.collection("deletionJobs").doc(uid).get();
      // Crucial: state must remain AUTH_DELETING so scheduled recovery or retry can finish it
      assert.strictEqual(jobSnap.data().state, "AUTH_DELETING");
      assert.match(jobSnap.data().lastError, /Internal Auth Backend Error/);
    });
  });

  // --------------------------------------------------------------------------
  // 6. Recovery of Orphaned Account Deletion Jobs
  // --------------------------------------------------------------------------
  describe("6. Recovery of Orphaned Account Deletion Jobs", () => {
    test("Auth deletion succeeds but completion recording fails: reconciles and finalizes job", async () => {
      const uid = "orphan-1";
      const pastTime = new Date(Date.now() - 20 * 60 * 1000).toISOString(); // 20 mins ago

      db.seed("deletionJobs", uid, {
        uid,
        state: "AUTH_DELETING",
        initiatedAt: pastTime,
        updatedAt: pastTime
      });

      // Auth service reports user is already deleted
      const authService = {
        getUser: async (targetUid) => {
          const err = new Error(`User ${targetUid} not found`);
          err.code = "auth/user-not-found";
          throw err;
        },
        deleteUser: async () => {}
      };

      const result = await reconcileStaleDeletionJobs(db, authService);

      assert.strictEqual(result.checkedCount, 1);
      assert.strictEqual(result.reconciledCount, 1);
      assert.strictEqual(result.skippedCount, 0);
      assert.strictEqual(result.errorCount, 0);

      // Verify job is now COMPLETED
      const jobSnap = await db.collection("deletionJobs").doc(uid).get();
      const jobData = jobSnap.data();
      assert.strictEqual(jobData.state, "COMPLETED");
      assert.strictEqual(jobData.reconciledReason, "auth_user_confirmed_deleted");

      // Verify audit log written
      const auditDocs = await db.collection("auditLogs").where("actorUid", "==", uid).get();
      assert.strictEqual(auditDocs.empty, false);
      assert.strictEqual(auditDocs.docs[0].data().action, "ACCOUNT_DELETION_RECONCILED");
    });

    test("The Auth user is already missing: confirms missing state and completes job", async () => {
      const uid = "orphan-already-missing";
      const pastTime = new Date(Date.now() - 25 * 60 * 1000).toISOString();

      db.seed("deletionJobs", uid, {
        uid,
        state: "AUTH_DELETING",
        initiatedAt: pastTime,
        updatedAt: pastTime
      });

      const authService = {
        getUser: async () => {
          const err = new Error("User record not found");
          err.code = "auth/user-not-found";
          throw err;
        },
        deleteUser: async () => {}
      };

      const result = await reconcileStaleDeletionJobs(db, authService);
      assert.strictEqual(result.reconciledCount, 1);

      const jobSnap = await db.collection("deletionJobs").doc(uid).get();
      assert.strictEqual(jobSnap.data().state, "COMPLETED");
    });

    test("The Auth service is temporarily unavailable: fails safe, does not complete job", async () => {
      const uid = "orphan-auth-down";
      const pastTime = new Date(Date.now() - 30 * 60 * 1000).toISOString();

      db.seed("deletionJobs", uid, {
        uid,
        state: "AUTH_DELETING",
        initiatedAt: pastTime,
        updatedAt: pastTime
      });

      // Auth service returns temporary error (503 / internal error)
      const authService = {
        getUser: async () => {
          const err = new Error("Auth service 503 unavailable");
          err.code = "auth/internal-error";
          throw err;
        },
        deleteUser: async () => {}
      };

      const result = await reconcileStaleDeletionJobs(db, authService);

      assert.strictEqual(result.checkedCount, 1);
      assert.strictEqual(result.reconciledCount, 0);
      assert.strictEqual(result.errorCount, 1);

      // Crucial: job MUST NOT be marked COMPLETED!
      const jobSnap = await db.collection("deletionJobs").doc(uid).get();
      assert.strictEqual(jobSnap.data().state, "AUTH_DELETING");
    });

    test("A job is too recent to reconcile: safely skipped to protect active execution", async () => {
      const uid = "orphan-active-running";
      // Updated only 1 minute ago (< 15 mins threshold)
      const recentTime = new Date(Date.now() - 60 * 1000).toISOString();

      db.seed("deletionJobs", uid, {
        uid,
        state: "AUTH_DELETING",
        initiatedAt: recentTime,
        updatedAt: recentTime
      });

      let getUserCalled = false;
      const authService = {
        getUser: async () => {
          getUserCalled = true;
          return { uid };
        },
        deleteUser: async () => {}
      };

      const result = await reconcileStaleDeletionJobs(db, authService);

      assert.strictEqual(result.checkedCount, 1);
      assert.strictEqual(result.skippedCount, 1);
      assert.strictEqual(result.reconciledCount, 0);
      assert.strictEqual(getUserCalled, false); // Auth was not even polled

      const jobSnap = await db.collection("deletionJobs").doc(uid).get();
      assert.strictEqual(jobSnap.data().state, "AUTH_DELETING");
    });

    test("A job is in an unexpected state: never reconciled or finalized", async () => {
      const pastTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();

      db.seed("deletionJobs", "job-init", {
        uid: "job-init",
        state: "INITIATED",
        initiatedAt: pastTime,
        updatedAt: pastTime
      });
      db.seed("deletionJobs", "job-unknown", {
        uid: "job-unknown",
        state: "PENDING_VERIFICATION",
        initiatedAt: pastTime,
        updatedAt: pastTime
      });
      db.seed("deletionJobs", "job-fail", {
        uid: "job-fail",
        state: "FAILED",
        initiatedAt: pastTime,
        updatedAt: pastTime
      });
      db.seed("deletionJobs", "job-comp", {
        uid: "job-comp",
        state: "COMPLETED",
        initiatedAt: pastTime,
        updatedAt: pastTime
      });

      const authService = {
        getUser: async () => {
          const err = new Error("User record not found");
          err.code = "auth/user-not-found";
          throw err;
        },
        deleteUser: async () => {}
      };

      const result = await reconcileStaleDeletionJobs(db, authService);

      assert.strictEqual(result.checkedCount, 0);
      assert.strictEqual(result.reconciledCount, 0);

      // Verify all non-target states are untouched
      assert.strictEqual((await db.collection("deletionJobs").doc("job-init").get()).data().state, "INITIATED");
      assert.strictEqual((await db.collection("deletionJobs").doc("job-unknown").get()).data().state, "PENDING_VERIFICATION");
      assert.strictEqual((await db.collection("deletionJobs").doc("job-fail").get()).data().state, "FAILED");
      assert.strictEqual((await db.collection("deletionJobs").doc("job-comp").get()).data().state, "COMPLETED");
    });

    test("Reconciliation is run repeatedly: idempotent with zero duplicate work", async () => {
      const uid = "orphan-idempotent";
      const pastTime = new Date(Date.now() - 30 * 60 * 1000).toISOString();

      db.seed("deletionJobs", uid, {
        uid,
        state: "AUTH_DELETING",
        initiatedAt: pastTime,
        updatedAt: pastTime
      });

      const authService = {
        getUser: async () => {
          const err = new Error("User record not found");
          err.code = "auth/user-not-found";
          throw err;
        },
        deleteUser: async () => {}
      };

      // Run 1: Reconciles the job
      const run1 = await reconcileStaleDeletionJobs(db, authService);
      assert.strictEqual(run1.reconciledCount, 1);

      // Run 2: Immediately re-run
      const run2 = await reconcileStaleDeletionJobs(db, authService);
      assert.strictEqual(run2.checkedCount, 0);
      assert.strictEqual(run2.reconciledCount, 0);

      // Run 3: Re-run again
      const run3 = await reconcileStaleDeletionJobs(db, authService);
      assert.strictEqual(run3.checkedCount, 0);
      assert.strictEqual(run3.reconciledCount, 0);

      // Verify exactly 1 audit log was written
      const auditDocs = await db.collection("auditLogs").where("actorUid", "==", uid).get();
      assert.strictEqual(auditDocs.size, 1);
    });

    test("A surviving Auth user with a new active request: aborts deletion and marks job FAILED", async () => {
      const uid = "surviving-with-active";
      const pastTime = new Date(Date.now() - 30 * 60 * 1000).toISOString();

      db.seed("deletionJobs", uid, {
        uid,
        state: "AUTH_DELETING",
        initiatedAt: pastTime,
        updatedAt: pastTime
      });

      // User created an active Pending request during the interval
      db.seed("requests", "req-surviving-active", {
        customerId: uid,
        workerUid: "worker-1",
        status: "Pending"
      });

      let deleteUserCalled = false;
      const authService = {
        getUser: async (targetUid) => {
          return { uid: targetUid, email: "survive@test.local" };
        },
        deleteUser: async () => {
          deleteUserCalled = true;
        }
      };

      const result = await reconcileStaleDeletionJobs(db, authService);

      assert.strictEqual(result.reconciledCount, 0);
      assert.strictEqual(result.errorCount, 1);
      assert.strictEqual(deleteUserCalled, false); // Crucial: Auth user was NOT deleted

      const jobSnap = await db.collection("deletionJobs").doc(uid).get();
      const jobData = jobSnap.data();
      assert.strictEqual(jobData.state, "FAILED");
      assert.match(jobData.error, /active service requests/);
    });

    test("A surviving Auth user with no active request: re-runs sanitization, deletes Auth user, and completes", async () => {
      const uid = "surviving-no-active";
      const pastTime = new Date(Date.now() - 30 * 60 * 1000).toISOString();

      db.seed("deletionJobs", uid, {
        uid,
        state: "AUTH_DELETING",
        initiatedAt: pastTime,
        updatedAt: pastTime
      });

      // Seed un-sanitized user profile and completed request
      db.seed("users", uid, {
        uid,
        name: "Surviving Customer",
        role: "customer"
      });
      db.seed("requests", "req-surviving-completed", {
        customerId: uid,
        customerName: "Surviving Customer",
        customerLocation: "Srinagar",
        status: "Completed"
      });

      let deleteUserCalled = false;
      const authService = {
        getUser: async (targetUid) => {
          return { uid: targetUid };
        },
        deleteUser: async (targetUid) => {
          deleteUserCalled = true;
          deletedAuthUids.push(targetUid);
        }
      };

      const result = await reconcileStaleDeletionJobs(db, authService);

      assert.strictEqual(result.reconciledCount, 1);
      assert.strictEqual(deleteUserCalled, true);

      // Verify sanitization ran
      const userSnap = await db.collection("users").doc(uid).get();
      assert.strictEqual(userSnap.exists, false);

      const reqSnap = await db.collection("requests").doc("req-surviving-completed").get();
      assert.strictEqual(reqSnap.data().customerName, "Former Customer");

      // Verify job is COMPLETED
      const jobSnap = await db.collection("deletionJobs").doc(uid).get();
      assert.strictEqual(jobSnap.data().state, "COMPLETED");
      assert.strictEqual(jobSnap.data().reconciledReason, "surviving_auth_user_sanitized_and_deleted");
    });

    test("Two reconciliation runs targeting the same job concurrently: transactional claim prevents duplicate processing and audit logs", async () => {
      const uid = "concurrent-orphan";
      const pastTime = new Date(Date.now() - 30 * 60 * 1000).toISOString();

      db.seed("deletionJobs", uid, {
        uid,
        state: "AUTH_DELETING",
        initiatedAt: pastTime,
        updatedAt: pastTime
      });

      const authService = {
        getUser: async () => {
          const err = new Error("User record not found");
          err.code = "auth/user-not-found";
          throw err;
        },
        deleteUser: async () => {}
      };

      // Launch both runs concurrently
      const [res1, res2] = await Promise.all([
        reconcileStaleDeletionJobs(db, authService),
        reconcileStaleDeletionJobs(db, authService)
      ]);

      const totalReconciled = res1.reconciledCount + res2.reconciledCount;
      assert.strictEqual(totalReconciled, 1);

      // Verify exactly 1 audit log was written (auditId prevents duplicates)
      const auditDocs = await db.collection("auditLogs").where("actorUid", "==", uid).get();
      assert.strictEqual(auditDocs.size, 1);

      const jobSnap = await db.collection("deletionJobs").doc(uid).get();
      assert.strictEqual(jobSnap.data().state, "COMPLETED");
    });

    test("Failure while writing completion state: catches error, fails safe, and leaves job retryable", async () => {
      const uid = "fail-on-write";
      const pastTime = new Date(Date.now() - 25 * 60 * 1000).toISOString();

      db.seed("deletionJobs", uid, {
        uid,
        state: "AUTH_DELETING",
        initiatedAt: pastTime,
        updatedAt: pastTime
      });

      // Temporary error during auth lookup or failure
      const authService = {
        getUser: async () => {
          const err = new Error("Firestore write failed / Network timeout");
          err.code = "auth/internal-error";
          throw err;
        },
        deleteUser: async () => {}
      };

      const result = await reconcileStaleDeletionJobs(db, authService);

      assert.strictEqual(result.reconciledCount, 0);
      assert.strictEqual(result.errorCount, 1);

      // Job is not marked COMPLETED and remains eligible for retry
      const jobSnap = await db.collection("deletionJobs").doc(uid).get();
      assert.strictEqual(jobSnap.data().state, "AUTH_DELETING");
    });

    test("A later retry after a transient failure: succeeds on subsequent run once service recovers", async () => {
      const uid = "transient-then-success";
      const pastTime = new Date(Date.now() - 30 * 60 * 1000).toISOString();

      db.seed("deletionJobs", uid, {
        uid,
        state: "AUTH_DELETING",
        initiatedAt: pastTime,
        updatedAt: pastTime
      });

      let authDown = true;
      const authService = {
        getUser: async () => {
          if (authDown) {
            const err = new Error("Temporary service unavailable");
            err.code = "auth/internal-error";
            throw err;
          }
          const err = new Error("User record not found");
          err.code = "auth/user-not-found";
          throw err;
        },
        deleteUser: async () => {}
      };

      // Run 1: Auth is down
      const run1 = await reconcileStaleDeletionJobs(db, authService);
      assert.strictEqual(run1.reconciledCount, 0);
      assert.strictEqual(run1.errorCount, 1);

      // Service recovers!
      authDown = false;

      // Run 2: Subsequent run
      const run2 = await reconcileStaleDeletionJobs(db, authService);
      assert.strictEqual(run2.reconciledCount, 1);

      const jobSnap = await db.collection("deletionJobs").doc(uid).get();
      assert.strictEqual(jobSnap.data().state, "COMPLETED");
      assert.strictEqual(jobSnap.data().reconciledReason, "auth_user_confirmed_deleted");
    });
  });

  // --------------------------------------------------------------------------
  // 7. Failure-Injection & Edge Case Resilience
  // --------------------------------------------------------------------------
  describe("7. Failure-Injection & Edge Case Resilience", () => {
    test("Mid-sanitization Firestore write failure followed by retry", async () => {
      const uid = "cust-mid-fail";
      db.seed("users", uid, {
        uid,
        role: "customer",
        name: "Midway Customer"
      });

      db.seed("requests", "req-mid-1", {
        id: "req-mid-1",
        customerId: uid,
        customerName: "Midway Customer",
        customerLocation: "Srinagar",
        problemDescription: "Issue 1",
        status: "Completed"
      });

      db.seed("requests", "req-mid-2", {
        id: "req-mid-2",
        customerId: uid,
        customerName: "Midway Customer",
        customerLocation: "Srinagar",
        problemDescription: "Issue 2",
        status: "Completed"
      });

      db.seed("requests", "req-mid-3", {
        id: "req-mid-3",
        customerId: uid,
        customerName: "Midway Customer",
        customerLocation: "Srinagar",
        problemDescription: "Issue 3",
        status: "Completed"
      });

      // Inject a transient failure specifically on req-mid-2
      let failDocId = "req-mid-2";
      const sampleDocRef = db.collection("requests").doc("req-mid-2");
      const MockDocRefClass = sampleDocRef.constructor;
      const origUpdate = MockDocRefClass.prototype.update;

      MockDocRefClass.prototype.update = async function (updates) {
        if (failDocId && this.id === failDocId) {
          throw new Error("Simulated Firestore write failure on " + this.id);
        }
        return origUpdate.call(this, updates);
      };

      try {
        const request = makeCallableRequest(uid, 15);

        // Run 1: Fails mid-sanitization on req-mid-2
        await assert.rejects(
          async () => {
            await deleteUserAccount(db, request, mockAuthService);
          },
          {
            code: "internal",
            message: /Simulated Firestore write failure on req-mid-2/
          }
        );

        // Job records FAILED with sanitization error
        const jobMidSnap = await db.collection("deletionJobs").doc(uid).get();
        assert.strictEqual(jobMidSnap.data().state, "FAILED");
        assert.match(jobMidSnap.data().error, /Simulated Firestore write failure/);

        // Clear failure injection
        failDocId = null;

        // Run 2: User retries deletion
        const retryResult = await deleteUserAccount(db, request, mockAuthService);
        assert.strictEqual(retryResult.success, true);
        assert.strictEqual(retryResult.status, "COMPLETED");

        // Verify ALL requests are now fully sanitized
        const r1 = (await db.collection("requests").doc("req-mid-1").get()).data();
        const r2 = (await db.collection("requests").doc("req-mid-2").get()).data();
        const r3 = (await db.collection("requests").doc("req-mid-3").get()).data();
        assert.strictEqual(r1.customerName, "Former Customer");
        assert.strictEqual(r2.customerName, "Former Customer");
        assert.strictEqual(r3.customerName, "Former Customer");

        // Verify user document deleted and auth purged
        assert.strictEqual((await db.collection("users").doc(uid).get()).exists, false);
        assert.strictEqual(deletedAuthUids.includes(uid), true);

        const jobFinalSnap = await db.collection("deletionJobs").doc(uid).get();
        assert.strictEqual(jobFinalSnap.data().state, "COMPLETED");
      } finally {
        MockDocRefClass.prototype.update = origUpdate;
      }
    });

    test("Firebase Auth deletion failure followed by successful scheduled recovery", async () => {
      const uid = "cust-auth-recovery";
      db.seed("users", uid, {
        uid,
        role: "customer",
        name: "Auth Recovery User"
      });
      db.seed("requests", "req-ar-1", {
        customerId: uid,
        customerName: "Auth Recovery User",
        status: "Completed"
      });

      let authFail = true;
      const recoverableAuth = {
        getUser: async (targetUid) => {
          return { uid: targetUid };
        },
        deleteUser: async (targetUid) => {
          if (authFail) {
            const err = new Error("Auth service 503 unavailable");
            err.code = "auth/internal-error";
            throw err;
          }
          deletedAuthUids.push(targetUid);
        }
      };

      const request = makeCallableRequest(uid, 20);

      // 1. Initial deleteUserAccount attempt: Auth fails
      await assert.rejects(
        async () => {
          await deleteUserAccount(db, request, recoverableAuth);
        },
        {
          code: "internal",
          message: /Auth service 503 unavailable/
        }
      );

      // Verify state is preserved as AUTH_DELETING (NOT FAILED!) with lastError
      const jobSnap1 = await db.collection("deletionJobs").doc(uid).get();
      assert.strictEqual(jobSnap1.data().state, "AUTH_DELETING");
      assert.match(jobSnap1.data().lastError, /503 unavailable/);
      assert.strictEqual(deletedAuthUids.includes(uid), false);

      // 2. Simulate 20 minutes elapsed (> 15m staleness threshold)
      const pastTime = new Date(Date.now() - 20 * 60 * 1000).toISOString();
      await db.collection("deletionJobs").doc(uid).set({
        initiatedAt: pastTime,
        updatedAt: pastTime
      }, { merge: true });

      // Service recovers!
      authFail = false;

      // 3. Scheduled recovery runs
      const reconcileResult = await reconcileStaleDeletionJobs(db, recoverableAuth);
      assert.strictEqual(reconcileResult.checkedCount, 1);
      assert.strictEqual(reconcileResult.reconciledCount, 1);

      // Verify user was deleted from Auth and job is COMPLETED
      assert.strictEqual(deletedAuthUids.includes(uid), true);
      const jobSnap2 = await db.collection("deletionJobs").doc(uid).get();
      assert.strictEqual(jobSnap2.data().state, "COMPLETED");
      assert.strictEqual(jobSnap2.data().reconciledReason, "surviving_auth_user_sanitized_and_deleted");
    });

    test("Legacy workerId reference sanitization", async () => {
      const workerId = "worker-legacy-test";
      db.seed("users", workerId, {
        uid: workerId,
        role: "worker",
        name: "Legacy Worker"
      });
      db.seed("workers", workerId, {
        name: "Legacy Worker",
        service: "Carpentry",
        status: "active",
        isVerified: true
      });

      // Request 1: Uses legacy workerId (workerUid is omitted/undefined)
      db.seed("requests", "req-legacy-only", {
        customerId: "cust-other",
        workerId: workerId,
        workerName: "Legacy Worker",
        status: "Completed"
      });

      // Request 2: Uses modern workerUid
      db.seed("requests", "req-modern-only", {
        customerId: "cust-other",
        workerUid: workerId,
        workerName: "Legacy Worker",
        status: "Completed"
      });

      const request = makeCallableRequest(workerId, 15);
      const result = await deleteUserAccount(db, request, mockAuthService);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.status, "COMPLETED");

      // Verify legacy workerId request is sanitized
      const reqLegacy = (await db.collection("requests").doc("req-legacy-only").get()).data();
      assert.strictEqual(reqLegacy.workerName, "Former Professional");
      assert.strictEqual(reqLegacy.workerDeleted, true);

      // Verify modern workerUid request is sanitized
      const reqModern = (await db.collection("requests").doc("req-modern-only").get()).data();
      assert.strictEqual(reqModern.workerName, "Former Professional");
      assert.strictEqual(reqModern.workerDeleted, true);
    });

    test("Recovery of a SANITIZING job older than 15 minutes", async () => {
      const uid = "cust-stale-sanitizing";
      const pastTime = new Date(Date.now() - 25 * 60 * 1000).toISOString(); // 25 mins ago

      db.seed("deletionJobs", uid, {
        uid,
        state: "SANITIZING",
        initiatedAt: pastTime,
        updatedAt: pastTime
      });

      // User profile and completed request that were NOT sanitized yet (simulating container crash)
      db.seed("users", uid, {
        uid,
        name: "Stale Sanitizing Customer",
        role: "customer"
      });
      db.seed("requests", "req-stale-san", {
        customerId: uid,
        customerName: "Stale Sanitizing Customer",
        customerLocation: "Baramulla",
        problemDescription: "Interrupted sanitization request",
        status: "Completed"
      });

      let deleteUserCalled = false;
      const authService = {
        getUser: async (targetUid) => {
          return { uid: targetUid };
        },
        deleteUser: async (targetUid) => {
          deleteUserCalled = true;
          deletedAuthUids.push(targetUid);
        }
      };

      const result = await reconcileStaleDeletionJobs(db, authService);

      assert.strictEqual(result.checkedCount, 1);
      assert.strictEqual(result.reconciledCount, 1);
      assert.strictEqual(deleteUserCalled, true);

      // Verify sanitization ran and user profile was deleted
      const userSnap = await db.collection("users").doc(uid).get();
      assert.strictEqual(userSnap.exists, false);

      // Verify request was sanitized
      const reqSnap = await db.collection("requests").doc("req-stale-san").get();
      assert.strictEqual(reqSnap.data().customerName, "Former Customer");
      assert.strictEqual(reqSnap.data().problemDescription, "[Description redacted upon account deletion]");

      // Verify job is COMPLETED
      const jobSnap = await db.collection("deletionJobs").doc(uid).get();
      assert.strictEqual(jobSnap.data().state, "COMPLETED");
      assert.strictEqual(jobSnap.data().reconciledReason, "surviving_auth_user_sanitized_and_deleted");
    });
  });

  // --------------------------------------------------------------------------
  // 8. Concurrent Request Creation and Deletion Prevention
  // --------------------------------------------------------------------------
  describe("8. Concurrent Request Creation and Deletion Prevention", () => {
    test("Aborts customer deletion if an active request is created concurrently during processing", async () => {
      const uid = "cust-concurrent-req";
      db.seed("users", uid, {
        uid,
        role: "customer",
        name: "Concurrent Customer"
      });
      db.seed("requests", "req-c-existing", {
        customerId: uid,
        customerName: "Concurrent Customer",
        status: "Completed"
      });

      // Hook MockDocRef.prototype.update to simulate a concurrent request creation
      // while sanitizeUserData is updating the completed request
      const sampleDocRef = db.collection("requests").doc("req-c-existing");
      const MockDocRefClass = sampleDocRef.constructor;
      const origUpdate = MockDocRefClass.prototype.update;

      let injectedConcurrentRequest = false;
      MockDocRefClass.prototype.update = async function (updates) {
        if (!injectedConcurrentRequest && this.id === "req-c-existing") {
          injectedConcurrentRequest = true;
          // Concurrently insert a new Pending request for this customer
          db.seed("requests", "req-concurrent-new", {
            id: "req-concurrent-new",
            customerId: uid,
            workerUid: "worker-99",
            status: "Pending"
          });
        }
        return origUpdate.call(this, updates);
      };

      try {
        const request = makeCallableRequest(uid, 15);

        await assert.rejects(
          async () => {
            await deleteUserAccount(db, request, mockAuthService);
          },
          {
            code: "failed-precondition",
            message: /Cannot delete account while you have active service requests/
          }
        );

        // Crucial assertions:
        // 1. Auth user must NOT have been deleted
        assert.strictEqual(deletedAuthUids.includes(uid), false);

        // 2. Job must be marked FAILED with clear reason
        const jobSnap = await db.collection("deletionJobs").doc(uid).get();
        assert.strictEqual(jobSnap.data().state, "FAILED");
        assert.match(jobSnap.data().error, /active service request detected during processing/);
      } finally {
        MockDocRefClass.prototype.update = origUpdate;
      }
    });

    test("Aborts worker deletion if an active request is assigned concurrently during processing", async () => {
      const workerId = "worker-concurrent-req";
      db.seed("users", workerId, {
        uid: workerId,
        role: "worker",
        name: "Concurrent Worker"
      });
      db.seed("workers", workerId, {
        name: "Concurrent Worker",
        service: "Plumbing",
        status: "active",
        isVerified: true
      });
      db.seed("requests", "req-w-existing", {
        customerId: "cust-other",
        workerUid: workerId,
        workerName: "Concurrent Worker",
        status: "Completed"
      });

      const sampleDocRef = db.collection("requests").doc("req-w-existing");
      const MockDocRefClass = sampleDocRef.constructor;
      const origUpdate = MockDocRefClass.prototype.update;

      let injectedConcurrentWorkerRequest = false;
      MockDocRefClass.prototype.update = async function (updates) {
        if (!injectedConcurrentWorkerRequest && this.id === "req-w-existing") {
          injectedConcurrentWorkerRequest = true;
          // Concurrently assign a new Accepted request to this worker
          db.seed("requests", "req-concurrent-assigned", {
            id: "req-concurrent-assigned",
            customerId: "cust-other-2",
            workerUid: workerId,
            status: "Accepted"
          });
        }
        return origUpdate.call(this, updates);
      };

      try {
        const request = makeCallableRequest(workerId, 15);

        await assert.rejects(
          async () => {
            await deleteUserAccount(db, request, mockAuthService);
          },
          {
            code: "failed-precondition",
            message: /Cannot delete account while you have active service requests/
          }
        );

        // Worker was NOT deleted from Auth
        assert.strictEqual(deletedAuthUids.includes(workerId), false);

        const jobSnap = await db.collection("deletionJobs").doc(workerId).get();
        assert.strictEqual(jobSnap.data().state, "FAILED");
        assert.match(jobSnap.data().error, /active service request detected during processing/);
      } finally {
        MockDocRefClass.prototype.update = origUpdate;
      }
    });

    test("Scheduled recovery aborts and preserves Auth user if active request created during reconciliation", async () => {
      const uid = "cust-reconcile-race";
      const pastTime = new Date(Date.now() - 30 * 60 * 1000).toISOString();

      db.seed("deletionJobs", uid, {
        uid,
        state: "AUTH_DELETING",
        initiatedAt: pastTime,
        updatedAt: pastTime
      });

      db.seed("users", uid, {
        uid,
        name: "Reconcile Race Customer",
        role: "customer"
      });

      // Hook to inject a new Pending request right during sanitization
      const sampleDocRef = db.collection("users").doc(uid);
      const MockDocRefClass = sampleDocRef.constructor;
      const origDelete = MockDocRefClass.prototype.delete;

      let injectedReconcileRequest = false;
      MockDocRefClass.prototype.delete = async function () {
        if (!injectedReconcileRequest && this.id === uid) {
          injectedReconcileRequest = true;
          db.seed("requests", "req-reconcile-active", {
            customerId: uid,
            workerUid: "worker-50",
            status: "Pending"
          });
        }
        return origDelete.call(this);
      };

      let deleteUserCalled = false;
      const authService = {
        getUser: async (targetUid) => ({ uid: targetUid }),
        deleteUser: async (targetUid) => {
          deleteUserCalled = true;
          deletedAuthUids.push(targetUid);
        }
      };

      try {
        const result = await reconcileStaleDeletionJobs(db, authService);

        assert.strictEqual(result.reconciledCount, 0);
        assert.strictEqual(result.errorCount, 1);
        // Crucial: Auth user must NOT be deleted
        assert.strictEqual(deleteUserCalled, false);
        assert.strictEqual(deletedAuthUids.includes(uid), false);

        const jobSnap = await db.collection("deletionJobs").doc(uid).get();
        assert.strictEqual(jobSnap.data().state, "FAILED");
        assert.match(jobSnap.data().error, /active service request detected/);
      } finally {
        MockDocRefClass.prototype.delete = origDelete;
      }
    });
  });
});
