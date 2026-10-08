// ==========================================
// #FUNCTIONS_CLIENT
// ==========================================
// Client-side boundary for Firebase Cloud Functions (2nd Gen) HTTPS Callable calls.
//
// Security & Architecture Principles:
// 1. Client calls trusted backend functions for sensitive status transitions and moderation.
// 2. Production Cloud Functions deployment is intentionally deferred until Blaze upgrade.
// 3. Gracefully detects whether backend functions are reachable (emulator or deployed)
//    without breaking existing Step 1-17 application flows.
// 4. Never fabricates fake production backend success.
// ==========================================

import { initializeFirebaseClient, getActiveFirebaseConfig } from "./firebase-config.js";

let functionsInstance = null;
let functionsModule = null;

/**
 * Initializes Firebase Functions modular SDK client.
 * Returns null gracefully if offline or in development preview.
 * @returns {Promise<object|null>}
 */
export async function getFunctionsClient() {
  if (functionsInstance) return functionsInstance;

  try {
    const { app } = await initializeFirebaseClient();
    if (!app) return null;

    if (!functionsModule) {
      functionsModule = await import(
        "https://www.gstatic.com/firebasejs/10.13.2/firebase-functions.js"
      );
    }

    functionsInstance = functionsModule.getFunctions(app, "us-central1");

    // Connect to local functions emulator if in emulator mode
    if (typeof window !== "undefined" && window.__JKFIXHUB_USE_EMULATORS__) {
      functionsModule.connectFunctionsEmulator(functionsInstance, "127.0.0.1", 5001);
    }

    return functionsInstance;
  } catch (err) {
    console.info(
      "[JKFixHub Functions] Functions SDK deferred (local development mode active).",
      err?.message || err
    );
    return null;
  }
}

/**
 * Invokes an HTTPS Callable function safely.
 * If backend functions are not reachable (production deployment deferred), returns an honest status.
 *
 * @param {string} functionName
 * @param {object} payload
 * @returns {Promise<{ success: boolean, data: any, error: string|null, isBackendConnected: boolean }>}
 */
export async function invokeCallableFunction(functionName, payload = {}) {
  try {
    const functions = await getFunctionsClient();
    if (!functions || !functionsModule) {
      return {
        success: false,
        data: null,
        error: "Cloud Functions backend is in local development mode. Production deployment is deferred.",
        isBackendConnected: false
      };
    }

    const callable = functionsModule.httpsCallable(functions, functionName);
    const result = await callable(payload);
    return {
      success: true,
      data: result.data,
      error: null,
      isBackendConnected: true
    };
  } catch (err) {
    const code = err?.code || "functions/unknown";
    const message = err?.message || "Function call failed.";
    return {
      success: false,
      data: null,
      error: message,
      code,
      isBackendConnected: false
    };
  }
}

// ----------------------------------------------------------------------------
// Request Lifecycle Callables
// ----------------------------------------------------------------------------

export async function callAcceptServiceRequest(requestId) {
  return await invokeCallableFunction("acceptServiceRequest", { requestId });
}

export async function callRejectServiceRequest(requestId, reason = "") {
  return await invokeCallableFunction("rejectServiceRequest", { requestId, reason });
}

export async function callCompleteServiceRequest(requestId) {
  return await invokeCallableFunction("completeServiceRequest", { requestId });
}

export async function callCancelServiceRequest(requestId, reason = "") {
  return await invokeCallableFunction("cancelServiceRequest", { requestId, reason });
}

// ----------------------------------------------------------------------------
// Review & Reputation Callables
// ----------------------------------------------------------------------------

export async function callSubmitReview({ requestId, rating, text }) {
  return await invokeCallableFunction("submitReview", { requestId, rating, text });
}

// ----------------------------------------------------------------------------
// Abuse & Safety Report Callables
// ----------------------------------------------------------------------------

export async function callSubmitReport({ targetType, targetId, reason, description }) {
  return await invokeCallableFunction("submitReport", {
    targetType,
    targetId,
    reason,
    description
  });
}

// ----------------------------------------------------------------------------
// Privileged Administration Callables
// ----------------------------------------------------------------------------

export async function callAdminUpdateWorkerStatus({ workerId, status, isVerified }) {
  return await invokeCallableFunction("adminUpdateWorkerStatus", {
    workerId,
    status,
    isVerified
  });
}

export async function callAdminModerateReport({ reportId, status }) {
  return await invokeCallableFunction("adminModerateReport", { reportId, status });
}

export async function callAdminModerateReview({ reviewId, status }) {
  return await invokeCallableFunction("adminModerateReview", { reviewId, status });
}
