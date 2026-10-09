import { describe, expect, it } from 'vitest';
import { decodeBool, decodeInt, decodeString, encodeInt32, isGardenaAdvertisement } from '../src/protocol.js';

describe('protocol', () => {
  it('round trips a watering duration as int32 little endian', () => {
    const encoded = encodeInt32(900);
    expect(encoded).toEqual(Buffer.from([0x84, 0x03, 0x00, 0x00]));
    expect(decodeInt(encoded)).toBe(900);
  });

  it('decodes integers of the width the device sends', () => {
    expect(decodeInt(Buffer.from([0x55]))).toBe(85);
    expect(decodeInt(Buffer.from([0xff]))).toBe(-1);
    expect(decodeInt(Buffer.alloc(0))).toBe(0);
  });

  it('decodes booleans', () => {
    expect(decodeBool(Buffer.from([1]))).toBe(true);
    expect(decodeBool(Buffer.from([0]))).toBe(false);
    expect(decodeBool(Buffer.alloc(0))).toBe(false);
  });

  it('decodes null terminated strings', () => {
    expect(decodeString(Buffer.from('1.2.3\0\0junk', 'latin1'))).toBe('1.2.3');
  });

  it('recognises Gardena manufacturer data by company id', () => {
    expect(isGardenaAdvertisement({ manufacturerData: Buffer.from([0x26, 0x04, 0x02, 0x05, 0x01]) })).toBe(true);
    expect(isGardenaAdvertisement({ manufacturerData: Buffer.from([0x4c, 0x00]) })).toBe(false);
    expect(isGardenaAdvertisement({})).toBe(false);
  });

  it('recognises a Gardena service uuid when manufacturer data is missing', () => {
    expect(isGardenaAdvertisement({ serviceUuids: ['98bd00010b0e421a84e5ddbf75dc6de4'] })).toBe(true);
    expect(isGardenaAdvertisement({ serviceUuids: ['180f'] })).toBe(false);
  });
});
