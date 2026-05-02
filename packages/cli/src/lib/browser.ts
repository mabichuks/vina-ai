import open from 'open';

export interface OpenBrowserOptions {
  /** When true, don't actually launch — used by `--no-browser` and CI. */
  skip?: boolean;
}

export async function openBrowser(url: string, options: OpenBrowserOptions = {}): Promise<void> {
  if (options.skip) return;
  await open(url, { wait: false });
}
