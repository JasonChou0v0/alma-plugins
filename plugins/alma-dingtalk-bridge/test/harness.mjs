/**
 * 测试支架：构造一个假的 PluginContext，把插件真正跑起来。
 * 供 inbound.mjs / unit.mjs 复用。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export function createStorage() {
    const store = {};
    return {
        local: {
            get: async (k, d) => (k in store ? store[k] : d),
            set: async (k, v) => {
                store[k] = v;
            },
            delete: async (k) => {
                delete store[k];
            },
            keys: async () => Object.keys(store),
            clear: async () => {
                for (const k of Object.keys(store)) delete store[k];
            },
        },
        raw: store,
    };
}

/**
 * @param {object} opts
 * @param {Record<string, unknown>} opts.pluginSettings  插件配置（键不带前缀）
 * @param {boolean} [opts.quiet]  是否静默插件日志
 */
export function createContext(opts = {}) {
    const { pluginSettings = {}, quiet = false, root = process.cwd(), apiPort = 23001 } = opts;

    /*
     * 测试专用 storage：内存态，不写磁盘。
     * 线上插件用的是 storage.local，这里隔离掉，测试不会污染真实会话映射。
     */
    const storage = createStorage();
    const commands = new Map();
    const notifications = [];
    const logs = [];
    const statusBar = { text: '', tooltip: '', shown: false, command: '' };

    /*
     * 捕获事件处理器与工具定义，供安全测试驱动真实生产代码
     * （如 tool.willExecute 钩子、dingtalk_notify 工具）。对其它测试无副作用。
     */
    const eventHandlers = new Map(); // eventName -> Set<handler>
    const registeredTools = new Map(); // id -> def

    const settingsMap = {};
    const withPrefix = (k) => (k.startsWith('dingtalkBridge.') ? k : `dingtalkBridge.${k}`);
    for (const [k, v] of Object.entries(pluginSettings)) {
        settingsMap[withPrefix(k)] = v;
    }
    settingsMap['dingtalkBridge.almaApiPort'] ??= apiPort;

    const say = (level) => (...args) => {
        logs.push([level, ...args]);
        if (!quiet) console.log(`[plugin:${level}]`, ...args);
    };

    const context = {
        id: 'alma-dingtalk-bridge',
        extensionPath: root,
        storagePath: path.join(root, 'test/.storage'),
        globalStoragePath: path.join(root, 'test/.storage'),
        logger: { info: say('info'), warn: say('warn'), error: say('error'), debug: () => {} },
        storage,
        settings: {
            get: (k, d) => (k in settingsMap ? settingsMap[k] : d),
            update: async (k, v) => {
                settingsMap[k] = v;
            },
            onDidChange: () => ({ dispose() {} }),
        },
        ui: {
            createStatusBarItem: () => ({
                get text() {
                    return statusBar.text;
                },
                set text(v) {
                    statusBar.text = v;
                },
                get tooltip() {
                    return statusBar.tooltip;
                },
                set tooltip(v) {
                    statusBar.tooltip = v;
                },
                command: '',
                show: () => {
                    statusBar.shown = true;
                },
                hide: () => {
                    statusBar.shown = false;
                },
                dispose: () => {
                    statusBar.shown = false;
                },
            }),
            showNotification: (m, o) => notifications.push({ message: m, options: o }),
            showError: (m) => notifications.push({ message: m, options: { type: 'error' } }),
            showWarning: (m) => notifications.push({ message: m, options: { type: 'warning' } }),
        },
        commands: {
            register: (id, def) => {
                commands.set(id, typeof def === 'function' ? def : def.handler);
                return { dispose: () => commands.delete(id) };
            },
        },
        events: {
            on: (name, handler) => {
                if (!eventHandlers.has(name)) eventHandlers.set(name, new Set());
                eventHandlers.get(name).add(handler);
                return {
                    dispose() {
                        eventHandlers.get(name)?.delete(handler);
                    },
                };
            },
            once: (name, handler) => {
                const wrap = (...a) => {
                    eventHandlers.get(name)?.delete(wrap);
                    handler(...a);
                };
                if (!eventHandlers.has(name)) eventHandlers.set(name, new Set());
                eventHandlers.get(name).add(wrap);
                return { dispose() { eventHandlers.get(name)?.delete(wrap); } };
            },
        },
        chat: {
            listThreads: async () => [],
            getThread: async () => undefined,
            getActiveThread: async () => undefined,
            getMessages: async () => [],
            createThread: async () => {
                throw new Error('chat.createThread 未接线');
            },
        },
        tools: {
            register: (id, def) => {
                registeredTools.set(id, def);
                return { dispose() { registeredTools.delete(id); } };
            },
        },
        workspace: {},
        theme: { register: () => ({ dispose() {} }) },
    };

    return { context, storage, commands, notifications, logs, statusBar, settingsMap, eventHandlers, registeredTools };
}
