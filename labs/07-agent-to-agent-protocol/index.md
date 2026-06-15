# 🔗 Lab 07: Connect Agents Across Platforms with the Agent-to-Agent (A2A) Protocol

*Coordinate Copilot Studio agents with external analytics agents so the right specialist handles the right utility question.*

| | |
|---|---|
| ⭐ **DIFFICULTY** | Advanced (Level 300) |
| ⏱️ **TIME** | 90 minutes |
| 🧩 **PRODUCTS** | Microsoft Copilot Studio, Microsoft Fabric, A2A Protocol |
| 🏷️ **TAGS** | A2A, Multi-Agent, Orchestration, Cross-Platform, Fabric Data Agents |
| 🏭 **INDUSTRIES** | Energy / Utilities |

---

## Overview

Modern utility scenarios rarely live inside one agent boundary. An account-support agent might understand customer history, while a Fabric Data Agent understands meter telemetry, rate analysis, or load forecasting. Rather than force one agent to own every tool and dataset, you can connect specialists and let an orchestrator route work intelligently.
In this lab, you will use the **Agent-to-Agent (A2A) protocol** to connect **Copilot Studio** with external agents such as **Microsoft Fabric Data Agents**. The lab continues the Contoso / Contoso Energy energy context by building a parent agent that decides whether to answer directly, hand work to an internal Copilot Studio specialist, or delegate to an external analytics agent over A2A.
You will also compare A2A with the connected-agent pattern from Lab 03 so you know when to keep everything inside Copilot Studio and when to open the architecture to cross-platform orchestration.

---

## 🏗️ What you'll build

| Layer | What you will build |
|---|---|
| **Parent agent** | **Grid Insights Orchestrator** that receives user questions |
| **Internal agent** | A Copilot Studio specialist for account operations or knowledge-grounded support |
| **External agent** | A **Fabric Data Agent** connected over the **A2A protocol** |
| **Routing layer** | Instructions and descriptions that steer questions to the correct specialist |
| **Validation suite** | Cross-platform routing tests for analytics, billing, and fallback questions |
| **Monitoring plan** | Conversation analytics and run review for multi-agent performance |

### Architecture summary

```text
User
  -> Grid Insights Orchestrator (Copilot Studio)
      -> Internal Copilot Studio agent for operational questions
      -> External A2A / Fabric Data Agent for analytics
      -> Final response assembled for planner, analyst, or operator
```

> 💡 **Tip:** Use multiple agents to improve specialization and manageability, not just because the feature is new.

---

## Objectives

1. Understand how A2A differs from child and connected agents in a single Copilot Studio environment.
2. Connect a Copilot Studio agent to a Fabric Data Agent over the A2A protocol.
3. Design a parent orchestrator that coordinates internal and external specialists.
4. Test whether routing goes to the right agent for different utility questions.
5. Review multi-agent analytics and performance tradeoffs.

---

## 🧠 Core concepts

| Concept | What it means in this lab |
|---|---|
| **Connected agent** | A reusable Copilot Studio agent connected inside the platform. |
| **Child agent** | A lightweight subagent created within an existing main agent. |
| **A2A protocol** | A cross-platform agent contract for delegating tasks to external agents. |
| **Fabric Data Agent** | An analytics-oriented external agent that can reason over Fabric data artifacts. |
| **Agent descriptions** | The routing hints the orchestrator reads to decide which specialist to use. |
| **Latency hop** | Each additional agent handoff can add delay, so specialization must justify the extra step. |
| **Activity map** | The view that reveals which connected or external agent handled the request. |
| **Known limitation** | Fabric Data Agents can be connected, but they cannot currently be redirected to explicitly from a topic node. |

---

## 📚 Documentation

- [Add other agents overview](https://learn.microsoft.com/en-us/microsoft-copilot-studio/authoring-add-other-agents)
- [Connect to an agent over the Agent2Agent (A2A) protocol](https://learn.microsoft.com/en-us/microsoft-copilot-studio/add-agent-agent-to-agent)

---

## Prerequisites

- An environment with access to **Microsoft Copilot Studio** and the ability to connect other agents.
- A working Copilot Studio specialist agent from a previous lab, such as the Contoso account or operations pattern from **Lab 03**.
- Access to **Microsoft Fabric** and a **Fabric Data Agent** or equivalent A2A-capable analytics endpoint.
- A small set of sample utility analytics questions, such as feeder peak-load analysis, outage trends, or billing-segment comparisons.

> ⚠️ **Warning:** Because connected agents expand your solution surface area, align naming, ownership, and test responsibilities before you connect them.

---

## 🗺️ Use cases covered

| # | Section | Time | Required |
|---|---|---|---|
| 1 | Understand A2A vs connected agents | 15 min | ✅ |
| 2 | Connect to a Fabric Data Agent | 20 min | ✅ |
| 3 | Build a multi-agent orchestration | 20 min | ✅ |
| 4 | Test cross-platform routing | 15 min | ✅ |
| 5 | Monitor A2A performance | 20 min | ✅ |

> 💡 **Tip:** Keep your first A2A pilot narrow. Connect one external specialist for one high-value class of questions before building a complex web of agent dependencies.

---

# 🧪 Use Case #1 — Understand A2A vs connected agents (15 min)

> 🎯 **Objective:** Compare internal Copilot Studio connected agents with external A2A specialists so you choose the right pattern.

### Scenario

A utility architecture team already used connected agents in Lab 03. Now they want to know when to keep that model and when to use A2A for an external analytics specialist.
You will create a simple design matrix before building anything.

### Step 1 — Review the multi-agent options in Copilot Studio

1. Open the Microsoft Learn article **Add other agents overview** and review the options for child agents, connected Copilot Studio agents, and external agents such as A2A and Fabric Data Agents.
2. Note that child agents are lightweight and live within the same parent solution, while connected agents are separate agents that can be reused and managed independently.
3. Record that external agents introduce cross-platform orchestration and can be attractive when the specialist lives outside Copilot Studio.
4. Capture the rule of thumb from Microsoft Learn that orchestration quality often degrades once a main agent has too many similarly described actions or tools.
5. Document the governance tradeoff: more agents improve specialization but increase testing, management, and observability requirements.
6. Share those notes with your team before you start connecting external endpoints.


### Step 2 — Create a decision matrix for your utility scenario

1. List three common questions from your utility scenario: operational policy question, customer-account lookup, and analytics-heavy feeder question.
2. For each question, decide whether the best resource is a parent topic, a connected Copilot Studio specialist, or an external A2A analytics agent.
3. Mark whether the specialist needs independent lifecycle management, a different model choice, or access to data that only exists in Fabric.
4. Add a column for expected latency tolerance so the team understands whether another orchestration hop is acceptable.
5. Add a column for compliance impact, especially if the external agent can access sensitive analytical or customer-adjacent data.
6. Use the matrix as the architecture baseline for the rest of the lab.


#### Sample comparison matrix starter for this step

```text
Question Type | Best Pattern | Why
Policy / FAQ | Parent or internal connected agent | Uses existing Copilot Studio knowledge and low-latency answers
Account operations | Internal connected agent | Same platform, shared governance, reusable operations specialist
Grid analytics | External A2A / Fabric agent | Data gravity lives in Fabric; analytics specialist owns reasoning
```

### Step 3 — Identify routing implications

1. Decide whether your parent agent should ever answer analytics questions directly or whether it should always defer to the Fabric specialist.
2. Write one sentence describing what makes an analytics question distinct, such as load trend analysis, meter data aggregation, or semantic-model reasoning.
3. Write one sentence describing what belongs to the internal operational specialist, such as account notes, customer process guidance, or internal policy answers.
4. Record that Fabric Data Agents can currently be connected but not explicitly redirected to from a topic node, so routing will rely on orchestration rather than topic-level redirect.
5. Define one fallback path for the parent agent when neither specialist should answer, such as asking a clarifying question or handing off to a human analyst.
6. Treat these statements as design artifacts, not just temporary notes—they will shape instructions and descriptions later.

> 💡 **Tip:** If two specialists sound similar in their descriptions, routing quality falls. Differentiate them aggressively.

### Test prompts

Use these prompts in Copilot Studio test chat, the flow test pane, or the voice test panel as appropriate:

```text
Should this question go to an internal operational specialist or an external analytics specialist: Which feeders in the South Bay district showed the highest evening peak growth this quarter?
Should this question stay inside Copilot Studio: How do I explain paperless billing enrollment rules to a customer operations rep?
```

### Validation checklist

- You documented when to use parent logic, internal specialists, and external A2A specialists.
- The team understands the routing limitation for Fabric Data Agents.
- You have clear language for what makes an analytics query distinct.

### What you accomplished

| Outcome | Why it matters |
|---|---|
| Compared agent patterns | You created a practical design lens instead of adopting A2A blindly. |
| Mapped questions to specialists | Routing accuracy starts with a strong architecture decision. |
| Captured platform limitations | Knowing the redirect limitation avoids false implementation assumptions. |

### Key takeaways

- A2A is valuable when data, lifecycle, or ownership live outside Copilot Studio.
- Connected-agent choices should be intentional and testable.
- Clear specialist boundaries are more important than the number of agents.

### Troubleshooting

- If your team cannot explain the specialist boundaries in one sentence each, refine the design before connecting anything.
- If every question seems to fit every agent, you likely need fewer agents or clearer descriptions.

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

You now have the foundation to move from **a rough multi-agent idea** to **an explicit decision model for specialization**.

---

# 🧪 Use Case #2 — Connect to a Fabric Data Agent (20 min)

> 🎯 **Objective:** Attach a Copilot Studio agent to an external Fabric analytics specialist over A2A.

### Scenario

Your operations team has a Fabric Data Agent that can answer questions about feeder performance, outage history, and rate-segment analytics. You want your parent agent to use that specialist instead of trying to answer analytical questions itself.

### Step 1 — Prepare the external agent endpoint

1. Confirm that the Fabric Data Agent or other external analytics agent is available and that you know the endpoint or connection details required by Copilot Studio.
2. Verify the agent has a clear name and description that emphasize analytics, semantic-model access, and utility planning use cases.
3. Coordinate with the Fabric owner so the connected agent exposes only the datasets or semantic models you want the pilot to use.
4. Check whether additional consent or delegated authorization is needed for the connection.
5. Prepare two or three example prompts the Fabric agent can already answer successfully before you connect it to the parent.
6. Record the ownership contact for the external agent because support will cross team boundaries once you connect it.


### Step 2 — Add the external agent in Copilot Studio

1. Open your parent Copilot Studio agent and go to the **Agents** page.
2. Select **Add agent** and choose the external agent / **Agent2Agent (A2A)** option available in your tenant.
3. Enter the connection details for the Fabric Data Agent and wait for Copilot Studio to retrieve or validate the external agent metadata.
4. Review the imported or displayed name and description carefully. If they are vague, improve them at the source if possible because the orchestrator depends on these hints.
5. Save the connection and confirm the external agent appears in the parent agent's **Agents** list.
6. Leave the agent enabled so the orchestrator can consider it during testing.

> ⚠️ **Warning:** Do not settle for a generic description like 'data agent.' That forces the parent to guess when analytics delegation is appropriate.

### Step 3 — Refine the external description for utility analytics

1. Open the connected agent details and review any editable description fields exposed in Copilot Studio.
2. Add specificity such as feeder load trends, outage analytics, rate segmentation, district-level comparisons, and Fabric semantic-model reasoning.
3. State that the agent is best used for analytical, aggregate, or trend-oriented questions rather than account-by-account operational lookups.
4. Mention the preferred output style, such as concise analytical summaries with numeric evidence, assumptions, and caveats.
5. Save your changes and compare the description with the internal specialist description to make sure they do not overlap heavily.
6. Document the final phrasing so you can reuse it in future environments or ALM pipelines.


#### Sample prompt for this step

```text
Use this external analytics agent for utility planning and operational analysis questions that require Microsoft Fabric data, semantic-model reasoning, trend comparison, or district / feeder level metrics. Examples include load growth, outage trend analysis, segment comparison, and time-based analytical summaries. Do not use this agent for customer-account operations, policy FAQs, or internal procedural guidance.
```

### Step 4 — Confirm internal specialist coexistence

1. Make sure your parent agent also has an internal specialist or topic path for nonanalytics questions, such as an account operations or support knowledge agent.
2. Review both connected resources together and confirm they serve distinct roles in the solution.
3. Rename the internal specialist if needed so its purpose is obvious to future makers and operators.
4. Keep both agents enabled and return to the parent agent overview to prepare instructions that mention each specialist clearly.
5. If the parent still has many unrelated tools, consider disabling nonessential ones during the first pilot so routing signals stay clean.
6. Save the parent agent once the specialist set is stable.


### Test prompts

Use these prompts in Copilot Studio test chat, the flow test pane, or the voice test panel as appropriate:

```text
Which feeders in the Contoso Energy South Bay district had the highest year-over-year evening peak growth?
Compare outage counts by district for the last 12 months and highlight the top drivers.
```

### Validation checklist

- The Fabric Data Agent appears in the parent agent's connected agent list.
- Its description clearly distinguishes analytics work from operational work.
- The parent has at least one alternative internal specialist or fallback path.

### What you accomplished

| Outcome | Why it matters |
|---|---|
| Connected an external A2A specialist | Your parent agent can now reach capabilities outside the Copilot Studio boundary. |
| Improved routing metadata | Specialist descriptions are what make orchestration intelligible. |
| Prepared a mixed agent set | You now have internal and external specialists ready for coordinated routing. |

### Key takeaways

- The external connection is only half the job; the description quality often determines success.
- A2A works best when the external agent already performs well on its own.
- Ownership boundaries must be explicit when specialists come from different teams or platforms.

### Troubleshooting

- If the external agent does not appear after connection, verify tenant availability, permissions, and endpoint details.
- If routing later feels random, revisit the external description before changing the parent instructions.

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

You now have the foundation to move from **an isolated external analytics agent** to **a connected external specialist in the parent solution**.

---

# 🧪 Use Case #3 — Build a multi-agent orchestration (20 min)

> 🎯 **Objective:** Create a parent agent that coordinates between an internal Copilot Studio specialist and an external A2A specialist.

### Scenario

The parent agent should feel like one front door for grid planners, customer operations analysts, and territory managers. Behind the scenes, it should decide which specialist deserves the question.

### Step 1 — Define the parent agent purpose

1. Rename or create the parent agent as **Grid Insights Orchestrator**.
2. Write a plain-language purpose statement: the orchestrator handles utility questions and delegates either to an internal Copilot Studio specialist for operational support or to the Fabric Data Agent for analytics.
3. Tell the agent to ask clarifying questions when the request could fit either specialist.
4. Tell it to prefer concise answers that mention whether the response came from an analytics specialist or operational specialist when useful for traceability.
5. Save the overview changes and ensure the specialist list remains enabled.
6. Avoid loading the parent with too many other tools during the first A2A pilot.


### Step 2 — Write high-signal parent instructions

1. Open the parent **Instructions** field and describe the delegation rules explicitly.
2. Explain that analytical, aggregate, or trend questions belong to the external Fabric specialist.
3. Explain that procedural, customer-support, or operational questions belong to the internal Copilot Studio specialist or parent knowledge sources.
4. Tell the parent to ask one clarifying question if a user request mixes account operations and analytics in the same sentence.
5. Tell the parent not to invent analytical results if the Fabric specialist is unavailable; it should instead report the limitation or route to a human analyst.
6. Save the instructions and read them side by side with each connected agent description to confirm the language is complementary.


#### Sample prompt for this step

```text
You are the Grid Insights Orchestrator for Contoso Energy and Contoso planning teams.
Use the internal Copilot Studio specialist for customer operations, process guidance, and internal support questions.
Use the external Fabric analytics agent for questions that require trend analysis, feeder or district comparisons, semantic-model reasoning, or numerical summaries over time.
If a request mixes operations and analytics, ask one clarifying question or handle the operational part first and then the analytics part if both are needed.
Never guess at analytical values if the analytics specialist is unavailable.
```

### Step 3 — Tune internal specialist descriptions

1. Open the internal connected agent or child agent description and make it clearly operational in focus.
2. Mention scenarios such as account process guidance, billing operations, internal runbooks, or support knowledge retrieval.
3. Remove any generic wording that sounds analytical or data-science oriented.
4. If the internal specialist has tools that could answer some numeric questions, keep the description explicit that it is for operational context, not enterprise analytics.
5. Save the updated description and return to the parent overview.
6. Take a screenshot or note of the final description set for documentation.


### Step 4 — Plan fallback and escalation behavior

1. Decide how the parent should respond if the analytics specialist cannot answer: clarify, apologize, or offer a human handoff.
2. Decide whether the parent should ever synthesize results from both specialists in one response or whether you want the pilot to keep them separate for simplicity.
3. Document when the parent should stop after one unsuccessful specialist attempt rather than ping-pong between agents.
4. If you use a topic or system message for escalations, make sure it does not overlap confusingly with the specialists.
5. Write two examples of mixed questions and how you expect the parent to break them apart.
6. Save the orchestrator once the support model is clear.


#### Quick verification

- Parent instructions mention both specialists explicitly.
- Internal and external descriptions are distinct.
- Fallback behavior is documented before testing.

### Test prompts

Use these prompts in Copilot Studio test chat, the flow test pane, or the voice test panel as appropriate:

```text
Summarize the top outage trend in the North County district during the last 90 days.
How should a customer operations rep explain delayed paperless billing activation?
Compare peak-load growth by district and then tell me who owns the customer-rate exception workflow.
```

### Validation checklist

- The parent instructions clearly describe delegation rules.
- Internal and external specialists have nonoverlapping descriptions.
- Fallback behavior exists for ambiguous or failed routing.

### What you accomplished

| Outcome | Why it matters |
|---|---|
| Created an orchestration layer | The parent agent is now responsible for specialist selection instead of trying to own everything itself. |
| Differentiated specialist roles | Distinct descriptions reduce misrouting. |
| Defined fallback behavior | Users get a controlled response when a specialist cannot help. |

### Key takeaways

- Multi-agent quality depends on orchestration clarity more than architecture diagrams.
- Parent instructions and child descriptions should read like complementary contracts.
- Fallback behavior matters just as much as the happy path.

### Troubleshooting

- If both specialists answer the same kinds of prompts, sharpen the descriptions before adding more instructions.
- If the parent keeps over-answering directly, strengthen the instruction language about when to delegate.

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

You now have the foundation to move from **connected specialists** to **a purposeful multi-agent front door**.

---

# 🧪 Use Case #4 — Test cross-platform routing (15 min)

> 🎯 **Objective:** Verify that the orchestrator sends utility questions to the right specialist.

### Scenario

A beautiful architecture is not enough. You need proof that analytical questions go to Fabric, operational questions stay in the Copilot Studio domain, and mixed questions are handled predictably.

### Step 1 — Build a routing test matrix

1. Create a simple table with three columns: prompt, expected specialist, and actual specialist.
2. Add at least three analytics-heavy prompts, three operational prompts, and two intentionally mixed prompts.
3. Include a fallback or ambiguous prompt that should trigger a clarifying question.
4. Use Contoso Energy or Contoso Energy scenarios so the prompts feel realistic to planners and operations teams.
5. Save the matrix where other testers can reuse it.
6. Reset the test chat before starting so prior conversation state does not bias routing.


### Step 2 — Run analytics prompts

1. Ask an analytics prompt such as a district trend, load forecast comparison, or outage-rate comparison.
2. Open the activity map and confirm that the external A2A / Fabric specialist handled the request.
3. Record the outcome in your matrix and note the response quality, not just the route.
4. Repeat with at least two more analytics prompts to check consistency rather than one lucky result.
5. If the parent answered directly instead of delegating, revise the parent instructions or the external agent description before moving on.
6. Watch for unnecessary clarifying questions that may indicate poor specialist separation.


### Step 3 — Run operational and mixed prompts

1. Ask an operational prompt such as an internal process explanation or customer operations guidance request.
2. Confirm that the internal Copilot Studio specialist or parent knowledge path handled the request.
3. Next, ask a mixed prompt that combines analytics and operations and see whether the parent asks a clarifying question or resolves the parts in a controlled order.
4. Record whether the routing matched your expectation and whether the final answer remained understandable to the user.
5. If the mixed prompt caused the wrong specialist to answer, make the distinction between question types more explicit in the parent instructions.
6. Repeat once after making changes so you can measure improvement immediately.


#### Sample prompt for this step

```text
Which district had the highest growth in evening peak demand last summer, and who owns the current customer-rate exception workflow for that district?
```

### Test prompts

Use these prompts in Copilot Studio test chat, the flow test pane, or the voice test panel as appropriate:

```text
Which district saw the largest quarter-over-quarter increase in outage restoration time?
How should an operations rep document a customer-requested rate exception?
Compare feeder growth in East County and then tell me where the rate-plan escalation instructions live.
I need a district-level analytics summary, but I am not sure whether to compare outage frequency or load growth first.
```

### Validation checklist

- Analytics prompts consistently route to the external specialist.
- Operational prompts consistently route internally.
- Mixed prompts are handled deliberately rather than randomly.
- The team recorded actual routing outcomes in a reusable matrix.

### What you accomplished

| Outcome | Why it matters |
|---|---|
| Tested route intent against actual behavior | You now know whether the orchestrator works instead of assuming it does. |
| Captured mixed-prompt behavior | Ambiguous prompts reveal routing weaknesses faster than happy-path prompts. |
| Established a reusable regression set | Future changes can be tested against the same matrix. |

### Key takeaways

- Routing tests should include ambiguous prompts, not just obvious ones.
- You are validating response quality and route selection together.
- A short regression set goes a long way when iterating on descriptions.

### Troubleshooting

- If routes flip-flop between runs, remove overlap in instructions and descriptions.
- If operational prompts keep hitting Fabric, the external description is likely too broad.

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

You now have the foundation to move from **an orchestrator configuration** to **a validated routing pattern**.

---

# 🧪 Use Case #5 — Monitor A2A performance (20 min)

> 🎯 **Objective:** Review analytics for multi-agent conversations and understand performance tradeoffs.

### Scenario

Every agent hop introduces a little more latency and operational complexity. You need a practical way to monitor whether the user experience still justifies the architecture.

### Step 1 — Review recent conversation activity

1. Open the parent agent **Activity** page and inspect several recent runs from your routing tests.
2. For each run, verify which specialist was used and whether the final answer felt appropriately concise.
3. Record response time impressions and any user-visible delay between the prompt and the response.
4. Note whether the activity map gives enough traceability for your support team to understand cross-agent behavior.
5. If you maintain a manual log, capture the prompt category, selected specialist, and pass/fail outcome.
6. Use those observations to decide whether more formal analytics are needed for the pilot.


### Step 2 — Create a lightweight performance scorecard

1. Track at least four metrics: successful route percentage, average response time by specialist, clarifying-question rate, and fallback / failure rate.
2. Split the scorecard by prompt class so analytics prompts are not mixed with operational prompts.
3. Add a column for user-perceived quality because a correct route with a poor answer still counts as a product issue.
4. Meet with the Fabric owner and Copilot Studio owner to review the scorecard together.
5. Identify which changes belong to the parent orchestrator, which belong to the internal specialist, and which belong to the external agent.
6. Repeat this review after every major instruction or description change.


### Step 3 — Plan for production hardening

1. List the extra governance tasks introduced by multi-agent solutions: more evaluations, clearer ownership, change windows, and rollback plans.
2. Decide which failures can be absorbed by the parent and which require disabling or disconnecting a specialist temporarily.
3. Document a communication plan for end users if the external analytics specialist becomes unavailable.
4. Consider whether some high-frequency prompts should move back into the parent or internal agent if the external hop is too slow.
5. Add a quarterly review to confirm the specialist boundaries still make sense as new tools are added.
6. Publish the hardening checklist with the same seriousness you would apply to a production API integration.


#### Quick verification

- A performance scorecard exists.
- Ownership across parent, internal specialist, and external specialist is clear.
- Rollback and communication paths are documented.

### Test prompts

Use these prompts in Copilot Studio test chat, the flow test pane, or the voice test panel as appropriate:

```text
Run three analytics prompts and compare response time and quality across them.
Run three operational prompts and confirm the internal specialist stays fast and consistent.
```

### Validation checklist

- You reviewed recent multi-agent runs in the activity experience.
- You created a performance scorecard that separates prompt classes.
- You documented hardening tasks for a broader pilot or production rollout.

### What you accomplished

| Outcome | Why it matters |
|---|---|
| Measured orchestration quality | You can now evaluate whether the cross-platform hop is worth it. |
| Shared ownership across teams | External specialists require cross-team operating discipline. |
| Prepared a hardening plan | The solution can progress beyond a single workshop demo. |

### Key takeaways

- Every extra agent hop should earn its place through better specialization or data access.
- Performance monitoring is a multi-team responsibility in A2A scenarios.
- A2A adoption is an architecture choice with operational consequences.

### Troubleshooting

- If latency is unacceptable, narrow the external use cases or optimize the external specialist first.
- If users are confused about who answered, add better traceability language in the parent response style.

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

You now have the foundation to move from **a working multi-agent demo** to **a monitored cross-platform orchestration pattern**.

---

# 🙋 Summary

### What you accomplished

| Step | What you did |
|---|---|
| **Compare** | Mapped when to use connected agents versus external A2A specialists |
| **Connect** | Attached a Fabric Data Agent as an external specialist |
| **Orchestrate** | Configured a parent agent to route between internal and external specialists |
| **Validate** | Built and ran a routing test matrix for realistic utility prompts |
| **Operate** | Defined scorecards and ownership for multi-agent monitoring |

### Why this matters for energy and utilities

- Energy and utility teams often keep operational context and analytical context in different systems.
- A2A allows Copilot Studio to remain the front door while specialized analytics agents stay close to their data.
- Cross-platform orchestration can unlock richer scenarios without forcing one agent to become unmanageably broad.

### Recommended next steps

- Add evaluation prompts that compare the same question answered by the parent alone versus the specialized route.
- Explore a second external specialist such as a planning or compliance analytics agent only after the first route is stable.
- Create a support playbook for temporarily disconnecting the Fabric specialist during maintenance windows.

> 🔋 **Final thought:** A2A is most powerful when it preserves specialization and data gravity while still giving users one coherent conversational entry point.

---

## 📎 Appendix A — Suggested facilitation prompts

Use these prompts to guide discussion during a live workshop, customer briefing, or internal enablement session.

- Which utility questions in our environment clearly belong to analytics rather than operations?
- Which team will own description quality for each specialist over time?
- How much extra latency are planners willing to accept for better analytical depth?
- What happens if Fabric data is stale or the external agent is unavailable during a storm event?
- Where should we log route decisions so support teams can explain behavior to business users?

## 📎 Appendix B — Environment readiness checklist

- Parent agent exists and can connect other agents.
- External A2A or Fabric agent is accessible and approved for the lab.
- Internal specialist description is clearly distinct from the external specialist.
- Routing test matrix contains analytics, operational, mixed, and fallback prompts.
- A scorecard template exists for latency and route accuracy.
- Cross-team support contacts are documented.

## 📎 Appendix C — Extension ideas

- Create a monthly regression set that checks route accuracy after every specialist description update.
- Add an internal evaluation rubric that scores whether the parent asks clarifying questions only when necessary.
- Pilot a second Fabric agent for a different analytical domain after the first route stabilizes.

## 📎 Appendix D — Demo prompt bank

Use these copy-paste prompts when you want a quick demonstration set for the lab.

- Should this question go to an internal operational specialist or an external analytics specialist: Which feeders in the South Bay district showed the highest evening peak growth this quarter?
- Should this question stay inside Copilot Studio: How do I explain paperless billing enrollment rules to a customer operations rep?
- Which feeders in the Contoso Energy South Bay district had the highest year-over-year evening peak growth?
- Compare outage counts by district for the last 12 months and highlight the top drivers.
- Summarize the top outage trend in the North County district during the last 90 days.
- How should a customer operations rep explain delayed paperless billing activation?
- Compare peak-load growth by district and then tell me who owns the customer-rate exception workflow.
- Which district saw the largest quarter-over-quarter increase in outage restoration time?
- How should an operations rep document a customer-requested rate exception?
- Compare feeder growth in East County and then tell me where the rate-plan escalation instructions live.
- I need a district-level analytics summary, but I am not sure whether to compare outage frequency or load growth first.
- Run three analytics prompts and compare response time and quality across them.
- Run three operational prompts and confirm the internal specialist stays fast and consistent.

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

- Connected agent: A reusable Copilot Studio agent connected inside the platform.
- Child agent: A lightweight subagent created within an existing main agent.
- A2A protocol: A cross-platform agent contract for delegating tasks to external agents.
- Fabric Data Agent: An analytics-oriented external agent that can reason over Fabric data artifacts.
- Agent descriptions: The routing hints the orchestrator reads to decide which specialist to use.
- Latency hop: Each additional agent handoff can add delay, so specialization must justify the extra step.

## 📎 Appendix G — Use-case review worksheet

### Use Case #1 — Understand A2A vs connected agents

- Objective review: Compare internal Copilot Studio connected agents with external A2A specialists so you choose the right pattern.
- Success evidence to collect: You documented when to use parent logic, internal specialists, and external A2A specialists.
- Most important takeaway: A2A is valuable when data, lifecycle, or ownership live outside Copilot Studio.
- Most likely support issue: If your team cannot explain the specialist boundaries in one sentence each, refine the design before connecting anything.
- Suggested next enhancement: Clear specialist boundaries are more important than the number of agents.

### Use Case #2 — Connect to a Fabric Data Agent

- Objective review: Attach a Copilot Studio agent to an external Fabric analytics specialist over A2A.
- Success evidence to collect: The Fabric Data Agent appears in the parent agent's connected agent list.
- Most important takeaway: The external connection is only half the job; the description quality often determines success.
- Most likely support issue: If the external agent does not appear after connection, verify tenant availability, permissions, and endpoint details.
- Suggested next enhancement: Ownership boundaries must be explicit when specialists come from different teams or platforms.

### Use Case #3 — Build a multi-agent orchestration

- Objective review: Create a parent agent that coordinates between an internal Copilot Studio specialist and an external A2A specialist.
- Success evidence to collect: The parent instructions clearly describe delegation rules.
- Most important takeaway: Multi-agent quality depends on orchestration clarity more than architecture diagrams.
- Most likely support issue: If both specialists answer the same kinds of prompts, sharpen the descriptions before adding more instructions.
- Suggested next enhancement: Fallback behavior matters just as much as the happy path.

### Use Case #4 — Test cross-platform routing

- Objective review: Verify that the orchestrator sends utility questions to the right specialist.
- Success evidence to collect: Analytics prompts consistently route to the external specialist.
- Most important takeaway: Routing tests should include ambiguous prompts, not just obvious ones.
- Most likely support issue: If routes flip-flop between runs, remove overlap in instructions and descriptions.
- Suggested next enhancement: A short regression set goes a long way when iterating on descriptions.

### Use Case #5 — Monitor A2A performance

- Objective review: Review analytics for multi-agent conversations and understand performance tradeoffs.
- Success evidence to collect: You reviewed recent multi-agent runs in the activity experience.
- Most important takeaway: Every extra agent hop should earn its place through better specialization or data access.
- Most likely support issue: If latency is unacceptable, narrow the external use cases or optimize the external specialist first.
- Suggested next enhancement: A2A adoption is an architecture choice with operational consequences.

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
