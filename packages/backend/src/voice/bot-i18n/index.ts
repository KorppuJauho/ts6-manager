/**
 * Bot message catalogues, one per language.
 *
 * `messages(lang)` is total: an unknown or missing language falls back to
 * English rather than throwing, because the value comes from the database and
 * a bad row should not silence the bot.
 */
import type { BotMessages, BotLanguage } from './types.js';
import { isBotLanguage } from './types.js';
import { en } from './en.js';
import { fi } from './fi.js';
import { fr } from './fr.js';
import { de } from './de.js';
import { es } from './es.js';
import { it } from './it.js';

const catalogues: Record<BotLanguage, BotMessages> = { en, fi, fr, de, es, it };

export const DEFAULT_BOT_LANGUAGE: BotLanguage = 'en';

export function messages(language: string | null | undefined): BotMessages {
  return isBotLanguage(language) ? catalogues[language] : catalogues[DEFAULT_BOT_LANGUAGE];
}

export { BOT_LANGUAGES, isBotLanguage } from './types.js';
export type { BotMessages, BotLanguage } from './types.js';
