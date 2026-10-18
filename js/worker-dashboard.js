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
  setWorkerDemoProfile,
  saveApplicationProfile,
  setCurrentUser
} from "./store.js";
import {
  getWorkerFirestoreRequests,
  updateFirestoreRequestStatus,
  subscribeToWorkerFirestoreRequests,
  unsubscribeWorkerFirestoreRequests
} from "./firestore-service.js";
import { renderWorkerReviews } from "./reviews.js";
import {
  getSafeErrorMessage,
  hasCapability,
  recordSecurityEvent,
  setTextContent,
  validatePersonName,
  validateEmail,
  validatePhone,
  validateText,
  SUPPORTED_SERVICES,
  validateService,
  setButtonLoading
} from "./security.js";
import {
  initializeFirebaseClient,
  getFirebaseAuthMethods,
  initializeFirestoreClient,
  getFirestoreMethods
} from "./firebase-config.js";

const statDefinitions = [
  ["Total Requests", "total"],
  ["Pending", "pending"],
  ["Accepted", "accepted"],
  ["Completed", "completed"],
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
  const effectiveUid = user.firebaseUid || user.uid || user.id;
  const workerLookup = (user.workerId && getWorkerById(user.workerId)) || (effectiveUid && getWorkerById(effectiveUid));
  if (workerLookup) {
    return {
      ...workerLookup,
      id: effectiveUid || workerLookup.id,
      workerUid: effectiveUid || workerLookup.id
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
    id: effectiveUid,
    workerUid: effectiveUid,
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

    const completeBtn = document.createElement("button");
    completeBtn.type = "button";
    completeBtn.className = "button primary btn-complete-request";
    completeBtn.dataset.workerAction = "complete";
    completeBtn.dataset.requestId = request.id;
    setTextContent(completeBtn, "Complete Work");

    const chatBtn = document.createElement("button");
    chatBtn.type = "button";
    chatBtn.className = "button subtle btn-chat-request";
    chatBtn.dataset.openWorkerChat = request.id;
    setTextContent(chatBtn, "Chat with Customer");

    actions.append(completeBtn, chatBtn);
    aside.append(actions);
  }

  card.append(main, aside);
  return card;
}

let workerDashboardUnsubscribe = null;
let activeListeningWorkerId = null;

export function stopWorkerDashboardSubscription() {
  const previousWorkerId = activeListeningWorkerId;
  activeListeningWorkerId = null;

  if (typeof workerDashboardUnsubscribe === "function") {
    try {
      workerDashboardUnsubscribe();
    } catch (err) {
      console.warn("[JKFixHub Worker Dashboard] Error stopping listener:", err);
    }
    workerDashboardUnsubscribe = null;
  }

  if (previousWorkerId) {
    unsubscribeWorkerFirestoreRequests(previousWorkerId);
  }
}

function renderWorkerRequestsLoading() {
  const requestsContainer = document.getElementById("workerDashboardRequests");
  if (!requestsContainer) return;
  const loading = document.createElement("div");
  loading.className = "worker-dashboard-loading";
  loading.id = "workerDashboardLoading";
  const spinner = document.createElement("div");
  spinner.className = "spinner";
  spinner.setAttribute("aria-hidden", "true");
  const text = document.createElement("p");
  setTextContent(text, "Connecting to live requests...");
  loading.append(spinner, text);
  requestsContainer.replaceChildren(loading);
}

function renderWorkerRequestsError(err, worker) {
  const requestsContainer = document.getElementById("workerDashboardRequests");
  if (!requestsContainer) return;

  const errorWrap = document.createElement("div");
  errorWrap.className = "worker-dashboard-error";
  errorWrap.id = "workerDashboardError";

  const errorMsg = document.createElement("p");
  errorMsg.id = "workerDashboardErrorMessage";
  const message = err?.code === "permission-denied"
    ? "Session expired or permission denied. Please sign in again."
    : err?.message || "Failed to load live requests. Please check your connection.";
  setTextContent(errorMsg, message);

  const retryBtn = document.createElement("button");
  retryBtn.type = "button";
  retryBtn.className = "button subtle";
  retryBtn.id = "workerDashboardRetryBtn";
  setTextContent(retryBtn, "Retry Connection");
  retryBtn.onclick = () => {
    stopWorkerDashboardSubscription();
    startWorkerDashboardSubscription(worker);
  };

  errorWrap.append(errorMsg, retryBtn);
  requestsContainer.replaceChildren(errorWrap);
}

export function renderWorkerRequestsList(requests, worker) {
  const requestsContainer = document.getElementById("workerDashboardRequests");
  if (!requestsContainer) return;

  const statistics = document.getElementById("workerDashboardStatistics");
  if (statistics) {
    const total = requests.length;
    const pending = requests.filter((r) => r.status === "Pending").length;
    const accepted = requests.filter((r) => r.status === "Accepted").length;
    const completed = requests.filter((r) => r.status === "Completed").length;
    const rejected = requests.filter((r) => r.status === "Rejected").length;
    const stats = {
      total,
      pending,
      accepted,
      completed,
      rejected,
      rating: `${worker?.rating || "5.0"} ★`
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

export function startWorkerDashboardSubscription(worker) {
  if (!worker) return Promise.resolve(() => {});
  const workerUid = worker.workerUid || worker.uid || worker.id;
  if (!workerUid) return Promise.resolve(() => {});

  // Prevent duplicate listeners if already listening or connecting for the same worker
  if (activeListeningWorkerId === workerUid) {
    return Promise.resolve(workerDashboardUnsubscribe || (() => {}));
  }

  stopWorkerDashboardSubscription();
  activeListeningWorkerId = workerUid;

  renderWorkerRequestsLoading();

  return subscribeToWorkerFirestoreRequests(
    workerUid,
    (requests) => {
      if (activeListeningWorkerId !== workerUid) return;
      renderWorkerRequestsList(requests, worker);
    },
    (err) => {
      if (activeListeningWorkerId !== workerUid) return;
      renderWorkerRequestsError(err, worker);
    }
  ).then((unsub) => {
    if (activeListeningWorkerId !== workerUid) {
      if (typeof unsub === "function") unsub();
      return () => {};
    }
    workerDashboardUnsubscribe = unsub;
    return unsub;
  });
}

export async function loadAndRenderWorkerRequests(worker) {
  const requestsContainer = document.getElementById("workerDashboardRequests");
  if (!requestsContainer) return;

  let requests = [];
  try {
    const workerUid = worker.workerUid || worker.uid || worker.id;
    requests = await getWorkerFirestoreRequests(workerUid);
  } catch (err) {
    console.warn("[JKFixHub Worker Dashboard] Requests fetch notice:", err);
  }

  renderWorkerRequestsList(requests, worker);
}

async function handleWorkerRequestAction(requestId, newStatus, worker, actionButton = null) {
  const feedbackEl = document.getElementById("workerDashboardFeedback");

  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    if (feedbackEl) setTextContent(feedbackEl, "Network connection error. Please check your internet connection and try again.");
    return;
  }

  const restoreBtn = actionButton ? setButtonLoading(actionButton, `${newStatus}...`) : () => {};
  if (feedbackEl) setTextContent(feedbackEl, `Updating request to ${newStatus}...`);

  try {
    const workerUid = worker.workerUid || worker.uid || worker.id;
    const res = await updateFirestoreRequestStatus(requestId, newStatus, workerUid);
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
  } finally {
    restoreBtn();
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

  startWorkerDashboardSubscription(worker);

  const reviewsContainer = document.getElementById("workerDashboardReviews");
  if (reviewsContainer) {
    const workerUid = worker.workerUid || worker.uid || worker.id;
    renderWorkerReviews(workerUid, reviewsContainer);
  }

  view.dataset.workerId = String(worker.id);
}

const ALL_DISTRICTS = Object.freeze([
  "Shopian", "Srinagar", "Anantnag", "Pulwama", "Kulgam", "Baramulla", "Budgam",
  "Kupwara", "Ganderbal", "Bandipora", "Jammu", "Kathua", "Udhampur", "Rajouri",
  "Poonch", "Doda", "Ramban", "Kishtwar", "Reasi", "Samba"
]);

function populateProfileOptions() {
  const existingServices = getWorkers().map((worker) => worker.service).filter(Boolean);
  const services = [...new Set([...SUPPORTED_SERVICES, ...existingServices])];
  const existingDistricts = getWorkers().map((worker) => worker.district).filter(Boolean);
  const districts = [...new Set([...ALL_DISTRICTS, ...existingDistricts])];
  const serviceSelect = document.getElementById("editWorkerService");
  const districtSelect = document.getElementById("editWorkerDistrict");

  for (const [select, values] of [[serviceSelect, services], [districtSelect, districts]]) {
    if (!select) continue;
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

let editProfileOrigin = "dashboard";

export function openProfileEditor(origin = "dashboard") {
  editProfileOrigin = typeof origin === "string" ? origin : "dashboard";
  const worker = getActiveWorker();
  if (!worker) return;
  const user = getCurrentUser();

  const form = document.getElementById("workerProfileEditForm");
  if (!form) return;
  form.reset();
  populateProfileOptions();

  const nameInput = document.getElementById("editWorkerName");
  const emailInput = document.getElementById("editWorkerEmail");
  const phoneInput = document.getElementById("editWorkerPhone");
  const serviceInput = document.getElementById("editWorkerService");
  const districtInput = document.getElementById("editWorkerDistrict");
  const expInput = document.getElementById("editWorkerExperience");
  const availInput = document.getElementById("editWorkerAvailability");
  const feedback = document.getElementById("workerProfileEditFeedback");
  const successFeedback = document.getElementById("workerProfileEditSuccessFeedback");

  if (feedback) {
    feedback.hidden = true;
    setTextContent(feedback, "");
  }
  if (successFeedback) {
    successFeedback.hidden = true;
    setTextContent(successFeedback, "");
  }

  form.querySelectorAll("[data-profile-error], .request-error").forEach((error) => {
    setTextContent(error, "");
    error.hidden = true;
  });
  form.querySelectorAll("[aria-invalid]").forEach((field) => field.removeAttribute("aria-invalid"));

  if (nameInput) nameInput.value = worker.name || user?.name || "";
  if (emailInput) emailInput.value = user?.email || "";
  if (phoneInput) phoneInput.value = user?.phone || "";
  if (serviceInput) serviceInput.value = worker.service || user?.service || "";
  if (districtInput) districtInput.value = worker.district || user?.district || "";
  if (expInput) {
    const rawExp = (worker.experience || user?.experience || "").trim();
    const customWrap = document.getElementById("editWorkerCustomExpWrap");
    const customInput = document.getElementById("editWorkerCustomExpInput");
    const customUnit = document.getElementById("editWorkerCustomExpUnit");

    const presetOption = Array.from(expInput.options).find((opt) => opt.value === rawExp);
    if (presetOption && rawExp !== "" && rawExp !== "custom") {
      expInput.value = rawExp;
      if (customWrap) customWrap.hidden = true;
      if (customInput) customInput.value = "";
      if (customUnit) customUnit.textContent = "years";
    } else if (rawExp) {
      expInput.value = "custom";
      if (customWrap) customWrap.hidden = false;
      const num = parseInt(rawExp, 10);
      if (!isNaN(num) && num >= 1) {
        if (customInput) customInput.value = num;
        if (customUnit) customUnit.textContent = num === 1 ? "year" : "years";
      } else {
        if (customInput) customInput.value = "";
        if (customUnit) customUnit.textContent = "years";
      }
    } else {
      expInput.value = "";
      if (customWrap) customWrap.hidden = true;
      if (customInput) customInput.value = "";
      if (customUnit) customUnit.textContent = "years";
    }
  }
  if (availInput) {
    availInput.value = ["Available", "Busy", "Offline"].includes(worker.availability) ? worker.availability : "Busy";
  }

  closeModal("authModal");
  openModal("workerProfileEditModal");
}

async function handleProfileSave(event) {
  event.preventDefault();
  const worker = getActiveWorker();
  if (!worker) return;
  const user = getCurrentUser();

  const form = document.getElementById("workerProfileEditForm");
  const feedback = document.getElementById("workerProfileEditFeedback");
  const successFeedback = document.getElementById("workerProfileEditSuccessFeedback");

  function setFeedback(msg, isErr = true) {
    if (feedback && isErr) {
      setTextContent(feedback, msg);
      feedback.hidden = !msg;
    }
    if (successFeedback && !isErr) {
      setTextContent(successFeedback, msg);
      successFeedback.hidden = !msg;
    }
    if (isErr && successFeedback) successFeedback.hidden = true;
    if (!isErr && feedback) feedback.hidden = true;
  }

  setFeedback("", true);

  const name = document.getElementById("editWorkerName");
  const email = document.getElementById("editWorkerEmail");
  const phone = document.getElementById("editWorkerPhone");
  const service = document.getElementById("editWorkerService");
  const district = document.getElementById("editWorkerDistrict");
  const expSelect = document.getElementById("editWorkerExperience");
  const customExpInput = document.getElementById("editWorkerCustomExpInput");
  const availability = document.getElementById("editWorkerAvailability");

  const nameValid = validatePersonName(name ? name.value : "");
  const emailValid = email ? validateEmail(email.value) : true;
  const phoneValid = phone ? validatePhone(phone.value) : true;
  const serviceValid = service ? (validateService(service.value) || getWorkers().some((item) => item.service === service.value)) : false;
  const districtValid = district ? (ALL_DISTRICTS.includes(district.value) || getWorkers().some((item) => item.district === district.value)) : false;

  let selectedExperience = "";
  let experienceValid = false;
  if (expSelect?.value === "custom") {
    const rawVal = customExpInput?.value ? parseInt(customExpInput.value.trim(), 10) : NaN;
    if (!isNaN(rawVal) && rawVal >= 1 && rawVal <= 70) {
      selectedExperience = `${rawVal} ${rawVal === 1 ? "year" : "years"}`;
      experienceValid = true;
    }
  } else if (expSelect?.value) {
    selectedExperience = expSelect.value.trim();
    experienceValid = /^\d{1,2} years?$/i.test(selectedExperience);
  }

  const availabilityValid = availability && ["Available", "Busy", "Offline"].includes(availability.value);

  setEditError(name, nameValid ? "" : getSafeErrorMessage("invalidName"), document.getElementById("editWorkerNameError"));
  if (email) setEditError(email, emailValid ? "" : getSafeErrorMessage("invalidEmail"), document.getElementById("editWorkerEmailError"));
  if (phone) setEditError(phone, phoneValid ? "" : getSafeErrorMessage("invalidPhone"), document.getElementById("editWorkerPhoneError"));
  setEditError(service, serviceValid ? "" : getSafeErrorMessage("invalidService"), document.getElementById("editWorkerServiceError"));
  setEditError(district, districtValid ? "" : "Choose a valid district.", document.getElementById("editWorkerDistrictError"));
  setEditError(expSelect, experienceValid ? "" : "Choose your experience or enter custom years (1–70).", document.getElementById("editWorkerExperienceError"));
  setEditError(availability, availabilityValid ? "" : "Choose an availability option.", document.getElementById("editWorkerAvailabilityError"));

  if (!nameValid || !emailValid || !phoneValid || !serviceValid || !districtValid || !experienceValid || !availabilityValid) {
    recordSecurityEvent("VALIDATION_FAILURE", "worker");
    if (!nameValid && /[<>]/.test(name?.value || "")) recordSecurityEvent("SUSPICIOUS_INPUT", "worker");
    document.querySelector("#workerProfileEditForm [aria-invalid='true']")?.focus();
    return;
  }

  const trimmedName = name.value.trim();
  const trimmedEmail = email ? email.value.trim() : (user?.email || "");
  const trimmedPhone = phone ? phone.value.trim() : (user?.phone || "");
  const selectedService = service.value;
  const selectedDistrict = district.value;
  const selectedAvailability = availability.value;

  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    setFeedback("Network connection error. Please check your internet connection and try again.", true);
    return;
  }

  const saveBtn = document.getElementById("saveWorkerProfileBtn");
  const restoreBtn = setButtonLoading(saveBtn, "Saving changes...");
  setFeedback("Saving your profile changes...", false);

  try {
    // Firebase auth & firestore sync
    if (user?.authProvider === "firebase" && user.id) {
    try {
      const { auth } = await initializeFirebaseClient();
      const methods = await getFirebaseAuthMethods();

      // Check if email changed
      if (auth?.currentUser && trimmedEmail !== user.email) {
        try {
          if (typeof methods?.verifyBeforeUpdateEmail === "function") {
            await methods.verifyBeforeUpdateEmail(auth.currentUser, trimmedEmail);
          } else if (typeof methods?.updateEmail === "function") {
            await methods.updateEmail(auth.currentUser, trimmedEmail);
          }
        } catch (emailErr) {
          recordSecurityEvent("EMAIL_UPDATE_ERROR", "worker");
          let safeMsg = "Failed to update email address.";
          if (emailErr.code === "auth/requires-recent-login") {
            safeMsg = "Updating your email requires recent authentication. Please sign out and sign in again before changing your email.";
          } else if (emailErr.code === "auth/email-already-in-use") {
            safeMsg = "That email address is already in use by another account.";
          } else if (emailErr.code === "auth/invalid-email") {
            safeMsg = "The email address format is invalid.";
          }
          setFeedback(safeMsg, true);
          return;
        }
      }

      // Update displayName
      if (auth?.currentUser && typeof methods?.updateProfile === "function" && trimmedName !== user.name) {
        try {
          await methods.updateProfile(auth.currentUser, { displayName: trimmedName });
        } catch (nameErr) {
          console.warn("[JKFixHub Worker Dashboard] updateProfile notice:", nameErr?.message || nameErr);
        }
      }

      // Sync Firestore
      try {
        const { db } = await initializeFirestoreClient();
        const firestoreMethods = await getFirestoreMethods();
        if (db && firestoreMethods && typeof firestoreMethods.updateDoc === "function") {
          // 1. users/{uid}: private details (phone, email, name, district)
          const userDocRef = firestoreMethods.doc(db, "users", user.id);
          await firestoreMethods.updateDoc(userDocRef, {
            name: trimmedName,
            email: trimmedEmail,
            phone: trimmedPhone,
            district: selectedDistrict,
            updatedAt: new Date().toISOString()
          });

          // 2. workers/{uid}: public details ONLY (NO phone, NO email! Preserves isVerified and status)
          const workerDocRef = firestoreMethods.doc(db, "workers", user.id);
          await firestoreMethods.updateDoc(workerDocRef, {
            name: trimmedName,
            service: selectedService,
            district: selectedDistrict,
            experience: selectedExperience,
            availability: selectedAvailability,
            updatedAt: new Date().toISOString()
          });
        }
      } catch (firestoreErr) {
        console.warn("[JKFixHub Worker Dashboard] Firestore update error:", firestoreErr?.message || firestoreErr);
        setFeedback("Failed to update profile in database.", true);
        return;
      }
    } catch (firebaseErr) {
      console.warn("[JKFixHub Worker Dashboard] Firebase save notice:", firebaseErr?.message || firebaseErr);
      setFeedback("Failed to save profile changes.", true);
      return;
    }
  }

  // Update in-memory user & worker state
  const updatedUser = {
    ...user,
    name: trimmedName,
    email: trimmedEmail,
    phone: trimmedPhone,
    service: selectedService,
    district: selectedDistrict,
    experience: selectedExperience,
    availability: selectedAvailability
  };
  setCurrentUser(updatedUser);
  saveApplicationProfile(user?.id || worker.id, {
    ...updatedUser,
    role: "worker"
  });

  let updatedWorker = {
    ...worker,
    name: trimmedName,
    service: selectedService,
    district: selectedDistrict,
    experience: selectedExperience,
    availability: selectedAvailability
  };

  try {
    const res = setWorkerDemoProfile(worker.id, {
      name: trimmedName,
      service: selectedService,
      district: selectedDistrict,
      experience: selectedExperience,
      availability: selectedAvailability
    });
    if (res) updatedWorker = res;
  } catch (_) {}

  recordSecurityEvent("PROFILE_UPDATED", "worker");
  closeModal("workerProfileEditModal");
  renderDashboard(updatedWorker);

  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("profile:updated"));
  }

  const feedbackEl = document.getElementById("workerDashboardFeedback");
  if (feedbackEl) setTextContent(feedbackEl, "Worker profile updated successfully.");

  if (editProfileOrigin === "account") {
    openModal("authModal");
  } else {
    openModal("authModal");
    openWorkerDashboard();
  }
  } finally {
    restoreBtn();
  }
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

  const editExpSelect = document.getElementById("editWorkerExperience");
  const editCustomExpWrap = document.getElementById("editWorkerCustomExpWrap");
  const editCustomExpInput = document.getElementById("editWorkerCustomExpInput");
  const editCustomExpUnit = document.getElementById("editWorkerCustomExpUnit");
  const editExpError = document.getElementById("editWorkerExperienceError");

  if (editExpSelect) {
    editExpSelect.addEventListener("change", () => {
      const isCustom = editExpSelect.value === "custom";
      if (editCustomExpWrap) editCustomExpWrap.hidden = !isCustom;
      if (isCustom && editCustomExpInput) editCustomExpInput.focus();
      if (editExpError) setEditError(editExpSelect, "", editExpError);
    });
  }

  if (editCustomExpInput) {
    editCustomExpInput.addEventListener("input", () => {
      const raw = parseInt(editCustomExpInput.value, 10);
      if (editCustomExpUnit) {
        editCustomExpUnit.textContent = raw === 1 ? "year" : "years";
      }
      if (editExpError) setEditError(editExpSelect, "", editExpError);
    });
  }

  document.getElementById("editWorkerProfileButton").addEventListener("click", openProfileEditor);
  form.addEventListener("submit", handleProfileSave);
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

  const authModal = document.getElementById("authModal");
  if (authModal) {
    authModal.addEventListener("modal:close", () => {
      stopWorkerDashboardSubscription();
    });
  }

  view.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    if (target.closest("#authLogoutFromDashboard, #backToAccount")) {
      stopWorkerDashboardSubscription();
    }

    const workerActionButton = target.closest("[data-worker-action]");
    if (workerActionButton) {
      const worker = getActiveWorker();
      if (!worker) return;
      const action = workerActionButton.dataset.workerAction;
      const requestId = workerActionButton.dataset.requestId;
      if (!requestId || !action) return;

      const newStatus = action === "accept"
        ? "Accepted"
        : action === "reject"
        ? "Rejected"
        : action === "complete"
        ? "Completed"
        : null;
      if (!newStatus) return;

      workerActionButton.disabled = true;
      const parent = workerActionButton.closest(".dashboard-request-actions");
      if (parent) {
        parent.querySelectorAll("button").forEach((btn) => { btn.disabled = true; });
      }

      handleWorkerRequestAction(requestId, newStatus, worker, workerActionButton);
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
      if (worker && requestId) {
        completeButton.disabled = true;
        handleWorkerRequestAction(requestId, "Completed", worker, completeButton);
      }
    }
  });
}
