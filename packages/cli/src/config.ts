import path from 'node:path';
import envPaths from 'env-paths';

const paths = envPaths('vina');

export const dataDir = process.env['VINA_DATA_DIR'] ?? paths.data;
export const logsDir = path.join(dataDir, 'logs');
export const pidFile = path.join(dataDir, 'vina.pid');
export const statusFile = path.join(dataDir, 'vina.status');
export const logFile = path.join(logsDir, 'vina.log');

export interface DaemonStatus {
  port: number;
  version: string;
  started_at: string;
  pid: number;
}
