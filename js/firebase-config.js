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

/**
 * Initializes and returns Firebase App and Auth instances.
 * Dynamically loads the official Firebase modular Web SDK if configured in browser.
 * Gracefully returns null if Firebase is not yet configured or if running offline.
 * @returns {Promise<{ app: object|null, auth: object|null, isConfigured: boolean }>}
 */
export async function initializeFirebaseClient() {
  if (testAuthAdapter) {
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
    return {
      app: initializedApp,
      auth: initializedAuth,
      isConfigured: true
    };
  }

  try {
    const config = getActiveFirebaseConfig();
    const { initializeApp, getApps, getApp } = await import(
      "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js"
    );
    const { getAuth } = await import(
      "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js"
    );

    const apps = getApps();
    initializedApp = apps.length > 0 ? getApp() : initializeApp(config);
    initializedAuth = getAuth(initializedApp);

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
  }
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
 * @returns {Promise<{ db: object|null, isConfigured: boolean }>}
 */
export async function initializeFirestoreClient() {
  if (testFirestoreAdapter) {
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

  try {
    const { app } = await initializeFirebaseClient();
    if (!app) {
      return { db: null, isConfigured: false };
    }

    const { getFirestore } = await import(
      "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js"
    );

    initializedFirestore = getFirestore(app);
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
  }
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
