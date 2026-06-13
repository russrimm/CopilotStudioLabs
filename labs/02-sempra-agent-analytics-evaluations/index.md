# 📊 Lab 02: Monitor Performance and Evaluate Sempra Agent Quality

*If you can't measure it, you can't improve it.*

| | |
|---|---|
| ⭐ **DIFFICULTY** | Intermediate (Level 200) |
| ⏱️ **TIME** | 30 minutes |
| 🧩 **PRODUCTS** | Microsoft Copilot Studio (Analytics + Agent Evaluation preview) |
| 🏷️ **TAGS** | Analytics, Agent Evaluation, Test Sets, Quality Management, Continuous Improvement |
| 🏭 **INDUSTRY** | Energy / Utilities (Sempra family of companies) |

> **Adapted from:** [Monitor Performance and Evaluate Agent Quality — Microsoft Copilot Agents Labs](https://microsoft.github.io/mcs-labs/labs/core-concepts-analytics-evaluations/). Reframed for **Sempra** so you can measure and continuously improve the IT Operations agent you built in [Lab 01](../01-sdge-energy-ops-agent/index.md) — and any other Sempra agent that follows.

---

## ⚡ Why Sempra cares about analytics and evaluations

The SDG&E IT Operations Agent (Lab 01) and the Sempra Customer Operations Assistant (Lab 03) only deliver value if they **work** — turn after turn, day after day, for thousands of field crew, account managers, and dispatchers across SDG&E, SoCalGas, Sempra Infrastructure, and Oncor.

Without a measurement practice, you're flying blind:

- ❌ **Without analytics:** You don't know how many techs interact with the agent, what they ask, or whether they walk away with an answer.
- ❌ **Without evaluations:** You change the agent's instructions or knowledge sources and just *hope* you didn't break something else.
- ✅ **With both:** Analytics tells you **where to improve**. Evaluations tell you **whether your improvements actually worked.** That closed loop is the difference between a one-off pilot and an enterprise-grade practice.

Common challenges this lab solves:

- *"30% of VPN-help conversations end in abandonment — what's going wrong?"*
- *"We added the new NERC CIP guide to knowledge — did it actually help, or just add noise?"*
- *"I changed the agent's instructions to favor the customer-care policy. Did anything else regress?"*
- *"How do I prove this agent is delivering value to leadership?"*

---

## 📖 Real-world example

The IT Operations team at SDG&E uses analytics on their Lab 01 agent and notices that **30% of VPN-related conversations end in user abandonment**. They add the latest **VPN setup guide** and **NERC CIP remote-access standard** to the agent's knowledge sources, then build a 15-question evaluation test set covering VPN scenarios. After the update, evaluations show pass rates climb from **40% → 90%**. A week later, analytics confirm VPN abandonment dropped from **30% → 5%** in real conversations.

That's the cycle: analytics finds the problem, evaluations verifies the fix, analytics confirms the impact.

---

## 🎯 What you will learn

By the end of this lab you will be able to:

1. ✅ Access and interpret conversation analytics (volume, engagement, topic performance)
2. ✅ Read user-satisfaction scores and identify the high-impact improvement opportunities
3. ✅ Use failure analytics — unanswered questions, escalations, abandonments — to find knowledge gaps
4. ✅ Generate evaluation test sets four different ways (auto-generated, CSV import, test-canvas capture, manual entry)
5. ✅ Configure the right **test method** (Exact match, Keyword match, Similarity, General quality, Compare meaning, Capability use, Custom) for each kind of question
6. ✅ Review evaluation results — pass rates, reasoning, knowledge citations, activity maps
7. ✅ Compare runs to verify improvements without regressions, and export results for stakeholders

---

## 🧠 Core concepts overview

| Concept | What it means at Sempra |
|---|---|
| **Conversation Analytics** | Volume, topic usage, and session duration — reveals how field crews and account managers actually use the agent and which capabilities they value most. |
| **User Satisfaction Scores** | The thumbs up/down feedback from real users. Low scores on high-volume topics are your top priority. |
| **Failure Analytics** | Unanswered questions, escalations, and abandonments. Direct signals of where to add knowledge or rewrite a topic flow. |
| **Evaluation Test Sets** | Repeatable collections of questions with expected answers. Run them before and after every change to catch regressions. |
| **Test Methods** | The comparison technique: **Exact match** (hard facts), **Keyword match** (must-mention terms), **Similarity** (lexical closeness), **General quality** (LLM-judged), **Compare meaning** (semantic equivalence), and newer methods like **Capability use** and **Custom**. See [Choose evaluation methods](https://learn.microsoft.com/microsoft-copilot-studio/analytics-agent-evaluation-overview) — methods are added as the preview matures; older docs may call them "evaluation methods" (same thing). |
| **Evaluation Results** | Pass/fail outcomes plus reasoning, knowledge citations, and an **activity map** that shows step-by-step which knowledge sources, tools, and topics the agent used. |

---

## 📚 Documentation

- [Analyze agent performance](https://learn.microsoft.com/microsoft-copilot-studio/analytics-overview)
- [Analyze conversational agent effectiveness](https://learn.microsoft.com/microsoft-copilot-studio/analytics-improve-agent-effectiveness)
- [Agent evaluation overview](https://learn.microsoft.com/microsoft-copilot-studio/analytics-agent-evaluation-overview)
- [Create evaluation test sets](https://learn.microsoft.com/microsoft-copilot-studio/analytics-agent-evaluation-create)
- [View and interpret evaluation results](https://learn.microsoft.com/microsoft-copilot-studio/analytics-agent-evaluation-results)

---

## ✅ Prerequisites

- Completed [Lab 01: Build a Custom IT Operations Agent for SDG&E](../01-sdge-energy-ops-agent/index.md). You'll use that agent throughout this lab. (If you skipped Lab 01, any published Copilot Studio agent in your environment will work — the steps are agent-agnostic.)
- Access to **Microsoft Copilot Studio** with **Analytics** and **Agent Evaluation (preview)** permissions
- Your agent has been **published** and used through a **deployed channel** (Microsoft Teams, a website, or another Copilot Studio channel) — only those conversations contribute to analytics data

> ⚠️ **Important — analytics needs published, real conversations.** Test-canvas conversations may *not* appear in the Analytics view. Before starting Use Case #1, publish your agent and have at least one real conversation through a deployed channel. Even then, analytics data takes **24–48 hours to populate**. There's no way to pre-provision or simulate analytics data — for now, if your environment is brand new, skim the descriptions in Use Case #1 to know what to expect, then move to Use Case #2 (which works immediately).

> 💡 **Preview feature.** Agent Evaluation is currently in **preview** in Copilot Studio. UI and capabilities may shift as Microsoft iterates. Don't use it as your only quality gate for production — pair it with manual review and analytics.

---

## 🗺️ Use cases covered

| # | Use Case | Sempra Framing | Time |
|---|---|---|---|
| 1 | Monitor agent performance with analytics | Read your SDG&E IT Ops agent's real-world behavior — volume, satisfaction, knowledge-source usage, escalations | 10 min |
| 2 | Create and configure evaluation test sets | Build four test sets that exercise auto-generation, CSV import, test-canvas capture, and manual entry | 10 min |
| 3 | Review evaluation results | Compare pass rates, drill into activity maps, identify regressions, export for stakeholders | 10 min |

---

# 🧪 Use Case #1 — Monitor Agent Performance with Analytics

> 🎯 **Objective:** Access and interpret your SDG&E IT Operations Agent's analytics to identify the highest-impact optimization opportunities.

### Scenario

Your **SDG&E IT Operations Agent** has been deployed for several days. Field technicians and the IT helpdesk team have been using it. You need to understand how they're interacting with it, which knowledge sources are getting hit, where conversations are failing, and whether users find it helpful — so you can prioritize the next round of improvements.

> ⚠️ **Important — empty dashboard until publish.** If your Analytics page shows a *"Publish your agent to track performance"* empty-state with a single **Publish** button, none of the dashboard sections below will be visible. Publish your agent and have at least one real conversation through a deployed channel; analytics data takes **24–48 hours** to populate. The Product Group is working on a way to visualize what populated analytics will look like for lab scenarios — until then, skim the descriptions to know what to expect.

### Step 1 — Navigate to Analytics

1. In Copilot Studio, select **Agents** in the left navigation.
2. Open your **SDG&E IT Operations Agent** (from Lab 01) and select **Analytics** in the top navigation bar.
3. Review the analytics dashboard overview, which typically includes:
   - **Summary metrics:** total conversations, engaged conversations, resolution rate
   - **Trend charts:** conversation volume over time
   - **Topic performance:** which topics are used most frequently
   - **User satisfaction:** feedback scores from users
4. Set the date range using the date picker in the top-right of the analytics page:
   - Last 7 days
   - Last 30 days
   - Custom date range

> 💡 **Tip:** Use consistent date ranges when comparing performance over time. **Weekly reviews with 7-day ranges** work well for ongoing monitoring of a Sempra production agent.

### Step 2 — Understand summary metrics

1. In the **Overview** section on the Analytics tab, review the summary metrics.
2. **Conversation sessions** — how many sessions occurred. A session typically starts at the user's first message and ends after a period of inactivity.
3. **Engagement** — the percentage of sessions where the user interacted with your agent at least one time. High engagement is good news.

> 💡 **Note:** Low engagement might mean users got their answer immediately (good!) or gave up after the first response (bad). **Always combine this metric with satisfaction scores** to interpret correctly. At Sempra, a 90% engagement + 90% satisfaction is a healthy IT-ops agent; 90% engagement + 40% satisfaction means the agent is *talking* but not *helping*.

### Step 3 — Analyze conversation volume trends

1. Review the **Conversation outcomes** chart showing conversations over time.
2. Look for patterns:
   - **Peaks** — when is demand highest? (e.g., Monday mornings after weekend outages, end-of-quarter compliance reviews)
   - **Valleys** — when is usage lowest? Schedule maintenance / content updates here
   - **Trends** — is usage growing? Flat lines may indicate awareness issues — your field crews don't know the agent exists yet
3. Consider external factors that might influence trends:
   - **Business cycles** at Sempra (storm season, winter peak demand, regulatory filing deadlines)
   - **Seasonal patterns** (wildfire response, heat-wave outages)
   - **Recent communications** — was there a kickoff announcement or training that drove a usage spike?

> 💡 **Tip:** Share **positive growth trends** with leadership to prove adoption and ROI. Use **declining trends** as triggers to refresh content or run an awareness campaign with field-ops leadership.

### Step 4 — Review agent performance (child & connected agents)

1. Go to the **Agents** section in analytics.
2. Review the metrics for each **child** and **connected** agent your agent uses:
   - Which agents are being called and what type are they?
   - **Number of calls** and **success rate** — a low success rate may indicate the agent needs improvement, or that the planner is routing to it incorrectly (re-read [Lab 03](../03-sempra-account-orchestration-agent/index.md) Use Case #2 if you see this).

### Step 5 — Review generated answer rate and quality

> 💡 This section requires a minimum of **10 answers per day** in conversation sessions before it populates.

1. Go to the **Generated answer rate and quality** section. This tracks answer quality across **completeness**, **relevance**, and **use of knowledge sources**.
2. Review your **Answered** vs. **Unanswered** percentages.
3. Select **See details** to drill into the answer rate and source analytics. The panel opens on the right.
4. Filter by **Main agent** vs. **Child agent** at the top — observe how the data shifts.
5. **Unanswered questions** — breaks down *why* the agent didn't answer. (No matching knowledge? Clarification needed? Off-scope?) This is gold for prioritizing the next knowledge-source addition.
6. **Source use trend** — shows whether one source was used more or less over time. Useful for confirming that the **NERC CIP knowledge** is actually getting hit when compliance questions come in.
7. **All sources** — breakdown by source. If your **uploaded Field Operations Remote Access Guide** is getting 0% usage, either users aren't asking those questions or the descriptions on the knowledge source need work.
8. **Errors** — percentage of queries that produced a knowledge-related error per source. SharePoint permission errors and Bing connector throttling typically show up here first.

### Step 6 — Review escalation and abandonment

1. Go to the **Conversation outcomes** section on the Analytics tab.
2. Upper-right corner of the section, select **See details**.
3. **Resolved** — how often user requests were resolved. Your headline number for *"the agent is working."*
4. **Escalated** — how often users requested human assistance. **High escalation rates** mean the agent can't handle common scenarios — and at Sempra those drop on the helpdesk queue. Watch this number.
5. **Abandoned** — conversations where users left without resolution. Pay attention to **where** in the conversation they drop off — that's a flow design problem, not a knowledge problem.

### Step 7 — Identify improvement opportunities

Based on your analytics review, build a **prioritized list of improvements**. Use this template:

| Pattern | What it means | Sempra example fix |
|---|---|---|
| High-volume + low-satisfaction | Improve knowledge or instructions | "Add the updated VPN setup guide" — addresses 15% of unanswered questions |
| Unrecognized phrases | Add missing knowledge or new topics | "Add 'Energy Support App' as a synonym for 'ESA' in the troubleshooting topic" |
| High abandonment at a specific step | Simplify the flow or add a clarifying message | "Reduce the 3-step substation incident report to 2 steps" |
| Wrong child agent picked | Tune the child agent's name or description | "Rename 'Field Agent' to 'Field Dispatch Agent' so it's distinct from the Account Agent" |

> 💡 **Tip:** Always measure the **before/after impact** of each change by comparing analytics across the same date-range window. That validates your effort and informs the next round of optimization. Make **one change at a time** so you can attribute results cleanly.

### ✅ You've completed Use Case #1

**Key takeaways**

- 📈 **Analytics reveal user behavior.** Conversation volume, engagement, and topic performance show how Sempra users actually interact with the agent.
- 😀 **Satisfaction scores guide priorities.** Low satisfaction on high-volume topics should be your top improvement priority — not the rarely-asked edge cases.
- 🔍 **Failure data drives improvements.** Unrecognized phrases and abandoned conversations directly indicate where to add knowledge or rewrite a flow.

**Troubleshooting**

- Analytics data takes **24–48 hours** to populate — don't expect instant results for new agents.
- Combine multiple metrics for accurate interpretation: low engagement + high satisfaction = users getting quick answers (good); low engagement + low satisfaction = users giving up (bad).
- Set a **regular review cadence**: weekly for new agents, bi-weekly for mature agents.

**Challenge — apply to a Sempra workflow**

- What satisfaction score would indicate success for the SDG&E IT Operations Agent? (Hint: benchmark against helpdesk CSAT.)
- How often will you review analytics, given your conversation volume?
- What three metrics would you put on a one-page exec dashboard for SDG&E IT leadership?

---

# 🧪 Use Case #2 — Create and Configure Evaluation Test Sets

> 🎯 **Objective:** Create evaluation test sets four different ways and understand which approach to use when.

### Scenario

You want to systematically test your SDG&E IT Operations Agent. You'll create **three** distinct test sets — one auto-generated, one imported from CSV that's intentionally designed to **fail** (so you can see how the platform reports refusals), and one captured from real agent conversations that should **pass**. Together they form a complete picture of how different creation methods and outcomes work.

> 💡 **Note — preview feature.** Agent evaluation is currently a **preview** feature. UI and capabilities may change. Don't rely on it as your only quality gate for a production Sempra agent — pair with manual review.

### Step 1 — Generate test cases (Quick question set)

1. In your **SDG&E IT Operations Agent**, select **Evaluation** in the top navigation bar.

> 💡 If you don't see **Evaluation**, the feature may need to be enabled in your environment settings or may not yet be available in your region. See the [Agent Evaluation overview](https://learn.microsoft.com/microsoft-copilot-studio/analytics-agent-evaluation-overview).

2. Select **Create a test set** to open the **New evaluation** page. Confirm **Single response** is selected under **Data type**, then choose **Quick question set** under **More ways to start** to generate ~10 test cases automatically. Copilot Studio uses AI to generate test cases based on your agent's knowledge sources and configuration.
3. In the **Configure test set** panel on the right, change the test set name to:
   ```text
   Sempra IT Ops — Non-Critical Set
   ```
4. In the **Test method** section, **General quality** is configured by default. Leave it for this set.

> 💡 **Tip:** A test set can have multiple test methods, but **all test cases in the set must follow all of the configured methods.** Choose methods that match the *overall* nature of the test set. **General quality** works well as a baseline; **Compare meaning** can be added when you're providing exact expected responses.

5. Select **Save** at the bottom of the panel.
6. Still in the panel, scroll to **User profile** and select **Manage**.
7. In the user-profile management surface that opens, select **your user account**, confirm, and return to the **Configure test set** panel.
8. Select **Evaluate** to start the run.

> 💡 **Note:** Evaluation time depends on the number of test cases and agent response time. ~10 cases typically completes in **3–5 minutes**.

9. After the run finishes, review the overall result and select the evaluation row to drill into per-question detail.
10. Review the list of questions to see which (if any) failed.
11. Select a failed row to see *why* it failed.
12. Select a passing row too — the agent response and the LLM-judged reasoning are both worth reading.
13. When done, select **Evaluation** in the agent's top nav to return to the test-set list.

### Step 2 — Import test cases (CSV — adversarial "Always Fail" set)

1. Select **Create a test set** to open the **New evaluation** page.
2. In the **Start by uploading some questions** section, select **CSV** to download the empty template.
3. Open the template and review the required columns:
   - **`question`** — the user question the agent will answer
   - **`expectedResponse`** — used for **Match**, **Similarity**, and **Compare meaning** test methods

> 💡 **Note:** Test methods are *not* included in the CSV template. You configure methods after import. Initially the default method is applied. Limits: **100 questions per file**, **500 characters per question**, including spaces.

4. Download the lab's adversarial CSV file from this repo: [`assets/EvaluationAlwaysFail.csv`](./assets/EvaluationAlwaysFail.csv). It contains **10 Sempra adversarial test cases** designed to verify the agent properly refuses harmful, off-policy, or PII-exfiltration requests (phishing emails to SDG&E customers, bypassing Energy Support App login, disabling SCADA alarms, dumping bulk PII, jailbreak attempts, etc.). Import it into the new test set.

> 💡 **Tip:** CSV import is the right choice when you have a large number of test cases or you maintain test cases in a spreadsheet (e.g., owned by your Compliance team for ongoing regulatory test coverage).

5. Change the test set name to:
   ```text
   Sempra IT Ops — Adversarial / Always Fail Set
   ```
6. Select **Save**.
7. Select **Evaluate** to run. These adversarial cases use the **General quality** method to assess how the agent handles harmful requests. A "pass" on this set means **the agent appropriately refused or redirected** — not that it answered the harmful question.

### Step 3 — Capture test cases from the test canvas ("Always Pass" set)

1. Select the **Test** icon in the upper-right of the agent designer to open the test panel.
2. Send the following message:
   ```text
   I want to get notified of the latest IT bulletins and field-ops alerts.
   ```
3. The agent should walk you through whatever notification / mailing-list flow exists. Provide your **lab account email** when prompted (e.g., `user@yourlabdomain.com`).

> 💡 **Note — privacy:** Use your **lab account email** rather than a personal email. Lab environment content is cleared 2 weeks after the event ends.

4. Provide your first name and last name when prompted.
5. Now send the following questions one at a time, waiting for a response between each:
   ```text
   How do I connect to the SDG&E corporate VPN from a remote substation?
   ```
   ```text
   What does NERC CIP require for remote interactive access to BES Cyber Systems?
   ```
   ```text
   I forgot my Energy Support App password — how do I reset it?
   ```
   ```text
   Where can I find the latest Field Operations Remote Access Guide?
   ```
6. Select **Evaluate** at the top of the test panel. This jumps directly to the new evaluation set view, with your test-canvas conversation captured automatically as the seed.

> 💡 **Note:** Earlier versions of the upstream lab had additional intermediate steps (*"Select New evaluation"* then *"In More ways to start, select Use your test chat conversation"*) that no longer apply in the current Copilot Studio UI.

7. Change the test set name to:
   ```text
   Sempra IT Ops — Always Pass Set
   ```

> 💡 **Note:** Since the expected responses were captured directly from the agent's own answers, this set should pass when re-evaluated — the agent should give the same (or very similar) answers when asked again. If it doesn't, you've discovered a *non-deterministic* response where you may want to tighten the agent's instructions.

### Step 4 — Add a manual test case

1. Select **+ Add Question** → **Write**.
2. Enter:
   ```text
   Where can I set DLP policies for Copilot Studio agents in our Sempra environment?
   ```
3. Select **Apply**, then **Save** to save the set.
4. Select **Evaluate** to run the evaluation on the updated set.

> 💡 **Note:** Only **one test set can run at a time**. If a previous set is still running, wait for it to complete or move on to Use Case #3 and come back.

> ⚠️ **Important — key limits:** Each test set supports up to **100 test cases**. Questions can be up to **1,000 characters**. Evaluation results are retained for **89 days** — export anything you need for long-term reporting.

### ✅ You've completed Use Case #2

**Key takeaways**

- 🛠️ **Four creation methods, four use cases.** **Auto-generation** for quick baseline coverage; **CSV import** for bulk-managed regulatory or adversarial sets; **test-canvas capture** for real-conversation regression sets; **manual entry** for targeted edge cases.
- 🎯 **Test methods matter.** Factual questions need **Exact** or **Keyword Match**. Open-ended questions benefit from **General Quality** or **Similarity** or **Compare meaning**.
- 🧪 **Test set strategy.** Build sets that are *intentionally* designed to pass or fail — it teaches you how the platform scores answers before you trust it on real quality measurement.

**Troubleshooting**

- Start with auto-generated test cases for baseline coverage; then add manual cases for the scenarios that matter most to Sempra (NERC CIP compliance, after-hours outage triage, etc.).
- Use the test-canvas approach to **capture real conversations** — the agent's own responses make reliable expected answers.
- **Review auto-generated cases** before relying on them. They may include irrelevant or poorly worded questions that don't reflect real Sempra users.

**Challenge — apply to a Sempra workflow**

- What are the **10 most important questions** the SDG&E IT Operations Agent must answer correctly? (These become your *Always Pass* regression set.)
- Which method would you use for ongoing regression testing as the agent changes weekly?
- How would you organize test sets across SDG&E, SoCalGas, and Sempra Infrastructure if they share a tenant but have different policies?

---

# 🧪 Use Case #3 — Review Evaluation Results

> 🎯 **Objective:** Interpret evaluation outcomes, compare runs, and turn the results into measurable agent improvements.

### Scenario

You created and ran three test sets in Use Case #2. Now read the results — pass rates, individual reasoning, activity maps, and run-over-run comparisons — and turn them into a backlog of concrete improvements for the SDG&E IT Operations Agent.

### Step 1 — Review the auto-generated test set results

1. Go to the **Evaluation** page in your **SDG&E IT Operations Agent**.
2. Select the **Sempra IT Ops — Non-Critical Set** to open its results.
3. Review the **pass rate** (e.g., *"7/10 passed — 70%"*).
4. Select an individual test case to view detail:
   - **Question** — the original test question
   - **Actual response** — what the agent actually said
   - **Result** — pass or fail
5. For any **failed** cases, review the **activity map** — the step-by-step conversation flow showing the agent's decision path, including which knowledge sources, tools, and topics were used.

> 💡 **Tip:** The **activity map** is your debugger. It shows exactly which knowledge sources, tools, and topics the agent used — or *failed to use* — when generating its response. If the agent missed a NERC CIP question because it never searched the NERC source, the map shows that immediately.

### Step 2 — Review the "Always Fail" / Adversarial set results

1. Select the **Sempra IT Ops — Adversarial / Always Fail Set**.
2. Review the test-case results. These adversarial questions test whether your agent properly **refuses harmful or off-policy requests** using the **General quality** method.
3. Select a test case and review:
   - The **actual response** (how the agent handled the adversarial question)
   - The **reasoning** explaining why the evaluation determined pass or fail
   - Whether the agent appropriately **declined**, **redirected**, or — concerningly — **complied**

> 💡 **Note — what "pass" means here:** A pass on the adversarial set means *"the agent appropriately refused or redirected,"* not *"the agent answered the harmful question."* If the agent **complied** with any of the adversarial cases (drafted a phishing email, gave bypass instructions, leaked PII), treat that as a **P0 issue** — tighten the agent's instructions immediately and re-run.

### Step 3 — Review the "Always Pass" set results

1. Select **Sempra IT Ops — Always Pass Set**.
2. Review the pass rate. Since expected responses came from the agent's own answers, most cases should pass.
3. Check the first test case (the mailing-list flow). Verify the evaluation passed.
4. Check the **DLP policies** test case you added manually. Did the agent answer? What was the result?

> 💡 **Tip:** If the **DLP test case failed**, that's a **knowledge gap** — the agent doesn't have the Sempra DLP policy in its knowledge sources. This is exactly how evaluations help you discover where to expand knowledge or improve instructions. Add the gap to the backlog you started in Use Case #1, Step 7.

### Step 4 — Filter and compare results

1. Use the **filter** options to focus on a subset:
   - **All** — every test case
   - **Pass** — only passing cases
   - **Fail** — only failing cases
2. Filter to **Fail** across all your test sets to quickly assemble the list of where the agent needs improvement.
3. If you have multiple runs of the **same** test set, use the **Compare with** dropdown to compare two runs side-by-side:
   - 🟢 **Green arrows** — improvements (failed before, pass now)
   - 🔴 **Red arrows** — regressions (passed before, fail now)
   - ⚪ **No change** — consistent results

> 💡 **Tip:** The **comparison feature is the single most powerful aspect of Agent Evaluation**. It turns *"I think this change helped"* into *"this change moved 4 cases from fail to pass with no regressions."* That's the difference between guesswork and engineering.

### Step 5 — Provide feedback and export results

1. For an individual test case, use the 👍 / 👎 buttons to indicate whether the evaluation's pass/fail determination was correct:
   - 👍 The evaluation correctly assessed the response
   - 👎 The evaluation got it wrong (false positive or false negative)
2. Select **Export test results** to download as CSV for stakeholder reporting or compliance documentation.

> 💡 **Tip:** Exported results are valuable for **stakeholder reporting** (SDG&E IT leadership, Sempra Cybersecurity), **compliance documentation** (NERC CIP audit trail), and **trend tracking over time**. Export after every major agent update and store alongside your change log.

### ✅ You've completed Use Case #3

**Test your understanding**

- Why is creating an *Always Fail / Adversarial* test set a useful exercise?
- How does the activity map help you debug a failed case in the SDG&E IT Operations Agent?
- What does it mean when a test in the *Always Pass* set unexpectedly fails?

**Challenge — apply to a Sempra workflow**

- What **pass rate** would you set as a quality gate before deploying agent updates to production?
- How would you integrate evaluation runs into your agent **change-management** workflow? (Hint: ALM pipelines.)
- What stakeholders inside Sempra would benefit from seeing exported results — IT leadership, Compliance, the data-governance team, the helpdesk manager?

---

# 🧠 Summary of learnings

You've put together the two pillars of an agent quality practice:

- **Analytics** tells you **where** to improve — volume, satisfaction, knowledge-source usage, escalation, abandonment.
- **Evaluations** tells you **whether** your improvements actually worked — repeatable, objective, comparable across runs.

### 🪙 Analytics & evaluation golden rules for Sempra

1. **Review analytics weekly for new agents, bi-weekly for mature agents.** Set a calendar reminder — drift happens silently.
2. **Prioritize improvements by volume × satisfaction-impact.** A 50% satisfaction score on a topic that's asked 1,000 times beats 90% on a topic that's asked twice.
3. **Track unrecognized phrases and unanswered questions.** They are *direct signals* of knowledge gaps. Add them to your backlog.
4. **Build evaluation test sets covering your agent's most critical capabilities.** A healthy Sempra agent typically has multiple sets running:
   - **Always Pass** — verifies core functionality (the questions field crews ask every day)
   - **Adversarial / Always Fail** — validates safety and policy guardrails (refusals, PII protection, NERC CIP boundaries)
   - **Non-Critical / General Quality** — tracks general quality drift over time
   - **Compliance / Regulatory** — owned by your Compliance team for NERC CIP and other regulatory questions
5. **Run evaluations before *and* after every significant change.** No exceptions.
6. **Make one improvement at a time.** Cleanly attribute results.
7. **Export and share evaluation results with stakeholders.** Demonstrates the team's commitment to quality and creates an audit trail for regulators.
8. **Use the comparison feature** to ensure improvements don't cause regressions elsewhere — this is what separates a hobby project from a production practice.

> 🔁 **The closed loop:** Analytics finds the problem → evaluations verifies the fix → analytics confirms the impact in real conversations. That's how an agent gets better month after month at Sempra — not by hoping, but by measuring.

---

*Adapted for the Sempra family of companies from the upstream [Microsoft Copilot Agents Labs — Monitor Performance and Evaluate Agent Quality](https://microsoft.github.io/mcs-labs/labs/core-concepts-analytics-evaluations/) lab. Source content © Microsoft.*
