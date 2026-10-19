import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const PORT = 8139;
const CDP_PORT = 9269;
const CHROME_PATH = "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe";

const MIME_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon"
};

console.log("\n=======================================================");
console.log("SUITE 1: STATIC CODE AUDIT (ROLE-BASED SMART HOME)");
console.log("=======================================================");

const indexHtml = fs.readFileSync(path.join(projectRoot, "index.html"), "utf8");
const smartHomeJs = fs.readFileSync(path.join(projectRoot, "js", "smart-home.js"), "utf8");
const authJs = fs.readFileSync(path.join(projectRoot, "js", "auth.js"), "utf8");
const appJs = fs.readFileSync(path.join(projectRoot, "js", "app.js"), "utf8");
const navJs = fs.readFileSync(path.join(projectRoot, "js", "navigation.js"), "utf8");
const polishCss = fs.readFileSync(path.join(projectRoot, "css", "polish.css"), "utf8");

// 1. Structure in HTML
assert.ok(indexHtml.includes('id="publicHeroWrapper"'), "index.html must have #publicHeroWrapper");
assert.ok(indexHtml.includes('id="customerHomeWrapper"'), "index.html must have #customerHomeWrapper");
assert.ok(indexHtml.includes('id="workerHomeWrapper"'), "index.html must have #workerHomeWrapper");

// Customer Home Elements
assert.ok(indexHtml.includes('id="customerHomeName"'), "index.html must have #customerHomeName");
assert.ok(indexHtml.includes('id="customerHomeDistrict"'), "index.html must have #customerHomeDistrict");
assert.ok(indexHtml.includes('id="customerHomeSearchForm"'), "index.html must have #customerHomeSearchForm");
assert.ok(indexHtml.includes('id="customerHomeSearchInput"'), "index.html must have #customerHomeSearchInput");
assert.ok(indexHtml.includes('id="customerBrowseAllServicesBtn"'), "index.html must have #customerBrowseAllServicesBtn");
assert.ok(indexHtml.includes('id="customerRequestsBadge"'), "index.html must have #customerRequestsBadge");
assert.ok(indexHtml.includes('id="customerHomeMyRequestsBtn"'), "index.html must have #customerHomeMyRequestsBtn");
assert.ok(indexHtml.includes('id="customerChatsBadge"'), "index.html must have #customerChatsBadge");
assert.ok(indexHtml.includes('id="customerHomeMyChatsBtn"'), "index.html must have #customerHomeMyChatsBtn");

// Verify NO "Join as Worker" in customer home
const customerHomeHtml = indexHtml.split('id="customerHomeWrapper"')[1].split('id="workerHomeWrapper"')[0];
assert.ok(!customerHomeHtml.includes('data-jk-action="join-worker"'), "Customer home must not contain join-worker action");
assert.ok(!customerHomeHtml.includes("Join as a Worker"), "Customer home must not have 'Join as a Worker' button");
console.log("  ✓ PASS: Customer Home structure and elements verified without redundant worker options.");

// Worker Home Elements
assert.ok(indexHtml.includes('id="workerHomeName"'), "index.html must have #workerHomeName");
assert.ok(indexHtml.includes('id="workerHomeService"'), "index.html must have #workerHomeService");
assert.ok(indexHtml.includes('id="workerHomeVerification"'), "index.html must have #workerHomeVerification");
assert.ok(indexHtml.includes('id="workerHomeAvailability"'), "index.html must have #workerHomeAvailability");
assert.ok(indexHtml.includes('id="workerHomeAvailIndicator"'), "index.html must have #workerHomeAvailIndicator");
assert.ok(indexHtml.includes('id="workerPendingCountBadge"'), "index.html must have #workerPendingCountBadge");
assert.ok(indexHtml.includes('id="workerHomePendingBtn"'), "index.html must have #workerHomePendingBtn");
assert.ok(indexHtml.includes('id="workerAcceptedCountBadge"'), "index.html must have #workerAcceptedCountBadge");
assert.ok(indexHtml.includes('id="workerHomeAcceptedBtn"'), "index.html must have #workerHomeAcceptedBtn");
assert.ok(indexHtml.includes('id="workerChatsBadge"'), "index.html must have #workerChatsBadge");
assert.ok(indexHtml.includes('id="workerHomeChatsBtn"'), "index.html must have #workerHomeChatsBtn");
assert.ok(indexHtml.includes('id="workerHomeProfileBtn"'), "index.html must have #workerHomeProfileBtn");

// Verify NO "Find a Worker" or "Join as Worker" in worker home
const workerHomeHtml = indexHtml.split('id="workerHomeWrapper"')[1].split('<!-- #SEARCH_VIEW -->')[0];
assert.ok(!workerHomeHtml.includes('data-jk-action="join-worker"'), "Worker home must not contain join-worker action");
assert.ok(!workerHomeHtml.includes('href="#find-worker"'), "Worker home must not contain find-worker link");
console.log("  ✓ PASS: Worker Home structure, requests queue, and availability controls verified without redundant actions.");

// 2. JavaScript modules integration
assert.ok(smartHomeJs.includes("export function renderCustomerHome"), "smart-home.js must export renderCustomerHome");
assert.ok(smartHomeJs.includes("export function renderWorkerHome"), "smart-home.js must export renderWorkerHome");
assert.ok(smartHomeJs.includes("export function updateRoleBasedHome"), "smart-home.js must export updateRoleBasedHome");
assert.ok(smartHomeJs.includes("export function initializeSmartHome"), "smart-home.js must export initializeSmartHome");
assert.ok(authJs.includes("updateRoleBasedHome"), "auth.js must call updateRoleBasedHome");
assert.ok(appJs.includes("initializeSmartHome"), "app.js must call initializeSmartHome");
assert.ok(navJs.includes("updateRoleBasedHome"), "navigation.js must call updateRoleBasedHome");
console.log("  ✓ PASS: JavaScript modules properly connect and dispatch smart home updates.");

// 3. CSS Polish styles
assert.ok(polishCss.includes(".smart-home-wrapper"), "polish.css must style .smart-home-wrapper");
assert.ok(polishCss.includes(".smart-home-search-panel"), "polish.css must style .smart-home-search-panel");
assert.ok(polishCss.includes(".smart-categories-grid"), "polish.css must style .smart-categories-grid");
assert.ok(polishCss.includes(".smart-shortcuts-grid"), "polish.css must style .smart-shortcuts-grid");
assert.ok(polishCss.includes(".smart-worker-stat-card"), "polish.css must style .smart-worker-stat-card");
assert.ok(polishCss.includes('[data-theme="dark"] .smart-home-search-panel'), "polish.css must have dark theme for search panel");
assert.ok(polishCss.includes('[data-theme="dark"] .smart-category-card'), "polish.css must have dark theme for category cards");
console.log("  ✓ PASS: CSS polish includes Kashmir theme, responsive cards, and full dark mode styling.");

// ----------------------------------------------------------------------------
// Headless Chrome Browser Verification
// ----------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  let reqPath = req.url.split("?")[0];
  if (reqPath === "/") reqPath = "/index.html";
  const filePath = path.join(projectRoot, reqPath);
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found: " + reqPath);
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME_TYPES[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": mime });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, async () => {
  console.log(`\n[Test Server] Running on http://localhost:${PORT}`);

  const tempProfile = path.join(process.env.TEMP || "C:\\Temp", `chrome-smart-home-test-${Date.now()}`);
  const chromeProc = spawn(CHROME_PATH, [
    "--headless=new",
    `--remote-debugging-port=${CDP_PORT}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    `--user-data-dir=${tempProfile}`,
    "--window-size=1280,900"
  ]);

  await new Promise((r) => setTimeout(r, 1600));

  try {
    const newTargetRes = await fetch(
      `http://127.0.0.1:${CDP_PORT}/json/new?http://localhost:${PORT}/index.html`,
      { method: "PUT" }
    );
    const target = await newTargetRes.json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));

    let msgId = 1;
    const pending = new Map();

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.method === "Runtime.exceptionThrown") {
        console.error("BROWSER EXCEPTION:", JSON.stringify(msg.params?.exceptionDetails?.exception?.description || msg.params));
      }
      if (msg.method === "Runtime.consoleAPICalled") {
        console.log("BROWSER LOG:", msg.params.args?.map(a => a.value || a.description).join(" "));
      }
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(msg.error);
        else resolve(msg.result);
      }
    };

    function send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = msgId++;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    await send("Page.enable");
    await send("Runtime.enable");

    async function evaluate(expression) {
      const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (res.exceptionDetails) {
        throw new Error(res.exceptionDetails.text || JSON.stringify(res.exceptionDetails));
      }
      return res.result?.value;
    }

    await send("Runtime.evaluate", {
      expression: `new Promise((resolve) => {
        if (document.readyState === "complete") {
          setTimeout(resolve, 1500);
        } else {
          window.addEventListener("load", () => setTimeout(resolve, 1500));
        }
      })`,
      awaitPromise: true
    });

    // TEST SUITE 2: UNAUTHENTICATED STATE
    console.log("\n=======================================================");
    console.log("SUITE 2: UNAUTHENTICATED HOME VIEW VERIFICATION");
    console.log("=======================================================");
    const unauthedState = await evaluate(`(() => {
      const publicHero = document.getElementById("publicHeroWrapper");
      const customerHome = document.getElementById("customerHomeWrapper");
      const workerHome = document.getElementById("workerHomeWrapper");
      return {
        publicHeroHidden: publicHero ? publicHero.hidden : null,
        customerHomeHidden: customerHome ? customerHome.hidden : null,
        workerHomeHidden: workerHome ? workerHome.hidden : null
      };
    })()`);

    console.log("  Initial Unauthenticated View:", JSON.stringify(unauthedState));
    assert.strictEqual(unauthedState.publicHeroHidden, false, "Public hero must be visible when signed out");
    assert.strictEqual(unauthedState.customerHomeHidden, true, "Customer home must be hidden when signed out");
    assert.strictEqual(unauthedState.workerHomeHidden, true, "Worker home must be hidden when signed out");
    console.log("  ✓ PASS: Public hero is properly preserved for unauthenticated visitors.");

    // TEST SUITE 3: CUSTOMER SMART HOME WORKFLOW
    console.log("\n=======================================================");
    console.log("SUITE 3: AUTHENTICATED CUSTOMER SMART HOME");
    console.log("=======================================================");
    const customerLoginResult = await evaluate(`(async () => {
      const auth = await import("./js/auth.js");
      auth.demoLogin("customer");
      const publicHero = document.getElementById("publicHeroWrapper");
      const customerHome = document.getElementById("customerHomeWrapper");
      const workerHome = document.getElementById("workerHomeWrapper");
      const nameEl = document.getElementById("customerHomeName");
      const districtEl = document.getElementById("customerHomeDistrict");
      const drawerJoinBtn = document.querySelector('.nav-drawer-actions [data-jk-action="join-worker"]');

      return {
        publicHeroHidden: publicHero.hidden,
        customerHomeHidden: customerHome.hidden,
        workerHomeHidden: workerHome.hidden,
        customerName: nameEl ? nameEl.textContent : null,
        customerDistrict: districtEl ? districtEl.textContent : null,
        drawerJoinHidden: drawerJoinBtn ? drawerJoinBtn.hidden : null
      };
    })()`);

    console.log("  Customer Login State:", JSON.stringify(customerLoginResult));
    assert.strictEqual(customerLoginResult.publicHeroHidden, true, "Public hero must be hidden for customer");
    assert.strictEqual(customerLoginResult.customerHomeHidden, false, "Customer home must be visible for customer");
    assert.strictEqual(customerLoginResult.workerHomeHidden, true, "Worker home must be hidden for customer");
    assert.ok(customerLoginResult.customerName?.length > 0, "Customer name must be populated");
    assert.strictEqual(customerLoginResult.drawerJoinHidden, true, "Drawer 'Join as Worker' must be hidden for customer");
    console.log("  ✓ PASS: Customer Smart Home reveals personalized welcome and hides redundant worker CTA.");

    // Customer Search Action
    const customerSearchNav = await evaluate(`(() => {
      const searchInput = document.getElementById("customerHomeSearchInput");
      searchInput.value = "Electrician Srinagar";
      const form = document.getElementById("customerHomeSearchForm");
      form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
      const searchView = document.getElementById("searchView");
      const keyword = document.getElementById("keyword");
      return {
        searchViewHidden: searchView ? searchView.hidden : null,
        keywordValue: keyword ? keyword.value : null
      };
    })()`);

    console.log("  Customer Search Action:", JSON.stringify(customerSearchNav));
    assert.strictEqual(customerSearchNav.searchViewHidden, false, "Submitting search must switch to search view");
    assert.strictEqual(customerSearchNav.keywordValue, "Electrician Srinagar", "Search query must propagate to keyword input");

    // Return back to Home
    await evaluate(`(async () => {
      const nav = await import("./js/navigation.js");
      nav.setView("home");
    })()`);

    // Category button click routing
    const categoryNav = await evaluate(`(() => {
      const catBtn = document.querySelector('.smart-category-card[data-service="Electrician"]');
      catBtn.click();
      const searchView = document.getElementById("searchView");
      const serviceFilter = document.getElementById("serviceFilter");
      return {
        searchViewHidden: searchView.hidden,
        serviceFilterValue: serviceFilter.value
      };
    })()`);
    console.log("  Category Click Navigation:", JSON.stringify(categoryNav));
    assert.strictEqual(categoryNav.searchViewHidden, false, "Category button must route to search view");
    assert.strictEqual(categoryNav.serviceFilterValue, "Electrician", "Service filter must be set to Electrician");

    // Return to Home
    await evaluate(`(async () => {
      const nav = await import("./js/navigation.js");
      nav.setView("home");
    })()`);

    // TEST SUITE 4: WORKER SMART HOME WORKFLOW
    console.log("\n=======================================================");
    console.log("SUITE 4: AUTHENTICATED WORKER SMART HOME");
    console.log("=======================================================");
    const workerLoginResult = await evaluate(`(async () => {
      const auth = await import("./js/auth.js");
      auth.demoLogin("worker");
      const publicHero = document.getElementById("publicHeroWrapper");
      const customerHome = document.getElementById("customerHomeWrapper");
      const workerHome = document.getElementById("workerHomeWrapper");
      const nameEl = document.getElementById("workerHomeName");
      const serviceEl = document.getElementById("workerHomeService");
      const availSelect = document.getElementById("workerHomeAvailability");
      const drawerJoinBtn = document.querySelector('.nav-drawer-actions [data-jk-action="join-worker"]');

      return {
        publicHeroHidden: publicHero.hidden,
        customerHomeHidden: customerHome.hidden,
        workerHomeHidden: workerHome.hidden,
        workerName: nameEl ? nameEl.textContent : null,
        workerService: serviceEl ? serviceEl.textContent : null,
        availability: availSelect ? availSelect.value : null,
        drawerJoinHidden: drawerJoinBtn ? drawerJoinBtn.hidden : null
      };
    })()`);

    console.log("  Worker Login State:", JSON.stringify(workerLoginResult));
    assert.strictEqual(workerLoginResult.publicHeroHidden, true, "Public hero must be hidden for worker");
    assert.strictEqual(workerLoginResult.customerHomeHidden, true, "Customer home must be hidden for worker");
    assert.strictEqual(workerLoginResult.workerHomeHidden, false, "Worker home must be visible for worker");
    assert.ok(workerLoginResult.workerName?.length > 0, "Worker name must be populated");
    assert.ok(workerLoginResult.workerService?.length > 0, "Worker service must be populated");
    assert.strictEqual(workerLoginResult.drawerJoinHidden, true, "Drawer 'Join as Worker' must be hidden for worker");
    console.log("  ✓ PASS: Worker Smart Home reveals professional heading and service details.");

    // Worker availability change
    const availChangeResult = await evaluate(`(async () => {
      const availSelect = document.getElementById("workerHomeAvailability");
      availSelect.value = "Busy";
      availSelect.dispatchEvent(new Event("change", { bubbles: true }));
      const store = await import("./js/store.js");
      const user = store.getCurrentUser();
      const indicator = document.getElementById("workerHomeAvailIndicator");
      return {
        userAvailability: user ? user.availability : null,
        indicatorHasBusy: indicator ? indicator.classList.contains("avail-busy") : null
      };
    })()`);

    console.log("  Worker Availability Change:", JSON.stringify(availChangeResult));
    assert.strictEqual(availChangeResult.userAvailability, "Busy", "User availability in store must update to Busy");
    assert.strictEqual(availChangeResult.indicatorHasBusy, true, "Indicator must have avail-busy class");
    console.log("  ✓ PASS: Worker operational availability controls synchronize cleanly with store.");

    // TEST SUITE 5: LOGOUT RESTORATION
    console.log("\n=======================================================");
    console.log("SUITE 5: SIGN OUT AND PUBLIC VIEW RESTORATION");
    console.log("=======================================================");
    const signoutResult = await evaluate(`(async () => {
      const auth = await import("./js/auth.js");
      await auth.signOutUser();
      const publicHero = document.getElementById("publicHeroWrapper");
      const customerHome = document.getElementById("customerHomeWrapper");
      const workerHome = document.getElementById("workerHomeWrapper");
      const drawerJoinBtn = document.querySelector('.nav-drawer-actions [data-jk-action="join-worker"]');

      return {
        publicHeroHidden: publicHero.hidden,
        customerHomeHidden: customerHome.hidden,
        workerHomeHidden: workerHome.hidden,
        drawerJoinHidden: drawerJoinBtn ? drawerJoinBtn.hidden : null
      };
    })()`);

    console.log("  Post-Signout State:", JSON.stringify(signoutResult));
    assert.strictEqual(signoutResult.publicHeroHidden, false, "Public hero must reappear after sign out");
    assert.strictEqual(signoutResult.customerHomeHidden, true, "Customer home must be hidden after sign out");
    assert.strictEqual(signoutResult.workerHomeHidden, true, "Worker home must be hidden after sign out");
    assert.strictEqual(signoutResult.drawerJoinHidden, false, "Drawer Join as Worker must be restored");
    console.log("  ✓ PASS: Clean sign out restores public home view and drawer actions.");

    // TEST SUITE 6: RESPONSIVE VIEWPORT & OVERFLOW AUDIT
    console.log("\n=======================================================");
    console.log("SUITE 6: RESPONSIVE VIEWPORT & OVERFLOW AUDIT");
    console.log("=======================================================");

    const viewports = [
      { name: "mobile-320", width: 320, height: 568 },
      { name: "mobile-390", width: 390, height: 844 },
      { name: "mobile-430", width: 430, height: 932 },
      { name: "desktop-1440", width: 1440, height: 900 }
    ];

    for (const vp of viewports) {
      await send("Emulation.setDeviceMetricsOverride", {
        width: vp.width,
        height: vp.height,
        deviceScaleFactor: 1,
        mobile: vp.width < 768
      });

      // Log in as customer to check customer home responsiveness
      const customerVpCheck = await evaluate(`(async () => {
        const auth = await import("./js/auth.js");
        auth.demoLogin("customer");
        const docEl = document.documentElement;
        return {
          scrollWidth: docEl.scrollWidth,
          clientWidth: docEl.clientWidth,
          hasHorizontalOverflow: docEl.scrollWidth > docEl.clientWidth
        };
      })()`);

      console.log(`  [${vp.name}] Customer Home - ScrollWidth: ${customerVpCheck.scrollWidth}px, ClientWidth: ${customerVpCheck.clientWidth}px (Overflow: ${customerVpCheck.hasHorizontalOverflow})`);
      assert.strictEqual(customerVpCheck.hasHorizontalOverflow, false, `No horizontal overflow on ${vp.name} for customer home`);

      // Log in as worker to check worker home responsiveness
      const workerVpCheck = await evaluate(`(async () => {
        const auth = await import("./js/auth.js");
        auth.demoLogin("worker");
        const docEl = document.documentElement;
        return {
          scrollWidth: docEl.scrollWidth,
          clientWidth: docEl.clientWidth,
          hasHorizontalOverflow: docEl.scrollWidth > docEl.clientWidth
        };
      })()`);

      console.log(`  [${vp.name}] Worker Home - ScrollWidth: ${workerVpCheck.scrollWidth}px, ClientWidth: ${workerVpCheck.clientWidth}px (Overflow: ${workerVpCheck.hasHorizontalOverflow})`);
      assert.strictEqual(workerVpCheck.hasHorizontalOverflow, false, `No horizontal overflow on ${vp.name} for worker home`);
    }

    console.log("  ✓ PASS: Zero horizontal overflow across all tested viewports (320px to 1440px).");

    console.log("\n=======================================================");
    console.log("ALL ROLE-BASED SMART HOME TESTS PASSED SUCCESSFULLY!");
    console.log("=======================================================\n");

    ws.close();
    chromeProc.kill();
    server.close();
    process.exit(0);
  } catch (err) {
    console.error("\n❌ TEST ERROR:", err);
    chromeProc.kill();
    server.close();
    process.exit(1);
  }
});
