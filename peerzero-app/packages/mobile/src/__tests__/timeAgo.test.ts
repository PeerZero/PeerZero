import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { timeAgo, formatTimestamp } from '../utils/timeAgo';

describe('timeAgo', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-12T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "never" for null/undefined', () => {
    expect(timeAgo(null)).toBe('never');
    expect(timeAgo(undefined)).toBe('never');
  });

  it('returns "just now" for < 5 seconds', () => {
    const date = new Date('2026-04-12T11:59:57Z');
    expect(timeAgo(date)).toBe('just now');
  });

  it('returns seconds for < 60 seconds', () => {
    const date = new Date('2026-04-12T11:59:30Z');
    expect(timeAgo(date)).toBe('30s ago');
  });

  it('returns minutes for < 60 minutes', () => {
    const date = new Date('2026-04-12T11:45:00Z');
    expect(timeAgo(date)).toBe('15m ago');
  });

  it('returns hours for < 24 hours', () => {
    const date = new Date('2026-04-12T06:00:00Z');
    expect(timeAgo(date)).toBe('6h ago');
  });

  it('returns "yesterday" for 1 day ago', () => {
    const date = new Date('2026-04-11T12:00:00Z');
    expect(timeAgo(date)).toBe('yesterday');
  });

  it('returns days for < 7 days', () => {
    const date = new Date('2026-04-08T12:00:00Z');
    expect(timeAgo(date)).toBe('4d ago');
  });

  it('returns weeks for < 5 weeks', () => {
    const date = new Date('2026-03-22T12:00:00Z');
    expect(timeAgo(date)).toBe('3w ago');
  });

  it('returns months for < 12 months', () => {
    const date = new Date('2025-11-12T12:00:00Z');
    expect(timeAgo(date)).toBe('5mo ago');
  });

  it('returns years for >= 12 months', () => {
    const date = new Date('2024-01-12T12:00:00Z');
    expect(timeAgo(date)).toBe('2y ago');
  });

  it('accepts ISO string input', () => {
    expect(timeAgo('2026-04-12T11:59:00Z')).toBe('1m ago');
  });
});

describe('formatTimestamp', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-12T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses relative time for < 24 hours ago', () => {
    const result = formatTimestamp('2026-04-12T11:00:00Z');
    expect(result).toBe('1h ago');
  });

  it('uses date+time format for > 24 hours ago', () => {
    const result = formatTimestamp('2026-04-10T12:00:00Z');
    // Should contain a date component — exact format depends on locale
    expect(result).toBeTruthy();
    expect(result).not.toBe('2d ago');
  });
});
