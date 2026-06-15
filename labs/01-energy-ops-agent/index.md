# ⚡ Lab 01: Build a Custom IT Operations Agent for Contoso Energy

*Delivering energy with purpose — powered by AI*

| | |
|---|---|
| ⭐ **DIFFICULTY** | Intermediate |
| ⏱️ **TIME** | 75 minutes |
| 🧩 **PRODUCTS** | Microsoft Copilot Studio, SharePoint, Microsoft Learn |
| 🏷️ **TAGS** | Custom Agents, Generative Orchestration, Knowledge Sources |
| 🏭 **INDUSTRIES** | Energy / Utilities |

---

## Overview

Contoso Energy's mission is to deliver energy with purpose — connecting approximately 40 million consumers through innovation, reliability, and a commitment to the communities we serve. Across subsidiaries including **Pacific Coast Electric**, **Western Gas & Energy**, and **LoneStar Grid**, nearly 20,000 employees manage natural gas pipelines, electrical substations, and smart grid infrastructure. The IT Operations team plays a critical role in keeping those field crews productive, connected, and safe.

In this lab, you will use Microsoft Copilot Studio to build a knowledge-powered IT Operations agent grounded in real Contoso Energy enterprise data. The agent will be able to reason, respond, and reference internal IT guides, policy documents, and industry compliance standards — helping users resolve issues faster without calling the helpdesk.

You will design, configure, and test a fully customized **Contoso IT Operations Agent** that answers questions using SharePoint, and public knowledge sources — including the NERC CIP standards that govern critical energy infrastructure.

Let's build your agent from the ground up.

---

## Objectives

In this mission, you'll learn:

1. Understanding what custom agents are and how they differ from pre-built templates
2. Creating agents using natural language prompts with AI
3. Grounding agents with enterprise knowledge sources including SharePoint, documents, and public websites
4. Learning about generative orchestration and how agents dynamically search and respond using multiple data sources
5. Building and testing a fully functional **Contoso Energy IT Operations agent** that answers questions from your own data

---

## 🤔 What is a custom agent?

A custom agent is a chatbot or virtual assistant that you create and design in Copilot Studio to help users with specific tasks or questions. It's called **custom** because:

- **You decide the purpose** — help users request access to the Energy Support App, troubleshoot a field device, look up NERC CIP compliance procedures.
- **You define the conversation** — what the agent says and how it should respond.
- **You ground it with your own data** — connect to your enterprise data through the built-in supported knowledge resources.
- **You connect it to your own systems or applications** — choose from connectors, flows, REST APIs, and model context protocol servers.

> **Think of it this way:** you are building your own digital IT Operations expert that can talk to employees, answer technical questions, collect incident information, and connect to your enterprise data — all without requiring staff to call the helpdesk for every common issue.

### 🤖 What can a custom agent do?

A custom agent can fulfill the following:

- Ask users for information such as employee ID, device type, substation location, or error codes.
- Save that information to a database, SharePoint list, or ITSM / "Helpdesk" system.
- Look up data based on the questions asked and answer them using grounded knowledge sources.
- Work autonomously without users directly interacting with the agent.
- Trigger actions either on-demand through direct user interaction or autonomously — such as sending an incident alert to Teams or creating a ticket in ServiceNow.

### 👩🏻‍💻 Why use a custom agent?

- Saves time by automating repetitive tasks.
- Gives field technicians a friendly, guided experience — even from a ruggedized tablet in the field.
- Tailored to Contoso Energy's unique operational environment: the Energy Support App, smart meters, NERC CIP requirements, and utility-specific workflows.

### ✨ Example

You build a custom agent that helps a field technician report an Energy Support App login failure from a remote substation.

It asks for their employee ID, the name of the Energy Support App they are trying to reach, the error message displayed, and the device type they are using. Once the technician provides this information, the agent logs the incident to Contoso Energy's IT ticketing system and posts a notification in the **#it-field-ops** Microsoft Teams channel.

Now, instead of a field crew member calling the IT helpdesk and waiting on hold while standing in a substation, they simply chat with the agent instead.

---

## 🗣️ Use natural language to create agents

In Copilot Studio, you don't need to write code to create an agent. Copilot Studio makes it easy to build agents by starting with a description in your own words — known as **natural language**.

When you start by describing your agent in natural language, the AI automatically generates the agent's name, description, and instructions. It also proposes triggers, channels, knowledge sources, and tools. You can accept or ignore these suggestions, but they only last for the current session and won't be saved.

---

## 🌱 But I'm new to "describing what I want" — what do I do?

Describing in natural language to create a custom agent might be a new concept for you. Whenever you use Copilot across Microsoft products and services, you are using natural language in the form of a **prompt**.

A prompt is the message or instruction you give to an AI agent to tell it what you want it to do. Think of it as giving directions to a new team member on their first day. The clearer your instructions are, the easier it is for the agent to understand and act on them.

### 🪄 Why prompts matter

- They guide the agent's behavior.
- They help the agent understand what kind of conversation to have.
- A good prompt makes the agent more helpful and accurate.

### 📝 Tips for writing a good prompt

- **Be clear and specific** — say exactly what you want the agent to do.
- **Think like the user** — what will the field technician say? What should the agent reply?
- **Include the context** — name the systems, policies, and escalation paths relevant to your organization.

#### ✨ Example

Let's say the IT Operations team needs an agent to help field technicians report Energy Support App login issues.

The prompt could be:

```
I want to build an agent that helps Contoso Energy field technicians report Energy Support App login failures. When a technician says they cannot log in to the Energy Support App, the agent should ask for their employee ID, the name of the Energy Support App they are trying to access, the error message displayed on screen, and the type of device they are using. Once the technician provides this information, the agent should save it to a SharePoint list called 'IT Field Incidents'.
```

**Why this prompt works:**

- **Clearly states the goal** — report an Energy Support App login failure
- **Describes the user interaction** — what the technician says and what the agent should ask
- **Lists the required data** — employee ID, Energy Support App name, error message, device type
- **Mentions where the data goes** — a SharePoint list


---

## Grounding your agent with knowledge

In Copilot Studio, **knowledge sources** are places where your agent can find information to give better answers. When you add these sources, your agent can pull in your enterprise data from places like SharePoint, uploaded documents, public websites, and other systems your company uses.

These sources work together with AI to help your agent respond more accurately to user questions through what is known as **generative orchestration**.

### 🌿 What is generative orchestration in the context of agents?

Generative orchestration means the agent uses AI to dynamically decide how to respond by combining its built-in language skills with your knowledge sources, topics, tools, and connected agents.

When a user asks a question, the agent:

- **Understands** the question using AI.
- **Can ask users for missing information** by generating questions on the fly.
- **Selects the most relevant resources** — knowledge sources, topics, tools, or connected agents — from those you have configured.
- **Searches and executes** to find the best answer.
- **Generates a natural, helpful response** using the information it found.

### Why knowledge sources matter

1. **Smarter answers** — when you add knowledge sources, your agent can give better, more accurate answers using real data from your organization.
2. **Less manual work** — you don't have to write every possible response. The agent can search through your added sources and respond automatically.
3. **Use trusted information** — your agent can pull answers from systems you already use such as SharePoint, internal policy documents, or company websites so that field staff have reliable information from a source of truth.
4. **Works with generative AI** — knowledge sources and AI help your agent understand questions and respond naturally, even if the question wasn't pre-programmed or added as a starter prompt.
5. **Flexible and expandable** — you can add knowledge sources anytime during setup or at a later point in time. Your agent grows smarter as your needs change.

#### ✨ Example

Imagine you build an agent to help Contoso Energy field technicians with IT questions. You add the Contoso Energy Technology - AI & Digital Enablement SharePoint site and a Field Remote Access Guide as knowledge sources.

When a technician asks, *"How do I connect to the corporate VPN from a remote substation?"*, the agent uses generative orchestration to search those sources and reply with the correct steps — without you having to write that answer manually. This saves you time in having to account for every possible question a field crew member may ask about remote access procedures.

---

## Types of knowledge sources that can be added

1. **Public websites**
   - *What it does:* Searches specific websites (like Microsoft Support or NERC CIP documentation) using Bing.
   - *Why it's useful:* Great for pulling in public-facing info like IT support articles, compliance standards, or product FAQs.

2. **Documents**
   - *What it does:* Uses documents that you upload directly to your agent, such as PDFs or Word files. These uploaded files are stored securely in Dataverse.
   - *Why it's useful:* Enables your agent to answer questions based on internal guides, field manuals, or IT policies.

3. **SharePoint**
   - *What it does:* Connects to SharePoint sites using Graph Search to access team documents and knowledge bases.
   - *Why it's useful:* Ideal for accessing team documents, IT policies, and internal knowledge bases that are already maintained in SharePoint.

4. **Dataverse**
   - *What it does:* Uses structured data from your Dataverse environment tables and rows.
   - *Why it's useful:* When you need to look up enterprise data stored in Dataverse such as employee information or IT asset inventory.

5. **Enterprise data with connectors**
   - *What it does:* Lets your agent access data from other enterprise systems during a conversation, using the user's own permissions. Common connectors include: SharePoint, Dataverse, Outlook (Email & Calendar), Microsoft Teams, OneDrive, Power Automate (flows to call connectors), Azure DevOps (ADO), Power BI (via Power Automate/API), ServiceNow, and Custom Connectors / APIs.
   - *Why it's useful:* Provides up-to-date, secure, and accurate responses without storing or duplicating data — for example, looking up the current status of an open IT incident in ServiceNow.

---

## 🔒 Note on security

### Knowledge source authentication

Some sources such as SharePoint and Dataverse require **user authentication**. This means the agent will only reference data in its response that the user is allowed to see. Whereas other sources may have additional configuration required for the agent to connect to them.

---

## Improving your agent's responses in Copilot Studio

After your agent is provisioned from the conversational authoring experience, you'll want to test your agent against the instructions AI generated from your prompt. Improving your agent's responses in Copilot Studio is all about making sure it understands your goals clearly and has the right information to work with.

1. **Refine the agent instructions** — this is where you tell your agent how it should behave. Use clear, specific language.

   For example:

   ✅ *"Act like a knowledgeable Contoso Energy IT Operations specialist who explains technical steps clearly and always asks for the technician's location and device type before troubleshooting."*

   ❌ *"Be helpful."* (Too vague)

2. **Check the tone and language** — make sure the agent's tone matches your audience (field technicians, not just office staff).

   You can set it to be:
   - Professional and concise.
   - Safety-aware and procedurally correct.
   - Patient and supportive for non-technical users.

3. **Add or update knowledge sources** — if your agent needs to answer questions about a topic, make sure it has access to the right information.
   - Add internal SharePoint guides, uploaded policy documents, or public websites.
   - Keep the content up to date, especially NERC CIP procedures.
   - Use clear, well-structured information.

4. **Use Topics with clear descriptions** — if your agent needs to handle specific tasks or conversations, create topics with accurate, thorough descriptions that explain the topic's purpose and when it should be used. The generative AI orchestrator reads these descriptions to decide which topic to trigger automatically — no manual trigger phrases needed. We'll learn more about this in the following lesson.

5. **Test with real questions** — try asking your agent the kinds of questions a field technician or helpdesk user might ask.

   If the answers aren't great:
   - Adjust the system instructions.
   - Add more examples or knowledge.
   - Rephrase your questions to see how it responds.

6. **Review and iterate** — improving an agent is an ongoing process!

   After publishing:
   - Collect feedback from field users.
   - Watch for common questions or points of confusion.
   - Keep refining the agent's setup.

---

## 🧪 Lab 01: Create a custom agent in Copilot Studio

We're now going to learn how to create a custom agent that can chat over your data.

### ✨ Use case

**As a Contoso Energy field technician or IT operations staff member**

I want to get quick and accurate help from the IT Operations agent for questions setting up a Copilot Studio agent, and NERC CIP compliance questions.

Let's begin!

---

### ✨ Prerequisites

#### SharePoint site

We'll be using the **Contoso Energy Technology - AI & Digital Enablement SharePoint** site. This site contains IT support documents.


#### Power Platform Solution

We'll be creating our agent inside a solution. If you have not yet set up a solution for this lab series, create a new solution named **Contoso Energy Agent Solution** with a publisher prefix of your choosing before continuing.

---

### 1.1 Use natural language to create an agent with AI

> **Note — AI generated instructions may differ across sessions**
>
> When you start by describing your agent in natural language, the AI generated name, description, and instructions can vary in each session. This also applies to the proposed triggers, channels, knowledge sources, and tools.

1. Navigate to https://copilotstudio.microsoft.com and in the description field, enter the following prompt which describes the Contoso Energy IT Operations agent.

```
You are a Contoso Energy IT Operations assistant that helps employees and field technicians resolve IT issues related to utility operations. Be professional, concise, and safety-aware. Use the Contoso Energy IT knowledge base and company resources as primary sources. Do not invent troubleshooting steps — if guidance cannot be verified, say so and escalate appropriately.

For troubleshooting:
1) Ask ONE focused question if details are missing (system name, error message, substation or location, device type).
2) Provide numbered step-by-step instructions (short and actionable).
3) If the issue is not resolved, offer 1-2 alternative approaches.
4) After 2-3 troubleshooting branches, recommend escalation and provide a ticket summary including: location, system affected, error message, device or app, and steps already tried.

For Energy Support App and OT systems:
1) Confirm the user is following OT network access protocols before providing guidance.
2) Only provide guidance that is aligned with NERC CIP security requirements.

Never request passwords, OTP codes, or authentication tokens. Refuse any request to bypass security controls. Always prioritize operational and field safety.

Use Microsoft Support (https://support.microsoft.com) for Microsoft product issues and NERC CIP standards (https://www.nerc.com/standards/reliability-standards) as an authoritative reference for compliance-related questions. Include relevant source links in your responses.
```

   The prompt covers:

   - **Role and goal:** Contoso Energy IT Operations assistant for field technicians and office staff
   - **Primary knowledge sources:** Contoso Energy IT knowledge base, Microsoft Support, NERC CIP standards
   - **Response style:** Professional, concise, safety-aware
   - **Troubleshooting flow:** Question → Quick fixes → Steps → Alternative branches → Escalation
   - **Escalation artifact:** Ticket summary with location, system, error, device, and steps tried
   - **Energy Support App/OT guidance:** OT protocol confirmation and NERC CIP alignment
   - **Security boundaries:** No passwords, no bypassing security controls, operational safety first
   - **Link handling:** Preserve source URLs, cite Microsoft Support and NERC CIP references

2. We'll double check the solution that our agent will be created in is the **Copilot Studio Lab Solution*. Select the wheel cog icon and the Agent Settings modal will appear. Confirm the correct solution is selected, then select **Cancel**.

3. Submit the prompt description and Copilot Studio will begin provisioning our agent.

4. Once the agent has been provisioned, you'll see a confirmation appear. Notice how AI automatically generated the name, description, and instructions for your agent. The orchestration mode is enabled by default (found in Settings) and the default primary AI model is used for the agent.

5. Scroll down to review the AI suggestions for knowledge sources, tools, and triggers.

6. Scroll down some more to review the Connected Agents, Topics, and Suggested Prompts sections.

7. We'll next double check our agent has correctly been created in the **Copilot Studio LabSolution**. Select **Settings** on the upper right.

8. We can see under **Advanced** that the agent has been created in the **Copilot**. Exit from settings.

9. Now let's update the name of our agent. Select **Edit** in the Details section.

10. Enter the following as the name of the agent and **Save** the updated details.

    ```
    Contoso IT Operations Agent by <<Enter Your Name or initials to avoid conflicts with other learners>>
    ```

11. We'll now add the suggested knowledge sources. In the Knowledge section, select **+ Add** for the website URL `https://support.microsoft.com`

12. The **Add public websites** modal appears with the website URL. Select **Add**.

13. Add another website using the URL below and select **Add to agent**.

    ```
   https://www.nerc.com/standards/reliability-standards
    ```

    > **Why NERC CIP?** Contoso Energy's electrical operations are subject to North American Electric Reliability Corporation (NERC) Critical Infrastructure Protection standards. Adding this as a knowledge source allows the agent to answer questions about cybersecurity requirements for critical energy infrastructure — something a generic IT helpdesk agent would not include.

14. The two website URLs have now been added as knowledge sources for our agent. Select **X Dismiss** to remove any remaining AI suggestions you do not want to add at this time.

15. By default the **Web Search** setting is enabled. Select the toggle to **disable** the Web Search feature, as we only want the agent to use the knowledge sources we define.

16. Let's now test our newly created agent. In the **Testing pane** on the right hand side, select the **new test session** icon.

17. Enter the following question in the Testing pane:

    ```
    How do I enable multi-factor authentication on my Microsoft account?
    ```

18. The Activity map will then load, showing in real-time what path the agent is processing. In this scenario, our agent has understood the question and searches the knowledge sources using the two website URLs.

    Our agent responds with step-by-step instructions, as defined in the instructions. The response has references to the `https://support.microsoft.com` website that the agent formed its answer from. This enables users to verify the source of the answer.

> **Congratulations!** You've built your first Contoso Energy custom agent by starting with a description in Copilot Studio 🙌

---

### 1.2 Add an internal knowledge source using a SharePoint site

Previously, we added public websites as external knowledge sources for our agent during the conversational creation experience. We're now going to add an internal knowledge source using a **SharePoint site**. This will be the **Contoso Energy Technology - AI & Digital Enablement SharePoint** site containing your IT policies and field guides.

1. In the **Knowledge** section, select **+ Add knowledge** and select **SharePoint**.

2. Paste in the address of the **Contoso Energy Technology - AI & Digital Enablement SharePoint** site `https://contoso.sharepoint.com/sites/digitalinnovation` in the SharePoint URL field and select **Add**.

3. Update the name of the SharePoint site to **`Contoso Energy Technology - AI & Digital Enablement`** and select **Add to agent**.

4. The SharePoint site has now been added as a knowledge source. The **Status** column will show whether the knowledge source has been loaded/connected successfully, or if there is an issue. Wait until the status shows **Ready** before continuing.

   > **What's in the Contoso Energy Technology - AI & Digital Enablement SharePoint site?** This folder contains documentation on setting up a Copilot Studio agent.

---

### 1.3 Add an internal knowledge source by uploading a document

We'll now add another internal knowledge source by uploading a document directly to our agent.

1. In the **Knowledge** section, select **+ Add knowledge** and select **Upload files** or select to browse.

2. Download the **[Contoso Energy Field Operations Remote Access Guide]** from the **Copilot Studio Lab Materials** document library, save it as a `.docx` or `.pdf` file, and select it in your File Explorer. Select **Open**.

   > **About this document:** This guide helps Contoso Energy employees understand how to create Copilot Studio agents.

3. The file has been selected for upload. Select **Add to agent**.

4. The document will be in the process of being added to the agent. Wait until the upload has completed — do not close the browser window.

5. The status of the document will initially show as **In progress**. Wait until the status has been updated to **Ready** before testing your agent.

Let's now test our agent!

---

### 1.4 Test agent

We'll test our four knowledge sources by asking questions to our **Contoso IT Operations Agent**.

1. Select the **new test session** icon in the test pane.

   Enter the following question to test our public website (external) knowledge source — Microsoft Support:

   ```
   How do I reset my Microsoft MFA settings to set up multi-factor authentication again?
   ```

2. You'll next see the agent reviewing the knowledge sources and providing a response using the Microsoft Support website knowledge source.

   A response will be returned. Notice how there are **references** to the web page it formed its answer from.

3. If you scroll down the knowledge modal in the activity map, you'll see the other knowledge sources the agent searched — the NERC CIP website, and the SharePoint site. However, these were not used for this answer, as the Microsoft Support website was the relevant source for the MFA question.

4. Let's now test both our **SharePoint site** knowledge source. Enter the following question:

   ```
   How do I create a new Copilot Studio agent for my team?
   ```

5. The agent reviews the knowledge sources to generate a response. The agent provides **references** for where it generated the response from.

   In the knowledge modal in the activity map, you'll see the **SharePoint site** referenced for the Copilot Studio creation question.

6. Scroll down to review the response for creating the Copilot Studio agent. You'll see a response that's grounded using the uploaded document, with specific references to the relevant sections.

7. Let's test the NERC CIP knowledge source. Enter the following question:

   ```
   What are the NERC CIP requirements for cybersecurity incident reporting in the energy sector?
   ```

8. The agent will reference the NERC CIP standards website in its response. This demonstrates how an energy-specific knowledge source enables the agent to answer industry-compliance questions that a generic IT helpdesk agent could not.

9. It's always good to verify the generated response is correct. Select a **document reference** and a modal will appear with the text from the source that reflects the answer.

> The agent can answer multiple questions in a single message and search the knowledge sources, referencing the most relevant source in its response. Make sure to always verify the response is correct by reviewing the references.

---

## ✅ Lab Complete

Congratulations! 👏 You've built a custom Contoso Energy IT Operations agent grounded in real enterprise data. Your agent can now draw on four distinct knowledge sources:

- ✅ **Microsoft Support** — for Microsoft product and device questions
- ✅ **NERC CIP Standards** — for energy industry compliance and cybersecurity questions
- ✅ **Contoso Energy Technology - AI & Digital Enablement SharePoint** — for Copilot Studio Agent setup documentation
- ✅ **Contoso Energy Field Operations Remote Access Guide** — for field remote access procedures

---

## 📚 Learning Resources

🔗 [Quickstart: Create and deploy an agent](https://learn.microsoft.com/microsoft-copilot-studio/fundamentals-get-started)

🔗 [Create and delete agents](https://learn.microsoft.com/microsoft-copilot-studio/authoring-first-bot)

🔗 [Key concepts — Authoring agents](https://learn.microsoft.com/microsoft-copilot-studio/authoring-fundamentals)

🔗 [Add knowledge to your agent](https://learn.microsoft.com/microsoft-copilot-studio/knowledge-add-existing-copilot)

🔗 [NERC CIP Standards](https://www.nerc.com/standards/reliability-standards)

🔗 [Microsoft Azure for Energy and Utilities](https://azure.microsoft.com/en-us/industries/energy/)

📺 [Create a custom agent using natural language](https://aka.ms/ai-in-action/copilot-studio/ep1)

📺 [Add knowledge to your agents](https://aka.ms/ai-in-action/copilot-studio/ep2)
