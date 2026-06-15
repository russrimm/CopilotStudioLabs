# 🎙️ Lab 10: Build Real-Time Voice Agents for Telephony and Contact Center

*Design a natural, compliant voice experience for utility callers who need fast help during high-stress moments.*

| | |
|---|---|
| ⭐ **DIFFICULTY** | Advanced (Level 300) |
| ⏱️ **TIME** | 2 hours |
| 🧩 **PRODUCTS** | Microsoft Copilot Studio, Dynamics 365 Contact Center, Voice Channel |
| 🏷️ **TAGS** | Voice Agents, Telephony, NLU, Multilingual, Speech, Contact Center |
| 🏭 **INDUSTRIES** | Energy / Utilities |

---

## Overview

During storms, outages, and billing spikes, customers often need immediate voice support. Traditional IVR trees frustrate callers when the situation is urgent or emotionally charged. Real-time voice agents offer a more natural experience: callers speak normally, the agent responds in real time, and the conversation can still follow deterministic business rules when compliance matters.
In this lab, you will build a **real-time voice agent** in **Microsoft Copilot Studio** for an energy-and-utilities contact center scenario. The agent will handle outage and billing-style calls, support tuning for natural turn-taking, allow hold and resume, trigger post-call actions, and request consent before recording.
You will also use the built-in voice test panel so you can evaluate the experience before assigning a phone number.

---

## 🏗️ What you'll build

| Layer | What you will build |
|---|---|
| **Voice agent** | **Utility Contact Center Voice Agent** for outage and billing scenarios |
| **Speech tuning** | Sensitivity, silence handling, and voice selection appropriate for stressed callers |
| **Conversation controls** | Hold and resume plus barge-in-friendly test validation |
| **Post-call automation** | End-of-conversation triggers for logging or backend updates |
| **Compliance controls** | Consent-based recording and telephony authentication posture |
| **Deployment** | A publish path from test panel to telephony channel |

### Architecture summary

```text
Caller
  -> Dynamics 365 Contact Center telephony
      -> Copilot Studio real-time voice agent
          -> Topics / voice settings / hold-resume
          -> Optional backend actions and post-call topic
          -> Consent-aware recording and compliance controls
```

> 💡 **Tip:** Voice agents must sound natural, but they also have to be operationally safe and compliant—especially in outage and billing scenarios.

---

## Objectives

1. Create a real-time voice agent with speech-enabled conversational design.
2. Tune voice settings for responsiveness, caller interruption, and clarity.
3. Use the built-in voice test panel to evaluate the experience before telephony rollout.
4. Configure hold and resume, post-call actions, and consent-based recording.
5. Publish the voice agent to telephony with an enterprise-ready deployment checklist.

---

## 🧠 Core concepts

| Concept | What it means in this lab |
|---|---|
| **Real-time voice** | A voice-first agent experience with natural turn-taking and low-latency spoken responses. |
| **Voice test panel** | A browser-based test experience that lets makers speak with the agent before a phone deployment. |
| **Barge-in** | The caller's ability to interrupt the agent naturally during playback. |
| **Hold and resume** | A topic-level or agent-level capability that pauses the conversation while the caller retrieves information. |
| **Post-call action topic** | A topic triggered by **End of conversation** so backend updates happen after the call ends. |
| **Consent-based recording** | An approach where callers explicitly approve recording and transcription before it begins. |
| **Regional limitation** | As of June 2026, real-time voice uses models hosted in North America or Australia, with cross-geo implications. |

---

## 📚 Documentation

- [Real-time voice agents overview](https://learn.microsoft.com/en-us/microsoft-copilot-studio/voice-realtime-voice-agents)
- [Test your real-time voice agent](https://learn.microsoft.com/en-us/microsoft-copilot-studio/voice-realtime-test)
- [Use Hold and resume](https://learn.microsoft.com/en-us/microsoft-copilot-studio/voice-hold-resume)
- [Configure post-call action topics](https://learn.microsoft.com/en-us/microsoft-copilot-studio/voice-post-call-actions)
- [Consent-based recording](https://learn.microsoft.com/en-us/microsoft-copilot-studio/voice-consent-based-record)

---

## Prerequisites

- Access to **Copilot Studio** with permission to create voice-enabled agents.
- A **Dynamics 365 Contact Center** environment with voice channel and call routing prerequisites in place.
- The right roles, such as Omnichannel administrator and Copilot Studio maker access, as described in Microsoft Learn.
- A lab tenant or test workstream where **No authentication** can be used for testing in the browser voice panel.
- Awareness of the regional limitation noted in Microsoft Learn: real-time voice processing uses supported hosted model geographies.

> ⚠️ **Warning:** Microsoft Learn notes that EU Data Boundary customers currently cannot use real-time voice because of cross-geo processing restrictions. Confirm regional and compliance fit before promising the feature.

---

## 🗺️ Use cases covered

| # | Section | Time | Required |
|---|---|---|---|
| 1 | Create a voice-enabled agent | 20 min | ✅ |
| 2 | Configure voice tuning | 15 min | ✅ |
| 3 | Test your voice agent | 15 min | ✅ |
| 4 | Add hold and resume | 15 min | ✅ |
| 5 | Configure post-call actions | 15 min | ✅ |
| 6 | Configure consent-based recording | 15 min | ✅ |
| 7 | Publish to telephony | 25 min | ✅ |

> 💡 **Tip:** Draft prompts and messages for the ear, not the eye. Spoken instructions should be shorter and more forgiving than chat responses.

---

# 🧪 Use Case #1 — Create a voice-enabled agent (20 min)

> 🎯 **Objective:** Set up a real-time voice agent with NLU and speech recognition for a utility call scenario.

### Scenario

You are building a voice experience for callers who need outage status, service-restoration updates, or billing guidance without navigating a rigid keypad tree.

### Step 1 — Create the base agent

1. Open Copilot Studio and create a new agent named **Utility Contact Center Voice Agent**.
2. Write instructions that describe the agent as a calm, concise, utility contact-center assistant for outage, billing, and service inquiries.
3. Tell the agent to confirm critical details such as service address, account number, or callback number when needed.
4. Keep the tone empathetic because outage and billing calls often happen under stress.
5. Save the agent and make sure it is available for channel and voice configuration.
6. Write down the first three call scenarios you want the voice experience to handle.


#### Sample prompt for this step

```text
You are a real-time voice assistant for Contoso Energy customer support. Speak clearly, keep sentences short, and confirm important details when needed. Help callers with outage status, restoration expectations, billing questions, and next steps. Be empathetic, concise, and action-oriented.
```

### Step 2 — Turn on real-time voice and telephony prerequisites

1. Open the agent's voice or channel configuration area and select **Real-time voice** where supported.
2. Confirm that the agent is intended for the Standard or Premium real-time voice tier so the browser test panel can be used later.
3. Review the prerequisites from Microsoft Learn, including Dynamics 365 Contact Center voice channel and required roles.
4. If you plan to use the browser microphone test, configure the agent's authentication to **No authentication** in the security settings for the lab environment.
5. Save the configuration and note any dependencies that still need contact-center admin action.
6. Confirm the telephony channel path is visible for later publication steps.


### Step 3 — Design the first spoken experience

1. Create or update the greeting so it sounds natural when spoken aloud.
2. Avoid long multi-clause sentences that work in text but sound exhausting on a call.
3. Add one or two initial routing questions that help the caller state their intent naturally, such as outage help, billing help, or service update.
4. Keep each prompt short enough that the caller does not forget the beginning before the sentence ends.
5. Save the topic or greeting changes and prepare for voice-specific tuning next.
6. Read the greeting aloud yourself; if it sounds awkward to a human, rewrite it before testing.


#### Quick verification

- The agent is configured for real-time voice.
- Testing prerequisites for the browser voice panel are satisfied.
- The greeting is short and voice-friendly.

### Test prompts

Use these prompts in Copilot Studio test chat, the flow test pane, or the voice test panel as appropriate:

```text
I need help because my neighborhood still doesn't have power.
I have a billing question and want to know why my balance changed this month.
```

### Validation checklist

- A voice-enabled agent exists with appropriate instructions.
- The agent is prepared for real-time voice testing.
- The opening experience is optimized for spoken interaction.

### What you accomplished

| Outcome | Why it matters |
|---|---|
| Created a voice-first agent shell | You now have a foundation for a natural spoken contact-center experience. |
| Aligned prerequisites | Voice features depend on telephony and security setup, not just agent authoring. |
| Rewrote for speech | Voice-friendly language is shorter, clearer, and more empathetic than chat prose. |

### Key takeaways

- Voice design starts with conversation clarity, not just feature enablement.
- Short spoken prompts reduce caller friction.
- Real-time voice setup includes both platform and contact-center dependencies.

### Troubleshooting

- If voice options are unavailable, revisit licensing, regional support, and contact-center prerequisites.
- If the greeting sounds robotic, simplify the wording before chasing other settings.

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

You now have the foundation to move from **a generic text agent** to **a voice-ready contact-center agent**.

---

# 🧪 Use Case #2 — Configure voice tuning (15 min)

> 🎯 **Objective:** Adjust speech sensitivity, silence detection, and voice selection for a natural calling experience.

### Scenario

Outage callers may speak quickly, interrupt the agent, or pause while looking up an account number. Voice tuning helps the agent feel patient rather than brittle.

### Step 1 — Review conversational-skill settings

1. Open the voice settings area for the agent and review available conversational controls such as speech responsiveness, interruption handling, silence behavior, and voice style.
2. Document your starting defaults before making changes so you can compare later.
3. Think about the likely caller environment—kitchen noise, mobile phone, speakerphone, or stressed speech during an outage.
4. Decide which settings most affect caller comfort in your scenario.
5. Use one small tuning change at a time rather than changing every control simultaneously.
6. Save after each meaningful adjustment so you can roll back if needed.


### Step 2 — Tune for interruptions and pauses

1. Adjust settings related to silence detection or turn-taking so the agent does not speak over callers who pause briefly.
2. Consider how barge-in or interruption should behave when a caller starts speaking before the prompt ends.
3. If the experience feels too eager, increase patience slightly; if it feels sluggish, reduce unnecessary wait time.
4. Test an account-number collection prompt and see whether the agent gives the caller enough time to respond.
5. Record what changed and why so tuning can be justified later.
6. Keep the settings aligned to real caller behavior, not just quiet-lab conditions.


### Step 3 — Select the spoken persona

1. Choose a voice that matches the utility brand: clear, calm, and professional.
2. Listen to the greeting with the selected voice and note whether pronunciation is understandable for street names, district names, or utility acronyms.
3. If specific terms are spoken awkwardly, simplify or rewrite the prompt rather than assuming the caller will infer the meaning.
4. Test at least one bilingual or multilingual phrase if your scenario requires it.
5. Save the chosen voice settings with a short rationale.
6. Prepare to validate the changes in the live voice test panel next.


#### Quick verification

- Patience and interruption settings were tuned deliberately.
- The selected voice matches the business tone.
- Critical utility terms are pronounced acceptably.

### Test prompts

Use these prompts in Copilot Studio test chat, the flow test pane, or the voice test panel as appropriate:

```text
Wait, let me grab my account number.
Hold on—I'm still looking at the outage text message you sent.
```

### Validation checklist

- Speech timing settings were reviewed and tuned.
- The agent handles short pauses and interruptions more naturally.
- Voice selection fits the utility scenario.

### What you accomplished

| Outcome | Why it matters |
|---|---|
| Tuned the conversation rhythm | Small timing changes can dramatically improve caller comfort. |
| Selected an appropriate voice | Voice persona affects trust and clarity. |
| Prepared for realistic testing | You now have explicit hypotheses to validate in the test panel. |

### Key takeaways

- Voice tuning should reflect real phone behavior, not quiet office assumptions.
- Prompt wording and voice selection work together.
- A patient agent often feels smarter than a fast but interruptive one.

### Troubleshooting

- If the agent cuts callers off, increase patience or review interruption settings.
- If the voice sounds unclear on utility terms, shorten or rewrite the spoken prompts.

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

You now have the foundation to move from **default voice settings** to **a tuned spoken experience**.

---

# 🧪 Use Case #3 — Test your voice agent (15 min)

> 🎯 **Objective:** Use the built-in voice test panel to validate the experience with microphone input.

### Scenario

Before publishing to a real phone number, you want to hear the conversation, interrupt it, and verify how it behaves with actual speech.

### Step 1 — Start a voice test session

1. Open the agent in Copilot Studio and open the test panel.
2. Set **Chat mode** to **Speech & DTMF (Preview)** if it is currently in text mode.
3. Allow microphone access in the browser when prompted.
4. Confirm that the agent's authentication is set to **No authentication** for this lab scenario; otherwise microphone testing will not work.
5. Select **Start voice conversation** and wait for the connection to establish.
6. Listen to the greeting and note your immediate reaction before you say anything back.


### Step 2 — Validate turn-taking and barge-in

1. Respond naturally to the greeting and verify that your speech appears in the transcript.
2. While the agent is speaking, interrupt it intentionally once to test barge-in behavior.
3. Use a DTMF input if your scenario requires keypad capture for account or menu input.
4. Mute and unmute once so you understand the operator controls available in the test panel.
5. End the conversation and review the transcript for how the interaction was recorded.
6. Restart a fresh test session if you want to compare before/after tuning changes.

> ⚠️ **Warning:** Microsoft Learn notes that the browser test panel is not identical to a real phone call path. Hardware, network, and PSTN differences can affect voice behavior.

### Step 3 — Capture findings and decide what to adjust

1. Write down what sounded natural, what sounded awkward, and where callers might need more time.
2. If barge-in failed or felt inconsistent, note that this may differ on real telephony but still deserves follow-up tuning.
3. Decide whether to change wording, timing, or voice settings first.
4. Run one more test after your first adjustment so you can observe the impact immediately.
5. Store the findings in a small test log or scorecard.
6. Use the log later when you move from browser tests to phone-number pilots.


#### Quick verification

- Microphone test works.
- Transcript captures both sides of the conversation.
- At least one interruption / barge-in scenario was tested.

### Test prompts

Use these prompts in Copilot Studio test chat, the flow test pane, or the voice test panel as appropriate:

```text
My power has been out since 2 PM—what's the latest status?
I need time to find my account number.
```

### Validation checklist

- The voice test panel is usable in your environment.
- You validated greeting, turn-taking, and interruption behavior.
- You captured at least one improvement to make before telephony rollout.

### What you accomplished

| Outcome | Why it matters |
|---|---|
| Heard the real experience | Testing by voice reveals issues text preview cannot show. |
| Checked interruption behavior | Barge-in is a major part of natural voice UX. |
| Built a tuning backlog | You now know what to fix before broader rollout. |

### Key takeaways

- Voice quality must be heard, not just read.
- Browser tests are essential but not identical to live telephony.
- Transcript review helps connect subjective experience to specific prompts and settings.

### Troubleshooting

- If the microphone test fails, check authentication mode and browser permissions first.
- If speech feels unnatural, revise prompt wording before radically changing all timing settings.

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

You now have the foundation to move from **a tuned configuration** to **a tested spoken experience**.

---

# 🧪 Use Case #4 — Add hold and resume (15 min)

> 🎯 **Objective:** Configure pause and resume so callers can retrieve information without frustration.

### Scenario

A caller needs time to find an account number, outage text, or meter location. Instead of timing out or escalating prematurely, the agent should wait gracefully.

### Step 1 — Choose agent-level or topic-level hold behavior

1. Review the **Hold and resume** documentation and decide whether your pattern should be configured globally at the agent level or precisely at the topic/question level.
2. If many call types need the same pause behavior, use the agent-level setting.
3. If only certain data-collection steps need pause behavior, use topic-level configuration on the relevant question nodes.
4. Document which approach you chose and why.
5. Save the design note so future makers do not configure conflicting patterns.
6. Remember that the settings are mutually exclusive by scope in practice—pick one intentionally per scenario.


### Step 2 — Configure hold and resume phrases

1. If using agent-level settings, open **Voice** > **Conversational skills** > **Hold and resume**.
2. Define hold words such as 'hold on', 'wait', or 'one second'.
3. Define resume words such as 'I'm back', 'ready', or 'continue'.
4. Write a calm hold message and a resume confirmation message.
5. If your brand allows it, configure hold music or a short audio file URL.
6. Save the settings and prepare a scenario where the caller needs to pause.


#### Sample prompt for this step

```text
Hold message: Okay, I'll wait. When you're ready, just say "continue."
Resume response: Thanks, I'm ready whenever you are.
```

### Step 3 — Test the hold experience

1. In the voice test panel, reach a question where the caller might need time, such as requesting an account number.
2. Say one of the hold words and confirm the agent enters the hold behavior instead of escalating or repeating aggressively.
3. Wait briefly and then say a resume word.
4. Observe whether the agent resumes smoothly from the correct point in the conversation.
5. If the timing feels off, adjust the hold timeout or repeat count.
6. Document any wording changes needed to make the experience feel more human.


#### Quick verification

- Hold words trigger the pause behavior.
- Resume words bring the caller back into the flow.
- The caller returns to the correct conversation step.

### Test prompts

Use these prompts in Copilot Studio test chat, the flow test pane, or the voice test panel as appropriate:

```text
Hold on while I find my account number.
Okay, I'm back—continue.
```

### Validation checklist

- Hold and resume is configured intentionally.
- The voice test confirms that callers can pause and return naturally.
- Timing and wording are acceptable for the business scenario.

### What you accomplished

| Outcome | Why it matters |
|---|---|
| Added patience to the experience | Callers can now retrieve information without friction. |
| Configured reusable trigger phrases | The agent understands natural pause and resume language. |
| Validated a smoother self-service path | Fewer callers should need escalation just because they paused. |

### Key takeaways

- Hold and resume is especially valuable in account, outage, and verification scenarios.
- The wording of the hold message affects caller trust.
- Topic-level precision is useful when only certain questions need pause behavior.

### Troubleshooting

- If the caller gets stuck in hold, review resume phrases and timeout settings.
- If hold is triggering accidentally, narrow the hold-word list.

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

You now have the foundation to move from **a continuous but rigid call flow** to **a more flexible natural conversation**.

---

# 🧪 Use Case #5 — Configure post-call actions (15 min)

> 🎯 **Objective:** Set up automatic backend triggers after a call ends.

### Scenario

When a call ends, the utility may need to log the outcome, update a case, or trigger a follow-up workflow. Doing that reliably requires a dedicated post-call action pattern.

### Step 1 — Create a post-call topic

1. Create a new topic called **Post-call actions**.
2. Open the trigger settings and change the trigger to **An activity occurs**.
3. Set the activity type to **End of conversation**.
4. Decide whether the topic should run for all end reasons or only some, such as **CUSTOMER_HANGUP**.
5. If needed, add a condition on `Conversation.EndReason` so the topic runs only for the intended outcome.
6. Save the topic before adding actions.


### Step 2 — Add backend actions

1. Insert the backend steps your scenario needs, such as updating a CRM case, logging the end reason, or triggering a Power Automate flow.
2. Capture call end time and end reason if those details matter for operational analytics.
3. If the utility only wants post-call processing for customer hang-ups, keep the condition narrow.
4. Test at least one happy path and one alternate end reason if possible.
5. Document which systems are updated after the call so support teams can trace side effects.
6. Save and version the topic like any other production-impacting automation.


#### Sample prompt for this step

```text
Post-call action example:
- Trigger: End of conversation
- Condition: Conversation.EndReason = CUSTOMER_HANGUP
- Actions:
  - Update CRM case status
  - Log call end time
  - Trigger follow-up workflow
```

### Test prompts

Use these prompts in Copilot Studio test chat, the flow test pane, or the voice test panel as appropriate:

```text
Complete a short test call and hang up to confirm the post-call topic runs.
```

### Validation checklist

- A dedicated post-call topic exists.
- The trigger is **End of conversation**.
- The expected backend action runs only for the intended end condition.

### What you accomplished

| Outcome | Why it matters |
|---|---|
| Added deterministic end-of-call automation | Backend systems can now update at the right lifecycle moment. |
| Used end-reason conditions | You can control whether the action runs for hang-up, transfer, or escalation cases. |

### Key takeaways

- Post-call automation belongs in its own topic so it is explicit and testable.
- EndReason conditions prevent accidental backend updates.

### Troubleshooting

- If the topic never runs, verify the trigger type and end-of-conversation activity selection.
- If actions run too often, tighten the `Conversation.EndReason` condition.

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

You now have the foundation to move from **a voice call with no backend closure** to **a voice call with deterministic follow-up automation**.

---

# 🧪 Use Case #6 — Configure consent-based recording (15 min)

> 🎯 **Objective:** Add compliant recording with caller consent.

### Scenario

Customer calls can contain sensitive information. The utility wants explicit caller consent before recording or transcription begins.

### Step 1 — Review the authentication and telephony prerequisites

1. Open the **Consent-based recording** documentation and confirm the prerequisites such as provisioned voice channel and inbound calling setup.
2. Verify the agent uses the required telephony association pattern and note that the setup relies on a voice-enabled agent scenario.
3. Confirm the agent's **Authentication** is configured appropriately for the voice scenario, as described in Microsoft Learn.
4. Review any organizational legal or compliance guidance before editing the consent flow.
5. Identify the exact wording that your compliance team wants for recording consent if it differs from the sample topic.
6. Only then move on to topic edits.


### Step 2 — Wire the User Consent topic into the call start

1. Open the sample **User Consent** topic if it exists in your environment or create an equivalent topic.
2. Edit the language so it asks for explicit consent in a concise, clear way.
3. Open the **Conversation Start** topic and add a **Go to another topic** step that sends the call into **User Consent**.
4. Make sure the flow clearly handles both consent granted and consent declined outcomes.
5. Save the changes and review the call opening sequence end to end.
6. If your business requires multiple language variants, note that requirement for a later iteration.


#### Sample prompt for this step

```text
Before we continue, may I record and transcribe this call for quality, training, and service improvement purposes? Please say yes to continue with recording or no to continue without recording.
```

### Step 3 — Test both branches

1. Run one test where you grant consent and verify the call proceeds with the expected recording behavior.
2. Run a second test where you decline consent and verify the conversation continues without recording or transcription features enabled, according to policy.
3. Listen for tone and clarity—the consent request should sound professional rather than legalistic overload.
4. Document where the consent outcome is stored or surfaced if that matters for reporting.
5. Review with compliance or legal stakeholders if required.
6. Save a screenshot or transcript excerpt for the project evidence pack.


#### Quick verification

- Consent request happens early in the call.
- Both yes and no branches are handled.
- The language aligns to compliance expectations.

### Test prompts

Use these prompts in Copilot Studio test chat, the flow test pane, or the voice test panel as appropriate:

```text
Yes, you may record this call.
No, I do not consent to recording.
```

### Validation checklist

- The call now includes an explicit consent step.
- Both branches are tested and documented.
- The wording is ready for compliance review.

### What you accomplished

| Outcome | Why it matters |
|---|---|
| Added a compliance-focused opening path | The agent now respects caller choice before recording. |
| Integrated consent into the voice flow | Compliance is part of the experience, not a manual side process. |
| Tested both outcomes | You know the call remains usable regardless of the caller's choice. |

### Key takeaways

- Consent flows should be clear, short, and legally aligned.
- Recording choices must not break the rest of the voice experience.
- Compliance review belongs early in voice-agent design.

### Troubleshooting

- If consent never triggers, verify the Conversation Start topic routes into the consent path.
- If the call stops after a decline, fix the no-consent branch before going further.

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

You now have the foundation to move from **a voice flow without explicit recording control** to **a compliant consent-aware voice experience**.

---

# 🧪 Use Case #7 — Publish to telephony (25 min)

> 🎯 **Objective:** Deploy the voice agent to a phone number with a realistic rollout checklist.

### Scenario

The pilot has passed browser testing and design review. The final step is preparing a controlled telephony rollout for a real phone number or test workstream.

### Step 1 — Prepare the rollout checklist

1. List the required go-live checks: greeting reviewed, call routing verified, post-call actions tested, consent wording approved, and support contacts assigned.
2. Confirm that the contact-center admin has provisioned the telephony resources and inbound routing path.
3. Decide whether the first rollout is a limited internal number, a pilot workstream, or a broader customer-facing line.
4. Prepare fallback handling if the voice agent must hand off to a human queue.
5. Define a monitoring window for the first live calls, including who will listen for issues and where incidents will be logged.
6. Get explicit sign-off from business, operations, and compliance stakeholders before publishing broadly.


### Step 2 — Publish and connect telephony

1. Publish the latest agent changes in Copilot Studio.
2. Open the **Channels** page and configure or review the **Telephony** channel settings.
3. Connect the agent to Dynamics 365 Customer Service or the appropriate telephony workstream as required in your environment.
4. Associate the agent with the target phone number or test line.
5. Confirm routing and queue behavior for escalation or transfer scenarios.
6. Save the configuration and document the exact deployment target.


### Step 3 — Run a controlled live-call pilot

1. Place a small number of test calls from different phones or networks if possible.
2. Compare the live-call experience to the browser test panel results, especially for barge-in, latency, and audio clarity.
3. Verify that hold and resume, consent, and post-call actions still work in the real phone path.
4. Capture the first-call findings quickly and decide whether any fixes are required before widening access.
5. If the experience differs materially from the browser test, prioritize live-call evidence because the PSTN path is the real user experience.
6. Only after that should you announce the pilot more broadly.

> ⚠️ **Warning:** Real phone behavior can differ from browser tests because of hardware, network, and telephony-path differences.

### Step 4 — Stand up the support model

1. Document who owns first-line support during the pilot and how they capture call IDs, timestamps, and issue descriptions.
2. Define which issues require immediate rollback, such as incorrect consent handling or broken escalation to a human queue.
3. Set a daily review cadence for the first week so tuning changes can be made quickly.
4. Create a short business dashboard or spreadsheet that tracks call count, fallback rate, transfer rate, and major caller complaints.
5. Store the deployment and rollback steps in the same runbook the support team will use.
6. Treat the voice agent like a service launch, not just a feature demo.


#### Quick verification

- Telephony channel and phone number mapping are complete.
- A limited pilot test has been run on a real call path.
- Support ownership and rollback triggers are documented.

### Test prompts

Use these prompts in Copilot Studio test chat, the flow test pane, or the voice test panel as appropriate:

```text
Place a real test call and ask for outage status, then pause, resume, and end the call.
Place a second call, decline recording consent, and confirm the call still proceeds correctly.
```

### Validation checklist

- The agent is published and mapped to telephony.
- At least one real-call pilot has been executed.
- Support and rollback processes are ready before wider rollout.

### What you accomplished

| Outcome | Why it matters |
|---|---|
| Prepared the go-live checklist | Deployment discipline reduces avoidable production surprises. |
| Connected telephony | The agent now has a path from browser tests to real callers. |
| Validated on the live call path | You confirmed behavior where it matters most. |
| Established support ownership | The launch now has an operational backbone. |

### Key takeaways

- Publishing to telephony is a service-launch event, not a simple checkbox.
- Real call testing is the final source of truth for audio and interruption quality.
- Support readiness is essential before customer-facing rollout.

### Troubleshooting

- If live calls sound different than browser tests, investigate telephony path, background noise, and audio hardware assumptions.
- If consent or escalation fails in telephony, pause rollout until the call path is corrected.

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

### ✅ You've completed Use Case #7

You now have the foundation to move from **a tested browser voice pilot** to **a telephony-ready voice service**.

---

# 🙋 Summary

### What you accomplished

| Step | What you did |
|---|---|
| **Create** | Built a real-time voice agent for utility support scenarios |
| **Tune** | Adjusted voice timing, interruption behavior, and spoken style |
| **Test** | Validated the agent through the browser voice test panel |
| **Extend** | Added hold/resume, post-call actions, and consent-based recording |
| **Deploy** | Prepared and piloted the agent on a telephony path |

### Why this matters for energy and utilities

- Voice remains a critical channel during outages, emergencies, and emotionally charged customer interactions.
- Real-time voice agents can improve caller experience while still preserving deterministic controls where compliance matters.
- A well-run pilot reduces the risk of replacing a frustrating IVR with a different kind of frustration.

### Recommended next steps

- Create multilingual voice prompts for regions or customer populations that require them.
- Add post-call surveys or SMS follow-up workflows after the initial pilot stabilizes.
- Run a structured evaluation against human-agent baselines for average handle time and caller satisfaction.

> 🔋 **Final thought:** The goal of a real-time voice agent is not to sound futuristic; it is to make a stressed caller feel heard, guided, and safely resolved.

---

## 📎 Appendix A — Suggested facilitation prompts

Use these prompts to guide discussion during a live workshop, customer briefing, or internal enablement session.

- Which utility call types are best suited to self-service voice versus immediate human escalation?
- Where do we need deterministic prompts for compliance even within a natural voice experience?
- How should we measure caller satisfaction during the first pilot week?
- What legal language must appear in recording consent without making the experience feel punitive?
- How will we handle regional or language-specific pronunciation challenges?

## 📎 Appendix B — Environment readiness checklist

- Contact-center voice prerequisites are complete.
- Real-time voice feature availability and regional fit are confirmed.
- Authentication mode is appropriate for testing and telephony behavior.
- Consent wording is reviewed by compliance.
- Hold/resume and post-call actions are tested.
- Pilot support contacts and rollback steps are documented.
- A real-call test window is scheduled before broader rollout.

## 📎 Appendix C — Extension ideas

- Add a topic that hands off to a human agent with a structured conversation summary.
- Create a voice analytics dashboard for transfer reasons and caller interruption frequency.
- Pilot multilingual greetings and pronunciation guides for district names and utility acronyms.

## 📎 Appendix D — Demo prompt bank

Use these copy-paste prompts when you want a quick demonstration set for the lab.

- I need help because my neighborhood still doesn't have power.
- I have a billing question and want to know why my balance changed this month.
- Wait, let me grab my account number.
- Hold on—I'm still looking at the outage text message you sent.
- My power has been out since 2 PM—what's the latest status?
- I need time to find my account number.
- Hold on while I find my account number.
- Okay, I'm back—continue.
- Complete a short test call and hang up to confirm the post-call topic runs.
- Yes, you may record this call.
- No, I do not consent to recording.
- Place a real test call and ask for outage status, then pause, resume, and end the call.
- Place a second call, decline recording consent, and confirm the call still proceeds correctly.

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

- Real-time voice: A voice-first agent experience with natural turn-taking and low-latency spoken responses.
- Voice test panel: A browser-based test experience that lets makers speak with the agent before a phone deployment.
- Barge-in: The caller's ability to interrupt the agent naturally during playback.
- Hold and resume: A topic-level or agent-level capability that pauses the conversation while the caller retrieves information.
- Post-call action topic: A topic triggered by **End of conversation** so backend updates happen after the call ends.
- Consent-based recording: An approach where callers explicitly approve recording and transcription before it begins.

## 📎 Appendix G — Use-case review worksheet

### Use Case #1 — Create a voice-enabled agent

- Objective review: Set up a real-time voice agent with NLU and speech recognition for a utility call scenario.
- Success evidence to collect: A voice-enabled agent exists with appropriate instructions.
- Most important takeaway: Voice design starts with conversation clarity, not just feature enablement.
- Most likely support issue: If voice options are unavailable, revisit licensing, regional support, and contact-center prerequisites.
- Suggested next enhancement: Real-time voice setup includes both platform and contact-center dependencies.

### Use Case #2 — Configure voice tuning

- Objective review: Adjust speech sensitivity, silence detection, and voice selection for a natural calling experience.
- Success evidence to collect: Speech timing settings were reviewed and tuned.
- Most important takeaway: Voice tuning should reflect real phone behavior, not quiet office assumptions.
- Most likely support issue: If the agent cuts callers off, increase patience or review interruption settings.
- Suggested next enhancement: A patient agent often feels smarter than a fast but interruptive one.

### Use Case #3 — Test your voice agent

- Objective review: Use the built-in voice test panel to validate the experience with microphone input.
- Success evidence to collect: The voice test panel is usable in your environment.
- Most important takeaway: Voice quality must be heard, not just read.
- Most likely support issue: If the microphone test fails, check authentication mode and browser permissions first.
- Suggested next enhancement: Transcript review helps connect subjective experience to specific prompts and settings.

### Use Case #4 — Add hold and resume

- Objective review: Configure pause and resume so callers can retrieve information without frustration.
- Success evidence to collect: Hold and resume is configured intentionally.
- Most important takeaway: Hold and resume is especially valuable in account, outage, and verification scenarios.
- Most likely support issue: If the caller gets stuck in hold, review resume phrases and timeout settings.
- Suggested next enhancement: Topic-level precision is useful when only certain questions need pause behavior.

### Use Case #5 — Configure post-call actions

- Objective review: Set up automatic backend triggers after a call ends.
- Success evidence to collect: A dedicated post-call topic exists.
- Most important takeaway: Post-call automation belongs in its own topic so it is explicit and testable.
- Most likely support issue: If the topic never runs, verify the trigger type and end-of-conversation activity selection.
- Suggested next enhancement: EndReason conditions prevent accidental backend updates.

### Use Case #6 — Configure consent-based recording

- Objective review: Add compliant recording with caller consent.
- Success evidence to collect: The call now includes an explicit consent step.
- Most important takeaway: Consent flows should be clear, short, and legally aligned.
- Most likely support issue: If consent never triggers, verify the Conversation Start topic routes into the consent path.
- Suggested next enhancement: Compliance review belongs early in voice-agent design.

### Use Case #7 — Publish to telephony

- Objective review: Deploy the voice agent to a phone number with a realistic rollout checklist.
- Success evidence to collect: The agent is published and mapped to telephony.
- Most important takeaway: Publishing to telephony is a service-launch event, not a simple checkbox.
- Most likely support issue: If live calls sound different than browser tests, investigate telephony path, background noise, and audio hardware assumptions.
- Suggested next enhancement: Support readiness is essential before customer-facing rollout.

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
