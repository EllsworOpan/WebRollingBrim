import { createInsertion } from './export';
import { validateGeneratedGcode } from './generated-gcode';
import { encodeBgcodeBlocks, type BgcodeIndex } from './bgcode';
import type { BrimResult, ExportMode, ParsedJob } from './types';

export interface PreparedExport {
  source: File;
  output: Blob;
  name: string;
  addedLines: string[];
  insertionLine: number;
  insertionByteOffset: number;
  insertionDescription: string;
  format?: 'bgcode';
}

/** The diff uses decoded source lines; the immutable download remains binary. */
export async function prepareBgcodeExport(original: File, source: File, binary: BgcodeIndex, job: ParsedJob, brim: BrimResult, mode: ExportMode): Promise<PreparedExport> {
  if (original.size !== binary.sourceBytes || source.size !== job.bytes) throw new Error('The source file does not match this preview.');
  const added = createInsertion(job, brim, mode);
  const { byteOffset, line } = job.insertion!;
  const block = binary.blocks.find(part => byteOffset >= part.textStart && byteOffset < part.textEnd);
  if (!block) throw new Error('The insertion point is outside the binary G-code blocks.');
  const before = await source.slice(block.textStart, byteOffset).arrayBuffer();
  const after = await source.slice(byteOffset, block.textEnd).arrayBuffer();
  // Check the final generated commands immediately before combining them with
  // original decoded bytes and wrapping the changed region in binary blocks.
  validateGeneratedGcode(added, mode);
  const changed = new Uint8Array(await new Blob([before, added, after]).arrayBuffer());
  return {
    source, format: 'bgcode',
    output: new Blob([original.slice(0, block.start), ...encodeBgcodeBlocks(changed, binary.checksum), original.slice(block.end)], { type: 'application/octet-stream' }),
    name: original.name.replace(/\.(bgcode|gcode|gco|gc)$/i, '') + '_rolling_brim.bgcode',
    addedLines: added.split(job.newline).slice(0, -1),
    insertionLine: line, insertionByteOffset: byteOffset, insertionDescription: job.insertion!.reason,
  };
}

/** The review and download share this immutable output; never regenerate on download. */
export function prepareExport(source: File, job: ParsedJob, brim: BrimResult, mode: ExportMode): PreparedExport {
  if (source.size !== job.bytes) throw new Error('The source file does not match this preview.');
  const added = createInsertion(job, brim, mode);
  const { byteOffset, line } = job.insertion!;
  validateGeneratedGcode(added, mode);
  return {
    source,
    output: new Blob([source.slice(0, byteOffset), added, source.slice(byteOffset)], { type: 'text/plain;charset=utf-8' }),
    name: source.name.replace(/\.(gcode|gco|gc)$/i, '') + '_rolling_brim.gcode',
    addedLines: added.split(job.newline).slice(0, -1),
    insertionLine: line,
    insertionByteOffset: byteOffset,
    insertionDescription: job.insertion!.reason,
  };
}

/** Index byte offsets, without keeping a decoded copy of a potentially 200 MB file. */
export async function indexLines(source: Blob, signal?: AbortSignal): Promise<Uint32Array> {
  let offsets = new Uint32Array(1024), count = source.size ? 1 : 0, position = 0, previousCR = false;
  const push = (offset: number) => {
    if (count === offsets.length) { const grown = new Uint32Array(count * 2); grown.set(offsets); offsets = grown; }
    offsets[count++] = offset;
  };
  const reader = source.stream().getReader();
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      for (const byte of value) {
        position++;
        if (byte === 10 && previousCR) offsets[count - 1] = position;
        else if (byte === 10 || byte === 13) push(position);
        previousCR = byte === 13;
      }
    }
    signal?.throwIfAborted();
  } finally { await reader.cancel(); reader.releaseLock(); }
  if (count && offsets[count - 1] === source.size) count--;
  return offsets.slice(0, count);
}

export interface DiffRow {
  kind: 'context' | 'added';
  originalLine: number | null;
  outputLine: number;
  text: string;
}

/** Zero-based output row range. Unchanged rows map directly to original byte slices. */
export async function readDiffRows(review: PreparedExport, index: Uint32Array, start: number, count: number): Promise<DiffRow[]> {
  const insertion = review.insertionLine - 1, added = review.addedLines.length;
  if (index[insertion] !== review.insertionByteOffset) throw new Error('The source insertion point does not match this review.');
  const end = Math.min(start + count, index.length + added), rows: DiffRow[] = [];
  for (let i = start; i < end; i++) {
    const isAdded = i >= insertion && i < insertion + added;
    rows.push({
      kind: isAdded ? 'added' : 'context',
      originalLine: isAdded ? null : i < insertion ? i + 1 : i - added + 1,
      outputLine: i + 1,
      text: isAdded ? review.addedLines[i - insertion] : '',
    });
  }
  const originalRows = rows.filter(row => row.originalLine !== null);
  if (originalRows.length) {
    const first = originalRows[0].originalLine! - 1, last = originalRows.at(-1)!.originalLine! - 1;
    const text = await review.source.slice(index[first], index[last + 1] ?? review.source.size).text();
    const lines = text.split(/\r\n|\n|\r/);
    for (const row of originalRows) row.text = lines[row.originalLine! - 1 - first];
  }
  return rows;
}
