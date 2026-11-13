// Overview filters. Every card is in the page already, so the site works as a
// plain list without JavaScript; this only hides cards that do not match.
(function () {
  var form = document.getElementById("filters");
  if (!form) return;
  var cards = Array.prototype.slice.call(document.querySelectorAll(".card"));
  var groups = Array.prototype.slice.call(document.querySelectorAll(".group"));
  var status = document.getElementById("results-status");
  var empty = document.getElementById("no-results");
  var total = cards.length;

  var controls = {
    q: document.getElementById("f-q"),
    harness: document.getElementById("f-harness"),
    level: document.getElementById("f-level"),
    category: document.getElementById("f-category"),
    availability: document.getElementById("f-availability"),
    shots: document.getElementById("f-shots"),
  };

  function readUrl() {
    var params = new URLSearchParams(location.search);
    Object.keys(controls).forEach(function (key) {
      var value = params.get(key);
      if (value === null) return;
      var el = controls[key];
      if (el.tagName === "SELECT" && !Array.prototype.some.call(el.options, function (o) { return o.value === value; })) return;
      el.value = value;
    });
  }

  function writeUrl() {
    var params = new URLSearchParams();
    Object.keys(controls).forEach(function (key) {
      if (controls[key].value) params.set(key, controls[key].value);
    });
    var query = params.toString();
    history.replaceState(null, "", location.pathname + (query ? "?" + query : "") + location.hash);
  }

  function apply() {
    var q = controls.q.value.trim().toLowerCase();
    var words = q ? q.split(/\s+/) : [];
    var shown = 0;
    cards.forEach(function (card) {
      var d = card.dataset;
      var match =
        (!controls.harness.value || d.harness === controls.harness.value) &&
        (!controls.level.value || d.level === controls.level.value) &&
        (!controls.category.value || d.category === controls.category.value) &&
        (!controls.availability.value || d.availability === controls.availability.value) &&
        (!controls.shots.value || d.shots === controls.shots.value) &&
        words.every(function (w) { return d.search.indexOf(w) !== -1; });
      card.hidden = !match;
      if (match) shown += 1;
    });
    groups.forEach(function (group) {
      var visible = group.querySelectorAll(".card:not([hidden])").length;
      group.hidden = visible === 0;
      var count = group.querySelector("[data-group-count]");
      if (count) count.textContent = String(visible);
    });
    empty.hidden = shown !== 0;
    status.textContent =
      shown === total ? "Showing all " + total + " features." : "Showing " + shown + " of " + total + " features.";
    writeUrl();
  }

  form.addEventListener("submit", function (event) { event.preventDefault(); });
  form.addEventListener("input", apply);
  form.addEventListener("change", apply);
  document.getElementById("f-reset").addEventListener("click", function () {
    Object.keys(controls).forEach(function (key) { controls[key].value = ""; });
    apply();
    controls.q.focus();
  });

  readUrl();
  apply();
})();
