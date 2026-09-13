import { describe, it, expect } from 'vitest';
import { effectiveEncoder, parseChannelFilter, STREAM_SETTINGS_DEFAULTS } from './stream-settings.js';

const settings = (over: Partial<typeof STREAM_SETTINGS_DEFAULTS>) => ({
  ...STREAM_SETTINGS_DEFAULTS,
  ...over,
});

describe('effectiveEncoder', () => {
  it('passes the chosen profile through when hardware is enabled', () => {
    expect(effectiveEncoder(settings({ hwAccelEnabled: true, encoderProfile: 'vp9_vaapi' })))
      .toBe('vp9_vaapi');
  });

  it('keeps the codec when hardware is disabled, dropping only the backend', () => {
    // Regression: this used to return '', which the sidecar read as "no
    // preference" and answered with its default — vp8_software. Selecting VP9
    // with the toggle off therefore produced VP8, and looked like the setting
    // was being ignored.
    expect(effectiveEncoder(settings({ hwAccelEnabled: false, encoderProfile: 'vp9_vaapi' })))
      .toBe('vp9_software');
    expect(effectiveEncoder(settings({ hwAccelEnabled: false, encoderProfile: 'vp8_vaapi' })))
      .toBe('vp8_software');
  });

  it('leaves a software profile alone either way', () => {
    expect(effectiveEncoder(settings({ hwAccelEnabled: false, encoderProfile: 'vp9_software' })))
      .toBe('vp9_software');
    expect(effectiveEncoder(settings({ hwAccelEnabled: true, encoderProfile: 'vp9_software' })))
      .toBe('vp9_software');
  });

  it('maps the other hardware backends the registry documents', () => {
    expect(effectiveEncoder(settings({ hwAccelEnabled: false, encoderProfile: 'h264_nvenc' })))
      .toBe('h264_software');
    expect(effectiveEncoder(settings({ hwAccelEnabled: false, encoderProfile: 'h264_qsv' })))
      .toBe('h264_software');
  });

  it('never returns empty, which the sidecar would read as no preference', () => {
    for (const profile of ['vp8_software', 'vp9_software', 'vp8_vaapi', 'vp9_vaapi']) {
      for (const hwAccelEnabled of [true, false]) {
        expect(effectiveEncoder(settings({ hwAccelEnabled, encoderProfile: profile })), profile)
          .not.toBe('');
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
