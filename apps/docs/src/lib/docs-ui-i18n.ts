import { i18n } from "@/lib/i18n";

/**
 * Single place for docs UI copy: Fumadocs chrome + 404.
 * When adding a locale: update `i18n.languages` in `./i18n.ts`, then add one entry here
 * (`docsLocaleList` + `docsUiByLocale`).
 */
export type DocsUiStrings = {
    toc: string;
    search: string;
    lastUpdate: string;
    searchNoResult: string;
    previousPage: string;
    nextPage: string;
    chooseLanguage: string;
    notFoundDescription: string;
    notFoundGoToDocs: string;
};

export const docsLocaleList: { name: string; locale: string }[] = [
    { name: "English", locale: "en" },
    { name: "简体中文", locale: "zh-cn" },
    { name: "繁體中文", locale: "zh-tw" },
    { name: "Español", locale: "es" },
    { name: "Tiếng Việt", locale: "vi" },
    { name: "日本語", locale: "ja" },
    { name: "한국어", locale: "ko" },
    { name: "Português (Brasil)", locale: "pt-br" },
    { name: "Français", locale: "fr" },
    { name: "Deutsch", locale: "de" },
    { name: "Русский", locale: "ru" },
    { name: "ภาษาไทย", locale: "th" },
];

export const docsUiByLocale: Record<string, DocsUiStrings> = {
    en: {
        toc: "Table of contents",
        search: "Search documentation",
        lastUpdate: "Last updated",
        searchNoResult: "No results",
        previousPage: "Previous page",
        nextPage: "Next page",
        chooseLanguage: "Choose language",
        notFoundDescription: "This page could not be found.",
        notFoundGoToDocs: "Go to Docs",
    },
    "zh-tw": {
        toc: "目錄",
        search: "搜尋文檔",
        lastUpdate: "最後更新於",
        searchNoResult: "沒有結果",
        previousPage: "上一頁",
        nextPage: "下一頁",
        chooseLanguage: "選擇語言",
        notFoundDescription: "找不到此頁面。",
        notFoundGoToDocs: "返回文檔",
    },
    "zh-cn": {
        toc: "目录",
        search: "搜索文档",
        lastUpdate: "最后更新于",
        searchNoResult: "没有结果",
        previousPage: "上一页",
        nextPage: "下一页",
        chooseLanguage: "选择语言",
        notFoundDescription: "找不到该页面。",
        notFoundGoToDocs: "返回文档",
    },
    es: {
        toc: "Tabla de contenidos",
        search: "Buscar documentación",
        lastUpdate: "Última actualización",
        searchNoResult: "Sin resultados",
        previousPage: "Página anterior",
        nextPage: "Página siguiente",
        chooseLanguage: "Elegir idioma",
        notFoundDescription: "No se encontró esta página.",
        notFoundGoToDocs: "Ir a la documentación",
    },
    vi: {
        toc: "Mục lục",
        search: "Tìm kiếm tài liệu",
        lastUpdate: "Cập nhật lần cuối",
        searchNoResult: "Không có kết quả",
        previousPage: "Trang trước",
        nextPage: "Trang sau",
        chooseLanguage: "Chọn ngôn ngữ",
        notFoundDescription: "Không tìm thấy trang này.",
        notFoundGoToDocs: "Đến tài liệu",
    },
    ja: {
        toc: "目次",
        search: "ドキュメントを検索",
        lastUpdate: "最終更新",
        searchNoResult: "結果なし",
        previousPage: "前のページ",
        nextPage: "次のページ",
        chooseLanguage: "言語を選択",
        notFoundDescription: "ページが見つかりません。",
        notFoundGoToDocs: "ドキュメントへ",
    },
    ko: {
        toc: "목차",
        search: "문서 검색",
        lastUpdate: "마지막 업데이트",
        searchNoResult: "결과 없음",
        previousPage: "이전 페이지",
        nextPage: "다음 페이지",
        chooseLanguage: "언어 선택",
        notFoundDescription: "페이지를 찾을 수 없습니다.",
        notFoundGoToDocs: "문서로 이동",
    },
    "pt-br": {
        toc: "Sumário",
        search: "Pesquisar documentação",
        lastUpdate: "Última atualização",
        searchNoResult: "Sem resultados",
        previousPage: "Página anterior",
        nextPage: "Próxima página",
        chooseLanguage: "Escolher idioma",
        notFoundDescription: "Esta página não foi encontrada.",
        notFoundGoToDocs: "Ir para a documentação",
    },
    fr: {
        toc: "Table des matières",
        search: "Rechercher la documentation",
        lastUpdate: "Dernière mise à jour",
        searchNoResult: "Aucun résultat",
        previousPage: "Page précédente",
        nextPage: "Page suivante",
        chooseLanguage: "Choisir la langue",
        notFoundDescription: "Cette page est introuvable.",
        notFoundGoToDocs: "Aller à la documentation",
    },
    de: {
        toc: "Inhaltsverzeichnis",
        search: "Dokumentation durchsuchen",
        lastUpdate: "Zuletzt aktualisiert",
        searchNoResult: "Keine Ergebnisse",
        previousPage: "Vorherige Seite",
        nextPage: "Nächste Seite",
        chooseLanguage: "Sprache wählen",
        notFoundDescription: "Diese Seite wurde nicht gefunden.",
        notFoundGoToDocs: "Zur Dokumentation",
    },
    ru: {
        toc: "Содержание",
        search: "Поиск по документации",
        lastUpdate: "Последнее обновление",
        searchNoResult: "Нет результатов",
        previousPage: "Предыдущая страница",
        nextPage: "Следующая страница",
        chooseLanguage: "Выбрать язык",
        notFoundDescription: "Страница не найдена.",
        notFoundGoToDocs: "К документации",
    },
    th: {
        toc: "สารบัญ",
        search: "ค้นหาเอกสาร",
        lastUpdate: "อัปเดตล่าสุด",
        searchNoResult: "ไม่พบผลลัพธ์",
        previousPage: "หน้าก่อนหน้า",
        nextPage: "หน้าถัดไป",
        chooseLanguage: "เลือกภาษา",
        notFoundDescription: "ไม่พบหน้านี้",
        notFoundGoToDocs: "ไปที่เอกสาร",
    },
};

const allowedLangs = new Set(i18n.languages);

export function getDocsUi(lang: string): DocsUiStrings {
    return docsUiByLocale[lang] ?? docsUiByLocale.en;
}

type FumadocsTranslationKeys = Exclude<keyof DocsUiStrings, "notFoundDescription" | "notFoundGoToDocs">;

/** Keys expected by Fumadocs `RootProvider` i18n.translations (excludes 404-only strings). */
export function getFumadocsTranslations(lang: string): Pick<DocsUiStrings, FumadocsTranslationKeys> {
    const t = getDocsUi(lang);
    return {
        toc: t.toc,
        search: t.search,
        lastUpdate: t.lastUpdate,
        searchNoResult: t.searchNoResult,
        previousPage: t.previousPage,
        nextPage: t.nextPage,
        chooseLanguage: t.chooseLanguage,
    };
}

/** First path segment when it is a supported docs locale; otherwise default language. */
export function localeFromPathname(pathname: string | null): string {
    const seg = pathname?.split("/").filter(Boolean)[0];
    if (seg && allowedLangs.has(seg)) return seg;
    return i18n.defaultLanguage;
}

/** Fails fast if `i18n.languages`, `docsUiByLocale`, and `docsLocaleList` drift apart. */
function assertDocsLocaleCoverage(): void {
    const fromI18n = new Set(i18n.languages);
    const fromUi = new Set(Object.keys(docsUiByLocale));
    const fromList = new Set(docsLocaleList.map((e) => e.locale));

    for (const lang of i18n.languages) {
        if (!fromUi.has(lang)) {
            throw new Error(
                `[docs-ui-i18n] Missing docsUiByLocale["${lang}"] — add a full UI bundle when adding a language.`,
            );
        }
        if (!fromList.has(lang)) {
            throw new Error(
                `[docs-ui-i18n] docsLocaleList is missing locale "${lang}" — add { name, locale } for the language picker.`,
            );
        }
    }
    for (const key of fromUi) {
        if (!fromI18n.has(key)) {
            throw new Error(`[docs-ui-i18n] docsUiByLocale has extra key "${key}" not listed in i18n.languages.`);
        }
    }
    for (const key of fromList) {
        if (!fromI18n.has(key)) {
            throw new Error(`[docs-ui-i18n] docsLocaleList references unknown locale "${key}".`);
        }
    }
}

assertDocsLocaleCoverage();
