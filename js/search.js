import { getWorkers } from "./store.js";
import { setTextContent } from "./security.js";

// ==========================================
// #SEARCH_LOGIC
// ==========================================
function getSearchableText(worker) {
  return [
    worker.name,
    worker.service,
    worker.district,
    worker.services,
    worker.experience,
    worker.availability,
    worker.about,
    worker.initials
  ].filter(Boolean).join(" ").toLowerCase();
}

function getRelevance(worker, keyword) {
  if (!keyword) return 0;
  const fields = [worker.name, worker.service, worker.district]
    .filter(Boolean)
    .map((value) => value.toLowerCase());

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
  setTextContent(service, worker.service);
  badge.className = "demo-badge";
  badge.textContent = "Sample profile";
  identity.append(name, service, badge);
  top.append(avatar, identity);

  metadata.className = "worker-meta";
  setTextContent(district, worker.district);
  setTextContent(rating, `${worker.rating} ★`);
  availability.className = "availability";
  availabilityIcon.setAttribute("aria-hidden", "true");
  setTextContent(availability, worker.availability);
  availability.prepend(availabilityIcon);
  setTextContent(experience, worker.experience);
  metadata.append(district, rating, availability, experience);

  actions.className = "worker-actions";
  profileButton.className = "button subtle";
  profileButton.type = "button";
  profileButton.dataset.profile = String(worker.id);
  profileButton.textContent = "View Profile";
  requestButton.className = "button primary";
  requestButton.type = "button";
  requestButton.dataset.requestWorker = String(worker.id);
  requestButton.textContent = "Request";
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

  function renderResults(matchingWorkers) {
    if (matchingWorkers.length) {
      results.replaceChildren(...matchingWorkers.map(buildWorkerCard));
    } else {
      const emptyState = document.createElement("div");
      const heading = document.createElement("h3");
      const message = document.createElement("p");
      const clearButton = document.createElement("button");

      emptyState.className = "empty-state";
      setTextContent(heading, "No workers found");
      setTextContent(message, "Try changing your service, district, or search keyword.");
      clearButton.className = "button subtle";
      clearButton.type = "button";
      clearButton.dataset.clearFilters = "";
      setTextContent(clearButton, "Clear Filters");
      emptyState.append(heading, message, clearButton);
      results.replaceChildren(emptyState);
    }

    if (feedback) {
      const count = matchingWorkers.length;
      setTextContent(feedback, count === 0
        ? "No workers found"
        : `${count} worker${count === 1 ? "" : "s"} found`);
    }
  }

  function getMatchingWorkers() {
    const service = serviceFilter?.value || "";
    const district = districtFilter?.value || "";
    const keyword = keywordInput?.value.trim().toLowerCase() || "";
    const terms = keyword.split(/\s+/).filter(Boolean);

    return getWorkers()
      .filter((worker) => {
        if (service && worker.service !== service) return false;
        if (district && worker.district !== district) return false;
        if (!terms.length) return true;
        const searchableText = getSearchableText(worker);
        return terms.every((term) => searchableText.includes(term));
      })
      .sort((first, second) => {
        const availabilityDifference =
          Number(second.availability === "Available") - Number(first.availability === "Available");
        if (availabilityDifference) return availabilityDifference;

        const ratingDifference = Number(second.rating) - Number(first.rating);
        if (ratingDifference) return ratingDifference;

        const relevanceDifference =
          getRelevance(second, keyword) - getRelevance(first, keyword);
        if (relevanceDifference) return relevanceDifference;

        return Number(first.id) - Number(second.id);
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

    const serviceButton = target.closest("[data-service]");
    if (!serviceButton) return;

    if (serviceFilter) serviceFilter.value = serviceButton.dataset.service;
    const workerSection = document.getElementById("find-worker");
    if (workerSection) workerSection.scrollIntoView({ behavior: "smooth" });
    if (showToast) showToast("Service selected");
    updateResults();
  });

  renderResults(getMatchingWorkers());
}
