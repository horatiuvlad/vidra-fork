import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

/**
 * A minimal, deterministic ZIP writer.
 *
 * Written by hand rather than pulled in as a dependency for two reasons. The CLI
 * ships with three runtime dependencies and adding an archiver for one command is
 * a poor trade; and the archive has to be *deterministic* — the same `ui/dist`
 * must produce the same bytes, and therefore the same sha256, so republishing an
 * unchanged bundle is a no-op rather than a new entry every publisher's users
 * download again. Every timestamp is pinned to the start of the DOS epoch and
 * entries are written in sorted order.
 *
 * The consumer is .NET's `ZipFile.OpenRead`, which the OTA end-to-end test
 * exercises on both macOS and Windows.
 */

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const DEFLATE = 8;
// 1980-01-01 00:00:00, the earliest a DOS timestamp can express.
const DOS_DATE = 0x0021;
const DOS_TIME = 0x0000;

const crcTable = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export const crc32 = (data: Buffer): number => {
  let c = 0xffffffff;
  for (const byte of data) {
    c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
};

export interface ZipFileEntry {
  /** Path inside the archive, always with forward slashes. */
  name: string;
  content: Buffer;
}

/** Builds a ZIP archive in memory. */
export const createZip = (entries: ZipFileEntry[]): Buffer => {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of sorted) {
    const name = Buffer.from(entry.name.replace(/\\/g, "/"), "utf8");
    const deflated = zlib.deflateRawSync(entry.content, { level: 9 });
    const checksum = crc32(entry.content);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(DEFLATE, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(entry.content.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length

    locals.push(local, name, deflated);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_HEADER, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(DEFLATE, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(entry.content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attributes
    // Regular file, rw-r--r--. The shift has to be made unsigned again: in JS
    // `<<` works on signed 32-bit integers, so this value comes out negative.
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);

    centrals.push(central, name);
    offset += local.length + name.length + deflated.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(0, 4); // disk number
  end.writeUInt16LE(0, 6); // disk with central directory
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...locals, centralDirectory, end]);
};

/** Reads a directory tree into archive entries, relative to {@link root}. */
export const readDirectoryEntries = (root: string): ZipFileEntry[] => {
  const entries: ZipFileEntry[] = [];

  const walk = (dir: string, prefix: string): void => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const full = path.join(dir, item.name);
      const name = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) {
        walk(full, name);
      } else if (item.isFile()) {
        entries.push({ name, content: fs.readFileSync(full) });
      }
    }
  };

  walk(root, "");
  return entries;
};
