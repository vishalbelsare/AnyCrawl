describe('CloakBrowser local smoke', () => {
    const runSmoke = process.env.ANYCRAWL_RUN_CLOAKBROWSER_SMOKE === 'true';
    const testOrSkip = runSmoke ? test : test.skip;

    testOrSkip('starts Playwright and Puppeteer launchers with CDP access', async () => {
        const { launch: launchPlaywright } = await import('cloakbrowser');

        const playwrightBrowser: any = await launchPlaywright({ headless: true });
        try {
            const page = await playwrightBrowser.newPage();
            await page.goto('data:text/html,<title>cloak-playwright</title><main id="ok">ready</main>');
            await expect(page.evaluate(() => document.querySelector('#ok')?.textContent)).resolves.toBe('ready');
            const session = await page.context().newCDPSession(page);
            await session.send('Runtime.enable');
            await session.detach();
        } finally {
            await playwrightBrowser.close();
        }

        const { launch: launchPuppeteer } = await import('cloakbrowser/puppeteer');
        const puppeteerBrowser: any = await launchPuppeteer({ headless: true });
        try {
            const page = await puppeteerBrowser.newPage();
            await page.goto('data:text/html,<title>cloak-puppeteer</title><main id="ok">ready</main>');
            await expect(page.evaluate(() => document.querySelector('#ok')?.textContent)).resolves.toBe('ready');
            const session = await page.target().createCDPSession();
            await session.send('Runtime.enable');
            await session.detach();
        } finally {
            await puppeteerBrowser.close();
        }
    }, 240000);
});
