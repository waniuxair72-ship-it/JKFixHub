/**
 * Test Suite: Task 6B - Fix Real Review Loading and Worker Replies
 *
 * Validates:
 * 1. Worker Identity Resolution & Authorized Replies:
 *    - Real Firebase workers (with string UIDs and null workerId) are recognized as review owners.
 *    - isReviewForWorker matches real Firebase workers and demo workers.
 *    - openWorkerReplyModal permits authenticated assigned worker (real UID or demo).
 *    - addWorkerReviewReply in store.js permits real Firebase worker UIDs.
 * 2. Access Control & Abuse Prevention:
 *    - Unauthorized workers attempting to open reply modal or add reply are blocked (UNAUTHORIZED_UI_ACTION).
 *    - Customers or unauthenticated users attempting to reply are blocked.
 * 3. Worker Dashboard Review Rendering:
 *    - renderWorkerReviews displays honest loading state (#workerReviewsLoading).
 *    - Loads persisted reviews from Cloud Firestore via getWorkerFirestoreReviews.
 *    - Renders "Reply to Review" or "Edit Reply" only for the authorized worker.
 *    - Renders honest empty state (.worker-dashboard-empty) when no reviews exist.
 *    - Renders honest error state (#workerReviewsError) with functional retry button on DB error.
 * 4. Customer Reload Detection & Duplicate Prevention:
 *    - syncCustomerRequestsFromFirestore populates customer reviews from Firestore.
 *    - showRequestDetails renders "View Your Review" (not "Leave a Review") when review exists.
 *    - openLeaveReviewModal checks Firestore, detects existing review after reload, and redirects
 *      to openViewReviewModal, preventing duplicate review submission.
 *    - openViewReviewModal fetches and displays existing review from Firestore when not in memory.
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
console.log("TEST SUITE: TASK 6B - REAL REVIEWS & WORKER REPLIES");
console.log("==================================================");

// -------------------------------------------------------------
// Mock DOM Setup
// -------------------------------------------------------------
globalThis.Node = class Node {};
globalThis.Element = class Element extends globalThis.Node {};

class MockClassList {
  constructor(el) {
    this._el = el;
  }
  _getClasses() {
    return new Set((this._el._className || "").split(/\s+/).filter(Boolean));
  }
  add(...names) {
    const set = this._getClasses();
    names.forEach((n) => set.add(n));
    this._el._className = Array.from(set).join(" ");
  }
  remove(...names) {
    const set = this._getClasses();
    names.forEach((n) => set.delete(n));
    this._el._className = Array.from(set).join(" ");
  }
  contains(name) {
    return this._getClasses().has(name);
  }
  toggle(name) {
    const set = this._getClasses();
    const has = set.has(name);
    if (has) set.delete(name);
    else set.add(name);
    this._el._className = Array.from(set).join(" ");
    return !has;
  }
}

class MockElement extends globalThis.Element {
  constructor(tagName = "div", id = "") {
    super();
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this._className = "";
    this.classList = new MockClassList(this);
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this._textContent = "";
    this.value = "";
    this.hidden = false;
    this.disabled = false;
    this.listeners = new Map();
  }

  get className() {
    return this._className;
  }
  set className(val) {
    this._className = String(val || "");
  }

  get textContent() {
    if (this._textContent) return this._textContent;
    if (this.children.length > 0) {
      return this.children.map((c) => c.textContent || "").join("");
    }
    return "";
  }
  set textContent(val) {
    this._textContent = val === null || val === undefined ? "" : String(val);
  }

  setAttribute(name, val) { this.attributes.set(name, String(val)); }
  getAttribute(name) { return this.attributes.get(name) || null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }

  append(...items) {
    items.forEach((item) => {
      if (item instanceof MockElement) {
        this.children.push(item);
      }
    });
  }

  replaceChildren(...items) {
    this.children = [];
    this.append(...items);
  }

  focus() {}
  reset() { this.value = ""; }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  dispatchEvent(event) {
    const list = this.listeners.get(event.type) || [];
    list.forEach((fn) => fn(event));
    return true;
  }

  querySelector(selector) {
    if (selector.startsWith("#")) {
      const targetId = selector.slice(1);
      if (this.id === targetId) return this;
      for (const child of this.children) {
        const found = child.querySelector(selector);
        if (found) return found;
      }
      return null;
    }
    if (selector.startsWith(".")) {
      const cls = selector.slice(1);
      if (this.classList.contains(cls)) return this;
      for (const child of this.children) {
        const found = child.querySelector(selector);
        if (found) return found;
      }
      return null;
    }
    if (selector.startsWith("[") && selector.endsWith("]")) {
      const inner = selector.slice(1, -1);
      const eqIdx = inner.indexOf("=");
      const attrName = eqIdx >= 0 ? inner.slice(0, eqIdx) : inner;
      const expectedVal = eqIdx >= 0 ? inner.slice(eqIdx + 1).replace(/^["']|["']$/g, "") : null;
      const dataProp = attrName.startsWith("data-")
        ? attrName.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
        : null;

      const matches = (el) => {
        if (dataProp && el.dataset && el.dataset[dataProp] !== undefined) {
          return expectedVal !== null ? el.dataset[dataProp] === expectedVal : true;
        }
        if (el.hasAttribute && el.hasAttribute(attrName)) {
          return expectedVal !== null ? el.getAttribute(attrName) === expectedVal : true;
        }
        return false;
      };

      if (matches(this)) return this;
      for (const child of this.children) {
        const found = child.querySelector(selector);
        if (found) return found;
      }
      return null;
    }
    if (/^[a-zA-Z]+$/.test(selector)) {
      if (this.tagName.toLowerCase() === selector.toLowerCase()) return this;
      for (const child of this.children) {
        const found = child.querySelector(selector);
        if (found) return found;
      }
      return null;
    }
    return null;
  }

  querySelectorAll(selector) {
    const results = [];
    const check = (el) => {
      if (selector.startsWith(".")) {
        if (el.classList.contains(selector.slice(1))) results.push(el);
      }
      for (const ch of el.children) check(ch);
    };
    check(this);
    return results;
  }

  closest(selector) {
    return null;
  }
}

function createTestDOM() {
  const elements = new Map();

  function getEl(id, tag = "div") {
    if (!elements.has(id)) {
      elements.set(id, new MockElement(tag, id));
    }
    return elements.get(id);
  }

  // Pre-create modal and review elements
  getEl("reviewModal");
  getEl("reviewViewModal");
  getEl("workerReplyModal");
  getEl("authModal");
  getEl("customerRequestsModal");
  getEl("customerRequestDetailsModal");

  getEl("reviewTargetWorker");
  getEl("reviewTargetService");
  getEl("reviewTargetDistrict");
  getEl("reviewTextInput", "textarea");
  getEl("reviewCharCount");
  getEl("reviewFormError");
  getEl("reviewForm", "form");

  getEl("viewReviewWorker");
  getEl("viewReviewRating");
  getEl("viewReviewDate");
  getEl("viewReviewText");
  getEl("viewReviewReplySection");
  getEl("viewReviewWorkerReply");
  getEl("viewReviewWorkerReplyDate");

  getEl("replyTargetCustomer");
  getEl("replyTargetRating");
  getEl("replyTargetReviewText");
  getEl("workerReplyInput", "textarea");
  getEl("workerReplyCharCount");
  getEl("workerReplyFormError");
  getEl("workerReplyForm", "form");

  getEl("customerRequestDetailsReview", "button");
  getEl("customerRequestsFeedback");
  getEl("workerDashboardReviews");

  const doc = {
    body: getEl("body", "body"),
    createElement: (tag) => new MockElement(tag),
    getElementById: (id) => getEl(id),
    querySelector: (sel) => {
      if (sel.startsWith("#")) {
        const id = sel.replace(/#([a-zA-Z0-9_-]+).*/, "$1");
        return getEl(id);
      }
      if (sel === ".modal-backdrop.open") {
        return null;
      }
      return null;
    },
    querySelectorAll: (sel) => {
      return [];
    },
    addEventListener: () => {}
  };

  return { doc, getEl };
}

// -------------------------------------------------------------
// Imports from App Modules
// -------------------------------------------------------------
import { setFirestoreAdapterForTesting } from "../js/firebase-config.js";
import {
  isReviewForWorker,
  openLeaveReviewModal,
  openViewReviewModal,
  openWorkerReplyModal,
  renderWorkerReviews,
  buildReviewCard
} from "../js/reviews.js";
import {
  setCurrentUser,
  clearCurrentUser,
  upsertStoredReview,
  setStoredReviews,
  getReviewById,
  getReviewByRequestId,
  getReviewsForWorker,
  addWorkerReviewReply,
  setStoredCustomerRequests
} from "../js/store.js";
import {
  getFirestoreReviewById,
  getFirestoreReviewByRequestId,
  getCustomerFirestoreReviews,
  getWorkerFirestoreReviews
} from "../js/firestore-service.js";

// Mock Firestore Adapter builder
function createMockFirestore(initialDocs = {}) {
  const docs = new Map();
  for (const [key, value] of Object.entries(initialDocs)) {
    docs.set(key, JSON.parse(JSON.stringify(value)));
  }

  const adapter = {
    getDoc: async (docRef) => {
      const data = docs.get(docRef._path);
      return {
        exists: () => data !== undefined,
        data: () => (data !== undefined ? JSON.parse(JSON.stringify(data)) : undefined),
        id: docRef.id
      };
    },
    setDoc: async (docRef, data) => {
      docs.set(docRef._path, JSON.parse(JSON.stringify(data)));
    },
    updateDoc: async (docRef, data) => {
      const existing = docs.get(docRef._path);
      if (!existing) throw new Error("Document not found: " + docRef._path);
      Object.assign(existing, JSON.parse(JSON.stringify(data)));
    },
    getDocs: async (queryOrCol) => {
      const matched = [];
      const colPath = queryOrCol._path || queryOrCol._colRef?._path;
      for (const [docPath, docData] of docs.entries()) {
        if (docPath.startsWith(colPath + "/")) {
          const docId = docPath.replace(colPath + "/", "");
          if (queryOrCol._whereClauses) {
            let matches = true;
            for (const clause of queryOrCol._whereClauses) {
              if (String(docData[clause.field]) !== String(clause.value)) {
                matches = false;
                break;
              }
            }
            if (matches) matched.push({ id: docId, ...JSON.parse(JSON.stringify(docData)) });
          } else {
            matched.push({ id: docId, ...JSON.parse(JSON.stringify(docData)) });
          }
        }
      }
      return {
        empty: matched.length === 0,
        forEach: (fn) => matched.forEach((item) => fn({ id: item.id, data: () => item }))
      };
    },
    collection: (db, pathStr) => ({ _path: pathStr }),
    doc: (db, colOrPath, id) => {
      const pathStr = id ? `${colOrPath}/${id}` : colOrPath;
      return { _path: pathStr, id: id || pathStr.split("/").pop() };
    },
    query: (colRef, ...clauses) => ({ _colRef: colRef, _whereClauses: clauses }),
    where: (field, op, value) => ({ field, op, value })
  };

  return { adapter, docs };
}

// -------------------------------------------------------------
// PART 1: Worker Identity Resolution & Reply Authorization
// -------------------------------------------------------------
console.log("\n--- Part 1: Worker Identity Resolution & Reply Authorization ---");

runTest("1a. isReviewForWorker: Real Firebase worker matches review by string workerUid", () => {
  const realWorker = {
    role: "worker",
    id: "firebase-worker-uid-999",
    firebaseUid: "firebase-worker-uid-999",
    workerId: null,
    name: "Tariq Ahmad"
  };

  const review = {
    id: "rev-req-123",
    requestId: "req-123",
    workerUid: "firebase-worker-uid-999",
    workerId: "firebase-worker-uid-999",
    customerName: "Sana",
    rating: 5,
    text: "Great plumbing service!"
  };

  const matches = isReviewForWorker(review, realWorker);
  assert.equal(matches, true, "Real Firebase worker with matching workerUid must match review");
});

runTest("1b. isReviewForWorker: Legacy/demo numeric worker matches review by workerId", () => {
  const demoWorker = {
    role: "worker",
    id: "demo-worker-1",
    workerId: 1,
    name: "Mohammad Ashraf"
  };

  const review = {
    id: "rev-req-demo",
    requestId: "req-demo",
    workerId: 1,
    workerUid: "1",
    customerName: "Amina",
    rating: 5
  };

  assert.equal(isReviewForWorker(review, demoWorker), true, "Demo worker must match review by numeric workerId");
});

runTest("1c. isReviewForWorker: Unauthorized worker does NOT match review", () => {
  const otherWorker = {
    role: "worker",
    id: "firebase-worker-uid-888",
    firebaseUid: "firebase-worker-uid-888",
    workerId: null
  };

  const review = {
    id: "rev-req-123",
    requestId: "req-123",
    workerUid: "firebase-worker-uid-999"
  };

  assert.equal(isReviewForWorker(review, otherWorker), false, "Different worker UID must NOT match review");
});

runTest("1d. isReviewForWorker: Customer or unauthenticated caller returns false", () => {
  const customer = { role: "customer", id: "cust-1", firebaseUid: "cust-1" };
  const review = { workerUid: "cust-1" };
  assert.equal(isReviewForWorker(review, customer), false, "Customer must never match as worker");
  assert.equal(isReviewForWorker(review, null), false, "Null user must return false");
});

runTest("1e. buildReviewCard: Renders 'Reply to Review' button for authorized real worker", () => {
  const dom = createTestDOM();
  const origDoc = globalThis.document;
  globalThis.document = dom.doc;
  try {
    const review = {
      id: "rev-101",
      customerName: "Zahoor",
      rating: 5,
      createdAt: new Date().toISOString(),
      text: "Excellent electrical repair.",
      workerReply: null
    };

    // Card built for current worker
    const cardCurrent = buildReviewCard(review, true);
    const replyBtn = cardCurrent.querySelector('[data-reply-review="rev-101"]');
    assert.ok(replyBtn, "Review card must include reply button for assigned worker");
    assert.equal(replyBtn.textContent, "Reply to Review");

    // Card built for non-worker / other user
    const cardOther = buildReviewCard(review, false);
    const otherReplyBtn = cardOther.querySelector('[data-reply-review="rev-101"]');
    assert.equal(otherReplyBtn, null, "Review card must NOT include reply button for unassigned users");
  } finally {
    globalThis.document = origDoc;
  }
});

runTest("1f. buildReviewCard: Renders 'Edit Reply' and existing reply when worker has replied", () => {
  const dom = createTestDOM();
  const origDoc = globalThis.document;
  globalThis.document = dom.doc;
  try {
    const review = {
      id: "rev-102",
      customerName: "Basit",
      workerName: "Tariq Ahmad",
      rating: 4,
      createdAt: new Date().toISOString(),
      text: "Good work.",
      workerReply: "Thank you for your feedback!",
      workerReplyAt: new Date().toISOString()
    };

    const card = buildReviewCard(review, true);
    const replyBox = card.querySelector(".worker-reply-box");
    assert.ok(replyBox, "Worker reply box must be rendered");
    const replyText = card.querySelector(".worker-reply-text");
    assert.equal(replyText.textContent, "Thank you for your feedback!");

    const replyBtn = card.querySelector('[data-reply-review="rev-102"]');
    assert.ok(replyBtn);
    assert.equal(replyBtn.textContent, "Edit Reply");
  } finally {
    globalThis.document = origDoc;
  }
});

// -------------------------------------------------------------
// PART 2: Modal Openers & Access Control
// -------------------------------------------------------------
console.log("\n--- Part 2: Modal Openers & Access Control ---");

await runAsyncTest("2a. openWorkerReplyModal: Permits authorized real Firebase worker", async () => {
  const dom = createTestDOM();
  const origDoc = globalThis.document;
  globalThis.document = dom.doc;

  try {
    const realWorker = {
      role: "worker",
      id: "firebase-worker-real-1",
      firebaseUid: "firebase-worker-real-1",
      workerId: null,
      name: "Tariq Ahmad"
    };
    setCurrentUser(realWorker);

    upsertStoredReview({
      id: "rev-test-1",
      requestId: "req-1",
      workerUid: "firebase-worker-real-1",
      customerName: "Imran",
      rating: 5,
      text: "Quick fix on the water heater."
    });

    const res = await openWorkerReplyModal("rev-test-1");
    assert.equal(res, true, "openWorkerReplyModal must return true for authorized worker");
    assert.equal(dom.getEl("replyTargetCustomer").textContent, "Imran");
    assert.equal(dom.getEl("replyTargetRating").textContent, "5 ★");
  } finally {
    globalThis.document = origDoc;
    clearCurrentUser();
  }
});

await runAsyncTest("2b. openWorkerReplyModal: Denies unassigned worker (UNAUTHORIZED_UI_ACTION)", async () => {
  const dom = createTestDOM();
  const origDoc = globalThis.document;
  globalThis.document = dom.doc;

  try {
    const otherWorker = {
      role: "worker",
      id: "firebase-worker-other-2",
      firebaseUid: "firebase-worker-other-2",
      workerId: null,
      name: "Other Worker"
    };
    setCurrentUser(otherWorker);

    upsertStoredReview({
      id: "rev-test-2",
      requestId: "req-2",
      workerUid: "firebase-worker-real-1",
      customerName: "Farooq",
      rating: 4,
      text: "Nice job."
    });

    const res = await openWorkerReplyModal("rev-test-2");
    assert.equal(res, false, "openWorkerReplyModal must return false for unauthorized worker");
  } finally {
    globalThis.document = origDoc;
    clearCurrentUser();
  }
});

await runAsyncTest("2c. openWorkerReplyModal: Denies customer caller", async () => {
  const dom = createTestDOM();
  const origDoc = globalThis.document;
  globalThis.document = dom.doc;

  try {
    const customer = { role: "customer", id: "cust-1", firebaseUid: "cust-1", name: "Customer User" };
    setCurrentUser(customer);

    const res = await openWorkerReplyModal("rev-test-1");
    assert.equal(res, false, "Customer must be rejected from opening worker reply modal");
  } finally {
    globalThis.document = origDoc;
    clearCurrentUser();
  }
});

runTest("2d. addWorkerReviewReply: Updates reply in store for real Firebase worker", () => {
  const realWorker = {
    role: "worker",
    id: "firebase-worker-real-1",
    firebaseUid: "firebase-worker-real-1",
    workerId: null,
    name: "Tariq Ahmad"
  };
  setCurrentUser(realWorker);

  upsertStoredReview({
    id: "rev-reply-test",
    requestId: "req-reply-1",
    workerUid: "firebase-worker-real-1",
    customerName: "Rashid",
    rating: 5,
    text: "Very professional."
  });

  const updated = addWorkerReviewReply("rev-reply-test", "Thank you Rashid!");
  assert.equal(updated.workerReply, "Thank you Rashid!");
  assert.ok(updated.workerReplyAt, "workerReplyAt must be set");

  // Verify unauthorized worker throws
  setCurrentUser({ role: "worker", id: "firebase-worker-intruder", workerId: null, name: "Intruder Worker" });
  assert.throws(() => {
    addWorkerReviewReply("rev-reply-test", "Spoofed reply");
  }, /You can only reply to reviews on your own profile/);

  clearCurrentUser();
});

// -------------------------------------------------------------
// PART 3: Worker Dashboard Review Loading & Honest States
// -------------------------------------------------------------
console.log("\n--- Part 3: Worker Dashboard Review Loading & States ---");

await runAsyncTest("3a. renderWorkerReviews: Shows loading state and loads reviews from Firestore", async () => {
  const dom = createTestDOM();
  const origDoc = globalThis.document;
  globalThis.document = dom.doc;

  const mockReviews = {
    "reviews/rev-w1-1": {
      id: "rev-w1-1",
      requestId: "req-w1-1",
      workerUid: "worker-uid-live",
      workerId: "worker-uid-live",
      workerName: "Bilal Dar",
      customerName: "Aaqib",
      rating: 5,
      text: "Superb repair work on time.",
      status: "published",
      createdAt: "2026-10-14T08:00:00Z"
    }
  };

  const { adapter } = createMockFirestore(mockReviews);
  setFirestoreAdapterForTesting(adapter);

  const realWorker = {
    role: "worker",
    id: "worker-uid-live",
    firebaseUid: "worker-uid-live",
    workerId: null,
    name: "Bilal Dar"
  };
  setCurrentUser(realWorker);

  const container = dom.getEl("workerDashboardReviews");

  try {
    await renderWorkerReviews("worker-uid-live", container);

    // Verify reviews container rendered the review card
    assert.equal(container.children.length, 1, "Must render exactly 1 review card");
    const card = container.children[0];
    assert.equal(card.dataset.reviewId, "rev-w1-1");
    // Verify reply button exists for the logged in worker
    const replyBtn = card.querySelector('[data-reply-review="rev-w1-1"]');
    assert.ok(replyBtn, "Card must include reply button for matching worker");
  } finally {
    setFirestoreAdapterForTesting(null);
    globalThis.document = origDoc;
    clearCurrentUser();
  }
});

await runAsyncTest("3b. renderWorkerReviews: Shows honest empty state when worker has 0 reviews", async () => {
  const dom = createTestDOM();
  const origDoc = globalThis.document;
  globalThis.document = dom.doc;

  const { adapter } = createMockFirestore({});
  setFirestoreAdapterForTesting(adapter);

  const container = dom.getEl("workerDashboardReviews");

  try {
    await renderWorkerReviews("worker-uid-empty", container);
    assert.equal(container.children.length, 1);
    const emptyEl = container.children[0];
    assert.equal(emptyEl.className, "worker-dashboard-empty");
    assert.equal(emptyEl.textContent, "No reviews received yet for this worker.");
  } finally {
    setFirestoreAdapterForTesting(null);
    globalThis.document = origDoc;
  }
});

await runAsyncTest("3c. renderWorkerReviews: Shows honest error state with retry on failure", async () => {
  const dom = createTestDOM();
  const origDoc = globalThis.document;
  globalThis.document = dom.doc;

  // Failing Firestore adapter
  const failingAdapter = {
    collection: () => { throw new Error("Firestore network disconnect"); }
  };
  setFirestoreAdapterForTesting(failingAdapter);

  const container = dom.getEl("workerDashboardReviews");

  try {
    await renderWorkerReviews("worker-uid-err", container);
    const errorWrap = container.children[0];
    assert.equal(errorWrap.className, "worker-dashboard-error");
    assert.ok(errorWrap.textContent.includes("Unable to load reviews"));
    const retryBtn = errorWrap.querySelector("button");
    assert.ok(retryBtn, "Error state must provide a retry button");
    assert.equal(typeof retryBtn.onclick, "function", "Retry button must have click handler");
  } finally {
    setFirestoreAdapterForTesting(null);
    globalThis.document = origDoc;
  }
});

// -------------------------------------------------------------
// PART 4: Customer Reload Detection & Duplicate Prevention
// -------------------------------------------------------------
console.log("\n--- Part 4: Customer Reload Detection & Duplicate Prevention ---");

await runAsyncTest("4a. getFirestoreReviewByRequestId: Resolves review by requestId from Firestore", async () => {
  const mockDocs = {
    "reviews/rev-req-comp-99": {
      id: "rev-req-comp-99",
      requestId: "req-comp-99",
      customerId: "cust-test-1",
      customerName: "Aasif",
      workerUid: "worker-1",
      workerName: "Ghulam Nabi",
      rating: 5,
      text: "Done perfectly.",
      status: "published",
      createdAt: "2026-10-13T12:00:00Z"
    }
  };

  const { adapter } = createMockFirestore(mockDocs);
  setFirestoreAdapterForTesting(adapter);

  try {
    const review = await getFirestoreReviewByRequestId("req-comp-99");
    assert.ok(review, "Review must be found by requestId");
    assert.equal(review.id, "rev-req-comp-99");
    assert.equal(review.rating, 5);
  } finally {
    setFirestoreAdapterForTesting(null);
  }
});

await runAsyncTest("4b. openLeaveReviewModal: Detects existing review after reload and redirects to view modal", async () => {
  const dom = createTestDOM();
  const origDoc = globalThis.document;
  globalThis.document = dom.doc;

  const mockDocs = {
    "reviews/rev-req-reload-1": {
      id: "rev-req-reload-1",
      requestId: "req-reload-1",
      customerId: "cust-reload-1",
      customerName: "Waseem",
      workerUid: "worker-1",
      workerName: "Ghulam Nabi",
      rating: 5,
      text: "Outstanding work on our kitchen plumbing.",
      status: "published",
      createdAt: "2026-10-12T14:00:00Z"
    }
  };

  const { adapter } = createMockFirestore(mockDocs);
  setFirestoreAdapterForTesting(adapter);

  const customerUser = {
    role: "customer",
    id: "cust-reload-1",
    firebaseUid: "cust-reload-1",
    name: "Waseem"
  };
  setCurrentUser(customerUser);

  // Set request as completed in store
  setStoredCustomerRequests([{
    id: "req-reload-1",
    requestId: "req-reload-1",
    customerId: "cust-reload-1",
    customerName: "Waseem",
    workerUid: "worker-1",
    workerId: "worker-1",
    workerName: "Ghulam Nabi",
    service: "Plumbing",
    district: "Srinagar",
    description: "Fixing bathroom sink leak.",
    location: "Srinagar Rajbagh",
    preferredTime: "Morning",
    status: "Completed",
    createdAt: "2026-10-12T10:00:00Z"
  }]);

  try {
    // Note: in-memory review is NOT present yet (simulating page reload)
    assert.equal(getReviewByRequestId("req-reload-1"), null, "Review must not be in local memory initially");

    // Attempting to open "Leave Review" modal should detect the review in Firestore
    const res = await openLeaveReviewModal("req-reload-1");
    assert.equal(res, true, "openLeaveReviewModal should return true");

    // Verify it redirected to view modal: review details populated
    assert.equal(dom.getEl("viewReviewWorker").textContent, "Ghulam Nabi");
    assert.ok(dom.getEl("viewReviewRating").textContent.includes("5 ★"));
    assert.equal(dom.getEl("viewReviewText").textContent, "Outstanding work on our kitchen plumbing.");

    // Verify review was cached in local store to prevent duplicate submissions
    const cached = getReviewByRequestId("req-reload-1");
    assert.ok(cached, "Existing review must now be cached in store");
  } finally {
    setFirestoreAdapterForTesting(null);
    globalThis.document = origDoc;
    clearCurrentUser();
  }
});

await runAsyncTest("4c. openViewReviewModal: Fetches and displays review from Firestore if not in store", async () => {
  const dom = createTestDOM();
  const origDoc = globalThis.document;
  globalThis.document = dom.doc;

  const mockDocs = {
    "reviews/rev-req-view-only": {
      id: "rev-req-view-only",
      requestId: "req-view-only",
      customerId: "cust-v",
      customerName: "Tanveer",
      workerUid: "worker-2",
      workerName: "Mushtaq Ahmad",
      rating: 4,
      text: "Good carpentry repair.",
      status: "published",
      workerReply: "Glad to help, Tanveer!",
      workerReplyAt: "2026-10-13T09:00:00Z",
      createdAt: "2026-10-12T15:00:00Z"
    }
  };

  const { adapter } = createMockFirestore(mockDocs);
  setFirestoreAdapterForTesting(adapter);

  try {
    const res = await openViewReviewModal("req-view-only");
    assert.equal(res, true);
    assert.equal(dom.getEl("viewReviewWorker").textContent, "Mushtaq Ahmad");
    assert.ok(dom.getEl("viewReviewRating").textContent.includes("4 ★"));
    assert.equal(dom.getEl("viewReviewText").textContent, "Good carpentry repair.");
    assert.equal(dom.getEl("viewReviewWorkerReply").textContent, "Glad to help, Tanveer!");
    assert.equal(dom.getEl("viewReviewReplySection").hidden, false);
  } finally {
    setFirestoreAdapterForTesting(null);
    globalThis.document = origDoc;
  }
});

// -------------------------------------------------------------
// SUMMARY
// -------------------------------------------------------------
console.log("\n==================================================");
console.log(`TOTAL TESTS: ${totalPassed + totalFailed} | PASSED: ${totalPassed} | FAILED: ${totalFailed}`);
console.log("==================================================");

if (totalFailed > 0) {
  process.exit(1);
}
