import type { TurnAttachment } from './types';

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export interface OutboundImage {
    bytes: Uint8Array;
    mediaType: string;
    filename: string;
}

/** Only load an explicit attachment from Alma's gallery, never an arbitrary URL or local path. */
export async function loadAlmaImage(attachment: TurnAttachment, port: number): Promise<OutboundImage> {
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/bmp'].includes(attachment.mediaType)) {
        throw new Error('暂只支持 PNG、JPEG、GIF、BMP 图片附件');
    }
    let url: URL;
    try { url = new URL(attachment.url); } catch { throw new Error('图片附件地址无效'); }
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) ||
        url.port !== String(port) || url.username || url.password || url.search || url.hash ||
        !/^\/api\/gallery\/cache\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(png|jpe?g|gif|bmp)$/i.test(url.pathname)) {
        throw new Error('仅允许转发本轮 Alma 图库中的图片附件');
    }
    const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
    if (!res.ok || !res.body) throw new Error('读取 Alma 图片附件失败');
    if (Number(res.headers.get('content-length')) > MAX_IMAGE_BYTES) {
        await res.body.cancel();
        throw new Error('图片超过钉钉 20MB 限制');
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_IMAGE_BYTES) throw new Error('图片超过钉钉 20MB 限制');
            chunks.push(value);
        }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let pos = 0;
    for (const chunk of chunks) { bytes.set(chunk, pos); pos += chunk.length; }
    let detected = '';
    if (size >= 8 && [137,80,78,71,13,10,26,10].every((n,i) => bytes[i] === n)) detected = 'image/png';
    else if (size >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) detected = 'image/jpeg';
    else if (size >= 6 && ['GIF87a', 'GIF89a'].includes(Buffer.from(bytes.subarray(0,6)).toString())) detected = 'image/gif';
    else if (size >= 2 && bytes[0] === 66 && bytes[1] === 77) detected = 'image/bmp';
    if (!detected || detected !== attachment.mediaType) throw new Error('图片内容与声明格式不符');
    return { bytes, mediaType: detected, filename: 'image.' + ({'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/bmp':'bmp'}[detected]) };
}
