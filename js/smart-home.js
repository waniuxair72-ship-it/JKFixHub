// ==========================================
// #SMART_HOME_LOGIC
// ==========================================

// Role-Based Smart Home for authenticated customers and workers.
// Preserves existing public hero and navigation structure for unauthenticated users.

import {
  getCurrentUser,
  getUserRole,
  isAuthenticated,
  isCustomer,
  isWorker,
  getWorkerById,
  getCustomerRequests,
  getWorkerCustomerRequests,
  setWorkerDemoProfile,
  setCurrentUser,
  saveApplicationProfile,
  setStoredCustomerRequests
} from "./store.js";
import { openCustomerRequests, syncCustomerRequestsFromFirestore } from "./customer-requests.js";
import { openWorkerDashboard, openProfileEditor } from "./worker-dashboard.js";
import { getWorkerFirestoreRequests } from "./firestore-service.js";
import { openChatForRequest } from "./chat.js";
import { openModal } from "./modals.js";
import { setView } from "./navigation.js";
import { setTextContent } from "./security.js";
import { initializeFirestoreClient, getFirestoreMethods } from "./firebase-config.js";

let initialized = false;
let isCustomerSyncing = false;
let isWorkerSyncing = false;

/**
 * Updates the availability indicator color and accessible state.
 */
function updateWorkerAvailUI(status) {
  const indicator = document.getElementById("workerHomeAvailIndicator");
  const select = document.getElementById("workerHomeAvailability");
  if (!indicator || !select) return;

  indicator.classList.remove("avail-available", "avail-busy", "avail-offline");
  if (status === "Available") {
    indicator.classList.add("avail-available");
  } else if (status === "Busy") {
    indicator.classList.add("avail-busy");
  } else {
    indicator.classList.add("avail-offline");
  }
}

/**
 * Populates and updates the authenticated Customer Smart Home view.
 */
export function renderCustomerHome(user, options = {}) {
  if (typeof document === "undefined") return;
  const homeWrapper = document.getElementById("customerHomeWrapper");
  if (!homeWrapper) return;

  const nameEl = document.getElementById("customerHomeName");
  const districtEl = document.getElementById("customerHomeDistrict");
  const requestsBadge = document.getElementById("customerRequestsBadge");
  const requestsDesc = document.getElementById("customerRequestsDesc");
  const chatsBadge = document.getElementById("customerChatsBadge");
  const chatsDesc = document.getElementById("customerChatsDesc");

  const displayName = user?.name ? user.name.split(" ")[0] : "Customer";
  if (nameEl) setTextContent(nameEl, displayName);
  if (districtEl) setTextContent(districtEl, user?.district || "Jammu & Kashmir");

  // Query actual customer requests
  let requests = [];
  let requestLoadError = false;
  try {
    if (isCustomer()) {
      requests = getCustomerRequests();
    }
  } catch (err) {
    console.warn("[JKFixHub Smart Home] Error getting customer requests:", err);
    requests = [];
    requestLoadError = true;
  }

  const total = requests.length;
  const pending = requests.filter((r) => r.status === "Pending").length;
  const accepted = requests.filter((r) => r.status === "Accepted").length;

  if (requestsBadge) {
    if (requestLoadError) {
      setTextContent(requestsBadge, "Unavailable");
    } else {
      setTextContent(requestsBadge, `${total} Request${total === 1 ? "" : "s"}`);
    }
  }
  if (requestsDesc) {
    if (requestLoadError) {
      setTextContent(requestsDesc, "Unable to load requests right now. Tap to refresh your requests.");
    } else if (total === 0) {
      setTextContent(requestsDesc, "No active requests yet. Search below to request a local specialist.");
    } else {
      const parts = [];
      if (pending > 0) parts.push(`${pending} pending`);
      if (accepted > 0) parts.push(`${accepted} accepted`);
      const details = parts.length > 0 ? ` (${parts.join(", ")})` : "";
      setTextContent(requestsDesc, `You have ${total} service request${total === 1 ? "" : "s"}${details}.`);
    }
  }

  // Chats status based on actual accepted requests
  const acceptedRequests = requests.filter((r) => r.status === "Accepted");
  if (chatsBadge) {
    if (requestLoadError) {
      setTextContent(chatsBadge, "Chats");
    } else if (acceptedRequests.length > 0) {
      setTextContent(chatsBadge, `${acceptedRequests.length} Active Chat${acceptedRequests.length === 1 ? "" : "s"}`);
    } else {
      setTextContent(chatsBadge, "Private Messaging");
    }
  }
  if (chatsDesc) {
    if (requestLoadError) {
      setTextContent(chatsDesc, "Unable to load active chats right now.");
    } else if (acceptedRequests.length > 0) {
      setTextContent(
        chatsDesc,
        `You have ${acceptedRequests.length} active conversation${acceptedRequests.length === 1 ? "" : "s"} with assigned specialists.`
      );
    } else {
      setTextContent(chatsDesc, "Private chat opens automatically once a specialist accepts your service request.");
    }
  }

  // Background Firestore sync for live authenticated customer
  if (!options?.skipSync && !isCustomerSyncing && user?.authProvider === "firebase" && user?.id) {
    isCustomerSyncing = true;
    syncCustomerRequestsFromFirestore()
      .then((syncedRequests) => {
        if (Array.isArray(syncedRequests)) {
          renderCustomerHome(user, { skipSync: true });
        }
      })
      .catch((err) => {
        console.warn("[JKFixHub Smart Home] Background customer request sync notice:", err);
      })
      .finally(() => {
        isCustomerSyncing = false;
      });
  }
}

/**
 * Populates and updates the authenticated Worker Smart Home view.
 */
export function renderWorkerHome(user, options = {}) {
  if (typeof document === "undefined") return;
  const homeWrapper = document.getElementById("workerHomeWrapper");
  if (!homeWrapper) return;

  const nameEl = document.getElementById("workerHomeName");
  const districtEl = document.getElementById("workerHomeDistrict");
  const serviceEl = document.getElementById("workerHomeService");
  const ratingEl = document.getElementById("workerHomeRating");
  const verificationEl = document.getElementById("workerHomeVerification");
  const expBadge = document.getElementById("workerProfileExpBadge");
  const availSelect = document.getElementById("workerHomeAvailability");
  const pendingBadge = document.getElementById("workerPendingCountBadge");
  const pendingDesc = document.getElementById("workerPendingDesc");
  const acceptedBadge = document.getElementById("workerAcceptedCountBadge");
  const acceptedDesc = document.getElementById("workerAcceptedDesc");
  const chatsBadge = document.getElementById("workerChatsBadge");
  const chatsDesc = document.getElementById("workerChatsDesc");

  const effectiveUid = user?.firebaseUid || user?.uid || user?.id;
  const workerLookup = (user?.workerId && getWorkerById(user.workerId)) || (effectiveUid && getWorkerById(effectiveUid));
  const worker = workerLookup || user;

  const displayName = worker?.name ? worker.name.split(" ")[0] : (user?.name ? user.name.split(" ")[0] : "Worker");
  if (nameEl) setTextContent(nameEl, displayName);
  if (districtEl) setTextContent(districtEl, worker?.district || user?.district || "Jammu & Kashmir");
  if (serviceEl) setTextContent(serviceEl, worker?.service || user?.service || "Specialist");
  if (ratingEl) setTextContent(ratingEl, `${worker?.rating || user?.rating || "5.0"} ★`);
  if (verificationEl) {
    const isVerified = Boolean(user?.isVerified || worker?.isVerified);
    setTextContent(verificationEl, isVerified ? "Verified worker" : "Pending verification");
    verificationEl.className = isVerified ? "worker-verification-badge verified" : "worker-verification-badge";
  }
  if (expBadge) {
    setTextContent(expBadge, worker?.experience || user?.experience || "Experience");
  }

  // Availability control
  const currentAvail = worker?.availability || user?.availability || "Available";
  const safeAvail = ["Available", "Busy", "Offline"].includes(currentAvail) ? currentAvail : "Available";
  if (availSelect) {
    availSelect.value = safeAvail;
  }
  updateWorkerAvailUI(safeAvail);

  // Query actual worker requests
  let workerRequests = [];
  let workerLoadError = false;
  try {
    if (isWorker()) {
      workerRequests = getWorkerCustomerRequests();
    }
  } catch (err) {
    console.warn("[JKFixHub Smart Home] Error getting worker requests:", err);
    workerRequests = [];
    workerLoadError = true;
  }

  const pending = workerRequests.filter((r) => r.status === "Pending").length;
  const accepted = workerRequests.filter((r) => r.status === "Accepted").length;

  if (pendingBadge) {
    if (workerLoadError) {
      setTextContent(pendingBadge, "Unavailable");
    } else {
      setTextContent(pendingBadge, `${pending} Pending`);
    }
  }
  if (pendingDesc) {
    if (workerLoadError) {
      setTextContent(pendingDesc, "Unable to load incoming requests. Tap to open dashboard.");
    } else if (pending > 0) {
      setTextContent(pendingDesc, `You have ${pending} incoming request${pending === 1 ? "" : "s"} awaiting your review.`);
    } else {
      setTextContent(pendingDesc, "No pending requests at the moment. New client requests will appear here.");
    }
  }

  if (acceptedBadge) {
    if (workerLoadError) {
      setTextContent(acceptedBadge, "Unavailable");
    } else {
      setTextContent(acceptedBadge, `${accepted} Active`);
    }
  }
  if (acceptedDesc) {
    if (workerLoadError) {
      setTextContent(acceptedDesc, "Unable to load active jobs. Tap to open dashboard.");
    } else if (accepted > 0) {
      setTextContent(acceptedDesc, `You have ${accepted} accepted job${accepted === 1 ? "" : "s"} currently in progress.`);
    } else {
      setTextContent(acceptedDesc, "No active jobs in progress. Accept incoming requests to start working.");
    }
  }

  // Chats status for worker
  const acceptedForChat = workerRequests.filter((r) => r.status === "Accepted");
  if (chatsBadge) {
    if (workerLoadError) {
      setTextContent(chatsBadge, "Client Chats");
    } else if (acceptedForChat.length > 0) {
      setTextContent(chatsBadge, `${acceptedForChat.length} Active Chat${acceptedForChat.length === 1 ? "" : "s"}`);
    } else {
      setTextContent(chatsBadge, "Client Messages");
    }
  }
  if (chatsDesc) {
    if (workerLoadError) {
      setTextContent(chatsDesc, "Unable to load client chats right now.");
    } else if (acceptedForChat.length > 0) {
      setTextContent(
        chatsDesc,
        `Coordinate timing, location, and pricing across ${acceptedForChat.length} active client conversation${acceptedForChat.length === 1 ? "" : "s"}.`
      );
    } else {
      setTextContent(chatsDesc, "Direct client messaging becomes active once you accept an incoming service request.");
    }
  }

  // Background Firestore sync for live authenticated worker
  const workerUid = user?.workerId || user?.firebaseUid || user?.uid || user?.id;
  if (!options?.skipSync && !isWorkerSyncing && user?.authProvider === "firebase" && workerUid) {
    isWorkerSyncing = true;
    getWorkerFirestoreRequests(workerUid)
      .then((syncedRequests) => {
        if (Array.isArray(syncedRequests)) {
          setStoredCustomerRequests(syncedRequests);
          renderWorkerHome(user, { skipSync: true });
        }
      })
      .catch((err) => {
        console.warn("[JKFixHub Smart Home] Background worker request sync notice:", err);
      })
      .finally(() => {
        isWorkerSyncing = false;
      });
  }
}

/**
 * Determines and renders the appropriate role-based home screen.
 * Restores seamlessly on login, logout, and page refresh.
 */
export function updateRoleBasedHome() {
  if (typeof document === "undefined") return;

  const publicHero = document.getElementById("publicHeroWrapper");
  const customerHome = document.getElementById("customerHomeWrapper");
  const workerHome = document.getElementById("workerHomeWrapper");

  if (!publicHero || !customerHome || !workerHome) return;

  const user = getCurrentUser();
  const role = getUserRole();
  const authed = isAuthenticated();

  // Navigation Drawer: remove redundant actions for authenticated users
  const joinWorkerDrawerBtns = document.querySelectorAll('.nav-drawer-actions [data-jk-action="join-worker"]');
  joinWorkerDrawerBtns.forEach((btn) => {
    btn.hidden = authed;
  });

  const signInDrawerBtns = document.querySelectorAll('.nav-drawer-actions [data-jk-action="sign-in"]');
  signInDrawerBtns.forEach((btn) => {
    btn.hidden = authed;
  });

  if (!authed || role === "admin") {
    publicHero.hidden = false;
    customerHome.hidden = true;
    workerHome.hidden = true;
    return;
  }

  if (role === "customer") {
    publicHero.hidden = true;
    workerHome.hidden = true;
    customerHome.hidden = false;
    renderCustomerHome(user);
    return;
  }

  if (role === "worker") {
    publicHero.hidden = true;
    customerHome.hidden = true;
    workerHome.hidden = false;
    renderWorkerHome(user);
    return;
  }
}

/**
 * Initializes smart home interactive event listeners and routing.
 */
export function initializeSmartHome() {
  if (typeof document === "undefined" || initialized) return;
  initialized = true;

  // 1. Customer Search Form submission
  const customerSearchForm = document.getElementById("customerHomeSearchForm");
  if (customerSearchForm) {
    customerSearchForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const input = document.getElementById("customerHomeSearchInput");
      const query = input?.value?.trim() || "";
      const searchKeyword = document.getElementById("keyword");
      if (searchKeyword && query) {
        searchKeyword.value = query;
        searchKeyword.dispatchEvent(new Event("input", { bubbles: true }));
      }
      setView("search");
    });
  }

  // 2. Customer "View All Services" link
  const browseServicesBtn = document.getElementById("customerBrowseAllServicesBtn");
  if (browseServicesBtn) {
    browseServicesBtn.addEventListener("click", () => {
      setView("search");
    });
  }

  // 3. Customer Service Category buttons
  const categoryCards = document.querySelectorAll(".smart-categories-grid .smart-category-card");
  categoryCards.forEach((btn) => {
    btn.addEventListener("click", () => {
      const service = btn.getAttribute("data-service");
      const serviceSelect = document.getElementById("serviceFilter");
      if (serviceSelect && service) {
        serviceSelect.value = service;
        serviceSelect.dispatchEvent(new Event("change", { bubbles: true }));
      }
      setView("search");
    });
  });

  // 4. Customer My Requests button
  const customerRequestsBtn = document.getElementById("customerHomeMyRequestsBtn");
  if (customerRequestsBtn) {
    customerRequestsBtn.addEventListener("click", () => {
      openCustomerRequests();
    });
  }

  // 5. Customer My Chats button
  const customerChatsBtn = document.getElementById("customerHomeMyChatsBtn");
  if (customerChatsBtn) {
    customerChatsBtn.addEventListener("click", () => {
      let requests = [];
      try {
        if (isCustomer()) requests = getCustomerRequests();
      } catch (_) {}

      const accepted = requests.filter((r) => r.status === "Accepted");
      if (accepted.length > 0) {
        openChatForRequest(accepted[0].id);
      } else {
        openCustomerRequests();
      }
    });
  }

  // 6. Worker Incoming Requests button
  const workerPendingBtn = document.getElementById("workerHomePendingBtn");
  if (workerPendingBtn) {
    workerPendingBtn.addEventListener("click", () => {
      if (openWorkerDashboard()) openModal("authModal");
    });
  }

  // 7. Worker Accepted Jobs button
  const workerAcceptedBtn = document.getElementById("workerHomeAcceptedBtn");
  if (workerAcceptedBtn) {
    workerAcceptedBtn.addEventListener("click", () => {
      if (openWorkerDashboard()) openModal("authModal");
    });
  }

  // 8. Worker My Chats button
  const workerChatsBtn = document.getElementById("workerHomeChatsBtn");
  if (workerChatsBtn) {
    workerChatsBtn.addEventListener("click", () => {
      let workerRequests = [];
      try {
        if (isWorker()) workerRequests = getWorkerCustomerRequests();
      } catch (_) {}

      const accepted = workerRequests.filter((r) => r.status === "Accepted");
      if (accepted.length > 0) {
        openChatForRequest(accepted[0].id);
      } else {
        if (openWorkerDashboard()) openModal("authModal");
      }
    });
  }

  // 9. Worker Profile button
  const workerProfileBtn = document.getElementById("workerHomeProfileBtn");
  if (workerProfileBtn) {
    workerProfileBtn.addEventListener("click", () => {
      openProfileEditor("home");
      openModal("workerProfileEditModal");
    });
  }

  // 10. Worker Availability control change listener
  const workerAvailSelect = document.getElementById("workerHomeAvailability");
  if (workerAvailSelect) {
    workerAvailSelect.addEventListener("change", async (e) => {
      const newAvail = e.currentTarget.value;
      const user = getCurrentUser();
      if (!user || user.role !== "worker") return;

      const effectiveUid = user.firebaseUid || user.uid || user.id;
      const workerLookup = (user.workerId && getWorkerById(user.workerId)) || (effectiveUid && getWorkerById(effectiveUid));
      const workerId = workerLookup?.id || effectiveUid;

      if (workerId) {
        try {
          setWorkerDemoProfile(workerId, { availability: newAvail });
        } catch (_) {}
      }

      const updatedUser = { ...user, availability: newAvail };
      setCurrentUser(updatedUser);
      updateWorkerAvailUI(newAvail);

      const dashSelect = document.getElementById("workerDashboardAvailability");
      if (dashSelect) dashSelect.value = newAvail;

      if (user.id) {
        try {
          saveApplicationProfile(user.id, { ...updatedUser, role: "worker" });
        } catch (_) {}
      }

      // Background Firestore update for live Firebase authenticated workers
      if (user?.authProvider === "firebase" && user.id) {
        try {
          const { db } = await initializeFirestoreClient();
          const firestoreMethods = await getFirestoreMethods();
          if (db && firestoreMethods && typeof firestoreMethods.updateDoc === "function") {
            const workerDocRef = firestoreMethods.doc(db, "workers", user.id);
            await firestoreMethods.updateDoc(workerDocRef, {
              availability: newAvail,
              updatedAt: new Date().toISOString()
            });
          }
        } catch (err) {
          console.warn("[JKFixHub Smart Home] Background availability update notice:", err);
        }
      }
    });
  }

  // Sync initial smart home state
  updateRoleBasedHome();
}

