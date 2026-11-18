const test = require("node:test");
const assert = require("node:assert/strict");

const {
  REVIEW_TYPES,
  resolveReviewType,
  calculateGenuineWorkerRating,
  submitReview,
  submitUnverifiedReview,
  editReview
} = require("../review-logic");

const {
  adminUpdateWorkerStatus,
  adminUpdateCustomerVerification,
  adminUpdateWorkerVerification,
  adminBackfillVerifiedWorkerBadges,
  adminModerateReview
} = require("../admin-operations");

const { submitReport } = require("../report-logic");
const { sanitizeUserData } = require("../account-lifecycle");

/**
 * In-memory Firestore mock supporting collections, docs, queries, and transactions.
 */
function createMockDb(seed = {}) {
  const store = new Map();
  for (const [path, data] of Object.entries(seed)) {
    store.set(path, JSON.parse(JSON.stringify(data)));
  }

  let autoCounter = 0;

  function docRef(collectionName, docId) {
    const path = `${collectionName}/${docId}`;
    return {
      id: docId,
      path,
      async get() {
        const has = store.has(path);
        const val = has ? JSON.parse(JSON.stringify(store.get(path))) : undefined;
        return {
          id: docId,
          exists: has,
          data: () => val
        };
      },
      async set(data, options = {}) {
        const clone = JSON.parse(JSON.stringify(data));
        if (options && options.merge && store.has(path)) {
          store.set(path, { ...store.get(path), ...clone });
        } else {
          store.set(path, clone);
        }
      },
      async update(data) {
        if (!store.has(path)) throw new Error(`NOT_FOUND: ${path}`);
        store.set(path, { ...store.get(path), ...JSON.parse(JSON.stringify(data)) });
      },
      async delete() {
        store.delete(path);
      }
    };
  }

  function buildQuery(collectionName, filters = [], limitCount = null) {
    return {
      where(field, op, value) {
        return buildQuery(collectionName, [...filters, { field, op, value }], limitCount);
      },
      limit(n) {
        return buildQuery(collectionName, filters, n);
      },
      async get() {
        const docs = [];
        for (const [p, val] of store.entries()) {
          if (!p.startsWith(`${collectionName}/`)) continue;
          const rest = p.slice(collectionName.length + 1);
          if (rest.includes("/")) continue;
          let match = true;
          for (const f of filters) {
            if (f.op === "==" && val[f.field] !== f.value) match = false;
            if (f.op === "in" && (!Array.isArray(f.value) || !f.value.includes(val[f.field]))) match = false;
          }
          if (match) {
            const snapData = JSON.parse(JSON.stringify(val));
            docs.push({
              id: rest,
              exists: true,
              ref: docRef(collectionName, rest),
              data: () => snapData
            });
          }
        }
        const sliced = typeof limitCount === "number" ? docs.slice(0, limitCount) : docs;
        return {
          size: sliced.length,
          empty: sliced.length === 0,
          docs: sliced,
          forEach: (cb) => sliced.forEach(cb)
        };
      }
    };
  }

  const db = {
    _store: store,
    collection(name) {
      return {
        doc(id) {
          const finalId = id || `auto-${++autoCounter}`;
          return docRef(name, finalId);
        },
        async add(data) {
          const finalId = `auto-${++autoCounter}`;
          const ref = docRef(name, finalId);
          await ref.set(data);
          return ref;
        },
        where(field, op, value) {
          return buildQuery(name, [{ field, op, value }]);
        },
        async get() {
          return buildQuery(name, []).get();
        }
      };
    },
    async runTransaction(fn) {
      const tx = {
        get: (ref) => ref.get(),
        set: (ref, data, opts) => ref.set(data, opts),
        update: (ref, data) => ref.update(data),
        delete: (ref) => ref.delete()
      };
      return fn(tx);
    }
  };
  return db;
}

test("calculateGenuineWorkerRating separates Verified Work and Unverified Experience counts accurately", () => {
  const summary = calculateGenuineWorkerRating([
    { id: "req-1", reviewType: "verified_work", verifiedService: true, rating: 5, status: "published" },
    { id: "req-2", reviewType: "verified_work", verifiedService: true, rating: 4, status: "published" },
    { id: "unv-w1-c3", reviewType: "unverified_experience", verifiedService: false, rating: 2, status: "published" },
    { id: "unv-w1-c4", reviewType: "unverified_experience", verifiedService: false, rating: 1, status: "hidden" }
  ]);

  assert.equal(summary.reviewCount, 3);
  assert.equal(summary.verifiedWorkCount, 2);
  assert.equal(summary.verifiedWorkAverage, 4.5);
  assert.equal(summary.unverifiedCount, 1);
  assert.equal(summary.rating, 3.7); // (5+4+2)/3 = 3.666 -> 3.7
  assert.equal(summary.distribution[5], 1);
  assert.equal(summary.distribution[4], 1);
  assert.equal(summary.distribution[2], 1);
  assert.equal(summary.distribution[1], 0); // Hidden excluded!
});

test("resolveReviewType never classifies unverified_experience as verified_work", () => {
  assert.equal(resolveReviewType({ reviewType: "unverified_experience", verifiedService: false }), REVIEW_TYPES.UNVERIFIED_EXPERIENCE);
  assert.equal(resolveReviewType({ verifiedService: false, requestId: null }), REVIEW_TYPES.UNVERIFIED_EXPERIENCE);
  assert.equal(resolveReviewType({ reviewType: "verified_work", verifiedService: true, requestId: "req-9" }), REVIEW_TYPES.VERIFIED_WORK);
  assert.equal(resolveReviewType({ verifiedService: true, requestId: "req-9" }), REVIEW_TYPES.VERIFIED_WORK);
});

test("submitUnverifiedReview allows 1 general feedback per (customer, worker), blocks duplicates, self-review, and suspended accounts", async () => {
  const db = createMockDb({
    "users/cust-1": { uid: "cust-1", role: "customer", name: "Aamir", status: "active" },
    "users/cust-susp": { uid: "cust-susp", role: "customer", name: "Blocked", status: "suspended" },
    "users/wrk-1": { uid: "wrk-1", role: "worker", name: "Bilal", status: "active" },
    "workers/wrk-1": { id: "wrk-1", name: "Bilal", service: "Electrician", district: "Srinagar", isVerified: true, status: "active", rating: null, reviewCount: 0 }
  });

  // 1. Valid unverified experience review succeeds
  const res1 = await submitUnverifiedReview(db, {
    auth: { uid: "cust-1" },
    data: { workerUid: "wrk-1", rating: 4, text: "Polite inquiry response over phone." }
  });
  assert.equal(res1.success, true);
  assert.equal(res1.reviewId, "unv-wrk-1-cust-1");
  const savedUnv = db._store.get("reviews/unv-wrk-1-cust-1");
  assert.equal(savedUnv.reviewType, "unverified_experience");
  assert.equal(savedUnv.verifiedService, false);
  assert.equal(savedUnv.requestId, null);

  const workerDoc = db._store.get("workers/wrk-1");
  assert.equal(workerDoc.rating, 4);
  assert.equal(workerDoc.reviewCount, 1);
  assert.equal(workerDoc.verifiedWorkCount, 0);
  assert.equal(workerDoc.unverifiedCount, 1);

  // 2. Duplicate unverified review by same customer for same worker is rejected
  await assert.rejects(
    () => submitUnverifiedReview(db, {
      auth: { uid: "cust-1" },
      data: { workerUid: "wrk-1", rating: 5, text: "Trying duplicate" }
    }),
    /already submitted an unverified experience review/i
  );

  // 3. Self-review is rejected
  await assert.rejects(
    () => submitUnverifiedReview(db, {
      auth: { uid: "wrk-1" },
      data: { workerUid: "wrk-1", rating: 5, text: "Self boost" }
    }),
    /own profile/i
  );

  // 4. Suspended customer is rejected
  await assert.rejects(
    () => submitUnverifiedReview(db, {
      auth: { uid: "cust-susp" },
      data: { workerUid: "wrk-1", rating: 1, text: "Suspended spam" }
    }),
    /suspended/i
  );
});

test("editReview allows editing unverified review within 24h while keeping reviewType & verifiedService immutable", async () => {
  const db = createMockDb({
    "users/cust-1": { uid: "cust-1", role: "customer", name: "Aamir", status: "active" },
    "workers/wrk-1": { id: "wrk-1", name: "Bilal", isVerified: true, status: "active" }
  });

  const created = await submitUnverifiedReview(db, {
    auth: { uid: "cust-1" },
    data: { workerUid: "wrk-1", rating: 3, text: "Initial feedback" }
  });

  const edited = await editReview(db, {
    auth: { uid: "cust-1" },
    data: { reviewId: created.reviewId, rating: 5, text: "Updated general feedback", tags: ["Polite"] }
  });
  assert.equal(edited.success, true);

  const stored = db._store.get(`reviews/${created.reviewId}`);
  assert.equal(stored.rating, 5);
  assert.equal(stored.reviewType, "unverified_experience");
  assert.equal(stored.verifiedService, false);
  assert.equal(stored.requestId, null);
  assert.equal(stored.editHistory.length, 1);
});

test("submitReview tags verified_work and aggregates cleanly alongside unverified_experience", async () => {
  const db = createMockDb({
    "users/cust-1": { uid: "cust-1", role: "customer", name: "Aamir", status: "active" },
    "users/cust-2": { uid: "cust-2", role: "customer", name: "Zoya", status: "active" },
    "workers/wrk-1": { id: "wrk-1", name: "Bilal", isVerified: true, status: "active" },
    "requests/req-100": {
      id: "req-100",
      customerId: "cust-1",
      customerName: "Aamir",
      workerUid: "wrk-1",
      workerName: "Bilal",
      service: "Electrician",
      district: "Srinagar",
      status: "Completed"
    }
  });

  const ver = await submitReview(db, {
    auth: { uid: "cust-1" },
    data: { requestId: "req-100", rating: 5, text: "Excellent wiring job" }
  });
  const savedVer = db._store.get(`reviews/${ver.reviewId}`);
  assert.equal(savedVer.reviewType, "verified_work");
  assert.equal(savedVer.verifiedService, true);

  await submitUnverifiedReview(db, {
    auth: { uid: "cust-2" },
    data: { workerUid: "wrk-1", rating: 3, text: "Quick call estimate" }
  });

  const wDoc = db._store.get("workers/wrk-1");
  assert.equal(wDoc.rating, 4);
  assert.equal(wDoc.reviewCount, 2);
  assert.equal(wDoc.verifiedWorkCount, 1);
  assert.equal(wDoc.verifiedWorkAverage, 5);
  assert.equal(wDoc.unverifiedCount, 1);
});

test("adminUpdateCustomerVerification & adminUpdateWorkerVerification enforce admin RBAC, history, /verifiedBadges sync, and auditLogs", async () => {
  const db = createMockDb({
    "admins/admin-1": { role: "admin", active: true },
    "users/cust-1": { uid: "cust-1", role: "customer", name: "Sana", status: "active" },
    "users/non-admin": { uid: "non-admin", role: "customer", name: "Sneaky", status: "active" },
    "workers/wrk-1": { id: "wrk-1", name: "Tariq", isVerified: false, status: "pending" }
  });

  // Non-admin blocked from verifying customer or worker
  await assert.rejects(
    () => adminUpdateCustomerVerification(db, {
      auth: { uid: "non-admin" },
      data: { customerId: "cust-1", status: "Verified" }
    }),
    /authorized administrators/i
  );
  await assert.rejects(
    () => adminUpdateWorkerVerification(db, {
      auth: { uid: "non-admin" },
      data: { workerId: "wrk-1", status: "Verified" }
    }),
    /authorized administrators/i
  );

  // Reject customer without reason fails
  await assert.rejects(
    () => adminUpdateCustomerVerification(db, {
      auth: { uid: "admin-1" },
      data: { customerId: "cust-1", status: "Rejected" }
    }),
    /reason is required/i
  );

  // Admin approves customer -> badge created in /verifiedBadges/cust-1 + history + auditLog
  const custGrant = await adminUpdateCustomerVerification(db, {
    auth: { uid: "admin-1" },
    data: { customerId: "cust-1", status: "Verified", internalNote: "Verified existing profile" }
  });
  assert.equal(custGrant.success, true);
  assert.equal(db._store.get("users/cust-1").isVerified, true);
  assert.equal(db._store.get("users/cust-1").customerVerification.status, "Verified");
  assert.equal(db._store.get("users/cust-1").customerVerification.history.length, 1);
  assert.equal(db._store.get("verifiedBadges/cust-1").badgeType, "verified_customer");
  assert.equal(db._store.get("verifiedBadges/cust-1").verified, true);

  // Admin revokes customer -> badge immediately removed from /verifiedBadges/cust-1
  const custRevoke = await adminUpdateCustomerVerification(db, {
    auth: { uid: "admin-1" },
    data: { customerId: "cust-1", status: "Revoked", internalNote: "Manual review revocation" }
  });
  assert.equal(custRevoke.success, true);
  assert.equal(db._store.get("users/cust-1").isVerified, false);
  assert.equal(db._store.get("users/cust-1").customerVerification.status, "Revoked");
  assert.equal(db._store.get("users/cust-1").customerVerification.history.length, 2);
  assert.equal(db._store.has("verifiedBadges/cust-1"), false);

  // Admin grants worker badge -> /workers/wrk-1 & /verifiedBadges/wrk-1 updated
  const wrkGrant = await adminUpdateWorkerVerification(db, {
    auth: { uid: "admin-1" },
    data: { workerId: "wrk-1", status: "Verified", internalNote: "Craftsman verified" }
  });
  assert.equal(wrkGrant.success, true);
  assert.equal(db._store.get("workers/wrk-1").isVerified, true);
  assert.equal(db._store.get("workers/wrk-1").workerVerification.status, "Verified");
  assert.equal(db._store.get("verifiedBadges/wrk-1").badgeType, "verified_professional");

  // Admin revokes worker badge -> /verifiedBadges/wrk-1 deleted
  const wrkRevoke = await adminUpdateWorkerVerification(db, {
    auth: { uid: "admin-1" },
    data: { workerId: "wrk-1", status: "Revoked", internalNote: "Badge revoked" }
  });
  assert.equal(wrkRevoke.success, true);
  assert.equal(db._store.get("workers/wrk-1").isVerified, false);
  assert.equal(db._store.has("verifiedBadges/wrk-1"), false);

  // Immutable audit logs recorded for all 4 admin transitions
  const auditEntries = [];
  for (const [k, v] of db._store.entries()) {
    if (k.startsWith("auditLogs/")) auditEntries.push(v);
  }
  assert.equal(auditEntries.length, 4);
  assert.ok(auditEntries.some((a) => a.action === "CUSTOMER_VERIFICATION_GRANTED"));
  assert.ok(auditEntries.some((a) => a.action === "CUSTOMER_VERIFICATION_REVOKED"));
  assert.ok(auditEntries.some((a) => a.action === "WORKER_BADGE_GRANTED"));
  assert.ok(auditEntries.some((a) => a.action === "WORKER_BADGE_REVOKED"));
});

test("account deletion sanitizeUserData removes /verifiedBadges/{uid} immediately", async () => {
  const db = createMockDb({
    "users/cust-del": { uid: "cust-del", name: "Delete Me", email: "del@example.com", role: "customer", isVerified: true },
    "verifiedBadges/cust-del": { uid: "cust-del", role: "customer", badgeType: "verified_customer", verified: true }
  });

  await sanitizeUserData(db, "cust-del");
  assert.equal(db._store.has("users/cust-del"), false);
  assert.equal(db._store.has("verifiedBadges/cust-del"), false);
});

test("Phase 6 membership-schema keeps official verification, Pro membership, and promotional placement strictly separate", async () => {
  const schema = await import("../../js/membership-schema.js");

  // Even if a future account has pro tier active, it MUST NOT grant official verification!
  const unverifiedProWorker = schema.resolveAccountTrustAndMembership({
    isVerified: false,
    workerVerification: { status: "Not Verified" },
    membership: { tier: "pro", status: "active" },
    promotionalPlacement: { enabled: false, rankingWeight: 0 }
  }, "worker");

  assert.equal(unverifiedProWorker.verification.status, "Not Verified");
  assert.equal(unverifiedProWorker.verification.isVerified, false);
  // While JKFixHub Pro is not yet launched, runtime membership stays inert ("free" / "inactive")
  assert.equal(unverifiedProWorker.membership.tier, "free");
  assert.equal(unverifiedProWorker.membership.status, "inactive");
  assert.equal(unverifiedProWorker.promotionalPlacement.enabled, false);
  assert.equal(unverifiedProWorker.promotionalPlacement.rankingWeight, 0);

  // Default membership & promotional placement are free/inactive/disabled
  const defaultCustomer = schema.resolveAccountTrustAndMembership({ role: "customer" }, "customer");
  assert.equal(defaultCustomer.verification.status, "Not Verified");
  assert.equal(defaultCustomer.verification.isVerified, false);
  assert.equal(defaultCustomer.membership.tier, "free");
  assert.equal(defaultCustomer.membership.status, "inactive");
  assert.equal(defaultCustomer.promotionalPlacement.enabled, false);
  assert.equal(defaultCustomer.promotionalPlacement.rankingWeight, 0);
});

test("Audit #1: Stale isVerified:true NEVER overrides Revoked/Rejected/Pending/Deleted status for workers or customers", async () => {
  const schema = await import("../../js/membership-schema.js");

  // Worker with stale isVerified:true but revoked workerVerification -> MUST be false
  for (const st of ["Revoked", "Rejected", "Pending", "Not Verified"]) {
    const staleWrk = { isVerified: true, status: "active", workerVerification: { status: st } };
    assert.equal(schema.isWorkerOfficiallyVerified(staleWrk), false, `Stale worker with status=${st} must not be verified`);
    assert.equal(schema.normalizeWorkerVerification(staleWrk).isVerified, false);
  }
  // Deleted worker with stale isVerified:true -> MUST be false
  assert.equal(schema.isWorkerOfficiallyVerified({ isVerified: true, status: "deleted", workerVerification: { status: "Verified" } }), false);
  // Genuine legacy active worker (no workerVerification object yet, isVerified:true) -> true
  assert.equal(schema.isWorkerOfficiallyVerified({ isVerified: true, status: "active" }), true);
  // Genuine verified worker -> true
  assert.equal(schema.isWorkerOfficiallyVerified({ isVerified: true, status: "active", workerVerification: { status: "Verified" } }), true);
  // Revoked via isVerified:false even if workerVerification.status stale "Verified" -> MUST be false
  assert.equal(schema.isWorkerOfficiallyVerified({ isVerified: false, status: "active", workerVerification: { status: "Verified" } }), false);

  // Customer with stale standalone isVerified:true without customerVerification.status==="Verified" -> MUST be false
  assert.equal(schema.isCustomerOfficiallyVerified({ isVerified: true }), false);
  assert.equal(schema.isCustomerOfficiallyVerified({ isVerified: true, customerVerification: { status: "Revoked" } }), false);
  assert.equal(schema.isCustomerOfficiallyVerified({ isVerified: false, customerVerification: { status: "Verified" } }), false);
  assert.equal(schema.isCustomerOfficiallyVerified({ isVerified: true, customerVerification: { status: "Verified" } }), true);
});

test("Audit #1b: adminUpdateWorkerStatus preserves & appends workerVerification.history and syncs /verifiedBadges", async () => {
  const db = createMockDb({
    "admins/admin-1": { role: "admin", active: true },
    "workers/wrk-hist": {
      id: "wrk-hist",
      name: "Tariq",
      status: "pending",
      isVerified: false,
      workerVerification: {
        status: "Pending",
        history: [{ previousStatus: "Not Verified", newStatus: "Pending", actionBy: "admin-0", actionAt: "2026-01-01T00:00:00.000Z" }]
      }
    }
  });

  // Approve worker via Workers tab -> appends history & creates /verifiedBadges/wrk-hist
  await adminUpdateWorkerStatus(db, {
    auth: { uid: "admin-1" },
    data: { workerId: "wrk-hist", status: "active", isVerified: true, reason: "Approved" }
  });
  const afterApprove = db._store.get("workers/wrk-hist");
  assert.equal(afterApprove.isVerified, true);
  assert.equal(afterApprove.workerVerification.status, "Verified");
  assert.equal(afterApprove.workerVerification.history.length, 2);
  assert.equal(db._store.get("verifiedBadges/wrk-hist").badgeType, "verified_professional");

  // Reject worker (without explicit isVerified) -> revokes isVerified, appends history, deletes /verifiedBadges/wrk-hist
  await adminUpdateWorkerStatus(db, {
    auth: { uid: "admin-1" },
    data: { workerId: "wrk-hist", status: "rejected", reason: "Policy violation" }
  });
  const afterReject = db._store.get("workers/wrk-hist");
  assert.equal(afterReject.isVerified, false);
  assert.equal(afterReject.workerVerification.status, "Rejected");
  assert.equal(afterReject.workerVerification.history.length, 3);
  assert.equal(db._store.has("verifiedBadges/wrk-hist"), false);
});

test("Audit #2: adminBackfillVerifiedWorkerBadges is admin-only, dry-run-first, non-PII, cleans stale records, and 100% idempotent", async () => {
  const db = createMockDb({
    "admins/admin-1": { role: "admin", active: true },
    "users/cust-1": { uid: "cust-1", role: "customer", status: "active" },
    // 1. Legacy active verified worker (needs /verifiedBadges + workerVerification metadata)
    "workers/wrk-legacy": { id: "wrk-legacy", name: "Legacy Pro", status: "active", isVerified: true, createdAt: "2025-10-01T00:00:00.000Z" },
    // 2. Pending unverified worker (must NOT receive badge)
    "workers/wrk-pend": { id: "wrk-pend", name: "Pending Pro", status: "pending", isVerified: false },
    // 3. Stale conflicted worker (isVerified:true + workerVerification:Revoked + orphaned badge -> must repair & delete badge)
    "workers/wrk-stale": { id: "wrk-stale", name: "Stale Pro", status: "active", isVerified: true, workerVerification: { status: "Revoked" } },
    "verifiedBadges/wrk-stale": { uid: "wrk-stale", role: "worker", badgeType: "verified_professional", verified: true },
    // 4. Verified customer badge (must remain untouched by worker backfill!)
    "verifiedBadges/cust-verified": { uid: "cust-verified", role: "customer", badgeType: "verified_customer", verified: true }
  });

  // Non-admin strictly denied
  await assert.rejects(
    () => adminBackfillVerifiedWorkerBadges(db, { auth: { uid: "cust-1" }, data: { dryRun: true } }),
    /authorized administrators/i
  );

  // Dry-run previews exact plan with ZERO writes
  const preview = await adminBackfillVerifiedWorkerBadges(db, { auth: { uid: "admin-1" }, data: { dryRun: true } });
  assert.equal(preview.dryRun, true);
  assert.deepEqual(preview.badgesToCreate, ["wrk-legacy"]);
  assert.deepEqual(preview.workerMetaToBackfill, ["wrk-legacy"]);
  assert.deepEqual(preview.staleFlagsToRepair, ["wrk-stale"]);
  assert.deepEqual(preview.staleBadgesToDelete, ["wrk-stale"]);
  assert.equal(db._store.has("verifiedBadges/wrk-legacy"), false, "Dry-run must NOT write");
  assert.equal(db._store.has("verifiedBadges/wrk-stale"), true, "Dry-run must NOT delete");

  // Live run executes backfill & repairs
  const exec1 = await adminBackfillVerifiedWorkerBadges(db, { auth: { uid: "admin-1" }, data: { dryRun: false } });
  assert.equal(exec1.dryRun, false);
  const newBadge = db._store.get("verifiedBadges/wrk-legacy");
  assert.ok(newBadge && newBadge.verified === true && newBadge.badgeType === "verified_professional");
  // Strictly non-PII check on created badge document
  assert.deepEqual(Object.keys(newBadge).sort(), ["badgeType", "role", "uid", "updatedAt", "verified", "verifiedAt"]);
  assert.equal(db._store.get("workers/wrk-legacy").workerVerification.status, "Verified");
  assert.equal(db._store.has("verifiedBadges/wrk-pend"), false);
  assert.equal(db._store.get("workers/wrk-stale").isVerified, false);
  assert.equal(db._store.has("verifiedBadges/wrk-stale"), false);
  assert.equal(db._store.has("verifiedBadges/cust-verified"), true, "Customer badge must stay untouched");

  // Second run is 100% idempotent (0 changes!)
  const exec2 = await adminBackfillVerifiedWorkerBadges(db, { auth: { uid: "admin-1" }, data: { dryRun: false } });
  assert.equal(exec2.badgesToCreate.length, 0);
  assert.equal(exec2.workerMetaToBackfill.length, 0);
  assert.equal(exec2.staleBadgesToDelete.length, 0);
  assert.equal(exec2.staleFlagsToRepair.length, 0);
  assert.equal(exec2.alreadySynced, 3);
});

test("Audit #4: Reporting and admin moderation work for BOTH verified_work and unverified_experience reviews", async () => {
  const db = createMockDb({
    "admins/admin-1": { role: "admin", active: true },
    "users/cust-1": { uid: "cust-1", role: "customer", name: "Customer 1", status: "active" },
    "users/cust-2": { uid: "cust-2", role: "customer", name: "Customer 2", status: "active" },
    "workers/wrk-mod": { id: "wrk-mod", name: "Mod Tech", isVerified: true, status: "active" },
    "requests/req-mod-1": { id: "req-mod-1", customerId: "cust-1", workerUid: "wrk-mod", status: "Completed" }
  });

  const vw = await submitReview(db, { auth: { uid: "cust-1" }, data: { requestId: "req-mod-1", rating: 5, text: "Great job" } });
  const uv = await submitUnverifiedReview(db, { auth: { uid: "cust-2" }, data: { workerUid: "wrk-mod", rating: 1, text: "Rude call" } });

  // Report both review types
  const rep1 = await submitReport(db, { auth: { uid: "wrk-mod" }, data: { targetType: "review", targetId: vw.reviewId, reason: "spam", description: "Reporting verified work review for test." } });
  const rep2 = await submitReport(db, { auth: { uid: "wrk-mod" }, data: { targetType: "review", targetId: uv.reviewId, reason: "abusive", description: "Reporting unverified experience review for test." } });
  assert.equal(rep1.success, true);
  assert.equal(rep2.success, true);

  // Admin hides the 1-star unverified review -> worker rating recalculates to 5.0 (1 Verified Work, 0 Unverified)
  await adminModerateReview(db, { auth: { uid: "admin-1" }, data: { reviewId: uv.reviewId, status: "hidden", note: "Abusive content" } });
  const afterHide = db._store.get("workers/wrk-mod");
  assert.equal(afterHide.rating, 5);
  assert.equal(afterHide.reviewCount, 1);
  assert.equal(afterHide.verifiedWorkCount, 1);
  assert.equal(afterHide.unverifiedCount, 0);

  // Admin restores it -> recalculates back to 3.0 (1 Verified Work, 1 Unverified)
  await adminModerateReview(db, { auth: { uid: "admin-1" }, data: { reviewId: uv.reviewId, status: "published", note: "Restored on appeal" } });
  const afterRestore = db._store.get("workers/wrk-mod");
  assert.equal(afterRestore.rating, 3);
  assert.equal(afterRestore.reviewCount, 2);
  assert.equal(afterRestore.verifiedWorkCount, 1);
  assert.equal(afterRestore.unverifiedCount, 1);
});

test("Audit #6: Worker account deletion tombstones workerVerification to Revoked and deletes /verifiedBadges/{uid}", async () => {
  const db = createMockDb({
    "users/wrk-del": { uid: "wrk-del", role: "worker", name: "Delete Pro", email: "dp@example.com" },
    "workers/wrk-del": { id: "wrk-del", name: "Delete Pro", isVerified: true, status: "active", workerVerification: { status: "Verified", internalNote: "Private note" } },
    "verifiedBadges/wrk-del": { uid: "wrk-del", role: "worker", badgeType: "verified_professional", verified: true }
  });

  await sanitizeUserData(db, "wrk-del");
  const tomb = db._store.get("workers/wrk-del");
  assert.equal(tomb.isVerified, false);
  assert.equal(tomb.status, "deleted");
  assert.equal(tomb.workerVerification.status, "Revoked");
  assert.equal(tomb.workerVerification.internalNote, "");
  assert.equal(db._store.has("verifiedBadges/wrk-del"), false);
  assert.equal(db._store.has("users/wrk-del"), false);
});
