# Microsoft AI Training Generator — Screenshot Capture Tool

Interactive Playwright script that helps you capture every screenshot referenced in a lab's `index.md`, with the exact filenames already wired into the markdown.

## What it does

1. Launches headed Chromium so you can sign in normally, then persists auth in `./.auth`.
2. Walks [`shots.json`](./shots.json) one shot at a time, printing the section and setup steps.
3. Optionally navigates, sets viewport/zoom, and best-effort dismisses cookie banners, teaching tips, popovers, and toasts before prompting.
4. Waits for your keystroke, captures the active tab, saves to `labs/<lab>/assets/<filename>.png`, and verifies the PNG.

The script never types into Copilot Studio or configures the agent — you drive sign-in, UI setup, and final shot approval.

## Local Capture Companion (capture from the portal)

The Azure-hosted portal has no browser and no way to sign in to your tenant, so it cannot capture screenshots itself. The **Local Capture Companion** (`companion.mjs`) runs on your own computer instead: the portal queues a capture job, the companion steps through each shot in a visible browser window (your installed Microsoft Edge, then Google Chrome, then Chromium), checks every image, hides account details, and uploads it back. The portal verifies the image again, then updates the lab's HTML, Word, and PowerPoint files and its Microsoft Learn sync state automatically. Paste or upload in the portal is the fallback for any single shot.

### Quick start

1. In the portal, open **Settings > Configuration > Setup checklist** and select **Connect your computer** on the **Screenshot computer** row (a lab's Screenshot Center has the same button). Download the companion from the pairing card (or use this folder from the repository). You need Node.js 20 or later.
2. Run the launcher for your system. It installs what is missing the first time (`npm install` and `npx playwright install chromium`):

   ```powershell
   .\start-companion.cmd --portal=https://<your-portal> --code=ABCD-EFGH     # Windows (or start-companion.ps1)
   ```

   ```bash
   ./start-companion.sh --portal=https://<your-portal> --code=ABCD-EFGH     # macOS and Linux
   ```

   Or, from the repository: `cd tools/screenshot-capture && npm install && npx playwright install chromium && npm run companion -- --portal=<address> --code=<code>`. Without `--portal` and `--code` it asks for them. The pairing code works once and expires in 10 minutes.
3. Leave the window open. The portal shows **Companion connected** (and the **Screenshot computer** row of the Setup checklist turns to Ready). Queue a capture there for a lab or for the shared library; the companion picks it up within a few seconds.
4. The first time a product needs sign-in, the browser window shows the Microsoft sign-in page and the companion says **Waiting for you to sign in to <product>**. Sign in yourself, and when it asks **Stay signed in?** choose **Yes** so the sign-in lasts. The companion remembers it on this computer, so you sign in once per product, not once per screenshot. See [Signing in](#signing-in-once-per-product) for what is saved and how to start over.

| Command | What it does |
| --- | --- |
| `node companion.mjs` or `--watch` | Keep polling the portal and run queued or stale jobs as they arrive (default). |
| `node companion.mjs --once [--wait=60]` | Run one queued job, then exit. `--wait` keeps asking for that many seconds before giving up. |
| `--status` | Show the connection, when the pairing expires, which browser it will open, and for each product whether you are signed in (profile saved, session saved, last successful capture). |
| `--browser=auto\|edge\|chrome\|chromium` | Which browser to open. The default `auto` uses an installed Microsoft Edge, then Google Chrome, then the Chromium that Playwright installs. Each browser keeps its own sign-ins. |
| `--forget-signin=<product>\|all` | Delete the saved sign-in for one product (for example `copilot-studio`) or all of them, so the next capture asks you to sign in again. |
| `--debug` / `--trace=<file>` | Write a redacted trace of the sign-in decisions and print where it is (see [Troubleshooting](#troubleshooting)). |
| `--sign-in-wait=<seconds>` | How long to wait for you to sign in to a product during one job (default 600). |
| `--guided-wait=<seconds>` | How long to wait for you at a screen you set up yourself (default 120). After that the shot is marked *needs you*. |
| `--ready-wait=<seconds>` | How long to wait for a page to finish loading before the picture (default 20). |
| `--check` / `--install-browser` | Check this computer is ready (Node, Playwright, and a browser) / install Chromium. |
| `--callouts=sidecar\|burn\|none` | Numbered callouts: positions saved next to the image (default), drawn on the image, or skipped. |
| `--mask=Contoso,contoso.com` | Extra text to hide, such as your tenant name. `--no-redact` turns masking off (not recommended). |
| `--headless` | No visible window. It cannot sign in, so use it only for public pages and automated checks. |
| `--unpair` | Forget this computer's pairing. Select **Disconnect** in the portal to remove it there too. |

Press Ctrl+C once to stop after the current screenshot; twice to quit now. Canceling a job in the portal also stops the companion between shots. If a companion stops without finishing a job (for example, the computer went to sleep), the portal gives up on that claim after 5 minutes of silence. After that you can queue the capture again.

### Where to capture, and how each screenshot is taken

A capture needs to know *where* to look in your tenant. Before this release every shot opened the product's generic start page, so agent screens (Overview, Instructions, Knowledge, Settings, Test pane, Publish) could not be reached and the companion photographed whatever page was open. Now each product has a small **Capture settings** model, saved with the active brand profile and overridable per lab (Screenshot Center > **Capture settings**, or the inline prompt that appears when shots are waiting for an address):

| Product | What it needs | Setting |
| --- | --- | --- |
| Copilot Studio | The agent. Optional: the environment (the sign-in redirect finds your default one) | **Agent address** (open the agent and copy the address bar) or **agent name** (opened from the Agents list by its exact name); optional **environment address** |
| Agent Builder | The agent's name | **Agent Builder agent name** |
| SharePoint | The site | **SharePoint site address** (a lab built with a site fills this in by itself) |
| Power Platform | The environment | **Power Platform environment address** |
| Microsoft Foundry | The project | **Foundry project address** |
| Admin centers | Optional | **SharePoint admin** / **Microsoft 365 admin** addresses |

Addresses must be `https`; names are at most 80 characters. They travel to the companion as `CAPTURE_*` variables (addresses) and job settings (names). The portal shows only their *names* in a job, never the values, and the trace never records them.

Every shot is classified honestly into one of three modes, and each shot card shows its mode and why:

- **Automatic** (`auto`): the screen can be reached by its address and read-only navigation, so the computer does it. With the agent known it goes **straight to the screen** (for example the agent's `/settings` page), brings a labeled tab into view only if the lab points at one (a read-only click on a navigation item or tab, matched by its *exact* name), waits until the page is really ready, and takes the picture. If the address does not land on the screen it falls back to the product's own navigation. If a required step cannot be done it **stops with the reason** (for example `Could not find “Generative AI” on the agent's Settings page`) instead of photographing whatever is open.
- **Guided** (`guided`): the screen needs something the computer should not create: an open dialog, a test conversation, a publish confirmation, a result, the details of one tool. The companion opens the closest page and shows a small toolbar on the page with plain instructions and three buttons: **Capture this screen** (shortcut **Alt+Shift+C**), **Skip** (**Alt+Shift+X**), and **Stop**. You set the screen up and capture it; the companion removes the toolbar from the page before the picture, verifies, and uploads as usual. The toolbar shows only the instruction text: it never reads the page, never touches an input, and is never in the picture.
- **Manual** (`manual`): outside the browser (a terminal, Visual Studio Code). Capture it with an OS screenshot tool and upload it.

A capture job runs in one of three **modes**, chosen in the Screenshot Center: **Let the computer do it** (`auto`: only automatic shots run; guided shots are marked *needs you*), **I will set up each screen** (`guided`), or **Smart (recommended)** (`smart`: automatic shots run first and unattended, then guided shots wait for you). Unattended use is safe: a guided shot waits for you at most `--guided-wait` seconds (default 120); if nobody answers, that shot and the other guided shots in the job are marked **needs you**, so a companion left running in `--watch` mode never hangs on a screen nobody is there to set up. With `--headless` guided shots are marked *needs you* at once.

**What each outcome means and how to fix it.** The Screenshot Center groups the shots that did not end well by cause, with one fix per group:

| Group | What happened | Fix |
| --- | --- | --- |
| No agent address set (or SharePoint site, or another address) | The shot needs your tenant address, so it was held back. Nothing was opened | Add it in **Capture settings**, then retake |
| The agent was not found | The agent name matches no agent in the environment | Check the name (it must match exactly) or use the agent address |
| Sign-in needed | The product asked for a sign-in | Sign in in the companion window, then retake |
| The wrong screen was open | The address or navigation ended on a different page. The picture is kept for review: *This is the Copilot Studio home page, not the agent's Settings page* | **Retake guided**, or check the agent address |
| A control could not be found | A required step (a tab the lab points at) is not on the screen | **Retake guided** and open it yourself |
| The page did not finish loading | The picture was blank or almost one color, even after waiting longer | Retake; check the page opens in the companion's browser |
| Paused: the browser window was closed | You closed the window (or pressed **Stop**). The remaining shots are *paused*, with one message, not failed | **Resume** (it queues exactly those shots) |
| This screen needs you | A guided shot in automatic mode, or nobody was there | **Retake guided** |

**How a picture is checked now.** The page address is the main signal: when the plan knows the screen it expects (for example the agent's Overview page), a picture whose address is a different page is *never* accepted automatically; it goes to **needs review** with a sentence that says what was captured and what was expected. When the address matches, the expected labels are only a soft hint, so a correct picture is not stuck because a label from the lab text never appears. Labels are cleaned first (typos such as *Start building form scratch* are corrected, stop words, placeholders, and sentences are dropped) and matched without caring about case, punctuation, plurals, or a one-letter typo. Blank pages, sign-in pages, and almost-one-color pictures are still rejected, and the magic-byte, size, and filename checks are unchanged. A picture you set up in guided mode only has to be in the product. The portal judges every upload against the plan's own expectation, never against what the companion says.

**Waiting for the page.** Before every picture the companion waits for all of these: the page has loaded, no loading indicator is visible (`aria-busy`, `role=progressbar`, skeleton or spinner classes), the page has stopped changing for a quiet window, and two pictures in a row are identical. A picture that still comes out empty is retried once with a longer wait. The budget is `--ready-wait=<seconds>` (default 20), and what was waited for is in the trace.

**If the browser misbehaves.** An interrupted navigation (`net::ERR_ABORTED`, a timeout, a reset connection) is retried twice with a growing pause. A crashed tab is replaced by a new tab in the same browser and the shot is tried again. Closing the browser window pauses the job once and tells you how many shots are waiting; in `--watch` mode the companion keeps running and picks up the next job, for example the one **Resume** queues.

**What it never does.** The companion looks at your tenant; it never creates, edits, publishes, or deletes anything. In addition to the sign-in and delete rules above, it refuses any control named Publish, Create, Save, Submit, Send, Add, Edit, New, Deploy, Apply, Confirm, Run, and similar (and any control that submits a form), whatever the plan says. Clicks are limited to exact-name navigation items and tabs.

**Older portals.** The companion still runs a plan from a portal that does not classify its shots (the way it did before, with the stricter control rules). Download it again after the portal is updated to get the new behavior.

### Signing in once per product

The companion never types a password or clicks a sign-in button. You sign in yourself, and it only watches the address bar to know when you are done.

- **One sign-in wait per product per job.** When a page turns out to be the Microsoft sign-in page, the companion waits for you (up to `--sign-in-wait` seconds), prints one message, and tells the portal. It waits through **Stay signed in?**, the account picker, multi-factor prompts, and **Working on it** pages. A quick silent trip to the sign-in page, a page that redirects to sign-in a moment after it loads, and a signed-in page whose address merely mentions a sign-in address are all handled without bothering you.
- **If sign-in does not finish, it stops.** The rest of that product's shots are reported once, right away, as needing a sign-in (the portal shows **Sign in to <product> on your computer, then retry the N screenshots**). The companion does not reopen the sign-in page for every shot.
- **Choose Yes on "Stay signed in?"** Without it, Microsoft keeps the sign-in in a session cookie that a closed browser throws away. The companion saves those cookies itself after every successful capture and restores them the next time, but **Yes** makes the sign-in last across restarts without relying on that.
- **Each product has its own sign-in.** Copilot Studio, Agent Builder, SharePoint AI, Microsoft Foundry, the Microsoft 365 Copilot hub, and the Power Platform AI hub each use their own browser profile, so a lab that spans two products asks you to sign in to each one once. Each browser kind (Edge, Chrome, Chromium) also has its own profiles.
- **Never clicks anything that signs in or out.** It refuses controls named Sign in, Sign out, Log in, Log out, Switch account, Use another account, Add account, Remove account, and the account and profile menus, however the plan names them, and it checks the link behind a control as well.
- **Pausing and stopping in `--watch` mode.** After a job ends without a sign-in, the companion waits 30 seconds before taking another job (60 seconds after a second one). After three jobs in a row that ended without a sign-in for the same product, it stops taking jobs and tells you why, so it cannot loop. Fix the sign-in, then start it again. A job the portal hands back after the companion already ran it twice is closed instead of run again.

**What is saved.** Under the companion folder, `.auth/<browser>/<product>/` holds the browser profile, `companion-session.json` (your browser's cookies for that product, including session cookies), and `companion-signin.json` (when it last worked). **Anyone who has these files can act as the signed-in account**, so keep the folder private. They stay on this computer, are git-ignored, and are left out of the companion download and the container image. To start over for one product run `node companion.mjs --forget-signin=copilot-studio`, or for everything `--forget-signin=all`. You can also delete the product's folder under `.auth/` yourself. Folders from older versions, such as `.auth/copilot-studio/`, are not used by the companion any more; delete them if you like.

### Security model

- **Paired, scoped, revocable.** A one-time code is traded for a capture token (`cap_...`). The portal keeps only a hash of the code and the token, compares them in constant time, extends the token while you use it, and lets you disconnect the computer at any time. The token opens only the companion endpoints; it is not a portal sign-in and cannot read or change anything else. A revoked or expired token is refused and the companion tells you to pair again.
- **Nothing secret in the download or in git.** The portal's download and this folder contain no tokens. The pairing file `.companion.json`, your browser sign-ins (`.auth/`, including the saved session cookies), and in-progress captures and traces (`.captures/`) stay on your computer, are git-ignored, and are left out of the companion download and the container image. The token is saved with owner-only permissions where the system supports it and is never printed.
- **Your credentials never leave your computer.** You sign in yourself in a real browser window. Only screenshots, page addresses (without query strings), the page title, and visible control names are sent, and only to the portal you paired with. Portal addresses must be `https` (`http` is allowed for `localhost` only).
- **It never types into tenant pages and never changes the tenant.** Steps are limited to opening an `https` page, waiting, dismissing banners, and clicking an exact-name navigation item or tab. It skips any control whose name says delete, remove, erase, purge, destroy, disconnect, unregister, revoke, or reset, any control that creates or changes something (Publish, Create, Save, Submit, Add, Edit, and similar, or a button that submits a form), and any control that signs in or out or switches the account (Sign in, Sign out, Switch account, Use another account, the account menu), whatever the portal asks for. It does not change how the browser identifies itself or hide that it is automated; it uses a normal installed browser that you sign in to yourself.
- **Account details are hidden.** Before each picture it draws a solid block over the account control and over any email address, tenant host name (`*.onmicrosoft.com`, SharePoint admin and personal hosts), or `--mask` term on the page, then removes the blocks. Text sent to the portal as evidence is scrubbed the same way. Always look at a screenshot before you publish it.
- **Verified twice.** Both the companion and the portal check magic bytes (PNG, JPEG, WebP), size (5 KB to 8 MB), dimensions, blank or sign-in pages, and a match with the expected control names. The portal never trusts what the companion reports for a security decision.
- **Tenant addresses.** A job can carry `CAPTURE_*` addresses (https only) for your tenant, for example from the lab's brand profile. They override same-named variables on your computer for that job only.

### Troubleshooting

| What you see | What to do |
| --- | --- |
| `The Playwright package is not installed` or `The Chromium browser is not installed` | In this folder run `npm install` then `npx playwright install chromium`, or run with `--install-browser`. |
| `Node.js 20 or later is required` | Install a current Node.js LTS from nodejs.org. |
| `Cannot reach the portal at ...` | Check your internet connection or VPN and the portal address. In watch mode the companion keeps trying and backs off up to a minute. |
| `That pairing code is not valid` or `expired` | Select **Connect your computer** in the portal for a new code (or **Get a new code** on the pairing card). Codes work once and last 10 minutes. Several wrong codes in a row pause pairing for a few minutes. |
| `This computer was disconnected in the portal` or `connection expired` | Pair again with a new code. The old token is deleted from `.companion.json`. |
| A shot says you were not signed in | Sign in in the browser window the companion opened (it waits up to 10 minutes, `--sign-in-wait`), choose **Yes** on **Stay signed in?**, then queue the shots again. The portal's message names the product, for example **Sign in to Microsoft Copilot Studio on your computer, then retry the 3 screenshots**. |
| **It took one screenshot, then kept asking me to sign in and never succeeded** | Update to this version (the companion shows `Local Capture Companion 1.1.0` or later: download the companion again from the portal, or `git pull`). Older versions looked at the address once, right after a page started to load, so a product that sends you to sign in a moment later was captured as a sign-in page and the next shot restarted the sign-in before you could finish. They also opened a separate browser profile for each product and threw away session cookies when it closed. Then: (1) close the companion and run `node companion.mjs --forget-signin=all` to remove stale sign-ins, delete any old `.auth/<product>/` folders, and start again; (2) when asked, sign in and choose **Yes** on **Stay signed in?**; (3) expect one sign-in per product. If it still loops, run `node companion.mjs --once --debug` and send the trace file it prints (see below). |
| The sign-in page appears again right after you signed in, or the page says you cannot access this from this device | Your organization's Conditional Access policy may not allow the browser Playwright installs (an unmanaged, non-compliant browser). Run with `--browser=edge` (or `--browser=chrome`) so the companion opens the browser installed on this computer, ideally the one your organization manages, and sign in there. If the policy still blocks it, ask your administrator to allow this device or browser for the account you use for captures, or capture those shots with an OS screenshot tool and upload them in the portal. The companion never tries to get around a policy. |
| `No supported browser was found` or `Microsoft Edge was not found` | Install Microsoft Edge or Google Chrome, or run `npx playwright install chromium` (or run with `--install-browser`). With `--browser=edge` or `--browser=chrome` the companion uses only that browser; with `auto` it falls back from Edge to Chrome to Chromium. |
| `Sign-in to ... did not work 3 jobs in a row` | The companion stopped on purpose so it cannot loop. Fix the sign-in (see the rows above), then start it again. |
| How do I see what it is doing? | Run with `--debug` (or `--trace=<file>`). It writes a trace under `.captures/traces/` and prints the path. The trace has step names, hosts and paths (no query strings), timings, and decisions such as `treated as sign-in because host=login.microsoftonline.com`. It has no cookies, tokens, page text, or account names, so it is safe to share. |
| `The picture came out blank` | The page did not finish loading. The companion waits for the page to be ready and retries once with a longer wait; if it still fails, make sure the page opens for your account, raise `--ready-wait`, then queue it again. |
| A shot is `skipped` and says it needs your agent address (or SharePoint site, or another address) | Add it in **Capture settings** in the Screenshot Center (the inline prompt has an input and a **Save** button), then retake. |
| A shot says **needs you** | It is a screen you set up yourself (a dialog, a test conversation, a result). Use **Retake guided**, or run a Smart capture while you are at the computer. |
| The portal says **paused** | You closed the browser window or pressed **Stop**. Select **Resume** to capture exactly the paused shots. |
| A shot is `manual` | It is outside the browser (a terminal or Visual Studio Code). Capture it with an OS screenshot tool and upload it in the portal. |
| The portal shows a shot as `needs review` | The image passed the hard checks but is probably the wrong screen, or has another warning. The card shows what was captured next to what the lab asks for. Accept it if it is right, or retake it (**Retake guided** if the computer keeps landing on the wrong page). |
| How do I see why a screen was or was not reached? | Run with `--debug`. The trace now also records each step (open, reveal, navigate: label, found, ok, and the masked address before and after), each page-ready wait (what it waited for and for how long), and each guided result. Still no query strings, cookies, tokens, page text, or account names. |

### Testing the capture logic without a tenant

`test/fixtures/fake-product-site.mjs` is a pretend Copilot Studio (and SharePoint site) that answers for the real host names through Playwright route interception, so nothing leaves your computer. It imitates the structure that broke real captures: a start page that redirects to the environment home, a home page with a promo card named like a navigation item that leads to a page for creating apps, an agents list, an agent with a side navigation, skeleton and spinner loading, late content, an interrupted first navigation, a session cookie, and `Publish` / `Create blank agent` buttons that are recorded as writes (`site.stats.writes` must stay empty).

```powershell
cd tools/screenshot-capture
node test/fixtures/capture-repro.mjs --verbose                       # every scenario against this checkout (real portal, a lab built offline, the real companion, a real browser)
node test/fixtures/capture-repro.mjs --repo-dir=<other checkout>     # the same scenarios against another checkout, for before and after numbers
node test/fixtures/capture-repro.mjs --only=blank,closed --edge      # some scenarios, in the installed Microsoft Edge
node scan-labels.mjs                                                 # find unusable or typo-suspect expected labels in the lab catalog and shot lists
node --test "test/*.test.mjs"                                        # hermetic and real-browser tests (the browser tests skip when no browser is installed)
```

## One-time setup

```powershell
cd tools/screenshot-capture
npm install
npx playwright install chromium
```

## Usage

```powershell
npm run capture              # capture shots missing on disk
npm run list                 # show existing/missing shots
node capture.js --help       # show all flags and keystrokes
node capture.js --dry-run --missing  # validate catalog without launching Playwright
node capture.js --all        # re-capture everything
node capture.js --only=3,7   # capture specific shot IDs
node capture.js --range=5-10 # capture an inclusive ID range
node capture.js --from=5     # start at shot ID 5
```

Selection precedence is `--only` > `--range` > `--from` > `--missing` default; conflicting selection flags are rejected.

### Verify screenshot consistency

```powershell
npm run verify
node verify-shots.js --lab=06-energy-weather-agent
node verify-shots.js --json
node verify-shots.js --strict
```

`verify-shots.js` scans lab markdown, `shots.json`, and lab assets for schema drift, missing or invalid image files, markdown/catalog mismatches, tiny placeholder-like PNGs, and orphan PNG/JPEG assets. It exits `0` when there are no critical findings, `1` when critical findings exist; `--strict` also fails on warnings.

Use `node verify-shots.js --check-state` before committing Lab 06 screenshot work to add a byte-size denylist check for known placeholder PNG fingerprints. The heuristic reports CRITICAL `restored-placeholder` findings for Lab 06 PNGs whose file size exactly matches one of the known-bad placeholders. A false positive is possible if a real capture lands on the exact same byte size, but that is extremely unlikely; inspect and re-capture if it happens.

## Heads-up: commit deletions promptly

Deleted Lab 06 placeholder PNGs still exist in git history. `git restore`, VS Code **Discard Changes**, or **Discard All Changes** can restore them into the working tree; run the state check before committing screenshot changes.

> ⚠️ **Heads up:** npm 11 strips unknown flags like `--all` from `npm run capture -- --all`. Use the direct `node capture.js …` form when passing flags. `npm run capture` and `npm run list` are wired in `package.json` so they work as-is.

## During a capture session

Get the browser into the right state, then use the terminal keystrokes shown in the one-line prompt:

- `Space` — snap, verify, save, and advance
- `r` — retry/re-snap the current shot after you tweak the UI
- `n` — skip this shot without saving
- `q` — quit gracefully, close Chromium, and persist auth
- `?` — re-print the current instructions

Each exit path prints snapped/skipped/retried/failed-verify counts and the remaining missing filenames.

## Optional `shots.json` fields

Each shot still requires `id`, `filename`, `section`, and `instructions`. Optional fields are:

```json
{
  "section": "topics",
  "url": "https://copilotstudio.microsoft.com/...",
  "labSection": "Use Case #1, Step 2",
  "viewport": { "width": 1440, "height": 900 },
  "zoom": 1.0,
  "highlight": { "selector": "[data-id='target']", "label": "Future callout" }
}
```

`url` navigates before prompting when the active page is elsewhere. When `url` is absent, `section` is treated as a current-agent section such as `topics`, `actions`, `agents`, `settings`, or `evaluations`; if the browser is already under `/environments/.../bots/.../`, the tool keeps the current environment/agent and replaces only the trailing section. Absolute `url` values win over `section`. If no current agent is open, the tool prints a hint and waits for manual navigation. `labSection` keeps the human lab step label for prompts. `viewport` and `zoom` reset to 1440x900 / 1.0 between shots before applying shot overrides. `highlight` is reserved for future callout-arrow work and is not implemented yet.

## Feature tour screenshots (all six products)

The feature tour has one generated shot list per product, with one or more shots for every feature in the lab builder catalog (`npm run feature-tour:build` regenerates them; CI fails if they are stale):

| Product id | Shot list | Shots |
| --- | --- | --- |
| `copilot-studio` | `feature-shots.json` | 136 |
| `m365-copilot-agent-builder` | `feature-shots.m365-copilot-agent-builder.json` | 43 |
| `sharepoint-ai` | `feature-shots.sharepoint-ai.json` | 31 |
| `ai-foundry` | `feature-shots.ai-foundry.json` | 38 |
| `m365-copilot-hub` | `feature-shots.m365-copilot-hub.json` | 33 |
| `power-platform-ai-hub` | `feature-shots.power-platform-ai-hub.json` | 44 |

**No real screenshots exist yet for any of them**: `docs/feature-tour/screenshots/` is empty, so every shot is pending. The tools never sign in for you and never fabricate images; you capture them against your own test tenants.

Every list writes PNGs to the same folder, `docs/feature-tour/screenshots/`, and each product keeps its own browser profile in `.auth/<product>/`, so you sign in once per product and tenant. The GitHub Pages feature tour and the lab generator pick captured images up with no code changes.

```bash
npm run status                                          # captured vs pending per product, and the exact next command
node status.mjs --product=sharepoint-ai                 # per feature for one product (--detail for all, --json, --strict)
node capture.js --features --list                       # every product's shots, with section names
node capture.js --product=sharepoint-ai --missing       # capture one product's missing shots
node capture.js --product=sharepoint-ai --section=sharepoint-admin-center --missing   # one portal area
node capture.js --product=ai-foundry --feature=<feature-id>   # specific features
node capture.js --product=all --missing                 # every product in turn
node capture.js --product=<id> --dry-run                # print the plan, no browser
node verify-shots.js --features --missing               # every product's pending shots
node verify-shots.js --product=<id> --strict-missing    # fail while that product has pending shots
```

`--features` alone means `--product=copilot-studio` (`--harness=standard|both|microsoft-copilot|customer-conversation` applies to Copilot Studio only, the one product with harnesses). With `--list` or `--dry-run` and no `--product`, `--features` covers every product. `--feature`, `--section`, and `--harness` filters combine with `--missing`, `--all`, `--only`, `--range`, and `--from`; shot ids are per product.

Feature shots also print the steps to reach the screen and the numbered callouts. After each snap the tool writes `<name>.callouts.json` with the position of every callout so the site can draw hotspots (this works the same for every product). A shot marked `manual` (a terminal or Visual Studio Code) is not screenshotted by the tool: save the image at the printed path, then press `Space` to verify it. Missing feature screenshots are reported as pending, not failures; add `--strict-missing` to `verify-shots.js` to fail on them.

### Tenant-specific addresses

Public sign-in and portal addresses come from Microsoft Learn and live in [`tools/feature-tour/capture-products.json`](../feature-tour/capture-products.json). For an address that is yours, set an environment variable before the run; it must be an `https` URL.

| Variable | Used for |
| --- | --- |
| `CAPTURE_COPILOT_STUDIO_START_URL` | Copilot Studio start page (regional or government host). |
| `CAPTURE_M365_AGENT_BUILDER_START_URL` | Agent Builder start page. |
| `CAPTURE_SHAREPOINT_AI_START_URL` | SharePoint AI start page. |
| `CAPTURE_SHAREPOINT_SITE_URL` | A SharePoint site you own (site, library, and agent builder shots). |
| `CAPTURE_SHAREPOINT_ADMIN_URL` | `https://<TenantName>-admin.sharepoint.com` (SharePoint admin center shots). |
| `CAPTURE_M365_ADMIN_URL` | A specific Microsoft 365 admin center address. |
| `CAPTURE_FOUNDRY_START_URL` | Foundry start page. |
| `CAPTURE_FOUNDRY_PROJECT_URL` | Your Foundry project page (project and agent shots). |
| `CAPTURE_M365_COPILOT_HUB_START_URL` | Copilot hub start page. |
| `CAPTURE_POWER_PLATFORM_START_URL` | Your Power Platform environment, for example `https://make.powerapps.com/environments/<environment-id>/home`. |

`--dry-run` shows which variable each shot uses and whether it is set. The step-by-step guide for each product (tenant, licenses, roles, preview features, sample data, capture order) and a checklist are in [`docs/feature-tour.md`](../../docs/feature-tour.md).

## Notes

- Login state for the interactive `capture.js` tool is stored in `tools/screenshot-capture/.auth/` (feature tour: `.auth/<product>/`). That directory is git-ignored — never commit it. The Local Capture Companion keeps its own sign-ins in `.auth/<browser>/<product>/` (see [Signing in](#signing-in-once-per-product)), so a sign-in made with one tool is not shared with the other. Its pairing file `.companion.json` and `.captures/` are git-ignored too.
- PNGs land directly in `labs/06-energy-weather-agent/assets/` with filenames declared in `shots.json`.
- The default manifest is currently configured for Lab 06. Use `--manifest=<path>` for another lab instead of rewriting the default catalog.
- Tests (`node --test "test/*.test.mjs"`) are hermetic: they run `--dry-run`, use temporary fixture images and a fake Playwright, so they need neither a browser nor a tenant. `test/signin-real-browser.test.mjs` also drives a real Chromium (and Microsoft Edge when it is installed) against a pretend tenant that answers by route interception, and skips itself when no browser is installed. `node test/fixtures/signin-repro.mjs [--tool-dir=<folder>] [--channel=msedge]` prints the sign-in scenarios as a table, which is how a before and after comparison is made.
