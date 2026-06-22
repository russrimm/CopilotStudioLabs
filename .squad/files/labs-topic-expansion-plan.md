# Labs Topic Expansion Plan (Numbering + Naming)

Date: 2026-06-22
Requested by: Russ Rimmerman [MSFT]
Scope: Plan-only update. No full lab content authoring.

## Current Baseline

- Existing lab sequence is contiguous through Lab 18.
- Latest existing lab folder: `labs/18-embed-agent-web-sdk/`.
- Next available sequential number: `19`.

## Numbering and Naming Rules

- Keep two-digit numeric prefixes for folder IDs (`19`, `20`, ... `35`).
- Keep lab folder pattern: `<nn>-<kebab-topic-slug>`.
- Keep short, capability-first names in README catalog entries.
- Split combined platform areas into focused labs when the topic list implies separate outcomes.
- Tag preview topics explicitly in planned title text with `(Preview)` until GA.

## Proposed New Labs (Sequential 19-35)

| Lab # | Topic from request | Proposed lab title | Proposed folder slug |
|---|---|---|---|
| 19 | Agent evaluations (GA) | Agent Evaluations (GA): Build and Run Reliable Evaluation Suites | `19-agent-evaluations-ga` |
| 20 | Multi-turn conversation tests | Multi-Turn Conversation Tests for Stateful Agent Quality | `20-multiturn-conversation-tests` |
| 21 | Question/reaction exports | Question and Reaction Exports for Insight Mining | `21-question-reaction-exports` |
| 22 | Prompt assistant | Prompt Assistant for Faster Prompt Iteration | `22-prompt-assistant` |
| 23 | Work IQ MCP (preview) | Work IQ MCP (Preview) for Enterprise Context Grounding | `23-work-iq-mcp-preview` |
| 24 | Agent-to-agent (GA) | Agent-to-Agent Protocol (GA): Cross-Agent Task Delegation | `24-agent-to-agent-ga` |
| 25 | Computer use (GA) | Computer Use (GA): Governed Desktop Action Automation | `25-computer-use-ga` |
| 26 | Agent flows: agent nodes | Agent Flows: Agent Nodes for Specialized Delegation | `26-agent-flows-agent-nodes` |
| 27 | Agent flows: prompt nodes | Agent Flows: Prompt Nodes for Controlled Reasoning Steps | `27-agent-flows-prompt-nodes` |
| 28 | Agent flows: M365 Copilot nodes | Agent Flows: Microsoft 365 Copilot Nodes for Work Data | `28-agent-flows-m365-copilot-nodes` |
| 29 | Agent flows: async responses | Agent Flows: Asynchronous Responses for Long-Running Work | `29-agent-flows-async-responses` |
| 30 | Usage estimator & Copilot Credits | Usage Estimator and Copilot Credits Cost Planning | `30-usage-estimator-copilot-credits` |
| 31 | Custom analytics metrics | Custom Analytics Metrics for Outcome Monitoring | `31-custom-analytics-metrics` |
| 32 | Agent inventory schema | Agent Inventory Schema for Portfolio Governance | `32-agent-inventory-schema` |
| 33 | Agent readiness / issue status | Agent Readiness and Issue Status Governance | `33-agent-readiness-issue-status` |
| 34 | Entra agent identities (preview) | Entra Agent Identities (Preview) for Secure Agent Access | `34-entra-agent-identities-preview` |
| 35 | Real-time voice agents (preview) | Real-Time Voice Agents (Preview): Live Conversational Experiences | `35-realtime-voice-agents-preview` |

## Rationalized Ordering

1. Quality and validation first (`19-22`) so teams can validate before scaling.
2. Ecosystem and interaction capabilities next (`23-25`).
3. Flow-node implementation details grouped contiguously (`26-29`).
4. Cost + telemetry + governance grouped as an operational block (`30-33`).
5. Identity and advanced modality close out the series (`34-35`).

## Minimal README Handoff Change

- Add a compact placeholder section in `README.md` after the existing supplementary labs table.
- Section purpose: reserve lab numbers `19-35` and expose the working topic map for downstream content authors.
- Keep existing Labs `01-18` entries unchanged.

## Out of Scope for This Task

- No new `labs/<nn>-.../index.md` files created.
- No metadata table authoring (industry/scenario/difficulty/time) for new labs.
- No portal/API wiring updates.

## Handoff Notes

- Content authors can create folders and `index.md` files directly from the numbering map above without renumbering existing labs.
- If any topic consolidates during authoring, reserve numbers instead of reusing them to avoid future link churn.