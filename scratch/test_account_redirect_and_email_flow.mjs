/**
 * Focused verification test suite for JKFixHub:
 * 1. Account page redirect prevention & form state resilience.
 * 2. Simplified email verification flow (no sendEmailVerification calls).
 * 3. Worker privacy & public discovery gating integrity.
 * 4. Hash navigation & backdrop click protection.
 */

import assert from "node:assert/strict";

// Mock minimal DOM environment
globalThis.Node = class Node {};

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
  toggle(name, force) {
    if (force !== undefined) {
      if (force) this.classes.add(name);
      else this.classes.delete(name);
      return force;
    }
    if (this.classes.has(name)) {
      this.classes.delete(name);
      return false;
    }
    this.classes.add(name);
    return true;
  }
}

class MockElement extends globalThis.Node {
  constructor(tagName = "div", id = "") {
    super();
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.hidden = false;
    this.value = "";
    this.type = "text";
    this.textContent = "";
    this.className = "";
    this.classList = new MockClassList(this);
    this.attributes = new Map();
    this.listeners = new Map();
    this.children = [];
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
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

  querySelector(sel) {
    if (sel === ".close") return null;
    return null;
  }

  focus() {}
}

const elements = new Map();
function getOrCreateElement(id, tagName = "div") {
  if (!elements.has(id)) {
    const el = new MockElement(tagName, id);
    elements.set(id, el);
  }
  return elements.get(id);
}

// Setup DOM globals
const authModal = getOrCreateElement("authModal", "div");
const authModalCard = new MockElement("div");
authModalCard.className = "modal";
authModal.children.push(authModalCard);

const authEntryView = getOrCreateElement("authEntryView", "section");
const authSignInPanel = getOrCreateElement("authSignInPanel", "section");
const authCustomerRegisterPanel = getOrCreateElement("authCustomerRegisterPanel", "section");
const authWorkerRegisterPanel = getOrCreateElement("authWorkerRegisterPanel", "section");
const authRoleSelection = getOrCreateElement("authRoleSelection", "section");
const authAccountView = getOrCreateElement("authAccountView", "section");
const workerDashboardView = getOrCreateElement("workerDashboardView", "section");
const authSignedOutView = getOrCreateElement("authSignedOutView", "div");

const authFeedback = getOrCreateElement("authFeedback", "div");
const authSuccessFeedback = getOrCreateElement("authSuccessFeedback", "div");
const authUserName = getOrCreateElement("authUserName", "p");
const authUserEmail = getOrCreateElement("authUserEmail", "p");
const authUserRole = getOrCreateElement("authUserRole", "span");
const authEmailVerifiedBadge = getOrCreateElement("authEmailVerifiedBadge", "span");
const authWorkerStatusBadge = getOrCreateElement("authWorkerStatusBadge", "span");
const authEmailVerificationNotice = getOrCreateElement("authEmailVerificationNotice", "div");

globalThis.document = {
  getElementById: (id) => getOrCreateElement(id),
  querySelector: (sel) => {
    if (sel === "#authModal .modal") return authModalCard;
    if (sel === ".modal-backdrop.open") {
      return authModal.classList.contains("open") ? authModal : null;
    }
    return null;
  },
  querySelectorAll: (sel) => {
    if (sel === ".modal-backdrop") return [authModal];
    if (sel === ".modal-backdrop.open") return authModal.classList.contains("open") ? [authModal] : [];
    if (sel === ".auth-modal .request-error") return [];
    if (sel === "[data-toggle-password]") return [];
    return [];
  },
  body: new MockElement("body"),
  addEventListener: () => {}
};

globalThis.window = {
  location: {
    hash: "",
    pathname: "/",
    search: ""
  },
  history: {
    replaceState: (state, title, url) => {
      const hashIndex = url.indexOf("#");
      window.location.hash = hashIndex >= 0 ? url.slice(hashIndex) : "";
    }
  },
  addEventListener: () => {}
};

// CustomEvent stub
globalThis.CustomEvent = class CustomEvent {
  constructor(type, detail = {}) {
    this.type = type;
    this.detail = detail;
  }
};

let testsRun = 0;
let testsPassed = 0;

function runTest(name, fn) {
  testsRun++;
  try {
    fn();
    testsPassed++;
    console.log(`  ✓ PASS: ${name}`);
  } catch (err) {
    console.error(`  ✗ FAIL: ${name}`);
    console.error(err);
  }
}

async function runAsyncTest(name, fn) {
  testsRun++;
  try {
    await fn();
    testsPassed++;
    console.log(`  ✓ PASS: ${name}`);
  } catch (err) {
    console.error(`  ✗ FAIL: ${name}`);
    console.error(err);
  }
}

console.log("==================================================");
console.log("TEST SUITE: ACCOUNT VIEW RESILIENCE & EMAIL FLOW");
console.log("==================================================");

// Import auth and modals modules
const {
  showSignIn,
  showCustomerRegister,
  showWorkerRegister,
  showAuthEntry,
  showSignedOutView,
  getActiveAuthTab,
  handleAuthHashNavigation,
  clearAuthHash,
  registerCustomer,
  registerWorker,
  sendPasswordReset
} = await import("../js/auth.js");

const { openModal, closeModal } = await import("../js/modals.js");
const { setAuthAdapterForTesting, setFirestoreAdapterForTesting, resetFirebaseClientForTesting } = await import("../js/firebase-config.js");
const { getCurrentUser, clearCurrentUser } = await import("../js/store.js");
const { getPublicWorkers } = await import("../js/firestore-service.js");

// 1. Form state resilience tests
runTest("1. showSignIn activates signin panel and does not hide inputs", () => {
  showSignIn();
  assert.equal(getActiveAuthTab(), "signin");
  assert.equal(authSignInPanel.hidden, false);
  assert.equal(authCustomerRegisterPanel.hidden, true);
  assert.equal(authWorkerRegisterPanel.hidden, true);
});

runTest("2. showSignedOutView(true) preserves active signin panel", () => {
  showSignIn();
  showSignedOutView(true);
  assert.equal(getActiveAuthTab(), "signin");
  assert.equal(authSignInPanel.hidden, false);
  assert.equal(authEntryView.hidden, true);
});

runTest("3. showSignedOutView(true) preserves active worker-register panel", () => {
  showWorkerRegister();
  showSignedOutView(true);
  assert.equal(getActiveAuthTab(), "worker-register");
  assert.equal(authWorkerRegisterPanel.hidden, false);
  assert.equal(authEntryView.hidden, true);
});

runTest("4. showSignedOutView(true) preserves active customer-register panel", () => {
  showCustomerRegister();
  showSignedOutView(true);
  assert.equal(getActiveAuthTab(), "customer-register");
  assert.equal(authCustomerRegisterPanel.hidden, false);
  assert.equal(authEntryView.hidden, true);
});

runTest("5. showSignedOutView(false) resets to clean auth entry screen", () => {
  showCustomerRegister();
  showSignedOutView(false);
  assert.equal(getActiveAuthTab(), "entry");
  assert.equal(authEntryView.hidden, false);
  assert.equal(authCustomerRegisterPanel.hidden, true);
});

// 2. Hash routing tests
runTest("6. handleAuthHashNavigation handles #worker-register correctly", () => {
  window.location.hash = "#worker-register";
  handleAuthHashNavigation();
  assert.equal(getActiveAuthTab(), "worker-register");
  assert.equal(authModal.classList.contains("open"), true);
});

runTest("7. handleAuthHashNavigation handles #login correctly", () => {
  window.location.hash = "#login";
  handleAuthHashNavigation();
  assert.equal(getActiveAuthTab(), "signin");
  assert.equal(authSignInPanel.hidden, false);
});

runTest("8. handleAuthHashNavigation handles #register correctly", () => {
  window.location.hash = "#register";
  handleAuthHashNavigation();
  assert.equal(getActiveAuthTab(), "customer-register");
  assert.equal(authCustomerRegisterPanel.hidden, false);
});

runTest("9. clearAuthHash cleans auth hash from URL", () => {
  window.location.hash = "#signin";
  clearAuthHash();
  assert.equal(window.location.hash, "");
});

// 3. Simplified Email Verification: Customer flow
await runAsyncTest("10. Customer registration does NOT call sendEmailVerification", async () => {
  let emailVerificationCalls = 0;
  const mockAuthAdapter = {
    currentUser: null,
    createUserWithEmailAndPassword: async () => {
      return {
        user: {
          uid: "cust-test-101",
          email: "customer@jkfixhub.test",
          emailVerified: false,
          displayName: "Customer Test"
        }
      };
    },
    updateProfile: async () => {},
    sendEmailVerification: async () => {
      emailVerificationCalls++;
    }
  };

  const storedDocs = new Map();
  const mockFirestoreAdapter = {
    doc: (db, col, id) => `${col}/${id}`,
    setDoc: async (docRef, data) => {
      storedDocs.set(docRef, data);
    },
    getDoc: async (docRef) => ({
      exists: () => storedDocs.has(docRef),
      data: () => storedDocs.get(docRef)
    })
  };

  setAuthAdapterForTesting(mockAuthAdapter);
  setFirestoreAdapterForTesting(mockFirestoreAdapter);

  const res = await registerCustomer({
    name: "Customer Test",
    email: "customer@jkfixhub.test",
    phone: "9876543210",
    district: "Srinagar",
    password: "Password123!",
    confirmPassword: "Password123!"
  });

  assert.equal(res.success, true);
  assert.equal(emailVerificationCalls, 0, "sendEmailVerification must NOT be called");

  const current = getCurrentUser();
  assert.equal(current.role, "customer");
  assert.equal(current.emailVerified, false);

  // Check Firestore user doc
  const userDoc = storedDocs.get("users/cust-test-101");
  assert.ok(userDoc);
  assert.equal(userDoc.email, "customer@jkfixhub.test");
  assert.equal(userDoc.phone, "9876543210");
  assert.equal(userDoc.role, "customer");

  // Check success feedback does not mention verification email sent
  assert.match(authSuccessFeedback.textContent, /Account created!/);
  assert.doesNotMatch(authSuccessFeedback.textContent, /verification email has been sent/i);
});

// 4. Simplified Email Verification: Worker flow & Discovery gating
await runAsyncTest("11. Worker registration does NOT call sendEmailVerification and remains pending", async () => {
  let emailVerificationCalls = 0;
  const mockAuthAdapter = {
    currentUser: null,
    createUserWithEmailAndPassword: async () => {
      return {
        user: {
          uid: "wrk-test-202",
          email: "worker@jkfixhub.test",
          emailVerified: false,
          displayName: "Technician Bashir"
        }
      };
    },
    updateProfile: async () => {},
    sendEmailVerification: async () => {
      emailVerificationCalls++;
    }
  };

  const storedDocs = new Map();
  const mockFirestoreAdapter = {
    doc: (db, col, id) => `${col}/${id}`,
    setDoc: async (docRef, data) => {
      storedDocs.set(docRef, data);
    },
    getDoc: async (docRef) => ({
      exists: () => storedDocs.has(docRef),
      data: () => storedDocs.get(docRef)
    }),
    collection: (db, name) => name,
    query: (col, ...constraints) => ({ col, constraints }),
    where: (f, op, v) => ({ f, op, v }),
    getDocs: async (q) => {
      // Simulate public discovery query: where('isVerified', '==', true), where('status', '==', 'active')
      const results = [];
      for (const [key, val] of storedDocs.entries()) {
        if (key.startsWith("workers/")) {
          if (val.isVerified === true && val.status === "active") {
            results.push({ id: val.id || val.uid, data: () => val });
          }
        }
      }
      return {
        docs: results,
        forEach: (fn) => results.forEach(fn),
        empty: results.length === 0,
        size: results.length
      };
    }
  };

  setAuthAdapterForTesting(mockAuthAdapter);
  setFirestoreAdapterForTesting(mockFirestoreAdapter);

  const res = await registerWorker({
    name: "Technician Bashir",
    email: "worker@jkfixhub.test",
    phone: "9876543211",
    district: "Shopian",
    service: "Electrician",
    experience: "5 years",
    availability: "Available",
    password: "Password123!",
    confirmPassword: "Password123!"
  });

  assert.equal(res.success, true);
  assert.equal(emailVerificationCalls, 0, "sendEmailVerification must NOT be called for worker");

  // Check worker profile in /workers/{uid}
  const workerDoc = storedDocs.get("workers/wrk-test-202");
  assert.ok(workerDoc);
  assert.equal(workerDoc.isVerified, false, "Newly registered worker must NOT be verified");
  assert.equal(workerDoc.status, "pending", "Newly registered worker status must be pending");
  assert.equal("email" in workerDoc, false, "email MUST NOT exist in /workers/{uid}");
  assert.equal("phone" in workerDoc, false, "phone MUST NOT exist in /workers/{uid}");

  // Check user doc in /users/{uid}
  const userDoc = storedDocs.get("users/wrk-test-202");
  assert.ok(userDoc);
  assert.equal(userDoc.email, "worker@jkfixhub.test");
  assert.equal(userDoc.phone, "9876543211");
  assert.equal(userDoc.role, "worker");

  // Check discovery gating: public query MUST NOT return the pending worker
  const publicWorkers = await getPublicWorkers();
  const foundWorker = publicWorkers.find((w) => w.id === "wrk-test-202" || w.uid === "wrk-test-202");
  assert.equal(foundWorker, undefined, "Pending worker must NOT be discoverable in public search");

  // Check success feedback message
  assert.match(authSuccessFeedback.textContent, /Pending administrative verification/i);
  assert.doesNotMatch(authSuccessFeedback.textContent, /check your email for verification/i);
});

// 5. Password Reset Helper Test
await runAsyncTest("12. sendPasswordReset invokes sendPasswordResetEmail with valid email", async () => {
  let resetEmailTarget = null;
  const mockAuthAdapter = {
    currentUser: null,
    sendPasswordResetEmail: async (auth, email) => {
      resetEmailTarget = email;
    }
  };

  setAuthAdapterForTesting(mockAuthAdapter);

  const invalidRes = await sendPasswordReset("invalid-email");
  assert.equal(invalidRes.success, false);

  const validRes = await sendPasswordReset("customer@jkfixhub.test");
  assert.equal(validRes.success, true);
  assert.equal(resetEmailTarget, "customer@jkfixhub.test");
});

// 6. Backdrop click dismiss protection
const { initializeModalHandlers } = await import("../js/modals.js");
initializeModalHandlers();

runTest("13. Dragging/selecting from inside modal does NOT dismiss modal on mouseup", () => {
  openModal("authModal");
  assert.equal(authModal.classList.contains("open"), true);

  // Pointerdown inside modal content
  authModal.dispatchEvent({ type: "pointerdown", target: authModalCard });
  // Click bubbles up to backdrop
  authModal.dispatchEvent({ type: "click", target: authModal });

  assert.equal(authModal.classList.contains("open"), true, "Modal must remain open after drag/selection release");
});

runTest("14. Direct backdrop click successfully closes modal", () => {
  openModal("authModal");
  assert.equal(authModal.classList.contains("open"), true);

  // Pointerdown directly on backdrop
  authModal.dispatchEvent({ type: "pointerdown", target: authModal });
  // Click on backdrop
  authModal.dispatchEvent({ type: "click", target: authModal });

  assert.equal(authModal.classList.contains("open"), false, "Modal should close on intentional backdrop click");
});

// Reset test adapters
resetFirebaseClientForTesting();
setAuthAdapterForTesting(null);
setFirestoreAdapterForTesting(null);
clearCurrentUser();

console.log("==================================================");
console.log(`TOTAL TESTS: ${testsRun} | PASSED: ${testsPassed} | FAILED: ${testsRun - testsPassed}`);
console.log("==================================================");

if (testsRun !== testsPassed) {
  process.exit(1);
}
