import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import en from './locales/en.json';

// English only. Strings still go through i18next so they stay in one file
// rather than scattered through the components.
i18n
  .use(initReactI18next)
  .init({
    resources: { en: { translation: en } },
    lng: 'en',
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  });

export default i18n;
