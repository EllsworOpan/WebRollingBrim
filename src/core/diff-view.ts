import { readDiffRows, type DiffRow, type PreparedExport } from './export-review';

export type FoldId = 'before' | 'added' | 'after';
export interface DiffSection {
  start: number; end: number; // Half-open export row range, before folding.
  fold: FoldId | null;
  kind: 'context' | 'added';
}
export type ReviewRow = { kind: 'fold'; section: DiffSection } | DiffRow;
export const DIFF_ROW_HEIGHT = 26;
const MAX_SCROLL_HEIGHT = 8_000_000; // Stay below browser element-height limits.

/** A handful of ranges, even when the source has millions of lines. */
export function diffSections(original: number, insertion: number, added: number, expanded: readonly FoldId[] = []): DiffSection[] {
  const result: DiffSection[] = [];
  const add = (start: number, end: number, kind: DiffSection['kind'], fold: FoldId | null = null) => {
    if (end > start) result.push({ start, end, kind, fold: fold && !expanded.includes(fold) ? fold : null });
  };
  const before = Math.max(0, insertion - 8), end = insertion + added;
  add(0, before, 'context', 'before');
  add(before, insertion, 'context');
  // Keep setup, return, and restoration visible; hide only a substantial middle.
  if (added > 40) {
    add(insertion, insertion + 16, 'added');
    add(insertion + 16, end - 12, 'added', 'added');
    add(end - 12, end, 'added');
  } else add(insertion, end, 'added');
  add(end, Math.min(original + added, end + 8), 'context');
  add(Math.min(original + added, end + 8), original + added, 'context', 'after');
  return result;
}

export const sectionRows = (section: DiffSection) => section.fold ? 1 : section.end - section.start;
export const diffRowCount = (sections: DiffSection[]) => sections.reduce((count, section) => count + sectionRows(section), 0);

/** A hidden target maps to its fold; expand that fold before jumping to the line. */
export function displayRowForOutput(sections: DiffSection[], outputRow: number): number {
  let offset = 0;
  for (const section of sections) {
    if (outputRow >= section.start && outputRow < section.end) return offset + (section.fold ? 0 : outputRow - section.start);
    offset += sectionRows(section);
  }
  return Math.max(0, offset - 1);
}

export async function readReviewRows(review: PreparedExport, index: Uint32Array, sections: DiffSection[], start: number, count: number): Promise<ReviewRow[]> {
  const reads: Promise<ReviewRow[]>[] = [];
  let offset = 0;
  for (const section of sections) {
    const length = sectionRows(section), from = Math.max(start, offset), to = Math.min(start + count, offset + length);
    if (to > from) reads.push(section.fold
      ? Promise.resolve([{ kind: 'fold', section }])
      : readDiffRows(review, index, section.start + from - offset, to - from));
    offset += length;
  }
  return (await Promise.all(reads)).flat();
}

/** Compress only the scrollbar for huge files, keeping every rendered row full height. */
export function diffViewport(count: number, viewport: number, scrollTop: number) {
  const height = Math.min(count * DIFF_ROW_HEIGHT, MAX_SCROLL_HEIGHT);
  const maxScroll = Math.max(0, height - viewport), logicalMax = Math.max(0, count * DIFF_ROW_HEIGHT - viewport);
  const top = Math.max(0, Math.min(scrollTop, maxScroll));
  const logicalTop = maxScroll ? top / maxScroll * logicalMax : 0;
  const start = Math.max(0, Math.floor(logicalTop / DIFF_ROW_HEIGHT) - 12);
  const end = Math.min(count, Math.ceil((logicalTop + viewport) / DIFF_ROW_HEIGHT) + 12);
  return { height, start, end, offset: top - (logicalTop - start * DIFF_ROW_HEIGHT) };
}

export function scrollTopForRow(count: number, viewport: number, row: number) {
  const logicalMax = Math.max(0, count * DIFF_ROW_HEIGHT - viewport);
  const physicalMax = Math.max(0, Math.min(count * DIFF_ROW_HEIGHT, MAX_SCROLL_HEIGHT) - viewport);
  const target = Math.max(0, Math.min(row * DIFF_ROW_HEIGHT - viewport / 2 + DIFF_ROW_HEIGHT / 2, logicalMax));
  return logicalMax ? target / logicalMax * physicalMax : 0;
}
