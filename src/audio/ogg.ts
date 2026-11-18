import { randomInt } from 'node:crypto';
import prism from 'prism-media';

/** Duration of one Discord Opus frame in milliseconds. */
export const FRAME_MS = 20;

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const SAMPLES_PER_FRAME = (SAMPLE_RATE * FRAME_MS) / 1000;
const MAX_PACKETS_PER_PAGE = 10;
const MAX_SEGMENTS_PER_PAGE = 255;

const FLAG_BOS = 0x02;
const FLAG_EOS = 0x04;

// prism-media 1.x ships only an Ogg demuxer, so the (small) muxing side lives here.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    table[i] = r >>> 0;
  }
  return table;
})();

function oggCrc(data: Buffer): number {
  let crc = 0;
  for (const byte of data) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]!) >>> 0;
  return crc;
}

/** Number of lacing values a packet needs (a multiple of 255 needs a terminating 0). */
function segmentCount(packet: Buffer): number {
  return Math.floor(packet.length / 255) + 1;
}

function buildPage(
  packets: Buffer[],
  opts: { flags: number; granule: bigint; serial: number; sequence: number },
): Buffer {
  const lacing: number[] = [];
  for (const packet of packets) {
    for (let remaining = packet.length; ; remaining -= 255) {
      lacing.push(Math.min(remaining, 255));
      if (remaining < 255) break;
    }
  }
  const header = Buffer.alloc(27 + lacing.length);
  header.write('OggS', 0, 'latin1');
  header.writeUInt8(0, 4); // stream structure version
  header.writeUInt8(opts.flags, 5);
  header.writeBigUInt64LE(opts.granule, 6);
  header.writeUInt32LE(opts.serial, 14);
  header.writeUInt32LE(opts.sequence, 18);
  // bytes 22..25 hold the CRC, computed below over the page with a zeroed CRC field
  header.writeUInt8(lacing.length, 26);
  Buffer.from(lacing).copy(header, 27);
  const page = Buffer.concat([header, ...packets]);
  page.writeUInt32LE(oggCrc(page), 22);
  return page;
}

function opusHead(): Buffer {
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0, 'latin1');
  head.writeUInt8(1, 8); // version
  head.writeUInt8(CHANNELS, 9);
  head.writeUInt16LE(0, 10); // pre-skip
  head.writeUInt32LE(SAMPLE_RATE, 12); // original input sample rate
  head.writeInt16LE(0, 16); // output gain
  head.writeUInt8(0, 18); // channel mapping family
  return head;
}

function opusTags(): Buffer {
  const vendor = Buffer.from('meeting-reporter-bot', 'utf8');
  const tags = Buffer.alloc(8 + 4 + vendor.length + 4);
  tags.write('OpusTags', 0, 'latin1');
  tags.writeUInt32LE(vendor.length, 8);
  vendor.copy(tags, 12);
  tags.writeUInt32LE(0, 12 + vendor.length); // no user comments
  return tags;
}

/** Wraps raw 48 kHz stereo Opus packets (20 ms each) into an Ogg Opus file. */
export async function encodeOggOpus(packets: Buffer[]): Promise<Buffer> {
  if (packets.length === 0) throw new RangeError('encodeOggOpus requires at least one packet');
  for (const packet of packets) {
    if (segmentCount(packet) > MAX_SEGMENTS_PER_PAGE) {
      throw new RangeError(`Opus packet of ${packet.length} bytes is too large for one Ogg page`);
    }
  }

  const serial = randomInt(0, 2 ** 32);
  let sequence = 0;
  const pages: Buffer[] = [
    buildPage([opusHead()], { flags: FLAG_BOS, granule: 0n, serial, sequence: sequence++ }),
    buildPage([opusTags()], { flags: 0, granule: 0n, serial, sequence: sequence++ }),
  ];

  let granule = 0n;
  let index = 0;
  while (index < packets.length) {
    const group: Buffer[] = [];
    let segments = 0;
    while (index < packets.length && group.length < MAX_PACKETS_PER_PAGE) {
      const next = packets[index]!;
      if (segments + segmentCount(next) > MAX_SEGMENTS_PER_PAGE) break;
      group.push(next);
      segments += segmentCount(next);
      index++;
    }
    granule += BigInt(group.length * SAMPLES_PER_FRAME);
    pages.push(
      buildPage(group, {
        flags: index >= packets.length ? FLAG_EOS : 0,
        granule,
        serial,
        sequence: sequence++,
      }),
    );
  }
  return Buffer.concat(pages);
}

/** Extracts the Opus audio packets (not the header packets) from an Ogg Opus file. */
export function decodeOggOpusPackets(data: Buffer): Promise<Buffer[]> {
  return new Promise((resolve, reject) => {
    const demuxer = new prism.opus.OggDemuxer();
    const packets: Buffer[] = [];
    demuxer.on('data', (packet: Buffer) => packets.push(packet));
    demuxer.on('error', reject);
    demuxer.on('end', () => resolve(packets));
    demuxer.end(data);
  });
}

/** Joins several Ogg Opus files into one, preserving packet order. */
export async function concatOggOpus(files: Buffer[]): Promise<Buffer> {
  const decoded = await Promise.all(files.map(decodeOggOpusPackets));
  return encodeOggOpus(decoded.flat());
}
