// Guided tour. Reads the feature data embedded in tour.html, so it also works
// when the file is opened without a server. All text is inserted with
// textContent, never as HTML.
(function () {
  var dataEl = document.getElementById("tour-data");
  if (!dataEl) return;
  var data = JSON.parse(dataEl.textContent);
  var features = data.features;
  var total = features.length;

  var stepEl = document.getElementById("tour-step");
  var prevBtn = document.getElementById("tour-prev");
  var nextBtn = document.getElementById("tour-next");
  var jump = document.getElementById("tour-jump");
  var progress = document.getElementById("tour-progress");
  var bar = document.getElementById("tour-bar");
  var progressText = document.getElementById("tour-progress-text");
  var statusEl = document.getElementById("tour-status");
  var REPO = "https://github.com/russrimm/CopilotStudioLabs";

  var current = 0;
  var shotIndex = 0;
  var userNavigated = false;

  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === "text") el.textContent = attrs[k];
        else if (k === "class") el.className = attrs[k];
        else el.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child == null) continue;
      el.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return el;
  }

  // **bold** and `code` markers from the catalog, rendered as elements.
  function rich(text) {
    var frag = document.createDocumentFragment();
    String(text).split(/(\*\*[^*]+\*\*|`[^`]+`)/).forEach(function (part) {
      if (!part) return;
      if (part.slice(0, 2) === "**") frag.appendChild(h("strong", { text: part.slice(2, -2) }));
      else if (part[0] === "`") frag.appendChild(h("code", { text: part.slice(1, -1) }));
      else frag.appendChild(document.createTextNode(part));
    });
    return frag;
  }

  function find(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function learnTitle(url) {
    var slug = "";
    try {
      var parts = new URL(url).pathname.split("/").filter(Boolean);
      slug = parts[parts.length - 1] || "";
    } catch (e) {
      slug = url;
    }
    var words = slug.replace(/[-_]+/g, " ").trim();
    return words ? "Microsoft Learn: " + words.charAt(0).toUpperCase() + words.slice(1) : "Microsoft Learn";
  }

  function indexFromHash() {
    var hash = decodeURIComponent(location.hash.replace(/^#/, ""));
    if (!hash) return 0;
    var stepMatch = /^step-(\d+)$/.exec(hash);
    if (stepMatch) {
      var n = parseInt(stepMatch[1], 10);
      return n >= 1 && n <= total ? n - 1 : 0;
    }
    for (var i = 0; i < total; i++) if (features[i].id === hash) return i;
    return 0;
  }

  function badge(cls, text) {
    return h("span", { class: "badge " + cls, text: text });
  }

  function badgesFor(f) {
    var harness = find(data.harnesses, f.harnessGroup);
    var avail = find(data.availability, f.availability);
    return h(
      "p",
      { class: "badges" },
      badge("badge-harness-" + harness.id, harness.id === "both" ? "Both harnesses" : harness.name),
      badge("badge-level", f.levelLabel),
      badge("badge-availability-" + avail.id, avail.label),
      badge("badge-minutes", "About " + f.minutes + " min")
    );
  }

  function setActiveCallout(n) {
    stepEl.querySelectorAll("[data-callout]").forEach(function (el) {
      el.classList.toggle("is-active", String(n) === el.getAttribute("data-callout"));
    });
  }

  function placeholder(shot) {
    var box = h("div", { class: "shot-placeholder" });
    box.appendChild(h("p", { class: "placeholder-title", text: "◌ Screenshot pending" }));
    box.appendChild(h("p", { text: shot.caption }));
    box.appendChild(h("p", { class: "placeholder-label", text: "Where this screen is" }));
    box.appendChild(h("p", { text: shot.navHint }));
    box.appendChild(h("p", { class: "placeholder-label", text: "What the screenshot will show" }));
    var ul = h("ul");
    shot.instructions.forEach(function (i) { ul.appendChild(h("li", null, rich(i))); });
    box.appendChild(ul);
    box.appendChild(h("p", { class: "placeholder-file" }, "Planned file: ", h("code", { text: shot.filename })));
    return box;
  }

  function screenshot(f, shot) {
    var fig = h("figure", { class: "shot" });
    if (shot.status === "ready") {
      var img = h("img", {
        src: shot.src,
        alt: f.name + ": " + shot.caption + ". The numbered callouts are listed beside the image.",
      });
      if (shot.width && shot.height) {
        img.setAttribute("width", shot.width);
        img.setAttribute("height", shot.height);
      }
      var frame = h("div", { class: "shot-frame" }, img);
      shot.callouts.forEach(function (c) {
        if (!c.rect) return;
        var spot = h("span", { class: "hotspot", "data-callout": String(c.n) });
        spot.style.left = (c.rect.x * 100).toFixed(2) + "%";
        spot.style.top = (c.rect.y * 100).toFixed(2) + "%";
        spot.style.width = (c.rect.w * 100).toFixed(2) + "%";
        spot.style.height = (c.rect.h * 100).toFixed(2) + "%";
        spot.appendChild(h("span", { class: "hotspot-n", "aria-hidden": "true", text: String(c.n) }));
        var btn = h("button", { type: "button", class: "hotspot-btn", "aria-label": "Callout " + c.n + ": " + c.label });
        btn.addEventListener("click", function () { setActiveCallout(c.n); });
        btn.addEventListener("focus", function () { setActiveCallout(c.n); });
        spot.appendChild(btn);
        frame.appendChild(spot);
      });
      fig.appendChild(frame);
    } else {
      fig.appendChild(placeholder(shot));
    }
    fig.appendChild(h("figcaption", { text: shot.caption + (shot.status === "ready" ? "" : " (screenshot pending)") }));
    return fig;
  }

  function calloutList(shot) {
    if (!shot.callouts.length) return null;
    var ol = h("ol", { class: "callout-list" });
    shot.callouts.forEach(function (c) {
      var li = h(
        "li",
        { "data-callout": String(c.n) },
        h("span", { class: "callout-n", "aria-hidden": "true", text: String(c.n) }),
        h("span", null, h("strong", { text: c.label }), c.note ? " — " + c.note : "")
      );
      ol.appendChild(li);
    });
    return ol;
  }

  function section(title, node) {
    if (!node) return null;
    var wrap = document.createDocumentFragment();
    wrap.appendChild(h("h3", { text: title }));
    wrap.appendChild(node);
    return wrap;
  }

  function listOf(items, tag) {
    if (!items.length) return null;
    var list = h(tag || "ul");
    items.forEach(function (item) { list.appendChild(h("li", null, rich(item))); });
    return list;
  }

  function render() {
    var f = features[current];
    var harness = find(data.harnesses, f.harnessGroup);
    var category = find(data.categories, f.category);
    var shot = f.shots[Math.min(shotIndex, f.shots.length - 1)];
    stepEl.textContent = "";
    stepEl.setAttribute("aria-labelledby", "tour-step-title");

    stepEl.appendChild(h("p", { class: "eyebrow", text: harness.name + " · " + category.name }));
    stepEl.appendChild(h("h2", { id: "tour-step-title", text: f.name }));
    stepEl.appendChild(badgesFor(f));
    stepEl.appendChild(h("p", { class: "lede", text: f.summary }));

    var left = h("div", { class: "shot-col" });
    if (f.shots.length > 1) {
      var sw = h("div", { class: "shot-switch", role: "group", "aria-label": "Screenshots for this feature" });
      f.shots.forEach(function (s, i) {
        var b = h("button", { type: "button", "aria-pressed": i === shotIndex ? "true" : "false", text: "Screenshot " + (i + 1) + " of " + f.shots.length });
        b.addEventListener("click", function () { shotIndex = i; render(); });
        sw.appendChild(b);
      });
      left.appendChild(sw);
    }
    if (shot) {
      left.appendChild(screenshot(f, shot));
      var callouts = calloutList(shot);
      if (callouts) {
        left.appendChild(h("h3", { text: "Callouts" }));
        left.appendChild(callouts);
      }
    }

    var right = h("div", { class: "info-col" });
    var parts = [
      section("Why it matters", h("p", { text: f.whyItMatters })),
      section("Where to click", listOf(f.steps, "ol")),
      section("What to know", listOf(f.concepts)),
      f.prereqs.length
        ? section("Prerequisites", (function () {
            var ul = h("ul");
            f.prereqs.forEach(function (p) {
              ul.appendChild(h("li", null, h("a", { href: "#" + p.id, text: p.name })));
            });
            return ul;
          })())
        : null,
      section("Caveats", listOf(f.caveats)),
    ];
    parts.forEach(function (p) { if (p) right.appendChild(p); });

    var links = h("div", { class: "tour-links" }, h("a", { href: "features/" + f.id + ".html", text: "Open the full feature page" }));
    f.learn.forEach(function (l) { links.appendChild(h("a", { href: l.url, text: learnTitle(l.url) })); });
    f.relatedLabs.forEach(function (lab) { links.appendChild(h("a", { href: REPO + "/tree/main/labs/" + lab, text: "Lab: " + lab })); });
    right.appendChild(links);

    stepEl.appendChild(h("div", { class: "step-grid" }, left, right));

    var n = current + 1;
    progress.setAttribute("aria-valuenow", String(n));
    progress.setAttribute("aria-valuetext", "Step " + n + " of " + total);
    bar.style.width = ((n / total) * 100).toFixed(1) + "%";
    progressText.textContent = "Step " + n + " of " + total + " · " + harness.name + " · " + category.name;
    jump.value = f.id;
    prevBtn.disabled = current === 0;
    nextBtn.disabled = current === total - 1;
    document.title = f.name + " | Guided tour | Microsoft AI Training Generator feature tour";
    statusEl.textContent = "Step " + n + " of " + total + ": " + f.name;
    if (userNavigated) {
      stepEl.focus({ preventScroll: true });
      stepEl.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    }
  }

  function go(index, user) {
    var next = Math.max(0, Math.min(total - 1, index));
    userNavigated = user !== false;
    var hash = "#" + features[next].id;
    if (location.hash === hash) {
      current = next;
      shotIndex = 0;
      render();
    } else {
      location.hash = hash;
    }
  }

  window.addEventListener("hashchange", function () {
    current = indexFromHash();
    shotIndex = 0;
    render();
  });

  prevBtn.addEventListener("click", function () { go(current - 1); });
  nextBtn.addEventListener("click", function () { go(current + 1); });
  jump.addEventListener("change", function () {
    for (var i = 0; i < total; i++) if (features[i].id === jump.value) go(i);
  });

  document.addEventListener("keydown", function (event) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    var tag = event.target && event.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (event.key === "ArrowRight") { event.preventDefault(); go(current + 1); }
    else if (event.key === "ArrowLeft") { event.preventDefault(); go(current - 1); }
    else if (event.key === "Home") { event.preventDefault(); go(0); }
    else if (event.key === "End") { event.preventDefault(); go(total - 1); }
  });

  current = indexFromHash();
  render();
})();
