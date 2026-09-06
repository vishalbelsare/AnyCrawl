import type { I18nConfig } from "fumadocs-core/i18n";

/** Supported doc locales. When adding one, also update `@/lib/docs-ui-i18n` (UI + language picker). */
export const i18n: I18nConfig = {
    defaultLanguage: "en",
    languages: ["en", "zh-cn", "zh-tw", "es", "vi", "ja", "ko", "pt-br", "fr", "de", "ru", "th"],
};
