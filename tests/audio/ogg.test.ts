import { randomBytes, randomInt } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  concatOggOpus,
  decodeOggOpusPackets,
  encodeOggOpus,
  FRAME_MS,
} from '../../src/audio/ogg.js';

function fakePackets(count = 30): Buffer[] {
  return Array.from({ length: count }, () => randomBytes(randomInt(40, 121)));
}

describe('ogg opus', () => {
  it('exposes the 20 ms frame length', () => {
    expect(FRAME_MS).toBe(20);
  });

  it('round-trips packets through encode and decode', async () => {
    const packets = fakePackets();
    const decoded = await decodeOggOpusPackets(await encodeOggOpus(packets));
    expect(decoded).toEqual(packets);
  });

  it('starts the output with the OggS capture pattern', async () => {
    const out = await encodeOggOpus(fakePackets(3));
    expect(out.subarray(0, 4).toString('latin1')).toBe('OggS');
  });

  it('concatenates files so decoding yields both packet lists in order', async () => {
    const a = fakePackets();
    const b = fakePackets(25);
    const merged = await concatOggOpus([await encodeOggOpus(a), await encodeOggOpus(b)]);
    expect(await decodeOggOpusPackets(merged)).toEqual([...a, ...b]);
  });

  it('rejects encoding an empty packet list with a RangeError', async () => {
    await expect(encodeOggOpus([])).rejects.toBeInstanceOf(RangeError);
  });

  it('round-trips packets whose size is a multiple of 255 and larger packets', async () => {
    const packets = [randomBytes(255), randomBytes(510), randomBytes(1000), randomBytes(1)];
    const decoded = await decodeOggOpusPackets(await encodeOggOpus(packets));
    expect(decoded).toEqual(packets);
  });
});
