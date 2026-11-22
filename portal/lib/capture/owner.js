/**
 * Who started a capture, as far as the portal can tell.
 *
 * With sign-in on, the owner is the signed-in person. With sign-in off (the demo default) the owner is the browser's
 * private client id (see ../concurrency/visitor.js). Both are stored only as a one-way key ("u-" or "c-" and 32 hex
 * characters), never as the id or the person, and the key is never sent back to a browser. A caller with neither gets no
 * owner: such calls stay permissive, like every capture before owners existed.
 *
 * An owner separates people's captures and stops them colliding. It is NOT a security boundary: anyone can send any id.
 */

import { createHash } from "node:crypto";

import { clientOwnerKey, readClientId, signedInIdentity } from "../concurrency/visitor.js";

const OWNER_KEY_RE = /^[cu]-[a-f0-9]{32}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{22,64}$/;

/** A key that is safe to store and compare, or null. Old files carry no key at all. */
export function cleanOwnerKey(value) {
  return typeof value === "string" && OWNER_KEY_RE.test(value) ? value : null;
}

/** The owner key of a signed-in person: "u-" and 32 hex characters. */
export function userOwnerKey(identity) {
  return `u-${createHash("sha256").update(`user:${identity}`).digest("hex").slice(0, 32)}`;
}

/** The client id the caller sent: the header, or the `cid` address parameter a progress stream (EventSource) uses because it cannot send headers. */
function callerClientId(req) {
  const fromHeader = readClientId(req);
  if (fromHeader) return fromHeader;
  const query = req?.query?.cid;
  return typeof query === "string" && CLIENT_ID_RE.test(query) ? query : null;
}

/** Who is asking: the signed-in person, else this browser's client id, else nobody (null). */
export function ownerOf(req) {
  const person = signedInIdentity(req?.user);
  if (person) return userOwnerKey(person);
  const clientId = callerClientId(req);
  return clientId ? clientOwnerKey(clientId) : null;
}

/**
 * Whether a computer paired by `deviceOwner` may work for `otherOwner` (a job, or the person asking). A computer paired
 * before owners existed (no owner) works for anyone, and so does a request with no owner: the migration rule.
 */
export function canServe(deviceOwner, otherOwner) {
  const device = cleanOwnerKey(deviceOwner);
  const other = cleanOwnerKey(otherOwner);
  return !device || !other || device === other;
}

/** `true` when both sides have an owner and it is the same one, `false` when they differ, `null` when either side has none. */
export function mineFlag(jobOwner, viewerOwner) {
  const job = cleanOwnerKey(jobOwner);
  const viewer = cleanOwnerKey(viewerOwner);
  if (!job || !viewer) return null;
  return job === viewer;
}

/** Whether two owners are different people: both known and not the same. */
export function differentPeople(a, b) {
  return mineFlag(a, b) === false;
}
