// ==========================================
// #CHAT_LOGIC
// ==========================================

// Chat is an in-memory demo and opens only for accepted requests.
import { closeModal, openMaintenanceNotice, openModal } from "./modals.js";
import {
  addConversationMessage,
  closeActiveConversation,
  getActiveConversation,
  getConversationMessages,
  getCurrentUser,
  getUserRole,
  isCustomer,
  openConversationForRequest,
  acceptCustomerRequestForDemo
} from "./store.js";
import { openCustomerRequests } from "./customer-requests.js";
import { openWorkerDashboard } from "./worker-dashboard.js";
import { recordSecurityEvent, setTextContent, validateText } from "./security.js";

const MAX_MESSAGE_LENGTH = 1000;
let initialized = false;
let returnTo = null;

function setChatFeedback(message) {
  setTextContent(document.getElementById("chatFeedback"), message);
}

function getChatError() {
  return "Your message could not be sent.";
}

function buildMessage(message, currentUser) {
  const article = document.createElement("article");
  const author = document.createElement("span");
  const text = document.createElement("p");
  const metadata = document.createElement("div");
  const timestamp = document.createElement("time");
  const readState = document.createElement("span");
  const ownMessage = message.senderId === currentUser.id;

  article.className = `chat-message${ownMessage ? " chat-message-own" : ""}`;
  setTextContent(author, ownMessage ? "You" : message.senderRole === "worker" ? "Worker" : "Customer");
  setTextContent(text, message.text);
  timestamp.dateTime = message.createdAt;
  setTextContent(timestamp, new Date(message.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
  metadata.className = "chat-message-meta";
  metadata.append(timestamp);
  if (ownMessage && message.readAt) {
    setTextContent(readState, "Read");
    metadata.append(readState);
  }
  article.append(author, text, metadata);
  return article;
}

function renderConversation(conversation) {
  const currentUser = getCurrentUser();
  const headerName = isCustomer() ? conversation.workerName : conversation.customerName;
  setTextContent(document.getElementById("chatParticipantName"), headerName);
  setTextContent(document.getElementById("chatService"), conversation.service);
  setTextContent(document.getElementById("chatDistrict"), conversation.district);
  setTextContent(document.getElementById("chatRequestStatus"), "Accepted · Demo only");

  const messageList = document.getElementById("chatMessages");
  const messages = getConversationMessages(conversation.id);
  messageList.replaceChildren(...messages.map((message) => buildMessage(message, currentUser)));
  messageList.scrollTop = messageList.scrollHeight;
  setChatFeedback(messages.length ? "" : "Chat is open for this accepted demo request.");
  updateMessageCounter();
}

function updateMessageCounter() {
  const input = document.getElementById("chatMessageInput");
  setTextContent(document.getElementById("chatCharacterCount"), `${input.value.length}/${MAX_MESSAGE_LENGTH}`);
}

function closeChat(returnToList = true) {
  closeModal("chatModal");
  closeActiveConversation();
  document.getElementById("chatMessageInput").value = "";
  setChatFeedback("");
  if (!returnToList) return;

  if (!getCurrentUser()) {
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

function openChatForRequest(requestId) {
  const role = getUserRole();
  if (role !== "customer" && role !== "worker") {
    recordSecurityEvent("CHAT_ACCESS_DENIED", role);
    setChatFeedback("Chat is not available yet.");
    return false;
  }

  const conversation = openConversationForRequest(requestId);
  if (!conversation) {
    setChatFeedback("Chat becomes available after the worker accepts your request.");
    return false;
  }

  returnTo = role;
  if (role === "customer") closeModal("customerRequestsModal");
  if (role === "worker") closeModal("authModal");
  document.getElementById("chatForm").reset();
  setChatFeedback("");
  renderConversation(conversation);
  openModal("chatModal");
  document.getElementById("chatMessageInput").focus();
  return true;
}

function sendMessage(event) {
  event.preventDefault();
  const input = document.getElementById("chatMessageInput");
  const message = input.value.trim();
  if (!validateText(message, { minLength: 1, maxLength: MAX_MESSAGE_LENGTH, allowNewlines: true })) {
    recordSecurityEvent("CHAT_MESSAGE_REJECTED", getUserRole());
    setChatFeedback(message ? "Messages must be 1,000 characters or fewer." : "Write a message before sending.");
    input.focus();
    return;
  }

  const conversation = getActiveConversation();
  if (!conversation || conversation.status !== "active") {
    recordSecurityEvent("CHAT_ACCESS_DENIED", getUserRole());
    setChatFeedback("Chat is not available yet.");
    closeChat(false);
    return;
  }

  const created = addConversationMessage(conversation.id, message);
  if (!created) {
    setChatFeedback(getChatError());
    return;
  }

  input.value = "";
  renderConversation(conversation);
  updateMessageCounter();
  input.focus();
}

function handleChatActions(event) {
  const target = event.target;
  if (!(target instanceof Element)) return;

  const acceptButton = target.closest("[data-demo-accept-request]");
  if (acceptButton) {
    const accepted = acceptCustomerRequestForDemo(acceptButton.dataset.demoAcceptRequest);
    if (!accepted) {
      recordSecurityEvent("CHAT_ACCESS_DENIED", getUserRole());
      return;
    }
    openWorkerDashboard();
    openModal("authModal");
    setTextContent(document.getElementById("workerDashboardFeedback"), "Demo only: this request was marked Accepted in memory.");
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
    if (event.key === "Escape" && dialog.classList.contains("open")) {
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
