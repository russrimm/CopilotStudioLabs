# AI writing (optional)

The Lab Builder can ask an AI model to reword parts of a lab and its decks for the audience, industry, department, level and scenario you chose. It is **optional, off by default, and chosen per lab**. With AI off, every lab, deck and guide is exactly what it was before: the same bytes, the same fingerprints, the same cache entries.

AI is a writing layer on top of the deterministic pipeline, not a source of facts. The model never decides a click path, a menu name, a connector name, a number, a product name, a URL or a licensing statement. Those come from the catalog and live Microsoft Learn, and a guard checks every AI passage against the text it replaces. A passage that fails the check keeps the standard text.

- [Modes, identity and cost](#modes-identity-and-cost)
- [Turn it on locally](#turn-it-on-locally)
- [What is sent, and what the model may write](#what-is-sent-and-what-the-model-may-write)
- [The guards](#the-guards)
- [How a lab is written: batches, time limits and retries](#how-a-lab-is-written-batches-time-limits-and-retries)
- [Choosing a model, and the prompt estimate](#choosing-a-model-and-the-prompt-estimate)
- [Measured on the real service](#measured-on-the-real-service)
- [Tuning](#tuning)
- [How the lab says AI wrote it](#how-the-lab-says-ai-wrote-it)
- [Cache, fingerprints and rebuilding](#cache-fingerprints-and-rebuilding)
- [Per-user sign-in with a GitHub App](#per-user-sign-in-with-a-github-app)
- [Your own model provider (BYOK)](#your-own-model-provider-byok)
- [Settings reference](#settings-reference)
- [Routes](#routes)
- [Command line](#command-line)
- [Deploying](#deploying)
- [What the SDK documents, with sources](#what-the-sdk-documents-with-sources)
- [Limits and open questions](#limits-and-open-questions)

## Modes, identity and cost

`AI_GENERATION` picks one mode. An unknown value, or a mode that is missing its settings, behaves as **off**.

| Mode | Who it is for | Whose Copilot allowance pays | Who may use it |
| --- | --- | --- | --- |
| `off` (default) | Everyone, and every deployment | Nobody | Nobody. The wizard shows one line: "AI writing is turned off on this server." |
| `local-user` | One person running the portal on their own PC | That PC's own Copilot sign-in (a stored login or `gh auth`) | Only requests that really come from that PC (see below) |
| `per-user` | A shared server where each visitor has Copilot | Each visitor's own GitHub account, through a GitHub App | A visitor who signed in with GitHub. Never anyone else. |
| `byok` | A server with its own model provider (for example Azure OpenAI) | The server's provider account | Only when portal sign-in is really on, or the portal is loopback-only |

The rule behind every mode: **a request for AI never runs on the owner's account or allowance unless the owner is the one at the keyboard.** So:

- The Azure portal runs with `PORTAL_AUTH_DISABLED=true` and is open to anyone with the address. AI there stays off. `local-user` refuses anything that is not loopback, `per-user` needs a visitor to sign in with their own GitHub account, and `byok` refuses when portal sign-in is off. An anonymous visitor therefore cannot spend anyone's quota.
- `local-user` accepts a request only when all of these hold: the portal is bound to a loopback address (`HOST=127.0.0.1`), the socket's remote address is loopback, there is no proxy header (`X-Forwarded-For`, `Forwarded`, `X-Forwarded-Host`, `X-Real-IP`), the `Host` header names this machine, and the browser did not mark the request cross-site or send a foreign `Origin`. A web page open on the same PC cannot make the owner's browser spend the owner's allowance.
- `per-user` keeps each visitor's GitHub token in server memory only. It is never put in a cookie (the cookie `ai_sid` is a random id), a log, a manifest or a response. It is passed to the SDK as that session's own token. One person's token is never used for another person.
- Per visitor, the server also limits labs, passages and tokens per day, and limits how many AI labs run at once across the server (see the [settings](#settings-reference)). The existing per-visitor rate limit and build queue still apply.
- Logs carry only counts, model ids, durations and outcomes. They never carry a prompt, source text, a token, a model answer or a person's identity. `portal/test/ai-modes.test.js` and `portal/test/ai-lab-build.test.js` scan logs, responses and the manifest for this.

## Turn it on locally

AI writing on your own PC uses your Copilot subscription. Each prompt counts toward your allowance, the same as Copilot CLI, and models differ in how many premium requests one prompt uses. GitHub does not report that number for every account (it reported none for the account this was measured on), so the wizard says "Cost not reported by GitHub; each prompt counts against your Copilot allowance" and shows how many prompts the lab will use instead. See [Choosing a model, and the prompt estimate](#choosing-a-model-and-the-prompt-estimate).

1. Sign in to Copilot on this PC, once, with either `copilot login` or `gh auth login`. A Copilot plan (or a Copilot trial) is required.
2. Start the portal bound to loopback with AI on:

   ```powershell
   cd portal
   $env:HOST = "127.0.0.1"
   $env:AI_GENERATION = "local-user"
   npm start
   ```

3. Open `http://127.0.0.1:3005`, choose Build a Lab, and on **Review and build** turn on **Write with AI (optional)**. The recommended model is already chosen; pick another if you like, choose what AI writes (the lab text, the training decks, the lab-day decks), read the prompt estimate, and build. While it builds, the page shows how many passages are done and how many prompts are used so far.
4. To check the SDK and your sign-in before a first build, run from the repository root: `node tools/lab-builder/ai-smoke.mjs`. It starts the SDK runtime and pings it, with no network call and no sign-in. Add `--models` to list your models, and `--say "<prompt>" --model <id>` for one short generation. Those two use your Copilot allowance.

If the card does not appear, open `/api/ai/status` and read `reason`. Common reasons: `off` (the setting), `not-local` (the request is not from this PC), `sdk-missing` (the optional package did not install or its runtime would not start), `copilot-sign-in-needed` (no Copilot sign-in found on this PC).

The SDK is an optional dependency. If it is missing or its runtime cannot start, every other feature works and the status says AI is not available on this server.

## What is sent, and what the model may write

**Sent to the model:** passages of the lab's own text. That is the lab's topic text from Microsoft Learn and the catalog, plus the scenario fields you typed (industry, audience, agent name, domain, problem, outcome). **Never sent:** tenant data, screenshots, files, tokens, or anything from a browser session.

Learn and catalog text is treated as untrusted data. It goes in as quoted source material, never as instructions. The model has no tools, so it cannot act on anything in it anyway.

**The model may reword** (same meaning, same order, clearer words for the audience):

| Part | Blocks |
| --- | --- |
| Lab text | The overview introduction, each module's "why it matters" and "In your scenario" text, the concepts, the steps, and troubleshooting symptom and fix pairs that the catalog authored |
| Training decks | The body text and speaker notes ("SAY" lines) of each slide, at the slide model, before any drawing |
| Lab-day decks | The concept bullets that feed the lab-day deck. The rest of the lab-day deck is built from the lab text, so it carries the reworded text when the lab text is on. |

**The model may not write:** product facts, click paths, menu or button names, connector names, numbers, URLs, code, or licensing statements. It also does not write knowledge-check questions (the answer keys and distractors are part of the product's promise, so they stay as authored), and it does not touch the picture, harness, library or ZIP naming rules.

## The guards

Every block is checked before it is used. If any check fails, that block keeps its standard text and the failure is counted (and shown as "kept as written" in the note, with the reason). A refusal is remembered for an hour (`AI_REJECT_CACHE_MS`), so a rebuild straight after does not pay for the same refusal again; an accepted passage is cached for good.

1. **Strict shape.** The model must answer with JSON that matches the schema (`portal/lib/ai/prompts.js`): one `text` for each passage id. Anything else is rejected. A passage the answer leaves out is asked for once more, then kept as written.
2. **No invented facts.** Every interface term, number, product or connector name, URL and code identifier in the source must still appear. Nothing new of those kinds may appear, except numbers and names that came from the scenario fields the person typed. Bold and backtick marks around protected terms are kept.
3. **Same structure.** A list of steps keeps the same count and order, and every item keeps its numbering or bullet. One bad item rejects the whole list, so a module never mixes two voices or loses a step.
4. **Length limits** against the source, by kind of block, and a slide's room for the text.
5. **No chatter, injection or markup.** Replies that start with "Sure" or "Certainly", say "here is the reworded text" (or any "here is" or "below is" that points at the text itself), mention instructions or the system prompt, add headings, HTML, code fences, new links, list marks, refusals or TODO words are rejected.
6. **Same final pipeline as the standard text.** AI text then goes through plain text (no emoji), US English, the connector display-name rewrite, the training guard that keeps lab steps and click paths out of training decks, the duplicate-slide guard, slide text fit and the lab quality gate. AI cannot bring back what earlier work removed.
7. **Fail soft.** If the model fails midway (time-out, quota, sign-in lost, or a run of rejected blocks), the lab still builds with the standard text for the rest, and the note says so.

### Matching that was too strict, and what changed

Every case below was a real refusal of a faithful rewording on the real service. None of them lets an invented fact through, and each has a test in `portal/test/ai-guard.test.js` with the opposite case beside it.

| What the model wrote | Why it was refused | What changed |
| --- | --- | --- |
| A presenter's line that opens with "Here's" or "Here are" and then says what the slide shows (9 passages) | "Here is" at the start counted as chatter. | Only talk about the text itself is chatter: "Here is the reworded text:", "Here's a quick rewrite", "Below is the updated note". |
| A sentence that opens with the plural noun "Teams" (2 passages) | "Teams" is on the list of product names, so the capital letter at the start of a sentence read as a new product. | `Teams`, `Excel` and `Outlook` at the start of a sentence are the plain word unless a product word follows ("Teams channel", "Excel users"). Anywhere else a capital still means the product, and a product named in the source must stay. |
| "Choose" at the start of a sentence where the source said "pick" (5 blocks) | "Choose" at the start of a sentence reads like a lab step. | "Choose" counts as "Pick" when the source already advised picking or choosing. "Select", "Open", "Click" and every other step verb are still refused, and so is "Choose" where the source never advised it. |

Refusals that stay, because they are right: a short slide line made more than a quarter longer, a source label such as "Step 4," turned into a numbered list item, and a step verb the source did not have. The prompt now tells the model about each of them, which cut them to about one block in 300 (see [Measured on the real service](#measured-on-the-real-service)).

## How a lab is written: batches, time limits and retries

A lab is written in two runs, in this order: the lab text and the concept points the lab-day decks use, then the training decks (which are planned from the finished lab text). Each run turns its blocks into requests like this (`portal/lib/ai/batching.js`, `portal/lib/ai/engine.js`):

1. **Passages, not lists.** Every sentence is its own passage with a short id (`p1`, `p2`, ...), and a passage that belongs to a list says "2 of 5". The answer is one `text` for each id. (Prompt version 1 sent a list as one block and asked for an `items` array. On the real service a model often wrote the whole list as one paragraph, so 67 of 97 training-deck blocks were refused as "count changed". That, not the time limit, was why decks kept the standard text.)
2. **Nothing is asked that is not worth asking.** A cached passage costs no call. A passage with nothing to reword (a bold label, a number, a code word, fewer than three plain words) is never sent, and it is not counted as kept or reworded. A list with a label in it sends the other items and keeps the label exactly.
3. **Batches by size.** Blocks are packed into requests of at most `AI_MAX_CHARS_PER_REQUEST` (3500) source characters and `AI_MAX_BLOCKS_PER_REQUEST` (16) blocks, from at most three scenarios. A block is never split, and one larger than the limit goes alone. A one-topic lab with all three outputs is about 12 requests.
4. **A time limit that scales.** The SDK takes the limit as the second argument of `sendAndWait`; a `timeout` inside the message is ignored, and the SDK then waits its default of 60 seconds. (The old code did that, so the 120 second setting never applied, and a call of 85 passages was cut off at 60 seconds that a retry finished in 38.) A call now gets 30 seconds plus 40 ms for each output token expected, at least 60 seconds, at most `AI_TIMEOUT_MS`.
5. **A few at a time.** Up to `AI_MAX_PARALLEL` (4) requests run at once in a lab, and `AI_MAX_CALLS_IN_FLIGHT` (8) is the ceiling across every lab being written on the server, on top of the per-visitor limits and `AI_MAX_CONCURRENT_LABS`.
6. **When a call goes wrong:**
   - A time-out, or an answer that is not the JSON asked for, splits the request in half by blocks and asks each half. A single block is asked once more.
   - A 429 or a 503 waits (the service's own `Retry-After` when it gives one, else 2, 4, 8 seconds with a little jitter), asks again up to `AI_RETRIES` times, and lowers the number of calls at once until three calls in a row succeed.
   - A passage left out of an answer is asked for once more.
   - An exhausted allowance, a refused sign-in or a cancel stops the run: the rest keeps the standard text.
   - Retries and halves share a budget of three quarters of the planned requests plus three, so a bad day cannot multiply the prompts.
7. **Reasoning.** Rewording needs no chain of thought, and thinking is most of what a call costs on a model that does it. When a model lists reasoning levels, the writer asks for `none`, else `low` (`AI_REASONING_EFFORT` changes that). On the real service this made a lab about six times faster (see below).
8. **Cancel.** The wizard's Cancel (and a dropped connection) aborts the run: no new request starts, calls in flight are abandoned, and every SDK session is disconnected and deleted. Measured against the real SDK: the build stopped 218 ms after the cancel, four sessions had been opened and four were disconnected, none were left open, and no call started after the cancel.
9. **Counts and timings only.** For each request the log has the number of blocks, passages and characters, the time limit, how long it took, the outcome, the tokens and the number running at once. `summary.calls` in the engine has the same. Never a prompt, a passage, an answer or a token.

Progress counts blocks done of the total (what was skipped is not in the total) and the prompts used so far. The manifest's `aiWriting.requests` and the "Prompts used" line of the note count every prompt, including retries and halves.

## Choosing a model, and the prompt estimate

The model picker lists the recommended model first, marked **recommended** with its plain reason, and chooses it for a person who has not chosen. `auto` and every other model the account offers stay in the list. The recommendation is `RECOMMENDED_MODELS` in `portal/lib/ai/models.js`: the first one the account offers wins.

**Recommended: `gpt-5.6-luna`.** It rewrote the whole of a one-topic lab, its training decks and its lab-day decks in 24 to 45 seconds on three different labs, with every passage accepted by the guard on all four builds. `gpt-6-luna` took about the same (30 seconds on one lab, one block refused for a list mark), `claude-haiku-5.5` and `mai-code-2-flash` took 37 to 51 seconds, and `claude-haiku-4.5`, which cannot turn thinking off, took 4 to 6 minutes. Its cost is not reported by GitHub. Every model uses the same number of prompts for the same lab, so the cost of a lab is the number of prompts times whatever that model charges for one.

Under the picker, the page says how many prompts the lab will use: "About 14 prompts for this lab with the parts ticked above. Cost is not reported by GitHub; each prompt counts against your Copilot allowance." When GitHub does report a multiplier, the line says how many premium requests that is. The count comes from the modules in the lab outline and the parts ticked (`portal/lib/ai/estimate.js`; the wizard carries the same formula, fed from `/api/ai/status`): the lab text is about `1 + 0.55 x modules` prompts, the training decks `3 + 3.5 x modules`, and 10% on top for retries. Those numbers come from counting what the engine would ask for real labs of 2, 6 and 9 modules without calling a model (`node tools/lab-builder/ai-measure.mjs --plan-only ...`): 2, 4 and 6 requests for the lab text and 10, 24 and 35 for the decks. A lab with all three parts on and 2 modules is 12 requests, and the page says about 14: the extra tenth leaves room for the retries a slow day costs (the measured labs used exactly the planned requests on `gpt-5.6-luna` and up to 8 more on `claude-haiku-4.5`).

## Measured on the real service

Measured on 2026-11-25 and 2026-11-26 with this PC's own Copilot sign-in (`local-user`), the SDK 2.0.1-preview.0, one-topic labs, `tools/lab-builder/ai-measure.mjs` (counts and timings only; every prompt is in a ledger). The account's model list had 23 models and no billing multiplier for any of them. Labs: **A** Copilot Studio, agent instructions (2 modules, no industry); **B** Power Platform AI hub, human review of a prompt's output in a flow (3 modules, financial services, finance); **C** Microsoft Foundry, orient yourself (1 module plus a recap, healthcare, IT). All three outputs on. A passage here is a block the guard judges as a whole.

| Model (reasoning asked for) | Lab | Seconds | Prompts | Lab text | Training decks | Lab-day decks |
| --- | --- | --- | --- | --- | --- | --- |
| `gpt-5.6-luna` (none) | A | 32 | 12 | 7 of 7 | 97 of 97 | 2 of 2 |
| `gpt-5.6-luna` (none) | B | 45 | 19 | 7 of 7 | 176 of 176 | 2 of 2 |
| `gpt-5.6-luna` (none) | C | 24 | 8 | 4 of 4 | 59 of 59 | 1 of 1 |
| `gpt-5.6-luna` (none), final code, then rebuilt | A | 33, then 2 | 12, then 0 | 7 of 7 | 97 of 97 | 2 of 2 |
| `gpt-6-luna` (none) | A | 30 | 12 | 7 of 7 | 96 of 97 | 2 of 2 |
| `claude-haiku-5.5` (low) | A | 51 | 12 | 7 of 7 | 97 of 97 | 2 of 2 |
| `claude-haiku-5.5` (low) | C | 44 | 8 | 4 of 4 | 59 of 59 | 1 of 1 |
| `mai-code-2-flash` (low) | A | 48 | 12 | 7 of 7 | 96 of 97 | 2 of 2 |
| `mai-code-2-flash` (low) | C | 37 | 8 | 4 of 4 | 56 of 59 | 1 of 1 |
| `claude-haiku-4.5` (no levels listed) | A | 227 | 14 | 7 of 7 | 85 of 97 | 2 of 2 |
| `claude-haiku-4.5` (no levels listed) | C | 341 | 16 | 4 of 4 | 59 of 59 | 1 of 1 |

The rows for `mai-code-2-flash`, `gpt-6-luna` and the first `claude-haiku-4.5` row show what each run's guard refused at the time; the guard was improved afterward (see [the matching table](#matching-that-was-too-strict-and-what-changed)), and the saved answers pass it now except for the refusals that are right. `claude-haiku-4.5` on lab C had four time-outs (one in the lab text, three in the decks); each was asked again as two halves and nothing was lost, which cost two extra prompts for the lab text and six for the decks.

**Where the guard refused, by kind** (across 13 real runs with prompt version 2 as it was refined, about 1,270 blocks; 20 refusals, of which 16 were false positives that are now fixed and 4 were right):

| Kind | Refusals | What it was |
| --- | --- | --- |
| Schema (not the JSON asked for) | 0 | |
| Missing passage | 0 | |
| Dropped term (a protected term lost) | 0 | |
| Added term | 2 | A sentence-opening plural noun that is also a product name (false positive, fixed) |
| Chatter | 9 | A presenter's line opening "Here's ..." (false positive, fixed) |
| Step voice | 5 | "Choose" for the source's "pick" (false positive, fixed) |
| Step order or count | 0 | Prompt version 1 had 67 of 97 deck blocks here |
| Injection words | 0 | |
| Length | 3 | A short slide line made more than a quarter longer (right) |
| Markup | 1 | "Step 4," turned into "4." (right; the prompt now says to keep a label) |

For comparison, the same lab A on `claude-haiku-4.5` before any of this. The owner's trial on 2026-11-25: lab text 5 of 7, training decks 5 of 97, 12 requests, and the note "The model took too long, so those parts keep the standard text." Our first run of the old code: lab text 7 of 7, decks 30 of 97, 180 seconds, 10 prompts, with 67 deck blocks refused as "count changed" and one call cut off at the SDK's 60 second default.

What the numbers say:

- Almost all of the time of a call is the model writing, and on `claude-haiku-4.5` about 80% of the output tokens are reasoning that cannot be switched off (it lists no levels): 47,864 of 58,722 output tokens in one deck run. `gpt-5.6-luna` with reasoning `none` wrote the same decks with 9,166 output tokens in 23 seconds. `claude-haiku-5.5` at `low` still spends about half its output on reasoning.
- The prompts a lab uses do not depend on the model; the seconds do, by a factor of ten.
- A rebuild of the same lab with the same model made zero model calls and took two seconds.
- With AI off, the lab Markdown, HTML and every Office package are identical to the build before this change except the timestamps they carry.
- The one-topic lab with all three outputs finishes in 24 to 45 seconds on the recommended model (33 seconds for lab A, the target was under 3 minutes), 37 to 51 on `claude-haiku-5.5` and `mai-code-2-flash`, and 4 to 6 minutes on `claude-haiku-4.5`.
- The `Lab gate` grade "almost" and the "1 paragraph repeats word for word" warning in the trial lab are not from AI: the same lab built with AI off has the same three polish items and the same repeated paragraph (placeholder pictures, filler quiz answers, one repeated line in the catalog's text for that topic).

## Tuning

| If you see | Change |
| --- | --- |
| Calls time out on a slow model or a slow day | Raise `AI_TIMEOUT_MS` (the ceiling; small calls get less) or lower `AI_MAX_CHARS_PER_REQUEST` so each call writes less. |
| Many 429 or "busy" notes | Lower `AI_MAX_PARALLEL`; raise `AI_RETRIES` (up to 4) or `AI_BACKOFF_MS`. |
| You want fewer prompts per lab and the model is fast | Raise `AI_MAX_CHARS_PER_REQUEST` (up to 20000) and `AI_MAX_BLOCKS_PER_REQUEST`; a failed bigger call is halved, so the cost of a failure is bounded. |
| A model is slow and thinks a lot | Pick a model that lists `none` or `low` reasoning; leave `AI_REASONING_EFFORT=auto`. `off` sends no level. |
| A rebuild should try refused passages again now | Set `AI_REJECT_CACHE_MS=0`. |


## How the lab says AI wrote it

A lab with AI-written parts carries a short **How This Lab Was Written** note. It is in the Markdown, HTML, Word and PDF versions of the lab and in the facilitator guide. It lists the model and provider, the date, the prompt version, how many prompts the build used, what AI was allowed to write, and for each part how many passages AI reworded and how many kept the standard text, with the reason in plain words and counts only ("3 because the model took too long, 1 because the check against the original found a change, so the original was kept"). A short passage with nothing to reword is counted separately. The build result says the same in one line ("AI reworded 94 of 106 passages. 12 kept the standard text: ..."), and so do the command line's `AI writing` line and the page's result panel. When a rebuild reuses wording from an earlier build, the note says it used no prompts.

The same facts are in `manifest.json` under `aiWriting` (and in `ai-writing.json`, which holds the accepted rewordings so the training decks can be rebuilt without calling the model). They never include prompts, tokens, a person's name or a model answer. A lab list entry shows whether AI was used, and **Edit this lab** reopens the wizard with the AI choice, so the same lab can be rebuilt with AI on or off. A lab built with AI off has no `aiWriting` and no note.

## Cache, fingerprints and rebuilding

- Each accepted passage is cached under a hash of the prompt version, guard version, provider, model, kind, source text, allowed terms and context. A rebuild with the same model does not call the model again for unchanged passages: a rebuild of the one-topic lab above made zero calls and took two seconds. A refused passage is remembered for `AI_REJECT_CACHE_MS` (an hour), so a rebuild straight after makes no call for it either; after that, a rebuild retries only those.
- The cache is in memory unless it has a folder: the portal keeps it in its data folder (`ai-cache.json`), and the command line keeps it in the folder named by `AI_CACHE_DIR`, if you set one.
- The saved wording (`ai-writing.json`) and the fingerprint are written in deck order, not in the order the answers arrived, so the same wording always has the same fingerprint and the same bytes, however the parallel calls finished.
- AI has its own constant, `AI_WRITING_VERSION` (`portal/lib/ai/config.js`), and the prompt version is `AI_PROMPT_VERSION`. The AI choice enters the lab and training-deck fingerprints as a separate field, the way the combined-harness version does. AI and non-AI builds never share an entry, and the training deck schema version is not changed by AI.
- Rebuilding a saved lab with AI off gives the standard text again.

## Per-user sign-in with a GitHub App

This mode is fully implemented but disabled until configured. A real GitHub App registration has not been exercised (it is tested against a fake GitHub only).

GitHub documents two ways to sign people in: the web flow (for an app with a browser and a server) and the device flow (for a CLI). A portal is a server with a browser, so this uses the **web flow**, with a `state` value and PKCE.

1. Register a GitHub App (Settings, Developer settings, GitHub Apps). Set the callback URL to `<AI_PUBLIC_URL>/api/ai/auth/callback`. Request no repository permissions. Leave "Expire user authorization tokens" on.
2. Set `AI_GENERATION=per-user`, `AI_PUBLIC_URL` (the address people use), `AI_GITHUB_CLIENT_ID` and `AI_GITHUB_CLIENT_SECRET`. Keep the secret in a Container Apps secret or Key Vault, never in a file in the repository.
3. A visitor chooses **Sign in with GitHub** on the AI card, authorizes the app in a window of their own, and returns. The portal holds their token in memory for the session and uses only that token for that visitor's models and generations.

Each visitor needs their own active Copilot subscription. Their usage is billed to them, as GitHub documents for this flow.

The alternative GitHub documents for organizations, a server-to-server token billed to an organization, is **not** implemented here.

## Your own model provider (BYOK)

`AI_GENERATION=byok` uses a provider the server owner configures, with an allowlist of models:

```text
AI_BYOK_TYPE=azure          # openai, azure or anthropic
AI_BYOK_BASE_URL=https://<your-resource>.openai.azure.com
AI_BYOK_API_KEY=<key>       # keep it in a secret
AI_BYOK_MODELS=gpt-4o=GPT-4o,gpt-4o-mini
```

The SDK's documentation says BYOK is key-based. The server holds the key, so this mode needs portal sign-in or a loopback-only portal; with sign-in off on a reachable server it refuses. It has not been run against a real provider. Managed-identity token support exists in the SDK's types as experimental and is not used.

## Settings reference

| Setting | Default | Meaning |
| --- | --- | --- |
| `AI_GENERATION` | `off` | `off`, `local-user`, `per-user` or `byok` |
| `AI_ALLOWED_MODELS` | (all the SDK reports) | Comma-separated model ids to offer |
| `AI_PUBLIC_URL`, `AI_GITHUB_CLIENT_ID`, `AI_GITHUB_CLIENT_SECRET` | (none) | Per-user sign-in |
| `AI_BYOK_TYPE`, `AI_BYOK_BASE_URL`, `AI_BYOK_API_KEY`, `AI_BYOK_MODELS`, `AI_BYOK_WIRE_API`, `AI_BYOK_AZURE_API_VERSION` | (none) | BYOK |
| `AI_COPILOT_HOME` | (none) | Folder holding the Copilot login, if the SDK does not find it by itself |
| `AI_MAX_PARALLEL` | 4 | Parallel model calls in one lab (maximum 6). Lowered for a while after a 429 or 503. |
| `AI_MAX_CALLS_IN_FLIGHT` | 8 | Model calls at once across every lab on the server (maximum 16) |
| `AI_MAX_CONCURRENT_LABS` | 2 | AI labs building at once on the server |
| `AI_TIMEOUT_MS` | 120000 | The most time one model call is given. A call gets 30 seconds plus 40 ms per output token expected, at least 60 seconds, at most this. |
| `AI_MAX_OUTPUT_CHARS` | 12000 | Largest answer accepted |
| `AI_MAX_BLOCKS_PER_REQUEST` | 16 | Blocks per model call |
| `AI_MAX_CHARS_PER_REQUEST` | 3500 | Source characters per model call (500 to 20000) |
| `AI_MAX_BLOCKS_PER_LAB` | 400 | Passages per lab |
| `AI_DAILY_LABS_PER_VISITOR` | 6 | AI labs per visitor per day |
| `AI_DAILY_BLOCKS_PER_VISITOR` | 800 | Passages per visitor per day |
| `AI_DAILY_TOKENS_PER_VISITOR` | 600000 | Tokens per visitor per day |
| `AI_RETRIES` | 2 | Tries again after a 429, a 503 or a time-out, per request (0 to 4). Halving a request that timed out is separate and bounded by the retry budget. |
| `AI_BACKOFF_MS` | 2000 | First pause after a 429 or 503 when the service gives none; it doubles each try |
| `AI_REJECT_CACHE_MS` | 3600000 | How long a refused passage is remembered (0 turns it off) |
| `AI_REASONING_EFFORT` | auto | `auto` asks a model that lists levels for `none`, else `low`; `off` sends none; or name `none`, `low`, `medium` or `high` |
| `AI_CACHE_DIR` | (none) | Command line only: a folder that keeps the reworded passages between builds |
| `AI_MODEL_CACHE_MS` | 300000 | How long the model list is cached |
| `AI_SESSION_TTL_MS` | 28800000 | How long a per-user sign-in lasts |

## Routes

| Route | What it does |
| --- | --- |
| `GET /api/ai/status` | Whether AI is possible and available for this request, who is signed in, the provider, the "what is sent" text, and the numbers behind the prompt estimate. Never returns a key or token. |
| `GET /api/ai/models` | The models this visitor can use, the recommended one first and marked, with plain-words cost. Refused (403) when AI is not available for the request. |
| `GET /api/ai/progress/:ticket` | Passages done of total and prompts used so far for a running build, so the page can show real progress. |
| `POST /api/ai/auth/start`, `GET /api/ai/auth/callback`, `POST /api/ai/auth/signout` | Per-user sign-in (only when that mode is configured). |

A build request carries `ai: { enabled, provider, model, scope: ["lab","training","labday"] }`. It is validated like any other field. An unknown model id is refused with a plain message, and a request for AI on a server where AI is off is refused (403, `off`) before anything is built.

## Command line

```powershell
node tools/lab-builder/build.mjs --ai-list-models
node tools/lab-builder/build.mjs --features create-agent --industry retail --ai-model <id> --ai-scope lab,training
node tools/lab-builder/export-training-decks.mjs --lab <id|folder> --ai-model <id>
```

The command line uses this PC's own Copilot sign-in, like `local-user`. Nothing is sent without `--ai-model`. `--ai-list-models` lists the recommended model first. The build prints `[ai]` progress lines (passages done and prompts used) and, at the end, an `AI writing` line with the prompts used. `export-training-decks.mjs --ai-model` rewords the deck text only, leaves the lab unchanged, and writes an `AI-NOTE.txt` beside the decks; a lab that was built with AI already carries its deck wording and exports it without the flag.

To measure a model on the real service without touching the owner's labs:

```powershell
node tools/lab-builder/ai-measure.mjs --features agent-instructions --levels 100 --model <id> `
  --out $env:TEMP\ai-measure --ledger $env:TEMP\ai-ledger.jsonl --report $env:TEMP\ai-report.json
node tools/lab-builder/ai-measure.mjs --features agent-instructions --plan-only --out $env:TEMP\ai-plan
```

It builds the lab into the `--out` folder (never `generated-labs`), counts every prompt in the ledger file and refuses to start a call once the ledger holds `--cap` prompts (default 190), and prints one JSON report: how the passages were grouped into calls, the size, time limit, duration and outcome of each call, the guard refusals by kind, the share of passages reworded by part, and the seconds. It never records a prompt, an answer or a token. `--plan-only` calls no model and reports how many requests the engine would make. `--abort-after <seconds>` cancels the build and reports how fast it stopped and whether every SDK session was disconnected. `--diagnose` keeps, in the report, the short protected term each refusal named, for tuning the guard.

## Deploying

The Azure Container Apps deployment sets `AI_GENERATION=off` (`infra/main.bicep`, `infra/main.parameters.json`) and does not enable AI. To turn a mode on, set `aiGeneration` to `per-user` or `byok` in `infra/main.parameters.json` and give it the settings that mode needs as parameters of the same file:

| Parameter | App setting | For |
| --- | --- | --- |
| `aiPublicUrl`, `aiGithubClientId` | `AI_PUBLIC_URL`, `AI_GITHUB_CLIENT_ID` | `per-user` |
| `aiGithubClientSecret` (secure) | `AI_GITHUB_CLIENT_SECRET` | `per-user` |
| `aiByokType`, `aiByokBaseUrl`, `aiByokModels` | `AI_BYOK_TYPE`, `AI_BYOK_BASE_URL`, `AI_BYOK_MODELS` | `byok` |
| `aiByokApiKey` (secure) | `AI_BYOK_API_KEY` | `byok` |
| `aiAllowedModels` | `AI_ALLOWED_MODELS` | any |

The two secure parameters are stored as Container Apps secrets (`ai-github-client-secret`, `ai-byok-api-key`) and handed to the app by reference, never as plain text in the template. Pass them at deployment time (for example from a Key Vault reference in your parameters file), not in a file you commit. Then run `azd provision` or `azd up`. When AI is on the app gets 1 CPU and 2Gi instead of 0.5 CPU and 1Gi, because the SDK runtime is about 200 MB and starts a process per generation.

Do not turn on `per-user` or `byok` while `PORTAL_AUTH_DISABLED=true` unless you intend that. `per-user` is safe for the owner's allowance (each visitor pays for themselves) but lets any visitor with a Copilot plan use the portal's AI layer; `byok` refuses to run with sign-in off.

Image impact: the SDK is an `optionalDependencies` entry, pinned exactly (`@microsoft/copilot-sdk` 2.0.1-preview.0). The image is `node:24-alpine`, so the `linuxmusl-x64` runtime package installs (about 200 MB unpacked, in the lockfile). Nothing is downloaded at start-up. The SDK is loaded with a dynamic import the first time AI is asked for, so a server that never uses AI does not load it. `COPILOT_CLI_PATH` can point to a runtime installed elsewhere.

## What the SDK documents, with sources

Checked on 2026-11-24 against the registry and the sources below. Re-check them before relying on any detail, because the SDK is still moving.

- **Package.** `@microsoft/copilot-sdk` 2.0.1-preview.0 (MIT, Node `^20.19.0 || >=22.12.0`) is the package this uses. The older flat API is `@github/copilot-sdk` 1.0.34. The repository README (https://github.com/github/copilot-sdk) says the project is becoming the Microsoft Copilot SDK.
- **Runtime.** It ships the Copilot CLI runtime as per-platform optional packages (`@microsoft/copilot-sdk-<platform>`, for example `linuxmusl-x64`), so there is no download at start-up. `COPILOT_CLI_PATH` overrides it.
- **API used.** `new CopilotClient({ mode: "empty", runtime, github })`, `client.start()`, `client.rpc.models.list(...)`, `client.createSession({ model, systemMessage: { mode: "replace" }, tools: { availableTools: [] }, permissions: { onRequest } })`, `session.sendAndWait({ prompt, responseSchema }, timeoutMs)` (the time limit is the second argument; the SDK's default is 60 seconds and nothing in the message changes it), `session.abort()`, `session.disconnect()`. The SDK exposes every first-party CLI tool by default, so each session sets `availableTools: []` and rejects every permission request.
- **Models.** Each model has an id, name, vendor, policy state, a billing multiplier and an optional provider and warning text. The picker shows the name and the multiplier in plain words, and says so when the SDK does not report one.
- **Authentication** (GitHub Docs, https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate): stored sign-in, an OAuth app's user token, `COPILOT_GITHUB_TOKEN`, `GH_TOKEN` and `GITHUB_TOKEN`, a per-session token for multi-user servers, and BYOK. The multi-tenancy guide (https://github.com/github/copilot-sdk/blob/main/docs/setup/multi-tenancy.md) says to use `mode: "empty"` for shared servers. The GitHub OAuth guide (https://github.com/github/copilot-sdk/blob/main/docs/setup/github-oauth.md) says usage is billed to each user's subscription and each user needs an active Copilot subscription.
- **Billing and terms.** Each prompt counts toward the signed-in person's Copilot allowance, the same as Copilot CLI (https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing). The Copilot terms are in GitHub Terms for Additional Products and Features (https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features). **No source found permits a server to use one person's token on behalf of other people, so this design never does.** The documented way to serve many people from one billing account is an organization's server-to-server token (https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/server-to-server-tokens). That is not implemented.

## Limits and open questions

- The SDK is labeled `-preview` on npm even though its README describes it as generally available. Its API may change; the SDK is touched in one adapter file, `portal/lib/ai/copilot-client.js`.
- Verified against the real service on 2026-11-25 and 2026-11-26 (`local-user`, this PC's own sign-in): model listing, structured output, the time limit, reasoning levels, parallel calls (up to 4 at once, no 429 seen), cancel and session clean-up, and the numbers in [Measured on the real service](#measured-on-the-real-service). Not verified against the real service: the per-user GitHub App flow, BYOK against a real provider, a 429 or 503 from the real service (the back-off is tested with a fake one), `local-user` on a PC where the login is only in `AI_COPILOT_HOME`, and how the generated decks look in real PowerPoint and Word. Everything else is tested offline with a fake backend (`portal/test/fixtures/fake-ai.js`).
- What still keeps the standard text, and why: a rewording the guard refused (about one block in 300 on the small models measured; a short slide line made longer, a label turned into a list mark, a step verb the source did not have); a passage the model left out twice; calls that failed after their retries (time-outs on a slow model, a service that kept saying slow down); an exhausted allowance, a refused sign-in or a cancel; a passage past `AI_MAX_BLOCKS_PER_LAB` or the visitor's daily limit; and everything never sent (titles, key terms, quiz questions and answers, licensing and availability facts, links, and short labels with nothing to reword). The build result and the note say how many and why, in counts.
- Models can be slower or stricter than the guard allows. A model that thinks before it answers and cannot be told not to (`claude-haiku-4.5`) took 4 to 6 minutes for a one-topic lab and had time-outs that the halving recovered; the picker does not say so, but the numbers above do.
- The prompt estimate is a straight-line fit to labs of 2, 6 and 9 modules. It overstates a small lab by a tenth on purpose and has not been checked for labs of both harnesses.
- Premium-request costs differ by model, and GitHub reported none for this account. A lab with all three parts on is about 9 prompts for a one-module lab, 14 for two modules and 32 for six, and the per-visitor daily caps above bound the worst case.
