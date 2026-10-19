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
import { renderWorkerReviews } from "./reviews.js";

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
  try {
    modal.dispatchEvent(new CustomEvent("modal:close", { bubbles: true, detail: { id } }));
  } catch (_) {}
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
  if (feature === "Request Service") return "This feature is currently unavailable.";
  if (feature === "Contact") return "This feature isn't available yet.";
  if (feature === "Worker registration") return "Worker registration isn't available yet.";
  if (feature === "Safety controls") return "This feature is currently unavailable.";
  return `${feature} is currently unavailable.`;
}

export function openMaintenanceNotice(feature = "Service requests") {
  const maintenanceTitle = document.getElementById("maintenanceTitle");
  if (maintenanceTitle) {
    maintenanceTitle.textContent = getFeatureTitle(feature);
  }
  openModal("maintenanceModal");
}

export function openWorkerProfile(id) {
  const worker = getWorkerById(id);
  const profileContent = document.getElementById("profileContent");
  if (!worker || !profileContent) return;

  const profile = document.createElement("div");
  profile.className = "profile-grid";

  // Worker identity aside
  const aside = document.createElement("aside");
  aside.className = "profile-aside";

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  setTextContent(avatar, worker.initials || "W");

  const identity = document.createElement("div");
  identity.className = "profile-identity";

  const name = document.createElement("h3");
  name.id = "profileTitle";
  name.className = "profile-name";
  setTextContent(name, worker.name || "Specialist");

  const primaryService = document.createElement("p");
  primaryService.className = "profile-service-text";
  setTextContent(primaryService, worker.service || "Local Specialist");

  const badgesRow = document.createElement("div");
  badgesRow.className = "profile-badges-row";

  const verificationBadge = document.createElement("span");
  verificationBadge.className = worker.isVerified
    ? "worker-verified-badge"
    : worker.isDemo
      ? "demo-badge"
      : "worker-pending-badge";
  setTextContent(
    verificationBadge,
    worker.isVerified
      ? "Verified Professional"
      : worker.isDemo
        ? "Sample Profile"
        : "Pending Verification"
  );

  const availabilityBadge = document.createElement("span");
  availabilityBadge.className = "availability";
  const availabilityDot = document.createElement("i");
  availabilityDot.setAttribute("aria-hidden", "true");
  setTextContent(availabilityBadge, worker.availability || "Available");
  availabilityBadge.prepend(availabilityDot);

  badgesRow.append(verificationBadge, availabilityBadge);
  identity.append(name, primaryService, badgesRow);
  aside.append(avatar, identity);

  // Profile details
  const details = document.createElement("div");
  details.className = "profile-details";

  // Rating and review count: only show what is supported by actual worker data
  let ratingText = "No ratings yet";
  if (worker.rating) {
    const reviewCount = worker.reviewCount ?? worker.reviewsCount;
    if (typeof reviewCount === "number" && reviewCount > 0) {
      ratingText = `${worker.rating} ★ (${reviewCount} ${reviewCount === 1 ? "review" : "reviews"})`;
    } else {
      ratingText = `${worker.rating} ★`;
    }
  }

  const fields = [
    ["District", worker.district || "Jammu & Kashmir"],
    ["Experience", worker.experience || "Experienced"],
    ["Rating", ratingText]
  ];

  // Deduplicate and extract legitimate additional skills
  let specializations = "";
  if (Array.isArray(worker.services)) {
    const primaryNorm = (worker.service || "").trim().toLowerCase();
    const additional = worker.services.filter(
      (s) => typeof s === "string" && s.trim().toLowerCase() !== primaryNorm
    );
    if (additional.length > 0) {
      specializations = additional.join(", ");
    }
  } else if (typeof worker.services === "string" && worker.services.trim()) {
    const primaryNorm = (worker.service || "").trim().toLowerCase();
    if (worker.services.trim().toLowerCase() !== primaryNorm) {
      specializations = worker.services.trim();
    }
  }

  if (specializations) {
    fields.push(["Specializations", specializations]);
  }

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

  // Profile About card
  const about = document.createElement("div");
  about.className = "profile-about";
  const aboutTitle = document.createElement("strong");
  aboutTitle.className = "profile-about-title";
  setTextContent(aboutTitle, "About this professional");
  const aboutText = document.createElement("p");
  aboutText.className = "profile-about-text";
  setTextContent(aboutText, worker.about || "Verified service professional providing trusted repairs in Jammu & Kashmir.");
  about.append(aboutTitle, aboutText);
  details.append(about);

  // Public customer reviews section
  const reviewsSection = document.createElement("div");
  reviewsSection.className = "profile-reviews-section";
  const reviewsTitle = document.createElement("h4");
  reviewsTitle.className = "profile-reviews-title";
  setTextContent(reviewsTitle, "Customer Reviews");
  const reviewsList = document.createElement("div");
  reviewsList.className = "profile-reviews-list";
  reviewsSection.append(reviewsTitle, reviewsList);
  details.append(reviewsSection);

  // Safely render verified public customer reviews
  try {
    if (typeof renderWorkerReviews === "function") {
      renderWorkerReviews(worker.firebaseUid || worker.id, reviewsList);
    }
  } catch (err) {
    console.warn("[JKFixHub Profile] Review mount notice:", err);
  }

  profile.append(aside, details);

  // Modal actions
  const actions = document.createElement("div");
  actions.className = "modal-actions";
  const backButton = document.createElement("button");
  backButton.className = "button subtle";
  backButton.type = "button";
  backButton.dataset.close = "profileModal";
  backButton.textContent = "Back to Results";
  const requestButton = document.createElement("button");
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
      openWorkerProfile(profileButton.dataset.profile);
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
    let pointerStartedOnBackdrop = false;
    modal.addEventListener("pointerdown", (event) => {
      pointerStartedOnBackdrop = event.target === modal;
    });
    modal.addEventListener("click", (event) => {
      if (event.target === modal && pointerStartedOnBackdrop) {
        closeModal(modal.id);
      }
      pointerStartedOnBackdrop = false;
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
      showToast("Profile preview ready");
      openMaintenanceNotice("Worker registration");
    });
  }
}

export { initializeModalHandlers };
