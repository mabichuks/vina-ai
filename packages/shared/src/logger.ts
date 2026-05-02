import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';

const SECRET_KEYS = ['api_key', 'password', 'bearer', 'cookies', 'serpapi_key'];
// Pino's `*` matches a single segment, so we list each secret name at the top
// level and under one and two layers of nesting. Three depths cover the
// realistic shapes we log.
const REDACT_PATHS = SECRET_KEYS.flatMap((k) => [k, `*.${k}`, `*.*.${k}`]);

const isProd = process.env.NODE_ENV === 'production';
const level = process.env.LOG_LEVEL ?? (isProd ? 'info' : 'debug');

function buildOptions(): LoggerOptions {
  return {
    level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    ...(isProd
      ? {}
      : {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:standard' },
          },
        }),
  };
}

const root: Logger = pino(buildOptions());

export function createLogger(module: string): Logger {
  return root.child({ module });
}

/**
 * Test seam: build a logger that writes to a caller-provided destination
 * stream. Used by the unit tests to capture and assert on emitted records;
 * not for production use.
 */
export function createLoggerForTest(module: string, destination: DestinationStream): Logger {
  // pino-pretty transport spawns a worker thread that ignores the destination
  // arg, so test loggers always use the plain JSON sink.
  const opts = { level, redact: { paths: REDACT_PATHS, censor: '[redacted]' } };
  return pino(opts, destination).child({ module });
}

export type { Logger };
