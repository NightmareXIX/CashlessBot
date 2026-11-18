import { describe, expect, it } from 'vitest';
import { formatDate, formatDuration, formatOffset, formatTime } from '../../src/util/time.js';

describe('formatOffset', () => {
  it('formats ms as HH:MM:SS', () => {
    expect(formatOffset(3_723_000)).toBe('01:02:03');
    expect(formatOffset(0)).toBe('00:00:00');
    expect(formatOffset(999)).toBe('00:00:00');
  });
});

describe('formatDuration', () => {
  it('formats minutes, and hours with minutes', () => {
    expect(formatDuration(52 * 60_000)).toBe('52 min');
    expect(formatDuration(65 * 60_000)).toBe('1 h 5 min');
  });

  it('handles whole hours and sub-minute durations', () => {
    expect(formatDuration(120 * 60_000)).toBe('2 h 0 min');
    expect(formatDuration(20_000)).toBe('0 min');
  });
});

describe('formatDate / formatTime', () => {
  const d = new Date('2026-11-18T15:00:00Z');

  it('formats the time in the given timezone', () => {
    expect(formatTime(d, 'Asia/Dhaka')).toBe('9:00 PM');
  });

  it('formats the date in the given timezone', () => {
    expect(formatDate(d, 'Asia/Dhaka')).toBe('18 Nov 2026');
  });

  it('respects the timezone across a date boundary', () => {
    expect(formatDate(d, 'Pacific/Kiritimati')).toBe('19 Nov 2026');
    expect(formatDate(d, 'UTC')).toBe('18 Nov 2026');
  });
});
