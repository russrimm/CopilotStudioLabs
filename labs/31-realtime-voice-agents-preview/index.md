# Lab 31: Real-time Voice Agents (Preview)

*Prototype preview real-time voice experiences in Copilot Studio and validate operational readiness risks.*

| | |
|---|---|
| ⭐ **DIFFICULTY** | Advanced (300) |
| ⏱️ **TIME** | 75 minutes |
| 🧩 **PRODUCTS** | Microsoft Copilot Studio, Dynamics 365 Contact Center |
| 🏷️ **TAGS** | Real-time Voice, Preview, Contact Center |
| 🏭 **INDUSTRIES** | Cross-industry |

---

## Overview

This lab focuses on **real-time voice agents (preview)** in Copilot Studio. You will build a preview voice experience, tune turn-taking behavior, test call-flow reliability, and document operational caveats before any broader rollout.

## Learning Objectives

1. Configure a preview real-time voice agent scenario.
2. Tune speech and interruption behavior for caller clarity.
3. Validate preview call-flow quality in test conditions.
4. Handle preview limitations with explicit fallback paths.
5. Create readiness criteria for pilot expansion.

## Prerequisites

- Access to a preview-enabled Copilot Studio environment.
- Contact center test setup for voice scenarios.
- A defined pilot call scenario and script set.
- Stakeholder alignment on preview risk tolerance.

## Step-by-Step

### Step 1 - Define preview pilot boundaries

1. Select one high-value call scenario for pilot scope.
2. Define in-scope and out-of-scope caller intents.
3. Set quality targets for response timing and clarity.
4. Define fallback to chat or human handoff.
5. Document preview rollback criteria.

### Step 2 - Configure the preview voice agent

1. Create or duplicate a test agent for preview use.
2. Enable preview voice features available in your tenant.
3. Configure greeting and intent-capture prompts.
4. Add short, voice-friendly response instructions.
5. Save and prepare test-call scripts.

### Step 3 - Tune turn-taking and interruption handling

1. Run initial voice tests with baseline settings.
2. Adjust interruption and silence handling settings.
3. Re-test caller prompts with natural pauses.
4. Capture issues such as overlap or delayed response.
5. Apply tuning changes and retest.

### Step 4 - Validate reliability and fallbacks

1. Test at least eight preview call scenarios.
2. Verify fallback behavior for unsupported intents.
3. Confirm escalation path reaches human support safely.
4. Review transcript quality where available.
5. Document defects and mitigation actions.

### Step 5 - Publish preview operations notes

1. Document known preview limitations.
2. Define support boundaries for pilot users.
3. Set monitoring checks for pilot health.
4. Define criteria to continue, pause, or expand.
5. Share readiness notes with contact center leadership.

## Validation / Success Criteria

- Preview voice scenario is configured and testable.
- Turn-taking and interruption behavior is tuned.
- Fallback and escalation behavior is validated.
- Preview limitations and guardrails are documented.

## Lab Complete

You completed a practical **real-time voice agents (preview)** pilot setup with explicit risk controls.

> 🔗 **Related scenario lab:** [Lab 30: Build Real-Time Voice Agents for Telephony and Contact Center](../30-realtime-voice-agents/index.md) — the end-to-end telephony/contact-center voice scenario.

Suggested next labs:

- [Lab 30: Build Real-Time Voice Agents for Telephony and Contact Center](../30-realtime-voice-agents/index.md)
- [Lab 39: Agent Readiness / Issue Status](../39-agent-readiness-issue-status/index.md)
