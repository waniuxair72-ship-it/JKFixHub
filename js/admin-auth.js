// ==========================================
// #ADMIN_AUTH
// ==========================================
// Authoritative Admin Authentication & Session Boundary.
//
// CRITICAL SECURITY PRINCIPLES:
// 1. Authenticates against Firebase Authentication.
// 2. Authorizes ONLY against the Cloud Firestore /admins/{uid} collection.
// 3. If a Firebase user signs in but has no active admin document in Firestore,
//    the session is IMMEDIATELY terminated (signOut) and access is denied.
// 4. No sensitive information or user existence is disclosed to unauthorized users.
// ==========================================

import {
  initializeFirebaseClient,
  getFirebaseAuth,
  getFirebaseAuthMethods
} from "./firebase-config.js";
import { verifyAdminAuthorization, recordAdminAuditLog } from "./firestore-service.js";

let currentAdminSession = null;
const authSubscribers = new Set();

/**
 * Returns currently active in-memory Admin session, or null.
 * @returns {object|null}
 */
export function getAdminSession() {
  return currentAdminSession ? { ...currentAdminSession } : null;
}

/**
 * Checks whether an active admin session possesses a specific capability.
 * @param {string} capability
 * @returns {boolean}
 */
export function hasAdminCapability(capability) {
  if (!currentAdminSession || !Array.isArray(currentAdminSession.capabilities)) {
    return false;
  }
  return currentAdminSession.capabilities.includes(capability);
}

/**
 * Subscribes to admin authentication lifecycle changes.
 * @param {Function} callback - Called with admin session object or null.
 * @returns {Function} Unsubscribe function.
 */
export function subscribeAdminAuthState(callback) {
  if (typeof callback !== "function") return () => {};
  authSubscribers.add(callback);
  callback(currentAdminSession ? { ...currentAdminSession } : null);

  return () => {
    authSubscribers.delete(callback);
  };
}

function notifySubscribers(session) {
  for (const cb of authSubscribers) {
    try {
      cb(session ? { ...session } : null);
    } catch (e) {
      console.warn("[JKFixHub AdminAuth] Subscriber error:", e);
    }
  }
}

/**
 * Authenticates an administrator using Firebase Authentication and validates
 * their server-side document in /admins/{uid}.
 *
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{ success: boolean, admin: object|null, error: string|null }>}
 */
export async function signInAdmin(email, password) {
  if (!email || typeof email !== "string" || !password || typeof password !== "string") {
    return {
      success: false,
      admin: null,
      error: "Please enter both email and password."
    };
  }

  try {
    const { auth } = await initializeFirebaseClient();
    const methods = await getFirebaseAuthMethods();

    if (!auth || !methods || typeof methods.signInWithEmailAndPassword !== "function") {
      return {
        success: false,
        admin: null,
        error: "Authentication service unavailable."
      };
    }

    // 1. Authenticate credentials with Firebase Authentication
    let userCredential;
    try {
      userCredential = await methods.signInWithEmailAndPassword(auth, email.trim(), password);
    } catch (authError) {
      // Intentionally generic error to prevent email enumeration
      return {
        success: false,
        admin: null,
        error: "Access unavailable. This area is restricted to authorized administrators."
      };
    }

    const firebaseUser = userCredential?.user;
    if (!firebaseUser || !firebaseUser.uid) {
      return {
        success: false,
        admin: null,
        error: "Access unavailable. This area is restricted to authorized administrators."
      };
    }

    // 2. Authoritative check: verify document in /admins/{uid}
    const verification = await verifyAdminAuthorization(firebaseUser.uid);

    if (!verification.isAuthorized || !verification.adminData) {
      // IMMEDIATE TERMINATION: User is authenticated in Firebase, but NOT an admin.
      // Sign out immediately to prevent unauthorized session retention.
      if (typeof methods.signOut === "function") {
        try {
          await methods.signOut(auth);
        } catch {}
      }

      currentAdminSession = null;
      notifySubscribers(null);

      return {
        success: false,
        admin: null,
        error: "Access unavailable. This area is restricted to authorized administrators."
      };
    }

    // 3. Authorized Admin: establish active session
    currentAdminSession = {
      ...verification.adminData,
      email: firebaseUser.email || verification.adminData.email,
      lastLogin: new Date().toISOString()
    };

    // Record audit event
    await recordAdminAuditLog({
      adminUid: firebaseUser.uid,
      action: "ADMIN_LOGIN_SUCCESS",
      targetType: "admin_session",
      targetId: firebaseUser.uid,
      result: "success"
    });

    notifySubscribers(currentAdminSession);

    return {
      success: true,
      admin: { ...currentAdminSession },
      error: null
    };
  } catch (err) {
    console.error("[JKFixHub AdminAuth] Unexpected login error:", err?.message || err);
    return {
      success: false,
      admin: null,
      error: "Access unavailable. This area is restricted to authorized administrators."
    };
  }
}

/**
 * Signs out the current administrator session.
 * @returns {Promise<boolean>}
 */
export async function signOutAdmin() {
  try {
    const session = currentAdminSession;
    const { auth } = await initializeFirebaseClient();
    const methods = await getFirebaseAuthMethods();

    if (session) {
      await recordAdminAuditLog({
        adminUid: session.uid,
        action: "ADMIN_LOGOUT",
        targetType: "admin_session",
        targetId: session.uid,
        result: "success"
      });
    }

    if (auth && methods && typeof methods.signOut === "function") {
      await methods.signOut(auth);
    }

    currentAdminSession = null;
    notifySubscribers(null);
    return true;
  } catch (err) {
    console.warn("[JKFixHub AdminAuth] Sign out warning:", err?.message || err);
    currentAdminSession = null;
    notifySubscribers(null);
    return true;
  }
}

/**
 * Initializes automatic background session listener on page load.
 */
export async function initializeAdminAuth() {
  try {
    const { auth } = await initializeFirebaseClient();
    const methods = await getFirebaseAuthMethods();

    if (auth && methods && typeof methods.onAuthStateChanged === "function") {
      methods.onAuthStateChanged(auth, async (firebaseUser) => {
        if (!firebaseUser) {
          currentAdminSession = null;
          notifySubscribers(null);
          return;
        }

        // Verify that this existing user is actually an admin
        const verification = await verifyAdminAuthorization(firebaseUser.uid);
        if (verification.isAuthorized && verification.adminData) {
          currentAdminSession = {
            ...verification.adminData,
            email: firebaseUser.email || verification.adminData.email
          };
          notifySubscribers(currentAdminSession);
        } else {
          // If not an admin, ensure they are signed out of the admin panel
          if (typeof methods.signOut === "function") {
            try {
              await methods.signOut(auth);
            } catch {}
          }
          currentAdminSession = null;
          notifySubscribers(null);
        }
      });
    }
  } catch (err) {
    console.warn("[JKFixHub AdminAuth] Init observer warning:", err?.message || err);
  }
}
