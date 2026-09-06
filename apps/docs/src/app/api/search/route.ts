import { source } from "@/lib/source";
import { createFromSource } from "fumadocs-core/search/server";

// Map unsupported locales to supported tokenizer languages for Orama
const localeMap = {
    "zh-cn": "english",
    "zh-tw": "english",
    es: "spanish",
    vi: "english",
    ja: "english",
    ko: "english",
    "pt-br": "portuguese",
    fr: "french",
    de: "german",
    ru: "english",
    th: "english",
};

export const { GET } = createFromSource(source, undefined, { localeMap });
