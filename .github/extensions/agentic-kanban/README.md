# Agentic kanban canvas

A project-scope Copilot extension that adds an **Agentic kanban** canvas. The agent and the user share one board: both can create, assign, and move cards, and each side sees the other's changes immediately.

The extension loads automatically for Copilot sessions in this repository (`.github/extensions/agentic-kanban/extension.mjs`). It has no npm dependencies.

## Use it

Ask Copilot to open the canvas, for example "open the kanban board", or open canvas `agentic-kanban` with an optional `boardId` (default: `default`). Then ask the agent to manage cards ("add a card for the lab review and assign it to me") or use the board directly:

- **Add card**: title, column, and optional assignee in the header form.
- **Assign**: select **Assign** on a card, type a name, and press Enter. An empty name unassigns.
- **Move**: drag a card to another column, or use the **Move to…** select on the card (keyboard accessible).
- **Delete**: select **Delete**, then **Confirm delete**.

Columns: `backlog`, `in-progress`, `review`, `done`. Card ids look like `C-1`.

## Agent actions

| Action | Input | Purpose |
| --- | --- | --- |
| `get_board` | `boardId?` | Return the columns, all cards, and recent activity. |
| `create_card` | `title`, `description?`, `assignee?`, `column?` | Create a card (defaults to `backlog`). |
| `assign_card` | `cardId`, `assignee` | Assign a card; `""` unassigns. |
| `move_card` | `cardId`, `column`, `position?` | Move a card, optionally to a zero-based position. |
| `update_card` | `cardId`, `title?`, `description?` | Edit a card. |
| `delete_card` | `cardId` | Delete a card. |

Every action also accepts an optional `boardId` and otherwise targets the board open in the canvas instance. Errors use codes such as `card_not_found`, `invalid_column`, `invalid_input`, `invalid_board_id`, and `board_full`. The activity log attributes edits to `agent` or `user`.

## Where data is stored

Boards are keyed by `boardId`, not by canvas instance, so they survive closing the canvas, reloading extensions, and new sessions. Each board is one JSON file:

```text
$COPILOT_HOME/extensions/agentic-kanban/artifacts/boards/<boardId>.json
```

`COPILOT_HOME` defaults to `~/.copilot`. Nothing is stored in the repository.

## How it works

- `extension.mjs` registers the canvas and actions and runs one loopback HTTP server (`127.0.0.1`, random port) per open instance.
- `store.mjs` holds the durable board store with serialized writes and validation.
- `ui.mjs` renders the static, accessible page (drag and drop, keyboard controls, light and dark themes, live refresh over server-sent events).
- The server rejects requests with an unexpected `Host`, requires `X-Requested-With: kanban` and a matching `Origin` for writes, and caps request bodies at 64 KB.
