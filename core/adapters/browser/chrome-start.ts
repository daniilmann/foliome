type Browser = { close(): Promise<void> };

type ChromeLaunchOptions = {
  channel: 'chrome';
  chromiumSandbox: true;
  args: string[];
  ignoreDefaultArgs: string[];
  timeout: number;
};

type ChromePorts<T extends Browser> = {
  verify(path: string, args: string[], signal: AbortSignal): Promise<boolean>;
  launch(options: ChromeLaunchOptions, signal: AbortSignal): Promise<T>;
};

type ChromeResult<T extends Browser> =
  | { ok: true; browser: T }
  | { ok: false; code: 'chrome-signature' | 'chrome-launch' | 'chrome-timeout' };

export declare const startVerifiedChrome: typeof start;
declare const exports: { startVerifiedChrome: typeof start };

async function start<T extends Browser>(
  ports: ChromePorts<T>,
  timeout: number,
): Promise<ChromeResult<T>> {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<ChromeResult<T>>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      resolve({ ok: false, code: 'chrome-timeout' });
    }, timeout);
  });

  const start = async (): Promise<ChromeResult<T>> => {
    let verified: boolean;
    try {
      verified = await ports.verify(
        '/usr/bin/codesign',
        [
          '--verify',
          '-R=anchor apple generic and certificate leaf[subject.OU] = "EQHXZ8M8AV"',
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        ],
        controller.signal,
      );
    } catch {
      return { ok: false, code: 'chrome-signature' };
    }
    if (!verified || timedOut) return { ok: false, code: 'chrome-signature' };

    try {
      const browser = await ports.launch(
        {
          channel: 'chrome',
          chromiumSandbox: true,
          args: ['--disable-sync'],
          ignoreDefaultArgs: [
            '--disable-background-networking',
            '--disable-component-update',
            '--enable-unsafe-swiftshader',
          ],
          timeout,
        },
        controller.signal,
      );
      if (timedOut) {
        try {
          await browser.close();
        } catch {
          // A late browser must never be returned, even if closing it fails.
        }
        return { ok: false, code: 'chrome-timeout' };
      }
      return { ok: true, browser };
    } catch {
      return { ok: false, code: 'chrome-launch' };
    }
  };

  try {
    return await Promise.race([start(), deadline]);
  } finally {
    clearTimeout(timer!);
  }
}

exports.startVerifiedChrome = start;
