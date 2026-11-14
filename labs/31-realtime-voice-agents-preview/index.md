# Lab 31: Real-time Voice Agents (Preview)

*Prototype preview real-time voice experiences in Copilot Studio and validate operational readiness risks.*

| Field | Details |
|---|---|
| ⭐ **DIFFICULTY** | Advanced (300) |
| ⏱️ **TIME** | 75 minutes |
| 🧩 **PRODUCTS** | Microsoft Copilot Studio, Dynamics 365 Contact Center |
| 🏷️ **TAGS** | Real-time Voice, Preview, Contact Center |
| 🏭 **INDUSTRIES** | Cross-industry |

---

## Overview

This lab focuses on the **preview capabilities of real-time voice agents** in Copilot Studio. While core real-time voice telephony on the **standard harness** with **Dynamics 365 Contact Center** and **GPT-Realtime** (North America) is generally available (covered in [Lab 30](../30-realtime-voice-agents/index.md)), Microsoft Learn documents several capabilities that remain in **preview** (see [Real-time voice agents overview](https://learn.microsoft.com/microsoft-copilot-studio/voice-realtime-voice-agents) and [Test your real-time voice agent](https://learn.microsoft.com/microsoft-copilot-studio/voice-realtime-test)):

- **Digital messaging channels (preview)** on real-time agents alongside the Voice channel.
- **Preview voice models:** **GPT-Realtime-Mini (preview)** (hosted in Australia) and **GPT-5-Chat (preview)** (a Text LLM voice model paired with **Microsoft Neural TTS** and custom voice models, supporting in-region data processing in the US, EU, UK, and Australia).
- **In-Studio voice testing:** the **Speech & DTMF (preview)** mode in the Copilot Studio test panel.

You will configure a pilot using these preview capabilities, tune turn-taking and barge-in behavior, validate known platform constraints, and document operational guardrails before broader rollout.

## Learning Objectives

1. Distinguish generally available real-time voice capabilities from preview voice models, digital messaging channels, and test tools.
2. Configure a real-time agent on the standard harness using preview model or channel options.
3. Tune speech, silence detection, and caller interruption (barge-in) behavior in the Speech & DTMF test panel.
4. Design explicit fallbacks around documented preview constraints (authentication, 60-minute session cap, analytics, and transcript limits).
5. Publish an operations readiness package for contact center stakeholders.

## Prerequisites

- Access to Copilot Studio in a supported region (**US**, **EU**, **UK**, or **Australia**, matching your selected voice model) on the **standard harness**.
- **Dynamics 365 Contact Center** voice or digital messaging test workstream prerequisites.
- Agent security set to **No authentication** when testing digital messaging channels (preview) or browser microphone testing.
- Stakeholder alignment on preview service terms and regional data residency.

## Step-by-Step

### Step 1 - Define pilot boundaries and model fit

1. Select one bounded contact-center call or digital messaging scenario for pilot scope.
2. Match the voice model to your environment geography and voice branding requirements:
   - `GPT-Realtime` (GA, North America speech-to-speech).
   - `GPT-Realtime-Mini` (Australia speech-to-speech).
   - `GPT-5-Chat` (US, EU, UK, and Australia Text LLM with Microsoft Neural TTS or custom voice models).
3. Account for documented platform constraints up front:
   - Digital messaging channels on real-time agents require **No authentication** (Microsoft Entra ID and OAuth user sign-in are not yet supported on digital messaging for real-time agents).
   - Conversations have a **60-minute maximum duration**, after which the session automatically escalates to a human representative.
4. Define explicit human-handoff triggers and rollback criteria.

### Step 2 - Configure the real-time agent

1. Create or duplicate a standard-harness test agent for your contact-center pilot.
2. Enable real-time voice configuration and select the voice model appropriate for your environment region.
3. Confirm authentication is set to **No authentication** if your pilot includes browser microphone testing or digital messaging channels.
4. Author short, spoken-first greeting and intent-capture instructions that avoid long lists or visual formatting.
5. Save your configuration and prepare at least eight spoken test scripts.

### Step 3 - Tune turn-taking and interruption handling

1. Open the Copilot Studio test pane, switch to **Speech & DTMF**, and run baseline spoken tests.
2. Adjust voice activity detection, silence thresholds, and caller barge-in settings so natural pauses do not cut callers off prematurely.
3. Re-test caller prompts with background hesitation, mid-sentence corrections, and keypad (DTMF) inputs.
4. If evaluating `GPT-5-Chat` with Neural TTS, compare spoken pacing and pronunciation against speech-to-speech behavior.
5. Save tuning adjustments and re-verify your baseline scripts.

### Step 4 - Validate reliability, handoff, and logging boundaries

1. Execute all eight test call scenarios, including out-of-scope requests and noisy caller phrasing.
2. Confirm [hold and resume](https://learn.microsoft.com/microsoft-copilot-studio/voice-hold-resume) and [post-call action topics](https://learn.microsoft.com/microsoft-copilot-studio/voice-post-call-actions) behave predictably when callers pause or hang up.
3. Verify that human representative escalation triggers cleanly well before the 60-minute conversation ceiling and whenever authentication-gated account changes are requested.
4. Check telemetry and transcripts: built-in Copilot Studio analytics reports are incomplete for real-time agents, and conversation transcripts are not logged for Text LLM (`GPT-5-Chat`) voice agents—plan Dynamics 365 Contact Center or external telemetry accordingly.
5. Record defects, latency observations, and mitigations.

### Step 5 - Publish operations readiness notes

1. Document which components in your pilot are generally available versus preview, along with regional model hosting.
2. Define support boundaries so contact-center supervisors know how to handle unauthenticated digital messaging and human escalations.
3. Estimate voice capacity at the documented real-time speech rate (see [Lab 37](../37-usage-estimator-copilot-credits/index.md) and [Copilot Credits billing rates](https://learn.microsoft.com/microsoft-copilot-studio/requirements-messages-management)).
4. Define objective go/no-go criteria to continue, pause, or expand the pilot.
5. Review the readiness package with contact center, compliance, and telephony leads.

## References

- [Real-time voice agents overview](https://learn.microsoft.com/microsoft-copilot-studio/voice-realtime-voice-agents)
- [Test your real-time voice agent](https://learn.microsoft.com/microsoft-copilot-studio/voice-realtime-test)
- [Use Hold and resume](https://learn.microsoft.com/microsoft-copilot-studio/voice-hold-resume)
- [Configure post-call action topics](https://learn.microsoft.com/microsoft-copilot-studio/voice-post-call-actions)
- [Consent-based recording](https://learn.microsoft.com/microsoft-copilot-studio/voice-consent-based-record)

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
