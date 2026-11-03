declare module 'ws';
declare module 'electron' {
    export const safeStorage: { isEncryptionAvailable(): boolean };
}
declare module 'zod' { export namespace z { type ZodType<T = any> = any; type infer<T> = any; } }
