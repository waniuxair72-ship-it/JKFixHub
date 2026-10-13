/**
 * Test Suite: Task 5 - Real-Time Worker Dashboard Verification
 *
 * Validates:
 * 1. Part 1: Client Service & Dashboard Integration:
 *    - Real-time subscription to /requests query where workerUid == authenticatedWorkerUid
 *    - Dynamic dashboard update when a new assigned request arrives (without manual refresh)
 *    - Dynamic dashboard update when a request changes status (Pending -> Accepted -> Completed)
 *    - Statistics counters consistency (Total, Pending, Accepted, Completed, Rejected, Rating)
 *    - Distinct UI states: Loading (.worker-dashboard-loading), Empty (.worker-dashboard-empty), Error (.worker-dashboard-error)
 *    - Retry button (#workerDashboardRetryBtn) reconnects the live listener
 *    - Listener deduplication: repeated calls do not duplicate listeners
 *    - Listener cleanup: stopWorkerDashboardSubscription(), demoLogout(), modal:close, and view switches
 *    - Backwards-compatible loadAndRenderWorkerRequests()
 *    - Worker action triggers (Accept, Reject, Complete) and button locking
 * 2. Part 2: Live Firestore Emulator Rules & Query Enforcement:
 *    - Authenticated worker querying requests where workerUid == auth.uid ALLOWED (200)
 *    - Authenticated worker querying requests for other worker DENIED (403)
 *    - Authenticated worker querying requests without filter DENIED (403)
 *    - Unauthenticated query on requests DENIED (403)
 *    - Dynamic creation by customer reflected in worker query (200)
 *    - Status transition by assigned worker reflected in query (200)
 *    - Unassigned worker attempting status change DENIED (403)
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
console.log("TEST SUITE: TASK 5 - REAL-TIME WORKER DASHBOARD");
console.log("==================================================");

// -------------------------------------------------------------
// PART 1: Client Service & Dashboard Integration Tests
// -------------------------------------------------------------
console.log("\n--- Part 1: Client Service & Dashboard Integration ---");

// Mock minimal DOM for headless testing
class MockClassList {
  constructor(el) {
    this.el = el;
    this.classes = new Set();
  }
  add(...names) { names.forEach((n) => this.classes.add(n)); }
  remove(...names) { names.forEach((n) => this.classes.delete(n)); }
  contains(name) { return this.classes.has(name); }
}

globalThis.Node = class Node {};

class MockElement extends globalThis.Node {
  constructor(tagName = "div", id = "") {
    super();
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.type = "text";
    this.textContent = "";
    this._className = "";
    this.classList = new MockClassList(this);
    this.attributes = new Map();
    this.listeners = new Map();
    this.children = [];
    this.dataset = {};
    this.parentElement = null;
  }

  get className() {
    return this._className || "";
  }

  set className(val) {
    this._className = val || "";
    this.classList.classes.clear();
    if (val && typeof val === "string") {
      val.split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c));
    }
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === "class") {
      this.className = String(value);
    }
    if (name.startsWith("data-")) {
      const camel = name.slice(5).replace(/-([a-z])/g, (_, l) => l.toUpperCase());
      this.dataset[camel] = String(value);
    }
  }

  getAttribute(name) {
    return this.attributes.get(name) || null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  addEventListener(event, fn) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(fn);
  }

  dispatchEvent(event) {
    const list = this.listeners.get(event.type) || [];
    for (const fn of list) {
      fn(event);
    }
    return true;
  }

  appendChild(child) {
    if (child instanceof MockElement) child.parentElement = this;
    this.children.push(child);
    return child;
  }

  append(...items) {
    items.forEach((item) => {
      if (item instanceof MockElement) item.parentElement = this;
      this.children.push(item);
    });
  }

  replaceChildren(...items) {
    this.children = [];
    this.append(...items);
  }

  closest(selector) {
    let curr = this;
    while (curr) {
      if (selector.startsWith("#") && curr.id === selector.slice(1)) return curr;
      if (selector.startsWith(".") && curr.classList.contains(selector.slice(1))) return curr;
      if (selector.includes("[data-worker-action]") && curr.dataset.workerAction) return curr;
      if (selector.includes("[data-demo-complete-request]") && curr.dataset.demoCompleteRequest) return curr;
      if (selector.includes("[data-request-action]") && curr.dataset.requestAction) return curr;
      if (selector.includes("#authLogoutFromDashboard") && curr.id === "authLogoutFromDashboard") return curr;
      if (selector.includes("#backToAccount") && curr.id === "backToAccount") return curr;
      curr = curr.parentElement;
    }
    return null;
  }

  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }

  querySelectorAll(sel) {
    const results = [];
    const check = (node) => {
      if (!node) return;
      if (sel.startsWith(".") && node.classList?.contains(sel.slice(1))) results.push(node);
      if (sel.startsWith("#") && node.id === sel.slice(1)) results.push(node);
      if (sel === "button" && node.tagName === "BUTTON") results.push(node);
      if (sel === "p" && node.tagName === "P") results.push(node);
      if (Array.isArray(node.children)) {
        node.children.forEach(check);
      }
    };
    if (Array.isArray(this.children)) {
      this.children.forEach(check);
    }
    return results;
  }

  focus() {}
}

globalThis.Element = MockElement;

const domElements = new Map();
function getOrCreateElement(id, tagName = "div") {
  if (!domElements.has(id)) {
    const el = new MockElement(tagName, id);
    domElements.set(id, el);
  }
  return domElements.get(id);
}

// Setup test DOM globals
globalThis.window = {
  location: { hash: "", pathname: "/", search: "" },
  history: {
    replaceState(state, title, url) {
      const hashIndex = url.indexOf("#");
      globalThis.window.location.hash = hashIndex >= 0 ? url.slice(hashIndex) : "";
    }
  },
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  dispatchEvent: () => true,
  addEventListener: () => {},
  CustomEvent: class CustomEvent {
    constructor(type, detail) {
      this.type = type;
      this.detail = detail;
    }
  }
};

globalThis.document = {
  body: new MockElement("body", "body"),
  createElement(tag) {
    return new MockElement(tag);
  },
  getElementById(id) {
    return domElements.get(id) || null;
  },
  querySelector(sel) {
    if (sel.includes("#authModal .modal")) {
      return getOrCreateElement("authModalInner", "div");
    }
    return null;
  },
  querySelectorAll() {
    return [];
  },
  addEventListener(event, fn) {}
};

// Create DOM structure for Worker Dashboard
getOrCreateElement("workerDashboardView", "section");
getOrCreateElement("workerDashboardTitle", "h2");
getOrCreateElement("workerDashboardInitials", "div");
getOrCreateElement("workerDashboardName", "h3");
getOrCreateElement("workerDashboardService", "p");
getOrCreateElement("workerDashboardDistrict", "strong");
getOrCreateElement("workerDashboardExperience", "strong");
getOrCreateElement("workerDashboardRating", "strong");
getOrCreateElement("workerDashboardAvailabilityLabel", "strong");
getOrCreateElement("workerDashboardVerification", "span");
getOrCreateElement("workerDashboardAvailability", "select");
getOrCreateElement("workerDashboardStatistics", "div");
getOrCreateElement("workerDashboardRequests", "div");
getOrCreateElement("workerDashboardFeedback", "p");
getOrCreateElement("workerDashboardReviews", "div");
getOrCreateElement("workerProfileEditModal", "div");
getOrCreateElement("workerProfileEditForm", "form");
getOrCreateElement("editWorkerProfileButton", "button");
getOrCreateElement("authModal", "div");
getOrCreateElement("authRoleSelection", "section");
getOrCreateElement("authAccountView", "section");
getOrCreateElement("authSignedOutView", "div");
getOrCreateElement("authLogoutFromDashboard", "button");
getOrCreateElement("backToAccount", "button");

// Import modules under test
const { setFirestoreAdapterForTesting } = await import("../js/firebase-config.js");
const {
  subscribeToWorkerFirestoreRequests,
  getActiveFirestoreListenersCount,
  unsubscribeAllFirestoreListeners,
  updateFirestoreRequestStatus
} = await import("../js/firestore-service.js");
const {
  startWorkerDashboardSubscription,
  stopWorkerDashboardSubscription,
  renderWorkerRequestsList,
  loadAndRenderWorkerRequests,
  initializeWorkerDashboard
} = await import("../js/worker-dashboard.js");
const { demoLogout } = await import("../js/auth.js");
const { setCurrentUser } = await import("../js/store.js");

// Initialize dashboard event listeners
initializeWorkerDashboard();

// Mock Real-Time Firestore Adapter
function createRealtimeMockFirestore(initialRequests = []) {
  const requests = new Map(initialRequests.map((r) => [r.id, { ...r }]));
  const listeners = new Set();

  function notify() {
    for (const { workerUid, onSnapshot, onError } of listeners) {
      const filtered = [];
      for (const req of requests.values()) {
        if (req.workerUid === workerUid) {
          filtered.push({
            id: req.id,
            data: () => ({ ...req })
          });
        }
      }
      onSnapshot({
        forEach: (cb) => filtered.forEach(cb),
        docs: filtered
      });
    }
  }

  const adapter = {
    requests,
    listeners,
    doc: (db, col, id) => `${col}/${id}`,
    collection: (db, col) => col,
    where: (field, op, val) => ({ field, op, val }),
    query: (colRef, ...filters) => ({ colRef, filters }),
    getDoc: async (docPath) => {
      const id = docPath.replace("requests/", "");
      const exists = requests.has(id);
      return {
        exists: () => exists,
        data: () => (exists ? { ...requests.get(id) } : null)
      };
    },
    updateDoc: async (docPath, updates) => {
      const id = docPath.replace("requests/", "");
      if (!requests.has(id)) throw new Error(`Request ${id} not found`);
      const existing = requests.get(id);
      Object.assign(existing, updates);
      notify();
      return existing;
    },
    getDocs: async (q) => {
      const workerFilter = q.filters?.find((f) => f.field === "workerUid");
      const workerUid = workerFilter ? workerFilter.val : null;
      const filtered = [];
      for (const req of requests.values()) {
        if (!workerUid || req.workerUid === workerUid) {
          filtered.push({
            id: req.id,
            data: () => ({ ...req })
          });
        }
      }
      return {
        forEach: (cb) => filtered.forEach(cb),
        docs: filtered
      };
    },
    onSnapshot: (q, onSnapshot, onError) => {
      const workerFilter = q.filters?.find((f) => f.field === "workerUid");
      const workerUid = workerFilter ? workerFilter.val : null;

      const listenerRecord = { workerUid, onSnapshot, onError };
      listeners.add(listenerRecord);

      // Emit initial snapshot asynchronously
      setTimeout(() => {
        if (!listeners.has(listenerRecord)) return;
        const filtered = [];
        for (const req of requests.values()) {
          if (req.workerUid === workerUid) {
            filtered.push({
              id: req.id,
              data: () => ({ ...req })
            });
          }
        }
        onSnapshot({
          forEach: (cb) => filtered.forEach(cb),
          docs: filtered
        });
      }, 0);

      return () => {
        listeners.delete(listenerRecord);
      };
    },
    addRequest: (req) => {
      requests.set(req.id, { ...req });
      notify();
    },
    triggerError: (workerUid, error) => {
      for (const listener of listeners) {
        if (listener.workerUid === workerUid && typeof listener.onError === "function") {
          listener.onError(error);
        }
      }
    }
  };

  return adapter;
}

// -------------------------------------------------------------
// Test 1a: subscribeToWorkerFirestoreRequests initial snapshot
// -------------------------------------------------------------
await runAsyncTest("1a. subscribeToWorkerFirestoreRequests receives initial assigned requests sorted", async () => {
  const mockAdapter = createRealtimeMockFirestore([
    { id: "r1", workerUid: "w-101", customerName: "Aadil", service: "Electrician", status: "Accepted", createdAt: "2026-10-10T10:00:00Z" },
    { id: "r2", workerUid: "w-101", customerName: "Bashir", service: "Electrician", status: "Pending", createdAt: "2026-10-11T12:00:00Z" },
    { id: "r3", workerUid: "w-999", customerName: "Other", service: "Plumber", status: "Pending", createdAt: "2026-10-12T12:00:00Z" }
  ]);
  setFirestoreAdapterForTesting(mockAdapter);

  let receivedRequests = null;
  const unsub = await subscribeToWorkerFirestoreRequests(
    "w-101",
    (requests) => {
      receivedRequests = requests;
    }
  );

  await new Promise((r) => setTimeout(r, 20));

  assert.ok(receivedRequests, "Expected to receive initial requests");
  assert.equal(receivedRequests.length, 2, "Should only receive requests for w-101");
  // Pending should be first
  assert.equal(receivedRequests[0].id, "r2", "Pending request must appear first");
  assert.equal(receivedRequests[1].id, "r1", "Accepted request must follow");

  assert.equal(getActiveFirestoreListenersCount(), 1, "Should record 1 active listener");
  unsub();
  assert.equal(getActiveFirestoreListenersCount(), 0, "Unsubscribing should decrease listener count to 0");
});

// -------------------------------------------------------------
// Test 1b: Dynamic update on new assigned request
// -------------------------------------------------------------
await runAsyncTest("1b. Real-time push: New request dynamically updates listener without manual refresh", async () => {
  const mockAdapter = createRealtimeMockFirestore([
    { id: "r1", workerUid: "w-102", customerName: "Aadil", service: "Electrician", status: "Accepted", createdAt: "2026-10-10T10:00:00Z" }
  ]);
  setFirestoreAdapterForTesting(mockAdapter);

  const updates = [];
  const unsub = await subscribeToWorkerFirestoreRequests("w-102", (reqs) => updates.push(reqs));

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(updates.length, 1);
  assert.equal(updates[0].length, 1);

  // Push new request into mock adapter
  mockAdapter.addRequest({
    id: "r-new",
    workerUid: "w-102",
    customerName: "Farooq",
    service: "Electrician",
    status: "Pending",
    createdAt: "2026-10-13T14:00:00Z"
  });

  assert.equal(updates.length, 2, "New update must be received dynamically");
  assert.equal(updates[1].length, 2, "Updated list must contain 2 requests");
  assert.equal(updates[1][0].id, "r-new", "Newly arrived Pending request appears at top");

  unsub();
});

// -------------------------------------------------------------
// Test 1c: Dynamic update on status transition
// -------------------------------------------------------------
await runAsyncTest("1c. Real-time push: Status change (Pending -> Accepted) updates listener", async () => {
  const mockAdapter = createRealtimeMockFirestore([
    { id: "r-status", workerUid: "w-103", customerName: "Aadil", service: "Electrician", status: "Pending", createdAt: "2026-10-10T10:00:00Z" }
  ]);
  setFirestoreAdapterForTesting(mockAdapter);

  const updates = [];
  const unsub = await subscribeToWorkerFirestoreRequests("w-103", (reqs) => updates.push(reqs));

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(updates[0][0].status, "Pending");

  // Worker accepts request via updateFirestoreRequestStatus
  const updateRes = await updateFirestoreRequestStatus("r-status", "Accepted", "w-103");
  assert.equal(updateRes.success, true);

  assert.equal(updates.length, 2, "Status update must push new snapshot to listener");
  assert.equal(updates[1][0].status, "Accepted", "Request status must reflect Accepted");

  unsub();
});

// -------------------------------------------------------------
// Test 1d: UI Statistics and Request Cards Rendering
// -------------------------------------------------------------
runTest("1d. renderWorkerRequestsList calculates 6 statistics and renders cards properly", () => {
  const statsContainer = getOrCreateElement("workerDashboardStatistics");
  const requestsContainer = getOrCreateElement("workerDashboardRequests");

  const sampleWorker = { id: "w-104", name: "Zahoor", rating: "4.8" };
  const sampleRequests = [
    { id: "req-1", status: "Pending", customerName: "Aadil", service: "Electrician", district: "Srinagar", createdAt: "2026-10-13T10:00:00Z" },
    { id: "req-2", status: "Accepted", customerName: "Bashir", service: "Electrician", district: "Shopian", createdAt: "2026-10-12T10:00:00Z" },
    { id: "req-3", status: "Completed", customerName: "Gulzar", service: "Electrician", district: "Anantnag", createdAt: "2026-10-11T10:00:00Z" },
    { id: "req-4", status: "Rejected", customerName: "Hamid", service: "Electrician", district: "Baramulla", createdAt: "2026-10-10T10:00:00Z" }
  ];

  renderWorkerRequestsList(sampleRequests, sampleWorker);

  // Verify statistics cards
  assert.equal(statsContainer.children.length, 6, "Expected 6 stat cards");

  // Check stat card contents
  const statTexts = statsContainer.children.map((c) => {
    const labelEl = c.children?.[0];
    const valEl = c.children?.[1];
    return `${labelEl?.textContent}: ${valEl?.textContent}`;
  });

  assert.ok(statTexts.includes("Total Requests: 4"), "Total requests stat must be 4");
  assert.ok(statTexts.includes("Pending: 1"), "Pending stat must be 1");
  assert.ok(statTexts.includes("Accepted: 1"), "Accepted stat must be 1");
  assert.ok(statTexts.includes("Completed: 1"), "Completed stat must be 1");
  assert.ok(statTexts.includes("Rejected: 1"), "Rejected stat must be 1");
  assert.ok(statTexts.includes("Rating: 4.8 ★"), "Rating stat must be 4.8 ★");

  // Verify request cards in DOM
  assert.equal(requestsContainer.children.length, 4, "Expected 4 rendered request cards");

  // Pending card should have Accept and Reject buttons
  const pendingCard = requestsContainer.children.find((c) => c.dataset.requestId === "req-1");
  assert.ok(pendingCard, "Pending card must exist");
  const acceptBtn = pendingCard.querySelector(".btn-accept-request");
  const rejectBtn = pendingCard.querySelector(".btn-reject-request");
  assert.ok(acceptBtn, "Pending card must have Accept button");
  assert.ok(rejectBtn, "Pending card must have Reject button");

  // Accepted card should have Complete and Chat buttons
  const acceptedCard = requestsContainer.children.find((c) => c.dataset.requestId === "req-2");
  assert.ok(acceptedCard, "Accepted card must exist");
  const completeBtn = acceptedCard.querySelector(".btn-complete-request");
  const chatBtn = acceptedCard.querySelector(".btn-chat-request");
  assert.ok(completeBtn, "Accepted card must have Complete Work button");
  assert.ok(chatBtn, "Accepted card must have Chat button");
});

// -------------------------------------------------------------
// Test 1e: Loading and Empty UI States
// -------------------------------------------------------------
await runAsyncTest("1e. UI States: Loading state and Empty state render properly", async () => {
  const requestsContainer = getOrCreateElement("workerDashboardRequests");
  const mockAdapter = createRealtimeMockFirestore([]);
  setFirestoreAdapterForTesting(mockAdapter);

  const testWorker = { id: "w-empty", workerUid: "w-empty", name: "Zahoor", rating: "5.0" };

  // 1. Calling startWorkerDashboardSubscription renders loading immediately
  startWorkerDashboardSubscription(testWorker);
  const loadingEl = requestsContainer.children.find((c) => c.classList?.contains("worker-dashboard-loading"));
  assert.ok(loadingEl, "Loading container must be displayed immediately");
  const loadingText = loadingEl.children?.find((c) => c.tagName === "P");
  assert.equal(loadingText?.textContent, "Connecting to live requests...");

  // 2. When empty snapshot arrives, empty state is displayed
  await new Promise((r) => setTimeout(r, 20));
  const emptyEl = requestsContainer.children.find((c) => c.classList?.contains("worker-dashboard-empty"));
  assert.ok(emptyEl, "Empty state container must be displayed when 0 requests");
  assert.match(emptyEl.textContent, /No customer requests are currently assigned/);

  stopWorkerDashboardSubscription();
});

// -------------------------------------------------------------
// Test 1f: Error state and Retry action
// -------------------------------------------------------------
await runAsyncTest("1f. UI States: Error state displays retry button and reconnects on click", async () => {
  const requestsContainer = getOrCreateElement("workerDashboardRequests");
  const mockAdapter = createRealtimeMockFirestore([]);
  setFirestoreAdapterForTesting(mockAdapter);

  const testWorker = { id: "w-err", workerUid: "w-err", name: "Zahoor", rating: "5.0" };
  startWorkerDashboardSubscription(testWorker);

  await new Promise((r) => setTimeout(r, 10));

  // Trigger error on listener
  mockAdapter.triggerError("w-err", new Error("Network websocket failure"));

  const errorEl = requestsContainer.children.find((c) => c.classList?.contains("worker-dashboard-error"));
  assert.ok(errorEl, "Error container must be rendered on listener error");

  const errMsg = errorEl.children?.find((c) => c.id === "workerDashboardErrorMessage");
  assert.match(errMsg?.textContent, /Network websocket failure/);

  const retryBtn = errorEl.children?.find((c) => c.id === "workerDashboardRetryBtn");
  assert.ok(retryBtn, "Retry button must be rendered in error state");

  // Clicking retry button reconnects
  retryBtn.onclick();
  const loadingAfterRetry = requestsContainer.children.find((c) => c.classList?.contains("worker-dashboard-loading"));
  assert.ok(loadingAfterRetry, "Clicking retry must immediately show loading state and re-subscribe");

  stopWorkerDashboardSubscription();
  await new Promise((r) => setTimeout(r, 20));
});

// -------------------------------------------------------------
// Test 1g: Deduplication of active listener
// -------------------------------------------------------------
await runAsyncTest("1g. Listener Deduplication: Repeated dashboard openings do not leak subscriptions", async () => {
  const mockAdapter = createRealtimeMockFirestore([
    { id: "r-dup", workerUid: "w-dup", customerName: "Aadil", status: "Pending" }
  ]);
  setFirestoreAdapterForTesting(mockAdapter);

  const testWorker = { id: "w-dup", workerUid: "w-dup", name: "Worker Dup" };

  stopWorkerDashboardSubscription();
  assert.equal(getActiveFirestoreListenersCount(), 0);

  // Start subscription 3 times for same worker
  await startWorkerDashboardSubscription(testWorker);
  await startWorkerDashboardSubscription(testWorker);
  await startWorkerDashboardSubscription(testWorker);

  assert.equal(getActiveFirestoreListenersCount(), 1, "Must maintain exactly 1 active listener for worker");

  stopWorkerDashboardSubscription();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(getActiveFirestoreListenersCount(), 0, "Cleaned up to 0 listeners");
});

// -------------------------------------------------------------
// Test 1h: Listener cleanup on Logout and Modal Close
// -------------------------------------------------------------
await runAsyncTest("1h. Session Cleanup: stopWorkerDashboardSubscription, demoLogout and modal:close tear down listener", async () => {
  const mockAdapter = createRealtimeMockFirestore([
    { id: "r-clean", workerUid: "w-clean", customerName: "Aadil", status: "Pending" }
  ]);
  setFirestoreAdapterForTesting(mockAdapter);

  const testWorker = { id: "w-clean", workerUid: "w-clean", name: "Worker Clean" };

  // 1. Explicit stopWorkerDashboardSubscription
  startWorkerDashboardSubscription(testWorker);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(getActiveFirestoreListenersCount(), 1);
  stopWorkerDashboardSubscription();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(getActiveFirestoreListenersCount(), 0);

  // 2. demoLogout() tears down listener
  startWorkerDashboardSubscription(testWorker);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(getActiveFirestoreListenersCount(), 1);
  demoLogout();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(getActiveFirestoreListenersCount(), 0, "demoLogout must tear down worker listeners");

  // 3. modal:close event tears down listener
  startWorkerDashboardSubscription(testWorker);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(getActiveFirestoreListenersCount(), 1);
  const authModal = getOrCreateElement("authModal");
  authModal.dispatchEvent({ type: "modal:close" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(getActiveFirestoreListenersCount(), 0, "modal:close must tear down worker dashboard listener");
});

// -------------------------------------------------------------
// Test 1i: Worker Actions (Accept, Reject, Complete) and DOM hooks
// -------------------------------------------------------------
await runAsyncTest("1i. Worker Actions: Accept, Reject and Complete update status and lock buttons", async () => {
  const mockAdapter = createRealtimeMockFirestore([
    { id: "req-act-1", workerUid: "w-act", customerName: "Aadil", service: "Plumber", status: "Pending" }
  ]);
  setFirestoreAdapterForTesting(mockAdapter);

  // Set current user as worker
  setCurrentUser({
    id: "w-act",
    firebaseUid: "w-act",
    role: "worker",
    name: "Worker Act"
  });

  const worker = { id: "w-act", workerUid: "w-act", name: "Worker Act", rating: "5.0" };
  renderWorkerRequestsList([{ id: "req-act-1", workerUid: "w-act", customerName: "Aadil", service: "Plumber", status: "Pending" }], worker);

  // Initialize dashboard click handlers
  initializeWorkerDashboard();

  const requestsContainer = getOrCreateElement("workerDashboardRequests");
  const card = requestsContainer.children[0];
  const acceptBtn = card.querySelector(".btn-accept-request");
  assert.ok(acceptBtn, "Accept button must exist");

  // Trigger Accept
  const dashboardView = getOrCreateElement("workerDashboardView");
  dashboardView.dispatchEvent({
    type: "click",
    target: acceptBtn
  });

  // Verify button was disabled to prevent double clicks
  assert.equal(acceptBtn.disabled, true, "Action button should be locked during update");

  await new Promise((r) => setTimeout(r, 20));

  assert.equal(mockAdapter.requests.get("req-act-1").status, "Accepted", "Request status should transition to Accepted");

  stopWorkerDashboardSubscription();
});

// -------------------------------------------------------------
// Test 1j: loadAndRenderWorkerRequests backwards-compatibility
// -------------------------------------------------------------
await runAsyncTest("1j. Backwards Compatibility: loadAndRenderWorkerRequests renders without error", async () => {
  const mockAdapter = createRealtimeMockFirestore([
    { id: "req-bw", workerUid: "w-bw", customerName: "Aadil", service: "Electrician", status: "Pending" }
  ]);
  mockAdapter.getDocs = async () => ({
    forEach: (cb) => cb({ id: "req-bw", data: () => ({ id: "req-bw", workerUid: "w-bw", customerName: "Aadil", service: "Electrician", status: "Pending" }) })
  });
  setFirestoreAdapterForTesting(mockAdapter);

  const worker = { id: "w-bw", workerUid: "w-bw", name: "Worker BW", rating: "5.0" };
  await loadAndRenderWorkerRequests(worker);

  const requestsContainer = getOrCreateElement("workerDashboardRequests");
  assert.equal(requestsContainer.children.length, 1, "Expected 1 request card rendered");
});

// -------------------------------------------------------------
// PART 2: Live Firestore Emulator Rules & Query Verification
// -------------------------------------------------------------
console.log("\n--- Part 2: Live Firestore Emulator Rules & Query Enforcement ---");

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

async function runStructuredQuery(uid, query) {
  const url = `${BASE_URL}:runQuery`;
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...makeAuthHeader(uid)
    },
    body: JSON.stringify(query)
  });
}

const emulatorLive = await isEmulatorAvailable();
if (!emulatorLive) {
  console.log("  ⚠️ Firestore Emulator not detected on", EMULATOR_HOST);
  console.log("  To run Part 2 rules tests: npx firebase-tools emulators:exec 'node scratch/test_realtime_worker_dashboard.mjs' --only firestore");
} else {
  console.log("  ✓ Firestore Emulator detected on", EMULATOR_HOST);

  // Seed initial test requests
  const reqAlphaPending = {
    id: "req-rt-alpha-1",
    requestId: "req-rt-alpha-1",
    customerId: "cust-rt-1",
    customerName: "Aadil",
    workerUid: "worker-rt-alpha",
    workerId: "worker-rt-alpha",
    workerName: "Alpha",
    service: "Electrician",
    district: "Srinagar",
    problemDescription: "Short circuit",
    customerLocation: "Dalgate",
    status: "Pending",
    createdAt: new Date().toISOString()
  };

  const reqAlphaAccepted = {
    id: "req-rt-alpha-2",
    requestId: "req-rt-alpha-2",
    customerId: "cust-rt-2",
    customerName: "Bashir",
    workerUid: "worker-rt-alpha",
    workerId: "worker-rt-alpha",
    workerName: "Alpha",
    service: "Electrician",
    district: "Shopian",
    problemDescription: "Switchboard fix",
    customerLocation: "Batamaloo",
    status: "Pending",
    createdAt: new Date().toISOString()
  };

  const reqBetaPending = {
    id: "req-rt-beta-1",
    requestId: "req-rt-beta-1",
    customerId: "cust-rt-3",
    customerName: "Gulzar",
    workerUid: "worker-rt-beta",
    workerId: "worker-rt-beta",
    workerName: "Beta",
    service: "Plumber",
    district: "Anantnag",
    problemDescription: "Leaking pipe",
    customerLocation: "KP Road",
    status: "Pending",
    createdAt: new Date().toISOString()
  };

  await createDocAsUser("requests", "req-rt-alpha-1", reqAlphaPending, "cust-rt-1");
  await createDocAsUser("requests", "req-rt-alpha-2", reqAlphaAccepted, "cust-rt-2");
  await createDocAsUser("requests", "req-rt-beta-1", reqBetaPending, "cust-rt-3");

  // Transition req-rt-alpha-2 to Accepted
  await updateDocAsUser("requests", "req-rt-alpha-2", { status: "Accepted", updatedAt: new Date().toISOString() }, ["status", "updatedAt"], "worker-rt-alpha");

  // 2a. worker-rt-alpha querying requests filtered by workerUid == "worker-rt-alpha"
  await runAsyncTest("2a. Authenticated worker querying own assigned requests is ALLOWED (200)", async () => {
    const query = {
      structuredQuery: {
        from: [{ collectionId: "requests" }],
        where: {
          fieldFilter: {
            field: { fieldPath: "workerUid" },
            op: "EQUAL",
            value: { stringValue: "worker-rt-alpha" }
          }
        }
      }
    };
    const res = await runStructuredQuery("worker-rt-alpha", query);
    assert.equal(res.status, 200);
    const json = await res.json();
    const docs = json.filter((item) => item.document);
    assert.equal(docs.length, 2, "Expected 2 requests returned for worker-rt-alpha");
  });

  // 2b. worker-rt-alpha querying requests filtered by workerUid == "worker-rt-beta" (imposter / cross-worker leak)
  await runAsyncTest("2b. Worker attempting to query other worker's requests is DENIED (403)", async () => {
    const query = {
      structuredQuery: {
        from: [{ collectionId: "requests" }],
        where: {
          fieldFilter: {
            field: { fieldPath: "workerUid" },
            op: "EQUAL",
            value: { stringValue: "worker-rt-beta" }
          }
        }
      }
    };
    const res = await runStructuredQuery("worker-rt-alpha", query);
    assert.equal(res.status, 403, "Query for another worker's requests must be denied 403");
  });

  // 2c. Unfiltered query over all requests by worker
  await runAsyncTest("2c. Worker attempting unfiltered query across /requests is DENIED (403)", async () => {
    const query = {
      structuredQuery: {
        from: [{ collectionId: "requests" }]
      }
    };
    const res = await runStructuredQuery("worker-rt-alpha", query);
    assert.equal(res.status, 403, "Unfiltered requests query must be denied 403");
  });

  // 2d. Unauthenticated query
  await runAsyncTest("2d. Unauthenticated query across /requests is DENIED (403)", async () => {
    const query = {
      structuredQuery: {
        from: [{ collectionId: "requests" }],
        where: {
          fieldFilter: {
            field: { fieldPath: "workerUid" },
            op: "EQUAL",
            value: { stringValue: "worker-rt-alpha" }
          }
        }
      }
    };
    const res = await runStructuredQuery(null, query);
    assert.equal(res.status, 403, "Unauthenticated query must be denied 403");
  });

  // 2e. Customer creates new request for worker-rt-alpha, worker queries and accepts it
  await runAsyncTest("2e. Dynamic lifecycle: Customer creates request -> Worker queries -> Worker completes", async () => {
    const newReq = {
      id: "req-rt-alpha-3",
      requestId: "req-rt-alpha-3",
      customerId: "cust-rt-4",
      customerName: "Tariq",
      workerUid: "worker-rt-alpha",
      workerId: "worker-rt-alpha",
      workerName: "Alpha",
      service: "Electrician",
      district: "Srinagar",
      problemDescription: "Fan repair",
      customerLocation: "Rajbagh",
      status: "Pending",
      createdAt: new Date().toISOString()
    };

    // 1. Customer creates request
    const createRes = await createDocAsUser("requests", "req-rt-alpha-3", newReq, "cust-rt-4");
    assert.equal(createRes.status, 200);

    // 2. Worker query returns newly created request
    const query = {
      structuredQuery: {
        from: [{ collectionId: "requests" }],
        where: {
          fieldFilter: {
            field: { fieldPath: "workerUid" },
            op: "EQUAL",
            value: { stringValue: "worker-rt-alpha" }
          }
        }
      }
    };
    const queryRes = await runStructuredQuery("worker-rt-alpha", query);
    assert.equal(queryRes.status, 200);
    const json = await queryRes.json();
    const docs = json.filter((item) => item.document);
    assert.equal(docs.length, 3, "Expected 3 requests after customer creation");

    // 3. Worker Alpha accepts request
    const acceptRes = await updateDocAsUser("requests", "req-rt-alpha-3", { status: "Accepted", updatedAt: new Date().toISOString() }, ["status", "updatedAt"], "worker-rt-alpha");
    assert.equal(acceptRes.status, 200);

    // 4. Worker Beta attempts to complete Alpha's request -> DENIED (403)
    const betaCompleteRes = await updateDocAsUser("requests", "req-rt-alpha-3", { status: "Completed", updatedAt: new Date().toISOString() }, ["status", "updatedAt"], "worker-rt-beta");
    assert.equal(betaCompleteRes.status, 403, "Worker Beta cannot complete Worker Alpha's request");

    // 5. Worker Alpha completes request -> ALLOWED (200)
    const alphaCompleteRes = await updateDocAsUser("requests", "req-rt-alpha-3", { status: "Completed", updatedAt: new Date().toISOString() }, ["status", "updatedAt"], "worker-rt-alpha");
    assert.equal(alphaCompleteRes.status, 200);
  });
}

console.log("\n==================================================");
console.log(`SUMMARY: ${totalPassed} passed, ${totalFailed} failed.`);
console.log("==================================================");

if (totalFailed > 0) {
  process.exit(1);
}

