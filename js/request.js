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
  createCustomerRequest,
  getCurrentUser,
  getCurrentRequest,
  getUserRole,
  getSelectedWorker,
  getWorkerById,
  setCurrentRequest,
  setSelectedWorker
} from "./store.js";
import { refreshCustomerRequestSummary } from "./customer-requests.js";
import {
  getSafeErrorMessage,
  recordSecurityEvent,
  setTextContent,
  validateDescription,
  validateLocation,
  validatePersonName
} from "./security.js";

const markupPattern = /<\s*\/?\s*[a-z!][^>]*>/i;

function setFieldError(field, message, errorElement) {
  setTextContent(errorElement, message);
  errorElement.hidden = !message;
  field.setAttribute("aria-invalid", String(Boolean(message)));
}

function resetRequestForm(form) {
  form.reset();
  form.hidden = false;
  clearRequestState();
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
  formView.hidden = true;
  success.hidden = false;
  modal.setAttribute("aria-labelledby", "requestSuccessTitle");
  document.getElementById("requestDone").focus();
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
    resetRequestForm(form);
    setSelectedWorker(worker.id);
    const selectedWorker = getSelectedWorker();
    document.getElementById("requestService").value = selectedWorker.service;
    renderSelectedWorker(selectedWorker);
    openModal("requestModal");
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();

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
    const validService = Boolean(worker && serviceValue === worker.service);
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

    const request = {
      customerId: getUserRole() === "customer" ? getCurrentUser()?.id || null : null,
      workerId: worker.id,
      workerName: worker.name,
      service: serviceValue,
      district: worker.district,
      customerName: nameValue,
      description: descriptionValue,
      location: locationValue,
      preferredTime: preferredTimeValue,
      submittedAt: new Date().toISOString()
    };

    setCurrentRequest(request);
    const submittedRequest = getCurrentRequest();
    if (getUserRole() === "customer") {
      createCustomerRequest(submittedRequest);
      refreshCustomerRequestSummary();
    }
    showRequestSuccess(submittedRequest);
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
