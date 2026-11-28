# Microsoft 365 Copilot Agent Builder capture slots

What the Local Capture Companion does for every Agent Builder picture slot (the `dca-` pictures of the `m365-copilot-agent-builder` product), and what is left for a person. Written from what a real tenant showed on 2026-11-27 (read only, window 1440 by 900, nothing typed, saved, sent, or created) and from Microsoft Learn. Companion 1.8.2 or later. US English, plain text.

The slot list is the 43 shots in `tools/screenshot-capture/feature-shots.m365-copilot-agent-builder.json` (generated from `portal/lib/lab-builder/catalog/m365-copilot-agent-builder.json`). The recipe is in `tools/screenshot-capture/recipes-builtin.mjs` (`m365.agent-builder.open`), the exact reasons are `AGENT_BUILDER_UNSEEN_SLOTS` in the same file, and the stop is in `runShotSetup` in `tools/screenshot-capture/autonomous.mjs`.

## What was read on a real tenant (2026-11-27)

1. **The start page.** `https://m365.cloud.microsoft/chat` redirects to `https://copilot.cloud.microsoft/home`. The left side bar has: the link *Copilot, home*; the buttons *Apps and more*, *Tasks*, and *Collapse sidebar*; the tabs *Home* and *Code*; the links *New*, *Search*, *Library*, *Automations*, and *Plugins*; the **button** *Agents*; the link *Workspaces*; the button *Projects* (with *New project* and *Add project here*); the *Recent* list; the account button; and *Settings and more*. The message box is the text box *Message Copilot*, with the radios *Chat* and *Cowork* and a *Model and generation settings* button.
2. **The Agents button does not navigate.** The address stays `/home`. It opens a flyout, a dialog named *Agents menu*, that lists the person's agents as links, then a **link** named *New agent* (to `/agents/new`) and a link *More agents & plugins*. The old recipe looked for a role button named *Create agent* in the main area, so it could never match.
3. **The start screen.** The *New agent* link goes to `copilot.cloud.microsoft/agents/new` (the address gets `?redirfrom=mcmToCcm`), page title *Microsoft Copilot*. The heading is *Build your own specialist agent*. Controls: the button *Skip* (top right of the panel), the text box *Message Agent Builder*, the buttons *Add and manage sources* and *Start dictation*, a source filter tab strip (*All*, *Files*, *Meetings*, *Chats*, *Channels*, *Sites*, *Fabric*), the tabs *Templates* and *My agents*, and template buttons (*Plan My Day template*, *Project Delta Digest template*, *Executive Briefing Agent template*, and *View all*). There are **no Describe or Configure tabs** on this screen: the builder is a conversation (you message Agent Builder).
4. **Not read.** What *Skip* does, what the screen shows after a message is sent, and where an agent's Configure, Try it, Knowledge, Skills, Share, and About this agent screens are in this layout.

## What the recipe does (the start screen only)

Only `dca-new-agent-page.png` has a recipe. It matches by file name (a library name that carries a harness tag is the same slot), never by words.

| Step | What it does | The step is OK only when | If not, the person reads |
| --- | --- | --- | --- |
| `agents-flyout-open` | Clicks the side bar **button** *Agents* (Tier 1, opens a dialog). Left out when the start screen is already open. | A dialog opened. | The side bar has no button named Agents that could be clicked (it may be collapsed or renamed). |
| `agents-menu-shown` | Looks for a dialog named *Agents menu* (a look, nothing is clicked). | The dialog is showing. | The Agents button was clicked, but no dialog named Agents menu opened. |
| `new-agent-open` | Clicks the **link** *New agent* inside that dialog (Tier 1). | The address path is `/agents/new`. | The Agents menu is open, but it has no link named New agent that opened the New agent page. |
| `builder-address` | Waits for the address path `/agents/new`. | The path is `/agents/new`. | The New agent link was clicked, but the address did not become `/agents/new`. |
| `builder-start-shown` | Looks for the heading *Build your own specialist agent* or the text box *Message Agent Builder*. | One of them is showing. | The address is the New agent page, but neither the heading nor the message box is showing. |

Every message is plain, names the control, and ends with the way out (use "Retake guided"). The recipe never clicks a template, *Skip*, *Send*, *Add and manage sources*, *Start dictation*, or anything that creates, saves, publishes, shares, or submits, and it types nothing. The picture is checked by the heading (a picture without it is saved for review).

**Reached by clicks, not by address.** The companion has no step that types an address, and the start page allows the in-app path, so the recipe uses the click path only. When the start screen is already open (a person is there), the three click steps are left out and the address and the content are still checked. The portal shows the shot as automatic (the "navigate" family, checked by landmark), and the Screenshot Center keeps the other seven shots of an Agent Builder lab with their fixed reason.

## What happens to every other slot

A slot with no recipe ends as **Needs you** before any step runs. The reason is the exact sentence in `AGENT_BUILDER_UNSEEN_SLOTS`, then "Use “Retake guided”, or upload the picture." (a job row shows 300 characters, so every reason fits). A person who recorded a recipe with **Show me once**, or shared one, is not stopped: that recipe is tried instead, the same way a Standard slot works. A person who sets the screen up with "Retake guided" is not stopped either.

Categories used below:

- **a** The slot has a recipe.
- **b** The screen was never read on a real tenant, so no recipe can be written (read the groups M1 to M8).
- **c** The picture is Visual Studio Code, outside the browser (use an operating system screenshot tool).
- **d** The picture is an admin screen, which the computer never opens or changes.
- **e** The picture needs an action the computer never does (share an agent, invite people, submit to the org catalog) or a state only a person's tenant has.
- **f** The picture is a chat with an agent that a person built and provisioned from Visual Studio Code with Microsoft 365 Agents Toolkit, which the computer never builds or provisions.

Result: 1 slot with a recipe, 18 slots of category b, 8 of c, 5 of d, 4 of e, and 7 of f.

## Slot table (43 rows)

| feature | file | category | what the companion does | what is needed or never read |
| --- | --- | --- | --- | --- |
| dca-declarative-agents-overview | dca-review-existing-agents.png | b | Needs you, with its own reason. | The page that lists agents already available to you. The Agents menu was read (your agents, New agent, More agents & plugins); the page that More agents & plugins opens was not. M1. |
| dca-licensing-and-environment | dca-upload-custom-apps-policy.png | d | Needs you, with its own reason. | A Teams admin center setup policy with a switch turned On (a change). |
| dca-agent-builder-vs-copilot-studio | dca-copy-to-copilot-studio-menu.png | b | Needs you, with its own reason. | An agent's More options menu with Copy to Copilot Studio. M6, M7. |
| dca-agent-builder-vs-copilot-studio | dca-copy-environment-picker.png | b | Needs you, with its own reason. | The environment step of Copy to Copilot Studio, a hand-off to another product that the computer never starts. M7. |
| dca-agent-builder-first-agent | dca-new-agent-page.png | a | Recipe `m365.agent-builder.open`. | The start screen, read on 2026-11-27. M2 confirms the details. |
| dca-agent-builder-first-agent | dca-configure-tab-prepopulated.png | b | Needs you, with its own reason. | An agent's Configure view with Name, Description, Instructions, Knowledge, and Starter prompts filled in. M3, M4. |
| dca-agent-builder-first-agent | dca-try-it-response.png | b | Needs you, with its own reason. | The Try it view with one prompt and its response. M5. |
| dca-agent-builder-templates-icon-mode | dca-template-gallery.png | b | Needs you, with its own reason. | The template list of the start screen. The tabs and buttons were read; which tab is selected on arrival and what View all opens were not. A template is never clicked. M2. |
| dca-agent-builder-templates-icon-mode | dca-icon-and-response-mode.png | b | Needs you, with its own reason. | The icon and the Model section (Auto, Quick response, Think deeper). M3. |
| dca-write-agent-instructions | dca-instructions-field.png | b | Needs you, with its own reason. | The Instructions field holding the lab's instructions (entering them is a change). M3. |
| dca-write-agent-instructions | dca-instructions-test-result.png | b | Needs you, with its own reason. | The Try it view with a response that follows the instructions. M5. |
| dca-agent-builder-knowledge | dca-knowledge-section.png | b | Needs you, with its own reason. | The Knowledge section with Search, Enter URL, Browse, and Upload. The start screen has Add and manage sources and a source filter strip; whether they are those options was not read. M2, M3. |
| dca-agent-builder-knowledge | dca-knowledge-sources-added.png | b | Needs you, with its own reason. | The Knowledge section listing a website, a SharePoint source, and an uploaded file. Adding sources is a change and the computer never uploads files. M3. |
| dca-agent-builder-knowledge | dca-knowledge-test-result.png | b | Needs you, with its own reason. | The Try it view with an answer that only an added source can give. M5. |
| dca-agent-builder-capabilities | dca-capability-toggles.png | b | Needs you, with its own reason. | The capability toggles (Create documents, charts, and code; Create images). M3. |
| dca-agent-builder-capabilities | dca-code-interpreter-chart.png | b | Needs you, with its own reason. | The Try it view with the Fibonacci prompt, a line chart, and the code button. M5. |
| dca-agent-builder-skills | dca-skill-attached.png | b | Needs you, with its own reason. | The Skills section with the new skill listed (adding one is a change). M3. |
| dca-agent-builder-skills | dca-skill-test-result.png | b | Needs you, with its own reason. | The Try it view with output produced by the skill. M5. |
| dca-agent-builder-troubleshooting | dca-get-support-details.png | b | Needs you, with its own reason. | The Get support section of the Help menu, whose IDs must be masked by hand. M8. |
| dca-toolkit-typespec-agent | dca-toolkit-create-agent-options.png | c | Needs you, with its own reason. | Visual Studio Code. Use an operating system screenshot tool. |
| dca-toolkit-typespec-agent | dca-toolkit-lifecycle-provision.png | c | Needs you, with its own reason. | Visual Studio Code. |
| dca-toolkit-typespec-agent | dca-typespec-instructions-result.png | f | Needs you, with its own reason. | Copilot Chat with a toolkit-built agent. |
| dca-toolkit-json-capabilities-action | dca-json-capabilities-array.png | c | Needs you, with its own reason. | Visual Studio Code. |
| dca-toolkit-json-capabilities-action | dca-json-api-selection.png | c | Needs you, with its own reason. | Visual Studio Code. |
| dca-toolkit-json-capabilities-action | dca-json-plugin-response.png | f | Needs you, with its own reason. | Copilot Chat with a toolkit-built agent. |
| dca-toolkit-knowledge-capabilities | dca-typespec-capabilities-code.png | c | Needs you, with its own reason. | Visual Studio Code. |
| dca-toolkit-knowledge-capabilities | dca-typespec-knowledge-answer.png | f | Needs you, with its own reason. | Copilot Chat with a toolkit-built agent. |
| dca-toolkit-developer-mode | dca-devmode-preview-f5.png | c | Needs you, with its own reason. | Visual Studio Code. |
| dca-toolkit-developer-mode | dca-devmode-debug-card.png | f | Needs you, with its own reason. | The debug card returned by a toolkit-built agent. |
| dca-toolkit-api-plugin-typespec | dca-api-plugin-namespace-code.png | c | Needs you, with its own reason. | Visual Studio Code. |
| dca-toolkit-api-plugin-typespec | dca-api-plugin-confirmation.png | f | Needs you, with its own reason. | The first-use confirmation of a toolkit-built agent. |
| dca-toolkit-api-plugin-typespec | dca-api-plugin-list-result.png | f | Needs you, with its own reason. | A toolkit-built agent's answer. |
| dca-toolkit-mcp-plugin | dca-mcp-auth-type-prompt.png | c | Needs you, with its own reason. | Visual Studio Code. |
| dca-toolkit-mcp-plugin | dca-mcp-agent-response.png | f | Needs you, with its own reason. | A toolkit-built agent's answer after sign-in. |
| dca-agent-builder-share-agent | dca-share-dialog.png | e | Needs you, with its own reason. | An agent's Share dialog. The computer never shares an agent. M6 (a person may read it). |
| dca-agent-builder-share-agent | dca-add-people-panel.png | e | Needs you, with its own reason. | The Add people panel. The computer never invites people. M6. |
| dca-agent-builder-share-agent | dca-about-this-agent.png | b | Needs you, with its own reason. | The About this agent dialog with four fields filled in (a change). M6. |
| dca-agent-builder-share-and-catalog | dca-submit-catalog-dialog.png | e | Needs you, with its own reason. | The Submit to your org catalog dialog. The computer never submits an agent. |
| dca-agent-builder-share-and-catalog | dca-catalog-approved-status.png | e | Needs you, with its own reason. | An agent an admin approved. Only a person's tenant has that state. |
| dca-admin-agent-settings | dca-admin-agent-settings-page.png | d | Needs you, with its own reason. | An admin center page. |
| dca-admin-agent-settings | dca-admin-sharing-setting.png | d | Needs you, with its own reason. | An admin center setting. |
| dca-admin-agent-registry | dca-admin-registry-list.png | d | Needs you, with its own reason. | An admin center list. |
| dca-admin-agent-registry | dca-admin-upload-agent.png | d | Needs you, with its own reason. | An admin center flow that uploads a package. |

## Real-tenant exploration checklist (read only)

One visit, in a throw-away or demo tenant, window 1440 by 900. The coordinator runs this with the owner present; the computer does not. One click at a time. Never create, save, send, or publish anything.

M0. Rules for every group
- Allowed: open Home, click the side bar button Agents, read the Agents menu, click the New agent link, click tabs (Templates, My agents, the source filter tabs), open a menu or dialog and leave it with Escape, Close, or Cancel, hover, and read the role, the exact accessible name, the enabled or disabled state, the headings, and the visible text.
- Never: Skip, Send (or Enter in a message box), a template button, anything that adds a source or uploads a file, Start dictation, Create, Update, Save, Share, Add (in a people panel), Submit, Publish, Delete, Download, Copy to Copilot Studio (the menu item may be read), or Sign out. Never type into any field except where a group says "with approval".
- If a prompt about unsaved changes or leaving the page appears, something changed: stop, write it down, and choose Discard or Leave.
- Record for every control: role, exact name, state, order on the page, and the address path (never the full address, the tenant, or a person's name).

M1. The Agents menu (slot: `dca-review-existing-agents.png`)
1. On Home, click Agents. Read the dialog name and every item in order: the agent links (names only), New agent, and More agents & plugins. Note whether the dialog has a heading, and whether any item is a button instead of a link.
2. Click More agents & plugins once. Read the address path, the page title, the heading (does it say All agents?), the tabs or sections, the list columns, and any button names. Use the browser Back button.
3. Open the Agents menu again and hover the first agent link; click nothing in the list.

M2. The start screen (slots: `dca-new-agent-page.png`, `dca-template-gallery.png`, `dca-knowledge-section.png`)
1. Open Agents, then New agent. Read the heading, the title, and the address path with its parameter.
2. Read which of Templates and My agents is selected on arrival, the order of the tabs, every template button, View all, and whether a heading such as Start with a template exists.
3. Click My agents. Read the list, its buttons (does it offer View all agents?), and its empty state. Click Templates again.
4. Read the source filter strip (All, Files, Meetings, Chats, Channels, Sites, Fabric): selected tab and where it sits.
5. Click Add and manage sources (open only). Read the dialog or menu name and every option (look for Search, Enter URL, Browse, Upload, Attach cloud files, My emails, My Teams chats and meetings). Choose nothing. Escape.
6. Hover Skip and Start dictation. Read the accessible names and any tooltip. Click neither.

M3. Skip, with approval, on a throw-away name (slots: `dca-configure-tab-prepopulated.png`, `dca-icon-and-response-mode.png`, `dca-instructions-field.png`, `dca-knowledge-section.png`, `dca-capability-toggles.png`, `dca-skill-attached.png`)
1. Ask the owner first: Skip may start a draft agent. Click Skip once.
2. Read the address path and the tabs (look for Configure, Describe, Try it, Preview). Read every field name and its limit text: Name, Icon (and the pencil control), Model (Auto, Quick response, Think deeper), Description, Instructions, Knowledge (Search, Enter URL, Browse, Upload, Attach cloud files), Starter prompts, the capability toggles, and Skills (and its Add button).
3. Read the header: the buttons (Create, Update, Share), the ellipsis (More) menu items, and the Help menu items (look for Get support). Click none of the action buttons.
4. Leave with the browser Back button. If a leave prompt appears, choose Leave.

M4. Sending a message, with approval, in a demo tenant (slots: `dca-configure-tab-prepopulated.png`, `dca-try-it-response.png`)
1. Type one harmless sentence into Message Agent Builder and send it. This is a write (it may create a draft): only with the owner's approval.
2. Read what the screen shows next: the tabs, the field names and values it filled in, the suggestion chips, and the state of Create. Do not click Create.
3. Leave the page and discard the draft if the product asks.

M5. The test view, after M3 or M4 (slots: `dca-try-it-response.png`, `dca-instructions-test-result.png`, `dca-knowledge-test-result.png`, `dca-code-interpreter-chart.png`, `dca-skill-test-result.png`)
1. Read the tab name (Try it or Preview), the chat box name, the Send button name, New chat, and the suggested prompts. Read when it becomes enabled (the product says: after a name, a description, and instructions).
2. With approval, send one harmless prompt and read the controls on the answer (feedback buttons, the code button, a chart). Click nothing else.

M6. An agent you already own (slots: `dca-about-this-agent.png`, `dca-share-dialog.png`, `dca-add-people-panel.png`, `dca-copy-to-copilot-studio-menu.png`)
1. In the Agents menu or My agents, open an existing agent of your own for edit (the ellipsis, then Edit). Read the header ellipsis items (look for About this agent, Copy to Copilot Studio, Download .zip file).
2. Click About this agent. Read the four field names and the placeholder text. Close it without saving.
3. Click Share (a person reads it; the computer never does). Read who has access, the roles, the Org-wide sharing toggle, and the link buttons. Do not click Add or Copy.

M7. Copy to Copilot Studio (slots: `dca-copy-to-copilot-studio-menu.png`, `dca-copy-environment-picker.png`)
1. Open the ellipsis menu and read the item name only. Do not click it: the next step hands the agent to another product.

M8. Help menu (slot: `dca-get-support-details.png`)
1. Open the Help menu and read its items. Open Get support and read the labels (agent ID, tenant ID, environment ID, session ID). The values must be masked by hand in the picture.

Person-only after exploration (nothing read-only can turn these into a recipe): the 8 Visual Studio Code pictures, the 7 chats with toolkit-built agents, the 5 admin center pictures, and the pictures that need a share, a submission, or an approval.

## Lab text: what changed and what Learn says

The lab text lives in `portal/lib/lab-builder/catalog/m365-copilot-agent-builder.json`, with the captions and alt text in `portal/lib/lab-builder/screenshot-slots.json`. These changes follow the screen where the screen and Learn differ, and keep Learn's wording in brackets so a learner on another layout can still find the control.

| Topic | Microsoft Learn | The screen on 2026-11-27 | What the lab says now |
| --- | --- | --- | --- |
| Where New agent is | New agent in the left pane (build article), or Agents & Skills then New agent (skills article), or Plugins then New agent (Agent store article). | The side bar button Agents opens the dialog Agents menu with the link New agent. | Select Agents in the side bar, then New agent in the Agents menu; Learn's other wordings are named once. |
| Describe tab | The Describe tab takes the description. | No Describe tab. The text box is named Message Agent Builder. | Type the description in the Message Agent Builder box and send it. |
| Skip | Skip to configure. | The button is named Skip (top right). | Select Skip (Learn calls it Skip to configure). |
| Add knowledge in the chat | The plus sign in the chat box. | The button is named Add and manage sources. | Select Add and manage sources (Learn calls it the plus sign). |
| Templates | Start with a template. | The Templates tab and its template buttons (and a My agents tab). | Select the Templates tab (Learn calls the list Start with a template). |
| Configure, Try it, Create, Share, About this agent | Documented. | Not read. | Unchanged. These steps still follow Learn and are unverified in the new layout. |

Learn pages used: Build agents in Agent Builder, Agent Builder overview, Agent Builder templates, Add knowledge sources to an agent in Agent Builder, Add skills to your declarative agent in Agent Builder, and Share and manage agents built in Agent Builder (all under `learn.microsoft.com/microsoft-365/copilot/extensibility/`), and Understand Agents in Microsoft Copilot (`learn.microsoft.com/copilot/manage/copilot-agent-store`). The last one still says Plugins then New agent, and names the test tab Preview, which the build article calls Try it: Learn is not consistent with itself here, and neither wording was seen on the screen.

The features whose steps were compared with Learn on 2026-11-27 carry that date as `lastVerified` (Build your first agent in Agent Builder, Start from a template, Ground an agent with knowledge sources, and Add a skill to an Agent Builder agent).
