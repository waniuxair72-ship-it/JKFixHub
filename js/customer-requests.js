// ==========================================
// #CUSTOMER_REQUESTS
// ==========================================

// Customer request history is connected to real Cloud Firestore data.
import { closeModal, openModal } from "./modals.js";
import {
  cancelCustomerRequest,
  getCustomerRequestById,
  getCustomerRequests,
  getCurrentUser,
  getReviewByRequestId,
  isCustomer,
  setStoredCustomerRequests,
  upsertStoredCustomerRequest
} from "./store.js";
import {
  getCustomerFirestoreRequests,
  subscribeToFirestoreRequest
} from "./firestore-service.js";
import { hasCapability, recordSecurityEvent, setTextContent } from "./security.js";

let initialized = false;
let pendingCancellationId = null;
let customerDetailsUnsubscribe = null;
let activeDetailsRequestId = null;

export function stopCustomerDetailsSubscription() {
  if (typeof customerDetailsUnsubscribe === "function") {
    try {
      customerDetailsUnsubscribe();
    } catch {}
    customerDetailsUnsubscribe = null;
  }
  activeDetailsRequestId = null;
}

function startCustomerDetailsSubscription(requestId) {
  stopCustomerDetailsSubscription();
  if (!requestId) return;

  activeDetailsRequestId = requestId;

  subscribeToFirestoreRequest(requestId, (updatedRequest) => {
    if (!updatedRequest || !updatedRequest.status) return;
    if (activeDetailsRequestId !== requestId && activeDetailsRequestId !== updatedRequest.id) return;

    upsertStoredCustomerRequest(updatedRequest);
    renderCustomerSummary();

    const statusElement = document.getElementById("customerRequestDetailStatus");
    if (statusElement) {
      setTextContent(statusElement, updatedRequest.status);
      statusElement.className = `customer-request-status status-${updatedRequest.status.toLowerCase()}`;
    }

    const cancelButton = document.getElementById("customerRequestDetailsCancel");
    if (cancelButton) {
      cancelButton.hidden = updatedRequest.status !== "Pending";
    }

    const chatButton = document.getElementById("customerRequestDetailsChat");
    if (chatButton) {
      chatButton.hidden = updatedRequest.status !== "Accepted";
      chatButton.dataset.openCustomerChat = updatedRequest.id;
    }

    // Also update request list in the background if rendered
    renderCustomerRequests();
  }).then((unsub) => {
    const detailsModal = document.getElementById("customerRequestDetailsModal");
    if (!detailsModal || !detailsModal.classList.contains("open") || activeDetailsRequestId !== requestId) {
      if (typeof unsub === "function") unsub();
      return;
    }
    customerDetailsUnsubscribe = unsub;
  });
}

function canViewCustomerRequests() {
  if (isCustomer() && hasCapability("customer", "viewOwnRequests")) return true;
  recordSecurityEvent("UNAUTHORIZED_UI_ACTION", getCurrentUser()?.role || null);
  return false;
}

function buildSummaryCard(label, value) {
  const card = document.createElement("article");
  const title = document.createElement("span");
  const count = document.createElement("strong");
  card.className = "customer-request-summary-card";
  setTextContent(title, label);
  setTextContent(count, value);
  card.append(title, count);
  return card;
}

function installCustomerEntryPoints() {
  const account = document.getElementById("authAccountView");
  const actions = document.querySelector("#authAccountView .auth-account-actions");
  const navActions = document.querySelector(".nav-actions");
  if (!account || !actions || !navActions) return;

  const summary = document.createElement("section");
  const heading = document.createElement("div");
  const title = document.createElement("h3");
  const note = document.createElement("span");
  const statistics = document.createElement("div");
  const button = document.createElement("button");
  const navButton = document.createElement("button");

  summary.id = "customerAccountRequestSummary";
  summary.className = "customer-account-request-summary";
  summary.hidden = true;
  heading.className = "customer-account-request-heading";
  setTextContent(title, "Your Requests");
  setTextContent(note, "Active session");
  heading.append(title, note);
  statistics.id = "customerAccountRequestStatistics";
  statistics.className = "customer-account-request-statistics";
  button.id = "openMyRequests";
  button.className = "button subtle";
  button.type = "button";
  setTextContent(button, "View My Requests");
  summary.append(heading, statistics, button);
  actions.insertAdjacentElement("afterend", summary);

  navButton.id = "myRequestsButton";
  navButton.className = "nav-button subtle";
  navButton.type = "button";
  navButton.hidden = true;
  setTextContent(navButton, "My Requests");
  navActions.append(navButton);
}

function renderCustomerSummary() {
  const summary = document.getElementById("customerAccountRequestSummary");
  const statistics = document.getElementById("customerAccountRequestStatistics");
  const navButton = document.getElementById("myRequestsButton");
  if (!summary || !statistics || !navButton) return;

  if (!isCustomer()) {
    summary.hidden = true;
    navButton.hidden = true;
    return;
  }

  const requests = getCustomerRequests();
  const counts = [
    ["Total", requests.length],
    ["Pending", requests.filter((request) => request.status === "Pending").length],
    ["Accepted", requests.filter((request) => request.status === "Accepted").length],
    ["Rejected", requests.filter((request) => request.status === "Rejected").length]
  ];
  statistics.replaceChildren(...counts.map(([label, value]) => buildSummaryCard(label, value)));
  summary.hidden = false;
  navButton.hidden = false;
}

function setRequestsFeedback(message) {
  setTextContent(document.getElementById("customerRequestsFeedback"), message);
}

async function syncCustomerRequestsFromFirestore() {
  const currentUser = getCurrentUser();
  if (!currentUser) return;
  const customerUid = currentUser.firebaseUid || currentUser.id;
  try {
    const firestoreRequests = await getCustomerFirestoreRequests(customerUid);
    if (firestoreRequests && firestoreRequests.length) {
      setStoredCustomerRequests(firestoreRequests);
    }
  } catch (err) {
    console.warn("[JKFixHub Customer] Firestore requests sync notice:", err);
  }
}

function buildRequestCard(request) {
  const card = document.createElement("article");
  const details = document.createElement("div");
  const worker = document.createElement("h3");
  const service = document.createElement("p");
  const description = document.createElement("p");
  const metadata = document.createElement("div");
  const district = document.createElement("span");
  const timestamp = document.createElement("span");
  const status = document.createElement("span");
  const actions = document.createElement("div");
  const detailsButton = document.createElement("button");

  card.className = "customer-request-card";
  details.className = "customer-request-card-main";
  setTextContent(worker, request.workerName);
  setTextContent(service, request.service);
  setTextContent(description, request.description);
  metadata.className = "customer-request-card-meta";
  setTextContent(district, request.district);
  setTextContent(timestamp, `Created · ${new Date(request.createdAt).toLocaleString()}`);
  metadata.append(district, timestamp);
  details.append(worker, service, description, metadata);
  status.className = `customer-request-status status-${request.status.toLowerCase()}`;
  setTextContent(status, request.status);
  actions.className = "customer-request-card-actions";
  detailsButton.className = "button subtle";
  detailsButton.type = "button";
  detailsButton.dataset.customerRequestDetails = request.id;
  setTextContent(detailsButton, "View Details");
  actions.append(detailsButton);

  if (request.status === "Pending") {
    const cancelButton = document.createElement("button");
    const chatLocked = document.createElement("span");
    cancelButton.className = "button subtle";
    cancelButton.type = "button";
    cancelButton.dataset.customerRequestCancel = request.id;
    setTextContent(cancelButton, "Cancel Request");
    actions.append(cancelButton);
    chatLocked.className = "customer-chat-locked";
    setTextContent(chatLocked, "Chat locked · available after worker acceptance");
    actions.append(chatLocked);
  } else if (request.status === "Accepted") {
    const chatButton = document.createElement("button");
    chatButton.className = "button primary";
    chatButton.type = "button";
    chatButton.dataset.openCustomerChat = request.id;
    setTextContent(chatButton, "Chat with Worker");
    actions.append(chatButton);
  } else if (request.status === "Completed") {
    const review = getReviewByRequestId(request.id);
    const reviewButton = document.createElement("button");
    reviewButton.type = "button";
    if (review) {
      reviewButton.className = "button subtle";
      reviewButton.dataset.viewReview = request.id;
      setTextContent(reviewButton, "View Your Review");
    } else {
      reviewButton.className = "button primary";
      reviewButton.dataset.leaveReview = request.id;
      setTextContent(reviewButton, "Leave a Review");
    }
    actions.append(reviewButton);
    const chatClosed = document.createElement("span");
    chatClosed.className = "customer-chat-locked";
    setTextContent(chatClosed, "Chat closed · Service completed");
    actions.append(chatClosed);
  } else {
    const unavailable = document.createElement("span");
    unavailable.className = "customer-chat-locked";
    setTextContent(unavailable, "Chat unavailable");
    actions.append(unavailable);
  }

  const side = document.createElement("div");
  side.className = "customer-request-card-side";
  side.append(status, actions);
  card.append(details, side);
  return card;
}

function renderCustomerRequests() {
  if (!canViewCustomerRequests()) return false;
  const list = document.getElementById("customerRequestsList");
  const empty = document.getElementById("customerRequestsEmpty");
  const requests = getCustomerRequests();

  list.replaceChildren(...requests.map(buildRequestCard));
  empty.hidden = requests.length > 0;
  setRequestsFeedback(requests.length
    ? `${requests.length} request${requests.length === 1 ? "" : "s"} in this session.`
    : "");
  renderCustomerSummary();
  return true;
}

export async function openCustomerRequests() {
  if (!canViewCustomerRequests()) return false;
  await syncCustomerRequestsFromFirestore();
  if (!renderCustomerRequests()) return false;
  document.getElementById("nav")?.classList.remove("open");
  document.getElementById("menuButton")?.setAttribute("aria-expanded", "false");
  closeModal("authModal");
  openModal("customerRequestsModal");
  return true;
}

export async function refreshCustomerRequestSummary() {
  await syncCustomerRequestsFromFirestore();
  renderCustomerSummary();
}

function showCustomerRequestsAgain(message = "") {
  if (!isCustomer()) return;
  renderCustomerRequests();
  if (message) setRequestsFeedback(message);
  openModal("customerRequestsModal");
}

function showRequestDetails(id) {
  if (!canViewCustomerRequests()) return;
  const request = getCustomerRequestById(id);
  if (!request) {
    setRequestsFeedback("That request is unavailable.");
    return;
  }

  const fields = [
    ["customerRequestDetailWorker", request.workerName],
    ["customerRequestDetailService", request.service],
    ["customerRequestDetailDistrict", request.district],
    ["customerRequestDetailDescription", request.description],
    ["customerRequestDetailLocation", request.customerLocation],
    ["customerRequestDetailStatus", request.status],
    ["customerRequestDetailCreatedAt", `Created · ${new Date(request.createdAt).toLocaleString()}`]
  ];
  for (const [id, value] of fields) {
    setTextContent(document.getElementById(id), value);
  }

  const statusElement = document.getElementById("customerRequestDetailStatus");
  statusElement.className = `customer-request-status status-${request.status.toLowerCase()}`;
  const cancelButton = document.getElementById("customerRequestDetailsCancel");
  cancelButton.hidden = request.status !== "Pending";
  cancelButton.dataset.customerRequestCancel = request.id;

  const chatButton = document.getElementById("customerRequestDetailsChat");
  if (chatButton) {
    chatButton.hidden = request.status !== "Accepted";
    chatButton.dataset.openCustomerChat = request.id;
  }

  const reviewButton = document.getElementById("customerRequestDetailsReview");
  if (reviewButton) {
    if (request.status === "Completed") {
      const review = getReviewByRequestId(request.id);
      reviewButton.hidden = false;
      if (review) {
        reviewButton.className = "button subtle";
        reviewButton.dataset.viewReview = request.id;
        delete reviewButton.dataset.leaveReview;
        setTextContent(reviewButton, "View Your Review");
      } else {
        reviewButton.className = "button primary";
        reviewButton.dataset.leaveReview = request.id;
        delete reviewButton.dataset.viewReview;
        setTextContent(reviewButton, "Leave a Review");
      }
    } else {
      reviewButton.hidden = true;
    }
  }
  closeModal("customerRequestsModal");
  openModal("customerRequestDetailsModal");

  if (request.status === "Pending") {
    startCustomerDetailsSubscription(request.id);
  } else {
    stopCustomerDetailsSubscription();
  }
}

function showCancellationConfirmation(id) {
  stopCustomerDetailsSubscription();
  if (!canViewCustomerRequests()) return;
  const request = getCustomerRequestById(id);
  if (!request || request.status !== "Pending") {
    setRequestsFeedback("Only pending requests can be cancelled.");
    return;
  }

  pendingCancellationId = request.id;
  setTextContent(
    document.getElementById("cancelCustomerRequestCopy"),
    `Cancel your ${request.service} request for ${request.workerName}? It will remain in your session history as Cancelled.`
  );
  closeModal("customerRequestsModal");
  closeModal("customerRequestDetailsModal");
  openModal("cancelCustomerRequestModal");
}

function confirmCancellation() {
  stopCustomerDetailsSubscription();
  if (!canViewCustomerRequests() || !pendingCancellationId) {
    pendingCancellationId = null;
    return;
  }

  const cancelled = cancelCustomerRequest(pendingCancellationId);
  pendingCancellationId = null;
  closeModal("cancelCustomerRequestModal");
  showCustomerRequestsAgain(cancelled
    ? "Request cancelled for this session only."
    : "This request can no longer be cancelled.");
}

function handleCustomerRequestClick(event) {
  const target = event.target;
  if (!(target instanceof Element)) return;

  if (target.closest("#myRequestsButton, #openMyRequests")) {
    openCustomerRequests();
    return;
  }
  if (target.closest("#customerRequestsBack")) {
    stopCustomerDetailsSubscription();
    closeModal("customerRequestsModal");
    openModal("authModal");
    return;
  }
  if (target.closest("#customerRequestsBrowse")) {
    stopCustomerDetailsSubscription();
    closeModal("customerRequestsModal");
    document.getElementById("find-worker").scrollIntoView({ behavior: "smooth" });
    return;
  }
  if (target.closest("#customerRequestDetailsCancel")) {
    showCancellationConfirmation(target.closest("#customerRequestDetailsCancel").dataset.customerRequestCancel);
    return;
  }
  if (target.closest("#confirmCustomerRequestCancel")) {
    confirmCancellation();
    return;
  }

  const detailsButton = target.closest("[data-customer-request-details]");
  if (detailsButton) {
    showRequestDetails(detailsButton.dataset.customerRequestDetails);
    return;
  }
  const cancelButton = target.closest("[data-customer-request-cancel]");
  if (cancelButton) {
    showCancellationConfirmation(cancelButton.dataset.customerRequestCancel);
    return;
  }

  if (target === document.getElementById("customerRequestDetailsModal") ||
      target.closest('[data-close="customerRequestDetailsModal"]')) {
    stopCustomerDetailsSubscription();
    window.setTimeout(() => showCustomerRequestsAgain(), 0);
  } else if (target === document.getElementById("cancelCustomerRequestModal") ||
      target.closest('[data-close="cancelCustomerRequestModal"]')) {
    pendingCancellationId = null;
    window.setTimeout(() => showCustomerRequestsAgain(), 0);
  }
}

export function initializeCustomerRequests() {
  if (initialized) return;
  initialized = true;
  installCustomerEntryPoints();

  document.addEventListener("click", handleCustomerRequestClick);
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest(
      "#authAccount, #authLogout, #authLogoutFromDashboard, [data-auth-role='customer'], [data-auth-role='worker']"
    )) {
      window.setTimeout(renderCustomerSummary, 0);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const shouldReturn = document.getElementById("customerRequestDetailsModal").classList.contains("open") ||
      document.getElementById("cancelCustomerRequestModal").classList.contains("open");
    if (shouldReturn) {
      stopCustomerDetailsSubscription();
      window.setTimeout(() => {
        pendingCancellationId = null;
        showCustomerRequestsAgain();
      }, 0);
    }
  }, true);
}
