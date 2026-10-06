// ==========================================
// #MODAL_LOGIC
// ==========================================

// This file contains the modal-related UI logic
// used by the JKFixHub prototype.
//
// Modal behavior is kept separate from the main
// application logic so the project remains easier
// to understand and maintain.
import { getWorkerById } from "./store.js";
import {
  getSafeErrorMessage,
  recordSecurityEvent,
  setTextContent,
  validateDescription,
  validatePersonName
} from "./security.js";

function setRegistrationError(field, errorElement, message) {
  setTextContent(errorElement, message);
  errorElement.hidden = !message;
  field.setAttribute("aria-invalid", String(Boolean(message)));
}

export function closeModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
  if (!document.querySelector(".modal-backdrop.open")) {
    document.body.classList.remove("modal-open");
  }
}

export function openModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  const closeButton = modal.querySelector(".close");
  if (closeButton) closeButton.focus();
}

function getFeatureTitle(feature = "Service requests") {
  if (feature === "Request Service") return "Service requests are not connected yet.";
  if (feature === "Contact") return "Contact details are not available yet.";
  if (feature === "Worker registration") return "Worker registration is not connected yet.";
  if (feature === "Safety controls") return "Safety controls are currently in development.";
  return `${feature} is not connected yet.`;
}

export function openMaintenanceNotice(feature = "Service requests") {
  const maintenanceTitle = document.getElementById("maintenanceTitle");
  if (maintenanceTitle) {
    maintenanceTitle.textContent = getFeatureTitle(feature);
  }
  openModal("maintenanceModal");
}

function openWorkerProfile(id) {
  const worker = getWorkerById(id);
  const profileContent = document.getElementById("profileContent");
  if (!worker || !profileContent) return;

  const profile = document.createElement("div");
  const aside = document.createElement("aside");
  const avatar = document.createElement("div");
  const name = document.createElement("h3");
  const service = document.createElement("p");
  const details = document.createElement("div");
  const about = document.createElement("div");
  const aboutTitle = document.createElement("strong");
  const aboutText = document.createElement("p");
  const actions = document.createElement("div");
  const backButton = document.createElement("button");
  const requestButton = document.createElement("button");

  profile.className = "profile-grid";
  aside.className = "profile-aside";
  avatar.className = "avatar";
  setTextContent(avatar, worker.initials);
  name.id = "profileTitle";
  setTextContent(name, worker.name);
  setTextContent(service, worker.service);
  aside.append(avatar, name, service);

  details.className = "profile-details";
  const fields = [
    ["District", worker.district],
    ["Experience", worker.experience],
    ["Rating", `${worker.rating} ★`],
    ["Availability", worker.availability],
    ["Services", worker.services]
  ];
  for (const [label, value] of fields) {
    const row = document.createElement("div");
    const heading = document.createElement("strong");
    const text = document.createElement("span");
    row.className = "detail-row";
    setTextContent(heading, label);
    setTextContent(text, value);
    row.append(heading, text);
    details.append(row);
  }

  about.className = "profile-about";
  setTextContent(aboutTitle, "About this demo profile");
  setTextContent(aboutText, worker.about);
  about.append(aboutTitle, aboutText);
  details.append(about);
  profile.append(aside, details);

  actions.className = "modal-actions";
  backButton.className = "button subtle";
  backButton.type = "button";
  backButton.dataset.close = "profileModal";
  backButton.textContent = "Back to Results";
  requestButton.className = "button primary";
  requestButton.type = "button";
  requestButton.dataset.requestWorker = String(worker.id);
  requestButton.textContent = "Request Service";
  actions.append(backButton, requestButton);
  profileContent.replaceChildren(profile, actions);
  openModal("profileModal");
}

function initializeModalHandlers(showToast) {
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const profileButton = target.closest("[data-profile]");
    if (profileButton) {
      openWorkerProfile(Number(profileButton.dataset.profile));
    }

    const maintenanceTrigger = target.closest("[data-maintenance]");
    if (maintenanceTrigger) {
      openMaintenanceNotice(maintenanceTrigger.dataset.maintenance);
    }

    const registrationTrigger = target.closest("[data-registration]");
    if (registrationTrigger) {
      openModal("registrationModal");
    }

    const closeTrigger = target.closest("[data-close]");
    if (closeTrigger) {
      closeModal(closeTrigger.dataset.close);
    }
  });

  document.querySelectorAll(".modal-backdrop").forEach((modal) => {
    modal.addEventListener("click", (event) => {
      if (event.target === modal) closeModal(modal.id);
    });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      document.querySelectorAll(".modal-backdrop.open").forEach((modal) => closeModal(modal.id));
    }
  });

  const registrationForm = document.getElementById("registrationForm");
  if (registrationForm) {
    registrationForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const name = document.getElementById("registrationName");
      const service = document.getElementById("registrationService");
      const about = document.getElementById("registrationAbout");
      const nameError = document.getElementById("registrationNameError");
      const serviceError = document.getElementById("registrationServiceError");
      const aboutError = document.getElementById("registrationAboutError");
      const validName = validatePersonName(name.value.trim());
      const validService = ["Electrician", "Appliance repair", "Heater repair"].includes(service.value);
      const validAbout = !about.value.trim() || validateDescription(about.value);

      setRegistrationError(name, nameError, validName ? "" : getSafeErrorMessage("invalidName"));
      setRegistrationError(service, serviceError, validService ? "" : getSafeErrorMessage("invalidService"));
      setRegistrationError(about, aboutError, validAbout ? "" : getSafeErrorMessage("invalidDescription"));
      if (!validName || !validService || !validAbout) {
        recordSecurityEvent("VALIDATION_FAILURE");
        if (!validName && /[<>]/.test(name.value)) {
          recordSecurityEvent("SUSPICIOUS_INPUT");
        }
        const firstInvalid = registrationForm.querySelector('[aria-invalid="true"]');
        if (firstInvalid) firstInvalid.focus();
        return;
      }

      closeModal("registrationModal");
      showToast("Prototype profile preview ready");
      openMaintenanceNotice("Worker registration");
    });
  }
}

export { initializeModalHandlers };
