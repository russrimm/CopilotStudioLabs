// Durable kanban storage. One JSON file per board under
// $COPILOT_HOME/extensions/agentic-kanban/artifacts/boards/<boardId>.json.
// Board state is keyed by boardId (the domain ID), never by canvas instanceId.

import { EventEmitter } from "node:events";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const COLUMNS = Object.freeze([
    { id: "backlog", title: "Backlog" },
    { id: "in-progress", title: "In progress" },
    { id: "review", title: "Review" },
    { id: "done", title: "Done" },
]);

const BOARD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LIMITS = { title: 200, description: 4000, assignee: 80, cards: 500, activity: 50 };

export class StoreError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

export const events = new EventEmitter();
events.setMaxListeners(100);

const chains = new Map(); // boardId -> promise chain that serializes mutations

function boardsDir() {
    const home = process.env.COPILOT_HOME || join(homedir(), ".copilot");
    return join(home, "extensions", "agentic-kanban", "artifacts", "boards");
}

export function normalizeBoardId(value) {
    const id = value === undefined || value === null || value === "" ? "default" : String(value);
    if (!BOARD_ID_RE.test(id)) {
        throw new StoreError(
            "invalid_board_id",
            "boardId must start with a letter or digit and use only letters, digits, '.', '_' or '-' (max 64 characters).",
        );
    }
    return id;
}

function emptyBoard(boardId) {
    return { version: 1, boardId, title: boardId === "default" ? "Kanban board" : boardId, nextId: 1, cards: [], activity: [] };
}

async function load(boardId) {
    const file = join(boardsDir(), `${boardId}.json`);
    try {
        const parsed = JSON.parse(await readFile(file, "utf8"));
        if (!parsed || !Array.isArray(parsed.cards)) throw new Error("malformed board file");
        return { ...emptyBoard(boardId), ...parsed, boardId };
    } catch (error) {
        if (error && error.code === "ENOENT") return emptyBoard(boardId);
        throw new StoreError("board_unreadable", `Could not read board '${boardId}': ${error.message}`);
    }
}

async function save(boardId, data) {
    const dir = boardsDir();
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${boardId}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await rename(tmp, file);
}

// Serializes mutations per board so concurrent UI and agent edits never
// interleave. Each mutation re-reads the file, so a board shared by several
// extension processes (one per session) never overwrites another's changes.
function mutate(boardId, fn) {
    const run = async () => {
        const draft = await load(boardId);
        const result = fn(draft);
        await save(boardId, draft);
        events.emit("change", boardId);
        return result;
    };
    const pending = (chains.get(boardId) ?? Promise.resolve()).then(run);
    chains.set(boardId, pending.catch(() => {}));
    return pending;
}

function cleanText(value, field, { required = false, max }) {
    if (value === undefined || value === null) {
        if (required) throw new StoreError("invalid_input", `${field} is required.`);
        return undefined;
    }
    const text = String(value).trim();
    if (required && !text) throw new StoreError("invalid_input", `${field} must not be empty.`);
    if (text.length > max) throw new StoreError("invalid_input", `${field} must be at most ${max} characters.`);
    return text;
}

export function resolveColumn(value) {
    const wanted = String(value ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-");
    const match = COLUMNS.find((c) => c.id === wanted || c.title.toLowerCase().replace(/\s+/g, "-") === wanted);
    if (!match) {
        throw new StoreError("invalid_column", `Unknown column '${value}'. Use one of: ${COLUMNS.map((c) => c.id).join(", ")}.`);
    }
    return match.id;
}

function findCard(data, cardId) {
    const id = String(cardId ?? "").trim().toUpperCase();
    const card = data.cards.find((c) => c.id.toUpperCase() === id);
    if (!card) throw new StoreError("card_not_found", `No card '${cardId}' on board '${data.boardId}'.`);
    return card;
}

function log(data, by, text) {
    data.activity.unshift({ at: new Date().toISOString(), by, text });
    data.activity.length = Math.min(data.activity.length, LIMITS.activity);
}

export async function getBoard(boardId) {
    await (chains.get(boardId) ?? Promise.resolve());
    return load(boardId);
}

export function createCard(boardId, input, by = "agent") {
    return mutate(boardId, (data) => {
        if (data.cards.length >= LIMITS.cards) throw new StoreError("board_full", `A board holds at most ${LIMITS.cards} cards.`);
        const now = new Date().toISOString();
        const card = {
            id: `C-${data.nextId++}`,
            title: cleanText(input.title, "title", { required: true, max: LIMITS.title }),
            description: cleanText(input.description, "description", { max: LIMITS.description }) ?? "",
            assignee: cleanText(input.assignee, "assignee", { max: LIMITS.assignee }) ?? "",
            column: input.column === undefined ? "backlog" : resolveColumn(input.column),
            createdAt: now,
            updatedAt: now,
        };
        data.cards.push(card);
        log(data, by, `Created ${card.id} "${card.title}" in ${card.column}`);
        return card;
    });
}

export function assignCard(boardId, input, by = "agent") {
    return mutate(boardId, (data) => {
        const card = findCard(data, input.cardId);
        const assignee = cleanText(input.assignee ?? "", "assignee", { max: LIMITS.assignee });
        card.assignee = assignee;
        card.updatedAt = new Date().toISOString();
        log(data, by, assignee ? `Assigned ${card.id} to ${assignee}` : `Unassigned ${card.id}`);
        return card;
    });
}

export function moveCard(boardId, input, by = "agent") {
    return mutate(boardId, (data) => {
        const card = findCard(data, input.cardId);
        const column = resolveColumn(input.column);
        const from = card.column;
        data.cards.splice(data.cards.indexOf(card), 1);
        card.column = column;
        card.updatedAt = new Date().toISOString();

        const inColumn = data.cards.filter((c) => c.column === column);
        const position = Number.isInteger(input.position) ? Math.max(0, Math.min(input.position, inColumn.length)) : inColumn.length;
        if (position >= inColumn.length) {
            const last = inColumn.at(-1);
            data.cards.splice(last ? data.cards.indexOf(last) + 1 : data.cards.length, 0, card);
        } else {
            data.cards.splice(data.cards.indexOf(inColumn[position]), 0, card);
        }
        if (from !== column) log(data, by, `Moved ${card.id} from ${from} to ${column}`);
        return card;
    });
}

export function updateCard(boardId, input, by = "agent") {
    return mutate(boardId, (data) => {
        const card = findCard(data, input.cardId);
        if (input.title === undefined && input.description === undefined) {
            throw new StoreError("invalid_input", "Provide a title or description to update.");
        }
        if (input.title !== undefined) card.title = cleanText(input.title, "title", { required: true, max: LIMITS.title });
        if (input.description !== undefined) card.description = cleanText(input.description, "description", { max: LIMITS.description });
        card.updatedAt = new Date().toISOString();
        log(data, by, `Edited ${card.id}`);
        return card;
    });
}

export function deleteCard(boardId, input, by = "agent") {
    return mutate(boardId, (data) => {
        const card = findCard(data, input.cardId);
        data.cards.splice(data.cards.indexOf(card), 1);
        log(data, by, `Deleted ${card.id} "${card.title}"`);
        return card;
    });
}
