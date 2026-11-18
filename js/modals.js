// ==========================================
// #MODAL_LOGIC
// ==========================================

// This file contains the modal-related UI logic
// used by the JKFixHub prototype.
//
// Modal behavior is kept separate from the main
// application logic so the project remains easier
// to understand and maintain.
import { getWorkerById, getReviewsForWorker, calculateWorkerRating } from "./store.js";
import {
  getSafeErrorMessage,
  recordSecurityEvent,
  setTextContent,
  validateDescription,
  validatePersonName
} from "./security.js";
import { renderWorkerReviews } from "./reviews.js";
import { createVerifiedWorkerBadge } from "./badges.js";
import { isWorkerOfficiallyVerified } from "./membership-schema.js";

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

  let verificationBadge;
  if (isWorkerOfficiallyVerified(worker)) {
    verificationBadge = createVerifiedWorkerBadge({ fullName: true });
  } else {
    verificationBadge = document.createElement("span");
    verificationBadge.className = worker.isDemo ? "demo-badge" : "worker-pending-badge";
    setTextContent(verificationBadge, worker.isDemo ? "Sample Profile" : "Pending Verification");
  }

  const availabilityBadge = document.createElement("span");
  availabilityBadge.className = "availability";
  const availabilityDot = document.createElement("i");
  availabilityDot.setAttribute("aria-hidden", "true");
  setTextContent(availabilityBadge, worker.availability || "Available");
  availabilityBadge.prepend(availabilityDot);

  // Rating and review count: accurately aggregate from genuine published reviews only
  const workerUid = worker.firebaseUid || worker.workerUid || worker.id;
  const workerReviews = typeof getReviewsForWorker === "function" ? getReviewsForWorker(workerUid) : [];
  const agg = typeof calculateWorkerRating === "function" ? calculateWorkerRating(workerReviews) : null;
  const storedCount = typeof worker.reviewCount === "number" && worker.reviewCount > 0 ? worker.reviewCount : 0;
  const parsedStored = Number(worker.rating);
  const hasStoredGenuine = storedCount > 0 && !Number.isNaN(parsedStored) && parsedStored >= 1 && parsedStored <= 5;

  const formatProfileRatingText = (avgVal, totalCount, vwCount = null, uvCount = null) => {
    const revLabel = `${totalCount} ${totalCount === 1 ? "review" : "reviews"}`;
    if (typeof vwCount === "number" && typeof uvCount === "number") {
      if (vwCount > 0 && uvCount > 0) {
        return `${avgVal.toFixed(1)} ★ (${revLabel} · ${vwCount} Verified Work, ${uvCount} Unverified)`;
      }
      if (vwCount > 0) {
        return `${avgVal.toFixed(1)} ★ (${revLabel} · ${vwCount} Verified Work)`;
      }
      if (uvCount > 0) {
        return `${avgVal.toFixed(1)} ★ (${revLabel} · ${uvCount} Unverified Experience)`;
      }
    }
    return `${avgVal.toFixed(1)} ★ (${revLabel})`;
  };

  let ratingText = "No ratings yet";
  let isNewWorker = true;
  if (agg && agg.reviewCount > 0) {
    ratingText = formatProfileRatingText(agg.average, agg.reviewCount, agg.verifiedWorkCount, agg.unverifiedCount);
    isNewWorker = false;
  } else if (hasStoredGenuine) {
    ratingText = formatProfileRatingText(
      parsedStored,
      storedCount,
      typeof worker.verifiedWorkCount === "number" ? worker.verifiedWorkCount : null,
      typeof worker.unverifiedCount === "number" ? worker.unverifiedCount : null
    );
    isNewWorker = false;
  }

  const newWorkerBadge = document.createElement("span");
  newWorkerBadge.id = "profileNewWorkerBadge";
  newWorkerBadge.className = "worker-new-badge";
  setTextContent(newWorkerBadge, "New Worker");
  newWorkerBadge.hidden = !isNewWorker;

  badgesRow.append(verificationBadge, availabilityBadge, newWorkerBadge);
  identity.append(name, primaryService, badgesRow);
  aside.append(avatar, identity);

  // Profile details
  const details = document.createElement("div");
  details.className = "profile-details";

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
    if (label === "Rating") text.id = "profileRatingValue";
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

  // Two-option review selector ("Did you hire this worker?")
  const reviewSelector = document.createElement("div");
  reviewSelector.className = "profile-review-selector";
  reviewSelector.id = "profileReviewSelector";

  const selectorHeading = document.createElement("strong");
  selectorHeading.className = "profile-review-selector-title";
  setTextContent(selectorHeading, "Did you hire this worker?");

  const selectorHint = document.createElement("p");
  selectorHint.className = "profile-review-selector-hint";
  setTextContent(
    selectorHint,
    "Verified Work reviews are tied to a completed JKFixHub request. General feedback is clearly marked as Unverified Experience."
  );

  const selectorBtns = document.createElement("div");
  selectorBtns.className = "profile-review-selector-actions";

  const hiredYesBtn = document.createElement("button");
  hiredYesBtn.type = "button";
  hiredYesBtn.className = "button primary profile-review-choice-btn";
  hiredYesBtn.dataset.profileReviewChoice = "verified";
  hiredYesBtn.dataset.workerId = String(workerUid);
  setTextContent(hiredYesBtn, "Yes, I completed a service with this worker");

  const hiredNoBtn = document.createElement("button");
  hiredNoBtn.type = "button";
  hiredNoBtn.className = "button subtle profile-review-choice-btn";
  hiredNoBtn.dataset.profileReviewChoice = "unverified";
  hiredNoBtn.dataset.workerId = String(workerUid);
  setTextContent(hiredNoBtn, "No, I want to leave general feedback");

  selectorBtns.append(hiredYesBtn, hiredNoBtn);

  const selectorFeedback = document.createElement("p");
  selectorFeedback.id = "profileReviewSelectorFeedback";
  selectorFeedback.className = "profile-review-selector-feedback";
  selectorFeedback.setAttribute("role", "status");
  selectorFeedback.hidden = true;

  reviewSelector.append(selectorHeading, selectorHint, selectorBtns, selectorFeedback);

  const reviewsList = document.createElement("div");
  reviewsList.className = "profile-reviews-list";
  reviewsSection.append(reviewsTitle, reviewSelector, reviewsList);
  details.append(reviewsSection);

  // Safely render verified & unverified public customer reviews and sync header rating live
  try {
    if (typeof renderWorkerReviews === "function") {
      renderWorkerReviews(workerUid, reviewsList, {
        onSummaryUpdate: (summary) => {
          const ratingEl = document.getElementById("profileRatingValue");
          const newBadgeEl = document.getElementById("profileNewWorkerBadge");
          if (summary && summary.reviewCount > 0) {
            if (ratingEl) {
              setTextContent(
                ratingEl,
                formatProfileRatingText(
                  summary.average,
                  summary.reviewCount,
                  summary.verifiedWorkCount,
                  summary.unverifiedCount
                )
              );
            }
            if (newBadgeEl) newBadgeEl.hidden = true;
          } else {
            if (ratingEl) setTextContent(ratingEl, "No ratings yet");
            if (newBadgeEl) newBadgeEl.hidden = false;
          }
        }
      });
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
