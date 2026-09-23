import { describe, expect, it } from 'vitest';
import { DIFF_ROW_HEIGHT, diffSections, diffRowCount, diffViewport, displayRowForOutput, readReviewRows, scrollTopForRow, type FoldId } from '../src/core/diff-view';
import { indexLines, type PreparedExport } from '../src/core/export-review';

describe('continuous, folded export review', () => {
  const original = 1000, insertion = 100, added = 500;
  it('labels the middle as added and places unchanged folds only outside the insertion', () => {
    const sections = diffSections(original, insertion, added);
    expect(sections.filter(section => section.fold)).toEqual([
      { start: 0, end: 92, kind: 'context', fold: 'before' },
      { start: 116, end: 588, kind: 'added', fold: 'added' },
      { start: 608, end: 1500, kind: 'context', fold: 'after' },
    ]);
    expect(diffRowCount(sections)).toBe(47);
    expect(sections.reduce((sum, section) => sum + section.end - section.start, 0)).toBe(original + added);
    for (let i = 1; i < sections.length; i++) expect(sections[i].start).toBe(sections[i - 1].end);
  });

  it('opens each fold independently, retaining exact line positions and full-file coverage', () => {
    for (const fold of ['before', 'added', 'after'] as FoldId[]) {
      const collapsed = diffSections(original, insertion, added);
      const section = collapsed.find(section => section.fold === fold)!;
      const expanded = diffSections(original, insertion, added, [fold]);
      expect(diffRowCount(expanded)).toBe(diffRowCount(collapsed) + section.end - section.start - 1);
      expect(displayRowForOutput(expanded, section.end - 1) - displayRowForOutput(expanded, section.start)).toBe(section.end - section.start - 1);
    }
    const full = diffSections(original, insertion, added, ['before', 'added', 'after']);
    expect(diffRowCount(full)).toBe(original + added);
    for (const row of [0, 99, 100, 599, 600, 1499]) expect(displayRowForOutput(full, row)).toBe(row);
  });

  it('handles a short insertion at either end without empty folds or lost rows', () => {
    for (const position of [0, 1, 5]) {
      const sections = diffSections(5, position, 4);
      expect(sections.every(section => !section.fold && section.end > section.start)).toBe(true);
      expect(diffRowCount(sections)).toBe(9);
    }
  });

  it('reads across folded boundaries without reading or decoding the hidden source', async () => {
    const source = new File([Array.from({ length: original }, (_, i) => `original ${i + 1}\n`).join('')], 'large.gcode');
    const index = await indexLines(source), byteOffset = index[insertion];
    const addedLines = Array.from({ length: added }, (_, i) => `added ${i + 1}`);
    const review: PreparedExport = { source, output: new Blob(), name: 'out.gcode', addedLines, insertionLine: insertion + 1, insertionByteOffset: byteOffset, insertionDescription: 'Test insertion' };
    const sections = diffSections(original, insertion, added);
    const rows = await readReviewRows(review, index, sections, 0, diffRowCount(sections));
    expect(rows.filter(row => row.kind !== 'fold').map(row => row.text)).toEqual([
      ...Array.from({ length: 8 }, (_, i) => `original ${93 + i}`),
      ...addedLines.slice(0, 16), ...addedLines.slice(-12),
      ...Array.from({ length: 8 }, (_, i) => `original ${101 + i}`),
    ]);
    const full = diffSections(original, insertion, added, ['before', 'added', 'after']);
    // Read adjoining windows as a continuous stream, including both boundaries.
    const continuous = [];
    for (let start = 95; start < 605; start += 17) continuous.push(...await readReviewRows(review, index, full, start, Math.min(17, 605 - start)));
    expect(continuous.map(row => row.kind !== 'fold' && row.outputLine)).toEqual(Array.from({ length: 510 }, (_, i) => 96 + i));
    expect(continuous[5]).toMatchObject({ kind: 'added', text: 'added 1', originalLine: null });
    expect(continuous[505]).toMatchObject({ kind: 'context', text: 'original 101', originalLine: 101 });
  });

  it('virtualizes ordinary and very large files with reachable first/last lines and accurate jumps', () => {
    for (const count of [20, 1000, 4_000_000, 100_000_000]) {
      for (const viewport of [180, 420]) {
        const first = diffViewport(count, viewport, 0);
        expect(first.start).toBe(0);
        expect(first.height).toBeLessThanOrEqual(8_000_000);
        const last = diffViewport(count, viewport, first.height);
        expect(last.end).toBe(count);
        for (const row of [0, Math.floor(count / 2), count - 1]) {
          const scroll = scrollTopForRow(count, viewport, row);
          const visible = diffViewport(count, viewport, scroll);
          expect(row).toBeGreaterThanOrEqual(visible.start);
          expect(row).toBeLessThan(visible.end);
          const rowTop = visible.offset + (row - visible.start) * DIFF_ROW_HEIGHT - scroll;
          expect(rowTop).toBeGreaterThanOrEqual(-0.001);
          expect(rowTop).toBeLessThanOrEqual(viewport - DIFF_ROW_HEIGHT + 0.001);
          expect(visible.end - visible.start).toBeLessThan(45);
        }
      }
    }
  });
});
