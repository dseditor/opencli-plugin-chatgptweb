import * as os from 'node:os';
import * as path from 'node:path';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { saveBase64ToFile } from '@jackwener/opencli/utils';
import { getChatGPTVisibleImageUrls, sendChatGPTMessage, waitForChatGPTImages, getChatGPTImageAssets } from './utils.js';

const CHATGPT_DOMAIN = 'chatgpt.com';

function extFromMime(mime) {
    if (mime.includes('png')) return '.png';
    if (mime.includes('webp')) return '.webp';
    if (mime.includes('gif')) return '.gif';
    return '.jpg';
}

function normalizeBooleanFlag(value) {
    if (typeof value === 'boolean') return value;
    const normalized = String(value ?? '').trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

function displayPath(filePath) {
    const home = os.homedir();
    return filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
}

async function currentChatGPTLink(page) {
    const url = await page.evaluate('window.location.href').catch(() => '');
    return typeof url === 'string' && url ? url : 'https://chatgpt.com';
}

export const imageCommand = cli({
    site: 'chatgptweb',
    name: 'image',
    description: 'Generate images with ChatGPT web and save them locally',
    domain: CHATGPT_DOMAIN,
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: false,
    defaultFormat: 'plain',
    timeoutSeconds: 240,
    args: [
        { name: 'prompt', positional: true, required: true, help: 'Image prompt to send to ChatGPT' },
        { name: 'op', default: path.join(os.homedir(), 'Pictures', 'chatgpt'), help: 'Output directory' },
        { name: 'sd', type: 'boolean', default: false, help: 'Skip download shorthand; only show ChatGPT link' },
    ],
    columns: ['status', 'file', 'link'],
    func: async (page, kwargs) => {
        const prompt = kwargs.prompt;
        const outputDir = kwargs.op || path.join(os.homedir(), 'Pictures', 'chatgpt');
        const skipDownloadRaw = kwargs.sd;
        const skipDownload = skipDownloadRaw === '' || skipDownloadRaw === true || normalizeBooleanFlag(skipDownloadRaw);
        const timeout = 120;

        // Navigate to homepage (not /new) — /new causes a hard CDP target change on first send
        await page.goto(`https://${CHATGPT_DOMAIN}`, { settleMs: 2000 });
        await page.wait(1);

        // Click "New chat" to start fresh (SPA nav, keeps same CDP target)
        await page.evaluate(`(() => {
            const btn = Array.from(document.querySelectorAll('button, a')).find(el => {
                const label = (el.getAttribute('aria-label') || '').toLowerCase();
                const text = (el.innerText || '').trim().toLowerCase();
                return label.includes('new chat') || label.includes('新對話') ||
                       text === 'new chat' || text === '新對話';
            });
            if (btn) btn.click();
        })()`).catch(() => {});
        await page.wait(2);

        // Snapshot existing images AFTER navigation so we only detect newly generated ones
        const beforeUrls = await getChatGPTVisibleImageUrls(page).catch(() => []);

        // Send the image generation prompt - must be explicit
        const sent = await sendChatGPTMessage(page, `Generate an image of: ${prompt}`);
        if (!sent) {
            return [{ status: '⚠️ send-failed', file: '📁 -', link: `🔗 ${await currentChatGPTLink(page)}` }];
        }

        // After send, ChatGPT navigates to /c/<id> (SPA route change).
        // Grab the URL quickly before the page handle goes stale.
        await page.wait(2).catch(() => {});
        const conversationUrl = await page.evaluate('window.location.href').catch(() => `https://${CHATGPT_DOMAIN}`);

        const urls = await waitForChatGPTImages(page, beforeUrls, timeout, conversationUrl);
        const link = await currentChatGPTLink(page);

        if (!urls.length) {
            return [{ status: '⚠️ no-images', file: '📁 -', link: `🔗 ${link}` }];
        }

        if (skipDownload) {
            return [{ status: '🎨 generated', file: '📁 -', link: `🔗 ${link}` }];
        }

        const assets = await getChatGPTImageAssets(page, urls.slice(0, 1));
        if (!assets.length) {
            return [{ status: '⚠️ export-failed', file: '📁 -', link: `🔗 ${link}` }];
        }

        const stamp = Date.now();
        const results = [];
        for (let index = 0; index < assets.length; index += 1) {
            const asset = assets[index];
            const base64 = asset.dataUrl.replace(/^data:[^;]+;base64,/, '');
            const suffix = assets.length > 1 ? `_${index + 1}` : '';
            const ext = extFromMime(asset.mimeType);
            const filePath = path.join(outputDir, `chatgpt_${stamp}${suffix}${ext}`);
            await saveBase64ToFile(base64, filePath);
            results.push({ status: '✅ saved', file: `📁 ${displayPath(filePath)}`, link: `🔗 ${link}` });
        }
        return results;
    },
});
