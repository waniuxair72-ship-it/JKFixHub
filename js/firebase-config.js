// ==========================================
// #FIREBASE_CONFIG
// ==========================================
// Public Firebase Web Client Configuration Boundary.
//
// CRITICAL SECURITY PRINCIPLES:
// 1. Firebase Web configuration parameters (apiKey, authDomain, projectId, appId)
//    are public client-side identifiers for routing to your Firebase project.
// 2. They are NOT server-side secrets.
// 3. SERVER SECRETS MUST NEVER BE COMMITTED OR PLACED IN FRONTEND CODE:
//    - NO Firebase Admin SDK private keys
//    - NO service-account JSON credentials
//    - NO database master secrets
//    - NO backend passwords or private tokens
// 4. In Step 16, Firebase Authentication is the sole Firebase service used.
//    Firestore, Storage, and Cloud Functions belong to Steps 17, 18, and 19.

export const defaultFirebaseConfig = Object.freeze({
  apiKey: "AIzaSyD1NClg5l_ajebC_I16IZjbyYLCvezSefU",
  authDomain: "jkfixhub.firebaseapp.com",
  projectId: "jkfixhub",
  storageBucket: "jkfixhub.firebasestorage.app",
  messagingSenderId: "138841599573",
  appId: "1:138841599573:web:e78eab6c33b33422b92edc",
  measurementId: "G-3DHM457JDH"
});

let runtimeConfig = null;
let initializedApp = null;
let initializedAuth = null;
let initializedFirestore = null;
let testAuthAdapter = null;
let testFirestoreAdapter = null;

/**
 * Returns active Firebase Web configuration.
 * Prioritizes window.__JKFIXHUB_FIREBASE_CONFIG__ if present, otherwise defaultFirebaseConfig.
 */
export function getActiveFirebaseConfig() {
  if (runtimeConfig) {
    return runtimeConfig;
  }
  if (typeof window !== "undefined" && window.__JKFIXHUB_FIREBASE_CONFIG__) {
    return window.__JKFIXHUB_FIREBASE_CONFIG__;
  }
  return defaultFirebaseConfig;
}

/**
 * Allows programmatic configuration injection before initialization.
 * @param {object} config - Valid Firebase Web configuration object.
 */
export function setFirebaseConfig(config) {
  if (!config || typeof config !== "object") {
    throw new TypeError("Firebase configuration must be an object.");
  }
  runtimeConfig = Object.freeze({ ...config });
  initializedApp = null;
  initializedAuth = null;
}

/**
 * Checks whether Firebase Web configuration has valid, non-placeholder credentials.
 * @returns {boolean}
 */
export function isFirebaseConfigured() {
  if (testAuthAdapter) return true;
  const config = getActiveFirebaseConfig();
  return Boolean(
    config &&
    typeof config.apiKey === "string" &&
    config.apiKey.trim().length > 5 &&
    !config.apiKey.includes("YOUR_") &&
    typeof config.projectId === "string" &&
    config.projectId.trim().length > 0 &&
    !config.projectId.includes("YOUR_")
  );
}

/**
 * Injects a testing adapter for unit/integration tests in non-browser or mock environments.
 * @param {object|null} adapter
 */
export function setAuthAdapterForTesting(adapter) {
  testAuthAdapter = adapter;
}

/**
 * Returns test auth adapter if set.
 * @returns {object|null}
 */
export function getTestAuthAdapter() {
  return testAuthAdapter;
}

/**
 * Injects a testing Firestore adapter for unit/integration tests in non-browser or mock environments.
 * @param {object|null} adapter
 */
export function setFirestoreAdapterForTesting(adapter) {
  testFirestoreAdapter = adapter;
}

/**
 * Returns test Firestore adapter if set.
 * @returns {object|null}
 */
export function getTestFirestoreAdapter() {
  return testFirestoreAdapter;
}

let emulatorAuthConnected = false;
let emulatorFirestoreConnected = false;
let inflightFirebaseInitPromise = null;
let inflightFirestoreInitPromise = null;
let testEmulatorHooks = null;

/**
 * Configures window.__FIREBASE_DEFAULTS__ so modular Firebase SDK functions (getAuth, getFirestore)
 * natively connect to local emulator hosts at instantiation time.
 */
function applyGlobalFirebaseEmulatorDefaults() {
  if (typeof window !== "undefined") {
    try {
      window.__FIREBASE_DEFAULTS__ = window.__FIREBASE_DEFAULTS__ || {};
      window.__FIREBASE_DEFAULTS__.emulatorHosts = window.__FIREBASE_DEFAULTS__.emulatorHosts || {};
      window.__FIREBASE_DEFAULTS__.emulatorHosts.auth = "127.0.0.1:9099";
      window.__FIREBASE_DEFAULTS__.emulatorHosts.firestore = "127.0.0.1:8085";
    } catch (_) {}
  }
}

/**
 * Checks whether client should connect to local Firebase Emulators.
 * Activated via:
 * 1. window.__JKFIXHUB_USE_EMULATOR__ === true
 * 2. URL search param or href containing ?useEmulator=true, ?emulator=true, ?useEmulator=1, etc.
 * 3. Persisted in sessionStorage or localStorage across page navigation/reloads
 * 4. Explicitly disabled via ?useEmulator=false
 * @returns {boolean}
 */
export function shouldConnectToEmulator() {
  if (typeof window === "undefined") {
    if (typeof process !== "undefined" && process.env) {
      return (
        process.env.JKFIXHUB_USE_EMULATOR === "true" ||
        Boolean(process.env.FIREBASE_AUTH_EMULATOR_HOST)
      );
    }
    return false;
  }
  if (window.__JKFIXHUB_USE_EMULATOR__ === true) {
    applyGlobalFirebaseEmulatorDefaults();
    return true;
  }
  if (window.__JKFIXHUB_USE_EMULATOR__ === false) return false;

  // Check DOM emulator toggle if present
  try {
    if (typeof document !== "undefined") {
      const toggle = document.getElementById("adminEmulatorToggle");
      if (toggle && toggle.checked) {
        applyGlobalFirebaseEmulatorDefaults();
        return true;
      }
    }
  } catch (_) {}

  try {
    const search = window.location?.search || "";
    const href = window.location?.href || "";
    const hash = window.location?.hash || "";
    const searchParams = new URLSearchParams(search);

    let explicitEnable = false;
    let explicitDisable = false;

    // Check search parameters case-insensitively
    for (const [key, val] of searchParams.entries()) {
      const k = key.toLowerCase();
      const v = String(val).toLowerCase();
      if (k === "useemulator" || k === "emulator") {
        if (v === "true" || v === "1" || v === "yes") explicitEnable = true;
        if (v === "false" || v === "0" || v === "no") explicitDisable = true;
      }
    }

    // Fallback: check href and hash strings
    if (!explicitEnable && !explicitDisable) {
      const fullUrl = (href + " " + hash).toLowerCase();
      if (
        fullUrl.includes("useemulator=true") ||
        fullUrl.includes("emulator=true") ||
        fullUrl.includes("useemulator=1") ||
        fullUrl.includes("emulator=1")
      ) {
        explicitEnable = true;
      } else if (
        fullUrl.includes("useemulator=false") ||
        fullUrl.includes("emulator=false") ||
        fullUrl.includes("useemulator=0") ||
        fullUrl.includes("emulator=0")
      ) {
        explicitDisable = true;
      }
    }

    if (explicitDisable) {
      try {
        sessionStorage.removeItem("jkfixhub_use_emulator");
        localStorage.removeItem("jkfixhub_use_emulator");
      } catch (_) {}
      if (window.__FIREBASE_DEFAULTS__?.emulatorHosts) {
        delete window.__FIREBASE_DEFAULTS__.emulatorHosts.auth;
        delete window.__FIREBASE_DEFAULTS__.emulatorHosts.firestore;
      }
      return false;
    }

    if (explicitEnable) {
      try {
        sessionStorage.setItem("jkfixhub_use_emulator", "true");
        localStorage.setItem("jkfixhub_use_emulator", "true");
      } catch (_) {}
      applyGlobalFirebaseEmulatorDefaults();
      return true;
    }

    // Persisted session or local storage flags across navigation/reloads
    try {
      if (
        sessionStorage.getItem("jkfixhub_use_emulator") === "true" ||
        localStorage.getItem("jkfixhub_use_emulator") === "true"
      ) {
        applyGlobalFirebaseEmulatorDefaults();
        return true;
      }
    } catch (_) {}
  } catch (_) {}

  return false;
}

// Proactively apply emulator defaults at module evaluation time if flag is active
if (typeof window !== "undefined" && shouldConnectToEmulator()) {
  applyGlobalFirebaseEmulatorDefaults();
}

/**
 * Connects an active Firebase Auth instance to the local Auth Emulator
 * using the official supported Firebase SDK connectAuthEmulator() API.
 *
 * Safe and idempotent. Does not mutate internal SDK properties.
 *
 * @param {object|null} auth - Firebase Auth instance.
 * @param {object|null} [methods] - Optional Firebase Auth SDK module methods.
 * @returns {boolean} Whether connectAuthEmulator was attached.
 */
export function connectAuthToEmulator(auth, methods = null) {
  if (!auth) return false;
  if (!shouldConnectToEmulator()) return false;
  if (emulatorAuthConnected) return true;

  try {
    if (testEmulatorHooks?.connectAuthEmulator) {
      testEmulatorHooks.connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
      emulatorAuthConnected = true;
      return true;
    }

    const connectFn = methods?.connectAuthEmulator;
    if (typeof connectFn === "function") {
      connectFn(auth, "http://127.0.0.1:9099", { disableWarnings: true });
      emulatorAuthConnected = true;
      console.log("[JKFixHub Auth Diagnostic] connectAuthEmulator successfully attached to http://127.0.0.1:9099");
      return true;
    }
  } catch (e) {
    // SDK may throw if already configured
    console.warn("[JKFixHub Auth Diagnostic] connectAuthEmulator notice:", e?.message || e);
  }

  return false;
}

// Alias for backward compatibility
export const ensureAuthEmulatorConnected = connectAuthToEmulator;

/**
 * Sets mock emulator hooks for testing.
 * @param {object|null} hooks - { connectAuthEmulator, connectFirestoreEmulator }
 */
export function setEmulatorHooksForTesting(hooks) {
  testEmulatorHooks = hooks;
}

/**
 * Returns current emulator connection state for tests.
 * @returns {{ auth: boolean, firestore: boolean }}
 */
export function isEmulatorConnectedForTesting() {
  return {
    auth: emulatorAuthConnected,
    firestore: emulatorFirestoreConnected
  };
}

/**
 * Resets Firebase client instances and emulator connection state (for testing).
 */
export function resetFirebaseClientForTesting() {
  initializedApp = null;
  initializedAuth = null;
  initializedFirestore = null;
  emulatorAuthConnected = false;
  emulatorFirestoreConnected = false;
  inflightFirebaseInitPromise = null;
  inflightFirestoreInitPromise = null;
  if (typeof window !== "undefined" && window.__FIREBASE_DEFAULTS__?.emulatorHosts) {
    delete window.__FIREBASE_DEFAULTS__.emulatorHosts.auth;
    delete window.__FIREBASE_DEFAULTS__.emulatorHosts.firestore;
  }
}

/**
 * Initializes and returns Firebase App and Auth instances.
 * Dynamically loads the official Firebase modular Web SDK if configured in browser.
 * Gracefully returns null if Firebase is not yet configured or if running offline.
 * Synchronously connects to the Auth Emulator immediately after getAuth() if opt-in flag is active.
 * @returns {Promise<{ app: object|null, auth: object|null, isConfigured: boolean }>}
 */
export async function initializeFirebaseClient() {
  if (testAuthAdapter) {
    if (shouldConnectToEmulator()) {
      ensureAuthEmulatorConnected(testAuthAdapter, null);
    }
    return {
      app: null,
      auth: testAuthAdapter,
      isConfigured: true
    };
  }

  if (!isFirebaseConfigured()) {
    return {
      app: null,
      auth: null,
      isConfigured: false
    };
  }

  if (initializedAuth && initializedApp) {
    if (shouldConnectToEmulator()) {
      ensureAuthEmulatorConnected(initializedAuth, null);
    }
    return {
      app: initializedApp,
      auth: initializedAuth,
      isConfigured: true
    };
  }

  if (inflightFirebaseInitPromise) {
    return inflightFirebaseInitPromise;
  }

  inflightFirebaseInitPromise = (async () => {
    try {
      const config = getActiveFirebaseConfig();
      const { initializeApp, getApps, getApp } = await import(
        "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js"
      );
      const { getAuth, connectAuthEmulator } = await import(
        "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js"
      );

      const apps = getApps();
      initializedApp = apps.length > 0 ? getApp() : initializeApp(config);
      initializedAuth = getAuth(initializedApp);

      // Synchronously connect to Auth Emulator immediately after getAuth()
      if (shouldConnectToEmulator()) {
        ensureAuthEmulatorConnected(initializedAuth, { connectAuthEmulator });
        console.log("[JKFixHub Auth Diagnostic] Connected Firebase Auth to local emulator (http://127.0.0.1:9099)");
      }

      return {
        app: initializedApp,
        auth: initializedAuth,
        isConfigured: true
      };
    } catch (error) {
      console.warn(
        "[JKFixHub] Firebase SDK load deferred or network unavailable. Safe offline fallback active.",
        error?.message || error
      );
      return {
        app: null,
        auth: null,
        isConfigured: false
      };
    } finally {
      inflightFirebaseInitPromise = null;
    }
  })();

  return inflightFirebaseInitPromise;
}

/**
 * Gets currently initialized Firebase Auth instance, or null.
 * @returns {object|null}
 */
export function getFirebaseAuth() {
  if (testAuthAdapter) return testAuthAdapter;
  return initializedAuth;
}

/**
 * Loads and returns Firebase Auth SDK modular functions (or test adapter).
 * @returns {Promise<object|null>}
 */
export async function getFirebaseAuthMethods() {
  if (testAuthAdapter) {
    return testAuthAdapter;
  }
  if (!isFirebaseConfigured()) {
    return null;
  }
  try {
    const authModule = await import(
      "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js"
    );
    return authModule;
  } catch (error) {
    return null;
  }
}

/**
 * Initializes and returns Cloud Firestore instance.
 * Dynamically loads official Firebase modular Firestore Web SDK.
 * Synchronously connects to the Firestore Emulator immediately after getFirestore() if opt-in flag is active.
 * @returns {Promise<{ db: object|null, isConfigured: boolean }>}
 */
export async function initializeFirestoreClient() {
  if (testFirestoreAdapter) {
    if (shouldConnectToEmulator() && !emulatorFirestoreConnected && testEmulatorHooks?.connectFirestoreEmulator) {
      emulatorFirestoreConnected = true;
      testEmulatorHooks.connectFirestoreEmulator(testFirestoreAdapter, "127.0.0.1", 8085);
    }
    return {
      db: testFirestoreAdapter,
      isConfigured: true
    };
  }

  if (!isFirebaseConfigured()) {
    return {
      db: null,
      isConfigured: false
    };
  }

  if (initializedFirestore) {
    return {
      db: initializedFirestore,
      isConfigured: true
    };
  }

  if (inflightFirestoreInitPromise) {
    return inflightFirestoreInitPromise;
  }

  inflightFirestoreInitPromise = (async () => {
    try {
      const { app } = await initializeFirebaseClient();
      if (!app) {
        return { db: null, isConfigured: false };
      }

      const { getFirestore, connectFirestoreEmulator } = await import(
        "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js"
      );

      initializedFirestore = getFirestore(app);

      // Synchronously connect to Firestore Emulator immediately after getFirestore()
      if (shouldConnectToEmulator() && !emulatorFirestoreConnected) {
        emulatorFirestoreConnected = true;
        try {
          if (testEmulatorHooks?.connectFirestoreEmulator) {
            testEmulatorHooks.connectFirestoreEmulator(initializedFirestore, "127.0.0.1", 8085);
          } else if (typeof connectFirestoreEmulator === "function") {
            connectFirestoreEmulator(initializedFirestore, "127.0.0.1", 8085);
            console.log("[JKFixHub] Connected Cloud Firestore to local emulator (127.0.0.1:8085)");
          }
        } catch (e) {
          console.warn("[JKFixHub] Could not connect Firestore emulator:", e?.message || e);
        }
      }

      return {
        db: initializedFirestore,
        isConfigured: true
      };
    } catch (error) {
      console.warn(
        "[JKFixHub] Cloud Firestore SDK load deferred or network unavailable.",
        error?.message || error
      );
      return {
        db: null,
        isConfigured: false
      };
    } finally {
      inflightFirestoreInitPromise = null;
    }
  })();

  return inflightFirestoreInitPromise;
}

/**
 * Gets currently initialized Firestore instance, or null.
 * @returns {object|null}
 */
export function getFirestoreDb() {
  if (testFirestoreAdapter) return testFirestoreAdapter;
  return initializedFirestore;
}

/**
 * Loads and returns Firebase Firestore SDK modular functions (or test adapter).
 * @returns {Promise<object|null>}
 */
export async function getFirestoreMethods() {
  if (testFirestoreAdapter) {
    return testFirestoreAdapter;
  }
  if (!isFirebaseConfigured()) {
    return null;
  }
  try {
    const firestoreModule = await import(
      "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js"
    );
    return firestoreModule;
  } catch (error) {
    return null;
  }
}
