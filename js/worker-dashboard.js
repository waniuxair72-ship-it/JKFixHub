// ==========================================
// #WORKER_DASHBOARD
// ==========================================

// Dashboard state and controls are connected to real Cloud Firestore data.
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
  getWorkerFirestoreRequests,
  updateFirestoreRequestStatus
} from "./firestore-service.js";
import { renderWorkerReviews } from "./reviews.js";
import {
  getSafeErrorMessage,
  hasCapability,
  recordSecurityEvent,
  setTextContent,
  validatePersonName,
  validateText
} from "./security.js";

const statDefinitions = [
  ["Total Requests", "total"],
  ["Pending", "pending"],
  ["Accepted", "accepted"],
  ["Rejected", "rejected"],
  ["Rating", "rating"]
];

let initialized = false;

function installWorkerReviewsSection() {
  if (document.getElementById("workerDashboardReviews")) return;
  const dashboard = document.getElementById("workerDashboardView");
  const requestsSection = document.getElementById("workerDashboardRequests")?.closest(".worker-dashboard-section");
  if (!dashboard || !requestsSection) return;

  const section = document.createElement("section");
  const heading = document.createElement("div");
  const titleWrap = document.createElement("div");
  const label = document.createElement("span");
  const title = document.createElement("h3");
  const note = document.createElement("span");
  const reviews = document.createElement("div");
  section.className = "worker-dashboard-section";
  heading.className = "worker-dashboard-section-heading";
  titleWrap.append(label, title);
  setTextContent(label, "Customer Feedback");
  label.className = "section-label";
  setTextContent(title, "Reviews Received");
  setTextContent(note, "Customer feedback");
  note.className = "dashboard-demo-note";
  heading.append(titleWrap, note);
  reviews.id = "workerDashboardReviews";
  reviews.className = "worker-dashboard-reviews";
  section.append(heading, reviews);
  requestsSection.insertAdjacentElement("afterend", section);
}

function getActiveWorker() {
  if (!isWorker() || !hasCapability("worker", "manageOwnProfile")) {
    recordSecurityEvent("UNAUTHORIZED_UI_ACTION", getCurrentUser()?.role || null);
    return null;
  }

  const user = getCurrentUser();
  if (!user) return null;
  const workerLookup = (user.workerId && getWorkerById(user.workerId)) || getWorkerById(user.id);
  if (workerLookup) {
    return {
      ...workerLookup,
      id: user.id || workerLookup.id,
      workerUid: user.id || workerLookup.id
    };
  }

  const initials = (user.name || "Worker")
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase() || "WK";

  return {
    id: user.id,
    workerUid: user.id,
    name: user.name || "Worker",
    service: user.service || "Electrician",
    district: user.district || "Srinagar",
    rating: user.rating || "5.0",
    availability: user.availability || "Available",
    initials,
    experience: user.experience || "1 year",
    services: user.service || "Electrician",
    about: "Registered service professional."
  };
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

function formatRequestTime(isoString) {
  if (!isoString) return "Recently";
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return "Recently";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function buildRequestCard(request) {
  const card = document.createElement("article");
  const main = document.createElement("div");
  const title = document.createElement("h4");
  const service = document.createElement("p");
  const description = document.createElement("p");
  const meta = document.createElement("div");
  const location = document.createElement("span");
  const time = document.createElement("span");
  const aside = document.createElement("div");
  const status = document.createElement("span");

  card.className = "dashboard-request-card";
  card.dataset.requestId = request.id;
  main.className = "dashboard-request-main";
  title.className = "dashboard-request-customer";
  service.className = "dashboard-request-service";
  description.className = "dashboard-request-description";
  meta.className = "dashboard-request-meta";
  aside.className = "dashboard-request-aside";
  status.className = `dashboard-request-status status-${(request.status || "pending").toLowerCase()}`;

  setTextContent(title, request.customerName || request.customer || "Customer");
  setTextContent(service, request.service);
  setTextContent(description, request.problemDescription || request.description || "No problem description provided.");

  const locParts = [request.district, request.customerLocation || request.location].filter(Boolean);
  setTextContent(location, locParts.join(" · ") || request.district || "Location not specified");
  setTextContent(time, formatRequestTime(request.createdAt));
  setTextContent(status, request.status || "Pending");

  meta.append(location, time);
  main.append(title, service, description, meta);
  aside.append(status);

  if (request.status === "Pending") {
    const actions = document.createElement("div");
    actions.className = "dashboard-request-actions";

    const acceptBtn = document.createElement("button");
    acceptBtn.type = "button";
    acceptBtn.className = "button primary btn-accept-request";
    acceptBtn.dataset.workerAction = "accept";
    acceptBtn.dataset.requestId = request.id;
    setTextContent(acceptBtn, "Accept");

    const rejectBtn = document.createElement("button");
    rejectBtn.type = "button";
    rejectBtn.className = "button subtle btn-reject-request";
    rejectBtn.dataset.workerAction = "reject";
    rejectBtn.dataset.requestId = request.id;
    setTextContent(rejectBtn, "Reject");

    actions.append(acceptBtn, rejectBtn);
    aside.append(actions);
  } else if (request.status === "Accepted") {
    const actions = document.createElement("div");
    actions.className = "dashboard-request-actions";

    const chatBtn = document.createElement("button");
    chatBtn.type = "button";
    chatBtn.className = "button primary btn-chat-request";
    chatBtn.dataset.openWorkerChat = request.id;
    setTextContent(chatBtn, "Chat with Customer");

    actions.append(chatBtn);
    aside.append(actions);
  }

  card.append(main, aside);
  return card;
}

async function loadAndRenderWorkerRequests(worker) {
  const requestsContainer = document.getElementById("workerDashboardRequests");
  if (!requestsContainer) return;

  let requests = [];
  try {
    requests = await getWorkerFirestoreRequests(worker.id);
  } catch (err) {
    console.warn("[JKFixHub Worker Dashboard] Requests fetch notice:", err);
  }

  if ((!requests || requests.length === 0) && isWorker()) {
    const fallbackMem = getWorkerCustomerRequests();
    if (fallbackMem && fallbackMem.length) {
      requests = fallbackMem;
    }
  }

  const statistics = document.getElementById("workerDashboardStatistics");
  if (statistics) {
    const total = requests.length;
    const pending = requests.filter((r) => r.status === "Pending").length;
    const accepted = requests.filter((r) => r.status === "Accepted").length;
    const rejected = requests.filter((r) => r.status === "Rejected").length;
    const stats = {
      total,
      pending,
      accepted,
      rejected,
      rating: `${worker.rating || "5.0"} ★`
    };
    statistics.replaceChildren(...statDefinitions.map(([label, key]) => buildStatCard(label, stats[key], key)));
  }

  if (!requests || requests.length === 0) {
    const empty = document.createElement("p");
    empty.className = "worker-dashboard-empty";
    setTextContent(empty, "No customer requests are currently assigned to this worker.");
    requestsContainer.replaceChildren(empty);
    return;
  }

  requests.sort((a, b) => {
    if (a.status === "Pending" && b.status !== "Pending") return -1;
    if (a.status !== "Pending" && b.status === "Pending") return 1;
    return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
  });

  requestsContainer.replaceChildren(...requests.map(buildRequestCard));
}

async function handleWorkerRequestAction(requestId, newStatus, worker) {
  const feedbackEl = document.getElementById("workerDashboardFeedback");
  if (feedbackEl) setTextContent(feedbackEl, `Updating request to ${newStatus}...`);

  try {
    const res = await updateFirestoreRequestStatus(requestId, newStatus, worker.id);
    if (res.success) {
      if (feedbackEl) {
        setTextContent(feedbackEl, `Request #${requestId} status updated to ${newStatus}.`);
      }
      await loadAndRenderWorkerRequests(worker);
    } else {
      if (feedbackEl) {
        setTextContent(feedbackEl, res.error || "Failed to update request.");
      }
      await loadAndRenderWorkerRequests(worker);
    }
  } catch (err) {
    console.error("[JKFixHub Worker Dashboard] Action error:", err);
    if (feedbackEl) {
      setTextContent(feedbackEl, "An error occurred while updating the request.");
    }
  }
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
    ["workerDashboardVerification", getCurrentUser()?.isVerified ? "Verified worker" : "Pending verification"]
  ];

  setTextContent(initials, worker.initials);
  for (const [id, value] of fields) {
    setTextContent(document.getElementById(id), value);
  }
  document.getElementById("workerDashboardAvailability").value =
    ["Available", "Busy", "Offline"].includes(worker.availability) ? worker.availability : "Busy";

  loadAndRenderWorkerRequests(worker);

  const reviewsContainer = document.getElementById("workerDashboardReviews");
  if (reviewsContainer) {
    renderWorkerReviews(worker.id, reviewsContainer);
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
  setTextContent(document.getElementById("workerDashboardFeedback"), "Worker profile updated successfully.");
}

export function openWorkerDashboard() {
  installWorkerReviewsSection();
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
  installWorkerReviewsSection();

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

    const workerActionButton = target.closest("[data-worker-action]");
    if (workerActionButton) {
      const worker = getActiveWorker();
      if (!worker) return;
      const action = workerActionButton.dataset.workerAction;
      const requestId = workerActionButton.dataset.requestId;
      if (!requestId || !action) return;

      const newStatus = action === "accept" ? "Accepted" : action === "reject" ? "Rejected" : null;
      if (!newStatus) return;

      workerActionButton.disabled = true;
      const parent = workerActionButton.closest(".dashboard-request-actions");
      if (parent) {
        parent.querySelectorAll("button").forEach((btn) => { btn.disabled = true; });
      }

      handleWorkerRequestAction(requestId, newStatus, worker);
      return;
    }

    const actionButton = target.closest("[data-request-action]");
    if (actionButton) {
      if (!getActiveWorker()) return;
      closeModal("authModal");
      openMaintenanceNotice("Request management");
      return;
    }

    const completeButton = target.closest("[data-demo-complete-request]");
    if (completeButton) {
      const requestId = completeButton.dataset.demoCompleteRequest;
      const worker = getActiveWorker();
      if (worker) {
        updateFirestoreRequestStatus(requestId, "Completed", worker.id).then(() => {
          renderDashboard(worker);
          setTextContent(
            document.getElementById("workerDashboardFeedback"),
            "Request marked Completed."
          );
        });
      }
    }
  });
}
