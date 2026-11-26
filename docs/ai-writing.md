# AI writing (optional)

The Lab Builder can ask an AI model to reword parts of a lab and its decks for the audience, industry, department, level and scenario you chose. It is **optional, off by default, and chosen per lab**. With AI off, every lab, deck and guide is exactly what it was before: the same bytes, the same fingerprints, the same cache entries.

AI is a writing layer on top of the deterministic pipeline, not a source of facts. The model never decides a click path, a menu name, a connector name, a number, a product name, a URL or a licensing statement. Those come from the catalog and live Microsoft Learn, and a guard checks every AI passage against the text it replaces. A passage that fails the check keeps the standard text.

- [Modes, identity and cost](#modes-identity-and-cost)
- [Turn it on locally](#turn-it-on-locally)
- [What is sent, and what the model may write](#what-is-sent-and-what-the-model-may-write)
- [The guards](#the-guards)
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

AI writing on your own PC uses your Copilot subscription. Each prompt counts toward your allowance, the same as Copilot CLI, and models differ in how many premium requests one prompt uses. The wizard shows the number the SDK reports next to each model.

1. Sign in to Copilot on this PC, once, with either `copilot login` or `gh auth login`. A Copilot plan (or a Copilot trial) is required.
2. Start the portal bound to loopback with AI on:

   ```powershell
   cd portal
   $env:HOST = "127.0.0.1"
   $env:AI_GENERATION = "local-user"
   npm start
   ```

3. Open `http://127.0.0.1:3005`, choose Build a Lab, and on **Review and build** turn on **Write with AI (optional)**. Pick a model, choose what AI writes (the lab text, the training decks, the lab-day decks), and build.
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

Every block is checked before it is used. If any check fails, that block keeps its standard text, the failure is counted (and shown as "kept as-is" in the note), and nothing is cached for it.

1. **Strict shape.** The model must answer with JSON that matches the schema (`portal/lib/ai/prompts.js`). Anything else is rejected.
2. **No invented facts.** Every interface term, number, product or connector name, URL and code identifier in the source must still appear. Nothing new of those kinds may appear, except numbers and names that came from the scenario fields the person typed. Bold and backtick marks around protected terms are kept.
3. **Same structure.** A list of steps keeps the same count and order, and every item keeps its numbering or bullet. One bad item rejects the whole list, so a module never mixes two voices or loses a step.
4. **Length limits** against the source, by kind of block, and a slide's room for the text.
5. **No chatter, injection or markup.** Replies that start with "Sure" or "Here is", mention instructions or the system prompt, add headings, HTML, code fences, new links, refusals or TODO words are rejected.
6. **Same final pipeline as the standard text.** AI text then goes through plain text (no emoji), US English, the connector display-name rewrite, the training guard that keeps lab steps and click paths out of training decks, the duplicate-slide guard, slide text fit and the lab quality gate. AI cannot bring back what earlier work removed.
7. **Fail soft.** If the model fails midway (time-out, quota, sign-in lost, or a run of rejected blocks), the lab still builds with the standard text for the rest, and the note says so.

## How the lab says AI wrote it

A lab with AI-written parts carries a short **How This Lab Was Written** note. It is in the Markdown, HTML, Word and PDF versions of the lab and in the facilitator guide. It lists the model and provider, the date, the prompt version, what AI was allowed to write, and how many passages AI reworded and how many kept the standard text.

The same facts are in `manifest.json` under `aiWriting` (and in `ai-writing.json`, which holds the accepted rewordings so the training decks can be rebuilt without calling the model). They never include prompts, tokens, a person's name or a model answer. A lab list entry shows whether AI was used, and **Edit this lab** reopens the wizard with the AI choice, so the same lab can be rebuilt with AI on or off. A lab built with AI off has no `aiWriting` and no note.

## Cache, fingerprints and rebuilding

- Each accepted passage is cached under a hash of the prompt version, guard version, provider, model, kind, source text, allowed terms and context. A rebuild with the same model does not call the model again for unchanged passages. A rejected passage is not cached, so a rebuild retries only those.
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
| `AI_MAX_PARALLEL` | 2 | Parallel model calls in one lab (maximum 4) |
| `AI_MAX_CONCURRENT_LABS` | 2 | AI labs building at once on the server |
| `AI_TIMEOUT_MS` | 120000 | Time limit for one model call |
| `AI_MAX_OUTPUT_CHARS` | 12000 | Largest answer accepted |
| `AI_MAX_BLOCKS_PER_REQUEST` | 24 | Passages per model call |
| `AI_MAX_BLOCKS_PER_LAB` | 400 | Passages per lab |
| `AI_DAILY_LABS_PER_VISITOR` | 6 | AI labs per visitor per day |
| `AI_DAILY_BLOCKS_PER_VISITOR` | 800 | Passages per visitor per day |
| `AI_DAILY_TOKENS_PER_VISITOR` | 600000 | Tokens per visitor per day |
| `AI_RETRIES` | 1 | Retries, only after a clearly transient error (0 to 2) |
| `AI_MODEL_CACHE_MS` | 300000 | How long the model list is cached |
| `AI_SESSION_TTL_MS` | 28800000 | How long a per-user sign-in lasts |

## Routes

| Route | What it does |
| --- | --- |
| `GET /api/ai/status` | Whether AI is possible and available for this request, who is signed in, the provider, and the "what is sent" text. Never returns a key or token. |
| `GET /api/ai/models` | The models this visitor can use, with plain-words cost. Refused (403) when AI is not available for the request. |
| `GET /api/ai/progress/:ticket` | Blocks done of total for a running build, so the page can show real progress. |
| `POST /api/ai/auth/start`, `GET /api/ai/auth/callback`, `POST /api/ai/auth/signout` | Per-user sign-in (only when that mode is configured). |

A build request carries `ai: { enabled, provider, model, scope: ["lab","training","labday"] }`. It is validated like any other field. An unknown model id is refused with a plain message, and a request for AI on a server where AI is off is refused (403, `off`) before anything is built.

## Command line

```powershell
node tools/lab-builder/build.mjs --ai-list-models
node tools/lab-builder/build.mjs --features create-agent --industry retail --ai-model <id> --ai-scope lab,training
node tools/lab-builder/export-training-decks.mjs --lab <id|folder> --ai-model <id>
```

The command line uses this PC's own Copilot sign-in, like `local-user`. Nothing is sent without `--ai-model`. `export-training-decks.mjs --ai-model` rewords the deck text only, leaves the lab unchanged, and writes an `AI-NOTE.txt` beside the decks; a lab that was built with AI already carries its deck wording and exports it without the flag.

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
- **API used.** `new CopilotClient({ mode: "empty", runtime, github })`, `client.start()`, `client.rpc.models.list(...)`, `client.createSession({ model, systemMessage: { mode: "replace" }, tools: { availableTools: [] }, permissions: { onRequest } })`, `session.sendAndWait({ prompt, responseSchema })`, `session.disconnect()`. The SDK exposes every first-party CLI tool by default, so each session sets `availableTools: []` and rejects every permission request.
- **Models.** Each model has an id, name, vendor, policy state, a billing multiplier and an optional provider and warning text. The picker shows the name and the multiplier in plain words, and says so when the SDK does not report one.
- **Authentication** (GitHub Docs, https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate): stored sign-in, an OAuth app's user token, `COPILOT_GITHUB_TOKEN`, `GH_TOKEN` and `GITHUB_TOKEN`, a per-session token for multi-user servers, and BYOK. The multi-tenancy guide (https://github.com/github/copilot-sdk/blob/main/docs/setup/multi-tenancy.md) says to use `mode: "empty"` for shared servers. The GitHub OAuth guide (https://github.com/github/copilot-sdk/blob/main/docs/setup/github-oauth.md) says usage is billed to each user's subscription and each user needs an active Copilot subscription.
- **Billing and terms.** Each prompt counts toward the signed-in person's Copilot allowance, the same as Copilot CLI (https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing). The Copilot terms are in GitHub Terms for Additional Products and Features (https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features). **No source found permits a server to use one person's token on behalf of other people, so this design never does.** The documented way to serve many people from one billing account is an organization's server-to-server token (https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/server-to-server-tokens). That is not implemented.

## Limits and open questions

- The SDK is labeled `-preview` on npm even though its README describes it as generally available. Its API may change; the SDK is touched in one adapter file, `portal/lib/ai/copilot-client.js`.
- Not verified against the real service: model listing and structured-output behavior, whether `local-user` finds a stored login with the SDK's private home folder (the fallback is `AI_COPILOT_HOME`), the per-user GitHub App flow, BYOK against a real provider, and how the generated decks look in real PowerPoint and Word. Everything else is tested offline with a fake backend (`portal/test/fixtures/fake-ai.js`).
- Models can be slower or stricter than the guard allows. When many passages are rejected, the lab still builds, with more standard text, and the note shows the counts.
- Premium-request costs differ by model. A lab with all three parts on is on the order of tens of prompts, and the per-visitor daily caps above bound the worst case.
