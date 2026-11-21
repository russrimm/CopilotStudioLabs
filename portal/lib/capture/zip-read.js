/**
 * A small, strict ZIP reader for the "Import screenshots" upload. It reads everything into memory and never touches the
 * file system, so an entry name can never reach a path. It reads only what a normal archive tool writes (stored or
 * deflated entries, no encryption, no ZIP64) and refuses anything that could be a zip bomb:
 *
 *   - at most `maxEntries` entries;
 *   - each entry's declared and actual size at most `maxEntryBytes`, and all of them together at most `maxTotalBytes`;
 *   - the CRC-32 of every entry must match.
 */

import zlib from "node:zlib";

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export class ZipError extends Error {}

/**
 * @param {Buffer} buffer the whole ZIP file
 * @param {{maxEntries?: number, maxEntryBytes?: number, maxTotalBytes?: number}} [limits]
 * @returns {Array<{name: string, size: number, read: () => Buffer}>} the file entries (folders are left out)
 */
export function readZipEntries(buffer, { maxEntries = 1000, maxEntryBytes = 8 * 1024 * 1024, maxTotalBytes = 256 * 1024 * 1024 } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new ZipError("That is not a ZIP file.");
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65535); i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("That is not a ZIP file.");
  const count = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new ZipError("ZIP64 archives are not supported. Make the ZIP smaller or split it.");
  if (count > maxEntries) throw new ZipError(`The ZIP has more than ${maxEntries} files.`);
  if (centralOffset + centralSize > buffer.length) throw new ZipError("The ZIP is damaged.");

  const entries = [];
  let declaredTotal = 0;
  let at = centralOffset;
  for (let n = 0; n < count; n += 1) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== CENTRAL) throw new ZipError("The ZIP is damaged.");
    const flags = buffer.readUInt16LE(at + 8);
    const method = buffer.readUInt16LE(at + 10);
    const crc = buffer.readUInt32LE(at + 16);
    const compressed = buffer.readUInt32LE(at + 20);
    const size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const localOffset = buffer.readUInt32LE(at + 42);
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    if (flags & 1) throw new ZipError("Encrypted ZIPs are not supported.");
    if (compressed === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new ZipError("ZIP64 archives are not supported. Make the ZIP smaller or split it.");
    declaredTotal += size;
    if (declaredTotal > maxTotalBytes) throw new ZipError("The ZIP expands to more than the allowed size.");
    entries.push({
      name,
      size,
      tooLarge: size > maxEntryBytes,
      read() {
        if (size > maxEntryBytes) throw new ZipError(`${name} is larger than ${Math.round(maxEntryBytes / 1048576)} MB.`);
        if (method !== 0 && method !== 8) throw new ZipError(`${name} uses a compression method this import does not read.`);
        if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL) throw new ZipError("The ZIP is damaged.");
        const start = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
        if (start + compressed > buffer.length) throw new ZipError("The ZIP is damaged.");
        const raw = buffer.subarray(start, start + compressed);
        let out;
        try {
          out = method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, Math.min(size, maxEntryBytes)) });
        } catch {
          throw new ZipError(`${name} could not be unpacked.`);
        }
        if (out.length !== size || zlib.crc32(out) >>> 0 !== crc) throw new ZipError(`${name} is damaged (its checksum does not match).`);
        return out;
      },
    });
  }
  return entries;
}
