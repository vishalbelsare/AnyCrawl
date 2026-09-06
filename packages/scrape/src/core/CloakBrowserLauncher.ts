import { log } from "@anycrawl/libs";

export const CLOAKBROWSER_RUNTIME = "cloakbrowser" as const;

type LaunchFunction = (options?: Record<string, unknown>) => Promise<unknown>;
type PlaywrightPersistentContextFunction = (
    options: Record<string, unknown> & { userDataDir: string },
) => Promise<unknown>;

export interface CloakBrowserLauncher {
    launch: LaunchFunction;
    __anycrawlBrowserRuntime: typeof CLOAKBROWSER_RUNTIME;
}

export interface CloakBrowserPlaywrightLauncher extends CloakBrowserLauncher {
    name: () => "chromium";
    launchPersistentContext: (
        userDataDir: string,
        options?: Record<string, unknown>,
    ) => Promise<unknown>;
}

type CloakBrowserModule = {
    launch?: LaunchFunction;
    ensureBinary?: () => Promise<unknown>;
    launchPersistentContext?: PlaywrightPersistentContextFunction;
};
type LoadedCloakBrowserModule = CloakBrowserModule & {
    launch: LaunchFunction;
};

let binaryPromise: Promise<void> | null = null;
let playwrightLauncherPromise: Promise<CloakBrowserPlaywrightLauncher> | null = null;
let puppeteerLauncherPromise: Promise<CloakBrowserLauncher> | null = null;

const ensureCloakBrowserBinary = async (): Promise<void> => {
    binaryPromise ??= (async () => {
        const mod = await import("cloakbrowser") as CloakBrowserModule;
        if (typeof mod.ensureBinary === "function") {
            await mod.ensureBinary();
        }
    })();
    await binaryPromise;
};

const loadCloakBrowserModule = async (
    moduleName: "cloakbrowser" | "cloakbrowser/puppeteer",
): Promise<LoadedCloakBrowserModule> => {
    await ensureCloakBrowserBinary();
    const mod = await import(moduleName) as CloakBrowserModule;
    if (typeof mod.launch !== "function") {
        throw new Error(`${moduleName} does not export a launch function`);
    }
    return mod as LoadedCloakBrowserModule;
};

const createPlaywrightLauncher = async (): Promise<CloakBrowserPlaywrightLauncher> => {
    const mod = await loadCloakBrowserModule("cloakbrowser");
    if (typeof mod.launchPersistentContext !== "function") {
        throw new Error("cloakbrowser does not export a launchPersistentContext function");
    }

    log.info("[CloakBrowser] Using cloakbrowser Playwright launcher");
    return {
        name: () => "chromium",
        launch: mod.launch,
        launchPersistentContext: (userDataDir, options = {}) => mod.launchPersistentContext!({
            ...options,
            userDataDir,
        }),
        __anycrawlBrowserRuntime: CLOAKBROWSER_RUNTIME,
    };
};

const createPuppeteerLauncher = async (): Promise<CloakBrowserLauncher> => {
    const mod = await loadCloakBrowserModule("cloakbrowser/puppeteer");
    log.info("[CloakBrowser] Using cloakbrowser Puppeteer launcher");
    return {
        launch: mod.launch,
        __anycrawlBrowserRuntime: CLOAKBROWSER_RUNTIME,
    };
};

export const getCloakBrowserPlaywrightLauncher = async (): Promise<CloakBrowserPlaywrightLauncher> => {
    playwrightLauncherPromise ??= createPlaywrightLauncher();
    return playwrightLauncherPromise;
};

export const getCloakBrowserPuppeteerLauncher = async (): Promise<CloakBrowserLauncher> => {
    puppeteerLauncherPromise ??= createPuppeteerLauncher();
    return puppeteerLauncherPromise;
};

// --- Human-behavior layer (cloakbrowser/human) -----------------------------
// Applied per-request rather than at launch, so humanize can be toggled per
// task without forcing a dedicated browser pool. Playwright only.

type HumanPreset = "default" | "careful";

type CloakBrowserHumanModule = {
    patchContext?: (context: unknown, cfg: unknown) => void;
    resolveConfig?: (preset?: HumanPreset, overrides?: Record<string, unknown>) => unknown;
};

// Marks a browser context whose interaction methods we have already patched,
// so repeated preNavigation hooks don't stack listeners on the same context.
const HUMANIZED_CONTEXT_FLAG = "__anycrawlHumanized";

let humanModulePromise: Promise<CloakBrowserHumanModule> | null = null;

const loadCloakBrowserHumanModule = async (): Promise<CloakBrowserHumanModule> => {
    humanModulePromise ??= import("cloakbrowser/human") as Promise<CloakBrowserHumanModule>;
    return humanModulePromise;
};

export interface ApplyHumanizeOptions {
    preset?: HumanPreset;
}

/**
 * Idempotently apply cloakbrowser's human-behavior layer to a Playwright page's
 * browser context. Patches click/type/hover/scroll and mouse movement to use
 * human-like timing and Bezier curves. Safe no-op when the human module is
 * unavailable or the page is not a Playwright page. Returns true when humanize
 * is active on the context.
 */
export const applyCloakBrowserHumanize = async (
    page: any,
    options: ApplyHumanizeOptions = {},
): Promise<boolean> => {
    if (!page || typeof page.context !== "function") return false;
    const context = page.context();
    if (!context) return false;
    if (context[HUMANIZED_CONTEXT_FLAG]) return true;

    const mod = await loadCloakBrowserHumanModule();
    if (typeof mod.patchContext !== "function") {
        log.warning("[CloakBrowser] cloakbrowser/human.patchContext unavailable; humanize skipped");
        return false;
    }
    const cfg = typeof mod.resolveConfig === "function"
        ? mod.resolveConfig(options.preset ?? "default")
        : {};
    mod.patchContext(context, cfg);
    context[HUMANIZED_CONTEXT_FLAG] = true;
    return true;
};

/**
 * Best-effort human "warm-up" performed after navigation once the context is
 * humanized: a couple of Bezier-curve cursor moves so the page receives real
 * (isTrusted) mouse-movement entropy during dwell. Never throws — a warm-up
 * failure must not fail the navigation/extraction.
 */
export const cloakBrowserHumanWarmup = async (page: any): Promise<void> => {
    try {
        const vp = typeof page?.viewportSize === "function" ? page.viewportSize() : null;
        const width = vp?.width ?? 1280;
        const height = vp?.height ?? 800;
        // page.mouse.move is humanized after applyCloakBrowserHumanize().
        await page.mouse.move(Math.floor(width * 0.42), Math.floor(height * 0.38));
        await page.mouse.move(Math.floor(width * 0.58), Math.floor(height * 0.62));
    } catch {
        // best-effort only
    }
};
