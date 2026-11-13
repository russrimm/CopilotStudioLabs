// Extension: agentic-kanban
// A kanban board canvas that the agent and the user edit together. Board state
// is durable and keyed by boardId (see store.mjs); each open canvas instance
// serves the board UI from its own loopback HTTP server.

import { createServer } from "node:http";
import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import { COLUMNS, StoreError, assignCard, createCard, deleteCard, events, getBoard, moveCard, normalizeBoardId, updateCard } from "./store.mjs";
import { renderPage } from "./ui.mjs";

const MAX_BODY_BYTES = 64 * 1024;
const PING_MS = 25_000;
const COLUMN_IDS = COLUMNS.map((c) => c.id);

// instanceId -> { boardId, server, origin, dispose }
const instances = new Map();

const STATUS_BY_CODE = {
    invalid_input: 400,
    invalid_column: 400,
    invalid_board_id: 400,
    card_not_found: 404,
    board_full: 409,
};

function toCanvasError(error) {
    if (error instanceof CanvasError) return error;
    if (error instanceof StoreError) return new CanvasError(error.code, error.message);
    return new CanvasError("internal_error", error instanceof Error ? error.message : String(error));
}

// ---------- HTTP server ----------

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
    });
    res.end(body);
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        const declared = Number(req.headers["content-length"]);
        if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
            reject(new HttpError(413, "Request body is too large (64 KB maximum)."));
            return;
        }
        const chunks = [];
        let size = 0;
        let done = false;
        req.on("data", (chunk) => {
            if (done) return;
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                done = true;
                reject(new HttpError(413, "Request body is too large (64 KB maximum)."));
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            if (done) return;
            done = true;
            if (size === 0) {
                resolve({});
                return;
            }
            if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
                reject(new HttpError(415, "Content-Type must be application/json."));
                return;
            }
            try {
                const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
                resolve(parsed);
            } catch {
                reject(new HttpError(400, "Request body must be a JSON object."));
            }
        });
        req.on("error", (error) => {
            if (!done) {
                done = true;
                reject(error);
            }
        });
    });
}

async function startServer(boardId) {
    const clients = new Set();
    let origin = "";
    let host = "";

    const onChange = (changedBoardId) => {
        if (changedBoardId !== boardId) return;
        for (const client of clients) client.write("data: change\n\n");
    };
    events.on("change", onChange);
    const pinger = setInterval(() => {
        for (const client of clients) client.write(": ping\n\n");
    }, PING_MS);
    pinger.unref();

    async function route(req, res) {
        // Rejecting unexpected Host headers blocks DNS-rebinding attacks.
        if (req.headers.host !== host) throw new HttpError(403, "Forbidden host.");
        const url = new URL(req.url ?? "/", origin);
        const method = req.method ?? "GET";
        const path = url.pathname;

        if (method !== "GET" && method !== "HEAD") {
            const requestOrigin = req.headers.origin;
            if (requestOrigin !== undefined && requestOrigin !== origin) throw new HttpError(403, "Forbidden origin.");
            if (req.headers["x-requested-with"] !== "kanban") throw new HttpError(403, "Missing X-Requested-With header.");
        }

        if (method === "GET" && path === "/") {
            const html = renderPage();
            res.writeHead(200, {
                "Content-Type": "text/html; charset=utf-8",
                "Content-Length": Buffer.byteLength(html),
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
                "Referrer-Policy": "no-referrer",
            });
            res.end(html);
            return;
        }

        if (method === "GET" && path === "/api/board") {
            sendJson(res, 200, { board: await getBoard(boardId), columns: COLUMNS });
            return;
        }

        if (method === "GET" && path === "/events") {
            res.writeHead(200, {
                "Content-Type": "text/event-stream; charset=utf-8",
                "Cache-Control": "no-store",
                Connection: "keep-alive",
                "X-Content-Type-Options": "nosniff",
            });
            res.write("retry: 2000\n: connected\n\n");
            clients.add(res);
            res.on("close", () => clients.delete(res));
            return;
        }

        if (path === "/api/cards") {
            if (method !== "POST") throw new HttpError(405, "Use POST to create a card.");
            await createCard(boardId, await readJsonBody(req), "user");
            sendJson(res, 201, { board: await getBoard(boardId) });
            return;
        }

        const match = /^\/api\/cards\/([^/]+)(?:\/(move|assign|update))?$/.exec(path);
        if (match) {
            const cardId = decodeURIComponent(match[1]);
            const verb = match[2];
            if (!verb) {
                if (method !== "DELETE") throw new HttpError(405, "Use DELETE to remove a card.");
                await deleteCard(boardId, { cardId }, "user");
            } else {
                if (method !== "POST") throw new HttpError(405, `Use POST to ${verb} a card.`);
                const input = { ...(await readJsonBody(req)), cardId };
                if (verb === "move") await moveCard(boardId, input, "user");
                else if (verb === "assign") await assignCard(boardId, input, "user");
                else await updateCard(boardId, input, "user");
            }
            sendJson(res, 200, { board: await getBoard(boardId) });
            return;
        }

        throw new HttpError(404, "Not found.");
    }

    const server = createServer((req, res) => {
        route(req, res).catch((error) => {
            const status = error instanceof HttpError ? error.status : error instanceof StoreError ? (STATUS_BY_CODE[error.code] ?? 500) : 500;
            const message = status === 500 && !(error instanceof StoreError) ? "Internal error." : error.message;
            if (res.headersSent) {
                res.end();
                return;
            }
            if (status === 413) res.setHeader("Connection", "close");
            sendJson(res, status, { error: message });
        });
    });

    // Port 0 lets the OS pick a free port; bind to loopback only.
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    origin = `http://127.0.0.1:${port}`;
    host = `127.0.0.1:${port}`;

    const dispose = async () => {
        events.off("change", onChange);
        clearInterval(pinger);
        for (const client of clients) client.end();
        clients.clear();
        await new Promise((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
        });
    };

    return { server, origin, dispose };
}

// ---------- Canvas wiring ----------

async function disposeInstance(instanceId) {
    const entry = instances.get(instanceId);
    if (!entry) return;
    instances.delete(instanceId);
    await entry.dispose();
}

function boardFor(ctx) {
    const input = ctx.input && typeof ctx.input === "object" ? ctx.input : {};
    try {
        return normalizeBoardId(input.boardId ?? instances.get(ctx.instanceId)?.boardId);
    } catch (error) {
        throw toCanvasError(error);
    }
}

function action(name, description, properties, required, run) {
    return {
        name,
        description,
        inputSchema: {
            type: "object",
            properties: {
                ...properties,
                boardId: { type: "string", description: "Board to act on. Defaults to the board open in this canvas instance." },
            },
            required,
            additionalProperties: false,
        },
        handler: async (ctx) => {
            try {
                return await run(boardFor(ctx), ctx.input ?? {});
            } catch (error) {
                throw toCanvasError(error);
            }
        },
    };
}

const cardId = { type: "string", description: "Card id such as C-1." };
const column = { type: "string", enum: COLUMN_IDS, description: `Target column: ${COLUMN_IDS.join(", ")}.` };

const session = await joinSession({
    canvases: [
        createCanvas({
            id: "agentic-kanban",
            displayName: "Agentic kanban",
            description: "A shared kanban board. The agent and the user create, assign, and move cards; changes persist across sessions.",
            inputSchema: {
                type: "object",
                properties: {
                    boardId: {
                        type: "string",
                        description: "Board to open (letters, digits, '.', '_' or '-'; max 64). Defaults to 'default'.",
                    },
                },
                additionalProperties: false,
            },
            actions: [
                action("get_board", "Return the board: columns and all cards with their id, title, description, assignee and column, plus recent activity.", {}, [], async (boardId) => ({
                    board: await getBoard(boardId),
                    columns: COLUMNS,
                })),
                action(
                    "create_card",
                    "Create a card. Defaults to the backlog column and no assignee.",
                    {
                        title: { type: "string", minLength: 1, maxLength: 200 },
                        description: { type: "string", maxLength: 4000 },
                        assignee: { type: "string", maxLength: 80, description: "Person or agent name." },
                        column,
                    },
                    ["title"],
                    (boardId, input) => createCard(boardId, input, "agent"),
                ),
                action(
                    "assign_card",
                    "Assign a card to a person or agent. Use an empty string to unassign.",
                    { cardId, assignee: { type: "string", maxLength: 80 } },
                    ["cardId", "assignee"],
                    (boardId, input) => assignCard(boardId, input, "agent"),
                ),
                action(
                    "move_card",
                    "Move a card to a column, optionally at a zero-based position (defaults to the end of the column).",
                    { cardId, column, position: { type: "integer", minimum: 0 } },
                    ["cardId", "column"],
                    (boardId, input) => moveCard(boardId, input, "agent"),
                ),
                action(
                    "update_card",
                    "Change a card's title and/or description.",
                    {
                        cardId,
                        title: { type: "string", minLength: 1, maxLength: 200 },
                        description: { type: "string", maxLength: 4000 },
                    },
                    ["cardId"],
                    (boardId, input) => updateCard(boardId, input, "agent"),
                ),
                action("delete_card", "Delete a card permanently.", { cardId }, ["cardId"], (boardId, input) => deleteCard(boardId, input, "agent")),
            ],
            // Idempotent per instanceId; the server is rebuilt only if the boardId changes.
            open: async (ctx) => {
                let boardId;
                try {
                    boardId = normalizeBoardId(ctx.input?.boardId);
                } catch (error) {
                    throw toCanvasError(error);
                }
                let entry = instances.get(ctx.instanceId);
                if (entry && entry.boardId !== boardId) {
                    await disposeInstance(ctx.instanceId);
                    entry = undefined;
                }
                let board;
                try {
                    board = await getBoard(boardId);
                } catch (error) {
                    throw toCanvasError(error);
                }
                if (!entry) {
                    const started = await startServer(boardId);
                    entry = { boardId, ...started };
                    instances.set(ctx.instanceId, entry);
                }
                return {
                    title: `Kanban: ${board.title}`,
                    url: `${entry.origin}/`,
                    status: `${board.cards.length} ${board.cards.length === 1 ? "card" : "cards"}`,
                };
            },
            onClose: async (ctx) => {
                await disposeInstance(ctx.instanceId);
            },
        }),
    ],
});

await session.log("Agentic kanban canvas ready", { ephemeral: true });
