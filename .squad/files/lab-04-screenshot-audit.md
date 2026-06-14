# Lab 04 Screenshot Audit
Date: 2026-06-14T03:09:24-05:00
Author: Kane

## Summary
- ✅ Correct: 1
- 🟡 Stale/low-fidelity: 0
- 🔴 Wrong: 7
- ⚫ Placeholder: 10
- ❓ Unverifiable: 0

Additional checks:
- Markdown image references found: 18
- `shots.json` entries found: 18
- Markdown references missing a matching `shots.json` filename: none
- `shots.json` filenames not referenced by markdown: none
- Obvious alt/filename/section contradictions: none in text/catalog; contradictions are in the PNG contents.

## Worklist (re-capture in this order)
1. adaptive-card-json-editor.png — ⚫ PLACEHOLDER — Capture the real Adaptive Card editor in JSON view with the lab payload visible.
2. adaptive-card-preview.png — ⚫ PLACEHOLDER — Capture the real Adaptive Card preview/designer showing City, State, Zip Code, and Submit.
3. adaptive-card-output-mapping.png — ⚫ PLACEHOLDER — Capture the real card node properties showing outputs mapped to Topic.City, Topic.StateInput, and Topic.ZipCode.
4. state-fips-switch-powerfx.png — ⚫ PLACEHOLDER — Capture the real formula editor / Set variable value node using the Switch expression for Topic.StateInput/Topic.StateFIPS.
5. variable-picker-in-url.png — ⚫ PLACEHOLDER — Capture the real URL field with the variable picker open and relevant variables visible.
6. tool-county-demographics-test.png — ⚫ PLACEHOLDER — Capture the real tool test panel after a successful 2023 Harris County response.
7. connected-agent-sharing-enabled.png — ⚫ PLACEHOLDER — Capture the real Census Data Specialist settings page with sharing enabled.
8. flow-agent-trigger.png — ⚫ PLACEHOLDER — Capture the real Power Automate trigger picker with "When an agent calls the flow" selected.
9. flow-state-summary-canvas.png — ⚫ PLACEHOLDER — Capture the real completed Power Automate flow canvas with all required actions visible.
10. evaluation-results.png — ⚫ PLACEHOLDER — Capture the real evaluation results dashboard with pass rate, per-test results, and activity map/failure detail.
11. topic-add-from-blank.png — 🔴 WRONG — Re-capture the Topics page with the + Add a topic dropdown open and From blank visible/highlighted.
12. global-variables-list.png — 🔴 WRONG — Re-capture the agent variables/global variables panel listing DefaultState, DefaultYear, and APIKey.
13. tool-county-demographics-inputs.png — 🔴 WRONG — Re-capture the Get County Demographics tool Inputs configuration screen.
14. connected-agent-config.png — 🔴 WRONG — Re-capture the Energy Intelligence Agent Agents page after Census Data Specialist has been added, with its description visible.
15. model-selection-comparison.png — 🔴 WRONG — Re-capture a composed comparison showing model selector plus two model responses to the same prompt.
16. eval-test-methods.png — 🔴 WRONG — Re-capture the Create a test set dialog with Similarity, General quality, and Keyword match checked.
17. mcp-tool-discovery.png — 🔴 WRONG — Re-capture the MCP discovered tools list with all four Census tools visible.

## Detailed findings

### copilot-studio-home.png
- **Section:** Use Case #1, Step 1
- **Markdown alt:** "Copilot Studio home page with the Agent option selected and the \"Start building from scratch\" tiles for Agent, Computer-using agent, and Create workflow."
- **Markdown context:** The learner opens Copilot Studio and should land on the "What would you like to build?" page; next they select the Agent tile.
- **shots.json instructions:**
  - Navigate to the Copilot Studio home page (copilotstudio.microsoft.com).
  - Make sure the 'Agent' option is selected and the 'Start building from scratch' tiles are visible.
  - Close any teaching tips, banners, or popovers.
- **Observed:** Real Copilot Studio home page, Agent selected, and the Agent / Computer-using agent / Create workflow tiles are visible.
- **Verdict:** ✅ CORRECT
- **Action:** no action needed
- **shots.json instruction update needed?** no

### topic-add-from-blank.png
- **Section:** Use Case #1, Step 2
- **Markdown alt:** "Topics page in Copilot Studio with the \"+ Add a topic\" menu open and \"From blank\" highlighted."
- **Markdown context:** After opening the agent, the learner selects Topics, then + Add a topic and From blank.
- **shots.json instructions:**
  - Open your Energy Intelligence Agent and go to the Topics page.
  - Click '+ Add a topic' so the dropdown menu is open.
  - Make sure 'From blank' is visible and highlighted in the menu.
- **Observed:** Real Copilot Studio screen, but it is the Energy Genius Overview page. No Topics page, + Add a topic menu, or From blank option is shown.
- **Verdict:** 🔴 WRONG
- **Action:** Re-capture on the Topics page with the + Add a topic dropdown open and From blank visible/highlighted. The current instructions are adequate, but the capture did not follow them.
- **shots.json instruction update needed?** yes — add a guard that the Overview page is not acceptable.

### adaptive-card-json-editor.png
- **Section:** Use Case #1, Step 3
- **Markdown alt:** "Adaptive Card editor in JSON view with the city/state/zipCode payload pasted in."
- **Markdown context:** The learner adds an Ask with adaptive card node, switches to JSON view, and pastes the provided Adaptive Card JSON.
- **shots.json instructions:**
  - Open the Service Territory Lookup topic and add an 'Ask with adaptive card' node.
  - Open the card editor and switch to the JSON view.
  - Paste the city/state/zipCode payload from the lab so the JSON is fully visible.
- **Observed:** Mock/reference slide labeled "Lab 04 Reference" with simplified JSON and a visible footer "Replace with actual UI capture". It is not the live Copilot Studio editor.
- **Verdict:** ⚫ PLACEHOLDER
- **Action:** Re-capture the live Adaptive Card JSON editor in Copilot Studio with the real lab payload visible enough to identify `$schema`, `type`, `version`, the three inputs, and Submit action.
- **shots.json instruction update needed?** yes — require a live Copilot Studio editor and forbid the reference/mock capture.

### adaptive-card-preview.png
- **Section:** Use Case #1, Step 3
- **Markdown alt:** "Adaptive Card preview rendering the City, State, and Zip Code input fields with a Submit button."
- **Markdown context:** After saving and closing the card, the lab shows the preview/rendered card before mapping outputs.
- **shots.json instructions:**
  - Switch the Adaptive Card editor to the Preview/Designer view.
  - Make sure City, State, Zip Code inputs and the Submit button are all visible.
- **Observed:** Mock/reference slide labeled "Lab 04 Reference" with simplified form controls and visible "Replace with actual UI capture" footer.
- **Verdict:** ⚫ PLACEHOLDER
- **Action:** Re-capture the live Adaptive Card preview/designer in Copilot Studio showing City, State, Zip Code fields and Submit button.
- **shots.json instruction update needed?** yes — require live UI and no reference/mock footer.

### adaptive-card-output-mapping.png
- **Section:** Use Case #1, Step 3
- **Markdown alt:** "Save user response as panel showing card outputs city, state, and zipCode mapped to topic variables."
- **Markdown context:** The learner maps `city`, `state`, and `zipCode` into `Topic.City`, `Topic.StateInput`, and `Topic.ZipCode`.
- **shots.json instructions:**
  - Close the card editor and click on the 'Ask with adaptive card' node so its properties pane is open.
  - Scroll the properties pane to 'Save user response as'.
  - Show the three card outputs (city, state, zipCode) mapped to topic variables.
- **Observed:** Mock/reference slide with visible "Replace with actual UI capture" footer. It also maps `state` to `Topic.State`, while the lab text says `Topic.StateInput`.
- **Verdict:** ⚫ PLACEHOLDER
- **Action:** Re-capture the real node properties pane with Save user response as visible and the mappings `city -> Topic.City`, `state -> Topic.StateInput`, `zipCode -> Topic.ZipCode`.
- **shots.json instruction update needed?** yes — specify exact target variable names to avoid the `Topic.State` mismatch.

### state-fips-switch-powerfx.png
- **Section:** Use Case #1, Step 4
- **Markdown alt:** "Set variable value node containing a Power Fx Switch expression mapping state abbreviations to FIPS codes."
- **Markdown context:** The learner adds a Set variable value node and uses a Power Fx `Switch(Upper(Topic.state), ...)` expression to produce state FIPS.
- **shots.json instructions:**
  - Add a 'Set variable value' node after the Adaptive Card node.
  - Open the formula editor and paste the Switch(Upper(Topic.state), 'TX', '48', ...) expression.
  - Make sure the full Power Fx expression is readable in the screenshot.
- **Observed:** Mock/reference slide with "Replace with actual UI capture" footer. It shows `Set Variable: Global.varFIPS`, not the topic variable flow described by the lab, and it uses `Topic.State` instead of the lab's `Topic.StateInput` naming.
- **Verdict:** ⚫ PLACEHOLDER
- **Action:** Re-capture the real formula editor / Set variable value node in Copilot Studio. Prefer showing `Topic.StateFIPS` set from `Switch(Upper(Topic.StateInput), "TX", "48", ...)` to align with the variables table.
- **shots.json instruction update needed?** yes — tighten variable names and require live UI.

### global-variables-list.png
- **Section:** Use Case #2, Step 2
- **Markdown alt:** "Global variables panel listing DefaultState, DefaultYear, and APIKey with their values."
- **Markdown context:** The learner creates `Global.DefaultState`, `Global.DefaultYear`, and `Global.APIKey`; the image should confirm the variables panel.
- **shots.json instructions:**
  - Open the agent's variables / global variables panel.
  - Make sure Global.DefaultState, Global.DefaultYear, and Global.APIKey are all visible.
  - Mask or blur the API key value if you don't want to commit it.
- **Observed:** Real Copilot Studio Overview page in a loading/skeleton state. It does not show the variables/global variables panel or any variables.
- **Verdict:** 🔴 WRONG
- **Action:** Re-capture the actual variables/global variables panel with all three variables visible. Mask or blur API key value.
- **shots.json instruction update needed?** yes — add "do not capture Overview/loading state" and wait for variables list to finish loading.

### variable-picker-in-url.png
- **Section:** Use Case #2, Step 5
- **Markdown alt:** "Variable picker open over an HTTP URL field, inserting Topic.DataYear, Topic.StateFIPS, and Global.APIKey."
- **Markdown context:** The lab shows how request URLs should reference topic/global variables in the Census endpoint template.
- **shots.json instructions:**
  - Open one of your HTTP tools and edit the URL field.
  - Open the variable picker so Topic.DataYear, Topic.StateFIPS, and Global.APIKey are visible as insertable values.
  - Position the URL field so the inserted variables are also visible in the URL.
- **Observed:** Mock/reference slide with simplified URL text and visible "Replace with actual UI capture" footer; not live Copilot Studio.
- **Verdict:** ⚫ PLACEHOLDER
- **Action:** Re-capture the real HTTP action/tool URL field with variable picker open and Topic.DataYear, Topic.StateFIPS, and Global.APIKey visible.
- **shots.json instruction update needed?** yes — require live UI and ensure the URL includes county/state variable placeholders, not a simplified mock.

### tool-county-demographics-inputs.png
- **Section:** Use Case #3, Step 2
- **Markdown alt:** "Tool input configuration for Get County Demographics showing year, state, county, and apiKey inputs."
- **Markdown context:** The learner configures Tool 1 inputs after naming and describing the Get County Demographics tool.
- **shots.json instructions:**
  - Open the 'Get County Demographics' tool's Inputs configuration.
  - Show all four inputs: year, state, county, apiKey, with their descriptions.
- **Observed:** Real Copilot Studio Topics list showing custom/system topics. It does not show Tools, Get County Demographics, inputs, or descriptions.
- **Verdict:** 🔴 WRONG
- **Action:** Re-capture the actual Get County Demographics tool Inputs configuration with `year`, `state`, `county`, and `apiKey` and their descriptions visible.
- **shots.json instruction update needed?** yes — add a guard that the Tools tab/tool editor must be visible, not Topics.

### tool-county-demographics-test.png
- **Section:** Use Case #3, Step 6
- **Markdown alt:** "Tool test panel showing a successful Get County Demographics response for Harris County, Texas."
- **Markdown context:** After manual tests with year 2023, state 48, county 201, and an API key, the learner verifies the tool returns readable data.
- **shots.json instructions:**
  - Run a manual test of the 'Get County Demographics' tool with year=2023, state=48, county=201, apiKey=<your key>.
  - Capture the test panel showing a successful response (NAME, population, income, housing units).
- **Observed:** Mock/reference slide with visible "Replace with actual UI capture" footer. It uses year 2022, not 2023, and shows a simplified raw array.
- **Verdict:** ⚫ PLACEHOLDER
- **Action:** Re-capture the live tool test panel after a successful 2023 Harris County, Texas response. It should show NAME, population, median income, and housing units; mask API key.
- **shots.json instruction update needed?** yes — emphasize year 2023 and live test result.

### connected-agent-sharing-enabled.png
- **Section:** Use Case #4, Step 2
- **Markdown alt:** "Census Data Specialist Settings page with the \"allow other agents to use this agent\" toggle enabled."
- **Markdown context:** The learner opens settings for the connected Census Data Specialist and enables sharing before publishing.
- **shots.json instructions:**
  - Open the Census Data Specialist agent's Settings page.
  - Find the 'allow other agents to use this agent' (or equivalent) toggle and make sure it's enabled.
  - Capture the toggle in the ON state.
- **Observed:** Mock/reference slide with visible "Replace with actual UI capture" footer, not the live settings page.
- **Verdict:** ⚫ PLACEHOLDER
- **Action:** Re-capture the real Census Data Specialist settings page with the sharing toggle visibly ON.
- **shots.json instruction update needed?** yes — require live settings page and visible toggle control.

### connected-agent-config.png
- **Section:** Use Case #4, Step 4
- **Markdown alt:** "Energy Intelligence Agent's Agents page showing Census Data Specialist added as a connected agent with its description visible."
- **Markdown context:** After adding the connected agent, the lab validates handoff behavior and shows the parent agent's Agents page.
- **shots.json instructions:**
  - Open Energy Intelligence Agent and navigate to the Agents page.
  - Show Census Data Specialist added as a connected agent with its description visible.
- **Observed:** Real Copilot Studio Agents page, but it is the empty "Add an agent" state. Census Data Specialist is not added and no description is visible.
- **Verdict:** 🔴 WRONG
- **Action:** Re-capture after Census Data Specialist has been added to Energy Intelligence Agent, with the connected agent card/row and description visible.
- **shots.json instruction update needed?** yes — add a guard that the empty Add an agent state is not acceptable.

### flow-agent-trigger.png
- **Section:** Use Case #5, Step 1
- **Markdown alt:** "Power Automate trigger picker with \"When an agent calls the flow\" selected."
- **Markdown context:** The learner opens Power Automate, creates a flow, and chooses the Copilot/agent trigger.
- **shots.json instructions:**
  - Open Power Automate and start creating a new flow.
  - Open the trigger picker and select / highlight 'When an agent calls the flow'.
- **Observed:** Mock/reference slide with visible "Replace with actual UI capture" footer, not real Power Automate.
- **Verdict:** ⚫ PLACEHOLDER
- **Action:** Re-capture the actual Power Automate trigger picker with "When an agent calls the flow" selected/highlighted.
- **shots.json instruction update needed?** yes — require Power Automate live UI and no reference/mock footer.

### flow-state-summary-canvas.png
- **Section:** Use Case #5, Step 4
- **Markdown alt:** "Power Automate flow canvas showing the trigger, two HTTP actions, Compose, and Respond to the agent steps."
- **Markdown context:** After saving the Census State Planning Summary flow, the image should show the completed flow before it is added back to the agent.
- **shots.json instructions:**
  - Open the completed 'Census State Planning Summary' flow.
  - Zoom out so the trigger, both HTTP actions, the Compose action, and the 'Respond to the agent' step are all visible in one view.
- **Observed:** Mock/reference slide with visible "Replace with actual UI capture" footer. It shows simplified text, not a Power Automate canvas.
- **Verdict:** ⚫ PLACEHOLDER
- **Action:** Re-capture the real Power Automate flow canvas zoomed out so trigger, both HTTP actions, Compose, and Respond to the agent are visible.
- **shots.json instruction update needed?** yes — require real canvas and named actions visible.

### model-selection-comparison.png
- **Section:** Use Case #6, Step 3
- **Markdown alt:** "Primary model selector in Copilot Studio settings alongside two side-by-side test responses for the same energy planning prompt."
- **Markdown context:** The learner switches models, re-runs the same prompts, and compares quality/latency/cost tradeoffs.
- **shots.json instructions:**
  - Open the agent's primary model selector in Settings.
  - Have two browser windows / tabs side-by-side showing the same prompt's response under two different models, plus the model selector.
  - Use the OS screenshot tool if you need to compose multiple windows in one shot.
- **Observed:** Real Copilot Studio Overview page with the Test pane, but it does not show the model selector open and does not show two side-by-side responses.
- **Verdict:** 🔴 WRONG
- **Action:** Re-capture a composed screenshot with the primary model selector visible plus two responses to the same prompt under different models. If composition is hard, use side-by-side browser windows or OS screenshot as the catalog says.
- **shots.json instruction update needed?** yes — add explicit acceptance criteria: selector open and two completed responses visible.

### eval-test-methods.png
- **Section:** Use Case #7, Step 1
- **Markdown alt:** "Create a test set dialog with Similarity, General quality, and Keyword match selected as test methods."
- **Markdown context:** The learner opens Evaluation, creates a test set, names it, and checks the three test methods.
- **shots.json instructions:**
  - Open the Evaluation tab and click 'Create a test set'.
  - On the dialog, check Similarity, General quality, and Keyword match so all three are visible.
- **Observed:** Real Copilot Studio Overview page/loading state. No Evaluation tab content, Create a test set dialog, or test method checkboxes are visible.
- **Verdict:** 🔴 WRONG
- **Action:** Re-capture the Create a test set dialog with Similarity, General quality, and Keyword match selected and visible.
- **shots.json instruction update needed?** yes — add a guard that the dialog must be open and loaded.

### evaluation-results.png
- **Section:** Use Case #7, Step 4
- **Markdown alt:** "Evaluation results dashboard with overall pass rate, per-test results, and an activity map for a failed case."
- **Markdown context:** After running evaluation, the learner reviews pass rate, failures, clusters, and failed case activity maps.
- **shots.json instructions:**
  - After running the evaluation, open the results dashboard.
  - Capture the overall pass rate and per-test results.
  - If possible, also show an activity map for one failed case in the same view.
- **Observed:** Mock/reference slide with visible "Replace with actual UI capture" footer. It is not a real evaluation dashboard and does not show an actual activity map.
- **Verdict:** ⚫ PLACEHOLDER
- **Action:** Re-capture the real evaluation results dashboard after a run. Show overall pass rate, per-test results, and if possible the activity map/failure detail pane for one failed case.
- **shots.json instruction update needed?** yes — require real results run and activity map/failure detail if available.

### mcp-tool-discovery.png
- **Section:** Optional Use Case #8, Step 5
- **Markdown alt:** "Copilot Studio MCP tool discovery page listing get_population, get_median_income, get_housing_stats, and get_employment_by_industry."
- **Markdown context:** After registering the MCP server, the learner reviews discovered tools and adds all four tools to the agent.
- **shots.json instructions:**
  - After registering the MCP server in Copilot Studio, open the discovered tools list.
  - Make sure get_population, get_median_income, get_housing_stats, and get_employment_by_industry are all visible.
- **Observed:** Real Copilot Studio Topics list showing system topics; no MCP registration or discovered tools list is visible.
- **Verdict:** 🔴 WRONG
- **Action:** Re-capture after MCP server registration on the discovered tools list with all four tool names visible.
- **shots.json instruction update needed?** yes — add a guard that Topics list is not acceptable; tool names must be visible.

## Proposed shots.json patches

The catalog has full coverage and no orphan filenames. These are ready-to-paste instruction replacements for shots that need stronger capture criteria.

```json
{
  "id": 1,
  "filename": "topic-add-from-blank.png",
  "instructions": [
    "Open your Energy Intelligence Agent and go to the Topics page.",
    "Click '+ Add a topic' so the dropdown menu is open.",
    "Make sure 'From blank' is visible and highlighted in the menu.",
    "Do not capture the Overview page; the Topics page and open menu must be visible."
  ]
}
```

```json
{
  "id": 2,
  "filename": "adaptive-card-json-editor.png",
  "instructions": [
    "Open the Service Territory Lookup topic and add an 'Ask with adaptive card' node.",
    "Open the real Copilot Studio card editor and switch to the JSON view.",
    "Paste the city/state/zipCode payload from the lab so the JSON is fully visible enough to identify the three inputs and Submit action.",
    "Do not use the Lab 04 Reference/mock placeholder image; the live Copilot Studio editor chrome must be visible."
  ]
}
```

```json
{
  "id": 3,
  "filename": "adaptive-card-preview.png",
  "instructions": [
    "Switch the real Adaptive Card editor to the Preview/Designer view.",
    "Make sure City, State, Zip Code inputs and the Submit button are all visible.",
    "Do not use the Lab 04 Reference/mock placeholder image; the live Copilot Studio editor chrome must be visible."
  ]
}
```

```json
{
  "id": 4,
  "filename": "adaptive-card-output-mapping.png",
  "instructions": [
    "Close the card editor and click on the 'Ask with adaptive card' node so its properties pane is open.",
    "Scroll the properties pane to 'Save user response as'.",
    "Show the three card outputs mapped exactly as city -> Topic.City, state -> Topic.StateInput, and zipCode -> Topic.ZipCode.",
    "Do not use the Lab 04 Reference/mock placeholder image."
  ]
}
```

```json
{
  "id": 5,
  "filename": "state-fips-switch-powerfx.png",
  "instructions": [
    "Add a 'Set variable value' node after the Adaptive Card node.",
    "Open the formula editor and paste the Switch(Upper(Topic.StateInput), 'TX', '48', ...) expression that sets Topic.StateFIPS.",
    "Make sure the full Power Fx expression is readable in the screenshot.",
    "Do not capture a mock/reference page or a mismatched Global.varFIPS variable."
  ]
}
```

```json
{
  "id": 6,
  "filename": "global-variables-list.png",
  "instructions": [
    "Open the agent's variables / global variables panel and wait for it to finish loading.",
    "Make sure Global.DefaultState, Global.DefaultYear, and Global.APIKey are all visible.",
    "Mask or blur the API key value if you don't want to commit it.",
    "Do not capture the Overview page or a loading/skeleton state."
  ]
}
```

```json
{
  "id": 7,
  "filename": "variable-picker-in-url.png",
  "instructions": [
    "Open one of your HTTP tools and edit the URL field in the real tool editor.",
    "Open the variable picker so Topic.DataYear, Topic.StateFIPS, and Global.APIKey are visible as insertable values.",
    "Position the URL field so the inserted variables are also visible in the URL.",
    "Do not use the Lab 04 Reference/mock placeholder image."
  ]
}
```

```json
{
  "id": 8,
  "filename": "tool-county-demographics-inputs.png",
  "instructions": [
    "Open the Tools tab, then open the 'Get County Demographics' tool's Inputs configuration.",
    "Show all four inputs: year, state, county, apiKey, with their descriptions.",
    "Do not capture the Topics page; the tool input configuration must be visible."
  ]
}
```

```json
{
  "id": 9,
  "filename": "tool-county-demographics-test.png",
  "instructions": [
    "Run a manual test of the 'Get County Demographics' tool with year=2023, state=48, county=201, apiKey=<your key>.",
    "Capture the real test panel showing a successful response (NAME, population, income, housing units).",
    "Mask the API key and do not use the Lab 04 Reference/mock placeholder image."
  ]
}
```

```json
{
  "id": 10,
  "filename": "connected-agent-sharing-enabled.png",
  "instructions": [
    "Open the real Census Data Specialist agent's Settings page.",
    "Find the 'allow other agents to use this agent' (or equivalent) toggle and make sure it's enabled.",
    "Capture the toggle in the ON state with enough surrounding settings context to identify the agent.",
    "Do not use the Lab 04 Reference/mock placeholder image."
  ]
}
```

```json
{
  "id": 11,
  "filename": "connected-agent-config.png",
  "instructions": [
    "Open Energy Intelligence Agent and navigate to the Agents page after adding Census Data Specialist.",
    "Show Census Data Specialist added as a connected agent with its description visible.",
    "Do not capture the empty 'Add an agent' state."
  ]
}
```

```json
{
  "id": 12,
  "filename": "flow-agent-trigger.png",
  "instructions": [
    "Open Power Automate and start creating a new flow.",
    "Open the real trigger picker and select / highlight 'When an agent calls the flow'.",
    "Do not use the Lab 04 Reference/mock placeholder image."
  ]
}
```

```json
{
  "id": 13,
  "filename": "flow-state-summary-canvas.png",
  "instructions": [
    "Open the completed 'Census State Planning Summary' flow in Power Automate.",
    "Zoom out so the trigger, both HTTP actions, the Compose action, and the 'Respond to the agent' step are all visible in one view.",
    "Do not use the Lab 04 Reference/mock placeholder image; the real Power Automate canvas must be visible."
  ]
}
```

```json
{
  "id": 14,
  "filename": "model-selection-comparison.png",
  "instructions": [
    "Open the agent's primary model selector in Settings with the selector/dropdown visible.",
    "Have two browser windows / tabs side-by-side showing the same prompt's completed response under two different models, plus the model selector.",
    "Use the OS screenshot tool if you need to compose multiple windows in one shot.",
    "Do not capture only the Overview page or an empty Test pane; two model responses must be visible."
  ]
}
```

```json
{
  "id": 15,
  "filename": "eval-test-methods.png",
  "instructions": [
    "Open the Evaluation tab and click 'Create a test set'.",
    "Wait for the dialog to load, then check Similarity, General quality, and Keyword match so all three are visible.",
    "Do not capture the Overview page, a loading state, or the Evaluation tab without the dialog."
  ]
}
```

```json
{
  "id": 16,
  "filename": "evaluation-results.png",
  "instructions": [
    "After running the evaluation, open the real results dashboard.",
    "Capture the overall pass rate and per-test results.",
    "If possible, also show an activity map or failure detail for one failed case in the same view.",
    "Do not use the Lab 04 Reference/mock placeholder image."
  ]
}
```

```json
{
  "id": 17,
  "filename": "mcp-tool-discovery.png",
  "instructions": [
    "After registering the MCP server in Copilot Studio, open the discovered tools list.",
    "Make sure get_population, get_median_income, get_housing_stats, and get_employment_by_industry are all visible.",
    "Do not capture the Topics page; the MCP discovered tools list and tool names must be visible."
  ]
}
```

## Open questions for Russ
- None blocking. The only judgment call: whether to accept `copilot-studio-home.png` despite showing a recent agent/account/environment. It matches the instructional target and has no obvious placeholder/wrong-screen issue.
