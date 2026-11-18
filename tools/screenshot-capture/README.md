# Microsoft AI Training Generator — Screenshot Capture Tool

Interactive Playwright script that helps you capture every screenshot referenced in a lab's `index.md`, with the exact filenames already wired into the markdown.

## What it does

1. Launches headed Chromium so you can sign in normally, then persists auth in `./.auth`.
2. Walks [`shots.json`](./shots.json) one shot at a time, printing the section and setup steps.
3. Optionally navigates, sets viewport/zoom, and best-effort dismisses cookie banners, teaching tips, popovers, and toasts before prompting.
4. Waits for your keystroke, captures the active tab, saves to `labs/<lab>/assets/<filename>.png`, and verifies the PNG.

The script never types into Copilot Studio or configures the agent — you drive sign-in, UI setup, and final shot approval.

## Local Capture Companion (capture from the portal)

The Azure-hosted portal has no browser and no way to sign in to your tenant, so it cannot capture screenshots itself. The **Local Capture Companion** (`companion.mjs`) runs on your own computer instead: the portal queues a capture job, the companion steps through each shot in a visible browser window (Microsoft Edge, Google Chrome, or the Chromium that Playwright installs: on a PC with a Windows work account it tries Chrome and Chromium first, so a screenshot never silently comes from your work account; see [Which account the screenshots come from](#which-account-the-screenshots-come-from)), checks every image, hides account details, and uploads it back. The portal verifies the image again, then updates the lab's HTML, Word, and PowerPoint files and its Microsoft Learn sync state automatically. Paste or upload in the portal is the fallback for any single shot.

### Quick start

1. In the portal, open **Settings > Configuration > Setup checklist** and select **Connect your computer** on the **Screenshot computer** row (a lab's Screenshot Center has the same button). Download the companion from the pairing card (or use this folder from the repository). You need Node.js 20 or later.
2. Unzip it, then start the companion with a launcher. The launchers are in the `capture-companion/tools/screenshot-capture` folder of the download (or `tools/screenshot-capture` in the repository), next to this file: `start-companion.cmd` (Windows), `start-companion.ps1` (Windows PowerShell), and `start-companion.sh` (macOS and Linux). Double-click `start-companion.cmd` on Windows, or run it from a terminal. A launcher installs what is missing the first time (`npm install` and `npx playwright install chromium`).

   Run this from the folder where you unzipped the companion (the folder that holds `capture-companion`). The portal shows the same command with your pairing code filled in, ready to copy:

   ```powershell
   .\capture-companion\tools\screenshot-capture\start-companion.cmd --portal=https://<your-portal> --code=ABCD-EFGH     # Windows PowerShell or Command Prompt
   ```

   ```bash
   ./capture-companion/tools/screenshot-capture/start-companion.sh --portal=https://<your-portal> --code=ABCD-EFGH     # macOS and Linux
   ```

   **Run it from anywhere.** Use the launcher's full path. If you type the folder you unzipped into on the portal's pairing card (**Where did you unzip the companion?**), it shows the full path for you. The folder stays in your browser and is never sent to the portal. A path with spaces, such as a OneDrive folder, needs quotes. In Windows PowerShell, start with `&` and use single quotes; in Command Prompt, use double quotes without the `&`; in macOS and Linux shells, use single quotes:

   ```powershell
   & 'C:\Users\you\OneDrive - Contoso\Downloads\copilot-studio-labs-capture-companion\capture-companion\tools\screenshot-capture\start-companion.cmd' --portal=https://<your-portal> --code=ABCD-EFGH
   ```

   ```bash
   '/Users/you/My Files/copilot-studio-labs-capture-companion/capture-companion/tools/screenshot-capture/start-companion.sh' --portal=https://<your-portal> --code=ABCD-EFGH
   ```

   **Next time you only need the launcher.** The pairing is remembered, so no `--portal` or `--code` is needed. Every time the companion starts it prints `Next time, start it from any folder with: ...` with the launcher's full path, quoted for your shell (never the pairing code), so you can copy it from there. Started with `node companion.mjs` directly, it prints the `node` form instead. The line stays on your computer: the path is never sent to the portal.

   **Keep the code folder and the data folder apart.** The unzipped folder holds only the companion's code. Your pairing and browser sign-in live in a separate local folder of your user account (on Windows, `%LOCALAPPDATA%\CopilotStudioLabsCompanion`), so unzipping, moving, or deleting the code folder, even inside OneDrive, never loses or syncs your sign-in.

   Or, from the repository: `cd tools/screenshot-capture && npm install && npx playwright install chromium && npm run companion -- --portal=<address> --code=<code>`. Without `--portal` and `--code` it asks for them. The pairing code works once and expires in 10 minutes.
3. Leave the window open. The portal shows **Companion connected** (and the **Screenshot computer** row of the Setup checklist turns to Ready). Queue a capture there for a lab or for the shared library; the companion picks it up within a few seconds.
4. The first time a product needs sign-in, the browser window shows the Microsoft sign-in page and the companion says **Waiting for you to sign in to <product>**. Sign in yourself, and when it asks **Stay signed in?** choose **Yes** so the sign-in lasts. The companion remembers it on this computer, so you sign in once per product, not once per screenshot. See [Signing in](#signing-in-once-per-product) for what is saved and how to start over.

| Command | What it does |
| --- | --- |
| `node companion.mjs` or `--watch` | Keep polling the portal and run queued or stale jobs as they arrive (default). |
| `node companion.mjs --once [--wait=60]` | Run one queued job, then exit. `--wait` keeps asking for that many seconds before giving up. |
| `--status` | Show the connection, when the pairing expires, which browser it will open, and for each product whether you are signed in (profile saved, session saved, last successful capture). |
| `--browser=auto\|edge\|chrome\|chromium` | Which browser to open. The default `auto` uses an installed Microsoft Edge, then Google Chrome, then the Chromium that Playwright installs, except on a PC with a Windows work account, where it tries Chrome, then Chromium, then Edge opened InPrivate. Each browser keeps its own sign-ins. |
| `--account-mode=separate\|windows` | Which account the browser signs in with. `separate` (the default on a PC with a Windows work account) never takes the Windows work account on its own; `windows` allows it on purpose. See [Which account the screenshots come from](#which-account-the-screenshots-come-from). |
| `--setup-account[=<product>]` | Choose which account the screenshots come from: opens the product so you sign in with the account you want (for example your demo tenant), checks it fits your addresses, and remembers it. |
| `--forget-signin=<product>\|all` | Delete the saved sign-in for one product (for example `copilot-studio`) or all of them, so the next capture asks you to sign in again. |
| `--check-signin[=<product>]` | Open the product's start page once, watch the sign-in, and print why it does or does not stick (see [Checking a sign-in](#checking-a-sign-in-that-will-not-stick)). |
| `--launch=auto\|attach\|playwright` | How Edge or Chrome is started. `attach` (the default for them) starts your normal browser and connects to it; `playwright` uses the automation launcher. |
| `--home=<folder>` / `--allow-synced-home` / `--delete-old-signin` | Where the data lives (default: a local folder of your user account, never a synced one), override for a synced folder (not recommended), and remove the old sign-in folder earlier versions kept beside the code. |
| `--background` | Run in a hidden window when a sign-in is already saved; a visible window opens if the product asks you to sign in again. |
| `--allow-practice-writes` / `--no-practice-writes` | Let jobs that you allowed in the portal create and use one practice agent / never create anything, whatever a job says. |
| `--dry-run-plan[=<job file>]` / `--diagnose[=<product>]` | Print every step a job would take, tier by tier, without a browser / write a redacted diagnostic file for the page open in a live browser. |
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

A capture job runs in one of four **modes**, chosen in the Screenshot Center: **Automatic (recommended)** (`autonomous`: the computer sets up every browser-reachable screen itself, see [Automatic capture](#automatic-capture-autonomous-mode)), **Automatic, read-only** (the same, but it never creates anything), and under **Advanced** **I will set up each screen** (`guided`), **Smart** (`smart`: automatic shots run first and unattended, then guided shots wait for you), and **Only what needs no setup** (`auto`: guided shots are marked *needs you*). Unattended use is safe: a guided shot waits for you at most `--guided-wait` seconds (default 120); if nobody answers, that shot and the other guided shots in the job are marked **needs you**, so a companion left running in `--watch` mode never hangs on a screen nobody is there to set up. With `--headless` guided shots are marked *needs you* at once.

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

**The newer agent layout.** A newer Copilot Studio agent shows a tab strip (Build, Preview, Evaluate, Monitor) instead of separate Knowledge, Topics, Tools, and Settings pages. Measured on a real agent: an address such as `.../knowledge` stays in the address bar but the page shows the Build tab, so a picture could pass the address check while showing the wrong screen. After the page settles, the companion looks for that tab strip (control roles and names only, never page text). If it is there, the Evaluation screen opens the Evaluate tab, the Analytics screen opens Monitor, and Overview stays on Build. A screen that has no page of its own there (Knowledge, Topics, Tools, Channels, Settings) is not photographed as Build: it stops with *This agent uses the newer Copilot Studio layout... which has no separate Knowledge page* (a screen whose steps could not be done says the same before its own reason). Use **Retake guided**, or **Show me once** so the computer learns the screen in that layout. Agents in the classic layout are unaffected.

**If the browser misbehaves.** An interrupted navigation (`net::ERR_ABORTED`, a timeout, a reset connection) is retried twice with a growing pause. A crashed tab is replaced by a new tab in the same browser and the shot is tried again. Closing the browser window pauses the job once and tells you how many shots are waiting; in `--watch` mode the companion keeps running and picks up the next job, for example the one **Resume** queues.

**What it never does.** In every mode the companion never signs in or out, switches or removes an account, deletes or removes anything, changes tenant, environment, admin, billing, licensing, security, DLP, or permission settings, installs or consents to an app, creates a connection with credentials, shares or publishes to anyone else, sends a message or an email, or uploads or downloads your files. In read-only and the older modes it also never creates, edits, saves, or publishes anything: it refuses any control named Publish, Create, Save, Submit, Send, Add, Edit, New, Deploy, Apply, Confirm, Run, and similar (and any control that submits a form), whatever the plan says. Automatic mode adds only the interactive-safe actions listed in the tier table below.

**Older portals.** The companion still runs a plan from a portal that does not classify its shots (the way it did before, with the stricter control rules). Download it again after the portal is updated to get the new behavior.

### Automatic capture (autonomous mode)

Automatic mode is for "do it for me": the computer sets up the screen itself (opens the test pane and asks a sample question, opens a dialog and cancels it after the picture, opens an item's detail panel, reaches Agent Builder through Microsoft 365 Copilot) and photographs it, with no click from you after the one-time sign-in. **Capture all screenshots automatically** in the Screenshot Center queues it (`options.mode: "autonomous"`), and the Step 8 capture-on-build checkbox uses it when a computer is connected. Guided capture stays as a last resort for a shot that automation tried and could not complete, and the portal says exactly which step failed.

**Consent first.** The first automatic job shows a consent card in the Screenshot Center. The portal sends the computer only what you allowed; a job without consent fields behaves as read-only, and the companion enforces what the job carries.

**The safety tiers** (one table, in `guard.mjs`, shared with the portal and shown in the consent card; `node companion.mjs --dry-run-plan` prints a job's steps by tier without a browser):

| Tier | Name | Examples | When |
| --- | --- | --- | --- |
| 0 | Look | Navigate, open sections, expand, select tabs, scroll, hover | Always |
| 1 | Try | Open menus, dialogs, panels, and pickers; type into the test chat and send test messages; type into search and filter boxes; fill a dialog's fields **without confirming** it, then cancel it after the picture; discard unsaved edits | Automatic mode with consent. Never confirms a committing or destructive button |
| 2 | Practice | Create, edit, save, and publish **only inside a practice agent the companion created itself** (named `Lab screenshots - ...`, listed in `.practice-agents.json`), only for shots that really need that state; only the default internal publish | The consent option *and* `--allow-practice-writes` on this computer (saved until `--no-practice-writes`). Otherwise the shot is captured as far as Tier 1 allows and labeled *needs practice agent* |
| 3 | Never | Sign out; switch, add, or remove accounts; delete or remove anything (cleanup included); change tenant, environment, admin, billing, licensing, security, DLP, or permissions; install or consent to apps; create connections with credentials; touch anything but the practice agent; send messages or emails; upload or download files; share or publish to external channels; leave the product's own sites | Never |

Every click and every typed character goes through one gate that classifies the control (its role, accessible name, the nearest dialog's title, its ancestors) before acting, refuses unknown controls in Tier 2 and 3 contexts, and records the decision in the trace. A neutral button in a dialog titled *Delete agent* is treated as destructive. Words such as Delete, Remove, Sign out, Publish to channel, Share, and Invite are recognized in several languages, with any capitalization, and by their icon-only accessible names. After a run, `practice-report.md` (next to the companion's data) lists everything it created, and the portal names it; **the companion never deletes anything**, so you delete the practice agent yourself.

**A resilient executor.** Each setup step is a small verified state machine. A control is found by ranked strategies (role and exact name inside the expected area, role and a normalized name, `aria-label` or `title`, the visible text's nearest interactive ancestor, then a fuzzy match over interactive controls only), across iframes and open shadow DOM. A click that changes nothing is not success: it tries the next candidate or strategy. A step passes only when its expected evidence is on the page (a dialog, a label, an address, a finished answer: no typing indicator and a stable answer area). Cookie banners, teaching and what's-new pop-ups, toasts, and leave-the-page prompts are dismissed. When a shot cannot be completed it ends *needs you* with the exact failing step and writes a redacted **diagnostic bundle** to `.captures/diagnostics/` (roles and accessible names of the visible controls around the failing step, the URL host and path, the step id, strategy attempts, and timings; no query strings, cookies, page text, or account or tenant names). Send that file if you ask for help. `node companion.mjs --diagnose[=<product>]` writes one for the page open in a live browser.

**Show me once.** When automation cannot complete a shot, press **Show me once** on that shot and set the screen up by hand. The companion records the interactions as tier-checked declarative steps (role, accessible name, and area; never coordinates, never typed values that look like secrets, never account information; Tier 3 interactions are skipped) and saves the recipe under `.recipes/` on this computer. The next run replays it automatically with the same self-healing, and a replay that fails marks the recipe stale. **Share this recipe** is your explicit choice: the portal validates it again (it rejects URLs with query strings, email addresses, tenant or environment GUIDs, and long text) and offers it to every lab and user.

**Background.** `--background` (the portal's **Run in the background when already signed in**) uses a hidden window with the saved session. If the tenant refuses it (Conditional Access, a sign-in redirect), the companion opens a normal window with one message. The first sign-in is always visible. `--headless` still cannot sign in.

**What is verified and what is not.** Automatic mode is proven against the deterministic pretend product site in `test/fixtures/fake-product-site.mjs` (streaming test pane, dialogs that must be canceled, a publish dialog, create-agent, Delete agent, Sign out, an admin page, iframes, shadow DOM, a cookie banner, a leave-page prompt, renamed controls, a flaky control, an Agent Builder page with no direct address, a SharePoint site) in real Chromium and the installed Edge: `node test/fixtures/autonomous-matrix.mjs` prints the before and after numbers. **Real Copilot Studio, Agent Builder, and SharePoint pages are not verified.** Their control names, landmarks, test-pane markup, and timings are assumptions until a run on a real tenant, and the practice-agent creation steps are written against the pretend site. When a built-in step does not match a real page the shot ends *needs you* with a diagnostic bundle, and **Show me once** teaches the companion the real step.

### Signing in once per product

The companion never types a password or clicks a sign-in button. You sign in yourself, and it only watches the address bar to know when you are done.

- **While you sign in, it only watches.** Once the browser is on a Microsoft sign-in page (or your company's identity provider), the companion makes no navigation, reload, retry, click, or picture until the page has left the sign-in pages and stayed on the product. Then it keeps watching several more seconds, because many apps finish signing in with one more round trip (a live Copilot Studio sign-in took about 13 seconds after the sign-in page to reach the home page, with pauses of about 4 seconds between pages). Every navigation it does make is written to the trace with its reason (`--debug`).
- **The first page of a product is watched for about 10 seconds.** The real products show their own page for several seconds (about 6 for Copilot Studio) and only then send the browser to sign in, so a quiet first page is not proof of a signed-in session. This happens once per product per job. After a fresh sign-in lands on the product's home page, the companion opens the screen it was asked for once.
- **One sign-in wait per product per job.** When a page turns out to be the Microsoft sign-in page, the companion waits for you (up to `--sign-in-wait` seconds), prints one message, and tells the portal. It waits through **Stay signed in?**, the account picker, multi-factor prompts (a 20-second wait for a phone approval is fine), consent pages, and **Working on it** pages. A quick silent trip to the sign-in page, a page that redirects to sign-in a moment after it loads, and a signed-in page whose address merely mentions a sign-in address are all handled without bothering you.
- **A sign-in that loops is stopped and explained.** If the browser bounces between the product and a sign-in page three or more times within 90 seconds without ever staying on a sign-in page long enough for you to type, the companion stops, leaves the window open so you can look at it, and prints the likely causes: sign-in files in a synced folder, blocked cookies, Conditional Access that wants a managed device or a particular browser, a wrong clock, a stale saved sign-in, blocked pop-ups, and the `AADSTS` error number if Microsoft shows one (an error number is not a secret; no other page text is read). The portal shows the same verdict and the next step.
- **A sign-in nobody finishes is not called a loop.** If the sign-in page just sits there (no page changes, no bouncing) until the wait runs out, the first thing the companion says is that the sign-in page was waiting for you, and what to do in that window. `--sign-in-wait=<seconds>` allows more time.
- **The window can open behind your other windows.** Windows does not let a program started in the background take over the screen, so the sign-in window may open behind the window you are using, which looks like a sign-in box that vanished. A live run showed exactly this: the window was behind other windows for most of the sign-in. The companion asks the browser to come forward once when it starts (Windows may still keep it behind, and a test showed it often does), then never again, so it will not take focus while you type. It says where to look in the console and the portal ("look for the new browser window on the taskbar"), and `--check-signin` records whether the window was covered.
- **If sign-in does not finish, it stops.** The rest of that product's shots are reported once, right away, as needing a sign-in (the portal shows **Sign in to <product> on your computer, then retry the N screenshots**). The companion does not reopen the sign-in page for every shot.
- **Choose Yes on "Stay signed in?"** Without it, Microsoft keeps the sign-in in a session cookie that a closed browser throws away. The companion saves those cookies itself after every successful capture and restores them the next time, but **Yes** makes the sign-in last across restarts without relying on that.
- **Each product has its own sign-in.** Copilot Studio, Agent Builder, SharePoint AI, Microsoft Foundry, the Microsoft 365 Copilot hub, and the Power Platform AI hub each use their own browser profile, so a lab that spans two products asks you to sign in to each one once. Each browser kind (Edge, Chrome, Chromium) also has its own profiles.
- **Never clicks anything that signs in or out.** It refuses controls named Sign in, Sign out, Log in, Log out, Switch account, Use another account, Add account, Remove account, and the account and profile menus, however the plan names them, and it checks the link behind a control as well.
- **Pausing and stopping in `--watch` mode.** After a job ends without a sign-in, the companion waits 30 seconds before taking another job (60 seconds after a second one). After three jobs in a row that ended without a sign-in for the same product, it stops taking jobs and tells you why, so it cannot loop. Fix the sign-in, then start it again. A job the portal hands back after the companion already ran it twice is closed instead of run again.

#### Where the companion keeps its data

Since version 1.4.0 the pairing file, browser profiles, traces, recipes, and the practice-agent list live in a **local folder of your user account**, never beside the code:

| System | Default data folder |
| --- | --- |
| Windows | `%LOCALAPPDATA%\CopilotStudioLabsCompanion` |
| macOS | `~/Library/Application Support/CopilotStudioLabsCompanion` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/copilot-studio-labs-companion` |

Why: a live browser profile has a locked cookie database and files that change all the time, and a saved sign-in lets anyone who has it act as you. OneDrive, Dropbox, iCloud Drive, and Google Drive can lock or lose those files (the sign-in never sticks and loops) and upload the sign-in to the cloud. Unzipping the companion into your Documents folder (which OneDrive often syncs) is fine now, because only the code lives there.

- **Synced folders are refused.** `--home=<folder>` and `COMPANION_HOME` still work, but if the folder is inside OneDrive, Dropbox, iCloud Drive, Google Drive, or Box (found from the folder names on its path, the `OneDrive`, `OneDriveCommercial`, and `OneDriveConsumer` environment variables, the macOS `CloudStorage` folder, and on Windows the read-only reparse-point attributes that OneDrive Files On-Demand sets), the companion refuses to start and prints the exact command with the local folder. `--allow-synced-home` overrides that (not recommended). `--status` and `--check-signin` show where the data is and warn about a synced folder.
- **Moving from an older version.** On the first start the companion copies the pairing file, settings, practice list, and recorded recipes from the old place (beside `companion.mjs`) into the local folder. If the old folder is synced, the pairing file is moved so the token does not stay in the cloud. The browser profile is not copied (it may be damaged), so you sign in once more. A small saved-session file is kept when the old folder was not synced. The old `.auth` folder is never deleted without being asked: run `node companion.mjs --delete-old-signin` (or answer **y** when it asks).

#### How the browser is started

By default (`--launch=auto`) Edge and Chrome are started **the normal way**: the companion runs your installed browser as an ordinary program with its own profile folder in the data folder and a debugging port, then connects to it. The port is random and listens on `127.0.0.1` only, and it closes when the browser exits. The companion does not add the switches Playwright's own launcher adds (the "controlled by automated test software" bar, disabled extensions, and others), because some organizations' device-based sign-in (Conditional Access that wants a managed or compliant device, Windows work-account single sign-on) does not work in a browser started that way, and the sign-in bounces. Nothing is hidden: the browser reports itself as it always does, and you sign in by hand.

- `--launch=playwright` uses Playwright's launcher (the previous behavior). `auto` falls back to it with one message if the normal start fails; `--launch=attach` never falls back.
- The bundled Chromium is always launched by Playwright. `--headless` and `--background` use a hidden window of the same browser.
- One companion per profile: a second one is refused. The browser process is ended when the job ends, when you press Ctrl+C, and when the companion crashes.

#### Checking a sign-in that will not stick

```powershell
node companion.mjs --check-signin                 # Copilot Studio
node companion.mjs --check-signin=ai-foundry      # another product
```

It opens the product's start page once, then only watches while you sign in, and prints a verdict in plain language: the sequence of pages (host and path only, never query strings) with timings, whether the browser was started the normal way, whether this computer is joined to a work or school account (yes or no, from `dsregcmd`), which sign-in and product cookies exist (names and attributes such as `Secure`, `HttpOnly`, and whether they survive closing the browser, **never values**), whether the browser profile blocks cookies, whether the data folder is synced, how far this computer's clock is from Microsoft's, and any `AADSTS` error number. The same text is written to a redacted trace under `.captures/traces/check-signin-<time>.log`, which has no query strings, cookie values, tokens, page text, or account and tenant names, so you can send it to whoever helps you.

The check also records what the browser **window** did, without reading any page text and without touching the window: how many windows and tabs there were, whether a popup opened or a tab closed, whether the window was minimized, whether the sign-in page rendered its form or went blank (counts of elements and inputs only, never their text), whether the page title was empty (never the title), and, on Windows, whether the window was in front or covered by another program, and whether a Windows sign-in window (such as the credential or account broker) was open. Only a short list of sign-in broker program names is ever reported; any other program is just "another-app". This is the `Window:` line in the verdict and the `surface-*` events in the trace.

**What is saved.** In the data folder, `.auth/<browser>/<product>/` (or `.auth/separate/<browser>/<product>/` for a separate sign-in on a PC with a Windows work account) holds the browser profile, `companion-session.json` (your browser's cookies for that product, including session cookies), `companion-signin.json` (when it last worked), and `companion-account.json` (yes or no flags about the account: how it was chosen, whether it was verified or confirmed, whether it is the account Windows uses for work; never a name, a tenant id, or an address). **Anyone who has these files can act as the signed-in account**, so keep the folder private. They stay on this computer, are git-ignored, and are left out of the companion download and the container image. To start over for one product run `node companion.mjs --forget-signin=copilot-studio`, or for everything `--forget-signin=all`. You can also delete the product's folder under `.auth/` yourself. Folders from older versions, such as `.auth/copilot-studio/`, are not used by the companion any more; delete them if you like.

### Which account the screenshots come from

A screenshot shows whatever account the browser is signed in with. For a lab that is almost always your **demo tenant**, not the account your computer signs in with at work. Screenshots from a work tenant would also be uploaded into your labs and exports, which is a privacy risk, so the companion makes the account **explicit, correct, and verified** before it takes a picture.

**Why this needs care.** A Windows PC joined to a work or school account (Microsoft Entra) has a *Windows work account*. Microsoft Edge can use it: on a managed PC Edge signs its profiles in with that account (often forced by an organization policy), and on a Microsoft sign-in page it can offer that account with one click or sign in with it by itself. Browsers that have no Windows account integration (Chromium from Playwright, Google Chrome without the Windows Accounts extension) just show the normal sign-in page, so you choose the account.

**What the companion does by default.**

1. At start it reads, on Windows, whether this PC has such an account (`dsregcmd /status`: Entra joined, work account added, domain joined, and whether a sign-in token exists). It keeps only yes or no. The Windows account's tenant id is used in memory to compare and is never printed, traced, uploaded, shown, or saved.
2. If it has one, `--account-mode` defaults to **`separate`**: the companion never takes the Windows account on its own. `--browser=auto` then tries **Google Chrome, then Chromium, then Microsoft Edge opened InPrivate** (an InPrivate window has no browser profile, so it does not carry the Windows account). Without a Windows work account (or on macOS and Linux, where it cannot tell) nothing changes: Edge, then Chrome, then Chromium.
3. A `separate` sign-in has its own profile folder (`.auth/separate/<browser>/<product>/`), so a profile that was signed in by the Windows account (the original `.auth/<browser>/<product>/` folders) is **never reused** as a separate one. You sign in once, yourself, with the account you want. The companion remembers it on this computer.
4. After sign-in, before the first screenshot of each product, it checks which account this is and stops with one plain sentence if it is wrong (see below). The console says at the start what each choice does.

| Option | What it does |
| --- | --- |
| `--browser=auto\|edge\|chrome\|chromium` | Which browser. The explicit choice is never changed, but in `separate` mode on a PC with a Windows work account Edge is opened InPrivate. Quick fix if Edge picked your work account: `--browser=chromium`. |
| `--account-mode=separate\|windows` | `separate` (the default when the PC has a Windows work account): you sign in yourself and the Windows account is never taken silently. `windows`: allow the old behavior **on purpose**: Edge opens normally and may sign in with your Windows work account, and screenshots then come from that account. The console and the Screenshot Center say so. |
| `--setup-account[=<product>]` | Choose the account: opens the browser on the dedicated profile at the product's start page and tells you to sign in with the account you want. See below. |
| `--forget-signin=<product>\|all` | Removes every saved sign-in of the product, in both profile layouts (separate and original). |

**Choose which account to use.** Run `node companion.mjs --setup-account` (or select **Choose which account to use** in the Screenshot Center, which asks the connected companion through its next check-in, so a window opens on your computer within a few seconds). The companion starts from a clean sign-in profile so you are shown a sign-in page, opens the product, and says what to do. **You** sign in with the account you want; if the browser shows a list of accounts (or **Use another account**), **you** pick. The companion never clicks, types, or picks an account: it only watches the address bar, like for every sign-in. When the page lands, it checks it (below), records that you chose the account, saves the session on this computer, and closes the window. If an account list shows, it simply waits.

**How it knows which account this is (never by reading page text).** After sign-in each profile gets one of these labels, kept as a flag in `companion-account.json` next to the profile:

| `account.source` | Meaning |
| --- | --- |
| `windows-sso` | No sign-in page was shown (a redirect to the sign-in host that passes in about a second or two) **and** the page landed in the Windows work account's own tenant (the `Default-<tenant id>` part of a Copilot Studio environment address, or a tenant id in a product address). |
| `manual` | A sign-in page stayed long enough for a person to use it (three seconds or more) and was completed. |
| `saved-session` | A sign-in saved on this computer was restored with no sign-in page, and it does not land in the Windows tenant, or the profile was classified before. |
| `unknown` | None of these can be told (for example, a product address that has no tenant id in it). |

The companion also keeps `inOsTenant` (a yes or no): whether the account is the same one Windows uses for work. Both labels and the yes or no are all that is ever reported. If you sign in yourself with your work account, `source` is `manual` and `inOsTenant` is yes: allowed, because you chose it, but the Screenshot Center warns that screenshots will come from that account.

**The wrong-account guard.** Before the first screenshot of each product the companion opens your own address when the job carries one (the Copilot Studio agent or environment address, the SharePoint site, a Power Platform environment, a Foundry project) and compares where the browser landed (host and path only, plus whether the page title is empty), without reading page text:

- **`windows-sso` in `separate` mode** stops the product with: *Edge signed in automatically with your Windows work account, not the account that owns this agent. Restart with --browser=chromium, or run --setup-account.* With `--account-mode=windows` it is allowed on purpose, unless it does not fit your address, which stops too.
- **The address leads somewhere else** (another environment id, another SharePoint host, an access-denied or not-found page, the agent never opened) stops with: *You are signed in to a different account than the one that owns that agent. Run --setup-account and sign in with the account you want, then retake.*
- **Addresses not set.** The job may still run, but the readiness strip says **Account not verified**. **Automatic capture does not start**, even with consent, until the account was verified against one of your addresses or you confirmed it once with `--setup-account` (only a yes or no is stored). A name (an agent name) is not an address.

A stop is reported to the portal as the shot status `needs-account` (a failed shot with the cause *Signed in to the wrong account*). The Screenshot Center shows the one-sentence fix and a **Choose which account to use** button.

**How to check which account is in use.** `node companion.mjs --status` shows the account line and, for each profile, how its account was chosen and whether it was verified; `--check-signin` prints the same after a sign-in; the Screenshot Center shows **Account: separate sign-in (browser: Chromium), verified for your agent.**, or **Account: your Windows work account (Edge single sign-on). Screenshots will come from that account.** with a warning and the fix button, or **Account not reported (update the companion)** for a companion older than 1.5.0. Nothing shows a tenant id, an address, or an account name.

**Measured on a work-joined PC** (fresh throwaway profiles, headed, nothing signed in, only the hops and timings observed). On that PC Edge was configured by policy to sign every profile in with the work account.

| Mode | Sign-in page shown? | What it offered |
| --- | --- | --- |
| Edge, normal (attach, or Playwright's launcher) | yes (it did not finish by itself in repeated runs) | an account list with the Windows work account one click away |
| Edge InPrivate | yes | an empty sign-in box, no Windows account |
| Chromium from Playwright (attach or launcher) | yes | an empty sign-in box |
| Google Chrome | not measured: not installed on that PC | |

Silent sign-in in Edge on a work-joined PC did not happen in these runs, but it can happen (it depends on the organization's policies and on timing), so the companion never relies on this: it classifies the result afterwards. That is why the default avoids a normal Edge window when a Windows work account is present.

#### Browser differences that matter for pictures

The companion normalizes these so a picture is the same in every browser. Measured with Edge and Chromium on a 150% display scale:

- **Size and display scaling.** Before the viewport is set, Edge's page was 1.5 times larger (1542 by 1362 pixels). The companion sets the viewport to 1440 by 900 CSS pixels at a device pixel ratio of 1 before every shot, reads it back (`viewport` in the trace), and sets it once more if it did not take. Pictures are 1440 by 900 pixels in Edge and Chromium. The visible window is also resized toward the picture size, as far as the screen allows, so a screen you set up yourself is not cropped.
- **A window that another window covers.** A browser started the normal way throttles a covered window, and a picture of it can hang (it did in Chromium; Edge was not affected). The companion adds three documented switches that only turn that throttling off for hidden windows (`--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding`, `--disable-background-timer-throttling`). They change nothing about how the browser identifies itself. A **minimized** window cannot be captured in any browser (the picture times out): keep the window open, not minimized.
- **Extra tabs.** A new browser profile opens, closes, and replaces its own first tabs; the companion waits for that to settle and closes the browser's own leftover pages (`edge://`, `chrome://`, `about:`) before each shot. It never closes a page of the web (a sign-in popup, a product tab). `--no-first-run` and `--no-default-browser-check` keep the welcome pages away.
- **Edge extras that do not matter.** The sidebar, the Copilot panel, shopping and coupon bubbles, sign-in-to-sync prompts, and translate bubbles are browser interface, not page content, so they are not in the picture.

### Security model

- **Paired, scoped, revocable.** A one-time code is traded for a capture token (`cap_...`). The portal keeps only a hash of the code and the token, compares them in constant time, extends the token while you use it, and lets you disconnect the computer at any time. The token opens only the companion endpoints; it is not a portal sign-in and cannot read or change anything else. A revoked or expired token is refused and the companion tells you to pair again.
- **Nothing secret in the download or in git.** The portal's download and this folder contain no tokens. The pairing file `.companion.json`, your browser sign-ins (`.auth/`, including the saved session cookies), and in-progress captures and traces (`.captures/`) stay on your computer, are git-ignored, and are left out of the companion download and the container image. The token is saved with owner-only permissions where the system supports it and is never printed.
- **Your credentials never leave your computer.** You sign in yourself in a real browser window. Only screenshots, page addresses (without query strings), the page title, and visible control names are sent, and only to the portal you paired with. Portal addresses must be `https` (`http` is allowed for `localhost` only).
- **It never types into tenant pages and never changes the tenant.** Steps are limited to opening an `https` page, waiting, dismissing banners, and clicking an exact-name navigation item or tab. It skips any control whose name says delete, remove, erase, purge, destroy, disconnect, unregister, revoke, or reset, any control that creates or changes something (Publish, Create, Save, Submit, Add, Edit, and similar, or a button that submits a form), and any control that signs in or out or switches the account (Sign in, Sign out, Switch account, Use another account, the account menu), whatever the portal asks for. It does not change how the browser identifies itself or hide that it is automated; it uses a normal installed browser that you sign in to yourself.
- **Account details are hidden.** Before each picture it draws a solid block over the account control (including the account menu of the newer Copilot Studio layout) and over any email address, tenant host name (`*.onmicrosoft.com`, SharePoint admin and personal hosts), or `--mask` term on the page, then removes the blocks. Text sent to the portal as evidence is scrubbed the same way. A diagnostic file keeps control names but drops the person or environment named in a label such as *Open account menu for ...*. The environment name shown in the navigation is not hidden: look at a screenshot before you publish it, and use `--mask` for names you want covered.
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
| **The screenshots show the wrong tenant, the wrong screens, or "Edge signed in automatically with your Windows work account..."** | The browser is signed in with your work account instead of your demo tenant. Right now: restart with `--browser=chromium`. Then run `node companion.mjs --setup-account` (or select **Choose which account to use** in the Screenshot Center) and sign in yourself with the account you want. `--status` shows which account each profile uses. See [Which account the screenshots come from](#which-account-the-screenshots-come-from). |
| `You are signed in to a different account than the one that owns that agent` (or site) | The address you gave leads somewhere that account cannot see. Run `node companion.mjs --setup-account`, sign in with the account that owns it, then retake. Check the address in the capture settings if it keeps happening. |
| `Automatic capture waits until you have chosen the account` | Automatic capture does not start until the account was checked against one of your addresses or you chose it once. Add your agent address in the capture settings, or run `node companion.mjs --setup-account`. |
| **It took one screenshot, then kept asking me to sign in and never succeeded** | Update to this version (the companion shows `Local Capture Companion 1.1.0` or later: download the companion again from the portal, or `git pull`). Older versions looked at the address once, right after a page started to load, so a product that sends you to sign in a moment later was captured as a sign-in page and the next shot restarted the sign-in before you could finish. They also opened a separate browser profile for each product and threw away session cookies when it closed. Then: (1) close the companion and run `node companion.mjs --forget-signin=all` to remove stale sign-ins, delete any old `.auth/<product>/` folders, and start again; (2) when asked, sign in and choose **Yes** on **Stay signed in?**; (3) expect one sign-in per product. If it still loops, run `node companion.mjs --once --debug` and send the trace file it prints (see below). |
| The sign-in box disappeared, or nothing seems to happen after the companion says it is waiting | The sign-in window is probably behind your other windows. Click the new browser window's icon on the taskbar. Run `node companion.mjs --check-signin` to see whether the window was covered (the `Window:` and `in front` lines) or whether a Windows account window was open. |
| The sign-in page appears again right after you signed in, the page says you cannot access this from this device, or the browser bounces between the product and sign-in | Start with `node companion.mjs --check-signin` (see above): it says which cause is likely. The usual ones, in order: (1) the data folder is in OneDrive or another synced folder (version 1.4.0 and later refuse that; older versions kept sign-in files beside the code, so update and sign in once more); (2) your organization's Conditional Access policy wants a managed or compliant device, so use the installed Microsoft Edge on a managed computer with the default `--launch=attach` (Playwright's own launcher can break device-based sign-in); (3) a stale saved sign-in, so run `--forget-signin=<product>`; (4) cookies or pop-ups blocked in the companion's browser window; (5) a wrong clock. If a policy still blocks it, ask your administrator to allow this device or browser for the account you use for captures, or capture those shots with an OS screenshot tool and upload them in the portal. The companion never tries to get around a policy. |
| `The companion's data folder is inside OneDrive` (or Dropbox, iCloud Drive, Google Drive) | Run the command it prints (it has `--home=` set to a local folder), or set `COMPANION_HOME` to a local folder. `--allow-synced-home` overrides this, but a synced folder is the most common reason a sign-in never sticks. |
| `Another companion window is already using this sign-in profile` | Close the other companion (or its browser window) and try again. One profile folder is used by one companion at a time. |
| `... could not be started the normal way` | The companion fell back to Playwright's launcher. Check that Edge or Chrome starts on its own, then try again, or use `--launch=playwright` on purpose. |
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
