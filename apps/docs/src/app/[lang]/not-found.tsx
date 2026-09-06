"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo } from "react";
import { getDocsUi, localeFromPathname } from "@/lib/docs-ui-i18n";

export default function NotFound() {
    const pathname = usePathname();
    const lang = useMemo(() => localeFromPathname(pathname), [pathname]);
    const { notFoundDescription, notFoundGoToDocs } = getDocsUi(lang);

    return (
        <div
            style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                minHeight: "60vh",
                textAlign: "center",
                padding: "2rem",
            }}
        >
            <h1 style={{ fontSize: "4rem", fontWeight: 700, margin: 0 }}>404</h1>
            <p style={{ fontSize: "1.25rem", marginTop: "0.5rem", opacity: 0.7 }}>{notFoundDescription}</p>
            <Link
                href={`/${lang}/general`}
                style={{
                    marginTop: "1.5rem",
                    padding: "0.5rem 1.5rem",
                    borderRadius: "0.5rem",
                    background: "var(--fd-primary)",
                    color: "var(--fd-primary-foreground, #fff)",
                    textDecoration: "none",
                    fontWeight: 500,
                }}
            >
                {notFoundGoToDocs}
            </Link>
        </div>
    );
}
