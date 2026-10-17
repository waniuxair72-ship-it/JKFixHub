// ==========================================
// #SECURITY_FOUNDATION
// ==========================================

// These definitions support frontend UX and validation only.
// Real authorization must be enforced by trusted backend services.
export const SUPPORTED_ROLES = Object.freeze(["customer", "worker", "admin"]);

export const SUPPORTED_SERVICES = Object.freeze([
  "Electrician",
  "Plumbing",
  "Carpentry",
  "Appliance repair",
  "Washing Machine Repair",
  "Refrigerator Repair",
  "Heater Repair",
  "TV / Electronics Repair"
]);

export const SERVICE_SYNONYMS = Object.freeze({
  plumber: "Plumbing",
  plumbing: "Plumbing",
  carpenter: "Carpentry",
  carpentry: "Carpentry",
  electrician: "Electrician",
  electrical: "Electrician",
  "electrical repair": "Electrician",
  appliance: "Appliance repair",
  "appliance repair": "Appliance repair",
  "washing machine": "Washing Machine Repair",
  "washing machine repair": "Washing Machine Repair",
  refrigerator: "Refrigerator Repair",
  "refrigerator repair": "Refrigerator Repair",
  fridge: "Refrigerator Repair",
  "fridge repair": "Refrigerator Repair",
  heater: "Heater Repair",
  "heater repair": "Heater Repair",
  "tv repair": "TV / Electronics Repair",
  "electronics repair": "TV / Electronics Repair",
  electronics: "TV / Electronics Repair",
  "tv / electronics repair": "TV / Electronics Repair",
  "tv & electronics repair": "TV / Electronics Repair",
  "tv & electronics": "TV / Electronics Repair"
});

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
  "EMAIL_VERIFICATION_FAILED",
  "PROFILE_UPDATED",
  "EMAIL_UPDATE_ERROR"
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

export function normalizeService(service) {
  if (typeof service !== "string") return "";
  const key = service.trim().toLowerCase();
  return SERVICE_SYNONYMS[key] || service.trim();
}

export function areServicesEquivalent(serviceA, serviceB) {
  if (!serviceA || !serviceB) return false;
  const normA = normalizeService(serviceA).toLowerCase();
  const normB = normalizeService(serviceB).toLowerCase();
  if (normA === normB) return true;
  return normA.includes(normB) || normB.includes(normA);
}

export function workerMatchesService(worker, targetService) {
  if (!targetService) return true;
  if (!worker) return false;

  const targetNorm = normalizeService(targetService).toLowerCase();

  // Check worker.service
  if (worker.service) {
    const workerNorm = normalizeService(worker.service).toLowerCase();
    if (workerNorm === targetNorm || workerNorm.includes(targetNorm) || targetNorm.includes(workerNorm)) {
      return true;
    }
  }

  // Check worker.services (string or array)
  if (worker.services) {
    const servicesList = Array.isArray(worker.services)
      ? worker.services
      : String(worker.services).split(/[,;]|\band\b/).map((s) => s.trim()).filter(Boolean);

    for (const item of servicesList) {
      const itemNorm = normalizeService(item).toLowerCase();
      if (itemNorm === targetNorm || itemNorm.includes(targetNorm) || targetNorm.includes(itemNorm)) {
        return true;
      }
    }
  }

  return false;
}

export function validateService(service) {
  if (typeof service !== "string") return false;
  const norm = normalizeService(service).toLowerCase();
  return SUPPORTED_SERVICES.some((s) => s.toLowerCase() === norm);
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

export const ALL_DISTRICTS = Object.freeze([
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

export function validateDistrict(district) {
  return typeof district === "string" && ALL_DISTRICTS.includes(district.trim());
}

export function normalizePhoneNumber(value) {
  if (typeof value !== "string") return null;
  let cleaned = value.trim().replace(/[\s\-()]/g, "");
  if (cleaned.startsWith("+91")) {
    cleaned = cleaned.slice(3);
  } else if (cleaned.startsWith("0") && cleaned.length === 11) {
    cleaned = cleaned.slice(1);
  }
  if (/^[6-9]\d{9}$/.test(cleaned)) {
    return cleaned;
  }
  return null;
}

export function validatePassword(password, confirmPassword = null, { minLength = 6, maxLength = 20 } = {}) {
  if (typeof password !== "string") {
    return { isValid: false, errorKey: "invalidPassword" };
  }
  if (password.length < minLength) {
    return { isValid: false, errorKey: "passwordTooShort" };
  }
  if (password.length > maxLength) {
    return { isValid: false, errorKey: "passwordTooLong" };
  }
  if (confirmPassword !== null && confirmPassword !== undefined && password !== confirmPassword) {
    return { isValid: false, errorKey: "passwordsDoNotMatch" };
  }
  return { isValid: true, errorKey: null };
}

export function mapFirebaseAuthError(error) {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return "Network connection error. Please check your internet connection and try again.";
  }
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
    case "unavailable":
      return "Network connection error. Please check your internet connection and try again.";
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
      if (typeof error?.message === "string" && /network|offline|failed to fetch/i.test(error.message)) {
        return "Network connection error. Please check your internet connection and try again.";
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
    invalidIdentifier: "Please enter a valid email or 10-digit mobile number.",
    invalidPassword: "Password must be between 6 and 20 characters.",
    passwordTooShort: "Password must be at least 6 characters long.",
    passwordTooLong: "Password cannot exceed 20 characters.",
    passwordsDoNotMatch: "Passwords do not match.",
    invalidDistrict: "Please choose a valid district.",
    invalidPhone: "Please enter a valid phone number (at least 7 digits).",
    invalidExperience: "Please enter your experience (e.g. 5 years).",
    firebaseNotConfigured: "Firebase Authentication is in preview/demo mode.",
    networkError: "Network connection error. Please check your internet connection and try again.",
    offline: "You are currently offline. Please reconnect to the internet and try again."
  };
  return messages[code] || "Something went wrong. Please try again.";
}

/**
 * Sets a button into an accessible loading state with an inline spinner and custom text.
 * Returns a callable restore function (also with .updateText(text) and .restore()) to revert state.
 *
 * @param {HTMLElement|null} button The button element to toggle.
 * @param {string} loadingText The loading announcement / visual text.
 * @returns {Function} Callable restore function with .updateText() method.
 */
export function setButtonLoading(button, loadingText = "Loading...") {
  const noop = () => {};
  noop.updateText = () => {};
  noop.restore = () => {};

  if (!button || typeof button !== "object") {
    return noop;
  }

  const originalDisabled = Boolean(button.disabled);
  const originalHtml = typeof button.innerHTML === "string" ? button.innerHTML : "";
  const originalTextContent = typeof button.textContent === "string" ? button.textContent : "";
  const originalAriaBusy = typeof button.getAttribute === "function" ? button.getAttribute("aria-busy") : null;
  const originalAriaLabel = typeof button.getAttribute === "function" ? button.getAttribute("aria-label") : null;

  try {
    button.disabled = true;
    if (typeof button.setAttribute === "function") {
      button.setAttribute("aria-busy", "true");
    }
    if (button.classList && typeof button.classList.add === "function") {
      button.classList.add("is-loading");
    }

    const safeText = String(loadingText).replace(/[&<>"']/g, (m) => {
      switch (m) {
        case "&": return "&amp;";
        case "<": return "&lt;";
        case ">": return "&gt;";
        case '"': return "&quot;";
        case "'": return "&#039;";
        default: return m;
      }
    });

    button.innerHTML = `<span class="btn-spinner" aria-hidden="true"></span><span class="btn-loading-text">${safeText}</span>`;
    // For mock environments without HTML parser where innerHTML does not create children or update textContent
    if (!button.children || button.children.length === 0) {
      button.textContent = loadingText;
    }
  } catch (_) {}

  let isRestored = false;
  function restore() {
    if (isRestored) return;
    isRestored = true;

    try {
      button.disabled = originalDisabled;
      if (typeof button.setAttribute === "function") {
        if (originalAriaBusy !== null) {
          button.setAttribute("aria-busy", originalAriaBusy);
        } else if (typeof button.removeAttribute === "function") {
          button.removeAttribute("aria-busy");
        }

        if (originalAriaLabel !== null) {
          button.setAttribute("aria-label", originalAriaLabel);
        } else if (typeof button.removeAttribute === "function") {
          button.removeAttribute("aria-label");
        }
      }

      if (button.classList && typeof button.classList.remove === "function") {
        button.classList.remove("is-loading");
      }

      button.innerHTML = originalHtml;
      if (!button.children || button.children.length === 0) {
        button.textContent = originalTextContent;
      }
    } catch (_) {}
  }

  restore.updateText = function (newText) {
    if (isRestored) return;
    try {
      const textSpan = typeof button.querySelector === "function" ? button.querySelector(".btn-loading-text") : null;
      if (textSpan) {
        textSpan.textContent = String(newText);
      } else {
        const safeText = String(newText).replace(/[&<>"']/g, (m) => {
          switch (m) {
            case "&": return "&amp;";
            case "<": return "&lt;";
            case ">": return "&gt;";
            case '"': return "&quot;";
            case "'": return "&#039;";
            default: return m;
          }
        });
        button.innerHTML = `<span class="btn-spinner" aria-hidden="true"></span><span class="btn-loading-text">${safeText}</span>`;
        if (!button.children || button.children.length === 0) {
          button.textContent = String(newText);
        }
      }
    } catch (_) {}
  };

  restore.restore = restore;
  return restore;
}

