// ==========================================
// #REQUEST_FLOW
// ==========================================

// Handles the frontend-only service request
// journey for the JKFixHub prototype.
//
// Real Firebase request handling will be
// connected in a future development stage.
import { closeModal, openModal } from "./modals.js";
import {
  clearRequestState,
  getCurrentUser,
  getCurrentRequest,
  getUserRole,
  getSelectedWorker,
  getWorkerById,
  setCurrentRequest,
  setSelectedWorker,
  upsertStoredCustomerRequest
} from "./store.js";
import {
  createFirestoreServiceRequest,
  subscribeToFirestoreRequest
} from "./firestore-service.js";
import { refreshCustomerRequestSummary } from "./customer-requests.js";
import {
  getSafeErrorMessage,
  recordSecurityEvent,
  setTextContent,
  validateDescription,
  validateLocation,
  validatePersonName,
  workerMatchesService,
  areServicesEquivalent,
  normalizeService
} from "./security.js";

const markupPattern = /<\s*\/?\s*[a-z!][^>]*>/i;

let requestSuccessUnsubscribe = null;
let listeningRequestId = null;

export function stopRequestSuccessSubscription() {
  if (typeof requestSuccessUnsubscribe === "function") {
    try {
      requestSuccessUnsubscribe();
    } catch {}
    requestSuccessUnsubscribe = null;
  }
  listeningRequestId = null;
}

function startRequestSuccessSubscription(requestId) {
  stopRequestSuccessSubscription();
  if (!requestId) return;

  listeningRequestId = requestId;

  subscribeToFirestoreRequest(requestId, (updatedRequest) => {
    if (!updatedRequest || !updatedRequest.status) return;
    if (listeningRequestId !== requestId && listeningRequestId !== updatedRequest.id) return;

    // Update in-memory store and drawer counts
    upsertStoredCustomerRequest(updatedRequest);
    refreshCustomerRequestSummary();

    const statusEl = document.getElementById("requestSuccessStatus");
    const tagEl = document.getElementById("requestSuccessTag");
    const noteEl = document.querySelector("#requestSuccess .request-prototype-note");

    const status = updatedRequest.status;

    if (statusEl) {
      setTextContent(statusEl, status);
      statusEl.className = `dashboard-request-status status-${status.toLowerCase()}`;
    }

    if (tagEl) {
      if (status === "Accepted") {
        setTextContent(tagEl, "Request Accepted");
      } else if (status === "Rejected") {
        setTextContent(tagEl, "Request Rejected");
      } else {
        setTextContent(tagEl, "Request Sent");
      }
    }

    if (noteEl) {
      if (status === "Accepted") {
        setTextContent(noteEl, "The professional has accepted your request. You can monitor details under My Requests.");
      } else if (status === "Rejected") {
        setTextContent(noteEl, "The professional is unavailable and declined this request.");
      }
    }

    const chatBtn = document.getElementById("requestSuccessChatBtn");
    if (chatBtn) {
      if (status === "Accepted") {
        chatBtn.hidden = false;
        chatBtn.dataset.openCustomerChat = updatedRequest.id;
      } else {
        chatBtn.hidden = true;
      }
    }
  }).then((unsub) => {
    if (typeof document === "undefined" || !document?.getElementById) {
      if (typeof unsub === "function") unsub();
      return;
    }
    const modal = document.getElementById("requestModal");
    if (!modal || !modal.classList.contains("open") || listeningRequestId !== requestId) {
      if (typeof unsub === "function") unsub();
      return;
    }
    requestSuccessUnsubscribe = unsub;
  });
}

let isSubmitting = false;
let savedDraft = null;

function setRequestFeedback(message, isError = true, showAuthActions = false) {
  const feedback = document.getElementById("requestFeedback");
  if (!feedback) return;

  const msgSpan = document.getElementById("requestFeedbackMessage");
  const actionsEl = document.getElementById("requestAuthPromptActions");

  if (!message) {
    feedback.hidden = true;
    if (msgSpan) setTextContent(msgSpan, "");
    else setTextContent(feedback, "");
    if (actionsEl) actionsEl.hidden = true;
    return;
  }

  feedback.className = isError ? "auth-feedback" : "auth-success-feedback";
  feedback.hidden = false;

  if (msgSpan) {
    setTextContent(msgSpan, message);
  } else {
    setTextContent(feedback, message);
  }

  if (actionsEl) {
    actionsEl.hidden = !showAuthActions;
  }
}

function setFieldError(field, message, errorElement) {
  setTextContent(errorElement, message);
  errorElement.hidden = !message;
  field.setAttribute("aria-invalid", String(Boolean(message)));
}

function resetRequestForm(form, preserveDraft = false) {
  stopRequestSuccessSubscription();
  form.reset();
  form.hidden = false;
  clearRequestState();
  if (!preserveDraft) {
    savedDraft = null;
  }
  isSubmitting = false;
  setRequestFeedback("");
  const submitBtn = form.querySelector('button[type="submit"]');
  if (submitBtn) {
    submitBtn.disabled = false;
    setTextContent(submitBtn, "Send Request");
  }
  const chatBtn = document.getElementById("requestSuccessChatBtn");
  if (chatBtn) chatBtn.hidden = true;
  document.getElementById("requestFormView").hidden = false;
  document.getElementById("requestSuccess").hidden = true;
  document.getElementById("requestModal").querySelector(".modal").setAttribute("aria-labelledby", "requestTitle");
  document.getElementById("requestWorker").replaceChildren();
  form.querySelectorAll("[data-request-error]").forEach((error) => {
    setTextContent(error, "");
    error.hidden = true;
  });
  form.querySelectorAll("[aria-invalid]").forEach((field) => {
    field.removeAttribute("aria-invalid");
  });
}

function renderSelectedWorker(worker) {
  const container = document.getElementById("requestWorker");
  const avatar = document.createElement("div");
  const details = document.createElement("div");
  const name = document.createElement("strong");
  const service = document.createElement("span");
  const districtRating = document.createElement("span");

  container.replaceChildren();
  container.className = "request-worker";
  avatar.className = "avatar";
  setTextContent(avatar, worker.initials);
  details.className = "request-worker-details";
  setTextContent(name, worker.name);
  setTextContent(service, worker.service);
  setTextContent(districtRating, `${worker.district} · ${worker.rating} ★`);
  details.append(name, service, districtRating);
  container.append(avatar, details);
}

function showRequestSuccess(request) {
  const form = document.getElementById("requestForm");
  const formView = document.getElementById("requestFormView");
  const success = document.getElementById("requestSuccess");
  const modal = document.querySelector("#requestModal .modal");
  setTextContent(document.getElementById("requestSuccessWorker"), request.workerName);
  setTextContent(document.getElementById("requestSuccessService"), request.service);
  setTextContent(document.getElementById("requestSuccessDistrict"), request.district);

  const status = request.status || "Pending";
  const statusEl = document.getElementById("requestSuccessStatus");
  if (statusEl) {
    setTextContent(statusEl, status);
    statusEl.className = `dashboard-request-status status-${status.toLowerCase()}`;
  }

  const tagEl = document.getElementById("requestSuccessTag");
  if (tagEl) {
    if (status === "Accepted") {
      setTextContent(tagEl, "Request Accepted");
    } else if (status === "Rejected") {
      setTextContent(tagEl, "Request Rejected");
    } else {
      setTextContent(tagEl, "Request Sent");
    }
  }

  formView.hidden = true;
  success.hidden = false;
  modal.setAttribute("aria-labelledby", "requestSuccessTitle");
  document.getElementById("requestDone").focus();

  const reqId = request.requestId || request.id;
  if (reqId && status === "Pending") {
    startRequestSuccessSubscription(reqId);
  }
}

export function initializeRequestFlow() {
  const form = document.getElementById("requestForm");
  const requestModal = document.getElementById("requestModal");
  if (!form || !requestModal) return;

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const trigger = target.closest("[data-request-worker]");
    if (!trigger) return;

    const worker = getWorkerById(trigger.dataset.requestWorker);
    if (!worker) {
      recordSecurityEvent("INVALID_REQUEST", getUserRole());
      resetRequestForm(form);
      return;
    }

    closeModal("profileModal");
    resetRequestForm(form, true);
    setSelectedWorker(worker.id);
    const selectedWorker = getSelectedWorker();
    const requestServiceSelect = document.getElementById("requestService");
    if (requestServiceSelect && selectedWorker) {
      const normWorkerService = normalizeService(selectedWorker.service).toLowerCase();
      let matched = false;
      for (const opt of requestServiceSelect.options) {
        if (
          opt.value &&
          (
            opt.value === selectedWorker.service ||
            normalizeService(opt.value).toLowerCase() === normWorkerService
          )
        ) {
          requestServiceSelect.value = opt.value;
          matched = true;
          break;
        }
      }
      if (!matched && selectedWorker.service) {
        requestServiceSelect.value = selectedWorker.service;
      }
    }
    renderSelectedWorker(selectedWorker);

    // Prepopulate customer name if signed in
    const currentUser = getCurrentUser();
    if (currentUser && currentUser.name) {
      const nameField = document.getElementById("customerName");
      if (nameField && !nameField.value) {
        nameField.value = currentUser.name;
      }
    }

    if (savedDraft) {
      const descField = document.getElementById("requestDescription");
      const locField = document.getElementById("requestLocation");
      const prefField = document.getElementById("preferredTime");
      if (descField && !descField.value && savedDraft.description) {
        descField.value = savedDraft.description;
      }
      if (locField && !locField.value && savedDraft.location) {
        locField.value = savedDraft.location;
      }
      if (prefField && savedDraft.preferredTime) {
        prefField.value = savedDraft.preferredTime;
      }
    }

    openModal("requestModal");
  });

  const signInPromptBtn = document.getElementById("requestSignInPromptBtn");
  if (signInPromptBtn) {
    signInPromptBtn.addEventListener("click", async () => {
      closeModal("requestModal");
      try {
        const { showSignIn } = await import("./auth.js");
        showSignIn();
      } catch (_) {}
      openModal("authModal");
    });
  }

  const registerPromptBtn = document.getElementById("requestRegisterPromptBtn");
  if (registerPromptBtn) {
    registerPromptBtn.addEventListener("click", async () => {
      closeModal("requestModal");
      try {
        const { showCustomerRegister } = await import("./auth.js");
        showCustomerRegister();
      } catch (_) {}
      openModal("authModal");
    });
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (isSubmitting) return;

    const customerName = document.getElementById("customerName");
    const requestService = document.getElementById("requestService");
    const requestDescription = document.getElementById("requestDescription");
    const requestLocation = document.getElementById("requestLocation");
    const preferredTime = document.getElementById("preferredTime");
    const preferredTimeError = document.getElementById("preferredTimeError");
    const nameError = document.getElementById("customerNameError");
    const descriptionError = document.getElementById("requestDescriptionError");
    const locationError = document.getElementById("requestLocationError");
    const serviceError = document.getElementById("requestServiceError");

    const nameValue = customerName.value.trim();
    const descriptionValue = requestDescription.value.trim();
    const locationValue = requestLocation.value.trim();
    const preferredTimeValue = preferredTime.value;
    const worker = getSelectedWorker();
    const serviceValue = requestService.value.trim();
    const validName = validatePersonName(nameValue);
    const validDescription = validateDescription(descriptionValue) && !markupPattern.test(descriptionValue);
    const validLocation = validateLocation(locationValue) && !markupPattern.test(locationValue);
    const validService = Boolean(
      worker &&
      (
        serviceValue === worker.service ||
        areServicesEquivalent(serviceValue, worker.service) ||
        workerMatchesService(worker, serviceValue)
      )
    );
    const validPreferredTime = ["As soon as possible", "Today", "Tomorrow", "Flexible"].includes(preferredTimeValue);

    setFieldError(customerName, validName ? "" : getSafeErrorMessage("invalidName"), nameError);
    setFieldError(requestDescription, validDescription ? "" : getSafeErrorMessage("invalidDescription"), descriptionError);
    setFieldError(requestLocation, validLocation ? "" : getSafeErrorMessage("invalidLocation"), locationError);
    setFieldError(requestService, validService ? "" : getSafeErrorMessage("invalidService"), serviceError);
    setFieldError(preferredTime, validPreferredTime ? "" : getSafeErrorMessage("invalidRequest"), preferredTimeError);

    if (!validName || !validDescription || !validLocation || !validService || !validPreferredTime || !worker) {
      recordSecurityEvent("VALIDATION_FAILURE", getUserRole());
      if (
        (!validName && /[<>]/.test(nameValue)) ||
        (!validDescription && markupPattern.test(descriptionValue)) ||
        (!validLocation && markupPattern.test(locationValue))
      ) {
        recordSecurityEvent("SUSPICIOUS_INPUT", getUserRole());
      }
      const firstInvalid = form.querySelector('[aria-invalid="true"]');
      if (firstInvalid) firstInvalid.focus();
      return;
    }

    const currentUser = getCurrentUser();
    const customerId = currentUser ? (currentUser.firebaseUid || currentUser.id) : null;
    const isCustomerUser = currentUser && (currentUser.role === "customer" || !currentUser.role);

    if (!currentUser || !customerId) {
      recordSecurityEvent("UNAUTHORIZED_UI_ACTION", null);
      savedDraft = {
        name: nameValue,
        service: serviceValue,
        description: descriptionValue,
        location: locationValue,
        preferredTime: preferredTimeValue,
        workerId: worker.id
      };
      setRequestFeedback(
        "Please sign in or create a customer account to submit your request. Your details have been preserved.",
        true,
        true
      );
      return;
    }

    if (!isCustomerUser) {
      recordSecurityEvent("UNAUTHORIZED_UI_ACTION", currentUser.role);
      setRequestFeedback(
        "Only customer accounts can submit service requests. Please switch to a customer account.",
        true,
        false
      );
      return;
    }

    isSubmitting = true;
    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) {
      submitBtn.disabled = true;
      setTextContent(submitBtn, "Sending Request...");
    }
    setRequestFeedback("");

    const workerUid = worker.workerUid || worker.uid || String(worker.id);
    const createdAt = new Date().toISOString();

    try {
      const result = await createFirestoreServiceRequest({
        customerId,
        customerName: nameValue,
        workerUid,
        workerId: workerUid,
        workerName: worker.name,
        service: serviceValue,
        district: worker.district,
        problemDescription: descriptionValue,
        customerLocation: locationValue,
        preferredTime: preferredTimeValue,
        status: "Pending",
        createdAt
      });

      if (!result || !result.success || !result.request) {
        const errorMsg = result?.error || "Failed to submit request. Please try again.";
        setRequestFeedback(errorMsg, true, false);
        setFieldError(requestDescription, errorMsg, descriptionError);
        return;
      }

      const submittedRequest = {
        ...result.request,
        submittedAt: result.request.submittedAt || result.request.createdAt || createdAt
      };

      savedDraft = null;
      setCurrentRequest(submittedRequest);
      upsertStoredCustomerRequest(submittedRequest);
      refreshCustomerRequestSummary();
      showRequestSuccess(submittedRequest);
    } catch (err) {
      console.error("[JKFixHub Request] Error creating request:", err);
      const errMsg = "Failed to send request. Please try again.";
      setRequestFeedback(errMsg, true, false);
      setFieldError(requestDescription, errMsg, descriptionError);
    } finally {
      isSubmitting = false;
      if (submitBtn) {
        submitBtn.disabled = false;
        setTextContent(submitBtn, "Send Request");
      }
    }
  });

  requestModal.addEventListener("click", (event) => {
    const target = event.target;
    if (target === requestModal || (target instanceof Element && target.closest('[data-close="requestModal"]'))) {
      resetRequestForm(form);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && requestModal.classList.contains("open")) {
      resetRequestForm(form);
    }
  }, true);

}
