// ==========================================
// #THEME_MANAGEMENT
// JK FixHub Dual-Theme Controller (Light: Design 9 / Dark: Design 8)
// ==========================================

export const THEME_STORAGE_KEY = "jkfixhub_theme";
export const SUPPORTED_THEMES = Object.freeze(["light", "dark"]);

/**
 * Returns currently active theme ('light' | 'dark').
 */
export function getTheme() {
  if (typeof document === "undefined") return "light";
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

/**
 * Applies a theme ('light' | 'dark') to document root.
 * Updates data-theme attribute, color-scheme property, meta theme-color,
 * and syncs all toggle buttons across drawer, menu, and dialogs.
 *
 * @param {'light'|'dark'} newTheme
 * @param {boolean} persist Whether to save the choice in localStorage.
 */
export function setTheme(newTheme, persist = true) {
  const theme = newTheme === "dark" ? "dark" : "light";

  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.style.colorScheme = theme;

    // Update meta theme-color for mobile browser chrome
    let themeMeta = document.querySelector('meta[name="theme-color"]');
    if (!themeMeta) {
      themeMeta = document.createElement("meta");
      themeMeta.name = "theme-color";
      document.head.appendChild(themeMeta);
    }
    themeMeta.content = theme === "dark" ? "#090d16" : "#ffffff";

    // Update state of all theme-control buttons in DOM
    const themeButtons = document.querySelectorAll("[data-theme-choice]");
    themeButtons.forEach((btn) => {
      const choice = btn.getAttribute("data-theme-choice");
      const isSelected = choice === theme;
      btn.classList.toggle("active", isSelected);
      btn.setAttribute("aria-checked", isSelected ? "true" : "false");
    });

    document.dispatchEvent(new CustomEvent("themechange", { detail: { theme } }));
  }

  if (persist && typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch (_) {}
  }

  return theme;
}

/**
 * Toggles between light and dark themes.
 */
export function toggleTheme() {
  const current = getTheme();
  return setTheme(current === "dark" ? "light" : "dark", true);
}

/**
 * Initializes theme controller and binds interactive controls.
 */
export function initializeTheme() {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  // Determine starting theme
  let initialTheme = "light";
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === "dark" || saved === "light") {
      initialTheme = saved;
    } else if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
      initialTheme = "dark";
    }
  } catch (_) {}

  // Apply immediately
  setTheme(initialTheme, false);

  window.__jkTheme = { getTheme, setTheme, toggleTheme };

  // Global delegated click handler for theme options
  document.addEventListener("click", (event) => {
    const choiceBtn = event.target.closest("[data-theme-choice]");
    if (choiceBtn) {
      event.preventDefault();
      const choice = choiceBtn.getAttribute("data-theme-choice");
      if (choice === "light" || choice === "dark") {
        setTheme(choice, true);
      }
      return;
    }

    const toggleBtn = event.target.closest("[data-theme-toggle]");
    if (toggleBtn) {
      event.preventDefault();
      toggleTheme();
    }
  });

  // Listen to system preference changes if user hasn't explicitly set a preference
  if (window.matchMedia) {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleMediaChange = (e) => {
      try {
        const saved = localStorage.getItem(THEME_STORAGE_KEY);
        // Only adapt automatically if user has not explicitly chosen a preference
        if (!saved) {
          setTheme(e.matches ? "dark" : "light", false);
        }
      } catch (_) {}
    };

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleMediaChange);
    } else if (typeof mediaQuery.addListener === "function") {
      mediaQuery.addListener(handleMediaChange);
    }
  }
}
