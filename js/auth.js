// ==========================================
// #AUTHENTICATION_MODULE
// ==========================================
// Firebase Authentication foundation & application identity boundary.
//
// CRITICAL SECURITY PRINCIPLES:
// 1. Firebase Authentication identifies the user (uid, email, emailVerified).
// 2. Firebase Authentication alone does NOT establish application authorization.
// 3. Application roles (Customer, Worker, Admin) are enforced in-memory in Step 16
//    and will be authoritatively enforced via Firestore Security Rules in Step 17.
// 4. Passwords and authentication tokens are NEVER logged, printed, or persisted.
// 5. Admin remains completely invisible in normal customer/worker registration & login.

import { closeModal, openModal } from "./modals.js";
import { openWorkerDashboard, openProfileEditor, stopWorkerDashboardSubscription } from "./worker-dashboard.js";
import { openCustomerRequests } from "./customer-requests.js";
import { openAdminDashboard } from "./admin-dashboard.js";
import {
  clearRequestState,
  clearCurrentUser,
  getCurrentUser,
  getUserRole,
  getWorkerById,
  isAuthenticated,
  resetDemoChatState,
  setCurrentUser,
  getAuthStatus,
  setAuthStatus,
  AUTH_STATUS,
  saveApplicationProfile,
  getApplicationProfile,
  canAccessAdmin
} from "./store.js";
import {
  isSupportedRole,
  recordSecurityEvent,
  setTextContent,
  validateEmail,
  validatePersonName,
  validatePassword,
  validatePhone,
  mapFirebaseAuthError,
  getSafeErrorMessage,
  validateService,
  setButtonLoading,
  normalizePhoneNumber
} from "./security.js";
import {
  initializeFirebaseClient,
  getFirebaseAuthMethods,
  getFirebaseAuth,
  isFirebaseConfigured,
  initializeFirestoreClient,
  getFirestoreMethods
} from "./firebase-config.js";
import { stopRequestSuccessSubscription } from "./request.js";
import { stopCustomerDetailsSubscription } from "./customer-requests.js";
import { unsubscribeAllFirestoreListeners } from "./firestore-service.js";
import { closeChat } from "./chat.js";

const ALLOWED_DISTRICTS = Object.freeze([
  "Shopian",
  "Srinagar",
  "Anantnag",
  "Pulwama",
  "Kulgam",
  "Baramulla",
  "Budgam",
  "Kupwara",
  "Ganderbal",
  "Bandipora",
  "Jammu",
  "Kathua",
  "Udhampur",
  "Rajouri",
  "Poonch",
  "Doda",
  "Ramban",
  "Kishtwar",
  "Reasi",
  "Samba"
]);

let initialized = false;
let activeAuthTab = "signin";
let pendingRegistrationUid = null;
let pendingRegistrationEmail = null;
let customerVerificationDismissed = false;

try {
  if (typeof sessionStorage !== "undefined" && sessionStorage.getItem("jk_dismiss_verification_customer") === "true") {
    customerVerificationDismissed = true;
  }
} catch (_) {}

export function dismissCustomerVerificationReminder() {
  customerVerificationDismissed = true;
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem("jk_dismiss_verification_customer", "true");
    }
  } catch (_) {}
  const notice = document.getElementById("authEmailVerificationNotice");
  if (notice) notice.hidden = true;
}

/**
 * Returns the UID currently undergoing registration/recovery, if any.
 */
export function getPendingRegistrationUid() {
  return pendingRegistrationUid;
}

/**
 * Test helper to simulate pending registration UID.
 */
export function setPendingRegistrationUidForTesting(uid) {
  pendingRegistrationUid = uid;
}

/**
 * Returns the email currently undergoing registration/recovery, if any.
 */
export function getPendingRegistrationEmail() {
  return pendingRegistrationEmail;
}

/**
 * Test helper to simulate pending registration email.
 */
export function setPendingRegistrationEmailForTesting(email) {
  pendingRegistrationEmail = email;
}

/**
 * Returns allowed Jammu & Kashmir districts for worker registration.
 */
export function getAllowedDistricts() {
  return [...ALLOWED_DISTRICTS];
}

/**
 * Sets feedback message in auth modal.
 */
function setAuthFeedback(message, isError = true) {
  if (typeof document === "undefined") return;
  const errorEl = document.getElementById("authFeedback");
  const successEl = document.getElementById("authSuccessFeedback");

  if (isError) {
    if (errorEl) {
      setTextContent(errorEl, message);
      errorEl.hidden = !message;
    }
    if (successEl) successEl.hidden = true;
  } else {
    if (successEl) {
      setTextContent(successEl, message);
      successEl.hidden = !message;
    }
    if (errorEl) errorEl.hidden = true;
  }
}

/**
 * Clears all error spans in auth forms.
 */
function clearAuthFieldErrors() {
  if (typeof document === "undefined") return;
  setAuthFeedback("");
  const errorSpans = document.querySelectorAll(".auth-modal .request-error");
  errorSpans.forEach((span) => {
    setTextContent(span, "");
    span.hidden = true;
  });
}

/**
 * Displays error on a specific form field.
 */
function setFieldError(fieldId, errorId, message) {
  if (typeof document === "undefined") return;
  const errorEl = document.getElementById(errorId);
  if (errorEl) {
    setTextContent(errorEl, message);
    errorEl.hidden = !message;
  }
}

export function getActiveAuthTab() {
  return activeAuthTab;
}

/**
 * Synchronizes browser URL hash with active auth tab without page jumping.
 */
function syncAuthHash(tab) {
  if (typeof window === "undefined" || !window.history?.replaceState) return;
  try {
    const currentHash = window.location.hash || "";
    let targetHash = "";
    if (tab === "signin") targetHash = "#signin";
    else if (tab === "customer-register") targetHash = "#register";
    else if (tab === "worker-register") targetHash = "#worker-register";
    else if (tab === "account") targetHash = "#account";
    else if (tab === "password-reset" || tab === "forgot-password") targetHash = "#forgot-password";

    if (targetHash && currentHash !== targetHash) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${targetHash}`);
    }
  } catch (_) {}
}

/**
 * Removes auth-related hash from the URL when modal closes.
 */
export function clearAuthHash() {
  if (typeof window === "undefined" || !window.history?.replaceState) return;
  try {
    const hash = window.location.hash;
    const authHashes = [
      "#signin",
      "#login",
      "#register",
      "#customer-register",
      "#signup",
      "#worker-register",
      "#join",
      "#account",
      "#forgot-password",
      "#password-reset",
      "#reset-password"
    ];
    if (authHashes.includes(hash)) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    }
  } catch (_) {}
}

/**
 * Handles direct hash routing on page load or hashchange events.
 */
export function handleAuthHashNavigation() {
  if (typeof window === "undefined") return;
  const hash = window.location.hash;
  if (!hash) return;

  if (hash === "#signin" || hash === "#login") {
    showSignIn();
    openModal("authModal");
  } else if (hash === "#register" || hash === "#customer-register" || hash === "#signup") {
    showCustomerRegister();
    openModal("authModal");
  } else if (hash === "#worker-register" || hash === "#join") {
    showWorkerRegister();
    openModal("authModal");
  } else if (hash === "#forgot-password" || hash === "#password-reset" || hash === "#reset-password") {
    showPasswordReset();
    openModal("authModal");
  } else if (hash === "#account") {
    if (isAuthenticated()) {
      showAccountView();
    } else {
      showSignIn();
    }
    openModal("authModal");
  } else if (hash === "#admin" || hash === "#admin-dashboard") {
    if (canAccessAdmin()) {
      closeModal("authModal");
      openAdminDashboard();
    } else if (!isAuthenticated()) {
      showSignIn();
      openModal("authModal");
    }
  }
}

/**
 * View controllers for auth modal navigation.
 */
export function showAuthEntry() {
  activeAuthTab = "entry";
  if (typeof document === "undefined") return;
  clearAuthFieldErrors();
  syncAuthHash("entry");

  const entryView = document.getElementById("authEntryView");
  const signInPanel = document.getElementById("authSignInPanel");
  const custPanel = document.getElementById("authCustomerRegisterPanel");
  const wrkPanel = document.getElementById("authWorkerRegisterPanel");
  const rolePanel = document.getElementById("authRoleSelection");
  const resetPanel = document.getElementById("authPasswordResetPanel");

  if (entryView) entryView.hidden = false;
  if (signInPanel) signInPanel.hidden = true;
  if (custPanel) custPanel.hidden = true;
  if (wrkPanel) wrkPanel.hidden = true;
  if (rolePanel) rolePanel.hidden = true;
  if (resetPanel) resetPanel.hidden = true;
}

export function showSignIn() {
  activeAuthTab = "signin";
  if (typeof document === "undefined") return;
  clearAuthFieldErrors();
  syncAuthHash("signin");

  const entryView = document.getElementById("authEntryView");
  const signInPanel = document.getElementById("authSignInPanel");
  const custPanel = document.getElementById("authCustomerRegisterPanel");
  const wrkPanel = document.getElementById("authWorkerRegisterPanel");
  const rolePanel = document.getElementById("authRoleSelection");
  const resetPanel = document.getElementById("authPasswordResetPanel");

  if (entryView) entryView.hidden = true;
  if (signInPanel) {
    signInPanel.hidden = false;
    document.getElementById("authSignInEmail")?.focus();
  }
  if (custPanel) custPanel.hidden = true;
  if (wrkPanel) wrkPanel.hidden = true;
  if (rolePanel) rolePanel.hidden = true;
  if (resetPanel) resetPanel.hidden = true;
}

export function showCustomerRegister() {
  activeAuthTab = "customer-register";
  if (typeof document === "undefined") return;
  clearAuthFieldErrors();
  syncAuthHash("customer-register");

  const entryView = document.getElementById("authEntryView");
  const signInPanel = document.getElementById("authSignInPanel");
  const custPanel = document.getElementById("authCustomerRegisterPanel");
  const wrkPanel = document.getElementById("authWorkerRegisterPanel");
  const rolePanel = document.getElementById("authRoleSelection");
  const resetPanel = document.getElementById("authPasswordResetPanel");

  if (entryView) entryView.hidden = true;
  if (signInPanel) signInPanel.hidden = true;
  if (custPanel) {
    custPanel.hidden = false;
    const phoneContainer = document.getElementById("authCustomerPhoneContainer");
    if (phoneContainer) phoneContainer.hidden = true;
    const phoneToggleBtn = document.getElementById("authCustomerTogglePhoneBtn");
    if (phoneToggleBtn) phoneToggleBtn.hidden = false;
    const phoneInput = document.getElementById("authCustomerPhone");
    if (phoneInput) phoneInput.value = "";
    document.getElementById("authCustomerName")?.focus();
  }
  if (wrkPanel) wrkPanel.hidden = true;
  if (rolePanel) rolePanel.hidden = true;
  if (resetPanel) resetPanel.hidden = true;
}

export function showWorkerRegister() {
  activeAuthTab = "worker-register";
  if (typeof document === "undefined") return;
  clearAuthFieldErrors();
  syncAuthHash("worker-register");

  const entryView = document.getElementById("authEntryView");
  const signInPanel = document.getElementById("authSignInPanel");
  const custPanel = document.getElementById("authCustomerRegisterPanel");
  const wrkPanel = document.getElementById("authWorkerRegisterPanel");
  const rolePanel = document.getElementById("authRoleSelection");
  const resetPanel = document.getElementById("authPasswordResetPanel");

  if (entryView) entryView.hidden = true;
  if (signInPanel) signInPanel.hidden = true;
  if (custPanel) custPanel.hidden = true;
  if (wrkPanel) {
    wrkPanel.hidden = false;
    document.getElementById("authWorkerName")?.focus();
  }
  if (rolePanel) rolePanel.hidden = true;
  if (resetPanel) resetPanel.hidden = true;
}

export function showPasswordReset(prefillEmail = "") {
  activeAuthTab = "password-reset";
  if (typeof document === "undefined") return;
  clearAuthFieldErrors();
  syncAuthHash("password-reset");

  const entryView = document.getElementById("authEntryView");
  const signInPanel = document.getElementById("authSignInPanel");
  const custPanel = document.getElementById("authCustomerRegisterPanel");
  const wrkPanel = document.getElementById("authWorkerRegisterPanel");
  const rolePanel = document.getElementById("authRoleSelection");
  const resetPanel = document.getElementById("authPasswordResetPanel");

  if (entryView) entryView.hidden = true;
  if (signInPanel) signInPanel.hidden = true;
  if (custPanel) custPanel.hidden = true;
  if (wrkPanel) wrkPanel.hidden = true;
  if (rolePanel) rolePanel.hidden = true;
  if (resetPanel) {
    resetPanel.hidden = false;
    const emailInput = document.getElementById("authPasswordResetEmail");
    if (emailInput) {
      if (prefillEmail) {
        emailInput.value = prefillEmail;
      } else {
        const signInEmail = document.getElementById("authSignInEmail")?.value?.trim();
        if (signInEmail && !emailInput.value) {
          emailInput.value = signInEmail;
        }
      }
      emailInput.focus();
    }
  }
}

/**
 * Switches between auth tabs/views.
 */
export function switchAuthTab(tabName) {
  if (tabName === "entry") return showAuthEntry();
  if (tabName === "signin") return showSignIn();
  if (tabName === "customer-register") return showCustomerRegister();
  if (tabName === "worker-register") return showWorkerRegister();
  if (tabName === "password-reset" || tabName === "forgot-password") return showPasswordReset();
  if (tabName === "demo-roles") {
    activeAuthTab = "demo-roles";
    const entryView = document.getElementById("authEntryView");
    const signInPanel = document.getElementById("authSignInPanel");
    const custPanel = document.getElementById("authCustomerRegisterPanel");
    const wrkPanel = document.getElementById("authWorkerRegisterPanel");
    const rolePanel = document.getElementById("authRoleSelection");
    const resetPanel = document.getElementById("authPasswordResetPanel");
    if (entryView) entryView.hidden = true;
    if (signInPanel) signInPanel.hidden = true;
    if (custPanel) custPanel.hidden = true;
    if (wrkPanel) wrkPanel.hidden = true;
    if (rolePanel) rolePanel.hidden = false;
    if (resetPanel) resetPanel.hidden = true;
    return;
  }
  showAuthEntry();
}

/**
 * Customer registration handler.
 * Accepts { name, email, phone, district, password, confirmPassword }.
 * Email is required; Phone is optional (validated to 10 Indian digits if provided).
 */
export async function registerCustomer({ name, identifier, email, phone, district, password, confirmPassword }) {
  clearAuthFieldErrors();

  const isNameValid = validatePersonName(name);
  if (!isNameValid) {
    setFieldError("authCustomerName", "authCustomerNameError", getSafeErrorMessage("invalidName"));
    return { success: false, error: getSafeErrorMessage("invalidName") };
  }

  const resolvedEmail = (email || identifier || "").trim();
  const isEmailValid = validateEmail(resolvedEmail);
  if (!isEmailValid) {
    setFieldError("authCustomerEmail", "authCustomerEmailError", getSafeErrorMessage("invalidEmail"));
    return { success: false, error: getSafeErrorMessage("invalidEmail") };
  }

  let registeredPhone = null;
  const rawPhone = (typeof phone === "string" ? phone : "").trim();
  if (rawPhone) {
    const normalizedPhone = normalizePhoneNumber(rawPhone);
    if (!normalizedPhone) {
      setFieldError("authCustomerPhone", "authCustomerPhoneError", "Please enter a valid 10-digit mobile number.");
      return { success: false, error: "Please enter a valid 10-digit mobile number." };
    }
    registeredPhone = normalizedPhone;
  }

  if (!district || !ALLOWED_DISTRICTS.includes(district)) {
    setFieldError("authCustomerDistrict", "authCustomerDistrictError", getSafeErrorMessage("invalidDistrict"));
    return { success: false, error: getSafeErrorMessage("invalidDistrict") };
  }

  const passCheck = validatePassword(password, confirmPassword, { minLength: 6, maxLength: 20 });
  if (!passCheck.isValid) {
    const errorMsg = getSafeErrorMessage(passCheck.errorKey);
    setFieldError("authCustomerPassword", "authCustomerPasswordError", errorMsg);
    if (passCheck.errorKey === "passwordsDoNotMatch") {
      setFieldError("authCustomerConfirmPassword", "authCustomerConfirmPasswordError", errorMsg);
    }
    return { success: false, error: errorMsg };
  }

  const normalizedEmail = resolvedEmail.toLowerCase();
  recordSecurityEvent("REGISTER_ATTEMPT", "customer");

  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    const errorMsg = "Network connection error. Please check your internet connection and try again.";
    setAuthFeedback(errorMsg, true);
    return { success: false, error: errorMsg };
  }

  const submitBtn = typeof document !== "undefined" ? document.getElementById("authCustomerRegisterSubmit") : null;
  const restoreBtn = setButtonLoading(submitBtn, "Creating account...");
  setAuthFeedback("Creating your account...", false);

  try {
    const firebaseReady = isFirebaseConfigured();
    const methods = await getFirebaseAuthMethods();
    let auth = getFirebaseAuth();
    if (!auth && firebaseReady) {
      const client = await initializeFirebaseClient();
      auth = client?.auth;
    }

    if (firebaseReady && methods && auth) {
      let createdUser = null;
      let isRecoveredAccount = false;
      pendingRegistrationEmail = normalizedEmail;

      try {
        setAuthStatus(AUTH_STATUS.LOADING);
        try {
          const userCredential = await methods.createUserWithEmailAndPassword(auth, normalizedEmail, password);
          createdUser = userCredential.user;
        } catch (authErr) {
          if (authErr?.code === "auth/email-already-in-use" && typeof methods.signInWithEmailAndPassword === "function") {
            try {
              const recoveryCredential = await methods.signInWithEmailAndPassword(auth, normalizedEmail, password);
              const candidateUser = recoveryCredential.user;
              const { db } = await initializeFirestoreClient();
              const firestoreMethods = await getFirestoreMethods();
              if (db && firestoreMethods && typeof firestoreMethods.getDoc === "function") {
                const existingDoc = await firestoreMethods.getDoc(firestoreMethods.doc(db, "users", candidateUser.uid));
                if (!existingDoc.exists()) {
                  // Orphaned Auth user without Firestore profile: recover and complete profile setup
                  createdUser = candidateUser;
                  isRecoveredAccount = true;
                } else {
                  if (typeof methods.signOut === "function") {
                    try { await methods.signOut(auth); } catch (_) {}
                  }
                  throw authErr;
                }
              } else {
                throw authErr;
              }
            } catch (recoveryErr) {
              throw authErr;
            }
          } else {
            throw authErr;
          }
        }

        pendingRegistrationUid = createdUser.uid;
        restoreBtn.updateText("Setting up profile...");
        setAuthFeedback("Setting up your customer profile...", false);
        const createdAt = new Date().toISOString();

        // Required profile creation in Firestore /users/{uid} FIRST before non-blocking calls
        const { db } = await initializeFirestoreClient();
        const firestoreMethods = await getFirestoreMethods();
        if (!db || !firestoreMethods || typeof firestoreMethods.setDoc !== "function") {
          throw new Error("DATABASE_UNAVAILABLE: Firestore database client not available.");
        }

        const userDocRef = firestoreMethods.doc(db, "users", createdUser.uid);
        await firestoreMethods.setDoc(userDocRef, {
          uid: createdUser.uid,
          name,
          email: normalizedEmail,
          phone: registeredPhone,
          district,
          role: "customer",
          emailVerified: Boolean(createdUser.emailVerified),
          createdAt
        });

        saveApplicationProfile(createdUser.uid, {
          role: "customer",
          name,
          email: normalizedEmail,
          phone: registeredPhone,
          district,
          emailVerified: Boolean(createdUser.emailVerified),
          isVerified: false,
          authProvider: "firebase",
          createdAt
        });

        setCurrentUser({
          id: createdUser.uid,
          firebaseUid: createdUser.uid,
          role: "customer",
          name,
          email: normalizedEmail,
          phone: registeredPhone,
          district,
          emailVerified: Boolean(createdUser.emailVerified),
          isVerified: false,
          authProvider: "firebase",
          createdAt
        });

        // Non-blocking metadata and verification operations after database record is secured
        if (!isRecoveredAccount || !createdUser.displayName) {
          if (typeof methods.updateProfile === "function") {
            try {
              await methods.updateProfile(createdUser, { displayName: name });
            } catch {
              // Non-blocking metadata update
            }
          }
        }

        recordSecurityEvent("REGISTER_SUCCESS", "customer");
        updateAccountControls();
        showAccountView();
        setAuthFeedback("Account created successfully! Welcome to JK FixHub.", false);
        return { success: true, recovered: isRecoveredAccount };
      } catch (error) {
        recordSecurityEvent("FIREBASE_AUTH_ERROR");
        setAuthStatus(AUTH_STATUS.ERROR, error?.code || "auth-error");

        if (createdUser) {
          console.warn("[JKFixHub Auth] Customer registration profile creation failed:", error?.message || error);
          clearCurrentUser();
          if (typeof methods.signOut === "function") {
            try {
              await methods.signOut(auth);
            } catch (_) {}
          }
          updateAccountControls();
          const safeMessage = "Your account was created, but setting up your profile encountered an error. Please try signing in or contact support.";
          setAuthFeedback(safeMessage, true);
          return { success: false, error: safeMessage, partialFailure: true };
        }

        const safeMessage = mapFirebaseAuthError(error);
        setAuthFeedback(safeMessage, true);
        return { success: false, error: safeMessage };
      } finally {
        if (pendingRegistrationUid === createdUser?.uid) {
          pendingRegistrationUid = null;
        }
        if (pendingRegistrationEmail === normalizedEmail) {
          pendingRegistrationEmail = null;
        }
      }
    }

    // Session Fallback
    const createdAt = new Date().toISOString();
    const demoUid = `cust-${Date.now().toString(36)}`;
    saveApplicationProfile(demoUid, {
      role: "customer",
      name,
      email: normalizedEmail,
      phone: registeredPhone,
      district,
      emailVerified: false,
      isVerified: false,
      authProvider: "demo",
      createdAt
    });

    setCurrentUser({
      id: demoUid,
      firebaseUid: null,
      role: "customer",
      name,
      email: normalizedEmail,
      phone: registeredPhone,
      district,
      emailVerified: false,
      isVerified: false,
      authProvider: "demo",
      createdAt
    });

    recordSecurityEvent("REGISTER_SUCCESS", "customer");
    updateAccountControls();
    showAccountView();
    setAuthFeedback("Account created in session mode.", false);
    return { success: true };
  } finally {
    restoreBtn();
  }
}

/**
 * Registers a new Worker using full professional attributes:
 * name, email, phone, district, service, experience, availability, password, confirmPassword.
 * Crucial: newly registered worker starts with isVerified: false (Pending Verification).
 */
export async function registerWorker({ name, email, phone, district, service, experience, availability, password, confirmPassword }) {
  clearAuthFieldErrors();

  const isNameValid = validatePersonName(name);
  if (!isNameValid) {
    setFieldError("authWorkerName", "authWorkerNameError", getSafeErrorMessage("invalidName"));
    return { success: false, error: getSafeErrorMessage("invalidName") };
  }

  const isEmailValid = validateEmail(email);
  if (!isEmailValid) {
    setFieldError("authWorkerEmail", "authWorkerEmailError", getSafeErrorMessage("invalidEmail"));
    return { success: false, error: getSafeErrorMessage("invalidEmail") };
  }

  const isPhoneValid = validatePhone(phone);
  if (!isPhoneValid) {
    setFieldError("authWorkerPhone", "authWorkerPhoneError", getSafeErrorMessage("invalidPhone"));
    return { success: false, error: getSafeErrorMessage("invalidPhone") };
  }

  if (!district || !ALLOWED_DISTRICTS.includes(district)) {
    setFieldError("authWorkerDistrict", "authWorkerDistrictError", getSafeErrorMessage("invalidDistrict"));
    return { success: false, error: getSafeErrorMessage("invalidDistrict") };
  }

  if (!service || !validateService(service)) {
    setFieldError("authWorkerService", "authWorkerServiceError", "Please select a valid primary service.");
    return { success: false, error: "Please select a valid primary service." };
  }

  if (typeof experience !== "string" || experience.trim().length === 0 || experience.trim().length > 40) {
    setFieldError("authWorkerExperience", "authWorkerExperienceError", getSafeErrorMessage("invalidExperience"));
    return { success: false, error: getSafeErrorMessage("invalidExperience") };
  }

  const allowedAvailabilities = ["Available", "Busy", "Offline"];
  const safeAvailability = allowedAvailabilities.includes(availability) ? availability : "Available";

  const passCheck = validatePassword(password, confirmPassword);
  if (!passCheck.isValid) {
    const errorMsg = getSafeErrorMessage(passCheck.errorKey);
    setFieldError(
      passCheck.errorKey === "passwordsDoNotMatch" ? "authWorkerConfirmPassword" : "authWorkerPassword",
      passCheck.errorKey === "passwordsDoNotMatch" ? "authWorkerConfirmPasswordError" : "authWorkerPasswordError",
      errorMsg
    );
    return { success: false, error: errorMsg };
  }

  recordSecurityEvent("REGISTER_ATTEMPT", "worker");

  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    const errorMsg = "Network connection error. Please check your internet connection and try again.";
    setAuthFeedback(errorMsg, true);
    return { success: false, error: errorMsg };
  }

  const submitBtn = typeof document !== "undefined" ? document.getElementById("authWorkerRegisterSubmit") : null;
  const restoreBtn = setButtonLoading(submitBtn, "Creating account...");
  setAuthFeedback("Creating your worker account...", false);

  try {
    const firebaseReady = isFirebaseConfigured();
    const methods = await getFirebaseAuthMethods();
    let auth = getFirebaseAuth();
    if (!auth && firebaseReady) {
      const client = await initializeFirebaseClient();
      auth = client?.auth;
    }

    if (firebaseReady && methods && auth) {
      let createdUser = null;
      let isRecoveredAccount = false;
      const normalizedEmail = email.toLowerCase().trim();
      pendingRegistrationEmail = normalizedEmail;

    try {
      setAuthStatus(AUTH_STATUS.LOADING);
      try {
        const userCredential = await methods.createUserWithEmailAndPassword(auth, email, password);
        createdUser = userCredential.user;
      } catch (authErr) {
        if (authErr?.code === "auth/email-already-in-use" && typeof methods.signInWithEmailAndPassword === "function") {
          try {
            const recoveryCredential = await methods.signInWithEmailAndPassword(auth, email, password);
            const candidateUser = recoveryCredential.user;
            const { db } = await initializeFirestoreClient();
            const firestoreMethods = await getFirestoreMethods();
            if (db && firestoreMethods && typeof firestoreMethods.getDoc === "function") {
              const existingDoc = await firestoreMethods.getDoc(firestoreMethods.doc(db, "users", candidateUser.uid));
              if (!existingDoc.exists()) {
                // Orphaned Auth user without Firestore profile: recover and complete profile setup
                createdUser = candidateUser;
                isRecoveredAccount = true;
              } else {
                if (typeof methods.signOut === "function") {
                  try { await methods.signOut(auth); } catch (_) {}
                }
                throw authErr;
              }
            } else {
              throw authErr;
            }
          } catch (recoveryErr) {
            throw authErr;
          }
        } else {
          throw authErr;
        }
      }

      pendingRegistrationUid = createdUser.uid;
      restoreBtn.updateText("Setting up profile...");
      setAuthFeedback("Setting up your worker profile...", false);
      const createdAt = new Date().toISOString();

      // Required profile creation in Firestore /users/{uid} and /workers/{uid} FIRST before non-blocking calls
      const { db } = await initializeFirestoreClient();
      const firestoreMethods = await getFirestoreMethods();
      if (!db || !firestoreMethods || typeof firestoreMethods.setDoc !== "function") {
        throw new Error("DATABASE_UNAVAILABLE: Firestore database client not available.");
      }

      const userDocRef = firestoreMethods.doc(db, "users", createdUser.uid);
      const workerDocRef = firestoreMethods.doc(db, "workers", createdUser.uid);

      if (typeof firestoreMethods.writeBatch === "function") {
        const batch = firestoreMethods.writeBatch(db);
        batch.set(userDocRef, {
          uid: createdUser.uid,
          name,
          email,
          phone,
          district,
          role: "worker",
          emailVerified: Boolean(createdUser.emailVerified),
          createdAt
        });
        batch.set(workerDocRef, {
          id: createdUser.uid,
          uid: createdUser.uid,
          name,
          district,
          service,
          experience: experience.trim(),
          availability: safeAvailability,
          rating: "5.0",
          reviewCount: 0,
          isVerified: false,
          status: "pending",
          createdAt
        });
        await batch.commit();
      } else {
        await firestoreMethods.setDoc(userDocRef, {
          uid: createdUser.uid,
          name,
          email,
          phone,
          district,
          role: "worker",
          emailVerified: Boolean(createdUser.emailVerified),
          createdAt
        });
        await firestoreMethods.setDoc(workerDocRef, {
          id: createdUser.uid,
          uid: createdUser.uid,
          name,
          district,
          service,
          experience: experience.trim(),
          availability: safeAvailability,
          rating: "5.0",
          reviewCount: 0,
          isVerified: false,
          status: "pending",
          createdAt
        });
      }

      saveApplicationProfile(createdUser.uid, {
        role: "worker",
        name,
        email,
        phone,
        district,
        service,
        experience: experience.trim(),
        availability: safeAvailability,
        emailVerified: Boolean(createdUser.emailVerified),
        isVerified: false,
        status: "pending",
        authProvider: "firebase",
        createdAt
      });

      setCurrentUser({
        id: createdUser.uid,
        firebaseUid: createdUser.uid,
        role: "worker",
        name,
        email,
        phone,
        district,
        service,
        experience: experience.trim(),
        availability: safeAvailability,
        workerId: null,
        emailVerified: Boolean(createdUser.emailVerified),
        isVerified: false,
        status: "pending",
        authProvider: "firebase",
        createdAt
      });

      // Non-blocking metadata and verification operations after database record is secured
      if (!isRecoveredAccount || !createdUser.displayName) {
        if (typeof methods.updateProfile === "function") {
          try {
            await methods.updateProfile(createdUser, { displayName: name });
          } catch {
            // Non-blocking
          }
        }
      }

      if (!createdUser.emailVerified && typeof methods.sendEmailVerification === "function") {
        try {
          await methods.sendEmailVerification(createdUser);
          recordSecurityEvent("EMAIL_VERIFICATION_SENT", "worker");
        } catch (verificationErr) {
          console.warn("[JKFixHub Auth] Worker email verification dispatch notice:", verificationErr?.message || verificationErr);
        }
      }

      recordSecurityEvent("REGISTER_SUCCESS", "worker");
      updateAccountControls();
      showAccountView();
      setAuthFeedback("Worker account created! A verification link has been sent to your email. Your profile is pending administrative verification.", false);
      return { success: true, recovered: isRecoveredAccount };
    } catch (error) {
      recordSecurityEvent("FIREBASE_AUTH_ERROR");
      setAuthStatus(AUTH_STATUS.ERROR, error?.code || "auth-error");

      if (createdUser) {
        console.warn("[JKFixHub Auth] Worker registration profile creation failed:", error?.message || error);
        clearCurrentUser();
        if (typeof methods.signOut === "function") {
          try {
            await methods.signOut(auth);
          } catch (_) {}
        }
        updateAccountControls();
        const safeMessage = "Worker account was created, but setting up your profile encountered an error. Please try signing in or contact support.";
        setAuthFeedback(safeMessage, true);
        return { success: false, error: safeMessage, partialFailure: true };
      }

      const safeMessage = mapFirebaseAuthError(error);
      setAuthFeedback(safeMessage, true);
      return { success: false, error: safeMessage };
    } finally {
      if (pendingRegistrationUid === createdUser?.uid) {
        pendingRegistrationUid = null;
      }
      if (pendingRegistrationEmail === normalizedEmail) {
        pendingRegistrationEmail = null;
      }
    }
  }

  // Session Fallback
  const createdAt = new Date().toISOString();
  const demoUid = `wrk-${Date.now().toString(36)}`;
  saveApplicationProfile(demoUid, {
    role: "worker",
    name,
    email,
    phone,
    district,
    service,
    experience: experience.trim(),
    availability: safeAvailability,
    emailVerified: false,
    isVerified: false,
    status: "pending",
    authProvider: "demo",
    createdAt
  });

  setCurrentUser({
    id: demoUid,
    firebaseUid: null,
    role: "worker",
    name,
    email,
    phone,
    district,
    service,
    experience: experience.trim(),
    availability: safeAvailability,
    workerId: null,
    emailVerified: false,
    isVerified: false,
    authProvider: "demo",
    createdAt
  });

  recordSecurityEvent("REGISTER_SUCCESS", "worker");
  updateAccountControls();
  showAccountView();
  setAuthFeedback("Worker account created in session mode (Pending Verification).", false);
  return { success: true };
  } finally {
    restoreBtn();
  }
}

/**
 * Signs in an existing user with Email and Password.
 * Routes to Customer or Worker experience based on profile;
 * Admin remains strictly separate via admin.html.
 */
export async function signInUser({ email, password }) {
  clearAuthFieldErrors();

  const isEmailValid = validateEmail(email);
  if (!isEmailValid) {
    setFieldError("authSignInEmail", "authSignInEmailError", getSafeErrorMessage("invalidEmail"));
    return { success: false, error: getSafeErrorMessage("invalidEmail") };
  }

  if (typeof password !== "string" || !password) {
    setFieldError("authSignInPassword", "authSignInPasswordError", getSafeErrorMessage("invalidPassword"));
    return { success: false, error: getSafeErrorMessage("invalidPassword") };
  }

  const normalizedEmail = email.toLowerCase().trim();
  recordSecurityEvent("LOGIN_ATTEMPT");

  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    const errorMsg = "Network connection error. Please check your internet connection and try again.";
    setAuthFeedback(errorMsg, true);
    return { success: false, error: errorMsg };
  }

  const submitBtn = typeof document !== "undefined" ? document.getElementById("authSignInSubmit") : null;
  const restoreBtn = setButtonLoading(submitBtn, "Signing in...");
  setAuthFeedback("Signing in to your account...", false);

  try {
    const firebaseReady = isFirebaseConfigured();
    const methods = await getFirebaseAuthMethods();
    let auth = getFirebaseAuth();
    if (!auth && firebaseReady) {
      const client = await initializeFirebaseClient();
      auth = client?.auth;
    }

    if (firebaseReady && methods && auth) {
      try {
        setAuthStatus(AUTH_STATUS.LOADING);
        const userCredential = await methods.signInWithEmailAndPassword(auth, normalizedEmail, password);
        const user = userCredential.user;

        restoreBtn.updateText("Loading profile...");
        setAuthFeedback("Loading your profile...", false);

        let profile = getApplicationProfile(user.uid);

        // Try fetching profile from Firestore
        try {
          const { db } = await initializeFirestoreClient();
          const firestoreMethods = await getFirestoreMethods();
          if (db && firestoreMethods && typeof firestoreMethods.getDoc === "function") {
            const userDoc = await firestoreMethods.getDoc(firestoreMethods.doc(db, "users", user.uid));
            if (userDoc.exists()) {
              const data = userDoc.data();
              const role = isSupportedRole(data?.role) ? data.role : null;
              if (role) {
                const userEmail = data.email || user.email;
                const userPhone = data.phone || null;
                profile = {
                  role,
                  name: data.name || user.displayName || (role === "worker" ? "Worker" : "Customer"),
                  email: userEmail,
                  phone: userPhone,
                  district: data.district || null,
                  createdAt: data.createdAt || new Date().toISOString()
                };

                if (profile.role === "worker") {
                  const workerDoc = await firestoreMethods.getDoc(firestoreMethods.doc(db, "workers", user.uid));
                  if (workerDoc.exists()) {
                    const wData = workerDoc.data();
                    profile.service = wData.service || null;
                    profile.experience = wData.experience || null;
                    profile.availability = wData.availability || "Available";
                    profile.isVerified = Boolean(wData.isVerified);
                    profile.status = wData.status || "pending";
                  } else {
                    profile.status = "pending";
                    profile.isVerified = false;
                  }
                }
              } else {
                profile = null;
              }
            } else {
              profile = null;
            }

            // Authoritative admin verification against /admins/{uid}
            if (!profile || profile.role === "admin") {
              try {
                const adminDoc = await firestoreMethods.getDoc(firestoreMethods.doc(db, "admins", user.uid));
                if (adminDoc.exists()) {
                  const aData = adminDoc.data();
                  if (aData && aData.active === true && aData.role === "admin") {
                    profile = {
                      role: "admin",
                      name: aData.displayName || profile?.name || user.displayName || "Platform Administrator",
                      email: aData.email || user.email,
                      phone: aData.phone || profile?.phone || null,
                      district: aData.district || profile?.district || null,
                      createdAt: aData.createdAt || profile?.createdAt || new Date().toISOString()
                    };
                  } else if (profile?.role === "admin") {
                    // User doc claimed admin role but /admins/{uid} is not active admin
                    profile = null;
                  }
                } else if (profile?.role === "admin") {
                  // User doc claimed admin role but no /admins/{uid} record exists
                  profile = null;
                }
              } catch (adminErr) {
                if (profile?.role === "admin") {
                  profile = null;
                }
              }
            }
          }
        } catch (e) {
          // Fallback to local profile cache only if it has a valid supported role
          if (!profile?.role || !isSupportedRole(profile.role)) {
            profile = null;
          }
        }

        if (!profile || !profile.role || !isSupportedRole(profile.role)) {
          recordSecurityEvent("FIREBASE_AUTH_ERROR");
          setAuthStatus(AUTH_STATUS.ERROR, "missing-profile");
          if (typeof methods.signOut === "function") {
            try {
              await methods.signOut(auth);
            } catch (_) {}
          }
          clearCurrentUser();
          updateAccountControls();
          const errorMsg = "Account profile not found. Please contact support or register again.";
          setAuthFeedback(errorMsg, true);
          return { success: false, error: errorMsg };
        }

        saveApplicationProfile(user.uid, {
          ...profile,
          emailVerified: Boolean(user.emailVerified),
          authProvider: "firebase"
        });

        setCurrentUser({
          id: user.uid,
          firebaseUid: user.uid,
          role: profile.role,
          name: profile.name,
          email: profile.email || user.email,
          phone: profile.phone || null,
          district: profile.district || null,
          service: profile.service || null,
          experience: profile.experience || null,
          availability: profile.availability || "Available",
          workerId: profile.workerId || null,
          emailVerified: Boolean(user.emailVerified),
          isVerified: Boolean(profile.isVerified),
          status: profile.status || (profile.role === "worker" ? "pending" : null),
          authProvider: "firebase",
          createdAt: profile.createdAt || new Date().toISOString()
        });

        updateAccountControls();
        if (profile.role === "admin") {
          closeModal("authModal");
          openAdminDashboard();
          setAuthFeedback("Signed in as Administrator.", false);
        } else {
          showAccountView();
          setAuthFeedback("Signed in successfully.", false);
        }
        return { success: true };
      } catch (error) {
        recordSecurityEvent("FIREBASE_AUTH_ERROR");
        setAuthStatus(AUTH_STATUS.ERROR, error?.code || "auth-error");
        const safeMessage = mapFirebaseAuthError(error);
        setAuthFeedback(safeMessage, true);
        return { success: false, error: safeMessage };
      }
    }

    // If Firebase credentials are not yet configured
    setAuthFeedback("Authentication service is temporarily unavailable. Please try again shortly.", true);
    return {
      success: false,
      error: "Firebase Authentication credentials not configured."
    };
  } finally {
    restoreBtn();
  }
}

/**
 * Resends email verification to the authenticated Firebase user.
 */
export async function resendVerificationEmail() {
  const user = getCurrentUser();
  const resendBtn = typeof document !== "undefined" ? document.getElementById("authResendVerification") : null;
  const feedback = typeof document !== "undefined" ? document.getElementById("authVerificationActionFeedback") : null;

  if (!user || user.authProvider !== "firebase") {
    if (feedback) {
      setTextContent(feedback, "Verification email cannot be resent for this account.");
      feedback.hidden = false;
    }
    return false;
  }

  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    if (feedback) {
      setTextContent(feedback, "Network connection error. Please reconnect to the internet.");
      feedback.hidden = false;
    }
    return false;
  }

  const restoreBtn = setButtonLoading(resendBtn, "Sending email...");
  if (feedback) {
    setTextContent(feedback, "Sending verification email...");
    feedback.hidden = false;
  }

  try {
    const methods = await getFirebaseAuthMethods();
    let auth = getFirebaseAuth();
    if (!auth && isFirebaseConfigured()) {
      const client = await initializeFirebaseClient();
      auth = client?.auth;
    }
    if (methods && auth?.currentUser && typeof methods.sendEmailVerification === "function") {
      try {
        await methods.sendEmailVerification(auth.currentUser);
        recordSecurityEvent("EMAIL_VERIFICATION_SENT");
        if (feedback) {
          setTextContent(feedback, "Verification email resent! Check your inbox.");
          feedback.hidden = false;
        }
        return true;
      } catch (error) {
        recordSecurityEvent("EMAIL_VERIFICATION_FAILED");
        if (feedback) {
          setTextContent(feedback, mapFirebaseAuthError(error));
          feedback.hidden = false;
        }
        return false;
      }
    }

    return false;
  } finally {
    restoreBtn();
  }
}

/**
 * Refreshes current user's email verification status by reloading Firebase user
 * and forcing a token refresh. Updates profile, in-memory currentUser, and UI.
 *
 * @returns {Promise<{ success: boolean, verified: boolean, message?: string, error?: string }>}
 */
export async function refreshUserVerificationStatus() {
  const user = getCurrentUser();
  const refreshBtn = typeof document !== "undefined" ? document.getElementById("authRefreshVerification") : null;
  const feedback = typeof document !== "undefined" ? document.getElementById("authVerificationActionFeedback") : null;

  if (!user || user.authProvider !== "firebase") {
    const msg = "Verification status cannot be checked for this account.";
    if (feedback) {
      setTextContent(feedback, msg);
      feedback.hidden = false;
    }
    return { success: false, verified: false, error: msg };
  }

  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    const errorMsg = "Network connection error. Please reconnect to the internet.";
    if (feedback) {
      setTextContent(feedback, errorMsg);
      feedback.hidden = false;
    }
    return { success: false, verified: false, error: errorMsg };
  }

  const restoreBtn = setButtonLoading(refreshBtn, "Checking status...");
  if (feedback) {
    setTextContent(feedback, "Checking verification status with Firebase...");
    feedback.hidden = false;
  }

  try {
    const methods = await getFirebaseAuthMethods();
    let auth = getFirebaseAuth();
    if (!auth && isFirebaseConfigured()) {
      const client = await initializeFirebaseClient();
      auth = client?.auth;
    }

    if (methods && auth?.currentUser) {
      try {
        if (typeof methods.reload === "function") {
          await methods.reload(auth.currentUser);
        }
        if (typeof methods.getIdToken === "function") {
          await methods.getIdToken(auth.currentUser, true);
        }

        const isVerified = Boolean(auth.currentUser.emailVerified);

        const existingProfile = getApplicationProfile(user.id);
        saveApplicationProfile(user.id, {
          ...(existingProfile || {}),
          emailVerified: isVerified
        });

        setCurrentUser({
          ...user,
          emailVerified: isVerified
        });

        if (isVerified) {
          try {
            const { db } = await initializeFirestoreClient();
            const firestoreMethods = await getFirestoreMethods();
            if (db && firestoreMethods && typeof firestoreMethods.updateDoc === "function") {
              const userDocRef = firestoreMethods.doc(db, "users", user.id);
              await firestoreMethods.updateDoc(userDocRef, {
                emailVerified: true,
                updatedAt: new Date().toISOString()
              });
            }
          } catch (dbErr) {
            console.warn("[JKFixHub Auth] Firestore user verification sync notice:", dbErr?.message || dbErr);
          }
        }

        recordSecurityEvent("AUTH_STATE_CHANGED", user.role);
        updateAccountControls();
        showAccountView(true);

        const msg = isVerified
          ? "✓ Email verified successfully!"
          : "Email is not verified yet. Please check your inbox and click the verification link, then check status again.";
        if (feedback) {
          setTextContent(feedback, msg);
          feedback.hidden = false;
        }

        return { success: true, verified: isVerified, message: msg };
      } catch (error) {
        recordSecurityEvent("FIREBASE_AUTH_ERROR", user.role);
        const safeMessage = mapFirebaseAuthError(error);
        if (feedback) {
          setTextContent(feedback, safeMessage);
          feedback.hidden = false;
        }
        return { success: false, verified: false, error: safeMessage };
      }
    }

    return { success: false, verified: false, error: "Auth service unavailable." };
  } finally {
    restoreBtn();
  }
}

/**
 * Sends a password reset email to the specified email address.
 * Preserves standard error mapping and security event logging.
 *
 * @param {string} email
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
export async function sendPasswordReset(email) {
  clearAuthFieldErrors();
  const isEmailValid = validateEmail(email);
  if (!isEmailValid) {
    return { success: false, error: getSafeErrorMessage("invalidEmail") };
  }

  const firebaseReady = isFirebaseConfigured();
  const methods = await getFirebaseAuthMethods();
  let auth = getFirebaseAuth();
  if (!auth && firebaseReady) {
    const client = await initializeFirebaseClient();
    auth = client?.auth;
  }

  if (firebaseReady && methods && auth && typeof methods.sendPasswordResetEmail === "function") {
    try {
      await methods.sendPasswordResetEmail(auth, email.trim());
      return { success: true };
    } catch (error) {
      if (error?.code === "auth/user-not-found") {
        // Prevent email enumeration: report success neutrally even if user does not exist
        return { success: true };
      }
      recordSecurityEvent("FIREBASE_AUTH_ERROR");
      return { success: false, error: mapFirebaseAuthError(error) };
    }
  }

  return { success: false, error: "Password reset service is temporarily unavailable." };
}

let isResettingPassword = false;

/**
 * Handles password reset submission with email validation,
 * loading state, duplicate submission guard, and neutral messaging.
 *
 * @param {string} email
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
export async function handlePasswordResetSubmit(email) {
  if (isResettingPassword) return { success: false, error: "In-flight request" };

  clearAuthFieldErrors();
  const trimmedEmail = typeof email === "string" ? email.trim() : "";
  if (!trimmedEmail) {
    const errorMsg = "Email address is required.";
    setFieldError("authPasswordResetEmail", "authPasswordResetEmailError", errorMsg);
    return { success: false, error: errorMsg };
  }

  if (!validateEmail(trimmedEmail)) {
    const errorMsg = getSafeErrorMessage("invalidEmail");
    setFieldError("authPasswordResetEmail", "authPasswordResetEmailError", errorMsg);
    return { success: false, error: errorMsg };
  }

  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    const errorMsg = "Network connection error. Please check your internet connection and try again.";
    setAuthFeedback(errorMsg, true);
    return { success: false, error: errorMsg };
  }

  const submitBtn = document.getElementById("authPasswordResetSubmit");
  const emailInput = document.getElementById("authPasswordResetEmail");
  const restoreBtn = setButtonLoading(submitBtn, "Sending Reset Link...");

  isResettingPassword = true;
  if (emailInput) {
    emailInput.disabled = true;
  }
  setAuthFeedback("Sending password reset email...", false);

  try {
    const result = await sendPasswordReset(trimmedEmail);
    if (result.success) {
      setAuthFeedback("If an account exists for this email address, a password reset link has been sent. Please check your inbox.", false);
      if (emailInput) {
        emailInput.value = "";
      }
      return { success: true };
    } else {
      setAuthFeedback(result.error || "Password reset service is temporarily unavailable.", true);
      return { success: false, error: result.error };
    }
  } catch (err) {
    recordSecurityEvent("FIREBASE_AUTH_ERROR");
    const safeError = mapFirebaseAuthError(err);
    setAuthFeedback(safeError, true);
    return { success: false, error: safeError };
  } finally {
    isResettingPassword = false;
    restoreBtn();
    if (emailInput) {
      emailInput.disabled = false;
    }
  }
}

/**
 * Signs out current user (Firebase signOut + application cleanup).
 */
export async function signOutUser() {
  const role = getUserRole();
  recordSecurityEvent("LOGOUT", role);

  const logoutBtns = typeof document !== "undefined"
    ? [document.getElementById("authLogout"), document.getElementById("authLogoutFromDashboard"), document.getElementById("adminLogoutButton")].filter(Boolean)
    : [];
  const restores = logoutBtns.map((btn) => setButtonLoading(btn, "Signing out..."));

  try {
    const methods = await getFirebaseAuthMethods();
    let auth = getFirebaseAuth();
    if (!auth && isFirebaseConfigured()) {
      const client = await initializeFirebaseClient();
      auth = client?.auth;
    }
    if (methods && auth && typeof methods.signOut === "function") {
      try {
        await methods.signOut(auth);
      } catch {
        // Clean up locally regardless
      }
    }

    demoLogout();
    updateAccountControls();
    clearAuthHash();
    showSignedOutView(false);
    setAuthFeedback("Signed out.", false);
  } finally {
    restores.forEach((r) => r());
  }
}

/**
 * Built-in demo login for rapid testing without credentials.
 */
export function demoLogin(role) {
  if (!isSupportedRole(role) || role === "admin") {
    recordSecurityEvent("ROLE_CHANGE_ATTEMPT", role);
    return false;
  }

  recordSecurityEvent("LOGIN_ATTEMPT", role);
  const createdAt = new Date().toISOString();

  if (role === "customer") {
    setCurrentUser({
      id: "demo-customer",
      firebaseUid: null,
      role: "customer",
      name: "Demo Customer",
      email: null,
      emailVerified: false,
      phone: null,
      photo: null,
      district: null,
      isVerified: false,
      authProvider: "demo",
      createdAt
    });
    return true;
  }

  if (role === "worker") {
    const worker = getWorkerById(1);
    if (!worker) throw new Error("The demo worker account is unavailable.");
    setCurrentUser({
      id: `demo-worker-${worker.id}`,
      firebaseUid: null,
      role: "worker",
      workerId: worker.id,
      name: worker.name,
      email: null,
      emailVerified: false,
      phone: null,
      photo: null,
      district: worker.district,
      isVerified: true,
      authProvider: "demo",
      createdAt
    });
    return true;
  }

  return false;
}

/**
 * Clean up local session state on logout.
 */
export function demoLogout() {
  closeChat(false);
  stopRequestSuccessSubscription();
  stopCustomerDetailsSubscription();
  stopWorkerDashboardSubscription();
  unsubscribeAllFirestoreListeners();
  resetDemoChatState();
  clearCurrentUser();
  clearRequestState();
  customerVerificationDismissed = false;
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.removeItem("jk_dismiss_verification_customer");
    }
  } catch (_) {}
}

/**
 * Helper to build accessible JK menu item buttons.
 */
function createJkMenuItem(icon, text, action, variant = "") {
  if (typeof document === "undefined") return null;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `jk-menu-item${variant ? ` jk-menu-item-${variant}` : ""}`;
  btn.setAttribute("data-jk-action", action);
  if (btn.dataset) {
    btn.dataset.jkAction = action;
  }

  const iconSpan = document.createElement("span");
  iconSpan.className = "jk-item-icon";
  iconSpan.setAttribute("aria-hidden", "true");
  setTextContent(iconSpan, icon);

  const textSpan = document.createElement("span");
  textSpan.className = "jk-item-text";
  setTextContent(textSpan, text);

  if (typeof btn.append === "function") {
    btn.append(iconSpan, textSpan);
  } else if (typeof btn.appendChild === "function") {
    btn.appendChild(iconSpan);
    btn.appendChild(textSpan);
  } else if (Array.isArray(btn.children)) {
    btn.children.push(iconSpan, textSpan);
  }
  return btn;
}

/**
 * Synchronizes the top-right JK logo/button and its role-aware menu.
 */
export function updateJkMenu() {
  if (typeof document === "undefined") return;
  try {
    const menuBtn = document.getElementById("jkMenuButton");
    const badgeEl = document.getElementById("jkBadge");
    const labelEl = document.getElementById("jkLabel");
    const userNameEl = document.getElementById("jkDropdownUserName");
    const userRoleEl = document.getElementById("jkDropdownUserRole");
    const itemsContainer = document.getElementById("jkDropdownItems");
    if (!menuBtn || !itemsContainer) return;

    const user = getCurrentUser();
    const role = getUserRole();
    const authed = isAuthenticated();
    const worker = role === "worker" && user?.workerId ? getWorkerById(user.workerId) : null;
    const displayName = worker?.name || user?.name || "";
    const firstName = displayName ? displayName.split(" ")[0] : "";

    if (authed) {
      if (labelEl) setTextContent(labelEl, firstName || (role === "worker" ? "Worker" : "Account"));
      if (badgeEl) {
        const initials = (worker?.initials || (displayName ? displayName.slice(0, 2).toUpperCase() : "JK"));
        setTextContent(badgeEl, initials);
      }
      menuBtn.setAttribute("aria-label", `${displayName || "User"} account menu`);
    } else {
      if (labelEl) setTextContent(labelEl, "Sign In");
      if (badgeEl) setTextContent(badgeEl, "JK");
      menuBtn.setAttribute("aria-label", "Open JK FixHub menu");
    }

    if (userNameEl) {
      setTextContent(userNameEl, authed ? (displayName || "My Account") : "Welcome to JK FixHub");
    }
    if (userRoleEl) {
      if (!authed) {
        setTextContent(userRoleEl, "Find & book local services in Kashmir");
      } else if (role === "admin") {
        setTextContent(userRoleEl, "Platform Administrator");
      } else if (role === "worker") {
        setTextContent(userRoleEl, `Worker • ${worker?.service || "Technician"}`);
      } else {
        setTextContent(userRoleEl, `Customer Account • ${user?.district || "J&K"}`);
      }
    }

    if (typeof itemsContainer.replaceChildren === "function") {
      itemsContainer.replaceChildren();
    } else if ("innerHTML" in itemsContainer) {
      itemsContainer.innerHTML = "";
    } else if (Array.isArray(itemsContainer.children)) {
      itemsContainer.children = [];
    }

    function addItem(item) {
      if (!item) return;
      if (typeof itemsContainer.appendChild === "function") {
        itemsContainer.appendChild(item);
      } else if (Array.isArray(itemsContainer.children)) {
        itemsContainer.children.push(item);
      }
    }

    function addDivider() {
      const divider = document.createElement("div");
      divider.className = "jk-dropdown-divider";
      addItem(divider);
    }

    if (!authed) {
      addItem(createJkMenuItem("🔑", "Sign In", "sign-in", "primary"));
      addItem(createJkMenuItem("🔧", "Join as a Worker", "join-worker"));
      addItem(createJkMenuItem("👤", "Create Customer Account", "create-customer"));
    } else if (role === "admin") {
      addItem(createJkMenuItem("🛡️", "Platform Administration", "admin-dashboard", "highlight"));
      addItem(createJkMenuItem("👤", "Profile", "profile"));
      addDivider();
      addItem(createJkMenuItem("🚪", "Sign Out", "sign-out", "danger"));
    } else if (role === "worker") {
      addItem(createJkMenuItem("👤", "Profile", "profile"));
      addItem(createJkMenuItem("✏️", "Edit Profile", "edit-profile"));
      addItem(createJkMenuItem("🛠️", "Worker Dashboard", "worker-dashboard", "highlight"));
      addItem(createJkMenuItem("📋", "My Requests", "my-requests"));
      addDivider();
      addItem(createJkMenuItem("🚪", "Sign Out", "sign-out", "danger"));
    } else {
      // Customer
      addItem(createJkMenuItem("👤", "Profile", "profile"));
      addItem(createJkMenuItem("✏️", "Edit Profile", "edit-profile"));
      addItem(createJkMenuItem("📋", "My Requests", "my-requests"));
      addDivider();
      addItem(createJkMenuItem("🚪", "Sign Out", "sign-out", "danger"));
    }
  } catch (_) {
    // Non-blocking in headless/testing environments with partial mock DOM
  }
}

/**
 * Handles action triggers from the top-right JK menu.
 */
export function handleJkMenuAction(action) {
  const dropdown = document.getElementById("jkDropdownMenu");
  const menuBtn = document.getElementById("jkMenuButton");
  if (dropdown) dropdown.hidden = true;
  if (menuBtn) menuBtn.setAttribute("aria-expanded", "false");

  if (action === "admin-dashboard") {
    openAdminDashboard();
  } else if (action === "sign-in") {
    showSignIn();
    openModal("authModal");
  } else if (action === "join-worker") {
    showWorkerRegister();
    openModal("authModal");
  } else if (action === "create-customer") {
    showCustomerRegister();
    openModal("authModal");
  } else if (action === "profile") {
    showAccountView();
    openModal("authModal");
  } else if (action === "edit-profile") {
    const role = getUserRole();
    if (role === "worker") {
      openProfileEditor("account");
      openModal("workerProfileEditModal");
    } else {
      openCustomerProfileEditor();
      openModal("customerProfileEditModal");
    }
  } else if (action === "worker-dashboard") {
    openModal("authModal");
    openWorkerDashboard();
  } else if (action === "my-requests") {
    const role = getUserRole();
    if (role === "worker") {
      openModal("authModal");
      openWorkerDashboard();
    } else {
      openCustomerRequests();
    }
  } else if (action === "sign-out") {
    signOutUser();
  }
}

/**
 * Synchronizes header navigation and account buttons.
 */
export function updateAccountControls() {
  if (typeof document === "undefined") return;
  const continueButton = document.getElementById("authContinue");
  const accountButton = document.getElementById("authAccount");
  const dashboardButton = document.getElementById("workerDashboardButton");
  const user = getCurrentUser();
  const role = getUserRole();
  const worker = user?.role === "worker" && user.workerId ? getWorkerById(user.workerId) : null;

  if (continueButton) continueButton.hidden = isAuthenticated();
  if (accountButton) {
    accountButton.hidden = !isAuthenticated();
    setTextContent(accountButton, "Account");
    accountButton.setAttribute(
      "aria-label",
      user ? `${worker?.name || user.name} account` : "Account"
    );
  }
  if (dashboardButton) dashboardButton.hidden = role !== "worker";
  updateJkMenu();
}

/**
 * Sets up show/hide toggle for password fields.
 */
function setupPasswordToggles() {
  document.querySelectorAll("[data-toggle-password]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetId = btn.getAttribute("data-toggle-password");
      const input = document.getElementById(targetId);
      if (!input) return;
      const isPassword = input.type === "password";
      input.type = isPassword ? "text" : "password";
      btn.textContent = isPassword ? "Hide" : "Show";
      btn.setAttribute("aria-label", isPassword ? "Hide password" : "Show password");
    });
  });
}

/**
 * Displays signed out panels in auth modal. Defaults to the clean entry screen.
 */
export function showSignedOutView(preserveActiveTab = true) {
  if (typeof document === "undefined") return;
  const modal = document.querySelector("#authModal .modal");
  if (modal) {
    modal.classList.remove("worker-dashboard-open");
    modal.setAttribute("aria-labelledby", "authModalTitle");
  }
  stopWorkerDashboardSubscription();
  const signedOutView = document.getElementById("authSignedOutView");
  const accountView = document.getElementById("authAccountView");
  const dashboardView = document.getElementById("workerDashboardView");
  if (signedOutView) signedOutView.hidden = false;
  if (accountView) accountView.hidden = true;
  if (dashboardView) dashboardView.hidden = true;

  if (
    preserveActiveTab &&
    (activeAuthTab === "signin" || activeAuthTab === "customer-register" || activeAuthTab === "worker-register" || activeAuthTab === "password-reset")
  ) {
    switchAuthTab(activeAuthTab);
  } else {
    showAuthEntry();
  }
}

/**
 * Sets feedback message inside authenticated profile view.
 */
export function setAccountFeedback(message, isError = false) {
  if (typeof document === "undefined") return;
  const errorEl = document.getElementById("authAccountFeedback");
  const successEl = document.getElementById("authAccountSuccessFeedback");

  if (isError) {
    if (errorEl) {
      setTextContent(errorEl, message);
      errorEl.hidden = !message;
    }
    if (successEl) successEl.hidden = true;
  } else {
    if (successEl) {
      setTextContent(successEl, message);
      successEl.hidden = !message;
    }
    if (errorEl) errorEl.hidden = true;
  }
}

/**
 * Displays authenticated account view in auth modal.
 */
export function showAccountView(preserveFeedback = false) {
  if (typeof document === "undefined") return;
  const user = getCurrentUser();
  if (!user) {
    showSignedOutView(false);
    return;
  }

  if (!preserveFeedback) {
    setAccountFeedback("", false);
  }

  activeAuthTab = "account";
  syncAuthHash("account");

  const modal = document.querySelector("#authModal .modal");
  if (modal) {
    modal.classList.remove("worker-dashboard-open");
    modal.setAttribute("aria-labelledby", "authAccountTitle");
  }

  stopWorkerDashboardSubscription();
  const signedOutView = document.getElementById("authSignedOutView");
  const accountView = document.getElementById("authAccountView");
  const dashboardView = document.getElementById("workerDashboardView");
  if (signedOutView) signedOutView.hidden = true;
  if (accountView) accountView.hidden = false;
  if (dashboardView) dashboardView.hidden = true;

  const worker = user.role === "worker" && user.workerId ? getWorkerById(user.workerId) : null;
  const displayName = worker?.name || user.name || "User";
  setTextContent(document.getElementById("authUserName"), displayName);

  // Avatar initials
  const avatarEl = document.getElementById("authAccountAvatar");
  if (avatarEl) {
    const initials = worker?.initials || (displayName ? displayName.slice(0, 2).toUpperCase() : "JK");
    setTextContent(avatarEl, initials);
  }

  // Email display
  const emailEl = document.getElementById("authUserEmail");
  if (emailEl) {
    if (user.email) {
      setTextContent(emailEl, user.email);
      emailEl.hidden = false;
    } else {
      setTextContent(emailEl, "(Managed preview account)");
      emailEl.hidden = false;
    }
  }

  // Phone display
  const phoneEl = document.getElementById("authUserPhone");
  if (phoneEl) {
    setTextContent(phoneEl, user.phone || "Not provided");
  }

  // District display
  const districtEl = document.getElementById("authUserDistrict");
  if (districtEl) {
    setTextContent(districtEl, user.district || "Jammu & Kashmir");
  }

  // Worker-only fields
  const isWrk = user.role === "worker";
  const sField = document.getElementById("authWorkerServiceField");
  const eField = document.getElementById("authWorkerExperienceField");
  const aField = document.getElementById("authWorkerAvailabilityField");
  const rField = document.getElementById("authWorkerRatingField");

  if (sField) {
    sField.hidden = !isWrk;
    if (isWrk) setTextContent(document.getElementById("authWorkerServiceValue"), user.service || worker?.service || "Technician");
  }
  if (eField) {
    eField.hidden = !isWrk;
    if (isWrk) setTextContent(document.getElementById("authWorkerExperienceValue"), user.experience || worker?.experience || "N/A");
  }
  if (aField) {
    aField.hidden = !isWrk;
    if (isWrk) setTextContent(document.getElementById("authWorkerAvailabilityValue"), user.availability || worker?.availability || "Available");
  }
  if (rField) {
    rField.hidden = !isWrk;
    if (isWrk) setTextContent(document.getElementById("authWorkerRatingValue"), `${worker?.rating || user.rating || "5.0"} ★`);
  }

  // Role chip
  let roleLabel = "Worker Account";
  if (user.role === "customer") {
    roleLabel = "Customer Account";
  } else if (user.role === "admin") {
    roleLabel = "Platform Administrator";
  }
  setTextContent(document.getElementById("authUserRole"), roleLabel);

  // Email verification badge and notice (unobtrusive reminder for customer, required for worker)
  const verifiedBadge = document.getElementById("authEmailVerifiedBadge");
  const verificationNotice = document.getElementById("authEmailVerificationNotice");
  const dismissNoticeBtn = document.getElementById("authDismissVerificationNotice");
  const verificationPrompt = document.getElementById("authVerificationPrompt");

  if (verifiedBadge) {
    if (user.emailVerified) {
      setTextContent(verifiedBadge, "✓ Email Verified");
      verifiedBadge.className = "auth-verification-badge verified";
      verifiedBadge.hidden = false;
      if (verificationNotice) verificationNotice.hidden = true;
    } else if (user.role === "customer") {
      // Customer: email verification is optional and unobtrusive
      verifiedBadge.hidden = true;
      if (verificationNotice) {
        if (customerVerificationDismissed) {
          verificationNotice.hidden = true;
        } else {
          verificationNotice.hidden = false;
          verificationNotice.classList.add("auth-verification-notice-subtle");
          if (verificationPrompt) {
            setTextContent(verificationPrompt, "Verify your email to help secure your account and recover password if needed.");
          }
          if (dismissNoticeBtn) dismissNoticeBtn.hidden = false;
        }
      }
    } else if (user.role === "worker") {
      // Worker: email verification is required
      setTextContent(verifiedBadge, "Email Unverified");
      verifiedBadge.className = "auth-verification-badge unverified";
      verifiedBadge.hidden = false;
      if (verificationNotice) {
        verificationNotice.hidden = false;
        verificationNotice.classList.remove("auth-verification-notice-subtle");
        if (verificationPrompt) {
          setTextContent(verificationPrompt, "Your email address is not yet verified. Please verify your email before accepting service requests or updating your profile.");
        }
        if (dismissNoticeBtn) dismissNoticeBtn.hidden = true;
      }
    } else {
      verifiedBadge.hidden = true;
      if (verificationNotice) verificationNotice.hidden = true;
    }
  }

  // Worker status badge (high-contrast pending status)
  const workerStatusBadge = document.getElementById("authWorkerStatusBadge");
  if (workerStatusBadge) {
    if (user.role === "worker") {
      setTextContent(
        workerStatusBadge,
        user.isVerified ? "✓ Verified Worker" : "Pending Verification"
      );
      workerStatusBadge.className = `auth-worker-badge ${user.isVerified ? "verified" : "pending"}`;
      workerStatusBadge.hidden = false;
    } else {
      workerStatusBadge.hidden = true;
    }
  }

  // Dashboard buttons
  const workerBtn = document.getElementById("openWorkerDashboard");
  if (workerBtn) workerBtn.hidden = user.role !== "worker";
  const adminBtn = document.getElementById("openAdminDashboardBtn");
  if (adminBtn) adminBtn.hidden = user.role !== "admin";
  const editProfileBtn = document.getElementById("authEditProfileBtn");
  if (editProfileBtn) editProfileBtn.hidden = user.role === "admin";
}

/**
 * Opens customer profile editor modal and pre-fills current customer data.
 */
export function openCustomerProfileEditor() {
  if (typeof document === "undefined") return;
  const user = getCurrentUser();
  if (!user || user.role !== "customer") return;

  const form = document.getElementById("customerProfileEditForm");
  if (!form) return;
  form.reset();

  const nameInput = document.getElementById("editCustomerName");
  const emailInput = document.getElementById("editCustomerEmail");
  const phoneInput = document.getElementById("editCustomerPhone");
  const districtSelect = document.getElementById("editCustomerDistrict");
  const feedback = document.getElementById("customerProfileEditFeedback");
  const successFeedback = document.getElementById("customerProfileEditSuccessFeedback");

  if (feedback) {
    feedback.hidden = true;
    setTextContent(feedback, "");
  }
  if (successFeedback) {
    successFeedback.hidden = true;
    setTextContent(successFeedback, "");
  }
  form.querySelectorAll(".request-error").forEach((el) => {
    el.hidden = true;
    setTextContent(el, "");
  });

  if (nameInput) nameInput.value = user.name || "";
  if (emailInput) emailInput.value = user.email || "";
  if (phoneInput) phoneInput.value = user.phone || "";
  if (districtSelect && user.district) districtSelect.value = user.district;

  closeModal("authModal");
  openModal("customerProfileEditModal");
}

/**
 * Validates, saves, and syncs updated customer profile data.
 * Updates Firebase Auth (email verification/update, displayName),
 * Cloud Firestore /users/{uid}, and local state.
 * Never displays success if save fails.
 */
export async function saveCustomerProfile({ name, email, phone, district }) {
  const form = document.getElementById("customerProfileEditForm");
  const feedback = document.getElementById("customerProfileEditFeedback");
  const successFeedback = document.getElementById("customerProfileEditSuccessFeedback");

  function setFeedback(msg, isErr = true) {
    if (feedback && isErr) {
      setTextContent(feedback, msg);
      feedback.hidden = !msg;
    }
    if (successFeedback && !isErr) {
      setTextContent(successFeedback, msg);
      successFeedback.hidden = !msg;
    }
    if (isErr && successFeedback) successFeedback.hidden = true;
    if (!isErr && feedback) feedback.hidden = true;
  }

  setFeedback("", true);
  if (form) {
    form.querySelectorAll(".request-error").forEach((el) => {
      el.hidden = true;
      setTextContent(el, "");
    });
  }

  const user = getCurrentUser();
  if (!user || user.role !== "customer") {
    recordSecurityEvent("UNAUTHORIZED_UI_ACTION", user?.role || null);
    setFeedback("Only signed-in customers can edit customer profiles.", true);
    return { success: false, error: "Unauthorized" };
  }

  const isNameValid = validatePersonName(name);
  if (!isNameValid) {
    setFieldError("editCustomerName", "editCustomerNameError", getSafeErrorMessage("invalidName"));
    return { success: false, error: getSafeErrorMessage("invalidName") };
  }

  const isEmailValid = validateEmail(email);
  if (!isEmailValid) {
    setFieldError("editCustomerEmail", "editCustomerEmailError", getSafeErrorMessage("invalidEmail"));
    return { success: false, error: getSafeErrorMessage("invalidEmail") };
  }

  let trimmedPhone = null;
  const rawPhone = (typeof phone === "string" ? phone : "").trim();
  if (rawPhone) {
    const normalizedPhone = normalizePhoneNumber(rawPhone);
    if (!normalizedPhone) {
      setFieldError("editCustomerPhone", "editCustomerPhoneError", "Please enter a valid 10-digit mobile number.");
      return { success: false, error: "Please enter a valid 10-digit mobile number." };
    }
    trimmedPhone = normalizedPhone;
  }

  if (!district || !ALLOWED_DISTRICTS.includes(district)) {
    setFieldError("editCustomerDistrict", "editCustomerDistrictError", getSafeErrorMessage("invalidDistrict"));
    return { success: false, error: getSafeErrorMessage("invalidDistrict") };
  }

  const trimmedName = name.trim();
  const trimmedEmail = email.trim();

  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    const errorMsg = "Network connection error. Please check your internet connection and try again.";
    setFeedback(errorMsg, true);
    return { success: false, error: errorMsg };
  }

  const submitBtn = typeof document !== "undefined" ? document.getElementById("saveCustomerProfileBtn") : null;
  const restoreBtn = setButtonLoading(submitBtn, "Saving changes...");
  setFeedback("Saving your profile changes...", false);

  try {
    // If Firebase-authenticated user
    if (user.authProvider === "firebase" && user.id) {
      try {
        const { auth } = await initializeFirebaseClient();
        const methods = await getFirebaseAuthMethods();

        // Check if email changed
        if (auth?.currentUser && trimmedEmail !== user.email) {
          try {
            if (typeof methods?.verifyBeforeUpdateEmail === "function") {
              await methods.verifyBeforeUpdateEmail(auth.currentUser, trimmedEmail);
            } else if (typeof methods?.updateEmail === "function") {
              await methods.updateEmail(auth.currentUser, trimmedEmail);
            }
          } catch (emailErr) {
            recordSecurityEvent("EMAIL_UPDATE_ERROR", "customer");
            let safeMsg = "Failed to update email address.";
            if (emailErr.code === "auth/requires-recent-login") {
              safeMsg = "Updating your email requires recent authentication. Please sign out and sign in again before changing your email.";
            } else if (emailErr.code === "auth/email-already-in-use") {
              safeMsg = "That email address is already in use by another account.";
            } else if (emailErr.code === "auth/invalid-email") {
              safeMsg = "The email address format is invalid.";
            }
            setFeedback(safeMsg, true);
            return { success: false, error: safeMsg };
          }
        }

        // Update displayName
        if (auth?.currentUser && typeof methods?.updateProfile === "function" && trimmedName !== user.name) {
          try {
            await methods.updateProfile(auth.currentUser, { displayName: trimmedName });
          } catch (nameErr) {
            console.warn("[JKFixHub Auth] updateProfile notice:", nameErr?.message || nameErr);
          }
        }

        // Sync Firestore /users/{uid}
        try {
          const { db } = await initializeFirestoreClient();
          const firestoreMethods = await getFirestoreMethods();
          if (db && firestoreMethods && typeof firestoreMethods.updateDoc === "function") {
            const userDocRef = firestoreMethods.doc(db, "users", user.id);
            await firestoreMethods.updateDoc(userDocRef, {
              name: trimmedName,
              email: trimmedEmail,
              phone: trimmedPhone,
              district,
              updatedAt: new Date().toISOString()
            });
          }
        } catch (firestoreErr) {
          console.warn("[JKFixHub Auth] Firestore user profile sync error:", firestoreErr?.message || firestoreErr);
          setFeedback("Failed to update profile in database.", true);
          return { success: false, error: "Database update failed." };
        }

        // Update state
        saveApplicationProfile(user.id, {
          role: "customer",
          name: trimmedName,
          email: trimmedEmail,
          phone: trimmedPhone,
          district,
          emailVerified: user.emailVerified,
          isVerified: false,
          authProvider: "firebase",
          createdAt: user.createdAt
        });

        setCurrentUser({
          ...user,
          name: trimmedName,
          email: trimmedEmail,
          phone: trimmedPhone,
          district
        });

        recordSecurityEvent("PROFILE_UPDATED", "customer");
        updateAccountControls();
        closeModal("customerProfileEditModal");
        showAccountView(true);
        setAccountFeedback("Profile updated successfully!", false);
        openModal("authModal");
        return { success: true };
      } catch (err) {
        recordSecurityEvent("FIREBASE_AUTH_ERROR", "customer");
        const safeMessage = mapFirebaseAuthError(err);
        setFeedback(safeMessage, true);
        return { success: false, error: safeMessage };
      }
    }

    // Session / Demo mode fallback
    saveApplicationProfile(user.id, {
      role: "customer",
      name: trimmedName,
      email: trimmedEmail,
      phone: trimmedPhone,
      district,
      emailVerified: Boolean(user.emailVerified),
      isVerified: false,
      authProvider: user.authProvider || "demo",
      createdAt: user.createdAt || new Date().toISOString()
    });

    setCurrentUser({
      ...user,
      name: trimmedName,
      email: trimmedEmail,
      phone: trimmedPhone,
      district
    });

    recordSecurityEvent("PROFILE_UPDATED", "customer");
    updateAccountControls();
    closeModal("customerProfileEditModal");
    showAccountView(true);
    setAccountFeedback("Profile updated successfully!", false);
    openModal("authModal");
    return { success: true };
  } finally {
    restoreBtn();
  }
}

/**
 * Initializes Firebase Auth state observer and DOM listeners.
 */
export function initializeAuth() {
  const modal = document.getElementById("authModal");
  if (!modal || initialized) return;
  initialized = true;

  updateAccountControls();
  setupPasswordToggles();

  // Form Submissions
  const signInForm = document.getElementById("authSignInForm");
  if (signInForm) {
    signInForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = document.getElementById("authSignInEmail")?.value || "";
      const password = document.getElementById("authSignInPassword")?.value || "";
      await signInUser({ email, password });
    });
  }

  const customerRegisterForm = document.getElementById("authCustomerRegisterForm");
  if (customerRegisterForm) {
    customerRegisterForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = document.getElementById("authCustomerName")?.value || "";
      const email = document.getElementById("authCustomerEmail")?.value || "";
      const phone = document.getElementById("authCustomerPhone")?.value || "";
      const district = document.getElementById("authCustomerDistrict")?.value || "";
      const password = document.getElementById("authCustomerPassword")?.value || "";
      const confirmPassword = document.getElementById("authCustomerConfirmPassword")?.value || null;
      await registerCustomer({ name, email, phone, district, password, confirmPassword });
    });
  }

  const togglePhoneBtn = document.getElementById("authCustomerTogglePhoneBtn");
  const phoneContainer = document.getElementById("authCustomerPhoneContainer");
  if (togglePhoneBtn && phoneContainer) {
    togglePhoneBtn.addEventListener("click", () => {
      phoneContainer.hidden = false;
      togglePhoneBtn.hidden = true;
      document.getElementById("authCustomerPhone")?.focus();
    });
  }

  const dismissVerificationNoticeBtn = document.getElementById("authDismissVerificationNotice");
  if (dismissVerificationNoticeBtn) {
    dismissVerificationNoticeBtn.addEventListener("click", () => {
      dismissCustomerVerificationReminder();
    });
  }

  const workerRegisterForm = document.getElementById("authWorkerRegisterForm");
  if (workerRegisterForm) {
    workerRegisterForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = document.getElementById("authWorkerName")?.value || "";
      const email = document.getElementById("authWorkerEmail")?.value || "";
      const phone = document.getElementById("authWorkerPhone")?.value || "";
      const district = document.getElementById("authWorkerDistrict")?.value || "";
      const service = document.getElementById("authWorkerService")?.value || "";
      const experience = document.getElementById("authWorkerExperience")?.value || "";
      const availability = document.getElementById("authWorkerAvailability")?.value || "Available";
      const password = document.getElementById("authWorkerPassword")?.value || "";
      const confirmPassword = document.getElementById("authWorkerConfirmPassword")?.value || "";
      await registerWorker({ name, email, phone, district, service, experience, availability, password, confirmPassword });
    });
  }

  const customerProfileEditForm = document.getElementById("customerProfileEditForm");
  if (customerProfileEditForm) {
    customerProfileEditForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = document.getElementById("editCustomerName")?.value || "";
      const email = document.getElementById("editCustomerEmail")?.value || "";
      const phone = document.getElementById("editCustomerPhone")?.value || "";
      const district = document.getElementById("editCustomerDistrict")?.value || "";
      await saveCustomerProfile({ name, email, phone, district });
    });
  }

  const passwordResetForm = document.getElementById("authPasswordResetForm");
  if (passwordResetForm) {
    passwordResetForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = document.getElementById("authPasswordResetEmail")?.value || "";
      await handlePasswordResetSubmit(email);
    });
  }

  // Capture-phase auth gating for actions requiring an authenticated account
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    if (target.closest("[data-request-worker]")) {
      if (!isAuthenticated()) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        closeModal("profileModal");
        showSignedOutView();
        openModal("authModal");
      }
    }
  }, true);

  // Delegated Click Handlers
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    // Entry view options
    if (target.closest("#authEntrySignInBtn")) {
      showSignIn();
    } else if (target.closest("#authEntryCustomerRegisterBtn")) {
      showCustomerRegister();
    } else if (target.closest("#authEntryWorkerRegisterBtn")) {
      showWorkerRegister();
    } else if (target.closest("#authSignInBack, #authCustomerRegisterBack, #authWorkerRegisterBack, #authSignInToRegister")) {
      showAuthEntry();
    } else if (target.closest("#authCustomerToSignIn, #authWorkerToSignIn, #authPasswordResetBack, #authPasswordResetToSignIn")) {
      showSignIn();
    } else if (target.closest("#authForgotPasswordBtn")) {
      showPasswordReset();
    } else if (target.closest('[data-auth-target="worker-register"], [data-registration]')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const user = getCurrentUser();
      if (user?.role === "worker") {
        if (openWorkerDashboard()) openModal("authModal");
      } else if (user) {
        showAccountView();
        openModal("authModal");
      } else {
        showWorkerRegister();
        openModal("authModal");
      }
    } else if (target.closest("#authContinue")) {
      if (isAuthenticated()) {
        showAccountView();
      } else {
        showSignIn();
      }
      openModal("authModal");
    } else if (target.closest("#authAccount")) {
      showAccountView();
      openModal("authModal");
    } else if (target.closest(".auth-tab-btn")) {
      const tab = target.closest(".auth-tab-btn").dataset.authTab;
      switchAuthTab(tab);
    } else if (target.closest("[data-auth-role]")) {
      const role = target.closest("[data-auth-role]").dataset.authRole;
      if (!demoLogin(role)) {
        setAuthFeedback("That demo account is not available.", true);
        return;
      }
      updateAccountControls();
      showAccountView();
    } else if (target.closest("#authLogout, #authLogoutFromDashboard, #adminLogoutButton")) {
      signOutUser();
    } else if (target.closest("#authResendVerification")) {
      resendVerificationEmail();
    } else if (target.closest("#authRefreshVerification")) {
      refreshUserVerificationStatus();
    } else if (target.closest("#workerDashboardButton")) {
      if (openWorkerDashboard()) openModal("authModal");
    } else if (target.closest("#openWorkerDashboard")) {
      openWorkerDashboard();
    } else if (target.closest("#openAdminDashboardBtn")) {
      closeModal("authModal");
      openAdminDashboard();
    } else if (target.closest("#backToAccount")) {
      showAccountView();
    } else if (target.closest("#authBackToRoles")) {
      showSignedOutView(false);
    } else if (target.closest("#authEditProfileBtn")) {
      const role = getUserRole();
      if (role === "worker") {
        openProfileEditor("account");
      } else {
        openCustomerProfileEditor();
      }
    } else if (target.closest("[data-jk-action]")) {
      const actionBtn = target.closest("[data-jk-action]");
      handleJkMenuAction(actionBtn.dataset.jkAction);
    }
  });

  // Direct hash navigation listener
  window.addEventListener("hashchange", handleAuthHashNavigation);
  handleAuthHashNavigation();

  // Clear auth hash and stop active subscriptions when modal is closed
  modal.addEventListener("modal:close", () => {
    stopWorkerDashboardSubscription();
    clearAuthHash();
  });

  // Reactive UI update on profile update
  window.addEventListener("profile:updated", () => {
    updateAccountControls();
    if (activeAuthTab === "account") {
      showAccountView(true);
      setAccountFeedback("Profile updated successfully!", false);
    }
  });

  // Sync sign out when admin dashboard triggers logout
  window.addEventListener("admin:logout", () => {
    signOutUser();
  });

  // Initialize Firebase client in background without blocking UI
  (async () => {
    try {
      const { auth, isConfigured: hasConfig } = await initializeFirebaseClient();
      const methods = await getFirebaseAuthMethods();

      if (hasConfig && auth && methods && typeof methods.onAuthStateChanged === "function") {
        methods.onAuthStateChanged(
          auth,
          async (firebaseUser) => {
            try {
              if (firebaseUser) {
                if (
                  (pendingRegistrationUid && pendingRegistrationUid === firebaseUser.uid) ||
                  (pendingRegistrationEmail && pendingRegistrationEmail === firebaseUser.email?.toLowerCase().trim())
                ) {
                  return;
                }
                let existingProfile = getApplicationProfile(firebaseUser.uid);

                try {
                  const { db } = await initializeFirestoreClient();
                  const firestoreMethods = await getFirestoreMethods();
                  if (db && firestoreMethods && typeof firestoreMethods.getDoc === "function") {
                    const userDoc = await firestoreMethods.getDoc(firestoreMethods.doc(db, "users", firebaseUser.uid));
                    if (userDoc.exists()) {
                      const uData = userDoc.data();
                      const role = isSupportedRole(uData?.role) ? uData.role : null;
                      if (role) {
                        const resolvedEmail = uData.email || firebaseUser.email;
                        const resolvedPhone = uData.phone || null;
                        existingProfile = {
                          ...existingProfile,
                          role,
                          name: uData.name || existingProfile?.name || firebaseUser.displayName || (role === "worker" ? "Worker" : "Customer"),
                          email: resolvedEmail,
                          phone: resolvedPhone,
                          district: uData.district || null
                        };

                        if (existingProfile.role === "worker") {
                          const wDoc = await firestoreMethods.getDoc(firestoreMethods.doc(db, "workers", firebaseUser.uid));
                          if (wDoc.exists()) {
                            const wData = wDoc.data();
                            existingProfile.service = wData.service || null;
                            existingProfile.experience = wData.experience || null;
                            existingProfile.availability = wData.availability || "Available";
                            existingProfile.isVerified = Boolean(wData.isVerified);
                            existingProfile.status = wData.status || "pending";
                          } else {
                            existingProfile.status = "pending";
                            existingProfile.isVerified = false;
                          }
                        }
                      } else {
                        existingProfile = null;
                      }
                    } else {
                      existingProfile = null;
                    }

                    // Authoritative admin verification against /admins/{uid}
                    if (!existingProfile || existingProfile.role === "admin") {
                      try {
                        const adminDoc = await firestoreMethods.getDoc(firestoreMethods.doc(db, "admins", firebaseUser.uid));
                        if (adminDoc.exists()) {
                          const aData = adminDoc.data();
                          if (aData && aData.active === true && aData.role === "admin") {
                            existingProfile = {
                              ...existingProfile,
                              role: "admin",
                              name: aData.displayName || existingProfile?.name || firebaseUser.displayName || "Platform Administrator",
                              email: aData.email || firebaseUser.email,
                              phone: aData.phone || existingProfile?.phone || null,
                              district: aData.district || existingProfile?.district || null,
                              createdAt: aData.createdAt || existingProfile?.createdAt || new Date().toISOString()
                            };
                          } else if (existingProfile?.role === "admin") {
                            existingProfile = null;
                          }
                        } else if (existingProfile?.role === "admin") {
                          existingProfile = null;
                        }
                      } catch (adminErr) {
                        if (existingProfile?.role === "admin") {
                          existingProfile = null;
                        }
                      }
                    }
                  }
                } catch (fetchErr) {
                  console.warn("[JKFixHub Auth] Firestore background profile sync notice:", fetchErr?.message || fetchErr);
                }

                if (!existingProfile?.role || !isSupportedRole(existingProfile.role)) {
                  console.warn("[JKFixHub Auth] Missing valid Firestore profile for authenticated user:", firebaseUser.uid);
                  clearCurrentUser();
                  if (typeof methods.signOut === "function") {
                    try {
                      await methods.signOut(auth);
                    } catch (_) {}
                  }
                  updateAccountControls();
                  return;
                }

                const currentUser = {
                  id: firebaseUser.uid,
                  firebaseUid: firebaseUser.uid,
                  role: existingProfile.role,
                  name: existingProfile.name || firebaseUser.displayName || (existingProfile.role === "worker" ? "Worker" : "Customer"),
                  email: existingProfile.email || firebaseUser.email,
                  phone: existingProfile.phone || null,
                  district: existingProfile.district || null,
                  service: existingProfile.service || null,
                  experience: existingProfile.experience || null,
                  availability: existingProfile.availability || "Available",
                  emailVerified: Boolean(firebaseUser.emailVerified),
                  workerId: existingProfile.workerId || null,
                  isVerified: Boolean(existingProfile.isVerified),
                  status: existingProfile.status || (existingProfile.role === "worker" ? "pending" : null),
                  authProvider: "firebase",
                  createdAt: existingProfile.createdAt || new Date().toISOString()
                };
                setCurrentUser(currentUser);
                recordSecurityEvent("AUTH_STATE_CHANGED", currentUser.role);
                updateAccountControls();
                if (currentUser.role === "admin" && (window.location.hash === "#admin" || window.location.hash === "#admin-dashboard")) {
                  openAdminDashboard();
                }
              } else {
                const current = getCurrentUser();
                if (current?.authProvider === "firebase") {
                  clearCurrentUser();
                  recordSecurityEvent("AUTH_STATE_CHANGED", null);
                  updateAccountControls();
                  // Guard: do NOT reset panel or close modal if user is actively filling out a registration, login, or password reset form
                  const isInteractingWithForm = ["signin", "customer-register", "worker-register", "password-reset"].includes(activeAuthTab);
                  if (!isInteractingWithForm) {
                    showSignedOutView(false);
                  }
                }
              }
            } catch (observerErr) {
              console.warn("[JKFixHub Auth] Auth observer handler notice:", observerErr?.message || observerErr);
            }
          },
          (authError) => {
            console.warn("[JKFixHub Auth] onAuthStateChanged background notice:", authError?.message || authError);
          }
        );
      }
    } catch (e) {
      console.warn("[JKFixHub Auth] Background Firebase observer setup notice:", e?.message || e);
    }
  })();
}
