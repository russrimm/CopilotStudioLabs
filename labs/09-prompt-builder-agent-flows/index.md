# ✨ Lab 09: Master Prompt Engineering with Prompt Builder and Agent Flow Nodes

*Design reusable prompts, wire them into flows, and control how AI content is generated for utility operations scenarios.*

| | |
|---|---|
| ⭐ **DIFFICULTY** | Intermediate to Advanced (Level 200-300) |
| ⏱️ **TIME** | 90 minutes |
| 🧩 **PRODUCTS** | Microsoft Copilot Studio, Power Automate, Prompt Builder, Microsoft 365 Copilot |
| 🏷️ **TAGS** | Prompt Builder, Prompt Nodes, Agent Flows, AI Orchestration, Model Selection, Content Moderation |
| 🏭 **INDUSTRIES** | Energy / Utilities |

---

## Overview

Utility teams constantly translate, summarize, classify, and draft content: outage updates, regulator-facing summaries, field report extractions, meeting recaps, and customer communications. Prompt Builder and agent flows let you turn those repeatable language tasks into governed automation.
In this lab, you will create reusable prompts, add them to **agent flows**, use the **Microsoft 365 Copilot node** for grounded research or drafting, and tune controls such as **model selection**, **content moderation**, **asynchronous response**, and **express mode**.
The scenario uses Contoso Energy and Contoso Energy operations, where prompt quality affects both productivity and compliance.

---

## 🏗️ What you'll build

| Layer | What you will build |
|---|---|
| **Prompt library** | Reusable prompts for outage summaries, field-report extraction, and leadership updates |
| **Agent flow** | A flow that calls prompt nodes for structured extraction or translation |
| **M365 Copilot node** | A research or drafting step grounded in the user's Microsoft 365 context |
| **Moderation policy** | Per-prompt content safety tuning for sensitive categories |
| **Performance model** | Express mode and asynchronous response for time-sensitive or long-running flows |
| **Quality loop** | Prompt Advisor testing and optimization guidance |

### Architecture summary

```text
User or agent
  -> Agent flow
      -> Prompt node for extraction / transformation
      -> M365 Copilot node for research / drafting
      -> Respond to agent (sync, async, or express mode pattern)
      -> Agent or downstream system consumes structured result
```

> 💡 **Tip:** Treat prompts like software assets: they need versioning, testing, model choices, and performance tuning.

---

## Objectives

1. Create a structured reusable prompt with Prompt Builder.
2. Add prompt nodes to agent flows for extraction or translation tasks.
3. Use the Microsoft 365 Copilot node for research and drafting scenarios.
4. Tune moderation settings at the prompt level.
5. Improve prompt quality with Prompt Advisor.
6. Decide when to use asynchronous response and express mode for flow performance.

---

## 🧠 Core concepts

| Concept | What it means in this lab |
|---|---|
| **Prompt Builder** | The authoring surface for reusable prompt assets with instructions, inputs, outputs, and testing. |
| **Prompt node** | An AI step inside a workflow or agent flow that performs a single model call. |
| **Structured output** | A typed response shape that downstream flow steps can consume deterministically. |
| **M365 Copilot node** | A flow step that asks Microsoft 365 Copilot or a targeted M365 agent to research or draft content. |
| **Content moderation** | Per-prompt filtering choices for hate/fairness, sexual, violence, and self-harm categories. |
| **Asynchronous response** | A mode that allows long-running agent flows to continue beyond the traditional two-minute limit. |
| **Express mode** | A performance option for logic-heavy agent flows that improves the chance of finishing within two minutes. |
| **Prompt Advisor** | A feedback loop that scores and improves prompt clarity and quality. |

---

## 📚 Documentation

- [Prompts overview](https://learn.microsoft.com/en-us/microsoft-copilot-studio/prompts-overview)
- [Add a prompt node to an agent flow or workflow](https://learn.microsoft.com/en-us/microsoft-copilot-studio/prompt-node-workflow)
- [Add a Microsoft 365 Copilot node to a workflow](https://learn.microsoft.com/en-us/microsoft-copilot-studio/microsoft-365-copilot-node-workflow)
- [Asynchronous response support for agent flows](https://learn.microsoft.com/en-us/microsoft-copilot-studio/flow-asynchronous-response)
- [Speed up agent flow execution with express mode](https://learn.microsoft.com/en-us/microsoft-copilot-studio/agent-flow-express-mode)

---

## Prerequisites

- Access to **Copilot Studio** and permission to create or edit **agent flows**.
- Dataverse installed in the environment because prompt features depend on it.
- Copilot Credits and regional availability for prompt models.
- Optional: Microsoft 365 access if you plan to fully test the **M365 Copilot** node with real user context.
- A set of realistic utility examples such as outage narratives, field notes, bilingual customer messages, or meeting prep requests.

> ⚠️ **Warning:** Generative features can produce plausible but wrong content. Always include human review when prompt output affects customer communication, safety decisions, or regulated reporting.

---

## 🗺️ Use cases covered

| # | Section | Time | Required |
|---|---|---|---|
| 1 | Create a prompt with Prompt Builder | 15 min | ✅ |
| 2 | Add a prompt node to an agent flow | 15 min | ✅ |
| 3 | Use the Microsoft 365 Copilot node | 15 min | ✅ |
| 4 | Configure content moderation per prompt | 10 min | ✅ |
| 5 | Test prompt quality with Prompt Advisor | 15 min | ✅ |
| 6 | Async responses and express mode | 20 min | ✅ |

> 💡 **Tip:** Pick one utility scenario per prompt. The more mixed the prompt goal becomes, the harder it is to optimize the prompt and the flow around it.

---

# 🧪 Use Case #1 — Create a prompt with Prompt Builder (15 min)

> 🎯 **Objective:** Design a reusable prompt with inputs, output structure, model selection, and moderation awareness.

### Scenario

Field supervisors send freeform outage notes after restoration events. Operations leadership wants a prompt that turns those notes into a structured summary with risks, customer impact, and next actions.

### Step 1 — Open Prompt Builder and define the task

1. Open the prompt creation experience in Copilot Studio and choose to create a new reusable prompt.
2. Name the prompt **Outage Narrative Summarizer**.
3. Write a one-sentence description explaining that it converts freeform outage or restoration notes into a leadership-ready structured summary.
4. Define the primary input variable, such as **fieldNotes**.
5. Decide whether you also need optional inputs such as **districtName**, **incidentId**, or **audienceType**.
6. Save the draft metadata before you begin refining the instructions.


### Step 2 — Write the instruction and choose the model

1. In the instruction area, tell the prompt exactly what to extract or summarize from the notes.
2. Request a consistent structure such as Incident summary, Customer impact, Safety concerns, Restoration status, and Next actions.
3. Use the model dropdown to choose a model tier appropriate for the task. Favor a more capable model if the notes are messy or nuanced.
4. Avoid asking for everything at once; focus on the information leadership actually needs.
5. Include a sentence telling the model to say 'Not provided' when the note does not contain a required fact.
6. Save the prompt and read it from the perspective of the downstream consumer.


#### Sample prompt for this step

```text
You are summarizing utility outage field notes for leadership.
Given the field notes, produce:
1. Incident summary
2. Customer impact
3. Safety concerns
4. Current restoration status
5. Next actions
If any item is missing, say Not provided.
Keep the tone concise and operational.
```

### Step 3 — Choose output shape and test

1. Select an output shape that fits your downstream use case. For reusable automations, prefer **Structured output** or **Custom structured output** over plain text.
2. Define fields such as **incidentSummary**, **customerImpact**, **safetyConcerns**, **restorationStatus**, and **nextActions**.
3. Paste a realistic field note example into the test pane.
4. Run the prompt and inspect whether every field is populated cleanly.
5. Adjust the instruction wording if the model merges fields or omits required content.
6. Save the prompt once the result is stable.


#### Quick verification

- Inputs are defined.
- A model is selected intentionally.
- Structured output fields align to the business requirement.

### Test prompts

Use these prompts in Copilot Studio test chat, the flow test pane, or the voice test panel as appropriate:

```text
Field notes: Crew isolated feeder 12A after vegetation contact. 1,842 customers impacted. No injuries. Temporary bypass active. Permanent repair scheduled for 06:00 tomorrow.
Field notes: Smoke reported near transformer bank. Crew dispatched. Customers rerouted. Awaiting safety clearance.
```

### Validation checklist

- The prompt exists as a reusable asset.
- It uses structured output rather than ad hoc prose only.
- The model and instruction quality are aligned to the field-note summarization task.

### What you accomplished

| Outcome | Why it matters |
|---|---|
| Created a reusable prompt asset | The summarization logic is now portable across agents, flows, and apps. |
| Structured the output | Downstream automation can use named fields instead of parsing paragraphs. |
| Selected the model intentionally | Prompt performance depends on matching the model to the task. |

### Key takeaways

- Reusable prompts are easier to govern than one-off embedded instructions.
- A well-defined output shape is the bridge between AI and deterministic automation.
- Prompt scope should stay focused on one clear business outcome.

### Troubleshooting

- If fields blur together, tighten the instruction and examples before changing the model.
- If the response is too verbose, explicitly request concise operational language.

### Evidence to capture

- Save at least one successful run, screenshot, or transcript excerpt for future demos and regression checks.
- Record the configuration choices that most influenced the result, such as descriptions, instructions, model selection, or access settings.
- Note one failure mode or edge case discovered during this use case so the team can retest it later.
- Capture which stakeholder would need to review this capability before broader rollout.

### Improvement ideas

- Add one more regression prompt that stresses this use case from a different angle.
- Decide whether any part of this pattern should become a reusable asset for other agents, flows, or teams.
- Review whether logging, governance, or support ownership need to be tightened before production use.
- Identify the next adjacent scenario you would automate or route now that this use case is working.

### Stakeholder discussion prompts

- What business outcome improves most if this use case becomes a standard operating capability?
- What would make the result more trustworthy to operations, security, or compliance reviewers?
- Which metric should be watched first after rollout to prove this use case is adding value?
- What is the simplest rollback plan if this use case behaves unexpectedly after a change?

### ✅ You've completed Use Case #1

You now have the foundation to move from **an idea for summarization** to **a reusable prompt asset**.

---

# 🧪 Use Case #2 — Add a prompt node to an agent flow (15 min)

> 🎯 **Objective:** Insert a prompt node into a flow to do AI-powered extraction or translation.

### Scenario

A field-operations team wants an agent flow that receives a freeform note and returns structured data that can be written into a case record or a shift-handoff summary.

### Step 1 — Create or open an agent flow

1. Open **Flows** in Copilot Studio and create a new **agent flow** using the **When an agent calls the flow** trigger.
2. Name the flow **Extract Outage Report Details**.
3. Add an input parameter for the incoming freeform note.
4. Decide whether the flow returns plain text, a structured object, or both.
5. Save the empty flow so you can build on a stable shell.
6. Keep the flow narrow: one note in, one structured result out.


### Step 2 — Add the prompt node

1. Select **Add a new action** and choose **Run a prompt** from the AI capabilities section.
2. Either pick the reusable **Outage Narrative Summarizer** prompt you created or build a new one inline.
3. Map the flow input to the prompt input variable.
4. Verify the selected output shape so the downstream response action receives named fields.
5. Use the prompt node test experience to confirm the flow data is passing correctly.
6. Save the flow after the prompt step is configured.


#### Sample prompt for this step

```text
Input token: trigger.fieldNotes
Prompt input: fieldNotes = trigger.fieldNotes
Expected outputs: incidentSummary, customerImpact, safetyConcerns, restorationStatus, nextActions
```

### Step 3 — Respond to the agent with structured data

1. Add a **Respond to agent** action after the prompt node.
2. Map each structured prompt output to a response field so the calling agent can display or reuse the values.
3. If needed, add a compose or formatting step before the response so the agent gets both structured data and a readable summary.
4. Save the flow and test it end to end from the agent or the flow test experience.
5. Verify that the agent receives the outputs in a deterministic shape instead of a freeform paragraph.
6. Document how a downstream app or system could consume those same outputs later.


#### Quick verification

- Prompt node is present in the agent flow.
- Input mapping is correct.
- Respond to agent returns structured values.

### Test prompts

Use these prompts in Copilot Studio test chat, the flow test pane, or the voice test panel as appropriate:

```text
Extract details from this outage note: Feeder 77B tripped at 14:10 after contractor dig-in. 623 customers interrupted. One traffic signal affected. Crew on site. Estimated restoration 18:00.
```

### Validation checklist

- The agent flow contains a prompt node.
- The flow returns structured data to the caller.
- The prompt node is doing transformation rather than broad orchestration.

### What you accomplished

| Outcome | Why it matters |
|---|---|
| Embedded AI inside a deterministic flow | You combined flexible language understanding with reliable automation. |
| Mapped outputs to response fields | The agent can now consume the result predictably. |
| Created a repeatable extraction pattern | Similar prompts can now be added for translation, classification, or redaction. |

### Key takeaways

- Prompt nodes are ideal for one-step transformations inside a larger automation.
- Flow outputs should stay structured whenever possible.
- Prompt reuse improves consistency and maintainability.

### Troubleshooting

- If output tokens are missing, review the prompt output shape configuration.
- If the flow result is still unstructured, you may have chosen text output instead of structured output.

### Evidence to capture

- Save at least one successful run, screenshot, or transcript excerpt for future demos and regression checks.
- Record the configuration choices that most influenced the result, such as descriptions, instructions, model selection, or access settings.
- Note one failure mode or edge case discovered during this use case so the team can retest it later.
- Capture which stakeholder would need to review this capability before broader rollout.

### Improvement ideas

- Add one more regression prompt that stresses this use case from a different angle.
- Decide whether any part of this pattern should become a reusable asset for other agents, flows, or teams.
- Review whether logging, governance, or support ownership need to be tightened before production use.
- Identify the next adjacent scenario you would automate or route now that this use case is working.

### Stakeholder discussion prompts

- What business outcome improves most if this use case becomes a standard operating capability?
- What would make the result more trustworthy to operations, security, or compliance reviewers?
- Which metric should be watched first after rollout to prove this use case is adding value?
- What is the simplest rollback plan if this use case behaves unexpectedly after a change?

### ✅ You've completed Use Case #2

You now have the foundation to move from **a standalone prompt** to **a flow-embedded AI automation step**.

---

# 🧪 Use Case #3 — Use the Microsoft 365 Copilot node (15 min)

> 🎯 **Objective:** Add an M365 Copilot node for research and document drafting.

### Scenario

A district manager wants a flow that prepares a briefing draft by researching recent emails, files, and meetings about an initiative before a weekly review.

### Step 1 — Add the M365 Copilot node

1. Open an existing workflow or agent flow where a user-specific research or drafting step makes sense.
2. Add the **M365 Copilot** node from the action picker.
3. Sign in with a Microsoft 365 account that has the appropriate access to the relevant mail, files, and meetings.
4. Choose whether to call general Microsoft 365 Copilot or a specific M365 agent such as **Researcher**, **Analyst**, or a tenant-specific Agent Builder agent.
5. Set the time zone if relative dates like 'this week' or 'yesterday' matter for the request.
6. Save the node before tuning the message.


### Step 2 — Write a grounded research message

1. In the **Message** field, write the exact research or drafting task.
2. Use dynamic content from earlier steps if the project name, account, or district should flow into the message.
3. Be explicit about the desired output format, such as a short briefing, action-item list, or draft email.
4. If your scenario needs deeper multi-source synthesis, select the **Researcher** agent when available.
5. If the task is more numerical or spreadsheet-oriented, test the **Analyst** agent instead.
6. Run a test and compare whether the chosen target produces the right style of output.


#### Sample prompt for this step

```text
Summarize all recent emails, meetings, chats, and files related to the South Region storm hardening initiative. Return:
1. Executive summary
2. Open blockers
3. Decisions made this week
4. Recommended next actions
```

### Step 3 — Use the output downstream

1. Add a downstream action such as **Send an email**, **Post a Teams message**, or **Respond to agent**.
2. Insert the M365 Copilot output into the chosen action.
3. If the output needs transformation, add a prompt node after M365 Copilot to rewrite or compress it.
4. Test the complete workflow and confirm the result feels grounded in current M365 work rather than generic background knowledge.
5. Decide whether the workflow should save the output in a SharePoint list, OneNote page, or document for future reference.
6. Record which M365 target—general Copilot, Researcher, Analyst, or custom agent—worked best for the scenario.


#### Quick verification

- The M365 Copilot node runs with a valid user context.
- The message is explicit about task and output format.
- The downstream step successfully consumes the node output.

### Test prompts

Use these prompts in Copilot Studio test chat, the flow test pane, or the voice test panel as appropriate:

```text
Draft a meeting-prep summary for the South Region storm hardening review.
Research the current status of the EV charging deployment workstream and draft a one-paragraph leader update.
```

### Validation checklist

- The M365 Copilot node is configured and tested.
- The output is grounded in user context.
- A downstream action consumes the result.

### What you accomplished

| Outcome | Why it matters |
|---|---|
| Added Microsoft 365-grounded reasoning | The flow can now leverage the user's daily work context. |
| Tested specialist agent selection | You compared whether a targeted M365 agent outperforms general Copilot. |
| Closed the automation loop | The research output now feeds a real downstream action. |

### Key takeaways

- The M365 Copilot node is strongest when user context matters materially.
- Message specificity strongly influences output usefulness.
- Grounded drafting works well as one step inside a broader deterministic workflow.

### Troubleshooting

- If the output is vague, clarify the scope, timeframe, and format in the message.
- If the wrong context is used, verify the signed-in M365 user and time zone settings.

### Evidence to capture

- Save at least one successful run, screenshot, or transcript excerpt for future demos and regression checks.
- Record the configuration choices that most influenced the result, such as descriptions, instructions, model selection, or access settings.
- Note one failure mode or edge case discovered during this use case so the team can retest it later.
- Capture which stakeholder would need to review this capability before broader rollout.

### Improvement ideas

- Add one more regression prompt that stresses this use case from a different angle.
- Decide whether any part of this pattern should become a reusable asset for other agents, flows, or teams.
- Review whether logging, governance, or support ownership need to be tightened before production use.
- Identify the next adjacent scenario you would automate or route now that this use case is working.

### Stakeholder discussion prompts

- What business outcome improves most if this use case becomes a standard operating capability?
- What would make the result more trustworthy to operations, security, or compliance reviewers?
- Which metric should be watched first after rollout to prove this use case is adding value?
- What is the simplest rollback plan if this use case behaves unexpectedly after a change?

### ✅ You've completed Use Case #3

You now have the foundation to move from **a generic flow** to **a Microsoft 365-grounded research workflow**.

---

# 🧪 Use Case #4 — Configure content moderation per prompt (10 min)

> 🎯 **Objective:** Set sensitivity levels for content filtering on a per-prompt basis.

### Scenario

Some utility prompts touch stressful outage situations or customer complaints. You want prompt-level safety controls without over-restricting every scenario.

### Step 1 — Review moderation needs by scenario

1. List the prompts you created and rank their risk level based on the business context.
2. Decide whether the prompt could surface sensitive topics or high-stress language from field notes, customer complaints, or incident narratives.
3. Review the available moderation categories such as hate/fairness, sexual, violence, and self-harm.
4. Align the chosen thresholds with your organization's responsible AI guidance.
5. Document where a human review step is required regardless of moderation settings.
6. Treat moderation as part of prompt design, not a separate afterthought.


### Step 2 — Tune settings on the prompt

1. Open the prompt configuration and locate the content moderation settings available for that prompt or node.
2. Set sensitivity levels appropriate for the scenario. For a neutral outage summarizer, you may keep strong filtering on harmful categories while still allowing operational incident language.
3. Test the prompt with examples that include stressful or emotionally charged wording but remain legitimate business content.
4. Confirm the prompt still produces useful output without incorrectly blocking normal incident language.
5. If you see over-blocking, adjust carefully and retest.
6. Save the moderation profile along with your rationale.


#### Sample prompt for this step

```text
Test phrase: Customer was extremely upset and reported feeling unsafe after repeated outages in the area.
Goal: Ensure the summarizer handles legitimate complaint context without generating harmful content.
```

### Test prompts

Use these prompts in Copilot Studio test chat, the flow test pane, or the voice test panel as appropriate:

```text
Summarize this customer complaint narrative and identify the requested follow-up action.
```

### Validation checklist

- Moderation settings were reviewed at the prompt level.
- Business-appropriate incident language still works after tuning.
- A rationale exists for the selected sensitivity profile.

### What you accomplished

| Outcome | Why it matters |
|---|---|
| Applied prompt-level safety controls | Different prompts can now have different risk postures. |
| Balanced usefulness and protection | Legitimate business content remains usable while unsafe patterns are constrained. |

### Key takeaways

- Content moderation should be scenario-specific whenever possible.
- Testing with realistic edge cases is essential before rollout.

### Troubleshooting

- If useful content is blocked, the settings may be too restrictive for the prompt's domain language.
- If risky content slips through, add stronger moderation and a human review checkpoint.

### Evidence to capture

- Save at least one successful run, screenshot, or transcript excerpt for future demos and regression checks.
- Record the configuration choices that most influenced the result, such as descriptions, instructions, model selection, or access settings.
- Note one failure mode or edge case discovered during this use case so the team can retest it later.
- Capture which stakeholder would need to review this capability before broader rollout.

### Improvement ideas

- Add one more regression prompt that stresses this use case from a different angle.
- Decide whether any part of this pattern should become a reusable asset for other agents, flows, or teams.
- Review whether logging, governance, or support ownership need to be tightened before production use.
- Identify the next adjacent scenario you would automate or route now that this use case is working.

### Stakeholder discussion prompts

- What business outcome improves most if this use case becomes a standard operating capability?
- What would make the result more trustworthy to operations, security, or compliance reviewers?
- Which metric should be watched first after rollout to prove this use case is adding value?
- What is the simplest rollback plan if this use case behaves unexpectedly after a change?

### ✅ You've completed Use Case #4

You now have the foundation to move from **an ungoverned prompt** to **a prompt with explicit safety posture**.

---

# 🧪 Use Case #5 — Test prompt quality with Prompt Advisor (15 min)

> 🎯 **Objective:** Score and optimize prompts using Prompt Advisor.

### Scenario

You have a working prompt, but you want evidence-backed advice on clarity, structure, and potential improvements before scaling it across flows.

### Step 1 — Capture a baseline prompt

1. Open the prompt you created earlier and save the current version as your baseline.
2. Write down the current strengths and weaknesses you already observe, such as inconsistent field extraction or overly verbose summaries.
3. Prepare two or three representative test cases that you will use before and after optimization.
4. Make sure the test cases reflect real utility language rather than synthetic filler text.
5. Document the expected outputs so you have something objective to compare against.
6. Only then move into Prompt Advisor or your chosen prompt-quality workflow.


### Step 2 — Run Prompt Advisor and apply improvements

1. Use Prompt Advisor in the Copilot Studio Kit or your available environment workflow to score the prompt.
2. Review the recommendations for clarity, specificity, output structure, or unnecessary ambiguity.
3. Apply the suggestions that align with your business need instead of accepting every stylistic tweak blindly.
4. Re-run the same test cases and compare the outputs to the baseline.
5. Track whether the improved prompt reduced hallucination, improved consistency, or shortened the answer appropriately.
6. Keep both versions if your team wants to review prompt evolution over time.


#### Quick verification

- Baseline captured before changes.
- Same tests run before and after.
- Advisor suggestions evaluated, not copied blindly.

### Test prompts

Use these prompts in Copilot Studio test chat, the flow test pane, or the voice test panel as appropriate:

```text
Use the original and improved prompt on the same outage note and compare field consistency.
```

### Validation checklist

- A baseline and optimized prompt version exist.
- The same test set was used for before/after comparison.
- Improvement decisions are documented.

### What you accomplished

| Outcome | Why it matters |
|---|---|
| Established a quality loop | Prompt design is now testable and improvable instead of subjective. |
| Compared baseline versus optimized behavior | You can show why changes were made. |
| Applied advisor feedback selectively | Business value stayed in control of the optimization process. |

### Key takeaways

- Prompt quality improves fastest when you compare versions against the same data.
- Advisor tools are most useful when combined with human judgment and domain context.
- A prompt is a living asset, not a one-time setup step.

### Troubleshooting

- If the advisor suggestions make the prompt worse for your domain, keep the original and document why.
- If output quality barely changes, your baseline may already be strong or your test cases may be too easy.

### Evidence to capture

- Save at least one successful run, screenshot, or transcript excerpt for future demos and regression checks.
- Record the configuration choices that most influenced the result, such as descriptions, instructions, model selection, or access settings.
- Note one failure mode or edge case discovered during this use case so the team can retest it later.
- Capture which stakeholder would need to review this capability before broader rollout.

### Improvement ideas

- Add one more regression prompt that stresses this use case from a different angle.
- Decide whether any part of this pattern should become a reusable asset for other agents, flows, or teams.
- Review whether logging, governance, or support ownership need to be tightened before production use.
- Identify the next adjacent scenario you would automate or route now that this use case is working.

### Stakeholder discussion prompts

- What business outcome improves most if this use case becomes a standard operating capability?
- What would make the result more trustworthy to operations, security, or compliance reviewers?
- Which metric should be watched first after rollout to prove this use case is adding value?
- What is the simplest rollback plan if this use case behaves unexpectedly after a change?

### ✅ You've completed Use Case #5

You now have the foundation to move from **a functioning prompt** to **a measured and improved prompt asset**.

---

# 🧪 Use Case #6 — Async responses and express mode (20 min)

> 🎯 **Objective:** Configure long-running flows to use asynchronous response and decide when express mode is the better fit.

### Scenario

Some utility workflows finish quickly and just need faster execution. Others involve longer research, drafting, or downstream processing that can exceed the traditional two-minute response window.

### Step 1 — Understand the two performance patterns

1. Review the Microsoft Learn articles for **Asynchronous response support for agent flows** and **Express mode**.
2. Note that asynchronous response allows a flow with **Respond to agent** to continue beyond two minutes and still return a result later in supported environments.
3. Note that express mode is intended for logic-heavy but not data-heavy flows and improves the chance of finishing within the standard response window.
4. Create a simple decision rule: choose **express mode** when the flow is time-sensitive but still reasonably lightweight; choose **asynchronous response** when the flow is legitimately long-running.
5. Document that both features require the environment to run on newer infrastructure.
6. Use this decision rule in the rest of the lab.


### Step 2 — Turn on asynchronous response

1. Open an agent flow that uses **When an agent calls the flow** and includes a **Respond to agent** action.
2. Select the **Respond to agent** action and open **Settings**.
3. Turn on **Asynchronous response**.
4. Save the flow and note that the flow can now continue running beyond two minutes where supported.
5. Test with a deliberately long-running path such as extra research or multiple downstream actions.
6. Observe how the agent behaves if the user sends another message before the flow completes, and document the user-experience implications.


### Step 3 — Turn on express mode where appropriate

1. Open a different agent flow that is logic-heavy but not data-heavy.
2. On the flow overview details or directly on the trigger card, turn on **Express mode**.
3. Save the flow and rerun your test prompt.
4. Compare the observed runtime with express mode on versus off.
5. If the flow starts hitting data or memory limitations, turn express mode back off and document why.
6. Keep the pattern only where it genuinely improves performance without breaking reliability.

> ⚠️ **Warning:** Express mode is not a universal speed button. It can fail or underperform on data-heavy flows.

### Step 4 — Create a performance decision table

1. List your flows and categorize each one as standard synchronous, express mode, asynchronous, or fire-and-forget.
2. Capture the reason for each choice, including latency tolerance, data volume, and user expectation.
3. Share the table with your team so future makers do not guess which performance pattern to use.
4. Add one test prompt per flow to your regression set.
5. Review the table after any major flow redesign because the right performance mode can change.
6. Save the table with your lab artifacts.


#### Quick verification

- At least one flow has asynchronous response enabled.
- At least one suitable flow was evaluated for express mode.
- A documented decision rule exists for choosing between them.

### Test prompts

Use these prompts in Copilot Studio test chat, the flow test pane, or the voice test panel as appropriate:

```text
Run the long research flow and confirm the asynchronous response returns after the long path completes.
Run the extraction flow before and after express mode to compare runtime.
```

### Validation checklist

- You can explain when to use asynchronous response versus express mode.
- You enabled asynchronous response on a qualifying flow.
- You tested express mode on a suitable logic-heavy flow.
- A documented decision table exists for future makers.

### What you accomplished

| Outcome | Why it matters |
|---|---|
| Configured long-running flow behavior | The agent can now wait for extended processing when appropriate. |
| Tested a flow-acceleration pattern | You learned when express mode helps and when it does not. |
| Documented performance decisions | Future design choices can stay consistent across the team. |

### Key takeaways

- Performance mode is part of flow design, not just a deployment tweak.
- Asynchronous response and express mode solve different problems.
- The right choice depends on data volume, latency tolerance, and user expectation.

### Troubleshooting

- If asynchronous response is unavailable, confirm the environment architecture supports it.
- If express mode fails, the flow may be too data-heavy or memory-intensive for that pattern.

### Evidence to capture

- Save at least one successful run, screenshot, or transcript excerpt for future demos and regression checks.
- Record the configuration choices that most influenced the result, such as descriptions, instructions, model selection, or access settings.
- Note one failure mode or edge case discovered during this use case so the team can retest it later.
- Capture which stakeholder would need to review this capability before broader rollout.

### Improvement ideas

- Add one more regression prompt that stresses this use case from a different angle.
- Decide whether any part of this pattern should become a reusable asset for other agents, flows, or teams.
- Review whether logging, governance, or support ownership need to be tightened before production use.
- Identify the next adjacent scenario you would automate or route now that this use case is working.

### Stakeholder discussion prompts

- What business outcome improves most if this use case becomes a standard operating capability?
- What would make the result more trustworthy to operations, security, or compliance reviewers?
- Which metric should be watched first after rollout to prove this use case is adding value?
- What is the simplest rollback plan if this use case behaves unexpectedly after a change?

### ✅ You've completed Use Case #6

You now have the foundation to move from **a functionally correct flow** to **a performance-tuned flow strategy**.

---

# 🙋 Summary

### What you accomplished

| Step | What you did |
|---|---|
| **Prompt design** | Created a reusable utility-focused prompt with structured outputs |
| **Flow integration** | Embedded prompt nodes in an agent flow and returned deterministic outputs |
| **Research** | Used the Microsoft 365 Copilot node for grounded drafting and analysis |
| **Governance** | Applied prompt-level moderation and quality review |
| **Performance** | Configured async and express-mode patterns for different flow workloads |

### Why this matters for energy and utilities

- Prompt assets let utility teams automate high-volume language tasks without rebuilding logic every time.
- Flow nodes make AI outputs composable with deterministic business automation.
- Performance and moderation settings are essential when AI is used in operational or regulated workflows.

### Recommended next steps

- Create a library of prompts for bilingual customer communications, field-note classification, and meeting recap drafting.
- Run a small evaluation set that measures extraction accuracy before and after prompt changes.
- Add human approval steps where prompt output may be sent externally or stored in official records.

> 🔋 **Final thought:** Prompt engineering becomes enterprise-ready only when it is paired with structure, testing, moderation, and performance discipline.

---

## 📎 Appendix A — Suggested facilitation prompts

Use these prompts to guide discussion during a live workshop, customer briefing, or internal enablement session.

- Which utility writing tasks are repetitive enough to justify a reusable prompt asset?
- Where do we need structured output rather than plain text to feed downstream systems?
- Which flows are logic-heavy versus data-heavy, and how does that affect express mode choices?
- What categories of generated content always require human review before distribution?
- How should we version prompts when multiple teams depend on them?

## 📎 Appendix B — Environment readiness checklist

- Dataverse is available in the environment.
- Copilot Credits and regional support are confirmed.
- Sample utility narratives and notes are prepared for testing.
- At least one qualifying flow exists for async response and express mode evaluation.
- Prompt test cases and expected outputs are documented.
- Responsible AI review expectations are understood by the team.

## 📎 Appendix C — Extension ideas

- Build a multilingual prompt that rewrites outage notices into English and Spanish with consistent terminology.
- Add a custom structured output schema that writes directly into a Dataverse or SharePoint schema.
- Track latency and quality changes as you switch models for the same prompt.

## 📎 Appendix D — Demo prompt bank

Use these copy-paste prompts when you want a quick demonstration set for the lab.

- Field notes: Crew isolated feeder 12A after vegetation contact. 1,842 customers impacted. No injuries. Temporary bypass active. Permanent repair scheduled for 06:00 tomorrow.
- Field notes: Smoke reported near transformer bank. Crew dispatched. Customers rerouted. Awaiting safety clearance.
- Extract details from this outage note: Feeder 77B tripped at 14:10 after contractor dig-in. 623 customers interrupted. One traffic signal affected. Crew on site. Estimated restoration 18:00.
- Draft a meeting-prep summary for the South Region storm hardening review.
- Research the current status of the EV charging deployment workstream and draft a one-paragraph leader update.
- Summarize this customer complaint narrative and identify the requested follow-up action.
- Use the original and improved prompt on the same outage note and compare field consistency.
- Run the long research flow and confirm the asynchronous response returns after the long path completes.
- Run the extraction flow before and after express mode to compare runtime.

## 📎 Appendix E — Change control checklist

- Record the feature, tool, or topic version before making edits.
- Retest at least one known-good prompt after every significant change.
- Capture screenshots or transcripts for any issue you escalate.
- Review security and access implications whenever you add a new data source or tool.
- Document the owner of every integration, flow, or connected agent used in the lab.
- Use a limited pilot audience before broad rollout.
- Define rollback steps before enabling a new capability in production-like environments.
- Revisit retention and logging settings whenever you expand scope.
- Store prompt or instruction changes in version control or change records where possible.
- Schedule a follow-up review after the pilot to decide what should be hardened, simplified, or retired.

## 📎 Appendix F — Vocabulary quick reference

- Prompt Builder: The authoring surface for reusable prompt assets with instructions, inputs, outputs, and testing.
- Prompt node: An AI step inside a workflow or agent flow that performs a single model call.
- Structured output: A typed response shape that downstream flow steps can consume deterministically.
- M365 Copilot node: A flow step that asks Microsoft 365 Copilot or a targeted M365 agent to research or draft content.
- Content moderation: Per-prompt filtering choices for hate/fairness, sexual, violence, and self-harm categories.
- Asynchronous response: A mode that allows long-running agent flows to continue beyond the traditional two-minute limit.

## 📎 Appendix G — Use-case review worksheet

### Use Case #1 — Create a prompt with Prompt Builder

- Objective review: Design a reusable prompt with inputs, output structure, model selection, and moderation awareness.
- Success evidence to collect: The prompt exists as a reusable asset.
- Most important takeaway: Reusable prompts are easier to govern than one-off embedded instructions.
- Most likely support issue: If fields blur together, tighten the instruction and examples before changing the model.
- Suggested next enhancement: Prompt scope should stay focused on one clear business outcome.

### Use Case #2 — Add a prompt node to an agent flow

- Objective review: Insert a prompt node into a flow to do AI-powered extraction or translation.
- Success evidence to collect: The agent flow contains a prompt node.
- Most important takeaway: Prompt nodes are ideal for one-step transformations inside a larger automation.
- Most likely support issue: If output tokens are missing, review the prompt output shape configuration.
- Suggested next enhancement: Prompt reuse improves consistency and maintainability.

### Use Case #3 — Use the Microsoft 365 Copilot node

- Objective review: Add an M365 Copilot node for research and document drafting.
- Success evidence to collect: The M365 Copilot node is configured and tested.
- Most important takeaway: The M365 Copilot node is strongest when user context matters materially.
- Most likely support issue: If the output is vague, clarify the scope, timeframe, and format in the message.
- Suggested next enhancement: Grounded drafting works well as one step inside a broader deterministic workflow.

### Use Case #4 — Configure content moderation per prompt

- Objective review: Set sensitivity levels for content filtering on a per-prompt basis.
- Success evidence to collect: Moderation settings were reviewed at the prompt level.
- Most important takeaway: Content moderation should be scenario-specific whenever possible.
- Most likely support issue: If useful content is blocked, the settings may be too restrictive for the prompt's domain language.
- Suggested next enhancement: Testing with realistic edge cases is essential before rollout.

### Use Case #5 — Test prompt quality with Prompt Advisor

- Objective review: Score and optimize prompts using Prompt Advisor.
- Success evidence to collect: A baseline and optimized prompt version exist.
- Most important takeaway: Prompt quality improves fastest when you compare versions against the same data.
- Most likely support issue: If the advisor suggestions make the prompt worse for your domain, keep the original and document why.
- Suggested next enhancement: A prompt is a living asset, not a one-time setup step.

### Use Case #6 — Async responses and express mode

- Objective review: Configure long-running flows to use asynchronous response and decide when express mode is the better fit.
- Success evidence to collect: You can explain when to use asynchronous response versus express mode.
- Most important takeaway: Performance mode is part of flow design, not just a deployment tweak.
- Most likely support issue: If asynchronous response is unavailable, confirm the environment architecture supports it.
- Suggested next enhancement: The right choice depends on data volume, latency tolerance, and user expectation.

## 📎 Appendix H — Facilitator retrospective questions

- Which part of the lab delivered the clearest business value signal?
- Where did learners need the most clarification or setup help?
- Which configuration step should be templatized for future workshops?
- What governance question came up repeatedly during testing?
- Which scenario felt most production-ready by the end of the lab?
- Which scenario should stay in pilot or preview status longer?
- What data, screenshot, or transcript artifact should be saved as a future teaching example?
- What would you simplify if you had to teach this lab in half the time?

## 📎 Appendix I — Role-based adaptation ideas

- For utility executives: shorten outputs into briefing bullets and decision-oriented summaries.
- For operations managers: emphasize current blockers, exceptions, and next actions.
- For field supervisors: simplify the language and foreground immediate procedural steps.
- For analysts: retain more detail, numeric evidence, and traceability to underlying sources.
- For compliance reviewers: elevate logging, retention, consent, and approval checkpoints.
- For helpdesk or contact-center leads: prioritize repeatability, escalation clarity, and support runbooks.

## 📎 Appendix J — Final quality gate

- At least one successful end-to-end scenario has been recorded.
- At least one edge case or failure path has been tested deliberately.
- Descriptions, instructions, and prompts are understandable to a reviewer who did not build the solution.
- Ownership is documented for every connected service, flow, tool, or knowledge source.
- A rollback or disable path exists before broader rollout.
- The pilot audience and feedback loop are defined.

## 📎 Appendix K — Quick demo script

- Start with the business problem in one sentence.
- Show the core happy-path scenario end to end.
- Show one failure or edge case and how the solution handles it.
- Explain the governance or support controls that make the scenario enterprise-ready.
- Close with the next step you would pilot in the real organization.
