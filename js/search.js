import { getWorkers, setDiscoveredWorkers } from "./store.js";
import { getPublicWorkers } from "./firestore-service.js";
import {
  setTextContent,
  workerMatchesService,
  normalizeService,
  areServicesEquivalent
} from "./security.js";

// ==========================================
// #SEARCH_LOGIC
// ==========================================
function getSearchableText(worker) {
  const servicesList = Array.isArray(worker.services)
    ? worker.services.join(" ")
    : (worker.services || "");
  return [
    worker.name,
    worker.service,
    servicesList,
    worker.district,
    worker.experience,
    worker.availability,
    worker.about,
    worker.initials
  ].filter(Boolean).join(" ").toLowerCase();
}

function getRelevance(worker, keyword) {
  if (!keyword) return 0;
  const services = Array.isArray(worker.services)
    ? worker.services
    : (worker.services ? [worker.services] : []);
  const fields = [worker.name, worker.service, ...services, worker.district]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());

  if (fields.some((value) => value === keyword)) return 3;
  if (fields.some((value) => value.startsWith(keyword))) return 2;
  if (fields.some((value) => value.includes(keyword))) return 1;
  return 0;
}

function buildWorkerCard(worker) {
  const card = document.createElement("article");
  const top = document.createElement("div");
  const avatar = document.createElement("div");
  const identity = document.createElement("div");
  const name = document.createElement("h3");
  const service = document.createElement("p");
  const badge = document.createElement("span");
  const metadata = document.createElement("div");
  const district = document.createElement("span");
  const rating = document.createElement("span");
  const availability = document.createElement("span");
  const availabilityIcon = document.createElement("i");
  const experience = document.createElement("span");
  const actions = document.createElement("div");
  const profileButton = document.createElement("button");
  const requestButton = document.createElement("button");

  card.className = "worker-card";
  top.className = "worker-top";
  avatar.className = "avatar";
  setTextContent(avatar, worker.initials);
  setTextContent(name, worker.name);

  const displayService = Array.isArray(worker.services) && worker.services.length > 1
    ? worker.services.join(" · ")
    : (worker.service || "Local Specialist");
  setTextContent(service, displayService);

  badge.className = worker.isVerified
    ? "worker-verified-badge"
    : worker.isDemo
      ? "demo-badge"
      : "worker-pending-badge";
  badge.textContent = worker.isVerified
    ? "Verified"
    : worker.isDemo
      ? "Sample profile"
      : "Pending Verification";

  identity.append(name, service, badge);
  top.append(avatar, identity);

  metadata.className = "worker-meta";
  setTextContent(district, worker.district);
  setTextContent(rating, worker.rating ? `${worker.rating} ★` : "5.0 ★");
  availability.className = "availability";
  availabilityIcon.setAttribute("aria-hidden", "true");
  setTextContent(availability, worker.availability || "Available");
  availability.prepend(availabilityIcon);
  setTextContent(experience, worker.experience || "Experienced");
  metadata.append(district, rating, availability, experience);

  actions.className = "worker-actions";
  profileButton.className = "button subtle";
  profileButton.type = "button";
  profileButton.dataset.profile = String(worker.id);
  profileButton.textContent = "View Profile";
  requestButton.className = "button primary";
  requestButton.type = "button";
  requestButton.dataset.requestWorker = String(worker.id);
  requestButton.textContent = "Request Service";
  actions.append(profileButton, requestButton);
  card.append(top, metadata, actions);
  return card;
}

export function initializeSearch({ showToast } = {}) {
  const searchForm = document.getElementById("searchForm");
  const searchPanel = document.querySelector(".search-panel");
  const results = document.getElementById("results");
  const feedback = document.getElementById("searchFeedback");
  const serviceFilter = document.getElementById("serviceFilter");
  const districtFilter = document.getElementById("districtFilter");
  const keywordInput = document.getElementById("keyword");
  const locationButton = document.getElementById("locationButton");
  let searchTimer = null;

  if (!searchForm || !results) return;

  function renderLoading() {
    if (feedback) {
      setTextContent(feedback, "Loading verified professionals...");
    }
    const loadingState = document.createElement("div");
    loadingState.className = "search-loading";
    loadingState.setAttribute("role", "status");
    const spinner = document.createElement("div");
    spinner.className = "search-loading-spinner";
    spinner.setAttribute("aria-hidden", "true");
    const message = document.createElement("p");
    setTextContent(message, "Finding verified professionals across Jammu & Kashmir...");
    loadingState.append(spinner, message);
    results.replaceChildren(loadingState);
  }

  function renderError(err) {
    if (feedback) {
      setTextContent(feedback, "Unable to load verified professionals");
    }
    const errorState = document.createElement("div");
    errorState.className = "search-error-state";
    errorState.setAttribute("role", "alert");
    const icon = document.createElement("div");
    icon.className = "search-error-icon";
    icon.setAttribute("aria-hidden", "true");
    setTextContent(icon, "⚠️");
    const heading = document.createElement("h3");
    setTextContent(heading, "Unable to load verified professionals");
    const message = document.createElement("p");
    setTextContent(message, "Could not load worker directory from server. Please check your connection and try again.");
    const retryButton = document.createElement("button");
    retryButton.className = "button primary search-retry-button";
    retryButton.type = "button";
    retryButton.dataset.searchRetry = "";
    setTextContent(retryButton, "Retry Search");
    errorState.append(icon, heading, message, retryButton);
    results.replaceChildren(errorState);
  }

  function renderResults(matchingWorkers) {
    if (matchingWorkers.length > 0) {
      results.replaceChildren(...matchingWorkers.map(buildWorkerCard));
      if (feedback) {
        const count = matchingWorkers.length;
        setTextContent(feedback, `${count} verified professional${count === 1 ? "" : "s"} found`);
      }
      return;
    }

    const allWorkers = getWorkers();
    const emptyState = document.createElement("div");
    const heading = document.createElement("h3");
    const message = document.createElement("p");

    emptyState.className = "empty-state";
    emptyState.setAttribute("role", "status");

    if (allWorkers.length === 0) {
      // Platform-wide zero verified workers registered
      setTextContent(heading, "No verified professionals available");
      setTextContent(message, "There are currently no verified active professionals in the directory. Please check back soon or register as a worker.");
      const joinButton = document.createElement("button");
      joinButton.className = "button subtle";
      joinButton.type = "button";
      joinButton.dataset.jkAction = "join-worker";
      setTextContent(joinButton, "Join as a Worker");
      emptyState.append(heading, message, joinButton);
      if (feedback) {
        setTextContent(feedback, "No verified professionals found");
      }
    } else {
      // Filters active but no workers match
      setTextContent(heading, "No matching workers found");
      setTextContent(message, "Try changing your service, district, or search keyword.");
      const clearButton = document.createElement("button");
      clearButton.className = "button subtle";
      clearButton.type = "button";
      clearButton.dataset.clearFilters = "";
      setTextContent(clearButton, "Clear Filters");
      emptyState.append(heading, message, clearButton);
      if (feedback) {
        setTextContent(feedback, "No workers found matching your criteria");
      }
    }

    results.replaceChildren(emptyState);
  }

  function getMatchingWorkers() {
    const service = serviceFilter?.value || "";
    const district = districtFilter?.value || "";
    const keyword = keywordInput?.value.trim().toLowerCase() || "";
    const terms = keyword.split(/\s+/).filter(Boolean);

    return getWorkers()
      .filter((worker) => {
        if (service && !workerMatchesService(worker, service)) return false;
        if (district && worker.district !== district) return false;
        if (!terms.length) return true;
        const searchableText = getSearchableText(worker);
        return terms.every((term) => searchableText.includes(term));
      })
      .sort((first, second) => {
        const availabilityDifference =
          Number(second.availability === "Available") - Number(first.availability === "Available");
        if (availabilityDifference) return availabilityDifference;

        const ratingDifference = Number(second.rating || 5.0) - Number(first.rating || 5.0);
        if (ratingDifference) return ratingDifference;

        const relevanceDifference =
          getRelevance(second, keyword) - getRelevance(first, keyword);
        if (relevanceDifference) return relevanceDifference;

        return String(first.id).localeCompare(String(second.id));
      });
  }

  function updateResults() {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => renderResults(getMatchingWorkers()), 120);
  }

  function clearFilters() {
    if (serviceFilter) serviceFilter.value = "";
    if (districtFilter) districtFilter.value = "";
    if (keywordInput) keywordInput.value = "";
    renderResults(getMatchingWorkers());
  }

  searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    window.clearTimeout(searchTimer);
    renderResults(getMatchingWorkers());
  });

  serviceFilter?.addEventListener("change", updateResults);
  districtFilter?.addEventListener("change", updateResults);
  keywordInput?.addEventListener("input", updateResults);

  searchPanel?.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    if (target.closest("[data-clear-filters]")) {
      window.clearTimeout(searchTimer);
      clearFilters();
    }

    if (target.closest("[data-search-retry]")) {
      window.clearTimeout(searchTimer);
      fetchLiveWorkers().catch(() => {});
    }
  });

  locationButton?.addEventListener("click", () => {
    const district = getWorkers().find((worker) => worker.district)?.district;
    if (!district || !districtFilter) return;

    districtFilter.value = district;
    window.clearTimeout(searchTimer);
    renderResults(getMatchingWorkers());
    if (showToast) showToast(`Showing workers in ${district}`);
  });

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const serviceTrigger = target.closest("[data-service], [data-service-select]");
    if (!serviceTrigger) return;

    const rawService = serviceTrigger.dataset.service || serviceTrigger.dataset.serviceSelect;
    if (!rawService) return;

    const canonicalService = normalizeService(rawService);
    if (serviceFilter) {
      let optionFound = false;
      for (const option of serviceFilter.options) {
        if (
          option.value === canonicalService ||
          areServicesEquivalent(option.value, rawService) ||
          option.value.toLowerCase() === canonicalService.toLowerCase()
        ) {
          serviceFilter.value = option.value;
          optionFound = true;
          break;
        }
      }
      if (!optionFound) {
        serviceFilter.value = canonicalService;
      }
    }

    const workerSection = document.getElementById("find-worker");
    if (workerSection) workerSection.scrollIntoView({ behavior: "smooth" });
    if (showToast) showToast(`Service filtered: ${serviceFilter?.value || canonicalService}`);
    updateResults();
  });

  async function fetchLiveWorkers() {
    renderLoading();
    try {
      const realWorkers = await getPublicWorkers({ throwOnError: true });
      if (Array.isArray(realWorkers)) {
        setDiscoveredWorkers(realWorkers);
      }
      renderResults(getMatchingWorkers());
      return realWorkers;
    } catch (err) {
      console.warn("[JKFixHub Discovery] Real worker discovery notice:", err?.message || err);
      renderError(err);
      throw err;
    }
  }

  // Initial load
  renderLoading();
  const discoveryPromise = fetchLiveWorkers().catch(() => {});

  return {
    fetchLiveWorkers,
    renderResults,
    getMatchingWorkers,
    discoveryPromise
  };
}
