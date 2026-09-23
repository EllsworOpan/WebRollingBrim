import { heatshrinkDecode, meatpackDecode } from '@chestnutlabs/gcode-bgcode';

export const MAX_SOURCE_BYTES = 200_000_000;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

export interface BgcodeIndex {
  sourceBytes: number;
  checksum: boolean;
  // Byte ranges in the binary source and in the decoded review document.
  blocks: { start: number; end: number; textStart: number; textEnd: number }[];
}

export function isBgcode(bytes: Uint8Array): boolean {
  return bytes[0] === 71 && bytes[1] === 67 && bytes[2] === 68 && bytes[3] === 69;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
export function bgcodeCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

async function decompress(data: Uint8Array<ArrayBuffer>, compression: number, expected: number): Promise<Uint8Array<ArrayBuffer>> {
  if (compression === 0) return data;
  if (compression === 2 || compression === 3) {
    const decoded = heatshrinkDecode(data, compression === 2 ? 11 : 12, 4, expected);
    if (decoded.length !== expected) throw new Error('Invalid bgcode: heatshrink size mismatch.');
    return new Uint8Array(decoded);
  }
  // Prusa uses zlib-wrapped DEFLATE. Read incrementally and cap output before
  // allocating beyond the declared size; cancellation also stops decompression.
  const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  const output = new Uint8Array(expected);
  let offset = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (offset + value.length > expected) throw new Error('Invalid bgcode: DEFLATE exceeds its declared size.');
      output.set(value, offset); offset += value.length;
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  if (offset !== expected) throw new Error('Invalid bgcode: DEFLATE size mismatch.');
  return output;
}

/** v1 layout from Prusa's published specification. Codec implementations are
 * supplied by the permissively licensed decoder; no libbgcode code is bundled.
 */
export async function decodeBgcode(bytes: Uint8Array<ArrayBuffer>, limit = MAX_SOURCE_BYTES): Promise<{ bytes: Uint8Array<ArrayBuffer>; index: BgcodeIndex }> {
  if (bytes.length > limit) throw new Error('Bgcode exceeds the 200 MB browser limit.');
  if (bytes.length < 10 || !isBgcode(bytes)) throw new Error('Invalid bgcode: missing GCDE file header.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) !== 1) throw new Error('Unsupported bgcode version. Only version 1 is supported.');
  const checksumType = view.getUint16(8, true);
  if (checksumType > 1) throw new Error('Unsupported bgcode checksum type.');
  const index: BgcodeIndex = { sourceBytes: bytes.length, checksum: checksumType === 1, blocks: [] };
  const code: Uint8Array<ArrayBuffer>[] = [], metadata: string[] = [];
  let config = '', producer = '', offset = 10, total = 0, codeSize = 0, stage = 0, count = 0;
  const requireBytes = (length: number) => { if (offset + length > bytes.length) throw new Error('Invalid bgcode: truncated block.'); };
  const comments = (text: string) => text.split(/\r\n|\n|\r/).map(line => `; ${line}\n`).join('');
  while (offset < bytes.length) {
    if (++count > 100_000) throw new Error('Bgcode has too many blocks for browser processing.');
    const start = offset;
    requireBytes(8);
    const type = view.getUint16(offset, true), compression = view.getUint16(offset + 2, true), size = view.getUint32(offset + 4, true);
    offset += 8;
    if (type > 5 || compression > 3) throw new Error('Unsupported bgcode block type or compression.');
    // Ordered metadata, optional thumbnails, then only G-code. Never interpret
    // an unknown block as G-code or silently ignore a later settings block.
    if (type === 0 && stage === 0) stage = 1;
    else if (type === 3 && stage <= 1) stage = 2;
    else if (type === 5 && stage === 2) { /* optional thumbnails */ }
    else if (type === 4 && stage === 2) stage = 3;
    else if (type === 2 && stage === 3) stage = 4;
    else if (type === 1 && stage >= 4) stage = 5;
    else throw new Error('Invalid bgcode: unsupported block order or missing metadata.');
    let storedSize = size;
    if (compression !== 0) { requireBytes(4); storedSize = view.getUint32(offset, true); offset += 4; }
    requireBytes(type === 5 ? 6 : 2);
    const encoding = view.getUint16(offset, true);
    if (type === 1 ? encoding > 2 : type === 5 ? encoding > 2 : encoding !== 0) throw new Error('Unsupported bgcode block encoding.');
    offset += type === 5 ? 6 : 2;
    requireBytes(storedSize + (index.checksum ? 4 : 0));
    const data = bytes.subarray(offset, offset + storedSize);
    offset += storedSize;
    if (index.checksum) {
      if (bgcodeCrc32(bytes.subarray(start, offset)) !== view.getUint32(offset, true)) throw new Error(`Invalid bgcode: checksum mismatch at byte ${start}.`);
      offset += 4;
    }
    if (size > limit - total) throw new Error('Decoded bgcode exceeds the 200 MB browser limit.');
    // Images are kept as original binary blocks, without decoding image data.
    if (type === 5) { total += size; continue; }
    let raw = await decompress(data, compression, size);
    if (type === 1 && encoding !== 0) raw = new Uint8Array(meatpackDecode(raw, limit - total));
    total += raw.length;
    if (total > limit) throw new Error('Decoded bgcode exceeds the 200 MB browser limit.');
    const text = decoder.decode(raw);
    if (text.includes('\0')) throw new Error('Invalid bgcode: decoded text contains a NUL byte.');
    if (type === 1) {
      code.push(raw);
      index.blocks.push({ start, end: offset, textStart: codeSize, textEnd: codeSize + raw.length });
      codeSize += raw.length;
    } else if (type === 2) config = comments(text);
    else {
      metadata.push(comments(text));
      if (type === 0) producer = text.match(/^Producer\s*=\s*([^\r\n]*)/m)?.[1].trim() || '';
    }
  }
  if (stage !== 5 || !codeSize) throw new Error('Invalid bgcode: missing metadata or G-code blocks.');
  // Metadata becomes comments solely for the existing parser/viewer. Export
  // copies its original binary blocks, never these reconstructed comments.
  const header = encoder.encode(`; generated by ${producer || 'Unknown'}\n${metadata.join('')}\n`);
  const footer = encoder.encode(`\n; prusaslicer_config = begin\n${config}; prusaslicer_config = end\n`);
  if (header.length + codeSize + footer.length > limit) throw new Error('Decoded bgcode exceeds the 200 MB browser limit.');
  const decoded = new Uint8Array(header.length + codeSize + footer.length);
  decoded.set(header); let pos = header.length;
  for (const part of code) { decoded.set(part, pos); pos += part.length; }
  decoded.set(footer, pos);
  for (const block of index.blocks) { block.textStart += header.length; block.textEnd += header.length; }
  return { bytes: decoded, index };
}

/** Store only the changed G-code region as ordinary uncompressed v1 blocks.
 * Each block is capped at 64 KiB and ends at a line boundary when possible.
 * All untouched compressed blocks and metadata are copied by the caller.
 */
export function encodeBgcodeBlocks(bytes: Uint8Array<ArrayBuffer>, checksum: boolean): Uint8Array<ArrayBuffer>[] {
  const blocks: Uint8Array<ArrayBuffer>[] = [];
  for (let start = 0; start < bytes.length;) {
    let end = Math.min(start + 65536, bytes.length);
    if (end < bytes.length) {
      while (end > start && ((bytes[end - 1] !== 10 && bytes[end - 1] !== 13)
        || (bytes[end - 1] === 13 && bytes[end] === 10))) end--;
      if (end === start) throw new Error('Cannot export bgcode: a G-code line exceeds 64 KiB.');
    }
    const block = new Uint8Array(10 + end - start + (checksum ? 4 : 0));
    const view = new DataView(block.buffer);
    view.setUint16(0, 1, true); // GCode, no compression, no encoding
    view.setUint32(4, end - start, true);
    block.set(bytes.subarray(start, end), 10);
    if (checksum) view.setUint32(block.length - 4, bgcodeCrc32(block.subarray(0, -4)), true);
    blocks.push(block); start = end;
  }
  return blocks;
}
