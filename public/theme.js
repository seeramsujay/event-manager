"use strict";

// Applies the saved color theme before the first paint so the page never
// flashes the wrong colors. The switch itself lives in app.js.
(function applySavedTheme() {
  try {
    const theme = localStorage.getItem("theme");
    if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  } catch {
    /* storage unavailable: follow the system setting */
  }
})();
