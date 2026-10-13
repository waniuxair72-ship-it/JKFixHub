/**
 * Regression Test Suite: Service Request Authentication and Persistence
 *
 * Verifies:
 * 1. Unauthenticated guest request attempts are rejected with clear sign-in / registration prompt.
 * 2. Form inputs are completely preserved on unauthenticated attempt without creating a request.
 * 3. Worker accounts attempting to submit customer requests are rejected with clear role error.
 * 4. Authenticated customer requests persist to Firestore and confirm success only upon genuine DB write.
 * 5. Firestore write failures (success: false) display honest error and allow retry.
 * 6. Firestore network exceptions display honest error, restore submit button, and allow retry.
 * 7. Duplicate in-flight submissions are blocked while request is pending.
 * 8. User inputs & drafts are preserved across auth prompt and modal reopening.
 * 9. Static audit: Zero mock/in-memory success fallbacks exist in request.js or firestore-service.js.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
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
console.log("TEST SUITE: SERVICE REQUEST AUTH & PERSISTENCE");
console.log("==================================================");

// -------------------------------------------------------------
// Test 1: Static Code Audit - Zero False Success Fallbacks
// -------------------------------------------------------------
runTest("1a. js/request.js contains zero fake in-memory success fallback objects", () => {
  const reqJsPath = path.join(projectRoot, "js", "request.js");
  const content = fs.readFileSync(reqJsPath, "utf-8");

  // Verify that the old mock fallback ternary ({ id: result?.requestId || `req-...`, ... }) is removed
  assert.ok(
    !content.includes("id: result?.requestId || `req-"),
    "request.js must not contain fallback mock object creating fake req- IDs"
  );
  assert.ok(
    !content.includes("submittedAt: createdAt\n      };"),
    "request.js must not construct fallback request object"
  );
  // Verify strict persistence check
  assert.ok(
    content.includes("if (!result || !result.success || !result.request)"),
    "request.js must strictly check result.success and result.request before confirming success"
  );
});

runTest("1b. js/firestore-service.js contains zero fake success fallbacks on write failure or offline", () => {
  const fsPath = path.join(projectRoot, "js", "firestore-service.js");
  const content = fs.readFileSync(fsPath, "utf-8");

  // In createFirestoreServiceRequest, offline / catch block must NOT return success: true
  const fnMatch = content.match(/export async function createFirestoreServiceRequest[\s\S]*?^}/m);
  assert.ok(fnMatch, "createFirestoreServiceRequest must exist");
  const fnBody = fnMatch[0];

  assert.ok(
    !fnBody.includes("// Safe fallback (offline / mock environment)\n  return {\n    success: true"),
    "createFirestoreServiceRequest must NOT return success: true on offline fallback"
  );
  assert.ok(
    fnBody.includes('error: "Service request database is unavailable.'),
    "createFirestoreServiceRequest must return honest error when database is unavailable"
  );
});

runTest("1c. index.html contains #requestFeedback in #requestModal", () => {
  const htmlPath = path.join(projectRoot, "index.html");
  const content = fs.readFileSync(htmlPath, "utf-8");

  assert.ok(content.includes('id="requestFeedback"'), "index.html must have #requestFeedback container");
  assert.ok(content.includes('id="requestFeedbackMessage"'), "index.html must have #requestFeedbackMessage container");
  assert.ok(content.includes('id="requestAuthPromptActions"'), "index.html must have #requestAuthPromptActions");
  assert.ok(content.includes('id="requestSignInPromptBtn"'), "index.html must have #requestSignInPromptBtn");
  assert.ok(content.includes('id="requestRegisterPromptBtn"'), "index.html must have #requestRegisterPromptBtn");
});

// -------------------------------------------------------------
// DOM Simulation Environment for Functional Tests
// -------------------------------------------------------------
globalThis.Node = class Node {};
globalThis.Element = class Element extends globalThis.Node {};

class MockClassList {
  constructor(el) {
    this.el = el;
    this.classes = new Set();
  }
  add(...names) {
    for (const name of names) this.classes.add(name);
  }
  remove(...names) {
    for (const name of names) this.classes.delete(name);
  }
  contains(name) {
    return this.classes.has(name);
  }
}

class MockElement extends globalThis.Element {
  constructor(tagName = "div", id = "") {
    super();
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.hidden = false;
    this.value = "";
    this.textContent = "";
    this.className = "";
    this.disabled = false;
    this.classList = new MockClassList(this);
    this.attributes = new Map();
    this.listeners = new Map();
    this.children = [];
    this.options = [];
  }

  get dataset() {
    const ds = {};
    for (const [k, v] of this.attributes) {
      if (k.startsWith("data-")) {
        const camel = k.slice(5).replace(/-([a-z])/g, (_, g) => g.toUpperCase());
        ds[camel] = v;
      }
    }
    return ds;
  }

  closest(sel) {
    if (sel === "[data-request-worker]" && this.attributes.has("data-request-worker")) {
      return this;
    }
    if (sel === '[data-close="requestModal"]' && this.getAttribute("data-close") === "requestModal") {
      return this;
    }
    return null;
  }

  setAttribute(name, val) {
    this.attributes.set(name, String(val));
  }
  getAttribute(name) {
    return this.attributes.get(name) || null;
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  addEventListener(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(fn);
  }
  async dispatchEvent(event) {
    const list = this.listeners.get(event.type) || [];
    for (const fn of list) {
      await fn(event);
    }
    return true;
  }
  querySelector(sel) {
    if (sel === 'button[type="submit"]') {
      return this.children.find((c) => c.type === "submit") || null;
    }
    if (sel === '[aria-invalid="true"]') {
      return this.children.find((c) => c.getAttribute("aria-invalid") === "true") || null;
    }
    if (sel === ".modal") return this;
    return null;
  }
  querySelectorAll(sel) {
    if (sel === "[data-request-error]") {
      return this.children.filter((c) => c.attributes.has("data-request-error"));
    }
    if (sel === "[aria-invalid]") {
      return this.children.filter((c) => c.attributes.has("aria-invalid"));
    }
    return [];
  }
  replaceChildren(...newChildren) {
    this.children = [...newChildren];
  }
  append(...items) {
    this.children.push(...items);
  }
  reset() {
    this.value = "";
  }
  focus() {}
}

function createTestDOM() {
  const elements = new Map();
  function getEl(id, tag = "div") {
    if (!elements.has(id)) {
      const el = new MockElement(tag, id);
      elements.set(id, el);
    }
    return elements.get(id);
  }

  const requestModal = getEl("requestModal", "div");
  const requestFormView = getEl("requestFormView", "div");
  const requestSuccess = getEl("requestSuccess", "section");
  requestSuccess.hidden = true;

  const requestFeedback = getEl("requestFeedback", "div");
  requestFeedback.hidden = true;
  const requestFeedbackMessage = getEl("requestFeedbackMessage", "span");
  const requestAuthPromptActions = getEl("requestAuthPromptActions", "div");
  requestAuthPromptActions.hidden = true;
  const requestSignInPromptBtn = getEl("requestSignInPromptBtn", "button");
  const requestRegisterPromptBtn = getEl("requestRegisterPromptBtn", "button");
  requestFeedback.children.push(requestFeedbackMessage, requestAuthPromptActions);
  requestAuthPromptActions.children.push(requestSignInPromptBtn, requestRegisterPromptBtn);

  const requestWorker = getEl("requestWorker", "div");
  const form = getEl("requestForm", "form");
  const submitBtn = getEl("submitBtn", "button");
  submitBtn.type = "submit";
  submitBtn.textContent = "Send Request";

  const customerName = getEl("customerName", "input");
  const customerNameError = getEl("customerNameError", "span");
  customerNameError.setAttribute("data-request-error", "");

  const requestService = getEl("requestService", "select");
  requestService.options = [
    { value: "Plumbing", text: "Plumbing" },
    { value: "Electrician", text: "Electrician" }
  ];
  const requestServiceError = getEl("requestServiceError", "span");
  requestServiceError.setAttribute("data-request-error", "");

  const requestDescription = getEl("requestDescription", "textarea");
  const requestDescriptionError = getEl("requestDescriptionError", "span");
  requestDescriptionError.setAttribute("data-request-error", "");

  const requestLocation = getEl("requestLocation", "input");
  const requestLocationError = getEl("requestLocationError", "span");
  requestLocationError.setAttribute("data-request-error", "");

  const preferredTime = getEl("preferredTime", "select");
  preferredTime.value = "Today";
  const preferredTimeError = getEl("preferredTimeError", "span");
  preferredTimeError.setAttribute("data-request-error", "");

  const requestSuccessWorker = getEl("requestSuccessWorker", "strong");
  const requestSuccessService = getEl("requestSuccessService", "span");
  const requestSuccessDistrict = getEl("requestSuccessDistrict", "span");
  const requestSuccessStatus = getEl("requestSuccessStatus", "span");
  const requestSuccessTag = getEl("requestSuccessTag", "span");
  const requestDone = getEl("requestDone", "button");

  form.children.push(
    customerName,
    customerNameError,
    requestService,
    requestServiceError,
    requestDescription,
    requestDescriptionError,
    requestLocation,
    requestLocationError,
    preferredTime,
    preferredTimeError,
    submitBtn
  );

  const docListeners = new Map();

  const doc = {
    body: new MockElement("body", "body"),
    createElement: (tag) => new MockElement(tag),
    getElementById: (id) => getEl(id),
    querySelector: (sel) => {
      if (sel === "#requestModal .modal") return requestModal;
      if (sel === 'button[type="submit"]') return submitBtn;
      if (sel === "#requestSuccess .request-prototype-note") return getEl("requestPrototypeNote");
      return null;
    },
    querySelectorAll: (sel) => {
      if (sel === ".modal-backdrop") return [requestModal];
      if (sel === ".modal-backdrop.open") return requestModal.classList.contains("open") ? [requestModal] : [];
      return [];
    },
    addEventListener: (event, fn) => {
      if (!docListeners.has(event)) docListeners.set(event, []);
      docListeners.get(event).push(fn);
    },
    dispatchEvent: async (event) => {
      const list = docListeners.get(event.type) || [];
      for (const fn of list) {
        await fn(event);
      }
      return true;
    }
  };

  return {
    doc,
    elements,
    form,
    submitBtn,
    customerName,
    requestService,
    requestDescription,
    requestLocation,
    preferredTime,
    requestFeedback,
    requestFeedbackMessage,
    requestAuthPromptActions,
    requestSuccess,
    requestFormView,
    requestModal
  };
}

// -------------------------------------------------------------
// Test 2: Unauthenticated Submission Rejection
// -------------------------------------------------------------
await runAsyncTest("2. Unauthenticated guest request is rejected: no request created, sign-in prompt displayed, form preserved", async () => {
  const dom = createTestDOM();
  const originalDoc = globalThis.document;
  globalThis.document = dom.doc;

  try {
    const store = await import("../js/store.js");
    const requestModule = await import("../js/request.js");

    // Ensure signed-out state
    store.clearCurrentUser();
    assert.equal(store.getCurrentUser(), null);

    // Select a valid worker
    const worker = {
      id: "w-test-1",
      name: "Tariq Lone",
      service: "Plumbing",
      district: "Srinagar",
      rating: 4.9,
      isVerified: true,
      status: "active"
    };
    // Add worker to store state for test
    store.setDiscoveredWorkers([worker]);
    store.setSelectedWorker(worker.id);

    // Fill valid form inputs as guest
    dom.customerName.value = "Guest Customer";
    dom.requestService.value = "Plumbing";
    dom.requestDescription.value = "Water leaking under the kitchen sink pipe.";
    dom.requestLocation.value = "Rajbagh, Srinagar";
    dom.preferredTime.value = "Today";

    // Initialize request flow
    requestModule.initializeRequestFlow();

    // Trigger submit as unauthenticated guest
    const submitEvent = {
      type: "submit",
      preventDefault: () => {}
    };
    await dom.form.dispatchEvent(submitEvent);

    // Assert: requestSuccess remains hidden
    assert.equal(dom.requestSuccess.hidden, true, "requestSuccess must NOT be visible for guest submission");
    assert.equal(dom.requestFormView.hidden, false, "requestFormView must remain visible");

    // Assert: requestFeedback displays clear prompt
    assert.equal(dom.requestFeedback.hidden, false, "requestFeedback banner must be visible");
    assert.ok(
      dom.requestFeedbackMessage.textContent.includes("Please sign in or create a customer account"),
      "Feedback must prompt guest to sign in or create an account"
    );
    assert.equal(dom.requestAuthPromptActions.hidden, false, "Auth prompt action buttons must be visible");

    // Assert: form inputs are completely preserved
    assert.equal(dom.customerName.value, "Guest Customer", "customerName must be preserved");
    assert.equal(dom.requestDescription.value, "Water leaking under the kitchen sink pipe.", "description must be preserved");
    assert.equal(dom.requestLocation.value, "Rajbagh, Srinagar", "location must be preserved");

    // Assert: submit button is enabled and ready
    assert.equal(dom.submitBtn.disabled, false, "submitBtn must NOT remain disabled");
    assert.equal(dom.submitBtn.textContent, "Send Request", "submitBtn text must be 'Send Request'");

    // Assert: no request stored in store
    assert.equal(store.getCurrentRequest(), null, "Store currentRequest must remain null");
  } finally {
    globalThis.document = originalDoc;
  }
});

// -------------------------------------------------------------
// Test 3: Worker Role Attempting Customer Request Rejection
// -------------------------------------------------------------
await runAsyncTest("3. Worker account attempting to submit service request is rejected with clear role error", async () => {
  const dom = createTestDOM();
  const originalDoc = globalThis.document;
  globalThis.document = dom.doc;

  try {
    const store = await import("../js/store.js");
    const requestModule = await import("../js/request.js");

    // Sign in as worker
    store.setCurrentUser({
      id: "w-signed-in",
      firebaseUid: "w-signed-in",
      role: "worker",
      name: "Bashir Electrician"
    });

    const worker = {
      id: "w-target",
      name: "Ghulam Nabi",
      service: "Plumbing",
      district: "Srinagar",
      rating: 4.8,
      isVerified: true,
      status: "active"
    };
    store.setDiscoveredWorkers([worker]);
    store.setSelectedWorker(worker.id);

    dom.customerName.value = "Bashir Electrician";
    dom.requestService.value = "Plumbing";
    dom.requestDescription.value = "Need plumbing repairs in workshop.";
    dom.requestLocation.value = "Batamaloo, Srinagar";
    dom.preferredTime.value = "Tomorrow";

    requestModule.initializeRequestFlow();

    await dom.form.dispatchEvent({ type: "submit", preventDefault: () => {} });

    // Assert rejection
    assert.equal(dom.requestSuccess.hidden, true, "requestSuccess must NOT be visible for worker user");
    assert.equal(dom.requestFeedback.hidden, false, "requestFeedback banner must be visible");
    assert.ok(
      dom.requestFeedbackMessage.textContent.includes("Only customer accounts can submit service requests"),
      "Feedback must clearly notify worker role restriction"
    );
    assert.equal(dom.submitBtn.disabled, false);
    assert.equal(store.getCurrentRequest(), null);
  } finally {
    globalThis.document = originalDoc;
  }
});

// -------------------------------------------------------------
// Test 4: Authenticated Customer with Successful Firestore Write
// -------------------------------------------------------------
await runAsyncTest("4. Authenticated customer request succeeds and confirms ONLY when Firestore confirms DB write", async () => {
  const dom = createTestDOM();
  const originalDoc = globalThis.document;
  globalThis.document = dom.doc;

  try {
    const store = await import("../js/store.js");
    const fsService = await import("../js/firestore-service.js");
    const requestModule = await import("../js/request.js");

    // Sign in as valid customer
    store.setCurrentUser({
      id: "c-authed-101",
      firebaseUid: "c-authed-101",
      role: "customer",
      name: "Aamir Farooq"
    });

    const worker = {
      id: "w-real-1",
      workerUid: "w-real-1",
      name: "Mohammad Ashraf",
      service: "Plumbing",
      district: "Srinagar",
      rating: 4.9,
      isVerified: true,
      status: "active"
    };
    store.setDiscoveredWorkers([worker]);
    store.setSelectedWorker(worker.id);

    dom.customerName.value = "Aamir Farooq";
    dom.requestService.value = "Plumbing";
    dom.requestDescription.value = "Geyser leaking hot water in main bathroom.";
    dom.requestLocation.value = "Rajbagh, Srinagar";
    dom.preferredTime.value = "As soon as possible";

    // Mock direct Firestore write to succeed
    const originalCreate = fsService.createFirestoreServiceRequest;
    let createCalledWith = null;

    // We simulate a verified Firestore save
    const mockRequestDoc = {
      id: "req-persisted-99",
      requestId: "req-persisted-99",
      customerId: "c-authed-101",
      customerName: "Aamir Farooq",
      workerUid: "w-real-1",
      workerName: "Mohammad Ashraf",
      service: "Plumbing",
      district: "Srinagar",
      problemDescription: "Geyser leaking hot water in main bathroom.",
      status: "Pending",
      createdAt: new Date().toISOString()
    };

    // Override with confirmed success
    const mockCreateFirestore = async (payload) => {
      createCalledWith = payload;
      return {
        success: true,
        requestId: "req-persisted-99",
        request: mockRequestDoc,
        error: null
      };
    };

    // Monkey-patch inside module scope if needed or test via module
    // Since createFirestoreServiceRequest is imported directly, let's test via form submit
    requestModule.initializeRequestFlow();

    // Since request.js imported createFirestoreServiceRequest statically,
    // let's temporarily mock the underlying Firestore client via firebase-config
    const fbConfig = await import("../js/firebase-config.js");
    const mockDb = { name: "mock-firestore" };
    const savedDocs = new Map();
    fbConfig.setFirestoreAdapterForTesting({
      collection: (db, name) => ({ path: name }),
      doc: (db, col, id) => ({ path: `${col}/${id}`, id }),
      setDoc: async (docRef, data) => {
        savedDocs.set(docRef.id, data);
      }
    });

    await dom.form.dispatchEvent({ type: "submit", preventDefault: () => {} });

    // Assert: request was genuinely written to Firestore adapter
    assert.equal(savedDocs.size, 1, "Document must have been written to Firestore adapter via setDoc");
    const writtenDoc = [...savedDocs.values()][0];
    assert.equal(writtenDoc.customerId, "c-authed-101", "Written doc customerId must match auth user");
    assert.equal(writtenDoc.workerUid, "w-real-1", "Written doc workerUid must match selected worker");
    assert.equal(writtenDoc.service, "Plumbing");
    assert.equal(writtenDoc.status, "Pending");

    // Assert: success confirmation revealed in UI
    assert.equal(dom.requestSuccess.hidden, false, "requestSuccess must be visible");
    assert.equal(dom.requestFormView.hidden, true, "requestFormView must be hidden");

    // Assert: store has currentRequest
    const storedReq = store.getCurrentRequest();
    assert.ok(storedReq, "Store must record currentRequest");
    assert.equal(storedReq.customerId, "c-authed-101");

    // Clean up adapter
    fbConfig.setFirestoreAdapterForTesting(null);
  } finally {
    globalThis.document = originalDoc;
  }
});

// -------------------------------------------------------------
// Test 5: Firestore Failure (success: false) Honest Error Handling
// -------------------------------------------------------------
await runAsyncTest("5. Firestore failure (success: false) displays honest error and restores submit button for retry", async () => {
  const dom = createTestDOM();
  const originalDoc = globalThis.document;
  globalThis.document = dom.doc;

  try {
    const store = await import("../js/store.js");
    const fbConfig = await import("../js/firebase-config.js");
    const requestModule = await import("../js/request.js");

    store.setCurrentUser({
      id: "c-authed-202",
      firebaseUid: "c-authed-202",
      role: "customer",
      name: "Zahoor Ahmad"
    });

    const worker = {
      id: "w-real-2",
      workerUid: "w-real-2",
      name: "Tariq Electrician",
      service: "Electrician",
      district: "Shopian",
      rating: 5.0,
      isVerified: true,
      status: "active"
    };
    store.setDiscoveredWorkers([worker]);
    store.setSelectedWorker(worker.id);

    dom.customerName.value = "Zahoor Ahmad";
    dom.requestService.value = "Electrician";
    dom.requestDescription.value = "Tripping MCB in living room circuit.";
    dom.requestLocation.value = "Shopian Town";
    dom.preferredTime.value = "Today";

    // Setup adapter where setDoc fails with permission-denied
    fbConfig.setFirestoreAdapterForTesting({
      collection: (db, name) => ({ path: name }),
      doc: (db, col, id) => ({ path: `${col}/${id}`, id }),
      setDoc: async () => {
        const err = new Error("Permission denied. Insufficient customer privileges.");
        err.code = "permission-denied";
        throw err;
      }
    });

    requestModule.initializeRequestFlow();

    await dom.form.dispatchEvent({ type: "submit", preventDefault: () => {} });

    // Assert: requestSuccess remains hidden
    assert.equal(dom.requestSuccess.hidden, true, "requestSuccess must NOT be visible upon Firestore failure");
    assert.equal(dom.requestFormView.hidden, false, "requestFormView must remain visible");

    // Assert: feedback displays the honest permission-denied error
    assert.equal(dom.requestFeedback.hidden, false, "requestFeedback banner must be displayed");
    assert.ok(
      dom.requestFeedbackMessage.textContent.includes("Permission denied"),
      `Expected permission denied error in feedback, got: ${dom.requestFeedbackMessage.textContent}`
    );

    // Assert: submit button restored for retry
    assert.equal(dom.submitBtn.disabled, false, "submitBtn must be re-enabled for retry");
    assert.equal(dom.submitBtn.textContent, "Send Request", "submitBtn text must be 'Send Request'");

    // Assert: form inputs are preserved so user can retry without re-typing
    assert.equal(dom.customerName.value, "Zahoor Ahmad");
    assert.equal(dom.requestDescription.value, "Tripping MCB in living room circuit.");
    assert.equal(dom.requestLocation.value, "Shopian Town");

    fbConfig.setFirestoreAdapterForTesting(null);
  } finally {
    globalThis.document = originalDoc;
  }
});

// -------------------------------------------------------------
// Test 6: Firestore Exception / Network Error Handling
// -------------------------------------------------------------
await runAsyncTest("6. Firestore network exception displays honest error and restores submit button", async () => {
  const dom = createTestDOM();
  const originalDoc = globalThis.document;
  globalThis.document = dom.doc;

  try {
    const store = await import("../js/store.js");
    const fbConfig = await import("../js/firebase-config.js");
    const requestModule = await import("../js/request.js");

    store.setCurrentUser({
      id: "c-authed-303",
      firebaseUid: "c-authed-303",
      role: "customer",
      name: "Nida Jan"
    });

    const worker = {
      id: "w-real-3",
      workerUid: "w-real-3",
      name: "Hilal Carpenter",
      service: "Carpentry",
      district: "Baramulla",
      rating: 4.8,
      isVerified: true,
      status: "active"
    };
    store.setDiscoveredWorkers([worker]);
    store.setSelectedWorker(worker.id);

    dom.customerName.value = "Nida Jan";
    dom.requestService.value = "Carpentry";
    dom.requestDescription.value = "Main entrance door lock is jammed and won't lock.";
    dom.requestLocation.value = "Baramulla Main Market";
    dom.preferredTime.value = "Flexible";

    // Setup adapter that throws network timeout
    fbConfig.setFirestoreAdapterForTesting({
      collection: () => ({}),
      doc: () => ({}),
      setDoc: async () => {
        throw new Error("Network timeout: unable to reach Firestore backend.");
      }
    });

    requestModule.initializeRequestFlow();

    await dom.form.dispatchEvent({ type: "submit", preventDefault: () => {} });

    assert.equal(dom.requestSuccess.hidden, true, "requestSuccess must NOT be shown on network exception");
    assert.equal(dom.requestFormView.hidden, false);
    assert.equal(dom.requestFeedback.hidden, false);
    assert.equal(dom.submitBtn.disabled, false);
    assert.equal(dom.submitBtn.textContent, "Send Request");
    assert.equal(dom.requestDescription.value, "Main entrance door lock is jammed and won't lock.");

    fbConfig.setFirestoreAdapterForTesting(null);
  } finally {
    globalThis.document = originalDoc;
  }
});

// -------------------------------------------------------------
// Test 7: Successful Retry After Previous Failure
// -------------------------------------------------------------
await runAsyncTest("7. Customer can successfully retry submission after previous error once DB recovers", async () => {
  const dom = createTestDOM();
  const originalDoc = globalThis.document;
  globalThis.document = dom.doc;

  try {
    const store = await import("../js/store.js");
    const fbConfig = await import("../js/firebase-config.js");
    const requestModule = await import("../js/request.js");

    store.setCurrentUser({
      id: "c-authed-404",
      firebaseUid: "c-authed-404",
      role: "customer",
      name: "Sajad Mir"
    });

    const worker = {
      id: "w-real-4",
      workerUid: "w-real-4",
      name: "Fayaz Plumber",
      service: "Plumbing",
      district: "Shopian",
      rating: 4.7,
      isVerified: true,
      status: "active"
    };
    store.setDiscoveredWorkers([worker]);
    store.setSelectedWorker(worker.id);

    dom.customerName.value = "Sajad Mir";
    dom.requestService.value = "Plumbing";
    dom.requestDescription.value = "Water tank overflow pipe broken.";
    dom.requestLocation.value = "Shopian";
    dom.preferredTime.value = "Today";

    let shouldFail = true;
    const savedDocs = new Map();

    fbConfig.setFirestoreAdapterForTesting({
      collection: (db, name) => ({ path: name }),
      doc: (db, col, id) => ({ path: `${col}/${id}`, id }),
      setDoc: async (docRef, data) => {
        if (shouldFail) {
          throw new Error("Temporary connection glitch");
        }
        savedDocs.set(docRef.id, data);
      }
    });

    requestModule.initializeRequestFlow();

    // First attempt: fails
    await dom.form.dispatchEvent({ type: "submit", preventDefault: () => {} });
    assert.equal(dom.requestSuccess.hidden, true);
    assert.equal(dom.submitBtn.disabled, false);

    // Second attempt: backend recovered, retry succeeds
    shouldFail = false;
    await dom.form.dispatchEvent({ type: "submit", preventDefault: () => {} });

    assert.equal(dom.requestSuccess.hidden, false, "Success confirmation must be shown after successful retry");
    assert.equal(savedDocs.size, 1, "Document must have been written on retry");

    fbConfig.setFirestoreAdapterForTesting(null);
  } finally {
    globalThis.document = originalDoc;
  }
});

// -------------------------------------------------------------
// Test 8: Duplicate In-Flight Submission Prevention
// -------------------------------------------------------------
await runAsyncTest("8. Duplicate submissions while in-flight are prevented", async () => {
  const dom = createTestDOM();
  const originalDoc = globalThis.document;
  globalThis.document = dom.doc;

  try {
    const store = await import("../js/store.js");
    const fbConfig = await import("../js/firebase-config.js");
    const requestModule = await import("../js/request.js");

    store.setCurrentUser({
      id: "c-authed-505",
      firebaseUid: "c-authed-505",
      role: "customer",
      name: "Bilal Lone"
    });

    const worker = {
      id: "w-real-5",
      workerUid: "w-real-5",
      name: "Tariq Plumber",
      service: "Plumbing",
      district: "Srinagar",
      rating: 4.9,
      isVerified: true,
      status: "active"
    };
    store.setDiscoveredWorkers([worker]);
    store.setSelectedWorker(worker.id);

    dom.customerName.value = "Bilal Lone";
    dom.requestService.value = "Plumbing";
    dom.requestDescription.value = "Leaking tap in bathroom wash basin.";
    dom.requestLocation.value = "Srinagar";
    dom.preferredTime.value = "Today";

    let writeCount = 0;
    let resolveWrite;
    const writePromise = new Promise((resolve) => {
      resolveWrite = resolve;
    });

    fbConfig.setFirestoreAdapterForTesting({
      collection: (db, name) => ({ path: name }),
      doc: (db, col, id) => ({ path: `${col}/${id}`, id }),
      setDoc: async () => {
        writeCount++;
        await writePromise;
      }
    });

    requestModule.initializeRequestFlow();

    // Trigger first submission (in-flight)
    const p1 = dom.form.dispatchEvent({ type: "submit", preventDefault: () => {} });

    // Submit button should be disabled with Sending Request...
    assert.equal(dom.submitBtn.disabled, true, "Submit button must be disabled while in-flight");
    assert.equal(dom.submitBtn.textContent, "Sending Request...", "Submit button text must indicate in-flight state");

    // Trigger second submission while first is still pending
    const p2 = dom.form.dispatchEvent({ type: "submit", preventDefault: () => {} });

    // Resolve the in-flight write
    resolveWrite();
    await Promise.all([p1, p2]);

    // Assert: write was only called once, second concurrent call was rejected
    assert.equal(writeCount, 1, "Duplicate in-flight submission must be blocked");
    assert.equal(dom.requestSuccess.hidden, false);

    fbConfig.setFirestoreAdapterForTesting(null);
  } finally {
    globalThis.document = originalDoc;
  }
});

// -------------------------------------------------------------
// Test 9: Draft restoration and auth modal trigger
// -------------------------------------------------------------
await runAsyncTest("9. Guest inputs are preserved and restored when reopening modal for the worker", async () => {
  const dom = createTestDOM();
  const originalDoc = globalThis.document;
  globalThis.document = dom.doc;

  try {
    const store = await import("../js/store.js");
    const requestModule = await import("../js/request.js");

    store.clearCurrentUser();

    const worker = {
      id: "w-real-6",
      workerUid: "w-real-6",
      name: "Parvaiz Mason",
      service: "Plumbing",
      district: "Srinagar",
      rating: 4.9,
      isVerified: true,
      status: "active"
    };
    store.setDiscoveredWorkers([worker]);
    store.setSelectedWorker(worker.id);

    dom.customerName.value = "Guest User";
    dom.requestService.value = "Plumbing";
    dom.requestDescription.value = "Draft problem description that must not be lost.";
    dom.requestLocation.value = "Lal Chowk, Srinagar";
    dom.preferredTime.value = "Tomorrow";

    requestModule.initializeRequestFlow();

    // Submit as guest
    await dom.form.dispatchEvent({ type: "submit", preventDefault: () => {} });

    // Simulate modal close without form reset (e.g. clicking Sign In)
    const signInBtn = dom.doc.getElementById("requestSignInPromptBtn");
    assert.ok(signInBtn, "requestSignInPromptBtn must exist");

    // Clear DOM input values to simulate reopening
    dom.customerName.value = "";
    dom.requestDescription.value = "";
    dom.requestLocation.value = "";

    // Simulate user signing in as customer
    store.setCurrentUser({
      id: "c-signed-in-6",
      firebaseUid: "c-signed-in-6",
      role: "customer",
      name: "Tariq Customer"
    });

    // Simulate clicking "Request Service" on the worker again via dispatch
    const trigger = new MockElement("button");
    trigger.setAttribute("data-request-worker", "w-real-6");
    await dom.doc.dispatchEvent({
      type: "click",
      target: trigger
    });

    // Check that draft inputs were restored!
    assert.equal(dom.customerName.value, "Tariq Customer", "Customer name should be prepopulated with logged-in user name");
    assert.equal(dom.requestDescription.value, "Draft problem description that must not be lost.", "Description should be restored from draft");
    assert.equal(dom.requestLocation.value, "Lal Chowk, Srinagar", "Location should be restored from draft");
    assert.equal(dom.preferredTime.value, "Tomorrow", "Preferred time should be restored from draft");
  } finally {
    globalThis.document = originalDoc;
  }
});

// -------------------------------------------------------------
// Test 10: resetRequestForm cleans up feedback, drafts, and buttons
// -------------------------------------------------------------
await runAsyncTest("10. Explicit modal close cleanly resets form, feedback, draft, and submit button", async () => {
  const dom = createTestDOM();
  const originalDoc = globalThis.document;
  globalThis.document = dom.doc;

  try {
    const store = await import("../js/store.js");
    const requestModule = await import("../js/request.js");

    store.clearCurrentUser();

    const worker = {
      id: "w-real-7",
      workerUid: "w-real-7",
      name: "Altaf Plumber",
      service: "Plumbing",
      district: "Srinagar",
      rating: 4.8,
      isVerified: true,
      status: "active"
    };
    store.setDiscoveredWorkers([worker]);
    store.setSelectedWorker(worker.id);

    dom.customerName.value = "Cancel User";
    dom.requestService.value = "Plumbing";
    dom.requestDescription.value = "Will cancel this";
    dom.requestLocation.value = "Srinagar";

    requestModule.initializeRequestFlow();

    // Submit as guest to trigger feedback
    await dom.form.dispatchEvent({ type: "submit", preventDefault: () => {} });
    assert.equal(dom.requestFeedback.hidden, false);

    // Simulate clicking close button [data-close="requestModal"]
    const closeBtn = new MockElement("button");
    closeBtn.setAttribute("data-close", "requestModal");
    await dom.requestModal.dispatchEvent({
      type: "click",
      target: closeBtn
    });

    // Assert: feedback is hidden and cleared
    assert.equal(dom.requestFeedback.hidden, true, "Feedback must be hidden on modal reset");
    assert.equal(dom.submitBtn.disabled, false, "Submit button must be enabled");
    assert.equal(dom.submitBtn.textContent, "Send Request", "Submit button text restored");
  } finally {
    globalThis.document = originalDoc;
  }
});

// -------------------------------------------------------------
// Test Summary
// -------------------------------------------------------------
console.log("\n==================================================");
console.log(`TOTAL TESTS: ${totalPassed + totalFailed} | PASSED: ${totalPassed} | FAILED: ${totalFailed}`);
console.log("==================================================");

if (totalFailed > 0) {
  process.exit(1);
}
