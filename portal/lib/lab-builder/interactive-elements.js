/**
 * Zero-dependency HTML post-processor for generated and hand-authored labs.
 *
 * Transforms static Markdown-rendered HTML into accessible, interactive lab UI:
 *   1. Checkable task lists ("Check your work" and "Validation / Success Criteria")
 *      with clickable `<label>` rows and deterministic `data-task-key` attributes,
 *      removing the `disabled` attribute emitted by GFM renderers.
 *   2. Interactive Lesson Mini-Quiz cards (`<section class="lab-quiz">`) from
 *      clean Markdown multiple-choice blocks (`**Knowledge check: Lesson mini-quiz**`),
 *      complete with `A`–`D` radio options, per-question & full-quiz grading controls,
 *      live score pill, accessible status text, and Microsoft Learn reference links.
 *   3. Semantic layout hooks (`lab-module-meta`, `lab-subhead`, `lab-scenario-callout`)
 *      for clear visual hierarchy without altering heading levels (`h1`–`h3`).
 *
 * Idempotent: running this function more than once produces identical HTML.
 */

function escapeAttr(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function stripTags(html) {
  return String(html ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Deterministic 32-bit FNV-1a hash encoded in base36 for compact task keys. */
export function shortTextHash(text) {
  const normalized = String(text ?? "").trim().toLowerCase();
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function isCheckedInputTag(inputTag) {
  return /\bchecked(?:\s*=\s*(?:""|''|"checked"|'checked'|true))?(?=\s|\/|>|$)/i.test(inputTag);
}

/**
 * Make GFM task-list checkboxes interactive and wrap each item in a `<label>`
 * so learners can click or press Space to track progress.
 */
export function enhanceTaskListHtml(html) {
  let taskIndex = 0;
  let next = String(html ?? "").replace(
    /<li(\b[^>]*)>((?:(?!<\/?li\b)[\s\S])*?)<\/li>/gi,
    (full, _liAttrs, inner) => {
      if (/\bclass=["'][^"']*\btask-list-label\b/i.test(inner) || /\bdata-task-key=/i.test(inner)) {
        return full;
      }

      let inputTag = null;
      let labelBody = "";
      let trailingHtml = "";

      const tightMatch = inner.match(
        /^\s*(<input\b[^>]*\btype=["']checkbox["'][^>]*\/?>)\s*([\s\S]*?)\s*$/i,
      );
      if (tightMatch) {
        inputTag = tightMatch[1];
        labelBody = tightMatch[2].trim();
      } else {
        const looseMatch = inner.match(
          /^\s*<p>\s*(<input\b[^>]*\btype=["']checkbox["'][^>]*\/?>)\s*([\s\S]*?)<\/p>([\s\S]*)$/i,
        );
        if (looseMatch) {
          inputTag = looseMatch[1];
          labelBody = looseMatch[2].trim();
          trailingHtml = looseMatch[3] || "";
        }
      }

      if (!inputTag) return full;

      taskIndex += 1;
      const checkedAttr = isCheckedInputTag(inputTag) ? " checked" : "";
      const key = `task-${taskIndex}-${shortTextHash(stripTags(labelBody))}`;
      return (
        `<li class="task-list-item">` +
        `<label class="task-list-label">` +
        `<input class="task-list-item-checkbox" type="checkbox"${checkedAttr} data-task-key="${escapeAttr(key)}" />` +
        `<span class="task-list-item-text">${labelBody}</span>` +
        `</label>${trailingHtml}</li>`
      );
    },
  );

  next = next.replace(
    /<ul(\b[^>]*)>(?=(?:(?!<\/?ul\b)[\s\S])*?<li class="task-list-item")/gi,
    (full, attrs) => {
      if (/\bcontains-task-list\b/.test(attrs)) return full;
      if (/\bclass=(["'])(.*?)\1/i.test(attrs)) {
        return `<ul${attrs.replace(
          /\bclass=(["'])(.*?)\1/i,
          (_m, quote, cls) => `class=${quote}${cls.trim()} contains-task-list${quote}`,
        )}>`;
      }
      return `<ul class="contains-task-list"${attrs}>`;
    },
  );

  return next;
}

const QUESTION_BLOCK_HTML_RE =
  /\s*<p><strong>Question\s+(\d+)\.<\/strong>\s*([\s\S]*?)<\/p>\s*<ul>([\s\S]*?)<\/ul>\s*<details>\s*<summary>[\s\S]*?<\/summary>\s*([\s\S]*?)\s*<\/details>/gi;

const QUIZ_SECTION_HTML_RE = new RegExp(
  `<p><strong>Knowledge check:\\s*Lesson mini-quiz<\\/strong><\\/p>` +
    `(?:\\s*<p><em>([\\s\\S]*?)<\\/em><\\/p>)?` +
    `((?:${QUESTION_BLOCK_HTML_RE.source})+)`,
  "gi",
);

function decorateExplanationHtml(rawExplanationHtml) {
  return String(rawExplanationHtml ?? "")
    .trim()
    .replace(
      /<p>(\s*<strong>Microsoft Learn references?:<\/strong>[\s\S]*?)<\/p>/gi,
      '<p class="lab-quiz-learn-ref">$1</p>',
    )
    .replace(/<a\s+href=(["']https?:\/\/[^"']+["'])>/gi, '<a href=$1 target="_blank" rel="noopener noreferrer">');
}

function parseQuizOptions(ulInnerHtml) {
  const options = [];
  const optionRe = /<li\b[^>]*>\s*(?:<p>\s*)?<strong>([A-D])\.<\/strong>\s*([\s\S]*?)(?:\s*<\/p>)?\s*<\/li>/gi;
  let match;
  while ((match = optionRe.exec(ulInnerHtml)) !== null) {
    options.push({
      letter: match[1].toUpperCase(),
      html: match[2].trim(),
    });
  }
  return options;
}

/**
 * Transform clean Markdown Lesson Mini-Quiz HTML blocks into interactive
 * multiple-choice `<section class="lab-quiz">` cards.
 */
export function enhanceQuizHtml(html) {
  let quizCounter = 0;
  return String(html ?? "").replace(QUIZ_SECTION_HTML_RE, (full, introHtml, questionsBlob) => {
    const parsedQuestions = [];
    const qRe = new RegExp(QUESTION_BLOCK_HTML_RE.source, "gi");
    let qMatch;
    while ((qMatch = qRe.exec(questionsBlob)) !== null) {
      const number = Number(qMatch[1]);
      const promptHtml = qMatch[2].trim();
      const options = parseQuizOptions(qMatch[3]);
      const rawExplanation = qMatch[4].trim();
      const answerMatch = rawExplanation.match(/<strong>Correct answer:\s*([A-D])\.<\/strong>/i);
      if (!options.length || !answerMatch) continue;
      parsedQuestions.push({
        number,
        promptHtml,
        options,
        correct: answerMatch[1].toUpperCase(),
        explanationHtml: decorateExplanationHtml(rawExplanation),
      });
    }

    if (!parsedQuestions.length) return full;
    quizCounter += 1;
    const quizId = `quiz-${quizCounter}`;
    const total = parsedQuestions.length;

    const questionsHtml = parsedQuestions
      .map((q, idx) => {
        const radioName = `lab-${quizId}-q${idx + 1}`;
        const optionsHtml = q.options
          .map(
            (opt) =>
              `<label class="lab-quiz-option" data-option-letter="${escapeAttr(opt.letter)}">` +
              `<input class="lab-quiz-radio" type="radio" name="${escapeAttr(radioName)}" value="${escapeAttr(opt.letter)}" data-quiz-option="${escapeAttr(opt.letter)}" />` +
              `<span class="lab-quiz-option-badge">${escapeAttr(opt.letter)}</span>` +
              `<span class="lab-quiz-option-text">${opt.html}</span>` +
              `</label>`,
          )
          .join("");

        return (
          `<fieldset class="lab-quiz-question" data-question-index="${idx}" data-correct="${escapeAttr(q.correct)}">` +
          `<legend class="lab-quiz-prompt"><strong>Question ${q.number}.</strong> ${q.promptHtml}</legend>` +
          `<div class="lab-quiz-options">${optionsHtml}</div>` +
          `<div class="lab-quiz-question-actions">` +
          `<button type="button" class="lab-quiz-btn lab-quiz-check-one" data-quiz-check-one="${idx}">Check answer</button>` +
          `<span class="lab-quiz-status" data-quiz-status role="status" aria-live="polite"></span>` +
          `</div>` +
          `<div class="lab-quiz-explanation" data-quiz-explanation hidden>${q.explanationHtml}</div>` +
          `</fieldset>`
        );
      })
      .join("");

    const introLine = introHtml
      ? `<p class="lab-quiz-intro"><em>${introHtml.trim()}</em></p>`
      : "";

    return (
      `<section class="lab-quiz" data-quiz-id="${escapeAttr(quizId)}" aria-label="Lesson mini-quiz">` +
      `<div class="lab-quiz-header">` +
      `<div class="lab-quiz-heading-group">` +
      `<span class="lab-quiz-eyebrow">Knowledge check</span>` +
      `<p class="lab-quiz-title"><strong>Lesson mini-quiz</strong></p>` +
      `${introLine}` +
      `</div>` +
      `<span class="lab-quiz-score" data-quiz-score role="status" aria-live="polite">0 / ${total} correct</span>` +
      `</div>` +
      `${questionsHtml}` +
      `<div class="lab-quiz-footer">` +
      `<button type="button" class="lab-quiz-btn lab-quiz-btn-primary" data-quiz-check-all="true">Check quiz</button>` +
      `<button type="button" class="lab-quiz-btn lab-quiz-btn-reset" data-quiz-reset="true">Reset quiz</button>` +
      `</div>` +
      `</section>`
    );
  });
}

const SUBHEAD_LABELS_RE =
  /^<p><strong>(Concepts before you click|Do this|Check your work|Troubleshooting|Microsoft Learn references|Vendor documentation|End-to-end test|Scenario data you will need|Design notes for your audience|Licensing and permissions|Further reading on Microsoft Learn|What this [^*<>]+ lab covers)<\/strong><\/p>$/gim;

/**
 * Add semantic typography classes to generated module metadata, sub-section
 * headers, and scenario callouts without emitting extra heading levels.
 */
export function enhanceLayoutCalloutsHtml(html) {
  return String(html ?? "")
    .replace(
      /<p><em>((?:Level\s+\d+\s*·|Prerequisite recap from Level\s+\d+)[\s\S]*?)<\/em><\/p>/gi,
      '<p class="lab-module-meta"><em>$1</em></p>',
    )
    .replace(SUBHEAD_LABELS_RE, '<p class="lab-subhead"><strong>$1</strong></p>')
    .replace(
      /<p><strong>In your scenario\.<\/strong>([\s\S]*?)<\/p>/gi,
      '<p class="lab-scenario-callout"><strong>In your scenario.</strong>$1</p>',
    );
}

/**
 * Apply all interactive and layout enhancements to rendered lab HTML.
 */
export function enhanceInteractiveLabHtml(html) {
  let out = enhanceQuizHtml(html);
  out = enhanceTaskListHtml(out);
  out = enhanceLayoutCalloutsHtml(out);
  return out;
}
