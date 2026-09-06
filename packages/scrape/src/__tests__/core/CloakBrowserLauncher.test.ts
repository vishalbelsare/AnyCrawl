import { jest } from '@jest/globals';

describe('CloakBrowserLauncher', () => {
    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
    });

    test('loads the Playwright-compatible CloakBrowser launcher', async () => {
        const launch = jest.fn();
        const launchPersistentContext = jest.fn(async () => ({ context: true }));
        const ensureBinary = jest.fn(async () => undefined);

        jest.unstable_mockModule('cloakbrowser', () => ({
            ensureBinary,
            launch,
            launchPersistentContext,
        }));

        const { getCloakBrowserPlaywrightLauncher } = await import('../../core/CloakBrowserLauncher.js');
        const launcher = await getCloakBrowserPlaywrightLauncher();

        expect(ensureBinary).toHaveBeenCalledTimes(1);
        expect(launcher.launch).toBe(launch);
        expect(launcher.name()).toBe('chromium');
        await launcher.launchPersistentContext('/tmp/cloak-profile', { headless: true });
        expect(launchPersistentContext).toHaveBeenCalledWith({
            headless: true,
            userDataDir: '/tmp/cloak-profile',
        });
        expect(launcher.__anycrawlBrowserRuntime).toBe('cloakbrowser');
    });

    test('loads the Puppeteer-compatible CloakBrowser launcher', async () => {
        const launch = jest.fn();
        const ensureBinary = jest.fn(async () => undefined);

        jest.unstable_mockModule('cloakbrowser', () => ({
            ensureBinary,
            launch: jest.fn(),
            launchPersistentContext: jest.fn(),
        }));
        jest.unstable_mockModule('cloakbrowser/puppeteer', () => ({
            launch,
        }));

        const { getCloakBrowserPuppeteerLauncher } = await import('../../core/CloakBrowserLauncher.js');
        const launcher = await getCloakBrowserPuppeteerLauncher();

        expect(ensureBinary).toHaveBeenCalledTimes(1);
        expect(launcher.launch).toBe(launch);
        expect(launcher.__anycrawlBrowserRuntime).toBe('cloakbrowser');
    });

    describe('applyCloakBrowserHumanize', () => {
        const makeContext = () => ({
            pages: () => [],
            on: jest.fn(),
            newPage: jest.fn(),
        });
        const makePage = (context: any) => ({ context: () => context });

        test('returns false for a non-page / missing context', async () => {
            const { applyCloakBrowserHumanize } = await import('../../core/CloakBrowserLauncher.js');
            expect(await applyCloakBrowserHumanize(null)).toBe(false);
            expect(await applyCloakBrowserHumanize({})).toBe(false);
            expect(await applyCloakBrowserHumanize({ context: () => null })).toBe(false);
        });

        test('patches the context once and is idempotent across pages', async () => {
            const patchContext = jest.fn();
            const resolveConfig = jest.fn((preset: string) => ({ preset }));
            jest.unstable_mockModule('cloakbrowser/human', () => ({ patchContext, resolveConfig }));

            const { applyCloakBrowserHumanize } = await import('../../core/CloakBrowserLauncher.js');
            const context = makeContext();

            // First page on the context patches it.
            expect(await applyCloakBrowserHumanize(makePage(context))).toBe(true);
            // A second page sharing the same context short-circuits (no re-patch).
            expect(await applyCloakBrowserHumanize(makePage(context))).toBe(true);

            expect(patchContext).toHaveBeenCalledTimes(1);
            expect(resolveConfig).toHaveBeenCalledWith('default');
        });

        test('honors the preset option', async () => {
            const patchContext = jest.fn();
            const resolveConfig = jest.fn((preset: string) => ({ preset }));
            jest.unstable_mockModule('cloakbrowser/human', () => ({ patchContext, resolveConfig }));

            const { applyCloakBrowserHumanize } = await import('../../core/CloakBrowserLauncher.js');
            await applyCloakBrowserHumanize(makePage(makeContext()), { preset: 'careful' });
            expect(resolveConfig).toHaveBeenCalledWith('careful');
        });

        test('returns false when the human module lacks patchContext', async () => {
            jest.unstable_mockModule('cloakbrowser/human', () => ({}));
            const { applyCloakBrowserHumanize } = await import('../../core/CloakBrowserLauncher.js');
            expect(await applyCloakBrowserHumanize(makePage(makeContext()))).toBe(false);
        });
    });

    describe('cloakBrowserHumanWarmup', () => {
        test('performs humanized cursor moves', async () => {
            const { cloakBrowserHumanWarmup } = await import('../../core/CloakBrowserLauncher.js');
            const move = jest.fn(async () => undefined);
            const page = { viewportSize: () => ({ width: 1000, height: 800 }), mouse: { move } };
            await cloakBrowserHumanWarmup(page);
            expect(move).toHaveBeenCalledTimes(2);
        });

        test('never throws on a broken page', async () => {
            const { cloakBrowserHumanWarmup } = await import('../../core/CloakBrowserLauncher.js');
            await expect(cloakBrowserHumanWarmup(null)).resolves.toBeUndefined();
            await expect(cloakBrowserHumanWarmup({ mouse: { move: () => { throw new Error('boom'); } } }))
                .resolves.toBeUndefined();
        });
    });
});
