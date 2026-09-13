import { describe, it, expect } from 'vitest';
import { messages, DEFAULT_BOT_LANGUAGE, BOT_LANGUAGES, isBotLanguage } from './index.js';
import { en } from './en.js';

describe('bot message catalogues', () => {
  it('every language defines every key the English catalogue has', () => {
    // The BotMessages interface makes this a compile error too, but this
    // catches a catalogue that satisfies the type via a widened cast.
    const expected = Object.keys(en).sort();
    for (const lang of BOT_LANGUAGES) {
      expect(Object.keys(messages(lang)).sort(), `language: ${lang}`).toEqual(expected);
    }
  });

  it('matches the value shape of the English catalogue key for key', () => {
    for (const lang of BOT_LANGUAGES) {
      const cat = messages(lang) as Record<string, unknown>;
      for (const [key, reference] of Object.entries(en as Record<string, unknown>)) {
        expect(typeof cat[key], `${lang}.${key}`).toBe(typeof reference);
        if (Array.isArray(reference)) {
          expect(Array.isArray(cat[key]), `${lang}.${key}`).toBe(true);
        }
      }
    }
  });

  it('interpolates its arguments rather than dropping them', () => {
    for (const lang of BOT_LANGUAGES) {
      const m = messages(lang);
      expect(m.nowPlaying('Artist', 'Title'), lang).toContain('Artist');
      expect(m.nowPlaying('Artist', 'Title'), lang).toContain('Title');
      expect(m.queued('Artist', 'Title', 3), lang).toContain('3');
      expect(m.permissionDenied('DJ'), lang).toContain('DJ');
      expect(m.tvStarting('MTV 3'), lang).toContain('MTV 3');
    }
  });

  it('omits the separator when a track has no artist', () => {
    for (const lang of BOT_LANGUAGES) {
      // Sources without artist metadata previously rendered "undefined - Title".
      const line = messages(lang).nowPlaying(undefined, 'Title');
      expect(line, lang).toContain('Title');
      expect(line, lang).not.toContain('undefined');
      expect(line, lang).not.toMatch(/\s-\s*$/);
    }
  });

  it('falls back to English for an unknown or missing language', () => {
    // The value comes from a database column, so a bad row must not throw.
    expect(messages('klingon')).toBe(messages(DEFAULT_BOT_LANGUAGE));
    expect(messages(null)).toBe(messages(DEFAULT_BOT_LANGUAGE));
    expect(messages(undefined)).toBe(messages(DEFAULT_BOT_LANGUAGE));
  });

  it('recognises exactly the supported languages', () => {
    expect(isBotLanguage('fi')).toBe(true);
    expect(isBotLanguage('klingon')).toBe(false);
    expect(isBotLanguage(42)).toBe(false);
  });

  it('gives every language a non-empty help table', () => {
    for (const lang of BOT_LANGUAGES) {
      const m = messages(lang);
      expect(m.helpLines.length, lang).toBeGreaterThan(10);
      expect(m.helpHeader.length, lang).toBeGreaterThan(0);
    }
  });
});
