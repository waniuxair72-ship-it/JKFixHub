/**
 * @file review-upgrade.test.js
 * @description Unit & integration tests for JKFixHub Premium Review & Rating System Upgrade:
 *   - Genuine rating aggregation & 5-star distribution (zero fake defaults)
 *   - Eligibility & suspended customer blocking
 *   - Duplicate & concurrent review prevention
 *   - Limited-time customer editing with append-only editHistory audit trail
 *   - Automatic worker rating recalculation on create, edit, hide, and restore
 */

const { describe, test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { MockFirestore } = require("./mock-firestore");

const {
  REVIEW_EXPERIENCE_TAGS,
  REVIEW_EDIT_WINDOW_MS,
  sanitizeReviewTags,
  calculateGenuineWorkerRating,
  submitReview,
  editReview
} = require("../review-logic");
const { adminModerateReview } = require("../admin-operations");

const ADMIN_UID = "admin-rev-1";
const CUST_A = "cust-rev-a";
const CUST_B = "cust-rev-b";
const CUST_SUSP = "cust-rev-susp";
const WORKER_1 = "worker-rev-1";

describe("JKFixHub Premium Review & Rating System — Backend Integrity", () => {
  let db;

  beforeEach(() => {
    db = new MockFirestore();
    db.seed("admins", ADMIN_UID, { uid: ADMIN_UID, role: "admin", active: true });
    db.seed("users", CUST_A, { uid: CUST_A, role: "customer", status: "active", name: "Aaqib" });
    db.seed("users", CUST_B, { uid: CUST_B, role: "customer", status: "active", name: "Bilal" });
    db.seed("users", CUST_SUSP, { uid: CUST_SUSP, role: "customer", status: "suspended", name: "Suspended User" });
    db.seed("workers", WORKER_1, {
      id: WORKER_1,
      name: "Tariq Electrician",
      service: "Electrician",
      district: "Srinagar",
      isVerified: true,
      status: "active",
      rating: null,
      reviewCount: 0
    });
  });

  test("1. Genuine rating calculation excludes hidden/flagged/deleted reviews, handles zero reviews, and rounds accurately", () => {
    const empty = calculateGenuineWorkerRating([]);
    assert.equal(empty.rating, null);
    assert.equal(empty.reviewCount, 0);
    assert.deepEqual(empty.distribution, { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 });

    const mixed = calculateGenuineWorkerRating([
      { id: "r1", requestId: "req1", rating: 5, status: "published" },
      { id: "r2", requestId: "req2", rating: 4, status: "published" },
      { id: "r3", requestId: "req3", rating: 4, status: "published" },
      { id: "r3-dup", requestId: "req3", rating: 1, status: "published" }, // Duplicate requestId ignored
      { id: "r4", requestId: "req4", rating: 1, status: "hidden" },       // Hidden excluded
      { id: "r5", requestId: "req5", rating: 2, status: "flagged" },      // Flagged excluded
      { id: "r6", requestId: "req6", rating: 5, status: "deleted" },      // Deleted excluded
      { id: "r7", requestId: "req7", rating: 4.5, status: "published" }   // Non-integer excluded
    ]);

    // (5 + 4 + 4) / 3 = 4.333... -> 4.3
    assert.equal(mixed.rating, 4.3);
    assert.equal(mixed.reviewCount, 3);
    assert.deepEqual(mixed.distribution, { 5: 1, 4: 2, 3: 0, 2: 0, 1: 0 });
  });

  test("2. Optional written comment + whitelisted experience tags work cleanly & recalculate worker rating", async () => {
    db.seed("requests", "req-comp-1", {
      id: "req-comp-1",
      customerId: CUST_A,
      customerName: "Aaqib",
      workerUid: WORKER_1,
      workerName: "Tariq Electrician",
      service: "Electrician",
      district: "Srinagar",
      status: "Completed"
    });

    const res = await submitReview(db, {
      auth: { uid: CUST_A },
      data: {
        requestId: "req-comp-1",
        rating: 5,
        text: "", // Optional comment allowed
        tags: ["Punctual", "Quality work", "Injected Fake Tag"]
      }
    });

    assert.equal(res.success, true);
    assert.equal(res.reviewId, "req-comp-1");
    assert.equal(res.ratingSummary.rating, 5);
    assert.equal(res.ratingSummary.reviewCount, 1);

    const savedReview = db.dump("reviews")["req-comp-1"];
    assert.deepEqual(savedReview.tags, ["Punctual", "Quality work"]);
    assert.equal(savedReview.verifiedService, true);
    assert.equal(savedReview.text, "");

    const worker = db.dump("workers")[WORKER_1];
    assert.equal(worker.rating, 5);
    assert.equal(worker.reviewCount, 1);
    assert.deepEqual(worker.ratingDistribution, { 5: 1, 4: 0, 3: 0, 2: 0, 1: 0 });
  });

  test("3. Suspended customer is rejected from submitting reviews", async () => {
    db.seed("requests", "req-susp-1", {
      id: "req-susp-1",
      customerId: CUST_SUSP,
      workerUid: WORKER_1,
      status: "Completed"
    });

    await assert.rejects(
      () => submitReview(db, {
        auth: { uid: CUST_SUSP },
        data: { requestId: "req-susp-1", rating: 4, text: "Nice work" }
      }),
      (err) => err.code === "permission-denied"
    );
  });

  test("4. Concurrent duplicate review submissions for one completed request allow only one review", async () => {
    db.seed("requests", "req-conc-1", {
      id: "req-conc-1",
      customerId: CUST_A,
      workerUid: WORKER_1,
      status: "Completed"
    });

    const results = await Promise.allSettled([
      submitReview(db, { auth: { uid: CUST_A }, data: { requestId: "req-conc-1", rating: 5, text: "First" } }),
      submitReview(db, { auth: { uid: CUST_A }, data: { requestId: "req-conc-1", rating: 2, text: "Duplicate" } })
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.code, "already-exists");
  });

  test("5. Limited-time customer editing preserves editHistory audit trail, recalculates worker rating, and rejects expired or unauthorized edits", async () => {
    db.seed("requests", "req-edit-1", {
      id: "req-edit-1",
      customerId: CUST_A,
      workerUid: WORKER_1,
      status: "Completed"
    });

    await submitReview(db, {
      auth: { uid: CUST_A },
      data: { requestId: "req-edit-1", rating: 3, text: "Initial review", tags: ["Punctual"] }
    });
    assert.equal(db.dump("workers")[WORKER_1].rating, 3);

    // Non-owner cannot edit
    await assert.rejects(
      () => editReview(db, {
        auth: { uid: CUST_B },
        data: { requestId: "req-edit-1", rating: 1, text: "Hijack attempt" }
      }),
      (err) => err.code === "permission-denied"
    );

    // Owner edits within 24h -> succeeds, records editHistory, recalculates worker rating to 5.0
    const edited = await editReview(db, {
      auth: { uid: CUST_A },
      data: { requestId: "req-edit-1", rating: 5, text: "Updated after follow-up!", tags: ["Punctual", "Professional"] }
    });
    assert.equal(edited.success, true);
    assert.equal(edited.ratingSummary.rating, 5);
    assert.equal(db.dump("workers")[WORKER_1].rating, 5);

    const revDoc = db.dump("reviews")["req-edit-1"];
    assert.equal(revDoc.editHistory.length, 1);
    assert.equal(revDoc.editHistory[0].previousRating, 3);
    assert.equal(revDoc.editHistory[0].previousText, "Initial review");

    // Simulate expired edit window (>24h ago) -> rejected
    db.seed("reviews", "req-edit-1", { ...revDoc, createdAtMs: Date.now() - REVIEW_EDIT_WINDOW_MS - 60000 });
    await assert.rejects(
      () => editReview(db, {
        auth: { uid: CUST_A },
        data: { requestId: "req-edit-1", rating: 4, text: "Too late edit" }
      }),
      (err) => err.code === "failed-precondition"
    );
  });

  test("6. Admin hiding and restoring a review preserves moderationHistory and recalculates worker rating accurately", async () => {
    db.seed("requests", "req-mod-a", { id: "req-mod-a", customerId: CUST_A, workerUid: WORKER_1, status: "Completed" });
    db.seed("requests", "req-mod-b", { id: "req-mod-b", customerId: CUST_B, workerUid: WORKER_1, status: "Completed" });

    await submitReview(db, { auth: { uid: CUST_A }, data: { requestId: "req-mod-a", rating: 5, text: "Great!" } });
    await submitReview(db, { auth: { uid: CUST_B }, data: { requestId: "req-mod-b", rating: 1, text: "Abusive spam" } });
    assert.equal(db.dump("workers")[WORKER_1].rating, 3);
    assert.equal(db.dump("workers")[WORKER_1].reviewCount, 2);

    // Admin hides the 1-star review -> worker rating updates to 5.0 (1 review)
    const hideRes = await adminModerateReview(db, {
      auth: { uid: ADMIN_UID },
      data: { reviewId: "req-mod-b", status: "hidden", note: "Confirmed abusive spam" }
    });
    assert.equal(hideRes.success, true);
    assert.equal(hideRes.ratingSummary.rating, 5);
    assert.equal(hideRes.ratingSummary.reviewCount, 1);
    assert.equal(db.dump("workers")[WORKER_1].rating, 5);
    assert.equal(db.dump("workers")[WORKER_1].reviewCount, 1);

    // Admin restores the review -> worker rating returns to 3.0 (2 reviews)
    const restoreRes = await adminModerateReview(db, {
      auth: { uid: ADMIN_UID },
      data: { reviewId: "req-mod-b", status: "published", note: "Restored on appeal" }
    });
    assert.equal(restoreRes.success, true);
    assert.equal(restoreRes.ratingSummary.rating, 3);
    assert.equal(restoreRes.ratingSummary.reviewCount, 2);
    assert.equal(db.dump("workers")[WORKER_1].rating, 3);
    assert.equal(db.dump("reviews")["req-mod-b"].moderationHistory.length, 2);
  });

  test("7. sanitizeReviewTags strictly enforces the 6 allowed experience tags", () => {
    assert.equal(REVIEW_EXPERIENCE_TAGS.length, 6);
    assert.deepEqual(
      sanitizeReviewTags(["punctual", "FAIR PRICING", "<script>", "punctual"]),
      ["Punctual", "Fair pricing"]
    );
  });
});
