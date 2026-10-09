// ==========================================
// #SECURITY_FOUNDATION
// ==========================================

// These definitions support frontend UX and validation only.
// Real authorization must be enforced by trusted backend services.
export const SUPPORTED_ROLES = Object.freeze(["customer", "worker", "admin"]);

export const CAPABILITIES = Object.freeze({
  customer: Object.freeze([
    "browseWorkers",
    "viewWorkerProfile",
    "createRequest",
    "viewOwnRequests",
    "sendMessageAfterAcceptance",
    "submitReview",
    "reportUser"
  ]),
  worker: Object.freeze([
    "manageOwnProfile",
    "viewOwnRequests",
    "acceptRequest",
    "rejectRequest",
    "sendMessageAfterAcceptance",
    "viewOwnReviews",
    "reportUser"
  ]),
  admin: Object.freeze([
    "accessAdmin",
    "manageWorkers",
    "manageUsers",
    "manageReports",
    "manageReviews",
    "manageCategories",
    "manageDistricts",
    "manageSuspensions",
    "viewSecurityEvents",
    "viewAuditLog",
    "manageSystemSettings"
  ])
});

export const SECURITY_EVENT_TYPES = Object.freeze([
  "LOGIN_ATTEMPT",
  "LOGOUT",
  "ROLE_CHANGE_ATTEMPT",
  "INVALID_REQUEST",
  "VALIDATION_FAILURE",
  "UNAUTHORIZED_UI_ACTION",
  "SUSPICIOUS_INPUT",
  "CHAT_ACCESS_DENIED",
  "CHAT_MESSAGE_REJECTED",
  "CHAT_RATE_LIMITED",
  "CHAT_DEMO_ACCEPTED",
  "REQUEST_COMPLETED",
  "REVIEW_SUBMITTED",
  "REVIEW_REPLY_SUBMITTED",
  "REPORT_SUBMITTED",
  "ABUSE_SIGNAL_TRIGGERED",
  "ABUSE_RESTRICTION_APPLIED",
  "ADMIN_ACCESS_DENIED",
  "ADMIN_ACCESS_GRANTED",
  "UNAUTHORIZED_ADMIN_ACTION",
  "WORKER_STATUS_CHANGED",
  "WORKER_APPROVAL_ACTION",
  "REPORT_MODERATION_ACTION",
  "REVIEW_MODERATION_ACTION",
  "ADMIN_LOGOUT",
  "INVALID_ADMIN_TARGET",
  "AUTH_STATE_CHANGED",
  "FIREBASE_AUTH_ERROR",
  "REGISTER_ATTEMPT",
  "REGISTER_SUCCESS",
  "EMAIL_VERIFICATION_SENT",
  "EMAIL_VERIFICATION_FAILED"
]);

const MAX_SECURITY_EVENTS = 50;
const securityEvents = [];
const namePattern = /^[\p{L}\p{M}][\p{L}\p{M}\p{N} .’'-]*$/u;
const blockedControlsPattern = /[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F]/;

export function isSupportedRole(role) {
  return typeof role === "string" && SUPPORTED_ROLES.includes(role);
}

export function getRoleCapabilities(role) {
  return isSupportedRole(role) ? [...CAPABILITIES[role]] : [];
}

export function hasCapability(role, capability) {
  return isSupportedRole(role) && CAPABILITIES[role].includes(capability);
}

export function setTextContent(node, value) {
  if (!(node instanceof Node)) {
    throw new TypeError("Safe text output requires a DOM node.");
  }
  node.textContent = value === null || value === undefined ? "" : String(value);
}

export function validateText(value, { minLength = 0, maxLength = Infinity, allowNewlines = false } = {}) {
  if (typeof value !== "string") return false;
  const normalized = value.trim();
  if (value.length > maxLength || normalized.length < minLength) return false;
  if (blockedControlsPattern.test(value)) return false;
  return allowNewlines || !/[\r\n]/.test(value);
}

export function validatePersonName(value) {
  return validateText(value, { minLength: 2, maxLength: 80 }) && namePattern.test(value.trim());
}

export function validateDescription(value) {
  return validateText(value, { minLength: 5, maxLength: 1200, allowNewlines: true });
}

export function validateReview(value) {
  return validateText(value, { minLength: 5, maxLength: 1200, allowNewlines: true });
}

export function validateReport(value) {
  return validateText(value, { minLength: 10, maxLength: 2000, allowNewlines: true });
}

export function validateLocation(value) {
  return validateText(value, { minLength: 2, maxLength: 160 });
}

export function validateEmail(value) {
  return typeof value === "string" &&
    value.length <= 254 &&
    /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value.trim());
}

export function validatePhone(value) {
  return typeof value === "string" &&
    /^[+()\d .-]{7,24}$/.test(value.trim()) &&
    (value.match(/\d/g) || []).length >= 7;
}

export function validateHttpsUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function recordSecurityEvent(type, role = null) {
  if (!SECURITY_EVENT_TYPES.includes(type)) {
    throw new RangeError("Unsupported security event type.");
  }

  securityEvents.push({
    type,
    timestamp: new Date().toISOString(),
    role: isSupportedRole(role) ? role : null
  });
  if (securityEvents.length > MAX_SECURITY_EVENTS) securityEvents.shift();
}

export function getSecurityEvents() {
  return securityEvents.map((event) => ({ ...event }));
}

export function clearSecurityEvents() {
  securityEvents.length = 0;
}

export function validatePassword(password, confirmPassword = null) {
  if (typeof password !== "string") {
    return { isValid: false, errorKey: "invalidPassword" };
  }
  if (password.length < 6) {
    return { isValid: false, errorKey: "passwordTooShort" };
  }
  if (confirmPassword !== null && password !== confirmPassword) {
    return { isValid: false, errorKey: "passwordsDoNotMatch" };
  }
  return { isValid: true, errorKey: null };
}

export function mapFirebaseAuthError(error) {
  const code = error?.code || "";
  switch (code) {
    case "auth/invalid-credential":
    case "auth/user-not-found":
    case "auth/wrong-password":
      return "Email or password is incorrect.";
    case "auth/email-already-in-use":
      return "An account with this email already exists.";
    case "auth/weak-password":
      return "Please choose a stronger password (at least 6 characters).";
    case "auth/invalid-email":
      return "Please enter a valid email address.";
    case "auth/too-many-requests":
      return "Too many attempts. Please try again later.";
    case "auth/network-request-failed":
      return "Network connection error. Please try again.";
    case "auth/user-disabled":
      return "This account has been disabled.";
    case "auth/requires-recent-login":
      return "Please sign in again to continue.";
    case "auth/operation-not-allowed":
      return "Email/password sign-in is not enabled for this project.";
    default:
      if (typeof error?.message === "string" && error.message.startsWith("SAFE:")) {
        return error.message.replace("SAFE:", "").trim();
      }
      return "Authentication could not be completed. Please try again.";
  }
}

export function getSafeErrorMessage(code) {
  const messages = {
    invalidName: "Enter a name using letters and common punctuation.",
    invalidDescription: "Enter a description between 5 and 1,200 characters.",
    invalidLocation: "Enter an area between 2 and 160 characters.",
    invalidService: "Choose a valid service for this worker.",
    invalidRequest: "We could not prepare this request. Please try again.",
    invalidReview: "Enter a review between 5 and 1,200 characters.",
    invalidRating: "Select a star rating from 1 to 5.",
    duplicateReview: "A review has already been submitted for this request.",
    invalidReport: "Enter a report description between 10 and 2,000 characters.",
    invalidReportReason: "Choose a valid reason for this report.",
    duplicateReport: "You have already submitted a report for this target.",
    invalidReply: "Enter a reply between 2 and 600 characters.",
    actionRestricted: "Action temporarily paused. Please slow down and try again shortly.",
    accessUnavailable: "Access unavailable.",
    unauthorizedAdmin: "Access unavailable.",
    invalidAdminTarget: "Invalid target.",
    invalidEmail: "Please enter a valid email address.",
    invalidPassword: "Password must be at least 6 characters long.",
    passwordTooShort: "Password must be at least 6 characters long.",
    passwordsDoNotMatch: "Passwords do not match.",
    invalidDistrict: "Please choose a valid district.",
    invalidPhone: "Please enter a valid phone number (at least 7 digits).",
    invalidExperience: "Please enter your experience (e.g. 5 years).",
    firebaseNotConfigured: "Firebase Authentication is in preview/demo mode."
  };
  return messages[code] || "Something went wrong. Please try again.";
}
