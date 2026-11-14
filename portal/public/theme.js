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
    var attr = root.getAttribute("data-theme");
    if (attr === "light" || attr === "dark") return attr;
    return stored() || systemTheme();
  }

  function setThemeAttr(value) {
    if (value) {
      root.setAttribute("data-theme", value);
      if (document.body) document.body.setAttribute("data-theme", value);
    } else {
      root.removeAttribute("data-theme");
      if (document.body) document.body.removeAttribute("data-theme");
    }
  }

  function apply() {
    setThemeAttr(stored());
  }

  function label(button) {
    var next = effective() === "dark" ? "light" : "dark";
    button.setAttribute("aria-label", "Switch to " + next + " theme");
    button.setAttribute("title", "Switch to " + next + " theme");
  }

  apply();

  document.addEventListener("DOMContentLoaded", function () {
    setThemeAttr(root.getAttribute("data-theme") || stored());
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
      setThemeAttr(next);
      label(button);
    });
    if (window.matchMedia) {
      window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", function () {
        if (!stored()) label(button);
      });
    }
  });
})();
