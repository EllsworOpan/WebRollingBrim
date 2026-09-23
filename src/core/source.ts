import { decodeBgcode, isBgcode, MAX_SOURCE_BYTES, type BgcodeIndex } from './bgcode';

export async function decodeSource(bytes: Uint8Array<ArrayBuffer>, name: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; bgcode?: BgcodeIndex }> {
  if (bytes.length > MAX_SOURCE_BYTES) throw new Error('This file exceeds the 200 MB browser limit.');
  if (isBgcode(bytes) || /\.bgcode$/i.test(name)) {
    const decoded = await decodeBgcode(bytes);
    return { bytes: decoded.bytes, bgcode: decoded.index };
  }
  return { bytes };
}
