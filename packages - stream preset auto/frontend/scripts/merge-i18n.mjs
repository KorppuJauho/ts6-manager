// Merges namespace fragments into the 5 locale files, then checks key parity.
// Fragment files live in scripts/i18n-fragments/*.json, each shaped:
//   { "namespace": "foo", "keys": { "en": {...}, "fr": {...}, "de": {...}, "es": {...}, "it": {...} } }
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LANGS = ['en', 'fr', 'de', 'es', 'it'];
const localesDir = path.join(__dirname, '..', 'src', 'i18n', 'locales');
const fragDir = path.join(__dirname, 'i18n-fragments');

const locales = Object.fromEntries(
  LANGS.map((l) => [l, JSON.parse(fs.readFileSync(path.join(localesDir, `${l}.json`), 'utf8'))]),
);

// Deep-merge so a fragment adds/updates keys without dropping existing ones
// in the same namespace (e.g. the settings namespace migrated across waves).
function deepMerge(target, src) {
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      target[k] = deepMerge(target[k] && typeof target[k] === 'object' ? target[k] : {}, v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

const fragments = fs.readdirSync(fragDir).filter((f) => f.endsWith('.json'));
for (const file of fragments) {
  const frag = JSON.parse(fs.readFileSync(path.join(fragDir, file), 'utf8'));
  const ns = frag.namespace;
  for (const lang of LANGS) {
    locales[lang][ns] = deepMerge(locales[lang][ns] && typeof locales[lang][ns] === 'object' ? locales[lang][ns] : {}, frag.keys[lang]);
  }
  console.log(`merged: ${ns} (${Object.keys(frag.keys.en).length} top-level keys)`);
}

for (const lang of LANGS) {
  fs.writeFileSync(path.join(localesDir, `${lang}.json`), JSON.stringify(locales[lang], null, 2) + '\n');
}

// Parity check
const flatten = (o, p = '') => Object.entries(o).flatMap(([k, v]) =>
  v && typeof v === 'object' ? flatten(v, p + k + '.') : [p + k]);
const base = new Set(flatten(locales.en));
let ok = true;
for (const lang of LANGS) {
  const keys = new Set(flatten(locales[lang]));
  const missing = [...base].filter((k) => !keys.has(k));
  const extra = [...keys].filter((k) => !base.has(k));
  if (missing.length || extra.length) {
    ok = false;
    console.log(`PARITY ${lang} — missing: ${missing.join(', ')} | extra: ${extra.join(', ')}`);
  }
}
console.log(ok ? `OK — ${base.size} keys across ${LANGS.length} locales` : 'PARITY MISMATCH');
process.exit(ok ? 0 : 1);
