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
import { openWorkerDashboard } from "./worker-dashboard.js";
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
  getApplicationProfile
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
  getSafeErrorMessage
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

/**
 * View controllers for auth modal navigation.
 */
export function showAuthEntry() {
  activeAuthTab = "entry";
  if (typeof document === "undefined") return;
  clearAuthFieldErrors();

  const entryView = document.getElementById("authEntryView");
  const signInPanel = document.getElementById("authSignInPanel");
  const custPanel = document.getElementById("authCustomerRegisterPanel");
  const wrkPanel = document.getElementById("authWorkerRegisterPanel");
  const rolePanel = document.getElementById("authRoleSelection");

  if (entryView) entryView.hidden = false;
  if (signInPanel) signInPanel.hidden = true;
  if (custPanel) custPanel.hidden = true;
  if (wrkPanel) wrkPanel.hidden = true;
  if (rolePanel) rolePanel.hidden = true;
}

export function showSignIn() {
  activeAuthTab = "signin";
  if (typeof document === "undefined") return;
  clearAuthFieldErrors();

  const entryView = document.getElementById("authEntryView");
  const signInPanel = document.getElementById("authSignInPanel");
  const custPanel = document.getElementById("authCustomerRegisterPanel");
  const wrkPanel = document.getElementById("authWorkerRegisterPanel");
  const rolePanel = document.getElementById("authRoleSelection");

  if (entryView) entryView.hidden = true;
  if (signInPanel) {
    signInPanel.hidden = false;
    document.getElementById("authSignInEmail")?.focus();
  }
  if (custPanel) custPanel.hidden = true;
  if (wrkPanel) wrkPanel.hidden = true;
  if (rolePanel) rolePanel.hidden = true;
}

export function showCustomerRegister() {
  activeAuthTab = "customer-register";
  if (typeof document === "undefined") return;
  clearAuthFieldErrors();

  const entryView = document.getElementById("authEntryView");
  const signInPanel = document.getElementById("authSignInPanel");
  const custPanel = document.getElementById("authCustomerRegisterPanel");
  const wrkPanel = document.getElementById("authWorkerRegisterPanel");
  const rolePanel = document.getElementById("authRoleSelection");

  if (entryView) entryView.hidden = true;
  if (signInPanel) signInPanel.hidden = true;
  if (custPanel) {
    custPanel.hidden = false;
    document.getElementById("authCustomerName")?.focus();
  }
  if (wrkPanel) wrkPanel.hidden = true;
  if (rolePanel) rolePanel.hidden = true;
}

export function showWorkerRegister() {
  activeAuthTab = "worker-register";
  if (typeof document === "undefined") return;
  clearAuthFieldErrors();

  const entryView = document.getElementById("authEntryView");
  const signInPanel = document.getElementById("authSignInPanel");
  const custPanel = document.getElementById("authCustomerRegisterPanel");
  const wrkPanel = document.getElementById("authWorkerRegisterPanel");
  const rolePanel = document.getElementById("authRoleSelection");

  if (entryView) entryView.hidden = true;
  if (signInPanel) signInPanel.hidden = true;
  if (custPanel) custPanel.hidden = true;
  if (wrkPanel) {
    wrkPanel.hidden = false;
    document.getElementById("authWorkerName")?.focus();
  }
  if (rolePanel) rolePanel.hidden = true;
}

/**
 * Switches between auth tabs/views.
 */
export function switchAuthTab(tabName) {
  if (tabName === "entry") return showAuthEntry();
  if (tabName === "signin") return showSignIn();
  if (tabName === "customer-register") return showCustomerRegister();
  if (tabName === "worker-register") return showWorkerRegister();
  if (tabName === "demo-roles") {
    activeAuthTab = "demo-roles";
    const entryView = document.getElementById("authEntryView");
    const signInPanel = document.getElementById("authSignInPanel");
    const custPanel = document.getElementById("authCustomerRegisterPanel");
    const wrkPanel = document.getElementById("authWorkerRegisterPanel");
    const rolePanel = document.getElementById("authRoleSelection");
    if (entryView) entryView.hidden = true;
    if (signInPanel) signInPanel.hidden = true;
    if (custPanel) custPanel.hidden = true;
    if (wrkPanel) wrkPanel.hidden = true;
    if (rolePanel) rolePanel.hidden = false;
    return;
  }
  showAuthEntry();
}

/**
 * Registers a new Customer using full profile attributes:
 * name, email, phone, district, password, confirmPassword.
 */
export async function registerCustomer({ name, email, phone, district, password, confirmPassword }) {
  clearAuthFieldErrors();

  const isNameValid = validatePersonName(name);
  if (!isNameValid) {
    setFieldError("authCustomerName", "authCustomerNameError", getSafeErrorMessage("invalidName"));
    return { success: false, error: getSafeErrorMessage("invalidName") };
  }

  const isEmailValid = validateEmail(email);
  if (!isEmailValid) {
    setFieldError("authCustomerEmail", "authCustomerEmailError", getSafeErrorMessage("invalidEmail"));
    return { success: false, error: getSafeErrorMessage("invalidEmail") };
  }

  const isPhoneValid = validatePhone(phone);
  if (!isPhoneValid) {
    setFieldError("authCustomerPhone", "authCustomerPhoneError", getSafeErrorMessage("invalidPhone"));
    return { success: false, error: getSafeErrorMessage("invalidPhone") };
  }

  if (!district || !ALLOWED_DISTRICTS.includes(district)) {
    setFieldError("authCustomerDistrict", "authCustomerDistrictError", getSafeErrorMessage("invalidDistrict"));
    return { success: false, error: getSafeErrorMessage("invalidDistrict") };
  }

  const passCheck = validatePassword(password, confirmPassword);
  if (!passCheck.isValid) {
    const errorMsg = getSafeErrorMessage(passCheck.errorKey);
    setFieldError(
      passCheck.errorKey === "passwordsDoNotMatch" ? "authCustomerConfirmPassword" : "authCustomerPassword",
      passCheck.errorKey === "passwordsDoNotMatch" ? "authCustomerConfirmPasswordError" : "authCustomerPasswordError",
      errorMsg
    );
    return { success: false, error: errorMsg };
  }

  recordSecurityEvent("REGISTER_ATTEMPT", "customer");

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
      const userCredential = await methods.createUserWithEmailAndPassword(auth, email, password);
      const user = userCredential.user;

      if (typeof methods.updateProfile === "function") {
        try {
          await methods.updateProfile(user, { displayName: name });
        } catch {
          // Non-blocking metadata update
        }
      }

      if (typeof methods.sendEmailVerification === "function") {
        try {
          await methods.sendEmailVerification(user);
          recordSecurityEvent("EMAIL_VERIFICATION_SENT");
        } catch {
          recordSecurityEvent("EMAIL_VERIFICATION_FAILED");
        }
      }

      const createdAt = new Date().toISOString();

      // Sync customer profile to Firestore /users/{uid}
      try {
        const { db } = await initializeFirestoreClient();
        const firestoreMethods = await getFirestoreMethods();
        if (db && firestoreMethods && typeof firestoreMethods.setDoc === "function") {
          const userDocRef = firestoreMethods.doc(db, "users", user.uid);
          await firestoreMethods.setDoc(userDocRef, {
            uid: user.uid,
            name,
            email,
            phone,
            district,
            role: "customer",
            emailVerified: Boolean(user.emailVerified),
            createdAt
          });
        }
      } catch (firestoreErr) {
        console.warn("[JKFixHub Auth] Firestore customer sync deferred:", firestoreErr?.message || firestoreErr);
      }

      saveApplicationProfile(user.uid, {
        role: "customer",
        name,
        email,
        phone,
        district,
        emailVerified: Boolean(user.emailVerified),
        isVerified: false,
        authProvider: "firebase",
        createdAt
      });

      setCurrentUser({
        id: user.uid,
        firebaseUid: user.uid,
        role: "customer",
        name,
        email,
        phone,
        district,
        emailVerified: Boolean(user.emailVerified),
        isVerified: false,
        authProvider: "firebase",
        createdAt
      });

      recordSecurityEvent("REGISTER_SUCCESS", "customer");
      updateAccountControls();
      showAccountView();
      setAuthFeedback("Account created! A verification email has been sent. You can start using JK FixHub immediately.", false);
      return { success: true };
    } catch (error) {
      recordSecurityEvent("FIREBASE_AUTH_ERROR");
      setAuthStatus(AUTH_STATUS.ERROR, error?.code || "auth-error");
      const safeMessage = mapFirebaseAuthError(error);
      setAuthFeedback(safeMessage, true);
      return { success: false, error: safeMessage };
    }
  }

  // Session Fallback
  const createdAt = new Date().toISOString();
  const demoUid = `cust-${Date.now().toString(36)}`;
  saveApplicationProfile(demoUid, {
    role: "customer",
    name,
    email,
    phone,
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
    email,
    phone,
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

  const allowedServices = ["Electrician", "Washing Machine Repair", "Refrigerator Repair", "Heater Repair", "TV / Electronics Repair"];
  if (!service || !allowedServices.includes(service)) {
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
      const userCredential = await methods.createUserWithEmailAndPassword(auth, email, password);
      const user = userCredential.user;

      if (typeof methods.updateProfile === "function") {
        try {
          await methods.updateProfile(user, { displayName: name });
        } catch {
          // Non-blocking
        }
      }

      if (typeof methods.sendEmailVerification === "function") {
        try {
          await methods.sendEmailVerification(user);
          recordSecurityEvent("EMAIL_VERIFICATION_SENT");
        } catch {
          recordSecurityEvent("EMAIL_VERIFICATION_FAILED");
        }
      }

      const createdAt = new Date().toISOString();

      // Sync worker profile to Firestore /users/{uid} and /workers/{uid}
      try {
        const { db } = await initializeFirestoreClient();
        const firestoreMethods = await getFirestoreMethods();
        if (db && firestoreMethods && typeof firestoreMethods.setDoc === "function") {
          // 1. users/{uid}
          const userDocRef = firestoreMethods.doc(db, "users", user.uid);
          await firestoreMethods.setDoc(userDocRef, {
            uid: user.uid,
            name,
            email,
            phone,
            district,
            role: "worker",
            emailVerified: Boolean(user.emailVerified),
            createdAt
          });

          // 2. workers/{uid} (Pending Verification)
          const workerDocRef = firestoreMethods.doc(db, "workers", user.uid);
          await firestoreMethods.setDoc(workerDocRef, {
            id: user.uid,
            uid: user.uid,
            name,
            email,
            phone,
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
      } catch (firestoreErr) {
        console.warn("[JKFixHub Auth] Firestore worker sync deferred:", firestoreErr?.message || firestoreErr);
      }

      saveApplicationProfile(user.uid, {
        role: "worker",
        name,
        email,
        phone,
        district,
        service,
        experience: experience.trim(),
        availability: safeAvailability,
        emailVerified: Boolean(user.emailVerified),
        isVerified: false,
        status: "pending",
        authProvider: "firebase",
        createdAt
      });

      setCurrentUser({
        id: user.uid,
        firebaseUid: user.uid,
        role: "worker",
        name,
        email,
        phone,
        district,
        service,
        experience: experience.trim(),
        availability: safeAvailability,
        workerId: null,
        emailVerified: Boolean(user.emailVerified),
        isVerified: false,
        authProvider: "firebase",
        createdAt
      });

      recordSecurityEvent("REGISTER_SUCCESS", "worker");
      updateAccountControls();
      showAccountView();
      setAuthFeedback("Worker account created! Status: Pending Verification. Please check your email for verification.", false);
      return { success: true };
    } catch (error) {
      recordSecurityEvent("FIREBASE_AUTH_ERROR");
      setAuthStatus(AUTH_STATUS.ERROR, error?.code || "auth-error");
      const safeMessage = mapFirebaseAuthError(error);
      setAuthFeedback(safeMessage, true);
      return { success: false, error: safeMessage };
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

  recordSecurityEvent("LOGIN_ATTEMPT");

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
      const userCredential = await methods.signInWithEmailAndPassword(auth, email, password);
      const user = userCredential.user;

      let profile = getApplicationProfile(user.uid);

      // Try fetching profile from Firestore
      try {
        const { db } = await initializeFirestoreClient();
        const firestoreMethods = await getFirestoreMethods();
        if (db && firestoreMethods && typeof firestoreMethods.getDoc === "function") {
          const userDoc = await firestoreMethods.getDoc(firestoreMethods.doc(db, "users", user.uid));
          if (userDoc.exists()) {
            const data = userDoc.data();
            profile = {
              role: data.role || "customer",
              name: data.name || user.displayName || "Customer",
              email: data.email || user.email,
              phone: data.phone || null,
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
              }
            }
          }
        }
      } catch (e) {
        // Fallback to local profile cache
      }

      if (!profile) {
        profile = {
          role: "customer",
          name: user.displayName || "Customer",
          email: user.email,
          phone: null,
          district: null,
          isVerified: false,
          authProvider: "firebase",
          createdAt: new Date().toISOString()
        };
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
        email: user.email,
        phone: profile.phone || null,
        district: profile.district || null,
        service: profile.service || null,
        experience: profile.experience || null,
        availability: profile.availability || "Available",
        workerId: profile.workerId || null,
        emailVerified: Boolean(user.emailVerified),
        isVerified: Boolean(profile.isVerified),
        authProvider: "firebase",
        createdAt: profile.createdAt || new Date().toISOString()
      });

      updateAccountControls();
      showAccountView();
      setAuthFeedback("Signed in successfully.", false);
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
}

/**
 * Resends email verification to the authenticated Firebase user.
 */
export async function resendVerificationEmail() {
  const user = getCurrentUser();
  if (!user || user.authProvider !== "firebase") {
    const feedback = document.getElementById("authVerificationActionFeedback");
    if (feedback) {
      setTextContent(feedback, "Verification email cannot be resent for this account.");
      feedback.hidden = false;
    }
    return false;
  }

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
      const feedback = document.getElementById("authVerificationActionFeedback");
      if (feedback) {
        setTextContent(feedback, "Verification email resent! Check your inbox.");
        feedback.hidden = false;
      }
      return true;
    } catch (error) {
      recordSecurityEvent("EMAIL_VERIFICATION_FAILED");
      const feedback = document.getElementById("authVerificationActionFeedback");
      if (feedback) {
        setTextContent(feedback, mapFirebaseAuthError(error));
        feedback.hidden = false;
      }
      return false;
    }
  }

  return false;
}

/**
 * Signs out current user (Firebase signOut + application cleanup).
 */
export async function signOutUser() {
  const role = getUserRole();
  recordSecurityEvent("LOGOUT", role);

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
  showSignedOutView();
  setAuthFeedback("Signed out.", false);
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
  unsubscribeAllFirestoreListeners();
  resetDemoChatState();
  clearCurrentUser();
  clearRequestState();
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
export function showSignedOutView() {
  if (typeof document === "undefined") return;
  const modal = document.querySelector("#authModal .modal");
  if (modal) {
    modal.classList.remove("worker-dashboard-open");
    modal.setAttribute("aria-labelledby", "authModalTitle");
  }
  const signedOutView = document.getElementById("authSignedOutView");
  const accountView = document.getElementById("authAccountView");
  const dashboardView = document.getElementById("workerDashboardView");
  if (signedOutView) signedOutView.hidden = false;
  if (accountView) accountView.hidden = true;
  if (dashboardView) dashboardView.hidden = true;
  showAuthEntry();
}

/**
 * Displays authenticated account view in auth modal.
 */
export function showAccountView() {
  if (typeof document === "undefined") return;
  const user = getCurrentUser();
  if (!user) {
    showSignedOutView();
    return;
  }

  const modal = document.querySelector("#authModal .modal");
  if (modal) {
    modal.classList.remove("worker-dashboard-open");
    modal.setAttribute("aria-labelledby", "authAccountTitle");
  }

  const signedOutView = document.getElementById("authSignedOutView");
  const accountView = document.getElementById("authAccountView");
  const dashboardView = document.getElementById("workerDashboardView");
  if (signedOutView) signedOutView.hidden = true;
  if (accountView) accountView.hidden = false;
  if (dashboardView) dashboardView.hidden = true;

  const worker = user.role === "worker" && user.workerId ? getWorkerById(user.workerId) : null;
  setTextContent(document.getElementById("authUserName"), worker?.name || user.name);

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

  // Role chip
  let roleLabel = "Worker Account";
  if (user.role === "customer") {
    roleLabel = "Customer Account";
  } else if (user.role === "admin") {
    roleLabel = "Platform Administrator";
  }
  setTextContent(document.getElementById("authUserRole"), roleLabel);

  // Email verification badge and notice (non-blocking recommendation)
  const verifiedBadge = document.getElementById("authEmailVerifiedBadge");
  const verificationNotice = document.getElementById("authEmailVerificationNotice");
  if (verifiedBadge) {
    if (user.email) {
      if (user.emailVerified) {
        setTextContent(verifiedBadge, "✓ Email Verified");
        verifiedBadge.className = "auth-verification-badge verified";
        verifiedBadge.hidden = false;
        if (verificationNotice) verificationNotice.hidden = true;
      } else {
        setTextContent(verifiedBadge, "Email Unverified");
        verifiedBadge.className = "auth-verification-badge unverified";
        verifiedBadge.hidden = false;
        if (verificationNotice) verificationNotice.hidden = false;
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
      const confirmPassword = document.getElementById("authCustomerConfirmPassword")?.value || "";
      await registerCustomer({ name, email, phone, district, password, confirmPassword });
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
    } else if (target.closest("#authCustomerToSignIn, #authWorkerToSignIn")) {
      showSignIn();
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
        showSignedOutView();
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
    } else if (target.closest("#authLogout, #authLogoutFromDashboard")) {
      signOutUser();
    } else if (target.closest("#authResendVerification")) {
      resendVerificationEmail();
    } else if (target.closest("#workerDashboardButton")) {
      if (openWorkerDashboard()) openModal("authModal");
    } else if (target.closest("#openWorkerDashboard")) {
      openWorkerDashboard();
    } else if (target.closest("#backToAccount")) {
      showAccountView();
    } else if (target.closest("#authBackToRoles")) {
      showSignedOutView();
    }
  });

  // Initialize Firebase client in background without blocking UI
  (async () => {
    try {
      const { auth, isConfigured: hasConfig } = await initializeFirebaseClient();
      const methods = await getFirebaseAuthMethods();

      if (hasConfig && auth && methods && typeof methods.onAuthStateChanged === "function") {
        methods.onAuthStateChanged(auth, async (firebaseUser) => {
          if (firebaseUser) {
            let existingProfile = getApplicationProfile(firebaseUser.uid);

            try {
              const { db } = await initializeFirestoreClient();
              const firestoreMethods = await getFirestoreMethods();
              if (db && firestoreMethods && typeof firestoreMethods.getDoc === "function") {
                const userDoc = await firestoreMethods.getDoc(firestoreMethods.doc(db, "users", firebaseUser.uid));
                if (userDoc.exists()) {
                  const uData = userDoc.data();
                  existingProfile = {
                    ...existingProfile,
                    role: uData.role || existingProfile?.role || "customer",
                    name: uData.name || existingProfile?.name || firebaseUser.displayName || "Customer",
                    email: uData.email || firebaseUser.email,
                    phone: uData.phone || null,
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
                    }
                  }
                }
              }
            } catch {}

            const currentUser = {
              id: firebaseUser.uid,
              firebaseUid: firebaseUser.uid,
              role: existingProfile?.role || "customer",
              name: existingProfile?.name || firebaseUser.displayName || "Customer",
              email: firebaseUser.email,
              phone: existingProfile?.phone || null,
              district: existingProfile?.district || null,
              service: existingProfile?.service || null,
              experience: existingProfile?.experience || null,
              availability: existingProfile?.availability || "Available",
              emailVerified: Boolean(firebaseUser.emailVerified),
              workerId: existingProfile?.workerId || null,
              isVerified: Boolean(existingProfile?.isVerified),
              authProvider: "firebase",
              createdAt: existingProfile?.createdAt || new Date().toISOString()
            };
            setCurrentUser(currentUser);
            recordSecurityEvent("AUTH_STATE_CHANGED", currentUser.role);
            updateAccountControls();
          } else {
            const current = getCurrentUser();
            if (current?.authProvider === "firebase") {
              clearCurrentUser();
              recordSecurityEvent("AUTH_STATE_CHANGED", null);
              updateAccountControls();
              showSignedOutView();
            }
          }
        });
      }
    } catch (e) {
      console.warn("[JKFixHub Auth] Background Firebase observer setup notice:", e?.message || e);
    }
  })();
}
