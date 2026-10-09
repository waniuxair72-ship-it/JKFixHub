// ==========================================
// #CHAT_LOGIC
// ==========================================
// Phase 5B: Real private Firebase chat after service request acceptance.

import { closeModal, openMaintenanceNotice, openModal } from "./modals.js";
import {
  getCurrentUser,
  getUserRole,
  isCustomer,
  closeActiveConversation
} from "./store.js";
import { openCustomerRequests } from "./customer-requests.js";
import { openWorkerDashboard } from "./worker-dashboard.js";
import { recordSecurityEvent, setTextContent, validateText } from "./security.js";
import {
  getFirestoreRequestById,
  getOrCreateFirestoreConversation,
  sendFirestoreChatMessage,
  subscribeToFirestoreChatMessages
} from "./firestore-service.js";

const MAX_MESSAGE_LENGTH = 1000;
let initialized = false;
let returnTo = null;
let currentChatConversation = null;
let chatMessagesUnsubscribe = null;

const CUSTOMER_QUICK_MESSAGES = [
  "Hey, are you available?",
  "Can you help me with this issue?",
  "When can you come?",
  "Thank you."
];

const WORKER_QUICK_MESSAGES = [
  "Yes, I am available.",
  "Please share more details.",
  "May I give you my contact no.?",
  "I can come today.",
  "Thank you."
];

function setChatFeedback(message) {
  setTextContent(document.getElementById("chatFeedback"), message);
}

function getChatError() {
  return "Your message could not be sent.";
}

function updateMessageCounter() {
  const input = document.getElementById("chatMessageInput");
  if (!input) return;
  setTextContent(
    document.getElementById("chatCharacterCount"),
    `${input.value.length}/${MAX_MESSAGE_LENGTH}`
  );
}

function renderQuickMessages(role) {
  const container = document.getElementById("chatQuickMessages");
  if (!container) return;
  const options = role === "worker" ? WORKER_QUICK_MESSAGES : CUSTOMER_QUICK_MESSAGES;
  const chips = options.map((phrase) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chat-quick-btn";
    btn.dataset.quickText = phrase;
    setTextContent(btn, phrase);
    return btn;
  });
  container.replaceChildren(...chips);
}

function buildMessage(message, currentUid) {
  const article = document.createElement("article");
  const author = document.createElement("span");
  const text = document.createElement("p");
  const metadata = document.createElement("div");
  const timestamp = document.createElement("time");
  const readState = document.createElement("span");

  const ownMessage = (message.senderId === currentUid || message.senderUid === currentUid);

  article.className = `chat-message${ownMessage ? " chat-message-own" : ""}`;
  const authorText = ownMessage
    ? "You"
    : message.senderRole === "worker"
      ? "Worker"
      : message.senderRole === "customer"
        ? "Customer"
        : (message.senderName || "User");
  setTextContent(author, authorText);
  setTextContent(text, message.text);

  const dateVal = message.createdAt ? new Date(message.createdAt) : new Date();
  timestamp.dateTime = message.createdAt || dateVal.toISOString();
  setTextContent(
    timestamp,
    Number.isNaN(dateVal.getTime())
      ? "Just now"
      : dateVal.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
  );

  metadata.className = "chat-message-meta";
  metadata.append(timestamp);
  if (ownMessage && message.readAt) {
    setTextContent(readState, "Read");
    metadata.append(readState);
  }
  article.append(author, text, metadata);
  return article;
}

function renderMessages(messages) {
  const messageList = document.getElementById("chatMessages");
  if (!messageList) return;
  const currentUser = getCurrentUser();
  const currentUid = currentUser?.firebaseUid || currentUser?.id;
  messageList.replaceChildren(...messages.map((m) => buildMessage(m, currentUid)));
  messageList.scrollTop = messageList.scrollHeight;
  setChatFeedback(messages.length ? "" : "Direct communication channel is open.");
}

export function closeChat(returnToList = true) {
  if (chatMessagesUnsubscribe) {
    try {
      chatMessagesUnsubscribe();
    } catch (_) {}
    chatMessagesUnsubscribe = null;
  }
  currentChatConversation = null;
  closeModal("chatModal");
  closeActiveConversation();

  const input = document.getElementById("chatMessageInput");
  if (input) input.value = "";
  setChatFeedback("");
  updateMessageCounter();

  if (!returnToList) {
    returnTo = null;
    return;
  }

  const user = getCurrentUser();
  if (!user) {
    returnTo = null;
    return;
  }

  if (returnTo === "worker") {
    if (openWorkerDashboard()) openModal("authModal");
  } else if (returnTo === "customer" && isCustomer()) {
    openCustomerRequests();
  }
  returnTo = null;
}

export async function openChatForRequest(requestId) {
  if (!requestId) return false;
  const role = getUserRole();
  if (role !== "customer" && role !== "worker") {
    recordSecurityEvent("CHAT_ACCESS_DENIED", role);
    setChatFeedback("Chat is not available yet.");
    return false;
  }

  const currentUser = getCurrentUser();
  if (!currentUser) {
    recordSecurityEvent("CHAT_ACCESS_DENIED", role);
    setChatFeedback("Please sign in to chat.");
    return false;
  }
  const currentUid = currentUser.firebaseUid || currentUser.id;

  // 1. Resolve request from Firestore ONLY (Fail-closed: no in-memory or demo fallback)
  const request = await getFirestoreRequestById(requestId);

  // 2. Chat must open only when the selected Firestore request exists and status === "Accepted"
  if (!request || request.status !== "Accepted") {
    recordSecurityEvent("CHAT_ACCESS_DENIED", role);
    const reason = !request
      ? "Request details could not be found."
      : request.status === "Pending"
        ? "Chat is locked while request is Pending review."
        : request.status === "Rejected"
          ? "Chat is unavailable because this request was declined."
          : `Chat is locked (request is ${request.status}). Available only when Accepted.`;
    setChatFeedback(reason);
    return false;
  }

  // 3. Current authenticated user must be either request.customerId or request.workerUid
  const customerId = request.customerId || request.customerUid;
  const workerUid = request.workerUid || request.workerId;
  if (currentUid !== customerId && currentUid !== workerUid) {
    recordSecurityEvent("CHAT_ACCESS_DENIED", role);
    setChatFeedback("Unauthorized: You are not a participant in this request.");
    return false;
  }

  // 4. Clean up any previous chat listener
  if (chatMessagesUnsubscribe) {
    try {
      chatMessagesUnsubscribe();
    } catch (_) {}
    chatMessagesUnsubscribe = null;
  }

  // 5. Ensure private Firestore conversation exists (Fail-closed)
  setChatFeedback("Connecting to conversation...");
  const convResult = await getOrCreateFirestoreConversation(request, currentUid);
  if (!convResult?.success || !convResult.conversation) {
    setChatFeedback(convResult?.error || "Could not open chat session.");
    return false;
  }

  currentChatConversation = convResult.conversation;
  returnTo = role;

  // 6. Dismiss any open source modals
  if (role === "customer") {
    closeModal("customerRequestsModal");
    closeModal("customerRequestDetailsModal");
    closeModal("requestModal");
  } else if (role === "worker") {
    closeModal("authModal");
  }

  // 7. Populate header
  const isCust = role === "customer";
  const headerName = isCust
    ? (currentChatConversation.workerName || "Worker")
    : (currentChatConversation.customerName || "Customer");

  setTextContent(document.getElementById("chatParticipantName"), headerName);
  setTextContent(document.getElementById("chatService"), currentChatConversation.service || "");
  setTextContent(document.getElementById("chatDistrict"), currentChatConversation.district || "");
  setTextContent(document.getElementById("chatRequestStatus"), "Accepted · Active");

  // 8. Reset composer & render quick response chips
  const form = document.getElementById("chatForm");
  if (form) form.reset();
  updateMessageCounter();
  renderQuickMessages(role);
  setChatFeedback("Direct communication channel is open.");

  // 9. Open modal and focus input
  openModal("chatModal");
  const input = document.getElementById("chatMessageInput");
  if (input) input.focus();

  // 10. Subscribe to real-time Firestore messages
  chatMessagesUnsubscribe = await subscribeToFirestoreChatMessages(
    currentChatConversation.id,
    (messages) => {
      renderMessages(messages);
    },
    (err) => {
      console.warn("[JKFixHub Chat] Message subscription notice:", err);
      setChatFeedback("Connection issue: could not load recent messages.");
    }
  );

  return true;
}

async function sendChatMessage(rawText) {
  if (!currentChatConversation) {
    recordSecurityEvent("CHAT_ACCESS_DENIED", getUserRole());
    setChatFeedback("Chat is not available yet.");
    closeChat(false);
    return;
  }

  const cleanText = (rawText || "").trim();
  if (!validateText(cleanText, { minLength: 1, maxLength: MAX_MESSAGE_LENGTH, allowNewlines: true })) {
    recordSecurityEvent("CHAT_MESSAGE_REJECTED", getUserRole());
    setChatFeedback(cleanText ? "Messages must be 1,000 characters or fewer." : "Write a message before sending.");
    document.getElementById("chatMessageInput")?.focus();
    return;
  }

  const currentUser = getCurrentUser();
  const currentUid = currentUser?.firebaseUid || currentUser?.id;
  const senderRole = getUserRole();

  const input = document.getElementById("chatMessageInput");
  if (input) input.value = "";
  updateMessageCounter();

  const result = await sendFirestoreChatMessage({
    chatId: currentChatConversation.id,
    text: cleanText,
    senderUid: currentUid,
    senderName: currentUser?.name || (senderRole === "worker" ? "Worker" : "Customer"),
    senderRole
  });

  if (!result?.success) {
    setChatFeedback(result?.error || getChatError());
    if (input) input.value = cleanText;
    updateMessageCounter();
  } else {
    setChatFeedback("");
  }

  if (input) input.focus();
}

function sendMessage(event) {
  event.preventDefault();
  const input = document.getElementById("chatMessageInput");
  const message = input ? input.value : "";
  sendChatMessage(message);
}

function handleChatActions(event) {
  const target = event.target;
  if (!(target instanceof Element)) return;

  const quickButton = target.closest(".chat-quick-btn");
  if (quickButton && quickButton.dataset.quickText) {
    sendChatMessage(quickButton.dataset.quickText);
    return;
  }

  const customerChatButton = target.closest("[data-open-customer-chat]");
  if (customerChatButton) {
    openChatForRequest(customerChatButton.dataset.openCustomerChat);
    return;
  }

  const workerChatButton = target.closest("[data-open-worker-chat]");
  if (workerChatButton) {
    openChatForRequest(workerChatButton.dataset.openWorkerChat);
    return;
  }

  if (target.closest("#chatBackButton")) {
    closeChat();
    return;
  }

  if (target.closest("#chatReportUser")) {
    return;
  }

  if (target.closest("#chatBlockUser")) {
    openMaintenanceNotice("Safety controls");
    return;
  }

  if (target === document.getElementById("chatModal") ||
      target.closest('[data-close="chatModal"]')) {
    closeChat();
  }
}

export function initializeChat() {
  if (initialized) return;
  initialized = true;

  const form = document.getElementById("chatForm");
  const input = document.getElementById("chatMessageInput");
  if (!form || !input) return;

  document.addEventListener("click", handleChatActions);
  form.addEventListener("submit", sendMessage);
  input.addEventListener("input", updateMessageCounter);
  document.addEventListener("keydown", (event) => {
    const dialog = document.getElementById("chatModal");
    if (event.key === "Escape" && dialog?.classList.contains("open")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const otherOpenModal = [...document.querySelectorAll(".modal-backdrop.open")]
        .find((modal) => modal.id !== "chatModal");
      if (otherOpenModal) {
        closeModal(otherOpenModal.id);
        return;
      }
      closeChat();
    }
  }, true);
}
