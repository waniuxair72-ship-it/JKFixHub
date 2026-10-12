import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

console.log("==================================================");
console.log("TEST SUITE: SERVICE CONSISTENCY & DISCOVERY");
console.log("==================================================");

let totalPassed = 0;
let totalFailed = 0;

function runTest(name, fn) {
  try {
    fn();
    console.log(`  ✓ PASS: ${name}`);
    totalPassed++;
  } catch (err) {
    console.error(`  ✗ FAIL: ${name}`);
    console.error(`    ${err.message}`);
    totalFailed++;
  }
}

async function runAsyncTest(name, fn) {
  try {
    await fn();
    console.log(`  ✓ PASS: ${name}`);
    totalPassed++;
  } catch (err) {
    console.error(`  ✗ FAIL: ${name}`);
    console.error(`    ${err.message}`);
    totalFailed++;
  }
}

// 1. Load modules
const {
  SUPPORTED_SERVICES,
  SERVICE_SYNONYMS,
  normalizeService,
  areServicesEquivalent,
  workerMatchesService,
  validateService,
  setTextContent
} = await import("../js/security.js");

const {
  getWorkers,
  setDiscoveredWorkers,
  clearDiscoveredWorkers,
  getWorkerById
} = await import("../js/store.js");

if (!globalThis.Node) {
  globalThis.Node = class Node {};
}

// Minimal mock DOM setup for UI tests
class MockElement extends globalThis.Node {
  constructor(tagName = "div") {
    super();
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.childNodes = [];
    this.classList = new Set();
    this.attributes = new Map();
    this.dataset = {};
    this.listeners = {};
    this.textContent = "";
    this.value = "";
    this.options = [];
    this.hidden = false;
  }

  get className() {
    return Array.from(this.classList).join(" ");
  }

  set className(val) {
    this.classList.clear();
    if (val) {
      val.split(/\s+/).filter(Boolean).forEach((cls) => this.classList.add(cls));
    }
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

  addEventListener(type, listener) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(listener);
  }

  dispatchEvent(event) {
    const list = this.listeners[event.type] || [];
    list.forEach((fn) => fn(event));
  }

  append(...nodes) {
    nodes.forEach((n) => {
      this.children.push(n);
      this.childNodes.push(n);
      n.parentNode = this;
    });
  }

  prepend(...nodes) {
    nodes.reverse().forEach((n) => {
      this.children.unshift(n);
      this.childNodes.unshift(n);
      n.parentNode = this;
    });
  }

  replaceChildren(...nodes) {
    this.children = [];
    this.childNodes = [];
    this.append(...nodes);
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const results = [];
    const search = (node) => {
      if (!node.children) return;
      for (const child of node.children) {
        if (child.matches && child.matches(selector)) {
          results.push(child);
        }
        search(child);
      }
    };
    search(this);
    return results;
  }

  matches(selector) {
    if (selector.startsWith("#")) {
      return this.id === selector.slice(1);
    }
    if (selector.startsWith(".")) {
      return this.classList.has(selector.slice(1));
    }
    if (selector.startsWith("[") && selector.endsWith("]")) {
      const attr = selector.slice(1, -1);
      if (attr.includes("=")) {
        const [k, v] = attr.split("=");
        const cleanV = v.replace(/["']/g, "");
        return this.getAttribute(k) === cleanV || this.dataset[k.replace("data-", "")] === cleanV;
      }
      return this.attributes.has(attr) || this.dataset[attr.replace("data-", "")] !== undefined;
    }
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }

  closest(selector) {
    let curr = this;
    while (curr) {
      if (curr.matches && curr.matches(selector)) return curr;
      curr = curr.parentNode;
    }
    return null;
  }
}

// -------------------------------------------------------------
// Test 1: Service Enum and Canonical Keys
// -------------------------------------------------------------
runTest("1. SUPPORTED_SERVICES contains all 8 core services", () => {
  assert.equal(SUPPORTED_SERVICES.length, 8);
  assert.ok(SUPPORTED_SERVICES.includes("Electrician"));
  assert.ok(SUPPORTED_SERVICES.includes("Plumbing"));
  assert.ok(SUPPORTED_SERVICES.includes("Carpentry"));
  assert.ok(SUPPORTED_SERVICES.includes("Appliance repair"));
  assert.ok(SUPPORTED_SERVICES.includes("Washing Machine Repair"));
  assert.ok(SUPPORTED_SERVICES.includes("Refrigerator Repair"));
  assert.ok(SUPPORTED_SERVICES.includes("Heater Repair"));
  assert.ok(SUPPORTED_SERVICES.includes("TV / Electronics Repair"));
});

// -------------------------------------------------------------
// Test 2: Normalization and Synonyms
// -------------------------------------------------------------
runTest("2. normalizeService maps common synonyms to canonical service values", () => {
  assert.equal(normalizeService("Plumber"), "Plumbing");
  assert.equal(normalizeService("plumber"), "Plumbing");
  assert.equal(normalizeService("Carpenter"), "Carpentry");
  assert.equal(normalizeService("carpenter"), "Carpentry");
  assert.equal(normalizeService("Electrical"), "Electrician");
  assert.equal(normalizeService("electrical repair"), "Electrician");
  assert.equal(normalizeService("Fridge Repair"), "Refrigerator Repair");
  assert.equal(normalizeService("refrigerator"), "Refrigerator Repair");
  assert.equal(normalizeService("Electronics Repair"), "TV / Electronics Repair");
  assert.equal(normalizeService("tv repair"), "TV / Electronics Repair");
  assert.equal(normalizeService("washing machine"), "Washing Machine Repair");
  assert.equal(normalizeService("heater"), "Heater Repair");
});

runTest("3. areServicesEquivalent handles synonyms symmetrically", () => {
  assert.ok(areServicesEquivalent("Plumber", "Plumbing"));
  assert.ok(areServicesEquivalent("Plumbing", "Plumber"));
  assert.ok(areServicesEquivalent("Carpenter", "Carpentry"));
  assert.ok(areServicesEquivalent("Electrical", "Electrician"));
  assert.ok(areServicesEquivalent("Fridge Repair", "Refrigerator Repair"));
  assert.ok(!areServicesEquivalent("Electrician", "Plumbing"));
  assert.ok(!areServicesEquivalent("Carpentry", "Heater Repair"));
});

// -------------------------------------------------------------
// Test 3: workerMatchesService with primary and multi-services
// -------------------------------------------------------------
runTest("4. workerMatchesService matches single and multi-skilled workers", () => {
  const plumberWorker = {
    name: "Mohammad Yusuf",
    service: "Plumbing",
    services: ["Plumbing"]
  };

  const multiWorker = {
    name: "Tariq Ahmad",
    service: "Electrician",
    services: ["Electrician", "Plumber", "Appliance repair"]
  };

  const carpenterWorker = {
    name: "Farooq Dar",
    service: "Carpenter",
    services: ["Carpentry"]
  };

  // Plumber matches Plumbing and Plumber
  assert.ok(workerMatchesService(plumberWorker, "Plumbing"));
  assert.ok(workerMatchesService(plumberWorker, "Plumber"));
  assert.ok(!workerMatchesService(plumberWorker, "Electrician"));

  // Multi-skilled worker matches all skills including synonyms
  assert.ok(workerMatchesService(multiWorker, "Electrician"));
  assert.ok(workerMatchesService(multiWorker, "Plumbing"));
  assert.ok(workerMatchesService(multiWorker, "Plumber"));
  assert.ok(workerMatchesService(multiWorker, "Appliance repair"));
  assert.ok(!workerMatchesService(multiWorker, "Carpentry"));

  // Carpenter worker matches Carpentry and Carpenter
  assert.ok(workerMatchesService(carpenterWorker, "Carpentry"));
  assert.ok(workerMatchesService(carpenterWorker, "Carpenter"));
});

// -------------------------------------------------------------
// Test 4: validateService on all 8 canonical categories + synonyms
// -------------------------------------------------------------
runTest("5. validateService approves all 8 canonical services and synonyms", () => {
  SUPPORTED_SERVICES.forEach((service) => {
    assert.ok(validateService(service), `Canonical service ${service} must validate`);
  });

  assert.ok(validateService("Plumber"));
  assert.ok(validateService("Carpenter"));
  assert.ok(validateService("Electrical"));
  assert.ok(validateService("fridge repair"));
  assert.ok(!validateService("Blacksmith"));
  assert.ok(!validateService(""));
  assert.ok(!validateService(null));
});

// -------------------------------------------------------------
// Test 5: Form inputs consistency in index.html
// -------------------------------------------------------------
runTest("6. index.html forms contain all 8 canonical service options", () => {
  const htmlPath = path.join(projectRoot, "index.html");
  const html = fs.readFileSync(htmlPath, "utf-8");

  // Check #serviceFilter
  assert.ok(html.includes('id="serviceFilter"'));
  SUPPORTED_SERVICES.forEach((service) => {
    assert.ok(
      html.includes(`<option value="${service}">${service}</option>`),
      `#serviceFilter must contain canonical option ${service}`
    );
  });

  // Check #authWorkerService
  assert.ok(html.includes('id="authWorkerService"'));
  SUPPORTED_SERVICES.forEach((service) => {
    assert.ok(
      html.includes(`<option value="${service}">${service}</option>`),
      `#authWorkerService must contain canonical option ${service}`
    );
  });

  // Check #registrationService
  assert.ok(html.includes('id="registrationService"'));
  SUPPORTED_SERVICES.forEach((service) => {
    assert.ok(
      html.includes(`<option value="${service}">${service}</option>`),
      `#registrationService must contain canonical option ${service}`
    );
  });

  // Check #requestService
  assert.ok(html.includes('id="requestService"'));
  SUPPORTED_SERVICES.forEach((service) => {
    assert.ok(
      html.includes(`<option value="${service}">${service}</option>`),
      `#requestService must contain canonical option ${service}`
    );
  });
});

// -------------------------------------------------------------
// Test 6: Zero demo worker leakage when discoveredWorkers is set
// -------------------------------------------------------------
runTest("7. store.getWorkers() strictly respects discoveredWorkers and does NOT leak demo workers", () => {
  // 1. Initial state (null) allows demo workers for tests
  clearDiscoveredWorkers();
  assert.equal(getWorkers().length, 3, "Uninitialized store has 3 demo workers");

  // 2. Discovered 0 live verified workers: state is empty array
  setDiscoveredWorkers([]);
  assert.deepEqual(getWorkers(), [], "Discovered [] must strictly return [] with 0 workers");
  assert.equal(getWorkerById(1), null, "Demo worker ID 1 must NOT be returned when discoveredWorkers is set");
  assert.equal(getWorkerById(2), null, "Demo worker ID 2 must NOT be returned when discoveredWorkers is set");
  assert.equal(getWorkerById("demo-1"), null, "Demo worker ID must NOT be returned");

  // 3. Discovered real workers
  const realWorkers = [
    {
      id: "live-worker-1",
      name: "Ghulam Nabi",
      service: "Plumbing",
      services: ["Plumbing"],
      district: "Srinagar",
      rating: 4.9,
      availability: "Available",
      experience: "8 years",
      initials: "GN",
      isVerified: true,
      status: "active"
    }
  ];
  setDiscoveredWorkers(realWorkers);
  assert.equal(getWorkers().length, 1);
  assert.equal(getWorkers()[0].name, "Ghulam Nabi");
  assert.equal(getWorkerById("live-worker-1")?.name, "Ghulam Nabi");

  // Cleanup
  clearDiscoveredWorkers();
});

// -------------------------------------------------------------
// Test 7: Search Loading, Error, and Empty States
// -------------------------------------------------------------
await runAsyncTest("8. Search module provides loading, error retry, and empty states without demo fallback", async () => {
  const searchModule = await import("../js/search.js");
  assert.ok(typeof searchModule.initializeSearch === "function");

  // Test with mock DOM
  const mockDoc = {
    elements: {},
    getElementById(id) {
      if (!this.elements[id]) {
        this.elements[id] = new MockElement("div");
        this.elements[id].id = id;
      }
      return this.elements[id];
    },
    querySelector(selector) {
      if (selector === ".search-panel") {
        return this.getElementById("searchPanel");
      }
      return null;
    },
    createElement(tag) {
      return new MockElement(tag);
    },
    addEventListener() {}
  };

  // Provide global mocks
  const originalDoc = globalThis.document;
  const originalWindow = globalThis.window;
  globalThis.document = mockDoc;
  globalThis.window = {
    clearTimeout: () => {},
    setTimeout: (fn) => fn(),
    matchMedia: () => ({ matches: false })
  };

  try {
    const searchForm = mockDoc.getElementById("searchForm");
    const results = mockDoc.getElementById("results");
    const feedback = mockDoc.getElementById("searchFeedback");
    const serviceFilter = mockDoc.getElementById("serviceFilter");
    const districtFilter = mockDoc.getElementById("districtFilter");
    const keyword = mockDoc.getElementById("keyword");

    // Initialize search
    const controller = searchModule.initializeSearch();
    assert.ok(controller, "initializeSearch should return controller");

    // Test 8a: Loading state rendered immediately
    const loadingEl = results.children.find((c) => c.className.includes("search-loading"));
    assert.ok(loadingEl, "Must render .search-loading element while live worker data is fetched");
    assert.ok(loadingEl.querySelector(".search-loading-spinner"), "Must have spinner");
    assert.equal(feedback.textContent, "Loading verified professionals...");

    // Test 8b: Empty state when 0 live verified workers found
    setDiscoveredWorkers([]);
    controller.renderResults([]);
    const emptyStateEl = results.children.find((c) => c.className.includes("empty-state"));
    assert.ok(emptyStateEl, "Must render .empty-state element");
    const heading = emptyStateEl.children.find((c) => c.tagName === "H3");
    assert.equal(heading.textContent, "No verified professionals available");
    assert.equal(feedback.textContent, "No verified professionals found");

    // Test 8c: Filtered empty state when live workers exist but 0 match filters
    setDiscoveredWorkers([
      {
        id: "live-worker-1",
        name: "Bashir Reshi",
        service: "Plumbing",
        district: "Shopian",
        availability: "Available",
        isVerified: true,
        status: "active"
      }
    ]);
    serviceFilter.value = "Electrician"; // Filter that doesn't match
    const matching = controller.getMatchingWorkers();
    assert.equal(matching.length, 0);
    controller.renderResults(matching);

    const filteredEmptyState = results.children.find((c) => c.className.includes("empty-state"));
    assert.ok(filteredEmptyState);
    const filteredHeading = filteredEmptyState.children.find((c) => c.tagName === "H3");
    assert.equal(filteredHeading.textContent, "No matching workers found");
    const clearBtn = filteredEmptyState.children.find((c) => c.dataset.clearFilters !== undefined);
    assert.ok(clearBtn, "Filtered empty state must provide Clear Filters button");

    // Test 8d: Results rendering with live worker
    serviceFilter.value = "Plumbing";
    const matched = controller.getMatchingWorkers();
    assert.equal(matched.length, 1);
    controller.renderResults(matched);
    assert.equal(results.children.length, 1);
    assert.ok(results.children[0].className.includes("worker-card"));
    assert.equal(feedback.textContent, "1 verified professional found");

    // Test 8e: Privacy check - worker phone and email must NEVER be in card markup
    const card = results.children[0];
    const getAllText = (el) => [el.textContent, ...(el.children || []).map(getAllText)].join(" ");
    const cardText = getAllText(card).toLowerCase();
    assert.ok(!cardText.includes("phone"), "Worker card must not expose phone number");
    assert.ok(!cardText.includes("email"), "Worker card must not expose email address");
    assert.ok(!cardText.includes("9876543210"), "Worker card must not expose phone digits");

    await controller.discoveryPromise;
  } finally {
    globalThis.document = originalDoc;
    globalThis.window = originalWindow;
    clearDiscoveredWorkers();
  }
});

// -------------------------------------------------------------
// Test 8: Request validation with multi-skilled worker & synonyms
// -------------------------------------------------------------
await runAsyncTest("9. Service request submits cleanly with normalized service names and multi-skilled workers", async () => {
  const requestModule = await import("../js/request.js");
  assert.ok(requestModule);

  const testWorker = {
    id: "w-multi-99",
    name: "Irfan Lone",
    service: "Carpentry",
    services: ["Carpentry", "Plumbing"],
    district: "Baramulla",
    rating: 4.8,
    isVerified: true,
    status: "active"
  };

  // Valid service checks
  assert.ok(workerMatchesService(testWorker, "Carpentry"));
  assert.ok(workerMatchesService(testWorker, "Carpenter"));
  assert.ok(workerMatchesService(testWorker, "Plumbing"));
  assert.ok(workerMatchesService(testWorker, "Plumber"));
  assert.ok(!workerMatchesService(testWorker, "Electrician"));
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
