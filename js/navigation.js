// ==========================================
// #NAVIGATION_LOGIC
// ==========================================

// This file contains the navigation-related UI logic
// used by the JKFixHub prototype.
//
// Navigation is kept separate from the main application
// logic so the project remains easier to understand
// and maintain.
export function initializeNavigation() {
  const nav = document.getElementById("nav");
  const menuButton = document.getElementById("menuButton");
  const header = document.querySelector(".site-header");

  function updateMenuState(isOpen) {
    if (!nav || !menuButton) return;
    nav.classList.toggle("open", isOpen);
    menuButton.setAttribute("aria-expanded", String(isOpen));
    menuButton.setAttribute("aria-label", isOpen ? "Close navigation" : "Open navigation");
  }

  if (menuButton) {
    menuButton.addEventListener("click", () => {
      const shouldOpen = !nav || !nav.classList.contains("open");
      updateMenuState(shouldOpen);
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

  document.querySelectorAll(".nav-links a").forEach((link) => {
    link.addEventListener("click", () => updateMenuState(false));
  });

  window.addEventListener("scroll", () => {
    if (header) {
      header.classList.toggle("scrolled", window.scrollY > 10);
    }
  }, { passive: true });
}
