const assert = require('node:assert/strict');
const test = require('node:test');

test(
  'показывает протокол в окне ядра с CSP и отклоняет запросы вне разрешённого контекста',
  { timeout: 60_000 },
  async () => {
    const { attachOwnerWindow } = await import('../../core/adapters/ui/owner-window.ts');
    const { chromium } = require(process.env.FOLIOME_STAND_PLAYWRIGHT_CORE ?? 'playwright-core');
    const owner = 'https://foliome-owner.invalid';
    const source = 'https://synthetic-source.invalid';
    const endpoint = '/preparation/login-complete';
    const label = `Тест <b> & " ' </b>`;
    const completions: string[] = [];
    const escapedRequests: string[] = [];
    const browser = await chromium.launch({
      channel: 'chrome',
      headless: true,
      chromiumSandbox: true,
      args: ['--disable-gpu'],
    });

    try {
      const sourceContext = await browser.newContext({ serviceWorkers: 'block' });
      const ownerContext = await browser.newContext({ serviceWorkers: 'block' });
      // The adapter's route is registered later and therefore gets the first chance to handle the request.
      await ownerContext.route('**/*', async (route: import('playwright-core').Route) => {
        escapedRequests.push(route.request().url());
        await route.abort();
      });
      await sourceContext.route('**/*', async (route: import('playwright-core').Route) => {
        if (route.request().url() === `${source}/` && route.request().method() === 'GET') {
          await route.fulfill({
            contentType: 'text/html',
            body: `<form method="post" action="${owner}${endpoint}"><input name="sessionId" value="session-one"><input name="nonce" value="nonce-one"><button>Отправить</button></form><a href="${owner}/">Окно</a>`,
          });
        } else {
          escapedRequests.push(route.request().url());
          await route.abort();
        }
      });
      const sourceAnchor = await sourceContext.newPage();
      const page = await ownerContext.newPage();
      const controller = await attachOwnerWindow({
        context: ownerContext,
        page,
        rows: () => [
          {
            atMs: 0,
            sourceId: 'source-synthetic',
            accessId: 'access-synthetic',
            actor: 'agent',
            method: 'read',
            snapshotNumber: 7,
            nodeNumber: 3,
            label,
            decision: 'blocked',
            reason: 'not-found',
            outcome: 'synthetic-outcome',
          },
        ],
        onLoginComplete: (sessionId: string) => {
          completions.push(sessionId);
          return true;
        },
      });

      const response = await page.goto(`${owner}/`);
      assert.equal(response?.status(), 200);
      const csp = response.headers()['content-security-policy'];
      assert.match(csp, /(?:^|;)\s*default-src\s+'none'\s*(?:;|$)/i);
      assert.match(csp, /(?:^|;)\s*form-action\s+'self'\s*(?:;|$)/i);
      assert.match(csp, /(?:^|;)\s*frame-ancestors\s+'none'\s*(?:;|$)/i);
      const table = page.locator('table');
      for (const value of [
        '1970-01-01T00:00:00.000Z',
        'source-synthetic',
        'access-synthetic',
        'read',
        '7',
        '3',
        label,
        'заблокировано',
        'Узел не найден',
        'synthetic-outcome',
      ]) {
        assert.ok((await table.innerText()).includes(value), value);
      }
      assert.equal(await table.locator('b').count(), 0);

      async function deniedNavigation(target: import('playwright-core').Page, url: string) {
        let result: import('playwright-core').Response | null = null;
        try {
          result = await target.goto(url, { timeout: 5_000 });
        } catch {
          /* A closed route may abort navigation. */
        }
        assert.ok(result === null || result.status() >= 400, `доступ разрешён: ${url}`);
      }

      async function deniedPost(
        target: import('playwright-core').Page,
        sessionId: string,
        nonce: string,
        submit: () => Promise<unknown>,
      ) {
        const outcome = new Promise<void>((resolve, reject) => {
          const matches = (request: import('playwright-core').Request) => {
            if (
              request.url() !== `${owner}${endpoint}` ||
              request.method() !== 'POST' ||
              request.frame() !== target.mainFrame()
            )
              return false;
            const body = new URLSearchParams(request.postData() ?? '');
            return body.get('sessionId') === sessionId && body.get('nonce') === nonce;
          };
          const cleanup = () => {
            clearTimeout(timer);
            target.off('response', onResponse);
            target.off('requestfailed', onFailed);
          };
          const onResponse = (response: import('playwright-core').Response) => {
            if (!matches(response.request())) return;
            cleanup();
            if (response.status() >= 400 && response.status() < 500) resolve();
            else reject(new Error(`Неожиданный статус POST: ${response.status()}`));
          };
          const onFailed = (request: import('playwright-core').Request) => {
            if (!matches(request)) return;
            cleanup();
            resolve();
          };
          const timer = setTimeout(() => {
            cleanup();
            reject(new Error('Нет исхода POST'));
          }, 5_000);
          target.on('response', onResponse);
          target.on('requestfailed', onFailed);
        });
        await Promise.all([outcome, submit().catch(() => {})]);
      }

      async function sourcePost() {
        const sourcePage = await sourceContext.newPage();
        try {
          await sourcePage.goto(`${source}/`);
          await deniedPost(sourcePage, 'session-one', 'nonce-one', () =>
            sourcePage.locator('button').click(),
          );
        } finally {
          await sourcePage.close();
        }
      }

      async function syntheticPost(sessionId: string, nonce: string) {
        const navigation = page.waitForEvent('framenavigated', {
          predicate: (frame: import('playwright-core').Frame) => frame === page.mainFrame(),
          timeout: 5_000,
        });
        await deniedPost(page, sessionId, nonce, () =>
          page.evaluate(
            ({
              endpoint,
              sessionId,
              nonce,
            }: {
              endpoint: string;
              sessionId: string;
              nonce: string;
            }) => {
              const form = document.createElement('form');
              form.method = 'post';
              form.action = endpoint;
              for (const [name, value] of Object.entries({ sessionId, nonce })) {
                const input = document.createElement('input');
                input.name = name;
                input.value = value;
                form.append(input);
              }
              document.body.append(form);
              form.submit();
            },
            { endpoint, sessionId, nonce },
          ),
        );
        await navigation;
      }

      const otherPage = await ownerContext.newPage();
      await deniedNavigation(otherPage, `${owner}/`);
      await deniedNavigation(page, `${owner}/unknown`);
      await deniedNavigation(page, `${owner}${endpoint}`);
      const sourcePage = await sourceContext.newPage();
      await deniedNavigation(sourcePage, `${owner}/`);
      await sourcePage.close();
      await sourcePost();
      assert.deepEqual(completions, []);

      controller.begin({ sessionId: 'session-one', nonce: 'nonce-one' });
      await page.goto(`${owner}/`);
      const form = page.locator(
        `form[method="post" i][action="${endpoint}"], form[method="post" i][action="${owner}${endpoint}"]`,
      );
      assert.equal(await form.count(), 1);
      assert.equal(await form.locator('[name="sessionId"]').inputValue(), 'session-one');
      assert.equal(await form.locator('[name="nonce"]').inputValue(), 'nonce-one');
      await form.locator('button, input[type="submit"]').first().click();
      assert.deepEqual(completions, ['session-one']);
      await page.goto(`${owner}/`);
      await syntheticPost('session-one', 'nonce-one');
      assert.deepEqual(completions, ['session-one']);

      controller.begin({ sessionId: 'session-two', nonce: 'nonce-two' });
      await page.goto(`${owner}/`);
      controller.close();
      await deniedPost(page, 'session-two', 'nonce-two', () =>
        page
          .locator('form[method="post" i]')
          .locator('button, input[type="submit"]')
          .first()
          .click(),
      );
      assert.deepEqual(completions, ['session-one']);
      await page.close();
      await deniedNavigation(otherPage, `${owner}${endpoint}`);
      await sourcePost();
      assert.deepEqual(completions, ['session-one']);
      await sourceAnchor.close();
      // Requests rejected by the test guard never reach the network or the source.
      assert.ok(escapedRequests.every((url) => url.startsWith(owner)));
    } finally {
      await browser.close();
    }
  },
);
