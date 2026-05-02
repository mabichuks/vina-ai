#!/usr/bin/env node
import { Command } from 'commander';
import { startCommand } from './commands/start.js';
import { stopCommand } from './commands/stop.js';
import { statusCommand } from './commands/status.js';
import { logsCommand } from './commands/logs.js';
import { resetCommand } from './commands/reset.js';
import { doctorCommand } from './commands/doctor.js';

const program = new Command();

program.name('vina').description('AI-powered job application assistant').version('0.0.0');

program
  .command('start')
  .description('Start the Vina daemon and open the UI in your browser')
  .option('--no-browser', "don't open a browser (useful for CI)")
  .action(async (opts: { browser?: boolean }) => {
    process.exit(await startCommand({ noBrowser: opts.browser === false }));
  });

program
  .command('stop')
  .description('Stop the running daemon')
  .action(async () => {
    process.exit(await stopCommand());
  });

program
  .command('status')
  .description('Show the running daemon status')
  .action(async () => {
    process.exit(await statusCommand());
  });

program
  .command('logs')
  .description('Print recent log lines (or follow with -f)')
  .option('-f, --follow', 'stream new log lines as they arrive')
  .option(
    '-n, --lines <n>',
    'number of trailing lines to print',
    (v) => Number.parseInt(v, 10),
    200,
  )
  .action(async (opts: { follow?: boolean; lines?: number }) => {
    process.exit(await logsCommand({ follow: opts.follow, lines: opts.lines }));
  });

program
  .command('reset')
  .description('Wipe all Vina data (requires confirmation)')
  .option('-y, --yes', 'skip the interactive prompt')
  .action(async (opts: { yes?: boolean }) => {
    process.exit(await resetCommand({ yes: opts.yes }));
  });

program
  .command('doctor')
  .description('Run environment health checks')
  .action(async () => {
    process.exit(await doctorCommand());
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`Error: ${(err as Error).message}\n`);
  process.exit(1);
});
