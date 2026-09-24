import { describe, it, expect } from 'vitest';
import {
  effectiveEncoder,
  codecFromProfile,
  composeProfile,
  parseChannelFilter,
  STREAM_SETTINGS_DEFAULTS,
} from './stream-settings.js';

const settings = (over: Partial<typeof STREAM_SETTINGS_DEFAULTS>) => ({
  ...STREAM_SETTINGS_DEFAULTS,
  ...over,
});

describe('codecFromProfile', () => {
  it('takes the codec half of a profile key', () => {
    expect(codecFromProfile('vp9_vaapi')).toBe('vp9');
    expect(codecFromProfile('vp8_software')).toBe('vp8');
    expect(codecFromProfile('h264_nvenc')).toBe('h264');
  });

  it('falls back rather than returning empty on a malformed key', () => {
    expect(codecFromProfile('')).toBe('vp8');
  });
});

describe('composeProfile', () => {
  it('pairs a codec with the backend the toggle selects', () => {
    expect(composeProfile('vp9', true)).toBe('vp9_vaapi');
    expect(composeProfile('vp9', false)).toBe('vp9_software');
  });
});

describe('effectiveEncoder', () => {
  it('takes the codec from the setting and the backend from the toggle', () => {
    expect(effectiveEncoder(settings({ hwAccelEnabled: true, encoderProfile: 'vp9_vaapi' })))
      .toBe('vp9_vaapi');
    expect(effectiveEncoder(settings({ hwAccelEnabled: false, encoderProfile: 'vp9_vaapi' })))
      .toBe('vp9_software');
  });

  it('keeps the codec when hardware is disabled', () => {
    // Regression: this used to return '', which the sidecar read as "no
    // preference" and answered with its default — vp8_software. Selecting VP9
    // therefore produced VP8, and looked like the setting was being ignored.
    expect(effectiveEncoder(settings({ hwAccelEnabled: false, encoderProfile: 'vp9_vaapi' })))
      .toBe('vp9_software');
    expect(effectiveEncoder(settings({ hwAccelEnabled: false, encoderProfile: 'vp8_vaapi' })))
      .toBe('vp8_software');
  });

  it('lets the toggle win over a stale backend in the stored key', () => {
    // Rows written before codec and backend were separated can hold a
    // software profile while the toggle is on. The toggle decides.
    expect(effectiveEncoder(settings({ hwAccelEnabled: true, encoderProfile: 'vp9_software' })))
      .toBe('vp9_vaapi');
    expect(effectiveEncoder(settings({ hwAccelEnabled: false, encoderProfile: 'vp8_software' })))
      .toBe('vp8_software');
  });

  it('never returns empty, which the sidecar would read as no preference', () => {
    for (const profile of ['vp8_software', 'vp9_software', 'vp8_vaapi', 'vp9_vaapi']) {
      for (const hwAccelEnabled of [true, false]) {
        expect(effectiveEncoder(settings({ hwAccelEnabled, encoderProfile: profile })), profile)
          .not.toBe('');
      }
    }
  });

  it('is idempotent — resolving its own output changes nothing', () => {
    for (const profile of ['vp8_software', 'vp9_vaapi']) {
      for (const hwAccelEnabled of [true, false]) {
        const once = effectiveEncoder(settings({ hwAccelEnabled, encoderProfile: profile }));
        const twice = effectiveEncoder(settings({ hwAccelEnabled, encoderProfile: once }));
        expect(twice, `${profile} hw=${hwAccelEnabled}`).toBe(once);
      }
    }
  });
});

describe('parseChannelFilter', () => {
  it('splits, trims and lowercases', () => {
    expect(parseChannelFilter('Yle TV1, MTV 3 ,nelonen')).toEqual(['yle tv1', 'mtv 3', 'nelonen']);
  });

  it('treats empty and null as no filter', () => {
    expect(parseChannelFilter('')).toEqual([]);
    expect(parseChannelFilter(null)).toEqual([]);
    expect(parseChannelFilter(undefined)).toEqual([]);
  });

  it('drops empty segments from stray commas', () => {
    expect(parseChannelFilter('yle,,  ,mtv')).toEqual(['yle', 'mtv']);
  });
});
