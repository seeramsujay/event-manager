"use strict";

// Applies the saved theme and accessibility preferences before the first paint so
// the page never flashes wrong colors, font sizes, or motion. The switches
// themselves live in app.js.
(function applySavedPreferences() {
  try {
    const theme = localStorage.getItem("theme");
    if (theme === "light" || theme === "dark") {
      document.documentElement.dataset.theme = theme;
    }

    const textSize = localStorage.getItem("textSize");
    if (textSize === "large") {
      document.documentElement.dataset.textSize = "large";
    }

    const contrast = localStorage.getItem("contrast");
    if (contrast === "high") {
      document.documentElement.dataset.contrast = "high";
    }

    const motion = localStorage.getItem("motion");
    if (motion === "reduce" || motion === "reduced") {
      document.documentElement.dataset.motion = "reduce";
    }
  } catch {
    /* storage unavailable: follow the system setting */
  }
})();
