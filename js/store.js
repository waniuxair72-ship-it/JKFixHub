import { workers } from "./worker-data.js";
import {
  hasCapability,
  recordSecurityEvent,
  validateDescription,
  validateEmail,
  validateHttpsUrl,
  validateLocation,
  validatePersonName,
  validatePhone,
  validateText,
  validateReview,
  validateReport
} from "./security.js";
import {
  checkAndTrackAction,
  resetAbuseSignals
} from "./abuse.js";

// ==========================================
// #APPLICATION_STATE
// ==========================================
const state = {
  selectedWorkerId: null,
  currentRequest: null,
  currentUser: null,
  workerDemoProfiles: {},
  customerRequests: [],
  conversations: [],
  messages: [],
  activeConversationId: null,
  messageAttempts: {},
  reviews: [],
  reports: []
};

let initialized = false;
let customerRequestSequence = 0;

const customerRequestStatuses = Object.freeze([
  "Pending",
  "Accepted",
  "Rejected",
  "Completed",
  "Cancelled"
]);
const customerRequestInputFields = Object.freeze([
  "customerId",
  "workerId",
  "workerName",
  "service",
  "district",
  "customerName",
  "description",
  "location",
  "preferredTime",
  "submittedAt",
  "status"
]);
const customerIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
const customerRequestIdPattern = /^req-[a-z0-9-]{8,80}$/;
const reviewIdPattern = /^rev-[a-z0-9-]{8,80}$/;
const reportIdPattern = /^rep-[a-z0-9-]{8,80}$/;
const markupPattern = /<\s*\/?\s*[a-z!][^>]*>/i;
const allowedReportTargetTypes = Object.freeze(["worker", "customer", "review", "message"]);
const allowedReportReasons = Object.freeze(["spam", "harassment", "scam", "inappropriate", "fake", "abusive", "other"]);

function requireCustomerId() {
  const user = state.currentUser;
  if (!user || user.role !== "customer" || !hasCapability(user.role, "viewOwnRequests")) {
    recordSecurityEvent("UNAUTHORIZED_UI_ACTION", user?.role || null);
    throw new Error("Customer request access requires a customer demo account.");
  }
  if (!customerIdPattern.test(user.id)) {
    recordSecurityEvent("INVALID_REQUEST", user.role);
    throw new TypeError("The customer identity is invalid.");
  }
  return user.id;
}

function copyCustomerRequest(request) {
  return { ...request };
}

function copyConversation(conversation) {
  return { ...conversation };
}

function copyMessage(message) {
  return { ...message };
}

function copyReview(review) {
  return { ...review };
}

function copyReport(report) {
  return { ...report };
}

function isValidStoredCustomerRequest(request) {
  return isValidCustomerRequestId(request.id) &&
    typeof request.customerId === "string" &&
    customerIdPattern.test(request.customerId) &&
    Number.isSafeInteger(request.workerId) &&
    getWorkerById(request.workerId) !== null &&
    validatePersonName(request.workerName) &&
    validatePersonName(request.customerName) &&
    validateText(request.service, { minLength: 1, maxLength: 80 }) &&
    validateText(request.district, { minLength: 2, maxLength: 80 }) &&
    validateDescription(request.description) &&
    !markupPattern.test(request.description) &&
    validateLocation(request.customerLocation) &&
    !markupPattern.test(request.customerLocation) &&
    customerRequestStatuses.includes(request.status) &&
    typeof request.demoAccepted === "boolean" &&
    (request.status !== "Accepted" || request.demoAccepted) &&
    typeof request.createdAt === "string" &&
    !Number.isNaN(Date.parse(request.createdAt));
}

function isValidCustomerRequestId(id) {
  return typeof id === "string" && customerRequestIdPattern.test(id);
}

function createCustomerRequestId() {
  let id;
  do {
    customerRequestSequence += 1;
    id = `req-${Date.now().toString(36)}-${customerRequestSequence.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  } while (state.customerRequests.some((request) => request.id === id));
  return id;
}

function copyWorker(worker) {
  return worker ? { ...worker } : null;
}

export function initializeStore() {
  if (initialized) return;
  initialized = true;
  clearRequestState();
}

export function getWorkers() {
  return workers.map((worker) => getWorkerById(worker.id));
}

export function getState() {
  return {
    selectedWorkerId: state.selectedWorkerId,
    currentRequest: state.currentRequest ? { ...state.currentRequest } : null,
    currentUser: state.currentUser ? { ...state.currentUser } : null
  };
}

export function getCurrentUser() {
  return state.currentUser ? { ...state.currentUser } : null;
}

export function setCurrentUser(user) {
  if (user === null) {
    clearCurrentUser();
    return;
  }
  if (!user || typeof user !== "object") {
    throw new TypeError("A current user must be an object or null.");
  }
  if (user.role !== "customer" && user.role !== "worker") {
    throw new RangeError("The current user role must be customer or worker.");
  }
  if (typeof user.id !== "string" || !user.id || typeof user.name !== "string" || !user.name) {
    throw new TypeError("A current user must have a non-empty ID and name.");
  }
  if (!customerIdPattern.test(user.id) || !validatePersonName(user.name)) {
    recordSecurityEvent("INVALID_REQUEST", user.role);
    throw new TypeError("The current user ID or name is invalid.");
  }
  if (user.role === "worker" && !Number.isSafeInteger(user.workerId)) {
    throw new TypeError("A worker account must reference a valid worker ID.");
  }
  if (user.role === "worker" && !getWorkerById(user.workerId)) {
    throw new RangeError("The worker account must reference an existing worker.");
  }
  if (user.email !== null && user.email !== undefined && !validateEmail(user.email)) {
    throw new TypeError("The current user email is invalid.");
  }
  if (user.phone !== null && user.phone !== undefined && !validatePhone(user.phone)) {
    throw new TypeError("The current user phone is invalid.");
  }
  if (user.photo !== null && user.photo !== undefined && !validateHttpsUrl(user.photo)) {
    throw new TypeError("The current user photo URL must use HTTPS.");
  }
  if (
    user.district !== null &&
    user.district !== undefined &&
    !validateText(user.district, { minLength: 1, maxLength: 80 })
  ) {
    throw new TypeError("The current user district is invalid.");
  }
  if (
    user.createdAt !== null &&
    user.createdAt !== undefined &&
    (typeof user.createdAt !== "string" || Number.isNaN(Date.parse(user.createdAt)))
  ) {
    throw new TypeError("The current user creation date is invalid.");
  }

  state.currentUser = {
    id: user.id,
    role: user.role,
    name: user.name,
    email: typeof user.email === "string" ? user.email : null,
    phone: typeof user.phone === "string" ? user.phone : null,
    photo: typeof user.photo === "string" ? user.photo : null,
    district: typeof user.district === "string" ? user.district : null,
    createdAt: typeof user.createdAt === "string" ? user.createdAt : null,
    ...(user.role === "worker" && Number.isInteger(user.workerId) ? { workerId: user.workerId } : {})
  };
}

export function clearCurrentUser() {
  state.currentUser = null;
  state.activeConversationId = null;
  state.reviews = [];
  state.reports = [];
  resetAbuseSignals();
}

export function isAuthenticated() {
  return state.currentUser !== null;
}

export function getUserRole() {
  return state.currentUser?.role || null;
}

export function isCustomer() {
  return getUserRole() === "customer";
}

export function isWorker() {
  return getUserRole() === "worker";
}

export function getWorkerById(id) {
  const normalizedId = typeof id === "number"
    ? id
    : typeof id === "string" && /^\d+$/.test(id)
      ? Number(id)
      : Number.NaN;
  if (!Number.isSafeInteger(normalizedId)) return null;
  const worker = workers.find((item) => item.id === normalizedId);
  if (!worker) return null;
  return { ...copyWorker(worker), ...state.workerDemoProfiles[normalizedId] };
}

export function setWorkerDemoProfile(id, profile) {
  const worker = getWorkerById(id);
  if (!worker) {
    throw new RangeError(`No worker exists with ID ${id}.`);
  }
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new TypeError("A demo worker profile update must be an object.");
  }

  const allowedFields = ["name", "service", "district", "experience", "availability"];
  if (Object.keys(profile).some((key) => !allowedFields.includes(key))) {
    throw new TypeError("The demo worker profile contains a protected or unsupported field.");
  }

  if ("name" in profile && !validatePersonName(profile.name)) {
    throw new TypeError("The demo worker name is invalid.");
  }
  if ("service" in profile && !workers.some((item) => item.service === profile.service)) {
    throw new RangeError("The demo worker service is not supported.");
  }
  if (
    "district" in profile &&
    (!validateText(profile.district, { minLength: 2, maxLength: 80 }) ||
      !workers.some((item) => item.district === profile.district))
  ) {
    throw new RangeError("The demo worker district is not supported.");
  }
  if (
    "experience" in profile &&
    (!validateText(profile.experience, { minLength: 1, maxLength: 40 }) ||
      !/^\d{1,2} years?$/.test(profile.experience.trim()))
  ) {
    throw new TypeError("The demo worker experience is invalid.");
  }
  if (
    "availability" in profile &&
    !["Available", "Busy", "Offline"].includes(profile.availability)
  ) {
    throw new RangeError("The demo worker availability is not supported.");
  }

  const updatedProfile = { ...state.workerDemoProfiles[worker.id] };
  if ("name" in profile) {
    updatedProfile.name = profile.name.trim();
    updatedProfile.initials = profile.name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  }
  if ("service" in profile) updatedProfile.service = profile.service;
  if ("district" in profile) updatedProfile.district = profile.district.trim();
  if ("experience" in profile) updatedProfile.experience = profile.experience.trim();
  if ("availability" in profile) updatedProfile.availability = profile.availability;
  state.workerDemoProfiles[worker.id] = updatedProfile;
  return getWorkerById(worker.id);
}

export function setSelectedWorker(id) {
  if (id === null) {
    state.selectedWorkerId = null;
    state.currentRequest = null;
    return;
  }

  const worker = getWorkerById(id);
  if (!worker) {
    throw new RangeError(`No worker exists with ID ${id}.`);
  }

  state.selectedWorkerId = worker.id;
  state.currentRequest = null;
}

export function getSelectedWorker() {
  return getWorkerById(state.selectedWorkerId);
}

export function setCurrentRequest(request) {
  if (request === null) {
    state.currentRequest = null;
    return;
  }

  if (!request || typeof request !== "object") {
    throw new TypeError("A service request must be an object or null.");
  }

  const worker = getWorkerById(request.workerId);
  if (!worker || request.workerId !== state.selectedWorkerId) {
    throw new Error("The request worker must match the selected worker.");
  }
  if (
    request.workerName !== worker.name ||
    request.service !== worker.service ||
    request.district !== worker.district ||
    !validatePersonName(request.customerName) ||
    !validateDescription(request.description) ||
    markupPattern.test(request.description) ||
    !validateLocation(request.location) ||
    markupPattern.test(request.location) ||
    !["As soon as possible", "Today", "Tomorrow", "Flexible"].includes(request.preferredTime) ||
    typeof request.submittedAt !== "string" ||
    Number.isNaN(Date.parse(request.submittedAt)) ||
    (request.customerId !== null &&
      (typeof request.customerId !== "string" ||
        !customerIdPattern.test(request.customerId) ||
        state.currentUser?.role !== "customer" ||
        request.customerId !== state.currentUser.id))
  ) {
    throw new TypeError("The service request data is invalid.");
  }

  state.currentRequest = {
    customerId: request.customerId,
    workerId: worker.id,
    workerName: worker.name,
    service: worker.service,
    district: worker.district,
    customerName: request.customerName.trim(),
    description: request.description.trim(),
    location: request.location.trim(),
    preferredTime: request.preferredTime,
    submittedAt: request.submittedAt
  };
}

export function getCurrentRequest() {
  return state.currentRequest ? { ...state.currentRequest } : null;
}

export function createCustomerRequest(request) {
  const customerId = requireCustomerId();
  const abuseCheck = checkAndTrackAction(customerId, "request");
  if (abuseCheck.restricted) {
    recordSecurityEvent("ABUSE_RESTRICTION_APPLIED", "customer");
    throw new Error(abuseCheck.reason);
  }
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    recordSecurityEvent("INVALID_REQUEST", "customer");
    throw new TypeError("A customer request must be an object.");
  }
  if (Object.keys(request).some((key) => !customerRequestInputFields.includes(key))) {
    recordSecurityEvent("VALIDATION_FAILURE", "customer");
    throw new TypeError("The customer request data is invalid.");
  }

  const worker = Number.isSafeInteger(request.workerId) ? getWorkerById(request.workerId) : null;
  const validRequest = worker &&
    request.customerId === customerId &&
    request.workerName === worker.name &&
    request.service === worker.service &&
    request.district === worker.district &&
    (!("status" in request) || request.status === "Pending") &&
    validatePersonName(request.customerName) &&
    validateDescription(request.description) &&
    !markupPattern.test(request.description) &&
    validateLocation(request.location) &&
    !markupPattern.test(request.location) &&
    ["As soon as possible", "Today", "Tomorrow", "Flexible"].includes(request.preferredTime) &&
    typeof request.submittedAt === "string" &&
    !Number.isNaN(Date.parse(request.submittedAt));

  if (!validRequest) {
    recordSecurityEvent("VALIDATION_FAILURE", "customer");
    throw new TypeError("The customer request data is invalid.");
  }

  const customerRequest = {
    id: createCustomerRequestId(),
    customerId,
    workerId: worker.id,
    workerName: worker.name,
    service: worker.service,
    district: worker.district,
    customerName: request.customerName.trim(),
    description: request.description.trim(),
    customerLocation: request.location.trim(),
    status: "Pending",
    createdAt: request.submittedAt,
    demoAccepted: false
  };
  state.customerRequests.push(customerRequest);
  return copyCustomerRequest(customerRequest);
}

export function getCustomerRequests() {
  const customerId = requireCustomerId();
  return state.customerRequests.reduce((ownedRequests, request) => {
    if (request.customerId !== customerId) return ownedRequests;
    if (!isValidStoredCustomerRequest(request)) {
      recordSecurityEvent("INVALID_REQUEST", "customer");
      return ownedRequests;
    }
    ownedRequests.push(copyCustomerRequest(request));
    return ownedRequests;
  }, []);
}

export function getCustomerRequestById(id) {
  const customerId = requireCustomerId();
  if (!isValidCustomerRequestId(id)) {
    recordSecurityEvent("INVALID_REQUEST", "customer");
    return null;
  }

  const request = state.customerRequests.find((item) => item.id === id);
  if (!request) {
    recordSecurityEvent("INVALID_REQUEST", "customer");
    return null;
  }
  if (request.customerId !== customerId) {
    recordSecurityEvent("UNAUTHORIZED_UI_ACTION", "customer");
    return null;
  }
  if (!isValidStoredCustomerRequest(request)) {
    recordSecurityEvent("INVALID_REQUEST", "customer");
    return null;
  }
  return copyCustomerRequest(request);
}

export function cancelCustomerRequest(id) {
  const customerId = requireCustomerId();
  const abuseCheck = checkAndTrackAction(customerId, "cancel_request");
  if (abuseCheck.restricted) {
    recordSecurityEvent("ABUSE_RESTRICTION_APPLIED", "customer");
    return false;
  }
  if (!isValidCustomerRequestId(id)) {
    recordSecurityEvent("INVALID_REQUEST", "customer");
    return false;
  }

  const request = state.customerRequests.find((item) => item.id === id);
  if (!request) {
    recordSecurityEvent("INVALID_REQUEST", "customer");
    return false;
  }
  if (request.customerId !== customerId) {
    recordSecurityEvent("UNAUTHORIZED_UI_ACTION", "customer");
    return false;
  }
  if (!customerRequestStatuses.includes(request.status) || request.status !== "Pending") {
    recordSecurityEvent("INVALID_REQUEST", "customer");
    return false;
  }

  request.status = "Cancelled";
  return true;
}

export function getWorkerCustomerRequests() {
  const user = state.currentUser;
  if (!user || user.role !== "worker" || !hasCapability(user.role, "viewOwnRequests")) {
    recordSecurityEvent("UNAUTHORIZED_UI_ACTION", user?.role || null);
    return [];
  }
  const worker = getWorkerById(user.workerId);
  if (!worker || user.id !== `demo-worker-${worker.id}`) {
    recordSecurityEvent("UNAUTHORIZED_UI_ACTION", user.role);
    return [];
  }
  return state.customerRequests
    .filter((request) => request.workerId === worker.id && isValidStoredCustomerRequest(request))
    .map(copyCustomerRequest);
}

export function acceptCustomerRequestForDemo(id) {
  const user = state.currentUser;
  if (!user || user.role !== "worker" || !hasCapability(user.role, "acceptRequest")) {
    recordSecurityEvent("UNAUTHORIZED_UI_ACTION", user?.role || null);
    return false;
  }
  if (!isValidCustomerRequestId(id)) {
    recordSecurityEvent("INVALID_REQUEST", user.role);
    return false;
  }
  const worker = getWorkerById(user.workerId);
  const request = state.customerRequests.find((item) => item.id === id);
  if (!worker || user.id !== `demo-worker-${worker.id}` ||
      !request || request.workerId !== worker.id ||
      !isValidStoredCustomerRequest(request)) {
    recordSecurityEvent("UNAUTHORIZED_UI_ACTION", user.role);
    return false;
  }
  if (request.status !== "Pending") {
    recordSecurityEvent("INVALID_REQUEST", user.role);
    return false;
  }
  request.status = "Accepted";
  request.demoAccepted = true;
  recordSecurityEvent("CHAT_DEMO_ACCEPTED", user.role);
  return true;
}

export function completeCustomerRequestForDemo(id) {
  const user = state.currentUser;
  if (!user || user.role !== "worker" || !hasCapability(user.role, "acceptRequest")) {
    recordSecurityEvent("UNAUTHORIZED_UI_ACTION", user?.role || null);
    return false;
  }
  if (!isValidCustomerRequestId(id)) {
    recordSecurityEvent("INVALID_REQUEST", user.role);
    return false;
  }
  const worker = getWorkerById(user.workerId);
  const request = state.customerRequests.find((item) => item.id === id);
  if (!worker || user.id !== `demo-worker-${worker.id}` ||
      !request || request.workerId !== worker.id ||
      !isValidStoredCustomerRequest(request)) {
    recordSecurityEvent("UNAUTHORIZED_UI_ACTION", user.role);
    return false;
  }
  if (request.status !== "Accepted") {
    recordSecurityEvent("INVALID_REQUEST", user.role);
    return false;
  }
  request.status = "Completed";

  // When completed, conversation is closed and active chat is cleared
  const conversation = state.conversations.find((item) => item.requestId === request.id);
  if (conversation) {
    conversation.status = "closed";
    if (state.activeConversationId === conversation.id) {
      state.activeConversationId = null;
    }
  }

  recordSecurityEvent("REQUEST_COMPLETED", user.role);
  return true;
}

function getRequestForConversation(id, user) {
  if (!isValidCustomerRequestId(id)) {
    recordSecurityEvent("INVALID_REQUEST", user?.role || null);
    return null;
  }
  const request = state.customerRequests.find((item) => item.id === id);
  if (!request || !isValidStoredCustomerRequest(request)) {
    recordSecurityEvent("INVALID_REQUEST", user?.role || null);
    return null;
  }
  if (user?.role === "customer" && request.customerId === user.id) return request;
  if (user?.role === "worker" &&
      request.workerId === user.workerId &&
      user.id === `demo-worker-${request.workerId}`) return request;
  recordSecurityEvent("CHAT_ACCESS_DENIED", user?.role || null);
  return null;
}

function canAccessConversation(conversationId, user = state.currentUser) {
  if (!user || !state.currentUser ||
      user.id !== state.currentUser.id ||
      user.role !== state.currentUser.role ||
      (user.role !== "customer" && user.role !== "worker") ||
      !hasCapability(user.role, "sendMessageAfterAcceptance")) {
    recordSecurityEvent("CHAT_ACCESS_DENIED", state.currentUser?.role || null);
    return null;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(user.id)) {
    recordSecurityEvent("CHAT_ACCESS_DENIED", user.role);
    return null;
  }
  if (typeof conversationId !== "string" || !/^conv-[a-z0-9-]{8,100}$/.test(conversationId)) {
    recordSecurityEvent("CHAT_ACCESS_DENIED", user.role);
    return null;
  }
  const conversation = state.conversations.find((item) => item.id === conversationId);
  if (!conversation) {
    recordSecurityEvent("CHAT_ACCESS_DENIED", user.role);
    return null;
  }
  const belongs = user.role === "customer"
    ? conversation.customerId === user.id
    : conversation.workerId === user.id;
  if (!belongs) {
    recordSecurityEvent("CHAT_ACCESS_DENIED", user.role);
    return null;
  }
  const request = state.customerRequests.find((item) => item.id === conversation.requestId);
  if (!request || request.customerId !== conversation.customerId ||
      `demo-worker-${request.workerId}` !== conversation.workerId ||
      !isValidStoredCustomerRequest(request)) {
    recordSecurityEvent("CHAT_ACCESS_DENIED", user.role);
    return null;
  }
  if (request.status === "Completed" || request.status === "Cancelled" || request.status === "Rejected") {
    conversation.status = "closed";
    state.activeConversationId = null;
    return null;
  }
  if (request.status !== "Accepted" || !request.demoAccepted || conversation.status === "closed") {
    conversation.status = "locked";
    recordSecurityEvent("CHAT_ACCESS_DENIED", user.role);
    return null;
  }
  conversation.status = "active";
  return { conversation, request };
}

export function openConversationForRequest(requestId) {
  const user = state.currentUser;
  if (!user || (user.role !== "customer" && user.role !== "worker") ||
      !hasCapability(user.role, "sendMessageAfterAcceptance")) {
    recordSecurityEvent("CHAT_ACCESS_DENIED", user?.role || null);
    return null;
  }
  const request = getRequestForConversation(requestId, user);
  if (!request) return null;
  if (request.status !== "Accepted" || !request.demoAccepted) {
    recordSecurityEvent("CHAT_ACCESS_DENIED", user.role);
    return null;
  }

  const worker = getWorkerById(request.workerId);
  const workerId = `demo-worker-${request.workerId}`;
  let conversation = state.conversations.find((item) => item.requestId === request.id);
  if (!conversation) {
    conversation = {
      id: `conv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      requestId: request.id,
      customerId: request.customerId,
      workerId,
      workerName: worker.name,
      customerName: request.customerName,
      service: request.service,
      district: request.district,
      status: "active",
      createdAt: new Date().toISOString(),
      lastMessageAt: null
    };
    state.conversations.push(conversation);
  }
  const access = canAccessConversation(conversation.id, user);
  if (!access) return null;

  state.activeConversationId = conversation.id;
  return copyConversation(access.conversation);
}

export function getConversationById(id, user = state.currentUser) {
  const access = canAccessConversation(id, user);
  return access ? copyConversation(access.conversation) : null;
}

export function getActiveConversation() {
  if (!state.activeConversationId) return null;
  const conversation = getConversationById(state.activeConversationId);
  return conversation ? copyConversation(conversation) : null;
}

export function getConversationMessages(conversationId) {
  const access = canAccessConversation(conversationId);
  if (!access) return [];
  const messages = state.messages.filter((message) => message.conversationId === conversationId);
  const readAt = new Date().toISOString();
  for (const message of messages) {
    if (message.senderId !== state.currentUser.id && !message.readAt) message.readAt = readAt;
  }
  return messages.map(copyMessage);
}

export function addConversationMessage(conversationId, text) {
  const access = canAccessConversation(conversationId);
  if (!access) return null;
  if (!validateText(text, { minLength: 1, maxLength: 1000, allowNewlines: true }) ||
      markupPattern.test(text)) {
    recordSecurityEvent("CHAT_MESSAGE_REJECTED", state.currentUser.role);
    return null;
  }

  const senderId = state.currentUser.id;
  const now = Date.now();
  const attempts = state.messageAttempts[senderId] || { sentAt: [], blockedUntil: 0 };
  attempts.sentAt = attempts.sentAt.filter((time) => now - time < 60000);
  if (attempts.blockedUntil > now || attempts.sentAt.length >= 10 ||
      (attempts.sentAt.length && now - attempts.sentAt[attempts.sentAt.length - 1] < 700)) {
    if (attempts.sentAt.length >= 10) attempts.blockedUntil = now + 15000;
    state.messageAttempts[senderId] = attempts;
    recordSecurityEvent("CHAT_RATE_LIMITED", state.currentUser.role);
    return null;
  }
  attempts.sentAt.push(now);
  state.messageAttempts[senderId] = attempts;

  const message = {
    id: `msg-${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    conversationId,
    senderId,
    senderRole: state.currentUser.role,
    text: text.trim(),
    createdAt: new Date(now).toISOString(),
    readAt: null
  };
  state.messages.push(message);
  access.conversation.lastMessageAt = message.createdAt;
  return copyMessage(message);
}

export function closeActiveConversation() {
  state.activeConversationId = null;
}

export function getChatState() {
  const visibleConversations = state.conversations.reduce((visible, conversation) => {
    const access = canAccessConversation(conversation.id);
    if (access) visible.push(copyConversation(access.conversation));
    return visible;
  }, []);
  const visibleIds = new Set(visibleConversations.map((conversation) => conversation.id));
  return {
    activeConversationId: visibleIds.has(state.activeConversationId) ? state.activeConversationId : null,
    conversations: visibleConversations,
    messages: state.messages
      .filter((message) => visibleIds.has(message.conversationId))
      .map(copyMessage)
  };
}

export function resetDemoChatState() {
  for (const request of state.customerRequests) {
    if (request.demoAccepted) {
      request.status = "Pending";
      request.demoAccepted = false;
    }
  }
  state.conversations = [];
  state.messages = [];
  state.activeConversationId = null;
  state.messageAttempts = {};
  state.reviews = [];
  state.reports = [];
  resetAbuseSignals();
}

export function clearRequestState() {
  state.selectedWorkerId = null;
  state.currentRequest = null;
}

// ==========================================
// #REVIEWS_STATE
// ==========================================

export function createCustomerReview(data) {
  const user = state.currentUser;
  if (!user || user.role !== "customer" || !hasCapability(user.role, "submitReview")) {
    recordSecurityEvent("UNAUTHORIZED_UI_ACTION", user?.role || null);
    throw new Error("Only authenticated customers can submit reviews.");
  }
  if (!data || typeof data !== "object") {
    recordSecurityEvent("INVALID_REQUEST", user.role);
    throw new TypeError("Review data must be an object.");
  }

  const abuseCheck = checkAndTrackAction(user.id, "review");
  if (abuseCheck.restricted) {
    recordSecurityEvent("ABUSE_RESTRICTION_APPLIED", user.role);
    throw new Error(abuseCheck.reason);
  }

  const { requestId, rating, text } = data;
  if (!isValidCustomerRequestId(requestId)) {
    recordSecurityEvent("INVALID_REQUEST", user.role);
    throw new TypeError("Invalid request ID for review.");
  }

  const request = state.customerRequests.find((item) => item.id === requestId);
  if (!request || request.customerId !== user.id || !isValidStoredCustomerRequest(request)) {
    recordSecurityEvent("UNAUTHORIZED_UI_ACTION", user.role);
    throw new Error("You can only review your own requests.");
  }

  if (request.status !== "Completed") {
    recordSecurityEvent("INVALID_REQUEST", user.role);
    throw new Error("Reviews can only be submitted for completed requests.");
  }

  const existingReview = state.reviews.find((item) => item.requestId === requestId);
  if (existingReview) {
    recordSecurityEvent("VALIDATION_FAILURE", user.role);
    throw new Error("A review has already been submitted for this request.");
  }

  const normalizedRating = Number(rating);
  if (!Number.isInteger(normalizedRating) || normalizedRating < 1 || normalizedRating > 5) {
    recordSecurityEvent("VALIDATION_FAILURE", user.role);
    throw new RangeError("Rating must be an integer between 1 and 5.");
  }

  if (!validateReview(text) || markupPattern.test(text)) {
    recordSecurityEvent("VALIDATION_FAILURE", user.role);
    if (markupPattern.test(text)) {
      recordSecurityEvent("SUSPICIOUS_INPUT", user.role);
    }
    throw new TypeError("Invalid review text.");
  }

  const review = {
    id: `rev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    requestId: request.id,
    customerId: user.id,
    customerName: request.customerName,
    workerId: request.workerId,
    workerName: request.workerName,
    rating: normalizedRating,
    text: text.trim(),
    createdAt: new Date().toISOString(),
    updatedAt: null,
    workerReply: null,
    workerReplyAt: null,
    status: "published"
  };

  state.reviews.push(review);
  recordSecurityEvent("REVIEW_SUBMITTED", user.role);
  return copyReview(review);
}

export function getReviewByRequestId(requestId) {
  if (!isValidCustomerRequestId(requestId)) return null;
  const review = state.reviews.find((item) => item.requestId === requestId);
  return review ? copyReview(review) : null;
}

export function getReviewsForWorker(workerId) {
  const normalizedId = Number(workerId);
  if (!Number.isSafeInteger(normalizedId)) return [];
  return state.reviews
    .filter((item) => item.workerId === normalizedId)
    .map(copyReview);
}

export function getReviewsForCustomer(customerId) {
  if (!customerId || typeof customerId !== "string" || !customerIdPattern.test(customerId)) return [];
  return state.reviews
    .filter((item) => item.customerId === customerId)
    .map(copyReview);
}

export function getReviewById(reviewId) {
  if (!reviewId || typeof reviewId !== "string" || !reviewIdPattern.test(reviewId)) return null;
  const review = state.reviews.find((item) => item.id === reviewId);
  return review ? copyReview(review) : null;
}

export function addWorkerReviewReply(reviewId, replyText) {
  const user = state.currentUser;
  if (!user || user.role !== "worker" || !hasCapability(user.role, "manageOwnProfile")) {
    recordSecurityEvent("UNAUTHORIZED_UI_ACTION", user?.role || null);
    throw new Error("Only authenticated workers can reply to reviews.");
  }
  if (!reviewId || typeof reviewId !== "string" || !reviewIdPattern.test(reviewId)) {
    recordSecurityEvent("INVALID_REQUEST", user.role);
    throw new TypeError("Invalid review ID.");
  }

  const review = state.reviews.find((item) => item.id === reviewId);
  if (!review) {
    recordSecurityEvent("INVALID_REQUEST", user.role);
    throw new Error("Review not found.");
  }

  if (review.workerId !== user.workerId || user.id !== `demo-worker-${user.workerId}`) {
    recordSecurityEvent("UNAUTHORIZED_UI_ACTION", user.role);
    throw new Error("You can only reply to reviews on your own profile.");
  }

  if (!validateText(replyText, { minLength: 2, maxLength: 600, allowNewlines: true }) || markupPattern.test(replyText)) {
    recordSecurityEvent("VALIDATION_FAILURE", user.role);
    if (markupPattern.test(replyText)) {
      recordSecurityEvent("SUSPICIOUS_INPUT", user.role);
    }
    throw new TypeError("Invalid reply text.");
  }

  review.workerReply = replyText.trim();
  review.workerReplyAt = new Date().toISOString();
  review.updatedAt = review.workerReplyAt;

  recordSecurityEvent("REVIEW_REPLY_SUBMITTED", user.role);
  return copyReview(review);
}

// ==========================================
// #REPORTS_STATE
// ==========================================

export function createReport(data) {
  const user = state.currentUser;
  if (!user || (user.role !== "customer" && user.role !== "worker") || !hasCapability(user.role, "reportUser")) {
    recordSecurityEvent("UNAUTHORIZED_UI_ACTION", user?.role || null);
    throw new Error("Reporting requires an authenticated account.");
  }
  if (!data || typeof data !== "object") {
    recordSecurityEvent("INVALID_REQUEST", user.role);
    throw new TypeError("Report data must be an object.");
  }

  const abuseCheck = checkAndTrackAction(user.id, "report");
  if (abuseCheck.restricted) {
    recordSecurityEvent("ABUSE_RESTRICTION_APPLIED", user.role);
    throw new Error(abuseCheck.reason);
  }

  const { targetType, targetId, reason, description } = data;
  if (!allowedReportTargetTypes.includes(targetType)) {
    recordSecurityEvent("INVALID_REQUEST", user.role);
    throw new RangeError("Invalid report target type.");
  }

  const targetIdStr = String(targetId).trim();
  if (!targetIdStr) {
    recordSecurityEvent("INVALID_REQUEST", user.role);
    throw new TypeError("Target ID is required.");
  }

  if (targetType === "worker") {
    const workerId = Number(targetIdStr);
    if (!Number.isSafeInteger(workerId) || !getWorkerById(workerId)) {
      recordSecurityEvent("INVALID_REQUEST", user.role);
      throw new TypeError("Invalid worker target ID.");
    }
  } else if (targetType === "customer") {
    if (!customerIdPattern.test(targetIdStr)) {
      recordSecurityEvent("INVALID_REQUEST", user.role);
      throw new TypeError("Invalid customer target ID.");
    }
  } else if (targetType === "review") {
    if (!reviewIdPattern.test(targetIdStr) || !state.reviews.some((r) => r.id === targetIdStr)) {
      recordSecurityEvent("INVALID_REQUEST", user.role);
      throw new TypeError("Invalid review target ID.");
    }
  } else if (targetType === "message") {
    if (!/^msg-[a-z0-9-]{8,100}$/.test(targetIdStr) || !state.messages.some((m) => m.id === targetIdStr)) {
      recordSecurityEvent("INVALID_REQUEST", user.role);
      throw new TypeError("Invalid message target ID.");
    }
  }

  if (!allowedReportReasons.includes(reason)) {
    recordSecurityEvent("VALIDATION_FAILURE", user.role);
    throw new RangeError("Invalid report reason.");
  }

  if (!validateReport(description) || markupPattern.test(description)) {
    recordSecurityEvent("VALIDATION_FAILURE", user.role);
    if (markupPattern.test(description)) {
      recordSecurityEvent("SUSPICIOUS_INPUT", user.role);
    }
    throw new TypeError("Invalid report description.");
  }

  const duplicate = state.reports.some(
    (item) => item.reporterId === user.id && item.targetId === targetIdStr && item.targetType === targetType
  );
  if (duplicate) {
    recordSecurityEvent("VALIDATION_FAILURE", user.role);
    throw new Error("You have already submitted a report for this target.");
  }

  const report = {
    id: `rep-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    reporterId: user.id,
    reporterRole: user.role,
    targetType,
    targetId: targetIdStr,
    reason,
    description: description.trim(),
    createdAt: new Date().toISOString(),
    status: "open"
  };

  state.reports.push(report);
  recordSecurityEvent("REPORT_SUBMITTED", user.role);
  return copyReport(report);
}

export function hasReportedTarget(targetId, targetType) {
  const user = state.currentUser;
  if (!user) return false;
  const targetIdStr = String(targetId).trim();
  return state.reports.some(
    (item) => item.reporterId === user.id && item.targetId === targetIdStr && (!targetType || item.targetType === targetType)
  );
}

export function getReportsByReporter(reporterId) {
  const user = state.currentUser;
  if (!user || user.id !== reporterId) return [];
  return state.reports
    .filter((item) => item.reporterId === reporterId)
    .map(copyReport);
}
