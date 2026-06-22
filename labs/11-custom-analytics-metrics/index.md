# Lab 11: Custom Analytics Metrics

*Define and operationalize custom metrics that reflect real business outcomes for your Copilot Studio agents.*

| | |
|---|---|
| ⭐ **DIFFICULTY** | Intermediate to Advanced (200-300) |
| ⏱️ **TIME** | 60 minutes |
| 🧩 **PRODUCTS** | Microsoft Copilot Studio, Power BI |
| 🏷️ **TAGS** | Analytics, Custom Metrics, KPI |
| 🏭 **INDUSTRIES** | Cross-industry |

---

## Overview

Default metrics are useful, but teams often need business-specific signals. In this lab, you will define **custom analytics metrics**, map them to observable events, and build a reporting view that supports operational decisions.

## Learning Objectives

1. Define business-outcome metrics beyond default dashboards.
2. Map metrics to trackable conversation events.
3. Build a dashboard view for custom KPI monitoring.
4. Set thresholds and alerting for metric drift.
5. Link metric trends to improvement actions.

## Prerequisites

- Access to Copilot Studio analytics and export capabilities.
- A target scenario with clear business outcomes.
- A reporting tool such as Power BI.
- Stakeholders aligned on KPI definitions.

## Step-by-Step

### Step 1 - Define your KPI framework

1. Identify three business outcomes your agent should improve.
2. Define one metric per outcome with clear formulas.
3. Document data sources needed for each metric.
4. Define baseline values or starting assumptions.
5. Agree on KPI owners and review audience.

### Step 2 - Map events to metric calculations

1. List agent events needed to compute each KPI.
2. Verify each event is available in analytics exports.
3. Create transformation logic for clean aggregation.
4. Handle missing or null event cases explicitly.
5. Validate calculations using sample data.

### Step 3 - Build the dashboard view

1. Create a KPI dashboard in your reporting tool.
2. Add trend lines by week and by intent.
3. Add segmentation by channel or user type.
4. Add filters for release version comparisons.
5. Publish dashboard access for stakeholders.

### Step 4 - Define thresholds and responses

1. Set warning and critical thresholds per KPI.
2. Define response playbooks for threshold breaches.
3. Assign owners for triage and remediation.
4. Add links from dashboard to backlog actions.
5. Validate one simulated breach workflow.

### Step 5 - Run your first KPI review cycle

1. Hold a review with product and operations teams.
2. Highlight top positive and negative KPI deltas.
3. Agree on two targeted improvement actions.
4. Record decisions and accountable owners.
5. Schedule the next review checkpoint.

## Validation / Success Criteria

- At least three custom KPIs are defined and calculated.
- KPI dashboard is published and review-ready.
- Thresholds and response actions are documented.
- KPI findings produced actionable backlog decisions.

## Lab Complete

You created an actionable **custom analytics metrics** model tied to real business outcomes.

Suggested next labs:

- [Lab 10: Question/Reaction Exports](../10-question-reaction-exports/index.md)
- [Lab 39: Agent Readiness / Issue Status](../39-agent-readiness-issue-status/index.md)
