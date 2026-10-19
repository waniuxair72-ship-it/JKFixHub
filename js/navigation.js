// ==========================================
// #NAVIGATION_LOGIC
// ==========================================

// This file contains the navigation-related UI logic
// used by the JKFixHub prototype.
//
// Navigation is kept separate from the main application
// logic so the project remains easier to understand
// and maintain.
import { openModal } from "./modals.js";
import { updateRoleBasedHome } from "./smart-home.js";

export function setView(viewName) {
  const homeView = document.getElementById("homeView");
  const searchView = document.getElementById("searchView");
  if (!homeView || !searchView) return;

  const isSearch = viewName === "search" || viewName === "find-worker";
  homeView.hidden = isSearch;
  searchView.hidden = !isSearch;

  if (!isSearch) {
    try {
      updateRoleBasedHome();
    } catch (_) {}
  }

  if (typeof window !== "undefined") {
    window.scrollTo({ top: 0, behavior: "instant" });
  }
}

export function initializeNavigation() {
  const nav = document.getElementById("nav");
  const menuButton = document.getElementById("menuButton");
  const navLinks = document.getElementById("navLinks");
  const navDrawerClose = document.getElementById("navDrawerClose");
  const header = document.querySelector(".site-header");

  function updateMenuState(isOpen) {
    if (!nav || !menuButton) return;
    nav.classList.toggle("open", isOpen);
    if (header) header.classList.toggle("nav-drawer-open", isOpen);
    menuButton.setAttribute("aria-expanded", String(isOpen));
    menuButton.setAttribute("aria-label", isOpen ? "Close navigation" : "Open navigation");
  }

  if (menuButton) {
    menuButton.addEventListener("click", () => {
      const shouldOpen = !nav || !nav.classList.contains("open");
      updateMenuState(shouldOpen);
    });
  }

  if (navDrawerClose) {
    navDrawerClose.addEventListener("click", () => {
      updateMenuState(false);
    });
  }

  const jkMenuButton = document.getElementById("jkMenuButton");
  const jkDropdownMenu = document.getElementById("jkDropdownMenu");

  function setJkMenuState(isOpen) {
    if (!jkMenuButton || !jkDropdownMenu) return;
    jkDropdownMenu.hidden = !isOpen;
    jkMenuButton.setAttribute("aria-expanded", String(isOpen));
  }

  if (jkMenuButton && jkDropdownMenu) {
    jkMenuButton.addEventListener("click", (event) => {
      event.stopPropagation();
      const shouldOpen = jkDropdownMenu.hidden;
      // Close mobile nav drawer if open to prevent overlap
      if (shouldOpen) updateMenuState(false);
      setJkMenuState(shouldOpen);
    });

    document.addEventListener("click", (event) => {
      if (jkDropdownMenu.hidden) return;
      if (!jkDropdownMenu.contains(event.target) && !jkMenuButton.contains(event.target)) {
        setJkMenuState(false);
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !jkDropdownMenu.hidden) {
        setJkMenuState(false);
        jkMenuButton.focus();
      }
    });
  }

  // Handle modal routing from navigation and generic data-nav-modal triggers
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    // Route to dedicated Search view
    const searchTrigger = target.closest('a[href="#find-worker"], [data-view="search"], [data-service], [data-service-select]');
    if (searchTrigger) {
      updateMenuState(false);
      setView("search");
      if (window.location.hash !== "#find-worker") {
        if (typeof history.replaceState === "function") {
          history.replaceState(null, "", "#find-worker");
        } else {
          window.location.hash = "#find-worker";
        }
      }
      return;
    }

    // Route back to Home view
    const homeTrigger = target.closest('a[href="#home"], #searchBackHomeLink, #navDrawerBrandLink, [data-view="home"]');
    if (homeTrigger) {
      event.preventDefault();
      updateMenuState(false);
      if (window.location.hash) {
        if (typeof history.pushState === "function") {
          history.pushState(null, "", window.location.pathname + window.location.search);
        } else {
          window.location.hash = "";
        }
      }
      setView("home");
      return;
    }

    const modalTrigger = target.closest("[data-nav-modal]");
    if (modalTrigger) {
      const modalId = modalTrigger.dataset.navModal;
      if (modalId) {
        updateMenuState(false);
        openModal(modalId);
      }
      return;
    }

    if (target.closest(".nav-links a, .nav-links [data-jk-action]")) {
      updateMenuState(false);
    }
  });

  // Close nav drawer on click outside
  document.addEventListener("click", (event) => {
    if (!nav || !nav.classList.contains("open")) return;
    if (
      navLinks &&
      !navLinks.contains(event.target) &&
      menuButton &&
      !menuButton.contains(event.target)
    ) {
      updateMenuState(false);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && nav && nav.classList.contains("open")) {
      updateMenuState(false);
      menuButton?.focus();
    }
  });

  // Hash-based modal and screen destinations
  const HASH_MODAL_MAP = {
    "#about": "aboutModal",
    "#how-it-works": "howItWorksModal",
    "#services": "servicesModal",
    "#trust": "trustModal",
    "#contact": "supportModal",
    "#support": "supportModal"
  };

  function handleNavHash() {
    const hash = (window.location.hash || "").toLowerCase();

    if (hash === "#find-worker" || hash === "#search") {
      updateMenuState(false);
      setView("search");
      return;
    }

    if (hash === "" || hash === "#" || hash === "#home" || hash === "#top") {
      updateMenuState(false);
      setView("home");
      return;
    }

    const modalId = HASH_MODAL_MAP[hash];
    if (modalId) {
      updateMenuState(false);
      openModal(modalId);
    }
  }

  window.addEventListener("hashchange", handleNavHash);
  if (typeof window !== "undefined" && window.location?.hash) {
    handleNavHash();
  }

  window.addEventListener("scroll", () => {
    if (header) {
      header.classList.toggle("scrolled", window.scrollY > 10);
    }
  }, { passive: true });

  initializeConnectionMonitor();
}

/**
 * Monitors online and offline network status events.
 * Displays a non-intrusive status banner with accessible live regions.
 */
export function initializeConnectionMonitor() {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  const banner = document.getElementById("connectionStatusBanner");
  const messageEl = document.getElementById("connectionStatusMessage");
  let hideTimeout = null;

  function updateStatus(isOnline, isInitial = false) {
    if (!banner) return;
    if (hideTimeout) {
      clearTimeout(hideTimeout);
      hideTimeout = null;
    }

    if (!isOnline) {
      banner.hidden = false;
      banner.classList.remove("is-online");
      banner.classList.add("is-offline");
      if (messageEl) {
        messageEl.textContent = "You are currently offline. Please check your internet connection.";
      }
    } else {
      if (isInitial) {
        banner.hidden = true;
        banner.classList.remove("is-offline", "is-online");
      } else {
        banner.hidden = false;
        banner.classList.remove("is-offline");
        banner.classList.add("is-online");
        if (messageEl) {
          messageEl.textContent = "Back online. Your connection has been restored.";
        }
        hideTimeout = setTimeout(() => {
          banner.hidden = true;
          banner.classList.remove("is-online");
        }, 3200);
      }
    }
  }

  window.addEventListener("online", () => updateStatus(true, false));
  window.addEventListener("offline", () => updateStatus(false, false));

  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    updateStatus(false, true);
  }
}



