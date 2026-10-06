// ==========================================
// #WORKER_DASHBOARD
// ==========================================

// Dashboard state and controls are frontend-only demo UX.
import { closeModal, openModal, openMaintenanceNotice } from "./modals.js";
import {
  getCurrentUser,
  getWorkerById,
  getWorkerCustomerRequests,
  getWorkers,
  isWorker,
  setWorkerDemoProfile
} from "./store.js";
import {
  getSafeErrorMessage,
  hasCapability,
  recordSecurityEvent,
  setTextContent,
  validatePersonName,
  validateText
} from "./security.js";

const demoRequests = [
  {
    id: "sample-1",
    customer: "Demo Customer A",
    service: "Electrical repair",
    district: "Shopian",
    description: "A light switch needs inspection.",
    status: "New",
    actions: ["Accept", "Reject"]
  },
  {
    id: "sample-2",
    customer: "Demo Customer B",
    service: "Appliance repair",
    district: "Srinagar",
    description: "The washing machine is not draining.",
    status: "Accepted",
    actions: ["Complete"]
  },
  {
    id: "sample-3",
    customer: "Demo Customer C",
    service: "Cooling repair",
    district: "Anantnag",
    description: "The refrigerator is not cooling evenly.",
    status: "Completed",
    actions: []
  },
  {
    id: "sample-4",
    customer: "Demo Customer D",
    service: "Heater repair",
    district: "Shopian",
    description: "Heating service example request.",
    status: "Cancelled",
    actions: []
  }
];

const statDefinitions = [
  ["Total Requests", "total"],
  ["Accepted", "accepted"],
  ["Completed", "completed"],
  ["Cancelled", "cancelled"],
  ["Rating", "rating"]
];

let initialized = false;

function installAssignedRequestsSection() {
  if (document.getElementById("workerAssignedCustomerRequests")) return;
  const dashboard = document.getElementById("workerDashboardView");
  const requestsSection = document.getElementById("workerDashboardRequests")?.closest(".worker-dashboard-section");
  if (!dashboard || !requestsSection) return;

  const section = document.createElement("section");
  const heading = document.createElement("div");
  const titleWrap = document.createElement("div");
  const label = document.createElement("span");
  const title = document.createElement("h3");
  const note = document.createElement("span");
  const requests = document.createElement("div");
  section.className = "worker-dashboard-section";
  heading.className = "worker-dashboard-section-heading";
  titleWrap.append(label, title);
  setTextContent(label, "Demo request workflow");
  label.className = "section-label";
  setTextContent(title, "Customer Requests");
  setTextContent(note, "Accept is a reversible session-only demo action");
  note.className = "dashboard-demo-note";
  heading.append(titleWrap, note);
  requests.id = "workerAssignedCustomerRequests";
  requests.className = "worker-dashboard-requests";
  section.append(heading, requests);
  requestsSection.insertAdjacentElement("afterend", section);
}

function getActiveWorker() {
  if (!isWorker() || !hasCapability("worker", "manageOwnProfile")) {
    recordSecurityEvent("UNAUTHORIZED_UI_ACTION", getCurrentUser()?.role || null);
    return null;
  }

  const user = getCurrentUser();
  const worker = user ? getWorkerById(user.workerId) : null;
  if (!worker) {
    recordSecurityEvent("INVALID_REQUEST", user?.role || null);
    return null;
  }
  return worker;
}

function buildStatCard(label, value, key) {
  const card = document.createElement("article");
  const title = document.createElement("span");
  const number = document.createElement("strong");
  card.className = "dashboard-stat-card";
  card.dataset.stat = key;
  setTextContent(title, label);
  setTextContent(number, value);
  card.append(title, number);
  return card;
}

function buildRequestCard(request) {
  const card = document.createElement("article");
  const main = document.createElement("div");
  const title = document.createElement("h4");
  const service = document.createElement("p");
  const description = document.createElement("p");
  const meta = document.createElement("div");
  const customer = document.createElement("span");
  const district = document.createElement("span");
  const sampleLabel = document.createElement("span");
  const aside = document.createElement("div");
  const status = document.createElement("span");
  const actions = document.createElement("div");

  card.className = "dashboard-request-card";
  main.className = "dashboard-request-main";
  title.className = "dashboard-request-customer";
  service.className = "dashboard-request-service";
  description.className = "dashboard-request-description";
  meta.className = "dashboard-request-meta";
  sampleLabel.className = "dashboard-sample-label";
  aside.className = "dashboard-request-aside";
  status.className = `dashboard-request-status status-${request.status.toLowerCase()}`;
  actions.className = "dashboard-request-actions";

  setTextContent(title, request.customer);
  setTextContent(service, request.service);
  setTextContent(description, request.description);
  setTextContent(customer, "Demo customer");
  setTextContent(district, request.district);
  setTextContent(sampleLabel, "Illustrative demo request · not saved");
  setTextContent(status, request.status);
  meta.append(customer, district, sampleLabel);
  main.append(title, service, description, meta);

  for (const action of request.actions) {
    const button = document.createElement("button");
    button.className = "button subtle";
    button.type = "button";
    button.dataset.requestAction = action.toLowerCase();
    button.dataset.demoRequest = request.id;
    setTextContent(button, action);
    actions.append(button);
  }
  aside.append(status, actions);
  card.append(main, aside);
  return card;
}

function buildAssignedRequestCard(request) {
  const card = document.createElement("article");
  const details = document.createElement("div");
  const title = document.createElement("h4");
  const service = document.createElement("p");
  const description = document.createElement("p");
  const district = document.createElement("span");
  const status = document.createElement("span");
  const actions = document.createElement("div");

  card.className = "dashboard-request-card";
  details.className = "dashboard-request-main";
  setTextContent(title, request.customerName);
  setTextContent(service, request.service);
  setTextContent(description, request.description);
  setTextContent(district, request.district);
  details.append(title, service, description, district);
  status.className = `dashboard-request-status status-${request.status.toLowerCase()}`;
  setTextContent(status, request.status);
  actions.className = "dashboard-request-actions";

  if (request.status === "Pending") {
    const acceptButton = document.createElement("button");
    acceptButton.className = "button subtle";
    acceptButton.type = "button";
    acceptButton.dataset.demoAcceptRequest = request.id;
    setTextContent(acceptButton, "Accept · Demo only");
    actions.append(acceptButton);
  } else if (request.status === "Accepted") {
    const chatButton = document.createElement("button");
    chatButton.className = "button primary";
    chatButton.type = "button";
    chatButton.dataset.openWorkerChat = request.id;
    setTextContent(chatButton, "Open Chat");
    actions.append(chatButton);
  } else {
    const unavailable = document.createElement("span");
    unavailable.className = "customer-chat-locked";
    setTextContent(unavailable, "Chat unavailable");
    actions.append(unavailable);
  }

  const side = document.createElement("div");
  side.className = "dashboard-request-aside";
  side.append(status, actions);
  card.append(details, side);
  return card;
}

function renderDashboard(worker) {
  const view = document.getElementById("workerDashboardView");
  const initials = document.getElementById("workerDashboardInitials");
  const fields = [
    ["workerDashboardName", worker.name],
    ["workerDashboardService", worker.service],
    ["workerDashboardDistrict", worker.district],
    ["workerDashboardExperience", worker.experience],
    ["workerDashboardRating", `${worker.rating} ★`],
    ["workerDashboardAvailabilityLabel", worker.availability],
    ["workerDashboardVerification", "Demo · not verified"]
  ];

  setTextContent(initials, worker.initials);
  for (const [id, value] of fields) {
    setTextContent(document.getElementById(id), value);
  }
  document.getElementById("workerDashboardAvailability").value =
    ["Available", "Busy", "Offline"].includes(worker.availability) ? worker.availability : "Busy";

  const statistics = document.getElementById("workerDashboardStatistics");
  const completed = demoRequests.filter((request) => request.status === "Completed").length;
  const accepted = demoRequests.filter((request) => request.status === "Accepted").length;
  const cancelled = demoRequests.filter((request) => request.status === "Cancelled").length;
  const stats = {
    total: demoRequests.length,
    accepted,
    completed,
    cancelled,
    rating: `${worker.rating} ★`
  };
  statistics.replaceChildren(...statDefinitions.map(([label, key]) => buildStatCard(label, stats[key], key)));

  const requests = document.getElementById("workerDashboardRequests");
  requests.replaceChildren(...demoRequests.map(buildRequestCard));
  const assignedRequests = document.getElementById("workerAssignedCustomerRequests");
  const customerRequests = getWorkerCustomerRequests();
  if (customerRequests.length) {
    assignedRequests.replaceChildren(...customerRequests.map(buildAssignedRequestCard));
  } else {
    const empty = document.createElement("p");
    empty.className = "worker-dashboard-empty";
    setTextContent(empty, "No customer-created demo requests are assigned to this worker.");
    assignedRequests.replaceChildren(empty);
  }
  view.dataset.workerId = String(worker.id);
}

function populateProfileOptions() {
  const services = [...new Set(getWorkers().map((worker) => worker.service))];
  const districts = [...new Set(getWorkers().map((worker) => worker.district))];
  const serviceSelect = document.getElementById("editWorkerService");
  const districtSelect = document.getElementById("editWorkerDistrict");

  for (const [select, values] of [[serviceSelect, services], [districtSelect, districts]]) {
    const options = values.map((value) => {
      const option = document.createElement("option");
      option.value = value;
      setTextContent(option, value);
      return option;
    });
    select.replaceChildren(...options);
  }
}

function setEditError(field, message, errorElement) {
  setTextContent(errorElement, message);
  errorElement.hidden = !message;
  field.setAttribute("aria-invalid", String(Boolean(message)));
}

function openProfileEditor() {
  const worker = getActiveWorker();
  if (!worker) return;

  const form = document.getElementById("workerProfileEditForm");
  form.reset();
  populateProfileOptions();
  document.getElementById("editWorkerName").value = worker.name;
  document.getElementById("editWorkerService").value = worker.service;
  document.getElementById("editWorkerDistrict").value = worker.district;
  document.getElementById("editWorkerExperience").value = worker.experience;
  document.getElementById("editWorkerAvailability").value =
    ["Available", "Busy", "Offline"].includes(worker.availability) ? worker.availability : "Busy";
  form.querySelectorAll("[data-profile-error]").forEach((error) => {
    setTextContent(error, "");
    error.hidden = true;
  });
  form.querySelectorAll("[aria-invalid]").forEach((field) => field.removeAttribute("aria-invalid"));
  closeModal("authModal");
  openModal("workerProfileEditModal");
}

function handleProfileSave(event) {
  event.preventDefault();
  const worker = getActiveWorker();
  if (!worker) return;

  const name = document.getElementById("editWorkerName");
  const service = document.getElementById("editWorkerService");
  const district = document.getElementById("editWorkerDistrict");
  const experience = document.getElementById("editWorkerExperience");
  const availability = document.getElementById("editWorkerAvailability");
  const nameValid = validatePersonName(name.value);
  const serviceValid = getWorkers().some((item) => item.service === service.value);
  const districtValid = getWorkers().some((item) => item.district === district.value);
  const experienceValid = validateText(experience.value, { minLength: 1, maxLength: 40 }) &&
    /^\d{1,2} years?$/.test(experience.value.trim());
  const availabilityValid = ["Available", "Busy", "Offline"].includes(availability.value);

  setEditError(name, nameValid ? "" : getSafeErrorMessage("invalidName"), document.getElementById("editWorkerNameError"));
  setEditError(service, serviceValid ? "" : getSafeErrorMessage("invalidService"), document.getElementById("editWorkerServiceError"));
  setEditError(district, districtValid ? "" : "Choose a demo district.", document.getElementById("editWorkerDistrictError"));
  setEditError(experience, experienceValid ? "" : "Enter experience like “6 years”.", document.getElementById("editWorkerExperienceError"));
  setEditError(availability, availabilityValid ? "" : "Choose an availability option.", document.getElementById("editWorkerAvailabilityError"));

  if (!nameValid || !serviceValid || !districtValid || !experienceValid || !availabilityValid) {
    recordSecurityEvent("VALIDATION_FAILURE", "worker");
    if (!nameValid && /[<>]/.test(name.value)) recordSecurityEvent("SUSPICIOUS_INPUT", "worker");
    document.querySelector("#workerProfileEditForm [aria-invalid='true']")?.focus();
    return;
  }

  const updated = setWorkerDemoProfile(worker.id, {
    name: name.value,
    service: service.value,
    district: district.value,
    experience: experience.value,
    availability: availability.value
  });
  closeModal("workerProfileEditModal");
  openModal("authModal");
  renderDashboard(updated);
  setTextContent(document.getElementById("workerDashboardFeedback"), "Demo profile updated for this session only.");
}

export function openWorkerDashboard() {
  installAssignedRequestsSection();
  const worker = getActiveWorker();
  if (!worker) return false;

  document.getElementById("authRoleSelection").hidden = true;
  document.getElementById("authAccountView").hidden = true;
  document.getElementById("workerDashboardView").hidden = false;
  const modal = document.querySelector("#authModal .modal");
  modal.classList.add("worker-dashboard-open");
  modal.setAttribute("aria-labelledby", "workerDashboardTitle");
  renderDashboard(worker);
  return true;
}

export function initializeWorkerDashboard() {
  if (initialized) return;
  initialized = true;
  const view = document.getElementById("workerDashboardView");
  const form = document.getElementById("workerProfileEditForm");
  const editModal = document.getElementById("workerProfileEditModal");
  if (!view || !form || !editModal) return;
  installAssignedRequestsSection();

  document.getElementById("editWorkerProfileButton").addEventListener("click", openProfileEditor);
  form.addEventListener("submit", handleProfileSave);
  editModal.addEventListener("click", (event) => {
    if (event.target === editModal || (event.target instanceof Element && event.target.closest('[data-close="workerProfileEditModal"]'))) {
      window.setTimeout(() => {
        if (!editModal.classList.contains("open") && isWorker()) {
          openModal("authModal");
          openWorkerDashboard();
        }
      }, 0);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !editModal.classList.contains("open") && isWorker() &&
      !document.getElementById("authModal").classList.contains("open")) {
      openModal("authModal");
      openWorkerDashboard();
    }
  });
  document.getElementById("workerDashboardAvailability").addEventListener("change", (event) => {
    const worker = getActiveWorker();
    if (!worker) return;
    const updated = setWorkerDemoProfile(worker.id, { availability: event.currentTarget.value });
    renderDashboard(updated);
    setTextContent(document.getElementById("workerDashboardFeedback"), "Availability updated for this session only.");
  });

  view.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const actionButton = target.closest("[data-request-action]");
    if (!actionButton) return;
    if (!getActiveWorker()) return;
    closeModal("authModal");
    openMaintenanceNotice("Request management");
  });
}
