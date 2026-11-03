import * as os from 'node:os';
import * as path from 'node:path';

/** Runtime uses context.storagePath; the default is for standalone maintenance tools. */
export function defaultDataDir() {
    const userData = process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support', 'Alma')
        : process.platform === 'win32'
            ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Alma')
            : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Alma');
    return path.join(userData, 'plugin-storage', 'alma-dingtalk-bridge');
}

export function dataPaths(storagePath = defaultDataDir()) {
    const root = path.resolve(storagePath);
    return {
        root,
        logs: path.join(root, 'logs'),
        dashboard: path.join(root, 'dashboard'),
        snapshot: path.join(root, 'dashboard', 'data.json'),
    };
}
