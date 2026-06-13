# Work Routing

## Member Routing

| Member | Route When | Typical Work |
|--------|------------|--------------|
| Ripley | Scope, architecture, sequencing, or cross-agent decisions are needed | Lab structure, technical trade-offs, final content review |
| Lambert | The task is primarily about lab authoring or documentation flow | Step-by-step labs, instructional copy, learner guidance |
| Dallas | The task touches code, APIs, Power Automate, or MCP server behavior | Node.js MCP servers, API integration, flow implementation |
| Kane | The task needs validation, test design, or edge-case coverage | Evaluation sets, QA passes, defect reproduction |
| Scribe | Decisions, status, or cross-agent context need to be recorded | Decision log updates, orchestration notes, session summaries |
| Ralph | Work needs monitoring, backlog hygiene, or queue visibility | Work queue checks, follow-up reminders, keep-alive monitoring |
| Rai | The task needs content safety, privacy, or responsible AI review | Lab safety review, risky prompt checks, policy alignment |

## Routing Rules

1. Start with **Ripley** for new multi-step efforts, ambiguous scope, or cross-cutting changes.
2. Route lab content and learner-facing markdown to **Lambert**.
3. Route integrations, flows, scripts, and MCP server work to **Dallas**.
4. Route acceptance checks, regression passes, and edge-case coverage to **Kane**.
5. Route decision capture and durable project memory to **Scribe**.
6. Route backlog/watch duties and coordination follow-through to **Ralph**.
7. Route safety, privacy, and inclusive-content review to **Rai**.
8. For multi-agent work, run a design review first and send outcomes to Scribe for logging.
