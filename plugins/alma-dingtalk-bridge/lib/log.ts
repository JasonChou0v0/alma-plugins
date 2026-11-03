/**
 * 带文件落盘的日志器。
 *
 * Alma 主进程的 console 输出不落盘，排查问题时拿不到。
 * 这里把日志同步写到 context.storagePath/logs/dingtalk-bridge-YYYY-MM-DD.log，
 * 同时透传给宿主 logger。
 */
import * as fs from 'node:fs';
import { dataPaths } from './paths.mjs';
import * as path from 'node:path';

export interface HostLogger {
    info: (...a: unknown[]) => void;
    warn: (...a: unknown[]) => void;
    error: (...a: unknown[]) => void;
    debug?: (...a: unknown[]) => void;
}

export interface Logger extends HostLogger {
    /** 日志文件路径，便于在 UI 里展示 */
    filePath(): string;
}

const MAX_FILE_BYTES = 5 * 1024 * 1024;


function format(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.stack || value.message;
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

export function createLogger(host: HostLogger, storagePath?: string): Logger {
    const dir = dataPaths(storagePath).logs;
    let ready = false;
    let currentFile = '';
    let dirError: string | null = null;

    const ensureDir = (): boolean => {
        if (dirError) return false;
        try {
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
            ready = true;
            return true;
        } catch (e) {
            dirError = e instanceof Error ? e.message : String(e);
            return false;
        }
    };

    const fileFor = (): string => {
        const day = new Date().toISOString().slice(0, 10);
        return path.join(dir, `dingtalk-bridge-${day}.log`);
    };

    const write = (level: string, args: unknown[]): void => {
        if (!ready && !ensureDir()) return;
        try {
            const file = fileFor();
            /* 超限后简单截断，避免无限增长 */
            if (fs.existsSync(file) && fs.statSync(file).size > MAX_FILE_BYTES) {
                fs.writeFileSync(file, '', { mode: 0o600 });
            }
            currentFile = file;
            const line = `${new Date().toISOString()} [${level}] ${args.map(format).join(' ')}\n`;
            fs.appendFileSync(file, line, { mode: 0o600 });
        } catch {
            /* 落盘失败不能影响主流程 */
        }
    };

    return {
        info: (...a: unknown[]) => {
            write('INFO', a);
            host.info(...a);
        },
        warn: (...a: unknown[]) => {
            write('WARN', a);
            host.warn(...a);
        },
        error: (...a: unknown[]) => {
            write('ERROR', a);
            host.error(...a);
        },
        debug: (...a: unknown[]) => {
            write('DEBUG', a);
            host.debug?.(...a);
        },
        filePath: () => currentFile || (ready ? fileFor() : path.join(dir, 'dingtalk-bridge-YYYY-MM-DD.log')),
    };
}
