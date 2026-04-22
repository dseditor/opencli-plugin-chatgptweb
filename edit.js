import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { saveBase64ToFile } from '@jackwener/opencli/utils';
import { getChatGPTVisibleImageUrls, getChatGPTImageAssets } from './utils.js';

const CHATGPT_DOMAIN = 'chatgpt.com';

async function currentChatGPTLink(page) {
  const url = await page.evaluate('window.location.href').catch(() => '');
  return typeof url === 'string' && url ? url : 'https://chatgpt.com';
}

async function uploadImage(page, imagePath) {
  const absPath = path.resolve(String(imagePath || ''));
  if (!fs.existsSync(absPath)) {
    return { ok: false, reason: `image not found: ${absPath}` };
  }

  const fileName = path.basename(absPath);
  let uploaded = false;

  // Try CDP file upload on #upload-photos (image-specific input, always present in DOM)
  if (page.setFileInput) {
    for (const sel of ['#upload-photos', '#upload-files', 'input[type="file"]']) {
      try {
        await page.setFileInput([absPath], sel);
        uploaded = true;
        break;
      } catch (err) {
        const msg = String(err?.message || err);
        if (!msg.includes('Unknown action') && !msg.includes('not supported') && !msg.includes('no count')) {
          throw err;
        }
      }
    }
  }

  if (!uploaded) {
    return { ok: false, reason: 'setFileInput not available or failed on all selectors' };
  }

  // Poll up to 20 s for attachment thumbnail / remove button / filename in body
  for (let i = 0; i < 13; i += 1) {
    await page.wait(i === 0 ? 1 : 1.5);
    const attachState = await page.evaluate(`(() => {
      const text = document.body ? (document.body.innerText || '') : '';
      const fileNameStr = ${JSON.stringify(fileName)};
      // Remove-file button (exact aria-label match)
      const hasRemove = Array.from(document.querySelectorAll('button,[role="button"]')).some(el => {
        const label = (el.getAttribute('aria-label') || '').toLowerCase();
        const inner = (el.innerText || '').trim();
        return label.includes('移除') || label.includes('remove') || label.includes('delete') || label.includes('刪除') ||
               inner === fileNameStr;
      });
      // Blob thumbnail from file upload
      const hasThumb = Array.from(document.querySelectorAll('img')).some(img => {
        const src = img.currentSrc || img.src || '';
        return src.includes('blob:') && !src.includes('extension');
      });
      // Filename visible anywhere in page text
      const hasName = text.includes(fileNameStr);
      return hasRemove || hasThumb || hasName;
    })()`);
    if (attachState) return { ok: true, fileName, absPath };
  }

  return { ok: false, reason: 'attachment preview did not appear after 20 s' };
}

async function sendEditPrompt(page, text) {
  await page.evaluate(`(() => {
    const cb = Array.from(document.querySelectorAll('button')).find(b =>
      ['Close sidebar', '關閉側邊欄'].includes(b.getAttribute('aria-label') || ''));
    if (cb) cb.click();
  })()`).catch(() => {});
  await page.wait(0.5);

  // Focus composer and clear any stale text
  const focused = await page.evaluate(`(() => {
    const candidates = [
      '[aria-label="與 ChatGPT 聊天"]',
      '[aria-label="Chat with ChatGPT"]',
      '#prompt-textarea',
      '[data-testid="prompt-textarea"]',
      '[contenteditable="true"]',
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (!el) continue;
      el.focus();
      el.textContent = '';
      return true;
    }
    return false;
  })()`);
  if (!focused) return false;

  await page.wait(0.3);

  // Use CDP Input.insertText — properly triggers React synthetic events
  try {
    if (page.nativeType) {
      await page.nativeType(text);
    } else {
      throw new Error('nativeType unavailable');
    }
  } catch (_) {
    await page.evaluate(`(() => {
      const el = document.querySelector(
        '[aria-label="與 ChatGPT 聊天"],[aria-label="Chat with ChatGPT"],#prompt-textarea,[contenteditable="true"]'
      );
      if (!el) return;
      el.focus();
      document.execCommand('insertText', false, ${JSON.stringify(text)});
    })()`);
  }

  // Wait for React to update send button state
  await page.wait(1.5);

  const clicked = await page.evaluate(`(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b =>
      ['Send prompt', '傳送提示詞', 'Send message', '傳送訊息'].includes(b.getAttribute('aria-label') || '') ||
      (b.getAttribute('data-testid') || '') === 'send-button');
    if (btn && !btn.disabled) { btn.click(); return true; }
    return false;
  })()`);

  if (!clicked) return false;

  // Verify send actually started (stop button or URL change within 10 s)
  for (let i = 0; i < 5; i++) {
    await page.wait(2);
    const started = await page.evaluate(`(() => {
      const url = window.location.href;
      const hasStop = Array.from(document.querySelectorAll('button')).some(b => {
        const l = b.getAttribute('aria-label') || '';
        const d = b.getAttribute('data-testid') || '';
        return l.includes('Stop') || l.includes('停止') || d === 'stop-button';
      });
      return url.includes('/c/') || hasStop;
    })()`).catch(() => false);
    if (started) return true;
  }
  return false;
}

// Two-phase image detector.
// Phase 1 (≤30 s): confirm generation actually started — URL moves to /c/<id> OR stop-button visible.
//   Returns [] immediately if generation never starts, preventing false positives from old page images.
// Phase 2: snapshot URLs at generation-start (reference image already in DOM),
//   then poll until a genuinely NEW URL appears (that is the generated image).
async function waitForGeneratedImage(page, timeoutSeconds, conversationUrl) {
  const startTime = Date.now();
  const timeoutMs = timeoutSeconds * 1000;
  let liveUrl = conversationUrl;
  let reattached = false;

  // Phase 1: wait for generation signal
  let started = false;
  while (!started && Date.now() - startTime < 30000) {
    try {
      const url = await page.evaluate('window.location.href').catch(() => '');
      if (url && url.includes('/c/')) { liveUrl = url; started = true; break; }
      started = await page.evaluate(`(() => Array.from(document.querySelectorAll('button')).some(b => {
        const l = b.getAttribute('aria-label') || '';
        const d = b.getAttribute('data-testid') || '';
        const t = (b.innerText || '').trim();
        return l.includes('Stop') || l.includes('停止') || d === 'stop-button' || t.includes('停止') || t.includes('思考');
      }))()`).catch(() => false);
    } catch (_) {}
    if (!started) await page.wait(2).catch(() => {});
  }
  if (!started) return [];

  // Phase 2: wait for reference image CDN URL to settle into the DOM before snapshotting.
  // The reference image's CDN URL appears shortly after send — if we snapshot too early,
  // it won't be in seenUrls and will be mistaken for the generated image later.
  await page.wait(8).catch(() => {});
  const seenUrls = new Set(await getChatGPTVisibleImageUrls(page).catch(() => []));

  while (Date.now() - startTime < timeoutMs) {
    try {
      const rawUrls = await getChatGPTVisibleImageUrls(page);
      const newUrls = rawUrls.filter(u => !seenUrls.has(u));
      if (newUrls.length > 0) return newUrls;
      rawUrls.forEach(u => seenUrls.add(u));
    } catch (_) {
      if (liveUrl.includes('/c/') && !reattached) {
        await page.goto(liveUrl, { settleMs: 4000 }).catch(() => {});
        reattached = true;
        await page.wait(3).catch(() => {});
      }
    }
    await page.wait(4).catch(() => {});
  }
  return [];
}


export const editCommand = cli({
  site: 'chatgptweb',
  name: 'edit',
  description: 'Upload a reference image to ChatGPT, generate an edited image, and save it locally',
  domain: CHATGPT_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  defaultFormat: 'plain',
  timeoutSeconds: 300,
  args: [
    { name: 'image', positional: true, required: true, help: 'Local image path to upload' },
    { name: 'prompt', positional: true, required: true, help: 'Edit prompt to send to ChatGPT' },
    { name: 'op', default: path.join(os.homedir(), 'Pictures', 'chatgpt'), help: 'Output directory' },
  ],
  columns: ['status', 'attachment', 'file', 'link'],
  func: async (page, kwargs) => {
    const imagePath = kwargs.image;
    const prompt = kwargs.prompt;
    const outputDir = kwargs.op || path.join(os.homedir(), 'Pictures', 'chatgpt');
    const timeout = 180;

    await page.goto(`https://${CHATGPT_DOMAIN}/new`, { settleMs: 3000 });
    await page.wait(1);

    // Upload reference image first
    const uploadResult = await uploadImage(page, imagePath);
    if (!uploadResult?.ok) {
      return [{ status: `⚠️ upload-failed: ${uploadResult?.reason || 'unknown'}`, attachment: '🖼️ -', file: '📁 -', link: `🔗 ${await currentChatGPTLink(page)}` }];
    }
    const attachName = `🖼️ ${path.basename(uploadResult.fileName || imagePath)}`;
    await page.wait(3);

    // Send edit prompt
    const sent = await sendEditPrompt(page, prompt);
    if (!sent) {
      return [{ status: '⚠️ send-failed', attachment: attachName, file: '📁 -', link: `🔗 ${await currentChatGPTLink(page)}` }];
    }

    // After send, ChatGPT navigates to /c/<id> (SPA route change). Grab URL quickly.
    await page.wait(2).catch(() => {});
    const conversationUrl = await page.evaluate('window.location.href').catch(() => `https://${CHATGPT_DOMAIN}`);

    // Delta detection: reference CDN URL appears first, generated image URL appears second
    const urls = await waitForGeneratedImage(page, timeout, conversationUrl);
    const link = await currentChatGPTLink(page);

    if (!urls.length) {
      return [{ status: '⚠️ no-images', attachment: attachName, file: '📁 -', link: `🔗 ${link}` }];
    }

    const assets = await getChatGPTImageAssets(page, urls.slice(0, 1));
    if (!assets.length) {
      return [{ status: '⚠️ export-failed', attachment: attachName, file: '📁 -', link: `🔗 ${link}` }];
    }

    const stamp = Date.now();
    const results = [];
    for (let index = 0; index < assets.length; index += 1) {
      const asset = assets[index];
      const base64 = asset.dataUrl.replace(/^data:[^;]+;base64,/, '');
      const extMap = { 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
      const ext = extMap[asset.mimeType] || '.jpg';
      const suffix = assets.length > 1 ? `_${index + 1}` : '';
      const filePath = path.join(outputDir, `chatgpt_edit_${stamp}${suffix}${ext}`);
      await saveBase64ToFile(base64, filePath);
      const home = os.homedir();
      const displayFile = filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
      results.push({ status: '✅ saved', attachment: attachName, file: `📁 ${displayFile}`, link: `🔗 ${link}` });
    }
    return results;
  }
});
