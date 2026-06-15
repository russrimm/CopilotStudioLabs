# 💻 Lab 11: Build a Power Apps Code App with Dataverse

*Bring your own code to Power Apps — build a supplier onboarding dashboard connected to Dataverse.*

| | |
|---|---|
| ⭐ **DIFFICULTY** | Intermediate (Level 200) |
| ⏱️ **TIME** | 45 minutes |
| 🧩 **PRODUCTS** | Power Apps (Code Apps / BYOC), Microsoft Dataverse, Visual Studio Code, PAC CLI, GitHub Copilot |
| 🏷️ **TAGS** | Bring Your Own Code, Code Apps, Dataverse, Supplier Onboarding, Pro Code |
| 🏭 **INDUSTRY** | Energy / Utilities |
| 👤 **PERSONA** | Pro Code / Maker |
| 📋 **STATUS** | Supplementary |

---

## ⚡ Why this lab matters

Energy companies like Contoso Energy manage hundreds of supplier relationships — from equipment vendors and field service contractors to fuel providers and environmental consultants. Onboarding these suppliers requires tracking submissions, approvals, and compliance documentation across multiple teams.

The **Bring Your Own Code (BYOC)** feature in Power Apps lets development teams build custom web applications using standard tools like **Visual Studio Code**, **Node.js**, and **Git** — then publish and run those apps directly in the Power Platform. This means your teams can:

- **Reuse existing code** and development skills rather than learning a new framework
- **Maintain enterprise coding standards** with familiar ALM practices (source control, CI/CD, code review)
- **Connect to Dataverse** for secure, governed data access alongside your Copilot Studio agents
- **Use GitHub Copilot** to accelerate development with AI-assisted coding

This lab demonstrates how BYOC extends the Power Platform ecosystem — complementing the no-code agent building you've done in previous labs with a code-first approach for scenarios that need custom UI and business logic.

---

## 🏗️ What you'll build

A **Supplier Onboarding Management** dashboard — a single-page web application that:

- Displays supplier data from a Dataverse table in a responsive grid
- Provides dashboard filter cards for supplier statuses (Submitted, Active, Declined)
- Opens a modal dialog on record click with full supplier details
- Allows users to approve or decline onboarding requests directly from the dialog
- Is optimized for both desktop and mobile (iPhone 12)

| Use case | Description | Est. time |
|---|---|---|
| **Create a code app** | Clone the starter template, connect to your environment, build and deploy to Power Apps | 15 min |
| **Add a data source** | Connect the Suppliers Dataverse table to your app | 5 min |
| **Add business logic** | Use GitHub Copilot to build the supplier onboarding dashboard UI and logic | 20 min |

---

## 🎯 Objectives

By the end of this lab, you will be able to:

1. Create a web application using VS Code and the Power Platform SDK
2. Connect a custom web application to a Dataverse table
3. Use GitHub Copilot to add business logic for supplier onboarding workflows
4. Build and publish a code app to Power Apps

---

## ✅ Prerequisites

| Requirement | Details |
|---|---|
| **Northwind Traders solution** | Import version 1.0.0.11 or later to your environment and seed with data using the Northwind Sample Data App. See the [Solutions folder](https://github.com/microsoft/apps-agents-workshop/tree/main/solutions) for the solution and full instructions. |
| **Node.js** | [Long-term support (LTS) version](https://nodejs.org/) |
| **Power Platform CLI** | [Install PAC CLI](https://learn.microsoft.com/power-platform/developer/cli/introduction?tabs=windows) |
| **Visual Studio Code** | With GitHub Copilot extension installed |
| **Power Apps license** | End users running code apps need a Power Apps Premium License |

### Configure PowerShell execution policy

To run scripts on your system, configure the PowerShell execution policy. Use `RemoteSigned` at the `CurrentUser` scope (no admin required):

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

> 💡 **Tip:** If you encounter a "running scripts is disabled on this system" error, see [Troubleshooting](#-troubleshooting) at the end of this lab.

---

## 🔨 Use case 1: Create a code app from scratch

| | |
|---|---|
| **Goal** | Clone the starter template, connect to your environment, build and deploy |
| **Time** | 15 minutes |
| **Outcome** | A code app published to Power Apps in your environment |

### Step-by-step instructions

**1. Open a project folder in VS Code**

Open Visual Studio Code, then open a folder where you want to host the source code (File → Open Folder).

**2. Clone the starter template**

Open a terminal in VS Code and run:

```bash
npx degit github:microsoft/PowerAppsCodeApps/templates/vite suppliers-onboarding-code-app
cd suppliers-onboarding-code-app
```

> 💡 **Tip:** You can replace `suppliers-onboarding-code-app` with any name you prefer.

You should now see the template files in the VS Code explorer — source code lives in the `src` folder.

**3. Authenticate and select your environment**

```bash
pac auth create
pac env select --environment <your-environment-ID>
```

> 💡 **Important:** Sign in using your Power Platform account when prompted. The environment ID ensures your app deploys to the correct environment.

**4. Install dependencies and initialize the code app**

```bash
npm install
pac code init --displayname "Suppliers Onboarding Code App"
```

> 💡 **Important:** The `power.config.json` file created by `pac code init` contains all settings for connecting to the Power Platform — including `appDisplayName`, `environmentId`, `connectionReferences`, and `databaseReferences`.

**5. Test locally**

```bash
npm run dev
```

Open the URL labelled **Local Play** in your browser.

> 💡 **Tip:** To stop the local server, press `Ctrl+C` in the terminal.

### ✅ Checkpoint

You should see the default Vite template app running in your browser. This is the starting point — you'll customize it in the next use cases.

**6. Build and deploy to Power Apps**

```bash
npm run build && pac code push --solutionName NorthwindTraders
```

This command:
- Runs the build scripts from `package.json` (`tsc -b && vite build`)
- Publishes the code app to Power Apps
- Targets the **NorthwindTraders** solution in your environment

> 💡 **Important:** If no solution is specified, `pac code push` deploys the app to the default solution. If you've previously deployed without `--solutionName`, delete your app from Power Apps, delete `power.config.json`, and reinitialize.

If successful, the command returns a Power Apps URL to run the app.

---

## 🔗 Use case 2: Add a Dataverse table to the app

| | |
|---|---|
| **Goal** | Connect the Suppliers table as a data source |
| **Time** | 5 minutes |
| **Outcome** | Your app has typed access to Dataverse supplier records |

### Step-by-step instructions

**1. Add the data source**

Ensure you're connected to your environment (see Use Case 1, Step 3), then run:

```bash
pac code add-data-source -a dataverse -t nwind_suppliers
```

> 💡 **Important:** Use the **logical name** for the Dataverse table (`nwind_suppliers`, not the display name).

You'll know it worked when you see generated code appear in your project folder.

**2. Test locally**

```bash
npm run dev
```

Open the **Local Play** link in your browser.

### ✅ Checkpoint

Your app is still working and now has the Dataverse Suppliers table connected. You're ready to add business logic.

---

## 🤖 Use case 3: Use GitHub Copilot to add business logic

| | |
|---|---|
| **Goal** | Build the supplier onboarding dashboard with AI-assisted coding |
| **Time** | 20 minutes |
| **Outcome** | A fully functional supplier management dashboard |

### Step-by-step instructions

**1. Open GitHub Copilot Chat in Agent Mode**

In VS Code, open the GitHub Copilot chat panel and ensure it's set to **Agent Mode**. Select your preferred model (e.g., Claude Sonnet 4.5).

**2. Prompt Copilot to build the dashboard**

Paste the following prompt into the Copilot chat:

```
Update the application to be a backend supplier onboarding acceptance tool. List all the suppliers in a grid. Make the page look like a dashboard which has card buttons which will filter the list for the different status_reasons for the suppliers: Submitted, Active, Declined. The items in the grid should be clickable and on click, they should show in a modal dialog. The modal dialog should show the full details of the supplier, and an edit button to let them edit any values and save them back to the database. There should also be an accept and decline button to let the user accept or decline from the modal dialog. Ensure the app is responsive for mobile devices. Optimize for iPhone 12.
```

> 💡 **Tip:** Different models may produce different implementations. Review the generated code and iterate as needed.

**3. Fix any errors**

If you see errors (marked in red in VS Code or in the browser console):

- Copy the error messages and paste them into the Copilot chat
- Ask Copilot to "fix the errors" or "run lint"
- Iterate until the app is error-free

**4. Test locally**

```bash
npm run dev
```

Open the **Local Play** link and verify the dashboard works as expected:

- Supplier data appears in the grid
- Filter cards work for each status
- Clicking a record opens the modal with full details
- Accept/Decline buttons function correctly
- The layout is responsive on mobile

> 💡 **Tip:** If `npm run dev` doesn't show data or you get JavaScript errors, copy the console errors and paste them into Copilot Chat for troubleshooting.

**5. Build and deploy**

Once you're satisfied with the app:

```bash
npm run build && pac code push
```

### ✅ Checkpoint

Your supplier onboarding dashboard is now published to Power Apps. You can:

- View and manage supplier records in a responsive grid
- Filter suppliers by status (Submitted, Active, Declined)
- Open supplier details in a modal dialog
- Approve or decline onboarding requests directly from the UI

---

## 🧠 What you learned

| Concept | Why it matters |
|---|---|
| **Bring Your Own Code** | Publish custom web apps to the Power Platform using standard development tools |
| **Dataverse integration** | Connect code apps to enterprise data with typed, governed access |
| **GitHub Copilot for code apps** | Accelerate development by using AI to generate business logic and UI |
| **Governance & ALM** | Use your own source control, CI/CD, and code review practices with Power Apps |

---

## 🔍 Troubleshooting

### Scripts are blocked from running

If you see: `running scripts is disabled on this system`

Check the current execution policy:

```powershell
Get-ExecutionPolicy -List
```

Ensure `RemoteSigned` is set at the `CurrentUser` or `LocalMachine` scope:

```powershell
# No admin required (current user only):
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned

# Requires admin (all users):
Set-ExecutionPolicy -Scope LocalMachine -ExecutionPolicy RemoteSigned
```

### Running scripts in VS Code or during tool setup

If script errors persist, allow scripts for the current session only as a last resort:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

> ⚠️ **Warning:** `Bypass` removes all warnings and prompts. Use only for temporary troubleshooting — it resets when the terminal closes.

### Downloaded scripts are blocked

Scripts downloaded from the internet may be blocked even with `RemoteSigned`. After verifying the script is from a trusted source:

```powershell
Unblock-File -Path .\script.ps1
```

### App shows no data or JavaScript errors

- Copy errors from the browser console and paste them into GitHub Copilot Chat
- Ask Copilot to diagnose and fix the issue
- Verify you're connected to the correct environment with `pac env list`

---

## 💡 Challenge: Apply this to your scenario

Now that you've built a supplier onboarding dashboard, consider how this pattern applies to your own work:

- **What operational data** in your organization could benefit from a custom code app?
- **What existing web code** could your team reuse inside Power Apps?
- **How could GitHub Copilot** accelerate building custom apps for your team?
- **What governance controls** would you need for production deployment?

---

## 📚 Resources

- 🔗 [Power Apps Code Apps documentation](https://learn.microsoft.com/power-apps/maker/code-apps/)
- 🔗 [Power Platform CLI reference](https://learn.microsoft.com/power-platform/developer/cli/introduction)
- 🔗 [Microsoft Dataverse developer guide](https://learn.microsoft.com/power-apps/developer/data-platform/)
- 🔗 [GitHub Copilot in VS Code](https://docs.github.com/copilot/using-github-copilot/getting-code-suggestions-in-your-ide)
- 🔗 [Reference lab from apps-agents-workshop](https://github.com/microsoft/apps-agents-workshop/blob/main/labs/byoc-powerapps/byoc-powerapps.md)
