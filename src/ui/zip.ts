/**
 * Minimal, dependency-free ZIP writer (STORE method — no compression).
 *
 * Why: the batch "Tải tất cả (.zip)" feature needs a real archive, and we do
 * not want to pull a third-party dependency (or WASM) into the main bundle.
 * PNG files are already DEFLATE-compressed, so storing them is essentially
 * free in size. Output is a spec-compliant ZIP (PKWARE APPNOTE 6.3) with
 * UTF-8 file name flags, which every OS/browser unzips fine.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  /** File name inside the archive, e.g. "anh-no-bg.png". */
  name: string;
  data: Uint8Array;
  /** Modification time; defaults to now. */
  date?: Date;
}

/** MS-DOS date/time pair used inside ZIP headers. */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time:
      (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * Copy into a freshly allocated, exactly-sized ArrayBuffer (TS 5.7+ types
 * BlobPart as ArrayBufferView<ArrayBuffer>, which Uint8Array<ArrayBufferLike>
 * does not satisfy).
 */
function toBlobPart(bytes: Uint8Array): BlobPart {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

/** Deduplicate names inside the archive ("a.png" → "a (2).png"). */
export function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name.toLowerCase())) {
    taken.add(name.toLowerCase());
    return name;
  }
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; n < 10_000; n++) {
    const candidate = `${base} (${n})${ext}`;
    if (!taken.has(candidate.toLowerCase())) {
      taken.add(candidate.toLowerCase());
      return candidate;
    }
  }
  const fallback = `${base}-${Date.now()}${ext}`;
  taken.add(fallback.toLowerCase());
  return fallback;
}

/** Build a ZIP archive blob from in-memory entries. */
export function createZip(entries: ZipEntry[]): Blob {
  const encoder = new TextEncoder();
  const parts: BlobPart[] = [];
  const central: Uint8Array[] = [];
  const taken = new Set<string>();
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(uniqueName(entry.name, taken));
    const data = entry.data;
    const crc = crc32(data);
    const { time, date } = dosDateTime(entry.date ?? new Date());
    const flags = 0x0800; // bit 11: UTF-8 file name

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // local file header signature
    lv.setUint16(4, 20, true); // version needed (2.0)
    lv.setUint16(6, flags, true);
    lv.setUint16(8, 0, true); // method: store
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true); // compressed size
    lv.setUint32(22, data.length, true); // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra field length
    local.set(nameBytes, 30);

    parts.push(local, new Uint8Array(data));

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); // central directory signature
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, flags, true);
    cv.setUint16(10, 0, true); // method: store
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true); // extra
    cv.setUint16(32, 0, true); // comment
    cv.setUint16(34, 0, true); // disk number start
    cv.setUint16(36, 0, true); // internal attrs
    cv.setUint32(38, 0, true); // external attrs
    cv.setUint32(42, offset, true); // relative offset of local header
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length + data.length;
  }

  const centralSize = central.reduce((sum, c) => sum + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); // end of central directory signature
  ev.setUint16(4, 0, true); // this disk
  ev.setUint16(6, 0, true); // disk with central directory
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true); // comment length

  const chunks: BlobPart[] = (parts as Uint8Array[]).map((chunk) => toBlobPart(chunk));
  for (const chunk of central) chunks.push(toBlobPart(chunk));
  chunks.push(toBlobPart(end));
  return new Blob(chunks, { type: 'application/zip' });
}

/** Convenience: zip a list of blobs with UTF-8 names. */
export async function zipBlobs(files: { name: string; blob: Blob }[]): Promise<Blob> {
  const entries: ZipEntry[] = [];
  for (const file of files) {
    entries.push({
      name: file.name,
      data: new Uint8Array(await file.blob.arrayBuffer()),
    });
  }
  return createZip(entries);
}
