// Theme toggle. Follows the system setting until the visitor picks one; the
// choice is kept in localStorage on this device only. No network, no tracking.
(function () {
  var KEY = "feature-tour-theme";
  var root = document.documentElement;
  try {
    var saved = localStorage.getItem(KEY);
    if (saved === "light" || saved === "dark") root.setAttribute("data-theme", saved);
  } catch (e) {
    /* storage unavailable: follow the system theme */
  }

  function effective() {
    var set = root.getAttribute("data-theme");
    if (set) return set;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function sync(button) {
    var dark = effective() === "dark";
    button.setAttribute("aria-pressed", dark ? "true" : "false");
    button.textContent = "Dark theme";
  }

  document.addEventListener("DOMContentLoaded", function () {
    var button = document.getElementById("theme-toggle");
    if (!button) return;
    sync(button);
    button.addEventListener("click", function () {
      var next = effective() === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try {
        localStorage.setItem(KEY, next);
      } catch (e) {
        /* ignore */
      }
      sync(button);
    });
  });
})();
