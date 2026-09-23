import { describe, expect, it } from 'vitest';
import { prepareExport, indexLines, readDiffRows } from '../src/core/export-review';
import { parseGcode } from '../src/core/gcode';
import { buildFootprint, generateBrim } from '../src/core/geometry';
import { DEFAULT_BRIM } from '../src/core/types';
import { fixtureSource } from './fixtures';

const prepare = (source = fixtureSource()) => {
  const file = new File([source], 'test.gcode');
  const job = parseGcode(source), brim = generateBrim(buildFootprint(job), job, DEFAULT_BRIM);
  return { job, brim, review: prepareExport(file, job, brim, 'standard') };
};

describe('export diff and shared download', () => {
  for (const newline of ['\n', '\r\n', '\r']) it(`maps inserted and original lines to the exact output with ${JSON.stringify(newline)}`, async () => {
    const source = '\uFEFF' + fixtureSource().trimEnd().replaceAll('\n', newline);
    const { review } = prepare(source), index = await indexLines(review.source);
    const rows = await readDiffRows(review, index, 0, index.length + review.addedLines.length);
    const output = await review.output.text();
    expect(rows.map(row => row.text)).toEqual(output.split(/\r\n|\n|\r/));
    expect(rows.filter(row => row.kind === 'context').map(row => row.text)).toEqual(source.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/));
    const insertion = rows.findIndex(row => row.kind === 'added');
    expect(insertion + 1).toBe(review.insertionLine);
    expect(rows[insertion].originalLine).toBeNull();
    expect(rows[insertion].text).toBe('; ROLLING_BRIM_BEGIN v1');
    expect(rows[insertion + review.addedLines.length - 1].text).toBe('; ROLLING_BRIM_END');
    expect(rows[insertion + review.addedLines.length].originalLine).toBe(review.insertionLine);
    expect(rows[insertion + review.addedLines.length].text).toBe('G1 X40 Y20 E1');
    const bytes = new Uint8Array(await review.output.arrayBuffer());
    const original = new Uint8Array(await review.source.arrayBuffer());
    const addedBytes = review.output.size - review.source.size;
    expect(bytes.slice(0, review.insertionByteOffset)).toEqual(original.slice(0, review.insertionByteOffset));
    expect(bytes.slice(review.insertionByteOffset + addedBytes)).toEqual(original.slice(review.insertionByteOffset));
  });

  it('indexes mixed newlines, UTF-8 and a CRLF split across stream chunks', async () => {
    const source = ';' + 'x'.repeat(65534) + '\r\n; café\n\rblank\rlast';
    const bytes = new TextEncoder().encode(source);
    // Deliberately split between CR and LF, independent of Blob's chunk size.
    const blob = new Blob([bytes]);
    Object.defineProperty(blob, 'stream', { value: () => new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(bytes.slice(0, 65536)); controller.enqueue(bytes.slice(65536)); controller.close();
    } }) });
    const index = await indexLines(blob), actual: string[] = [];
    for (let i = 0; i < index.length; i++) actual.push((await blob.slice(index[i], index[i + 1] ?? blob.size).text()).replace(/\r\n$|[\r\n]$/, ''));
    expect(actual).toEqual(source.split(/\r\n|\r|\n/));
    expect(await indexLines(new Blob([]))).toHaveLength(0);
    expect(await indexLines(new Blob(['a\r\n']))).toEqual(new Uint32Array([0]));
  });

  it('reads ranges at both insertion boundaries and the end of a large source', async () => {
    const source = fixtureSource() + '; unchanged\n'.repeat(400_000) + '; last';
    const { review } = prepare(source), index = await indexLines(review.source);
    const insertion = review.insertionLine - 1, added = review.addedLines.length;
    const before = await readDiffRows(review, index, insertion - 2, 5);
    expect(before.map(row => row.kind)).toEqual(['context', 'context', 'added', 'added', 'added']);
    const after = await readDiffRows(review, index, insertion + added - 2, 5);
    expect(after.map(row => row.kind)).toEqual(['added', 'added', 'context', 'context', 'context']);
    const last = await readDiffRows(review, index, index.length + added - 1, 250);
    expect(last).toEqual([{ kind: 'context', originalLine: index.length, outputLine: index.length + added, text: '; last' }]);
  });

  it('keeps the reviewed output stable when later settings change and rejects a mismatched source', async () => {
    const { review, job, brim } = prepare();
    const bytes = await review.output.arrayBuffer();
    brim.settings.speed = 55;
    expect(await review.output.arrayBuffer()).toEqual(bytes);
    expect(() => prepareExport(new File(['wrong'], 'other.gcode'), job, brim, 'standard')).toThrow(/does not match/);
    await expect(readDiffRows(review, new Uint32Array([0]), 0, 10)).rejects.toThrow(/insertion point/);
    const abort = new AbortController(); abort.abort();
    await expect(indexLines(review.source, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
