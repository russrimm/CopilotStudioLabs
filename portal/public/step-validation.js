/**
 * Step validation UI (Validation tab).
 *
 * Starts a server-side run that checks each lab step's claims against Microsoft
 * Learn, polls its progress, and renders results as they arrive. All text that
 * originates from labs or Learn is escaped; links are only created for
 * https://learn.microsoft.com/ URLs.
 */
(function () {
  const POLL_MS = 1000;
  const ICONS = { verified: "✅", unverified: "❔", stale: "⚠️", unable: "🔌", "no-claims": "➖", "no-steps": "➖" };
  const LABELS = {
    verified: "Verified",
    unverified: "Unverified",
    stale: "Likely stale",
    unable: "Unable to verify",
    "no-claims": "Nothing to check",
    "no-steps": "No steps found",
  };
  const BADGE = { verified: "tag-success", unverified: "tag-warning", stale: "tag-danger", unable: "tag-warning" };

  let jobId = null;
  let timer = null;
  let running = false;
  const labs = new Map(); // labId -> { lab, partial }
  const cards = new Map(); // labId -> { el, signature }

  const $ = (id) => document.getElementById(id);
  const esc = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const isLearnUrl = (url) => /^https:\/\/learn\.microsoft\.com\//i.test(String(url || ""));
  const notify = (message, type) => (typeof window.toast === "function" ? window.toast(message, type) : undefined);

  function tag(status, text) {
    return `<span class="tag ${BADGE[status] || ""}">${ICONS[status] || ""} ${esc(text ?? LABELS[status] ?? status)}</span>`;
  }

  function countsText(counts) {
    return `${counts.verified} verified · ${counts.unverified} unverified · ${counts.stale} stale · ${counts.unable} unable`;
  }

  function renderClaim(claim) {
    const evidence = (claim.evidence || [])[0];
    const link = evidence && isLearnUrl(evidence.url)
      ? `<a href="${esc(evidence.url)}" target="_blank" rel="noopener noreferrer">${esc(evidence.title || evidence.url)}</a>`
      : "";
    return `
      <li class="sv-claim">
        ${tag(claim.status)} <span class="sv-claim-term">${esc(claim.term)}</span>
        <div class="sv-claim-meta">${esc(claim.kind)} · rule ${esc(claim.rule)} · line ${esc(claim.line)}</div>
        <div>${esc(claim.explanation)}</div>
        ${link ? `<div class="sv-claim-meta">Source: ${link}</div>` : ""}
        ${evidence?.excerpt ? `<blockquote class="sv-excerpt">${esc(evidence.excerpt)}</blockquote>` : ""}
      </li>`;
  }

  function renderStep(step) {
    const docs = step.checks?.docs;
    const claims = docs?.claims || [];
    return `
      <li>
        <details class="sv-step" data-key="${esc(step.id)}" ${step.status === "stale" || step.status === "unable" ? "open" : ""}>
          <summary>${tag(step.status)} <span>${esc(step.title)}</span>
            <span class="sv-claim-meta">${claims.length} claim(s) · ${esc(countsText(step.counts))}</span></summary>
          ${claims.length ? `<ul class="sv-claims">${claims.map(renderClaim).join("")}</ul>` : `<p class="sv-note">No verifiable claims were found in this step.</p>`}
          ${docs?.skipped?.length ? `<p class="sv-note">Skipped as user-supplied or generic: ${esc(docs.skipped.map((s) => s.text).join(", "))}</p>` : ""}
        </details>
      </li>`;
  }

  function labHtml(entry) {
    const { lab, partial } = entry;
    const status = partial ? null : lab.status;
    const done = lab.steps.length;
    const counts = lab.counts || { verified: 0, unverified: 0, stale: 0, unable: 0 };
    const notes = (lab.notes || []).map((n) => `<p class="sv-note">${esc(n)}</p>`).join("");
    return `
      <details data-key="lab" ${status === "stale" || status === "unable" ? "open" : ""}>
        <summary>
          ${status ? tag(status) : `<span class="tag"><span class="spinner"></span> Checking…</span>`}
          <span>${esc(lab.title || lab.labId)}</span>
          <span class="sv-lab-meta">${done} section(s)${partial ? " so far" : ""} · ${esc(countsText(counts))}${lab.stepSource ? ` · steps from ${esc(lab.stepSource)}` : ""}</span>
        </summary>
        ${notes}
        <ul class="sv-steps">${lab.steps.map(renderStep).join("")}</ul>
      </details>`;
  }

  function attentionNeeded(entry) {
    return entry.partial || ["stale", "unable", "unverified"].includes(entry.lab.status);
  }

  function applyFilter() {
    const onlyAttention = $("step-validation-filter")?.checked;
    for (const [labId, card] of cards) {
      card.el.hidden = Boolean(onlyAttention) && !attentionNeeded(labs.get(labId));
    }
  }

  function renderLabs() {
    const container = $("step-validation-results");
    if (!container) return;
    let host = container.querySelector(".sv-labs");
    if (!host) {
      container.innerHTML = '<div class="sv-labs"></div>';
      host = container.querySelector(".sv-labs");
    }
    for (const [labId, entry] of labs) {
      const signature = `${entry.partial ? "p" : "d"}:${entry.lab.steps.length}:${entry.lab.status || ""}`;
      let card = cards.get(labId);
      if (!card) {
        const el = document.createElement("div");
        el.className = "sv-lab";
        host.appendChild(el);
        card = { el, signature: "" };
        cards.set(labId, card);
      }
      if (card.signature === signature) continue;
      // Keep sections the user opened or closed while the lab was still updating.
      const open = new Map([...card.el.querySelectorAll("details[data-key]")].map((d) => [d.dataset.key, d.open]));
      card.el.innerHTML = labHtml(entry);
      card.el.querySelectorAll("details[data-key]").forEach((d) => {
        if (open.has(d.dataset.key)) d.open = open.get(d.dataset.key);
      });
      card.signature = signature;
    }
    applyFilter();
  }

  function renderProgress(job) {
    const p = job.progress;
    const total = Math.max(1, p.labTotal);
    const within = p.stepTotal ? Math.min(1, p.stepsDone / p.stepTotal) : 0;
    const fraction = job.status === "running" ? Math.min(1, (p.labsDone + within) / total) : 1;
    const bar = $("step-validation-bar");
    if (bar) {
      bar.firstElementChild.style.transform = `scaleX(${fraction})`;
      bar.setAttribute("aria-valuenow", String(Math.round(fraction * 100)));
    }
    const status = $("step-validation-status");
    if (status && job.status === "running") {
      status.textContent = p.labId
        ? `Lab ${p.labIndex} of ${p.labTotal} (${p.labTitle || p.labId}) · section ${Math.min(p.stepsDone + 1, p.stepTotal)} of ${p.stepTotal}`
        : "Starting…";
    }
    const detail = $("step-validation-detail");
    if (detail) detail.textContent = job.status === "running" ? p.message || p.stepTitle || "" : "";
  }

  function renderSummary(job) {
    const summary = $("step-validation-summary");
    if (!summary) return;
    const report = job.report;
    if (!report) {
      summary.innerHTML = "";
      return;
    }
    const c = report.summary.claimStatus;
    summary.innerHTML = `
      <span class="tag">${report.summary.labs} labs · ${report.summary.steps} sections · ${report.summary.claims} claims</span>
      ${tag("verified", `${c.verified} verified`)} ${tag("unverified", `${c.unverified} unverified`)}
      ${tag("stale", `${c.stale} likely stale`)} ${tag("unable", `${c.unable} unable to verify`)}
      ${report.canceled ? '<span class="tag tag-warning">Canceled — partial results</span>' : ""}
      <span class="sv-claim-meta">Last run ${esc(new Date(job.updatedAt).toLocaleString())}</span>`;
  }

  function setRunning(next) {
    running = next;
    const run = $("step-validation-run");
    const cancel = $("step-validation-cancel");
    if (run) run.disabled = next;
    if (cancel) cancel.hidden = !next;
    $("step-validation-progress")?.toggleAttribute("hidden", false);
  }

  function absorb(job) {
    for (const lab of job.completedLabs || []) labs.set(lab.labId, { lab, partial: false });
    if (job.currentLab) {
      labs.set(job.currentLab.labId, {
        lab: { ...job.currentLab, counts: countSteps(job.currentLab.steps), notes: [] },
        partial: true,
      });
    }
  }

  function countSteps(steps) {
    const total = { verified: 0, unverified: 0, stale: 0, unable: 0 };
    for (const step of steps) for (const key of Object.keys(total)) total[key] += step.counts?.[key] || 0;
    return total;
  }

  async function poll() {
    if (!jobId) return;
    try {
      const res = await fetch(`/api/step-validation/${encodeURIComponent(jobId)}`);
      const job = await res.json();
      if (!res.ok) throw new Error(job.error || "Could not read step validation progress");
      absorb(job);
      renderProgress(job);
      renderLabs();
      if (job.status === "running") {
        timer = setTimeout(poll, POLL_MS);
        return;
      }
      finish(job);
    } catch (err) {
      setRunning(false);
      const status = $("step-validation-status");
      if (status) status.textContent = `Step validation stopped: ${err.message}`;
      notify(`Step validation failed: ${err.message}`, "error");
    }
  }

  function finish(job) {
    setRunning(false);
    jobId = null;
    renderSummary(job);
    const status = $("step-validation-status");
    if (job.status === "failed") {
      if (status) status.textContent = `Step validation failed: ${job.error || "unknown error"}`;
      notify("Step validation failed", "error");
      return;
    }
    const c = job.report?.summary.claimStatus;
    if (status) {
      status.textContent =
        job.status === "canceled" ? "Step validation canceled. Showing partial results." : "Step validation complete.";
    }
    if (c) {
      const bad = c.stale > 0 || c.unable > 0;
      notify(
        `Step validation: ${c.verified} verified, ${c.unverified} unverified, ${c.stale} likely stale, ${c.unable} unable to verify`,
        bad ? "error" : "success",
      );
    }
  }

  async function start(labIds) {
    if (running) return;
    labs.clear();
    cards.clear();
    const results = $("step-validation-results");
    if (results) results.innerHTML = "";
    const summary = $("step-validation-summary");
    if (summary) summary.innerHTML = "";
    setRunning(true);
    const status = $("step-validation-status");
    if (status) status.textContent = "Starting…";
    try {
      const res = await fetch("/api/step-validation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(labIds?.length ? { labIds } : {}),
      });
      const body = await res.json();
      if (res.status === 409 && body.jobId) {
        jobId = body.jobId;
      } else if (!res.ok) {
        throw new Error(body.error || "Could not start step validation");
      } else {
        jobId = body.jobId;
      }
      poll();
    } catch (err) {
      setRunning(false);
      if (status) status.textContent = `Could not start step validation: ${err.message}`;
      notify(`Could not start step validation: ${err.message}`, "error");
    }
  }

  async function cancel() {
    if (!jobId) return;
    clearTimeout(timer);
    try {
      await fetch(`/api/step-validation/${encodeURIComponent(jobId)}`, { method: "DELETE" });
    } catch {
      /* the next poll reports the outcome */
    }
    poll();
  }

  window.StepValidation = { start, cancel, applyFilter };
})();
