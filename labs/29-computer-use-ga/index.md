# Lab 29: Computer Use (GA)

*Build and validate generally available computer-use automations for repetitive desktop workflows.*

| | |
|---|---|
| ⭐ **DIFFICULTY** | Advanced (300) |
| ⏱️ **TIME** | 90 minutes |
| 🧩 **PRODUCTS** | Microsoft Copilot Studio |
| 🏷️ **TAGS** | Computer Use, UI Automation, Governance |
| 🏭 **INDUSTRIES** | Cross-industry |

---

## Overview

This lab focuses on **computer use (GA)** for practical desktop task automation in Copilot Studio scenarios. You will choose a repetitive process, define deterministic checkpoints, configure execution behavior, and validate reliability at scale.

## Learning Objectives

1. Identify high-value candidate workflows for computer use.
2. Configure a stable automation path with robust checkpoints.
3. Handle common UI variance and interruption scenarios.
4. Validate reliability with repeated runs.
5. Establish governance controls for safe operation.

## Prerequisites

- Access to Copilot Studio with computer-use capabilities.
- A test environment containing the target desktop workflow.
- A known process with repeatable inputs and expected outputs.
- Permission to execute and monitor automation runs.

## Step-by-Step

### Step 1 - Select and scope the workflow

1. Choose one repetitive workflow with clear success output.
2. List the UI steps required from start to finish.
3. Define where human review is required.
4. Identify known unstable screens or prompts.
5. Record baseline completion time for manual execution.

### Step 2 - Configure the automation sequence

1. Build the computer-use sequence in Copilot Studio.
2. Add checkpoints after each critical action.
3. Use explicit selectors or stable cues where possible.
4. Add timeout and retry behavior for slow screens.
5. Save and label this as your baseline automation.

### Step 3 - Handle interruptions and UI drift

1. Test the automation with minor UI differences.
2. Add fallback steps for optional dialogs.
3. Add validation checks before final submit actions.
4. Capture failure signatures and likely causes.
5. Update sequence logic to reduce brittle behavior.

### Step 4 - Run reliability tests

1. Execute at least ten consecutive test runs.
2. Track success rate, retries, and average duration.
3. Compare automation time versus manual baseline.
4. Review failed runs and classify root causes.
5. Re-run after fixes to confirm improvement.

### Step 5 - Apply governance and rollout controls

1. Define who can execute the automation in production.
2. Add audit and run-log review expectations.
3. Document safe rollback and disable procedures.
4. Set thresholds that trigger human intervention.
5. Publish operating guidance for support teams.

## Validation / Success Criteria

- Workflow success rate meets your defined threshold.
- Recovery behavior exists for at least two interruption types.
- Run logs support troubleshooting and audit needs.
- Governance controls are documented before wider rollout.

## Lab Complete

You built a production-oriented **computer use (GA)** pattern with measurable reliability and governance.

> 🔗 **Related scenario lab:** [Lab 28: Build a Computer-Using Agent for Desktop Automation](../28-computer-use-agents/index.md) — the end-to-end desktop-automation scenario this GA feature fits into.

Suggested next labs:

- [Lab 28: Build a Computer-Using Agent for Desktop Automation](../28-computer-use-agents/index.md)
- [Lab 39: Agent Readiness / Issue Status](../39-agent-readiness-issue-status/index.md)
