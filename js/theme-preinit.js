/**
 * Synchronous early theme initializer for JK FixHub.
 * Runs in <head> before <body> render to eliminate flash of wrong theme (FOUC).
 * Respects localStorage saved preference or device preferred-color-scheme.
 */
(function () {
  try {
    const saved = localStorage.getItem("jkfixhub_theme");
    const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    const theme = (saved === "dark" || saved === "light") ? saved : (prefersDark ? "dark" : "light");
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.style.colorScheme = theme;
  } catch (_) {}
})();

