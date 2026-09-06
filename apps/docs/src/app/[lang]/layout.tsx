import "fumadocs-ui/style.css";
import "../global.css";
import { RootProvider } from "fumadocs-ui/provider";
import { Inter } from "next/font/google";
import type { ReactNode } from "react";
import { docsLocaleList, getFumadocsTranslations } from "@/lib/docs-ui-i18n";

const inter = Inter({
    subsets: ["latin", "cyrillic", "vietnamese", "latin-ext"],
});

export default async function Layout({
    params,
    children,
}: Readonly<{
    params: Promise<{ lang: string }>;
    children: ReactNode;
}>) {
    const { lang } = await params;
    return (
        <html lang={lang} className={inter.className} suppressHydrationWarning>
            <body
                style={{
                    display: "flex",
                    flexDirection: "column",
                    minHeight: "100vh",
                }}
            >
                <RootProvider
                    i18n={{
                        locale: lang,
                        locales: docsLocaleList,
                        translations: getFumadocsTranslations(lang) as Record<string, string>,
                    }}
                >
                    {children}
                </RootProvider>
            </body>
        </html>
    );
}
