/*
 * SPDX-FileCopyrightText: 2024 Siemens AG
 *
 * SPDX-License-Identifier: MIT
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import translationEN from "./locales/en/translation.json";
import translationDE from "./locales/de/translation.json";

const resources = {
  en: {
    translation: translationEN,
  },
  de: {
    translation: translationDE,
  },
};

// WCAG 3.1.1 (Language of Page) / 3.1.2 (Language of Parts).
// index.html ships lang="en", but nothing used to update it: after
// i18n.changeLanguage("de") the whole document still claimed to be English, so
// a screen reader read German copy with an English voice and English
// pronunciation rules. Keep <html lang> pinned to the active language — on
// every change, and once at start-up so the initial value is set by the same
// source of truth rather than only matching by accident.
function syncDocumentLanguage(language: string) {
  if (typeof document === "undefined") return;
  document.documentElement.lang = language;
}

i18n.on("languageChanged", syncDocumentLanguage);

i18n.use(initReactI18next).init({
  resources,
  lng: "en",
  interpolation: {
    escapeValue: false,
  },
});

syncDocumentLanguage(i18n.resolvedLanguage ?? i18n.language);

export default i18n;
