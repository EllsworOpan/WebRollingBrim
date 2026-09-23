import { readFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { openBgcode } from '@chestnutlabs/gcode-bgcode';
import { bgcodeCrc32, decodeBgcode, encodeBgcodeBlocks, isBgcode } from '../src/core/bgcode';
import { decodeSource } from '../src/core/source';
import { parseGcode } from '../src/core/gcode';
import { buildFootprint, generateBrim } from '../src/core/geometry';
import { createInsertion, exportBlockers, hardExportBlockers } from '../src/core/export';
import { assertReviewAccepted, indexLines, prepareBgcodeExport, readDiffRows } from '../src/core/export-review';
import { DEFAULT_BRIM } from '../src/core/types';
import { fixtureSource } from './fixtures';

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const config = fixtureSource().split('; prusaslicer_config = begin\n')[1].split('; prusaslicer_config = end')[0].replace(/^; /gm, '');
const body = fixtureSource().split('; prusaslicer_config = begin')[0];
const sample = new Uint8Array(readFileSync(new URL('../examples/gcodes/clearance-test-plate.bgcode', import.meta.url)));

// Independent fixture writer, using Node's CRC and zlib rather than app helpers.
function block(type: number, data: Uint8Array, compression = 0, encoding = 0, checksum = true) {
  let stored = data;
  if (compression === 1) stored = deflateSync(data);
  if (compression === 2 || compression === 3) {
    // Valid heatshrink stream using only literal tokens, MSB first.
    const bits = [...data].map(byte => '1' + byte.toString(2).padStart(8, '0')).join('');
    stored = Uint8Array.from(bits.padEnd(Math.ceil(bits.length / 8) * 8, '0').match(/.{8}/g) || [], part => parseInt(part, 2));
  }
  const header = compression ? 12 : 8, params = type === 5 ? 6 : 2;
  const result = new Uint8Array(header + params + stored.length + (checksum ? 4 : 0)), view = new DataView(result.buffer);
  view.setUint16(0, type, true); view.setUint16(2, compression, true); view.setUint32(4, data.length, true);
  if (compression) view.setUint32(8, stored.length, true);
  view.setUint16(header, encoding, true);
  if (type === 5) { view.setUint16(header + 2, 1, true); view.setUint16(header + 4, 1, true); }
  result.set(stored, header + params);
  if (checksum) view.setUint32(result.length - 4, crc32(result.subarray(0, -4)), true);
  return result;
}
function fixture(compression = 0, encoding = 0, checksum = true, parts = [body]) {
  const header = new Uint8Array(10), view = new DataView(header.buffer);
  header.set(encode('GCDE')); view.setUint32(4, 1, true); view.setUint16(8, checksum ? 1 : 0, true);
  const chunks = [header, block(0, encode('Producer = PrusaSlicer 2.9.6\n'), 0, 0, checksum),
    block(3, encode('printer_model = TEST\n'), 0, 0, checksum),
    block(5, Uint8Array.of(137, 80, 78, 71), 0, 0, checksum),
    block(4, encode('estimated printing time = 1m\n'), 1, 0, checksum),
    block(2, encode(config), 1, 0, checksum),
    ...parts.map(text => block(1, encode(text), compression, encoding, checksum))];
  const result = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

describe('binary G-code import and export', () => {
  it('requires scoped acceptance for binary export and still enforces its late allowlist', async () => {
    const input = fixture(1, 0, true, [body.replace('G21', 'M573 R\nG21')]);
    const decoded = await decodeBgcode(input), job = parseGcode(decode(decoded.bytes));
    const brim = generateBrim(buildFootprint(job), job, DEFAULT_BRIM);
    const original = new File([input], 'part.bgcode'), source = new File([decoded.bytes], 'part.bgcode');
    await expect(prepareBgcodeExport(original, source, decoded.index, job, brim, 'standard')).rejects.toThrow(/acceptance/);
    const ids = job.concerns.map(issue => issue.id);
    const review = await prepareBgcodeExport(original, source, decoded.index, job, brim, 'standard', ids);
    expect(() => assertReviewAccepted(review, [])).toThrow(/confirm/);
    expect(() => assertReviewAccepted(review, ids)).not.toThrow();
    const roundtrip = await decodeBgcode(new Uint8Array(await review.output.arrayBuffer()));
    expect(decode(roundtrip.bytes).replace(createInsertion(job, brim, 'standard', ids), '')).toBe(decode(decoded.bytes));
    job.insertion!.state.type = 'Custom\nM104 S280';
    await expect(prepareBgcodeExport(original, source, decoded.index, job, brim, 'standard', ids)).rejects.toThrow(/disallowed command/);
  });

  it.skipIf(!process.env.ROLLING_BRIM_TEST_BGCODE)('reviews and roundtrips a private binary startup fixture', async () => {
    const input = new Uint8Array(readFileSync(process.env.ROLLING_BRIM_TEST_BGCODE!));
    const decoded = await decodeBgcode(input), job = parseGcode(decode(decoded.bytes));
    expect(hardExportBlockers(job)).toEqual([]);
    const brim = generateBrim(buildFootprint(job), job, { ...DEFAULT_BRIM, lineWidth: job.settings.lineWidth });
    const ids = job.concerns.map(issue => issue.id);
    const review = await prepareBgcodeExport(new File([input], 'private.bgcode'), new File([decoded.bytes], 'private.bgcode'), decoded.index, job, brim, 'standard', ids);
    const roundtrip = await openBgcode(new Uint8Array(await review.output.arrayBuffer()));
    expect(decode(roundtrip.gcode).replace(createInsertion(job, brim, 'standard', ids), '')).toBe(decode((await openBgcode(input)).gcode));
    assertReviewAccepted(review, ids);
  });

  for (const compression of [0, 1, 2, 3]) for (const encoding of [0, 1, 2]) {
    it(`decodes compression ${compression}, encoding ${encoding}, and metadata into the existing interpreter`, async () => {
      // MeatPack starts with packing disabled; literal input is valid in that
      // state. The real slicer fixture below exercises packed nibbles/backrefs.
      const input = fixture(compression, encoding), result = await decodeBgcode(input);
      const job = parseGcode(decode(result.bytes));
      expect(exportBlockers(job)).toEqual([]);
      expect(job.settings).toEqual(parseGcode(fixtureSource()).settings);
      expect(job.paths).toEqual(parseGcode(fixtureSource()).paths);
      const region = result.index.blocks[0];
      expect(decode(result.bytes.slice(region.textStart, region.textEnd))).toBe(body);
      expect(result.index.sourceBytes).toBe(input.length);
    });
  }

  it('loads a real PrusaSlicer heatshrink/MeatPack sample and matches the text footprint', async () => {
    const result = await decodeBgcode(sample), job = parseGcode(decode(result.bytes));
    const text = parseGcode(readFileSync(new URL('../examples/gcodes/clearance-test-plate.gcode', import.meta.url), 'utf8'));
    expect(exportBlockers(job)).toEqual([]);
    expect(job.insertion!.kind).toBe('travel');
    expect(job.settings).toEqual(text.settings);
    expect(job.paths).toEqual(text.paths);
    expect(job.layerCount).toBe(text.layerCount);
    expect(result.index.blocks.length).toBeGreaterThan(1);
  });

  for (const checksum of [false, true]) it(`preserves decoded commands and unchanged binary bytes on export (CRC ${checksum})`, async () => {
    const input = fixture(1, 0, checksum, [body.slice(0, body.indexOf('G1 X40')), body.slice(body.indexOf('G1 X40'))]);
    const result = await decodeBgcode(input), source = new File([result.bytes], 'part.bgcode');
    const job = parseGcode(decode(result.bytes)), brim = generateBrim(buildFootprint(job), job, DEFAULT_BRIM);
    for (const mode of ['standard', 'klipper'] as const) {
      const review = await prepareBgcodeExport(new File([input], 'part.bgcode'), source, result.index, job, brim, mode);
      const bytes = new Uint8Array(await review.output.arrayBuffer()), roundtrip = await decodeBgcode(bytes);
      const added = encode(createInsertion(job, brim, mode)), offset = job.insertion!.byteOffset;
      expect(roundtrip.bytes.slice(0, offset)).toEqual(result.bytes.slice(0, offset));
      expect(roundtrip.bytes.slice(offset, offset + added.length)).toEqual(added);
      expect(roundtrip.bytes.slice(offset + added.length)).toEqual(result.bytes.slice(offset));
      const changed = result.index.blocks.find(b => offset >= b.textStart && offset < b.textEnd)!;
      expect(bytes.slice(0, changed.start)).toEqual(input.slice(0, changed.start));
      expect(bytes.slice(bytes.length - (input.length - changed.end))).toEqual(input.slice(changed.end));
      expect(review.name).toBe('part_rolling_brim.bgcode');
      expect(review.format).toBe('bgcode');
      // The dependency's separate container walker must accept the emitted file.
      const external = await openBgcode(bytes);
      expect(decode(external.gcode)).toContain(createInsertion(job, brim, mode));
      const lines = await indexLines(source), rows = await readDiffRows(review, lines, 0, lines.length + review.addedLines.length);
      expect(rows.map(row => row.text)).toEqual(decode(roundtrip.bytes).trimEnd().split('\n'));
    }
  });

  it('roundtrips the real compressed sample and retains all original commands around the insertion', async () => {
    const result = await decodeBgcode(sample), job = parseGcode(decode(result.bytes));
    const brim = generateBrim(buildFootprint(job), job, DEFAULT_BRIM);
    const review = await prepareBgcodeExport(new File([sample], 'plate.bgcode'), new File([result.bytes], 'plate.bgcode'), result.index, job, brim, 'standard');
    const output = new Uint8Array(await review.output.arrayBuffer());
    const original = await openBgcode(sample), updated = await openBgcode(output);
    expect(decode(updated.gcode).replace(createInsertion(job, brim), '')).toBe(decode(original.gcode));
    expect(parseGcode(decode((await decodeBgcode(output)).bytes)).blockers.join()).toContain('already contains a rolling brim');
  });

  it('chunks large changed regions into bounded blocks and computes standard CRC32', async () => {
    expect(bgcodeCrc32(encode('123456789'))).toBe(0xcbf43926);
    const bytes = encode('G1 X10 E0.1\r\n'.repeat(20_000));
    const blocks = encodeBgcodeBlocks(bytes, true);
    expect(blocks.length).toBeGreaterThan(1);
    for (const block of blocks) {
      const view = new DataView(block.buffer);
      expect(view.getUint32(4, true)).toBeLessThanOrEqual(65536);
      expect(view.getUint32(block.length - 4, true)).toBe(crc32(block.subarray(0, -4)));
      expect(decode(block.subarray(10, -4))).toMatch(/\r\n$/);
    }
    expect(Buffer.concat(blocks.map(block => block.subarray(10, -4)))).toEqual(Buffer.from(bytes));
    // A CR exactly at the size boundary must stay with its LF, and neither
    // block should split the preceding command just before that CRLF.
    const boundary = encode('; header\n' + 'X'.repeat(65526) + '\r\nG1 X0\r\n');
    const boundaryBlocks = encodeBgcodeBlocks(boundary, true);
    for (const part of boundaryBlocks) expect(part[part.length - 5]).toBe(10);
    expect(Buffer.concat(boundaryBlocks.map(part => part.subarray(10, -4)))).toEqual(Buffer.from(boundary));
    expect(() => encodeBgcodeBlocks(encode('X'.repeat(70_000)), true)).toThrow(/64 KiB/);
  });

  it('sniffs binary magic, rejects falsely labelled binary input, and leaves plain bytes untouched', async () => {
    expect(isBgcode(sample)).toBe(true);
    expect((await decodeSource(sample, 'renamed.gcode')).bgcode).toBeDefined();
    const bytes = encode(fixtureSource());
    expect((await decodeSource(bytes, 'plain.gcode')).bytes).toBe(bytes);
    await expect(decodeSource(bytes, 'wrong.bgcode')).rejects.toThrow(/GCDE/);
  });

  it('rejects corruption, truncation, unknown versions/codecs and out-of-order blocks', async () => {
    const input = fixture();
    const corrupt = input.slice(); corrupt[25] ^= 1;
    await expect(decodeBgcode(corrupt)).rejects.toThrow(/checksum/);
    await expect(decodeBgcode(input.slice(0, -1))).rejects.toThrow(/truncated/);
    const version = input.slice(); new DataView(version.buffer).setUint32(4, 2, true);
    await expect(decodeBgcode(version)).rejects.toThrow(/version/);
    for (const [offset, value] of [[8, 2], [10, 9], [12, 9], [18, 9], [10, 1]]) {
      const invalid = input.slice(); new DataView(invalid.buffer).setUint16(offset, value, true);
      await expect(decodeBgcode(invalid)).rejects.toThrow(/Unsupported|unsupported|Invalid/);
    }
    await expect(decodeBgcode(input.slice(0, 10))).rejects.toThrow(/missing/);
  });

  it('limits decompression before accepting the declared sizes', async () => {
    const input = fixture(1), limit = input.length + 100;
    const result = await decodeBgcode(input), first = result.index.blocks[0].start;
    const huge = input.slice(); new DataView(huge.buffer).setUint32(first + 4, 0xffffffff, true);
    new DataView(huge.buffer).setUint32(huge.length - 4, crc32(huge.subarray(first, -4)), true);
    await expect(decodeBgcode(huge, limit)).rejects.toThrow(/limit/);
  });

  it('rejects streams that expand past their declared size without hanging', async () => {
    for (const compression of [1, 2, 3]) {
      const input = fixture(compression), result = await decodeBgcode(input), first = result.index.blocks[0].start;
      new DataView(input.buffer).setUint32(first + 4, 1, true);
      new DataView(input.buffer).setUint32(input.length - 4, crc32(input.subarray(first, -4)), true);
      await expect(decodeBgcode(input)).rejects.toThrow(/declared size|limit/);
    }
  });

  it('rejects decoded NUL bytes and invalid UTF-8 instead of repairing commands', async () => {
    await expect(decodeBgcode(fixture(0, 0, true, ['G1 X1\0\n']))).rejects.toThrow(/NUL/);
    const input = fixture(), result = await decodeBgcode(input), first = result.index.blocks[0].start;
    input[first + 10] = 0xff;
    new DataView(input.buffer).setUint32(input.length - 4, crc32(input.subarray(first, -4)), true);
    await expect(decodeBgcode(input)).rejects.toThrow(/encoded data/);
  });

  it('enforces the final command allowlist on binary export as well', async () => {
    const input = fixture(), result = await decodeBgcode(input), job = parseGcode(decode(result.bytes));
    const brim = generateBrim(buildFootprint(job), job, DEFAULT_BRIM);
    job.insertion!.state.type += '\nM104 S250';
    await expect(prepareBgcodeExport(new File([input], 'part.bgcode'), new File([result.bytes], 'part.bgcode'), result.index, job, brim, 'standard'))
      .rejects.toThrow(/generated brim line .*disallowed command "M104"/);
  });
});
