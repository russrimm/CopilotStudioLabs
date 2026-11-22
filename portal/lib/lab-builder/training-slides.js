/**
 * Slide content for the pre-lab training decks: pure data, no XML. `buildTopicDeck`, `buildFoundationsDeck`, and
 * `buildCompleteDeck` turn a training plan (training-plan.js) and the teaching library (training-library.js)
 * into slide specs that training-pptx.js draws.
 *
 * Storyline of a topic deck (about 12 or 13 slides, 25 minutes): title with three outcomes, why it matters in the
 * lab's own scenario, what it is, what you need to know first (higher levels), the building blocks, how it works,
 * see it in action, when to use it and when not to, things to know before you start, key terms, check your
 * understanding, what you will do in the hands-on lab, and Learn links. Concepts and orientation only: no lab
 * steps, no click paths, no administrator settings, no tenant values.
 *
 * Every product word is explained the first time it appears, once across a combined deck (a "word to know" line on
 * the slide, or inline in the speaker notes), and every slide carries speaker notes with a talk track, an example,
 * a question for the room, what to demo, and its time.
 */

import { findTermsInText, loadTrainingLibrary } from "./training-library.js";
import { isConceptSentence } from "./training-guard.js";
import { TRAINING_MINUTES, briefFor, describeFeature, helpLine, toYouWill } from "./training-plan.js";
import { getConcepts } from "./concepts.js";
import { getProduct } from "./products.js";
import { endWithPeriod, firstSentence, fleschKincaid, lowerFirst, plainText, splitSentences, wholeSentences } from "./training-text.js";

/** Relative weight of each slide kind when a deck's minutes are shared out among its slides. */
const WEIGHTS = {
  title: 1, scenario: 3, definition: 3, needToKnow: 3, blocks: 3, flow: 4, example: 3, fit: 2, know: 2, terms: 2, quiz: 3, labPreview: 1, learn: 1,
  what: 2, fitHub: 3, vocab: 3, where: 2, day: 2, adds: 3, divider: 0, agenda: 1, closing: 1,
};

/** Share `total` minutes across slides by weight (largest remainder), at least one minute for any slide with weight. */
export function allocateMinutes(kinds, total) {
  const weights = kinds.map((k) => WEIGHTS[k] ?? 1);
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!sum) return kinds.map(() => 0);
  const raw = weights.map((w) => (w * total) / sum);
  const out = raw.map((r, i) => (weights[i] ? Math.max(1, Math.floor(r)) : 0));
  let used = out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0]);
  for (let i = 0; used < total && i < order.length * 3; i += 1) {
    const idx = order[i % order.length][1];
    if (weights[idx]) {
      out[idx] += 1;
      used += 1;
    }
  }
  while (used > total) {
    const idx = out.indexOf(Math.max(...out));
    if (out[idx] <= 1) break;
    out[idx] -= 1;
    used -= 1;
  }
  return out;
}

/** Tracks which glossary terms a deck has already explained, so each is explained once. */
class Glossary {
  constructor(library, defined = new Set()) {
    this.library = library;
    this.defined = defined;
    this.order = [];
  }

  /** Terms in `texts` that this deck has not explained yet, in reading order. Marks them explained. */
  newTerms(texts, listed = new Set()) {
    const out = [];
    for (const text of texts) {
      for (const hit of findTermsInText(text, this.library, { listed })) {
        if (this.defined.has(hit.id)) continue;
        this.defined.add(hit.id);
        this.order.push(hit.id);
        out.push(hit.id);
      }
    }
    return out;
  }

  /** Terms in `texts` that this deck has not explained yet, without marking them (a dry run). */
  peek(texts, listed = new Set()) {
    const out = [];
    for (const text of texts) {
      for (const hit of findTermsInText(text, this.library, { listed })) {
        if (!this.defined.has(hit.id) && !out.includes(hit.id)) out.push(hit.id);
      }
    }
    return out;
  }

  define(ids) {
    for (const id of ids) {
      if (!this.defined.has(id)) {
        this.defined.add(id);
        this.order.push(id);
      }
    }
  }

  /** Speaker notes may use a term the slide did not show: explain it in brackets right after its first use. */
  glossNotes(lines, listed = new Set()) {
    return lines.map((line) => {
      if (typeof line !== "string") return line;
      const m = line.match(/^([A-Z][A-Z0-9 /&()'–—-]{2,48}:)\s*([\s\S]*)$/);
      const label = m ? `${m[1]} ` : "";
      let text = m ? m[2] : line;
      const hits = findTermsInText(text, this.library, { listed }).filter((h) => !this.defined.has(h.id));
      const seen = new Set();
      let shift = 0;
      for (const hit of hits) {
        if (seen.has(hit.id)) continue;
        seen.add(hit.id);
        this.defined.add(hit.id);
        this.order.push(hit.id);
        const entry = this.library.terms[hit.id];
        const insert = ` (${entry.plain})`;
        const at = hit.index + hit.text.length + shift;
        text = `${text.slice(0, at)}${insert}${text.slice(at)}`;
        shift += insert.length;
      }
      return `${label}${text}`;
    });
  }
}

function listFromLabels(labels) {
  const items = labels.filter(Boolean);
  if (items.length <= 1) return items[0] || "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/** The brief for a topic: its concept's brief with the feature's own override laid over it. Defined in training-plan.js. */
export { briefFor };

function substitute(text, scenario, sample) {
  return String(text || "")
    .replace(/\{sampleQuestion\}/g, sample)
    .replace(/\{agentName\}/g, scenario.agentName)
    .replace(/\{domain\}/g, scenario.domain);
}

function minutesWord(n) {
  return `${n} minute${n === 1 ? "" : "s"}`;
}

function learnLinksFor(topic, brief) {
  const links = [];
  const add = (title, url) => {
    if (!url || !/^https:\/\/learn\.microsoft\.com\//i.test(url) || links.some((l) => l.url === url)) return;
    links.push({ title: plainText(title) || `Microsoft Learn: ${topic.title}`, url });
  };
  for (const l of brief?.learn || []) add(l.title, l.url);
  for (const t of topic.learnTakeaways || []) add(t.title, t.url);
  for (const url of topic.docUrls || []) add(`Microsoft Learn: ${topic.title}`, url);
  return links.slice(0, 4);
}

/** Sentences from catalog text that are safe and short enough for a slide. A sentence that names an interface label is left out. */
function slideSentences(text, { maxWords = 28, maxGrade = 12, limit = 2 } = {}) {
  const out = [];
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  for (const piece of raw.split(/(?<=[.!?])\s+(?=[A-Z])/)) {
    if (!isConceptSentence(piece)) continue;
    const sentence = plainText(piece);
    if (sentence.split(/\s+/).length > maxWords || fleschKincaid(sentence).grade > maxGrade) continue;
    out.push(endWithPeriod(sentence));
    if (out.length >= limit) break;
  }
  return out;
}

function pickSample(scenario, topic, index = 0) {
  const own = String(topic.facts?.samplePrompt || "").trim();
  if (own.length >= 8 && own.length <= 160 && !/[<>{}]/.test(own)) return own;
  const list = scenario.sampleQuestions;
  return list[index % list.length];
}

function tag(prefix, name) {
  return `${prefix}: ${name}`;
}

/**
 * Build the slides of one topic deck.
 *
 * @param {object} plan   from buildTrainingPlan
 * @param {object} topic  one entry of plan.topics
 * @param {{library?: object, defined?: Set<string>, introduced?: Map<string, string>, complete?: boolean}} [options]
 *   `defined` and `introduced` are shared across a combined deck so nothing is explained twice. A standalone deck
 *   starts with both empty.
 */
export function buildTopicDeck(plan, topic, { library = loadTrainingLibrary(), defined = new Set(), introduced = new Map(), complete = false } = {}) {
  const glossary = new Glossary(library, defined);
  const brief = briefFor(topic, library);
  const scenario = plan.scenario;
  const name = topic.title;
  const short = topic.short;
  const sampleIndex = topic.order - 1;
  const sample = pickSample(scenario, topic, sampleIndex);
  const listed = new Set(brief?.terms || []);
  const slides = [];
  const total = topic.thin ? TRAINING_MINUTES.short : topic.minutes;
  const priorConcept = topic.conceptId && introduced.has(topic.conceptId) ? introduced.get(topic.conceptId) : null;

  const add = (slide) => {
    slides.push({ ...slide, texts: slide.texts || [] });
    return slide;
  };

  const featureLine = describeFeature(name, topic.summary);
  const levelText = topic.level ? `Level ${topic.level}` : "";
  const kindLabel = topic.isRecap ? "Refresher" : "Topic";

  // ── Title with the three outcomes ────────────────────────────────────────
  const blockLabels = (brief?.blocks || []).slice(0, 4).map((b) => b.label.toLowerCase());
  const outcomes = topic.thin
    ? [`Say what ${name} is, using what Microsoft Learn says`, `Know what to check before you try it`, `Know what you will do in the hands-on lab`]
    : [
        `Explain ${name} in plain words`,
        blockLabels.length >= 3 ? `Name its main parts: ${listFromLabels(blockLabels)}` : `Describe how it works from start to finish`,
        `Know when to use it, and what to check first`,
      ];
  add({
    kind: "title",
    id: "title",
    title: name,
    eyebrow: `${topic.isRecap ? "REFRESHER" : "TRAINING"} · ${(getProduct(topic.productId)?.shortName || "").toUpperCase()}`.replace(/ · $/, ""),
    body: { subtitle: plan.labTitle, tags: [kindLabel, levelText, `about ${total} minutes`].filter(Boolean), outcomesHeading: "In this session you will learn", outcomes },
    texts: [name, plan.labTitle, ...outcomes],
  });

  // ── Why it matters ───────────────────────────────────────────────────────
  // Few new words here: the scenario is the warm-up, so a sentence that needs several explanations is left for later.
  const wordsNow = () => {
    const sim = new Glossary(library, new Set(defined));
    for (const s of slides) sim.newTerms([s.title, ...s.texts], listed);
    return sim;
  };
  const situation = firstSentence(scenario.problem, 190);
  const contextLine = `In this lab you help ${scenario.audience} with ${scenario.agentName}.`;
  const calm = (...parts) => wordsNow().peek([situation, ...parts, contextLine], listed).length <= 2;
  // A summary from the lab reads like a task ("Confirm or turn on ..."), so without a "why it matters" sentence
  // the box lists the curated "when to use it" notes, which read fine as a short list.
  const whySentence = slideSentences(topic.whyItMatters, { limit: 4 }).find((s) => calm(s));
  const useItems = !whySentence && !topic.thin ? (brief?.whenToUse || []).map((line) => endWithPeriod(plainText(line))).filter(Boolean) : [];
  const helpsItems = [];
  for (const item of useItems) {
    if (helpsItems.length >= 2) break;
    if (calm(item, ...helpsItems)) helpsItems.push(item);
  }
  if (!whySentence && !helpsItems.length && useItems.length) helpsItems.push(useItems[0]);
  const helps = whySentence || helpsItems.join(" ") || describeFeature(name, topic.summary);
  const whyBody = {
    situationHeading: "The situation",
    situation,
    helpsHeading: helpsItems.length ? "Where it helps" : `How ${short} helps`,
    helps,
    helpsItems,
    context: contextLine,
  };
  if (!topic.thin) {
    add({ kind: "scenario", id: "why", title: tag("Why it matters", short), eyebrow: "WHY IT MATTERS", body: whyBody, texts: [situation, whyBody.helps, whyBody.context] });
  }

  // ── What is it? ──────────────────────────────────────────────────────────
  const pictureLeft = "A request comes in";
  const pictureRight = "A result goes out";
  const definitionSentence = brief?.definition && !topic.thin ? endWithPeriod(brief.definition) : featureLine;
  const definitionBody = {
    sentence: definitionSentence,
    analogy: brief?.analogy && !topic.thin ? endWithPeriod(brief.analogy) : "",
    thisTopic: topic.thin || !brief?.definition ? (featureLine && featureLine !== definitionSentence ? featureLine : "") : "",
    picture: { left: pictureLeft, middle: short, right: pictureRight },
    pictureAlt: `Simple picture of three boxes joined by arrows: a request comes in, ${short} does its work, and a result goes out.`,
    learnOnly: topic.thin,
  };
  if (priorConcept && complete) {
    // The idea behind this topic was explained earlier in the combined deck: point back, do not say it again.
    const addsItems = [!topic.thin && brief?.whenToUse?.[0] ? helpLine(name, brief.whenToUse[0]) : featureLine, ...slideSentences(topic.concepts.join(" "), { limit: 3, maxWords: 24 })].filter(Boolean).slice(0, 4);
    add({
      kind: "adds",
      id: "adds",
      title: tag("What this adds", short),
      eyebrow: "BUILDING ON",
      body: {
        recall: `This builds on the idea from ${priorConcept}. If you need a reminder, go back to that section.`,
        heading: `What ${short} adds`,
        items: addsItems,
      },
      texts: addsItems,
    });
  } else {
    add({
      kind: "definition",
      id: "what",
      title: topic.thin ? tag("What it is", short) : `What is ${short}?`,
      eyebrow: "WHAT IS IT?",
      body: definitionBody,
      alt: definitionBody.pictureAlt,
      texts: [definitionBody.sentence, definitionBody.analogy, definitionBody.thisTopic, pictureLeft, short, pictureRight],
    });
  }

  // ── You will need to know ────────────────────────────────────────────────
  let needItems = [];
  for (const conceptId of topic.prereqConceptIds || []) {
    if (introduced.has(conceptId) && complete) continue;
    const b = library.concepts[conceptId];
    if (!b?.needToKnow) continue;
    const label = getConcepts().find((c) => c.id === conceptId)?.name || conceptId;
    needItems.push({ head: label, text: wholeSentences(b.needToKnow, 230, 2) || b.needToKnow, conceptId });
  }
  // Keep the slide calm: no more new words than the "word to know" line can hold. The count is made as the deck stands now.
  const wordsSoFar = () => {
    const sim = new Glossary(library, new Set(defined));
    for (const s of slides) sim.newTerms([s.title, ...s.texts], listed);
    return sim;
  };
  while (needItems.length > 1) {
    const probe = new Set([...listed, ...needItems.flatMap((i) => library.concepts[i.conceptId]?.terms || [])]);
    if (wordsSoFar().peek(needItems.flatMap((i) => [i.head, i.text]), probe).length <= 4) break;
    needItems = needItems.slice(0, -1);
  }
  if (needItems.length && !topic.thin) {
    for (const item of needItems) for (const termId of library.concepts[item.conceptId]?.terms || []) listed.add(termId);
    add({
      kind: "needToKnow",
      id: "need",
      title: tag("You will need to know", short),
      eyebrow: "BEFORE YOU START",
      body: { intro: "This builds on a few ideas. Here they are in plain words.", items: needItems },
      texts: needItems.flatMap((i) => [i.head, i.text]),
    });
  }

  // ── Building blocks and how it works (concept level; said once across a combined deck) ──
  const ov = (topic.id && library.featureOverrides[topic.id]) || {};
  const showFull = Boolean(brief) && !topic.thin;
  if (showFull && (!priorConcept || ov.blocks)) {
    add({
      kind: "blocks",
      id: "blocks",
      title: tag("The building blocks", short),
      eyebrow: "THE BUILDING BLOCKS",
      body: { nodes: brief.blocks },
      alt: `Diagram of ${brief.blocks.length} building blocks: ${brief.blocks.map((b) => `${b.label}, ${plainText(b.plain)}`).join("; ")}`,
      texts: brief.blocks.flatMap((b) => [b.label, b.plain]),
    });
  }
  if (showFull && (!priorConcept || ov.flow)) {
    add({
      kind: "flow",
      id: "flow",
      title: tag("How it works", short),
      eyebrow: "HOW IT WORKS",
      body: { steps: brief.flow },
      alt: `Flow diagram with ${brief.flow.length} steps: ${brief.flow.map((s) => s.label).join(", then ")}.`,
      texts: brief.flow.flatMap((s) => [s.label, s.plain]),
    });
  }

  // ── See it in action ─────────────────────────────────────────────────────
  if (showFull && (!priorConcept || ov.example)) {
    const input = substitute(brief.example.input, scenario, sample);
    const output = substitute(brief.example.output, scenario, sample);
    const expect = slideSentences(topic.validation[0] || "", { limit: 1, maxWords: 26 })[0] || "";
    add({
      kind: "example",
      id: "example",
      title: tag("See it in action", short),
      eyebrow: "SEE IT IN ACTION",
      body: {
        inputHeading: "What starts it",
        input,
        inputIsQuestion: /\?\s*["”]?$/.test(input.trim()),
        outputHeading: "What you get",
        output,
        expect: expect ? `In the lab you can check: ${lowerFirst(expect)}` : "",
      },
      texts: [input, output, expect],
    });
  }

  // ── When to use it, and when not to ──────────────────────────────────────
  if (showFull && (!priorConcept || ov.whenToUse || ov.whenNot)) {
    add({
      kind: "fit",
      id: "fit",
      title: tag("When to use it, and when not to", short),
      eyebrow: "GOOD FIT, NOT A FIT",
      body: { useHeading: "A good fit when", use: brief.whenToUse.slice(0, 4), notHeading: "Not a good fit when", not: brief.whenNot.slice(0, 4) },
      texts: [...brief.whenToUse.slice(0, 4), ...brief.whenNot.slice(0, 4)],
    });
  }

  // ── Things to know before you start ──────────────────────────────────────
  const know = [];
  know.push({ label: "Availability", text: topic.availability.text, confirmed: topic.availability.confirmed });
  const product = getProduct(topic.productId);
  if (product?.licenseNote) know.push({ label: "Licensing", text: wholeSentences(product.licenseNote, 200, 2) || firstSentence(product.licenseNote, 200), confirmed: !/Not confirmed in Microsoft Learn/i.test(product.licenseNote) });
  if (topic.limits.length) know.push({ label: "Limits that matter", text: wholeSentences(topic.limits.join(" "), 230, 2), confirmed: true });
  const dataNote = brief?.dataNote ? endWithPeriod(brief.dataNote) : "";
  know.push(dataNote ? { label: "Your data", text: dataNote, confirmed: true } : { label: "Your data", text: "Not confirmed in Microsoft Learn for this topic: what happens to data.", confirmed: false });
  if (topic.prereqNames.length) know.push({ label: "Builds on", text: `${listFromLabels(topic.prereqNames.slice(0, 3))}.`, confirmed: true });
  add({
    kind: "know",
    id: "know",
    title: tag("Things to know before you start", short),
    eyebrow: "BEFORE YOU START",
    body: { items: know.slice(0, 5) },
    texts: know.flatMap((k) => [k.label, k.text]),
  });

  // ── Key terms: filled in after every slide has been scanned ──────────────
  const termsPlaceholderIndex = slides.length;

  // ── Check your understanding ─────────────────────────────────────────────
  if (showFull && (!priorConcept || ov.quiz)) {
    const questions = brief.quiz.slice(0, 4);
    add({
      kind: "quiz",
      id: "quiz",
      title: tag("Check your understanding", short),
      eyebrow: "CHECK YOUR UNDERSTANDING",
      body: { questions: questions.map((q) => ({ q: q.q, options: q.options })) },
      texts: questions.flatMap((q) => [q.q, ...q.options]),
    });
  }

  // ── What you will do in the hands-on lab ─────────────────────────────────
  const goal = toYouWill(topic.facts.whatYouAreDoing && isConceptSentence(plainText(topic.facts.whatYouAreDoing)) ? topic.facts.whatYouAreDoing : topic.summary);
  const labTime = topic.handsOnMinutes ? `about ${minutesWord(topic.handsOnMinutes)}` : "about the time shown in the lab guide";
  add({
    kind: "labPreview",
    id: "lab",
    title: tag("Your hands-on lab", short),
    eyebrow: "WHAT YOU WILL DO NEXT",
    body: {
      moduleLabel: `${topic.stepLabel}: ${name}`,
      time: topic.isRecap ? `A short refresher, ${labTime}` : `Hands-on time: ${labTime}`,
      outcome: goal,
      note: "The lab guide gives you the steps. Today is only about the ideas.",
    },
    texts: [name, goal],
  });

  // ── Learn more ───────────────────────────────────────────────────────────
  const links = learnLinksFor(topic, brief);
  add({ kind: "learn", id: "learn", title: tag("Learn more", short), eyebrow: "LEARN MORE", body: { links, intro: "These Microsoft Learn pages are the source for this session." }, texts: [] });

  // ── Words to know: strips on the slides, then the glossary slide ────────
  for (const slide of slides) {
    if (slide.kind === "terms") continue;
    const scan = [slide.title, ...slide.texts];
    slide.words = glossary.newTerms(scan, listed);
  }
  const glossaryIds = [...glossary.order];
  if (glossaryIds.length) {
    const chunks = [];
    for (let i = 0; i < glossaryIds.length && chunks.length < 2; i += 6) chunks.push(glossaryIds.slice(i, i + 6));
    const termSlides = chunks.map((chunk, i) => ({
      kind: "terms",
      id: `terms${i + 1}`,
      title: tag(`Key terms${chunks.length > 1 ? ` (${i + 1} of ${chunks.length})` : ""}`, short),
      eyebrow: "KEY TERMS",
      body: { items: chunk.map((id) => ({ term: library.terms[id].term, plain: library.terms[id].plain })) },
      words: [],
      texts: [],
    }));
    slides.splice(termsPlaceholderIndex, 0, ...termSlides);
  }

  // ── Minutes and speaker notes ────────────────────────────────────────────
  const minutes = allocateMinutes(slides.map((s) => s.kind), total);
  slides.forEach((slide, i) => {
    slide.minutes = minutes[i];
  });
  const ctx = { plan, topic, brief, scenario, sample, short, name, total, library, links, outcomes, needItems, know, complete, priorConcept, featureLine, goal, labTime, glossaryIds };
  slides.forEach((slide, i) => {
    // The glossary slides read definitions aloud; their notes are not scanned for more words to explain.
    const noGloss = slide.kind === "terms";
    const lines = notesFor(slide, ctx, i, slides.length);
    slide.notes = noGloss ? lines : glossary.glossNotes(lines, listed);
  });
  if (topic.presenterNotes.length) {
    slides[0].notes = [`REVIEW FIRST: ${topic.presenterNotes[0]}`, ...topic.presenterNotes.slice(1).map((n) => `PRESENTER NOTE: ${n}`), ...slides[0].notes];
  }

  if (brief?.conceptId && !priorConcept) introduced.set(brief.conceptId, name);

  return {
    kind: "topic",
    order: topic.order,
    title: name,
    short,
    stepLabel: topic.stepLabel,
    isRecap: topic.isRecap,
    minutes: total,
    unreviewed: topic.unreviewed,
    thin: topic.thin,
    conceptId: topic.conceptId,
    slides,
    termsDefined: [...glossary.order],
    alt: `Training deck for ${name}`,
  };
}

function notesFor(slide, c, index, count) {
  const { topic, brief, scenario, short, name, links } = c;
  const t = `TIME: about ${minutesWord(slide.minutes)}.`;
  const lines = [t];
  const say = (text) => lines.push(`SAY: ${text}`);
  const ask = (text) => lines.push(`ASK THE ROOM: ${text}`);
  switch (slide.kind) {
    case "title":
      say(`Welcome, everyone. In this short session we look at ${name}. You do not need any background. We start at the beginning and use everyday words.`);
      say(`By the end you will be able to do three things. ${c.outcomes.map((o, i) => `${["First", "Second", "Third"][i]}, ${lowerFirst(o)}.`).join(" ")}`);
      say("This is a talk before the hands-on lab, so there is nothing to click today. You will do the steps later, with the lab guide in front of you.");
      ask("Has anyone used something like this before? A show of hands is fine.");
      lines.push(`TOTAL: this deck takes about ${minutesWord(c.total)}. Each slide shows its own time in these notes.`);
      break;
    case "scenario":
      say(`Let me start with a real situation from this lab. ${slide.body.situation}`);
      say(`Here is why ${short} matters. ${slide.body.helps}`);
      say(slide.body.context);
      if (brief?.sayOutLoud) lines.push(`EXAMPLE TO SAY OUT LOUD: ${brief.sayOutLoud}`);
      ask(brief?.askTheRoom || `Where do people in your own team lose time on something like this?`);
      break;
    case "definition":
      say(slide.body.sentence || c.featureLine);
      if (slide.body.analogy) say(slide.body.analogy);
      if (slide.body.thisTopic) say(`In this topic, that means: ${slide.body.thisTopic}`);
      say(`Look at the picture. A request comes in on the left. ${short} does its work in the middle. A result goes out on the right.`);
      lines.push("TIP: Say the one-sentence definition twice, slowly. Everything later builds on it.");
      ask(`In your own words, what does ${short} do? Take one or two answers.`);
      if (topic.thin) lines.push("SOURCE: This slide follows Microsoft Learn. Read the Learn page before you present, because nobody has reviewed this topic by hand.");
      break;
    case "adds":
      say(slide.body.recall);
      say(`Here is what is new in this topic. ${slide.body.items.join(" ")}`);
      ask("What would you reuse from the earlier section, and what is new here?");
      break;
    case "needToKnow":
      say("Some people skip the earlier levels, so here are the ideas this topic builds on. Keep it short: one or two sentences each.");
      for (const item of slide.body.items) say(`${item.head}: ${item.text}`);
      ask("Which of these is new to you? It is fine if all of them are.");
      break;
    case "blocks":
      say(`There are ${slide.body.nodes.length} parts. Walk the diagram from left to right.`);
      for (const n of slide.body.nodes) say(`${n.label}: ${plainText(n.plain)}`);
      ask("Which of these parts do you already know from another tool you use?");
      break;
    case "flow":
      say("This is what happens when it runs. Tell it like a short story, one step at a time.");
      slide.body.steps.forEach((s, i) => say(`Step ${i + 1}, ${s.label}: ${plainText(s.plain)}`));
      ask("At which step could something go wrong? There is no wrong answer.");
      break;
    case "example": {
      const input = plainText(slide.body.input).replace(/^["“]|["”]$/g, "");
      const lead = slide.body.inputIsQuestion ? `Someone asks, "${input}"` : `Picture this. ${endWithPeriod(input)}`;
      lines.push(`EXAMPLE TO SAY OUT LOUD: ${lead} Here is what happens. ${endWithPeriod(plainText(slide.body.output))}`);
      if (brief?.demo) lines.push(`DEMO IF THERE IS TIME: ${brief.demo}`);
      else lines.push("DEMO IF THERE IS TIME: Show a finished example on screen, without changing any settings.");
      if (slide.body.expect) say(`When you do the lab, you will check this yourself. ${slide.body.expect}`);
      ask("What would you ask it first if you were in this scenario?");
      break;
    }
    case "fit":
      say("Be honest about limits. Knowing when not to use something saves a lot of time.");
      say(`A good fit: ${slide.body.use.map(plainText).join(" ")}`);
      say(`Not a good fit: ${slide.body.not.map(plainText).join(" ")}`);
      ask("Think of one task in your work. Is it a good fit or not? Why?");
      break;
    case "know":
      say("These are the facts to check before you start. I will say plainly where Microsoft Learn does not tell us.");
      for (const item of slide.body.items) {
        if (item.confirmed) say(`${item.label}: ${item.text}`);
        else lines.push(`PRESENTER CHECK: ${item.label}: ${item.text} If someone asks, say you will confirm it on Microsoft Learn and tell them after the session. Do not guess.`);
      }
      for (const l of links.slice(0, 2)) lines.push(`SOURCE: ${l.title}, ${l.url}`);
      ask("Is there anything here your organization would need to check before you start?");
      break;
    case "terms":
      say("Here are the words from this session in one place. Read each one aloud and ask whether it makes sense.");
      for (const item of slide.body.items) say(`${item.term}: ${item.plain}.`);
      ask("Which word was new to you today?");
      break;
    case "quiz":
      say("These questions are for the room. Read each one aloud, give people a moment, and then share the answer below. There are no grades.");
      (brief?.quiz || []).slice(0, 4).forEach((q, i) => {
        lines.push(`ANSWER ${i + 1}: ${["A", "B", "C", "D"][q.answer]}, ${endWithPeriod(plainText(q.options[q.answer]).replace(/[.]+$/, ""))} ${plainText(q.why)}`);
      });
      ask("Which question was the hardest? Why?");
      break;
    case "labPreview":
      say(`After this session you will do ${short} yourself in the hands-on lab. ${slide.body.time}.`);
      say(slide.body.outcome);
      say("The lab guide has every step, so you do not need to remember anything from today. The ideas are what matter.");
      ask("What would make the hands-on lab easier for you? Write down any questions to bring with you.");
      break;
    case "learn":
      say("These pages are the official source. If something changes, Microsoft Learn is right and this deck is not.");
      for (const l of links) lines.push(`SOURCE: ${l.title}, ${l.url}`);
      say("Thank you. Questions before we move on?");
      break;
    default:
      break;
  }
  if (index === count - 1 && !["learn"].includes(slide.kind)) lines.push("CLOSE: Thank the group and move to the next part.");
  return lines;
}

// ───────────────────────────────────────────────────────────────────────────
// Foundations decks
// ───────────────────────────────────────────────────────────────────────────

/**
 * Build one product's foundations deck (about 8 slides, 12 minutes). `topics` are the lab topics of this product,
 * used for the "how the day is organized" slide.
 */
export function buildFoundationsDeck(plan, foundation, { library = loadTrainingLibrary(), defined = new Set(), complete = false } = {}) {
  const glossary = new Glossary(library, defined);
  const brief = library.products[foundation.productId] || null;
  const product = getProduct(foundation.productId);
  const short = foundation.short;
  const name = foundation.name;
  const total = foundation.minutes;
  const slides = [];
  const topics = plan.topics.filter((t) => t.productId === foundation.productId);
  const thin = !brief || brief.thin;
  const vocabIds = (brief?.vocabulary || []).filter((id) => library.terms[id]);
  const listed = new Set(vocabIds);

  const outcomes = [`Say what ${name} is and who uses it`, thin ? "Know the few words you will hear in this lab" : "Name its main building blocks and how they fit together", "Know where you will work and how the day runs"];
  slides.push({
    kind: "title",
    id: "title",
    title: `Foundations: ${short}`,
    eyebrow: "TRAINING · START HERE",
    body: { subtitle: plan.labTitle, tags: ["Foundations", `about ${total} minutes`], outcomesHeading: "In this session you will learn", outcomes },
    texts: [short, plan.labTitle, ...outcomes],
  });

  const whatItIs = brief?.whatItIs ? endWithPeriod(brief.whatItIs) : endWithPeriod(plainText(product?.summary || ""));
  const whoUses = brief?.whoUses ? endWithPeriod(brief.whoUses) : "";
  slides.push({
    kind: "what",
    id: "what",
    title: `What is ${short}?`,
    eyebrow: "WHAT IS IT?",
    body: { sentence: whatItIs, whoHeading: "Who uses it", who: whoUses },
    texts: [whatItIs, whoUses],
  });

  if (vocabIds.length) {
    // One calm slide of the six words every topic leans on; any others are explained where they first appear.
    const chunk = vocabIds.slice(0, 6);
    slides.push({
      kind: "vocab",
      id: "vocab1",
      title: `Words you will hear today: ${short}`,
      eyebrow: "SHARED VOCABULARY",
      body: { items: chunk.map((id) => ({ term: library.terms[id].term, plain: library.terms[id].plain })) },
      words: [],
      texts: [],
      vocabIds: chunk,
    });
  }

  if (brief && !thin) {
    slides.push({
      kind: "blocks",
      id: "blocks",
      title: `The main building blocks of ${short}`,
      eyebrow: "THE BUILDING BLOCKS",
      body: { nodes: brief.blocks },
      alt: `Diagram of ${brief.blocks.length} building blocks of ${short}: ${brief.blocks.map((b) => `${b.label}, ${plainText(b.plain)}`).join("; ")}`,
      texts: brief.blocks.flatMap((b) => [b.label, b.plain]),
    });
    if (brief.fit?.center && (brief.fit.around || []).length >= 3) {
      slides.push({
        kind: "fitHub",
        id: "fit",
        title: `How the pieces fit together: ${short}`,
        eyebrow: "HOW IT FITS TOGETHER",
        body: { center: brief.fit.center, around: brief.fit.around },
        alt: `Hub diagram: ${brief.fit.center.label} in the middle, connected to ${brief.fit.around.map((a) => a.label).join(", ")}.`,
        texts: [brief.fit.center.label, brief.fit.center.plain, ...brief.fit.around.flatMap((a) => [a.label, a.plain])],
      });
    }
  }

  const harnessLine = plan.harnessName && foundation.productId === "copilot-studio" ? `In this lab you build on the ${plan.harnessName}.` : "";
  const where = brief?.whereYouWork ? endWithPeriod(brief.whereYouWork) : "";
  if (where || harnessLine) {
    slides.push({
      kind: "where",
      id: "where",
      title: `Where you will work: ${short}`,
      eyebrow: "WHERE YOU WILL WORK",
      body: { sentence: where, harness: harnessLine, note: "You will not need to remember where things are. The lab guide shows you." },
      texts: [where, harnessLine],
    });
  }

  if (!complete) {
    const rows = topics.map((t) => ({ label: `${t.stepLabel}: ${t.title}`, training: t.minutes, handsOn: t.handsOnMinutes }));
    slides.push({
      kind: "day",
      id: "day",
      title: `How the day is organized: ${short}`,
      eyebrow: "HOW THE DAY RUNS",
      body: {
        intro: "First the training, with no clicking. Then the hands-on lab.",
        rows: rows.slice(0, 8),
        more: rows.length > 8 ? `${rows.length - 8} more topics` : "",
        totals: { training: total + topics.reduce((s, t) => s + t.minutes, 0), handsOn: topics.reduce((s, t) => s + (t.handsOnMinutes || 0), 0) },
      },
      texts: rows.slice(0, 8).map((r) => r.label),
    });
  }

  const links = (brief?.learn || []).slice(0, 4);
  slides.push({ kind: "learn", id: "learn", title: `Learn more: ${short}`, eyebrow: "LEARN MORE", body: { links, intro: "These Microsoft Learn pages are the source for this session." }, texts: [] });

  for (const slide of slides) {
    if (slide.kind === "vocab") {
      glossary.define(slide.vocabIds);
      continue;
    }
    slide.words = glossary.newTerms([slide.title, ...slide.texts], listed);
  }

  const minutes = allocateMinutes(slides.map((s) => s.kind), total);
  slides.forEach((slide, i) => {
    slide.minutes = minutes[i];
  });
  const ctx = { plan, foundation, brief, short, name, total, links, topics, thin };
  slides.forEach((slide, i) => {
    slide.notes = glossary.glossNotes(foundationNotes(slide, ctx, i, slides.length), listed);
  });
  if (thin) {
    slides[0].notes = [
      `REVIEW FIRST: ${brief?.thinNote || "Microsoft Learn does not give enough to build a full foundations deck for this product, so this one is short on purpose. Read the Learn pages before you present, and do not add details Learn does not state."}`,
      ...slides[0].notes,
    ];
  }

  return { kind: "foundations", productId: foundation.productId, title: `Foundations: ${short}`, short, minutes: total, thin, unreviewed: thin, slides, termsDefined: [...glossary.order] };
}

function foundationNotes(slide, c, index, count) {
  const { brief, short, name, links, plan } = c;
  const lines = [`TIME: about ${minutesWord(slide.minutes)}.`];
  const say = (text) => lines.push(`SAY: ${text}`);
  const ask = (text) => lines.push(`ASK THE ROOM: ${text}`);
  switch (slide.kind) {
    case "title":
      say(`Welcome. Before we look at any single topic, this short session sets the scene for ${name}. You do not need any background.`);
      say(`By the end you will know what ${short} is, the main parts and words, and how today is organized.`);
      if (brief?.sayOutLoud) lines.push(`EXAMPLE TO SAY OUT LOUD: ${brief.sayOutLoud}`);
      ask(brief?.askTheRoom || `Who has seen ${short} before, even once?`);
      break;
    case "what":
      say(slide.body.sentence);
      if (slide.body.who) say(`Who uses it: ${slide.body.who}`);
      ask("Where could something like this help in your own work?");
      break;
    case "blocks":
      say(`${short} is made of ${slide.body.nodes.length} main parts. Walk through them from left to right.`);
      for (const n of slide.body.nodes) say(`${n.label}: ${plainText(n.plain)}`);
      ask("Which of these parts sounds most useful to you?");
      break;
    case "fitHub":
      say(`${slide.body.center.label} is in the middle: ${plainText(slide.body.center.plain)} Everything else connects to it.`);
      for (const a of slide.body.around) say(`${a.label}: ${plainText(a.plain)}`);
      ask("If one of these parts were missing, what could not happen?");
      break;
    case "vocab":
      say("These are the words you will hear all day. You do not need to memorize them. Come back to this slide whenever a word is new.");
      for (const item of slide.body.items) say(`${item.term}: ${item.plain}.`);
      ask("Which of these words have you heard before? Which are new?");
      break;
    case "where":
      say(slide.body.sentence || "Your lab guide shows you exactly where to work.");
      if (slide.body.harness) say(slide.body.harness);
      lines.push("TIP: Do not describe screens or menus from memory. Products change often, and the lab guide is always current.");
      break;
    case "day":
      say("Here is how the day runs. First we go through the ideas with no clicking. Then you do the hands-on lab.");
      for (const r of slide.body.rows) say(`${r.label}: about ${r.training} minutes of training, then about ${r.handsOn ?? "?"} minutes hands-on.`);
      say(`In total: about ${slide.body.totals.training} minutes of training and about ${slide.body.totals.handsOn} minutes hands-on.`);
      ask("Does the schedule work for everyone? Do we need a break after the training?");
      break;
    case "learn":
      say("These pages are the official source. If something here is out of date, trust Microsoft Learn.");
      for (const l of links) lines.push(`SOURCE: ${l.title}, ${l.url}`);
      break;
    default:
      break;
  }
  if (index === count - 1 && slide.kind !== "learn") lines.push("CLOSE: Move on to the first topic.");
  void plan;
  return lines;
}

// ───────────────────────────────────────────────────────────────────────────
// The complete deck
// ───────────────────────────────────────────────────────────────────────────

/**
 * One deck for the whole lab: a title, the running agenda, then for each product its foundations and for each topic
 * its training slides in the lab's teaching order, each section opened by a divider that shows where you are.
 * Terms and ideas are explained once: later sections point back instead of repeating.
 */
export function buildCompleteDeck(plan, { library = loadTrainingLibrary() } = {}) {
  const defined = new Set();
  const introduced = new Map();
  const sections = [];
  for (const foundation of plan.foundations) {
    const deck = buildFoundationsDeck(plan, foundation, { library, defined, complete: true });
    sections.push({ type: "foundations", name: `Foundations: ${foundation.short}`, minutes: deck.minutes, deck, thin: deck.thin });
  }
  for (const topic of plan.topics) {
    const deck = buildTopicDeck(plan, topic, { library, defined, introduced, complete: true });
    sections.push({ type: "topic", name: `${topic.stepLabel}: ${topic.title}`, minutes: deck.minutes, deck, thin: deck.thin, unreviewed: deck.unreviewed });
  }

  const totalMinutes = sections.reduce((s, x) => s + x.minutes, 0);
  const slides = [];
  const hands = plan.handsOnMinutes;

  slides.push({
    kind: "title",
    id: "title",
    title: `Training deck: ${plan.labTitle}`,
    eyebrow: "TRAINING · DELIVER FIRST",
    body: {
      subtitle: "For people who are new to this. No lab steps.",
      tags: [`${sections.length} parts`, `about ${totalMinutes} minutes`],
      outcomesHeading: "Today",
      outcomes: ["Learn the ideas and the words you will use", "See how each topic works, in plain language", "Then do the hands-on lab with confidence"],
    },
    texts: ["Learn the ideas and the words you will use", "See how each topic works, in plain language", "Then do the hands-on lab with confidence"],
    minutes: 1,
    notes: [
      "TIME: about 1 minute.",
      `SAY: Welcome. This is the training session that comes before the hands-on lab for ${plan.labTitle}. Nobody needs any background. We will go through the ideas in plain words, and then you will do the lab.`,
      `TOTAL: about ${minutesWord(totalMinutes)} for the whole session, with ${plan.topics.length} topic${plan.topics.length === 1 ? "" : "s"} and ${plan.foundations.length} foundations part${plan.foundations.length === 1 ? "" : "s"}. The hands-on lab is about ${minutesWord(hands)} after that.`,
      "ASK THE ROOM: What do you hope to be able to do after the lab? Write two or three answers on a board.",
    ],
    words: [],
  });

  const agendaRows = sections.map((s, i) => ({ n: i + 1, label: s.name, minutes: s.minutes, flag: s.unreviewed ? "unreviewed" : "" }));
  const agendaChunks = [];
  for (let i = 0; i < agendaRows.length; i += 12) agendaChunks.push(agendaRows.slice(i, i + 12));
  agendaChunks.forEach((chunk, i) => {
    slides.push({
      kind: "agenda",
      id: `agenda${i + 1}`,
      title: `Agenda${agendaChunks.length > 1 ? ` (${i + 1} of ${agendaChunks.length})` : ""}: ${plan.labTitle}`,
      eyebrow: "AGENDA",
      body: { rows: chunk, totalMinutes, handsOnMinutes: hands, showTotal: i === 0 },
      minutes: i === 0 ? 1 : 0,
      notes: [
        `TIME: about ${i === 0 ? "1 minute" : "no extra time"}.`,
        `SAY: Here is the plan. ${sections.length} parts, about ${minutesWord(totalMinutes)} in total. We start with the foundations, then take the topics in the same order as the lab.`,
        "ASK THE ROOM: Is there a topic you most want to hear about? We will make sure to cover it.",
        "TIP: Take a short break about halfway through if the total is longer than an hour.",
      ],
      words: [],
      texts: [],
    });
  });

  sections.forEach((section, i) => {
    slides.push({
      kind: "divider",
      id: `divider${i + 1}`,
      title: `Part ${i + 1} of ${sections.length}: ${section.name}`,
      eyebrow: "WHERE WE ARE",
      body: { rows: agendaRows, current: i, minutes: section.minutes, totalMinutes },
      minutes: 0,
      notes: [
        "TIME: under 1 minute.",
        `SAY: We are at part ${i + 1} of ${sections.length}: ${section.name}. This part takes about ${minutesWord(section.minutes)}.`,
        ...(section.deck.thin ? ["REVIEW FIRST: This part is short because Microsoft Learn does not give much to teach from. Read the Learn page before you present it."] : []),
      ],
      words: [],
      texts: [],
    });
    for (const slide of section.deck.slides) slides.push({ ...slide, section: i + 1 });
  });

  slides.push({
    kind: "closing",
    id: "closing",
    title: "Next: the hands-on lab",
    eyebrow: "WHAT HAPPENS NEXT",
    body: {
      intro: `Now you do the lab. It takes about ${minutesWord(hands)}.`,
      rows: plan.topics.map((t) => ({ label: `${t.stepLabel}: ${t.title}`, handsOn: t.handsOnMinutes })).slice(0, 10),
      more: plan.topics.length > 10 ? `${plan.topics.length - 10} more topics` : "",
    },
    minutes: 1,
    notes: [
      "TIME: about 1 minute.",
      `SAY: That is the end of the training. Next you do the hands-on lab, which takes about ${minutesWord(hands)}. The lab guide has every step, so use it.`,
      "ASK THE ROOM: Any questions before we start? Write down anything you want to come back to.",
    ],
    words: [],
    texts: [],
  });

  return {
    kind: "complete",
    title: `Training deck: ${plan.labTitle}`,
    minutes: totalMinutes,
    sections: sections.map((s, i) => ({ n: i + 1, name: s.name, minutes: s.minutes, type: s.type, thin: Boolean(s.thin), unreviewed: Boolean(s.unreviewed) })),
    slides,
    termsDefined: [...defined],
  };
}

/** Every piece of text a presenter would read or show in a deck: titles, body texts, strips, and notes. */
export function deckTexts(deck) {
  const out = [];
  for (const slide of deck.slides) {
    out.push(slide.title, ...(slide.texts || []), ...(slide.notes || []));
  }
  return out.filter(Boolean);
}
