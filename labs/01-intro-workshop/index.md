# Lab 01: Copilot Studio Introductory Workshop

## Metadata

| | |
|---|---|
| ⭐ **DIFFICULTY** | Beginner to Intermediate (Level 100-200) |
| ⏱️ **TIME** | 1.5 hours |
| 🧩 **PRODUCTS** | Microsoft Copilot Studio, Microsoft 365, Microsoft Teams, SharePoint, MSN Weather |
| 🏷️ **TAGS** | Agent Creation, Connectors, Tool Use, Model Selection, Publishing, Channels |
| 🏭 **INDUSTRY** | Energy / Utilities |

## Overview

This hands-on lab covers the essential skills for building, configuring, and publishing AI agents in Microsoft Copilot Studio. Participants will learn multiple approaches to agent creation, integrate external tools using connectors, understand model selection tradeoffs, and publish agents across Microsoft 365 channels.

## 🎯 Objectives

| Section | Topic | Duration |
|---------|-------|----------|
| 1 | Ways to Build a Copilot Studio Agent | 15 min |
| 2 | Tool Use with Connectors (MSN Weather) | 30 min |
| 3 | Model Selection — GPT vs Claude vs Others | 20 min |
| 4 | Publishing & Sharing on M365, Teams, SharePoint | 25 min |

## Prerequisites

- Microsoft 365 account with Copilot Studio access
- Web browser (Microsoft Edge or Chrome recommended)
- Basic familiarity with Microsoft 365 apps

## Lab Materials

- **[Full Lab Guide (DOCX)](Copilot-Studio-Intro-Lab-Workshop.docx)** — Complete walkthrough with embedded screenshots
- **[Full Lab Guide (PDF)](Copilot-Studio-Intro-Lab-Workshop.pdf)** — Print-ready version
- **[Screenshots](screenshots/)** — All screenshots in light mode
- **[Dark Mode Screenshots](screenshots/dark/)** — Dark mode variants

## Section Summaries

### Section 1: Ways to Build Agents
- Describe-to-build (natural language)
- Build from scratch (blank canvas)
- Computer-using agents
- Workflows (Power Automate)

### Section 2: Tool Use with Connectors
- Creating conversational topics with question nodes
- Adding the MSN Weather connector as a tool
- Wiring tools with Power Fx formulas
- Testing end-to-end tool invocation

### Section 3: Model Selection
- OpenAI models: GPT-5 Chat, GPT-5 Auto, GPT-5 Reasoning, GPT-4.1
- Anthropic models: Claude Sonnet 4.5/4.6, Claude Opus 4.6/4.7/4.8
- Decision guide: when to use which model
- Advanced Generative AI settings

### Section 4: Publishing & Sharing
- Microsoft 365 Copilot (Agent Store)
- Microsoft Teams (chats, meetings, channels)
- SharePoint (web part embedding)
- Authentication considerations
- Other channels overview

## ✅ Validation

You have successfully completed this workshop when you can confirm all of the following:

- **Built an agent** — you created a Copilot Studio agent using at least one of the approaches covered (describe-to-build or build-from-scratch) and it responds in the test canvas.
- **Tool use works** — you added the MSN Weather connector as a tool, wired it with a question node and Power Fx, and the agent returns live weather data for a location you supply.
- **Model choice understood** — you can explain when to choose an OpenAI (GPT) model versus an Anthropic (Claude) model, and you changed the agent's model in the Generative AI settings.
- **Published successfully** — you published the agent and made it available in at least one Microsoft 365 channel (Microsoft 365 Copilot, Teams, or SharePoint).
- **Sharing verified** — another user (or a second test session) can reach the published agent through the channel you configured.

If any check fails, revisit the matching section: confirm the connector tool is configured correctly, that the model is set in Generative AI settings, and that the agent has been published before testing the channel.

## ✅ Lab Complete

Congratulations! 👏 You now have a working Copilot Studio agent and the core skills to build, extend, and ship agents across Microsoft 365. In this workshop you learned multiple ways to create an agent, added a connector tool with the MSN Weather example, compared model options and their tradeoffs, and published your agent to Microsoft 365 channels.

**Suggested next labs:**

- **[Lab 06: Energy Operations Weather Agent](../06-energy-weather-agent/)** — go deeper with custom prompt tools, connected child agents, and evaluation test suites.
- **[Lab 07: Monitor Performance and Evaluate Agent Quality](../07-agent-analytics-evaluations/index.md)** — measure and continuously improve the agents you build.

## Related Labs

- **[Lab 06: Energy Operations Weather Agent](../06-energy-weather-agent/)** — Advanced lab building a complete agent with custom prompt tools, connected child agents, and evaluation test suites.

---

*Generated with automated lab documentation tooling.*
