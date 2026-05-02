import fs from 'node:fs';
import { logFile } from '../config.js';

export interface LogsOptions {
  follow?: boolean;
  /** Number of trailing lines to print before following / exiting. */
  lines?: number;
}

function tailLines(text: string, n: number): string {
  if (!text) return '';
  const lines = text.split('\n');
  // Drop trailing empty string from a final newline.
  if (lines.at(-1) === '') lines.pop();
  return lines.slice(-n).join('\n') + (lines.length > 0 ? '\n' : '');
}

export async function logsCommand(options: LogsOptions = {}): Promise<number> {
  const lines = options.lines ?? 100;

  if (!fs.existsSync(logFile)) {
    process.stdout.write(`No log file at ${logFile}\n`);
    return 0;
  }

  const initial = fs.readFileSync(logFile, 'utf8');
  process.stdout.write(tailLines(initial, lines));

  if (!options.follow) return 0;

  let position = Buffer.byteLength(initial, 'utf8');
  // fs.watchFile polls — fine for a log tail; avoids depending on macOS FSEvents
  // edge cases when the daemon rotates the file out from under us.
  const stopped = new Promise<void>((resolve) => {
    process.on('SIGINT', () => resolve());
    process.on('SIGTERM', () => resolve());
  });

  fs.watchFile(logFile, { interval: 200 }, (curr) => {
    if (curr.size < position) {
      // File was truncated/rotated — start over.
      position = 0;
    }
    if (curr.size > position) {
      const fd = fs.openSync(logFile, 'r');
      const buffer = Buffer.alloc(curr.size - position);
      fs.readSync(fd, buffer, 0, buffer.length, position);
      fs.closeSync(fd);
      process.stdout.write(buffer.toString('utf8'));
      position = curr.size;
    }
  });

  await stopped;
  fs.unwatchFile(logFile);
  return 0;
}
