/* Theme bootstrap: runs before first paint so the saved choice never flashes. */
(function () {
  var KEY = "portal-theme";
  var root = document.documentElement;

  function stored() {
    try {
      var value = localStorage.getItem(KEY);
      return value === "light" || value === "dark" ? value : null;
    } catch (_err) {
      return null;
    }
  }

  function systemTheme() {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }

  function effective() {
    return stored() || systemTheme();
  }

  function apply() {
    var saved = stored();
    if (saved) root.setAttribute("data-theme", saved);
    else root.removeAttribute("data-theme");
  }

  function label(button) {
    var next = effective() === "dark" ? "light" : "dark";
    button.setAttribute("aria-label", "Switch to " + next + " theme");
    button.setAttribute("title", "Switch to " + next + " theme");
  }

  apply();

  document.addEventListener("DOMContentLoaded", function () {
    var button = document.getElementById("theme-toggle");
    if (!button) return;
    label(button);
    button.addEventListener("click", function () {
      var next = effective() === "dark" ? "light" : "dark";
      try {
        localStorage.setItem(KEY, next);
      } catch (_err) {
        /* storage unavailable: the choice applies for this page view only */
      }
      root.setAttribute("data-theme", next);
      label(button);
    });
    if (window.matchMedia) {
      window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", function () {
        if (!stored()) label(button);
      });
    }
  });
})();
