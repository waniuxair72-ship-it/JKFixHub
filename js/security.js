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
    "manageWorkers",
    "manageUsers",
    "manageReports",
    "manageReviews",
    "manageCategories",
    "manageDistricts",
    "manageSuspensions",
    "viewSecurityEvents",
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
  "CHAT_DEMO_ACCEPTED"
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

export function getSafeErrorMessage(code) {
  const messages = {
    invalidName: "Enter a name using letters and common punctuation.",
    invalidDescription: "Enter a description between 5 and 1,200 characters.",
    invalidLocation: "Enter an area between 2 and 160 characters.",
    invalidService: "Choose a valid service for this worker.",
    invalidRequest: "We could not prepare this request. Please try again."
  };
  return messages[code] || "Something went wrong. Please try again.";
}
