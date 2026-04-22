/**
 * ChatGPT web browser automation helpers for image generation.
 * Cross-platform: works on Linux/macOS/Windows via OpenCLI's CDP browser automation.
 */

export const CHATGPT_DOMAIN = 'chatgpt.com';
export const CHATGPT_URL = 'https://chatgpt.com';

const COMPOSER_SELECTOR = '[aria-label="與 ChatGPT 聊天"], [aria-label="Chat with ChatGPT"]';

function buildComposerLocatorScript() {
    const markerAttr = 'data-opencli-chatgpt-composer';
    return `
      const isVisible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const markerAttr = ${JSON.stringify(markerAttr)};
      const findComposer = () => {
        const marked = document.querySelector('[' + markerAttr + '="1"]');
        if (marked instanceof HTMLElement && isVisible(marked)) return marked;
        const selectors = ${JSON.stringify([COMPOSER_SELECTOR])};
        for (const selector of selectors) {
          const node = Array.from(document.querySelectorAll(selector)).find(c => c instanceof HTMLElement && isVisible(c));
          if (node instanceof HTMLElement) { node.setAttribute(markerAttr, '1'); return node; }
        }
        return null;
      };
      findComposer.toString = () => 'findComposer';
      return { findComposer, markerAttr };
    `;
}

/**
 * Send a message to the ChatGPT composer and submit it.
 */
export async function sendChatGPTMessage(page, text) {
    await page.evaluate(`(() => {
        const closeBtn = Array.from(document.querySelectorAll('button')).find(b =>
            ['Close sidebar', '關閉側邊欄'].includes(b.getAttribute('aria-label') || ''));
        if (closeBtn) closeBtn.click();
    })()`);
    await page.wait(0.5);

    // Activate image chip if present
    await page.evaluate(`(() => {
        const chip = Array.from(document.querySelectorAll('button')).find(b => {
            const t = (b.innerText || '').trim();
            return t.includes('製作圖片') || t.includes('Create image') || t === 'Image';
        });
        if (chip) chip.click();
    })()`).catch(() => {});
    await page.wait(1.5);

    const typeResult = await page.evaluate(`(() => {
        ${buildComposerLocatorScript()}
        const composer = findComposer();
        if (!composer) return false;
        composer.focus();
        composer.textContent = '';
        return true;
    })()`);
    if (!typeResult) return false;

    try {
        if (page.nativeType) {
            await page.nativeType(text);
        } else {
            throw new Error('nativeType unavailable');
        }
    } catch (e) {
        await page.evaluate(`(() => {
            const composer = document.querySelector('[aria-label="與 ChatGPT 聊天"], [aria-label="Chat with ChatGPT"]');
            if (!composer) return;
            composer.focus();
            document.execCommand('insertText', false, ${JSON.stringify(text)});
        })()`);
    }
    await page.wait(1.5);

    const sent = await page.evaluate(`(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b =>
            ['Send prompt', '傳送提示詞'].includes(b.getAttribute('aria-label') || '') ||
            (b.getAttribute('data-testid') || '') === 'send-button');
        if (btn && !btn.disabled) { btn.click(); return true; }
        return false;
    })()`);

    if (!sent) {
        // Fallback: Enter key
        await page.evaluate(`(() => {
            const el = document.querySelector('#prompt-textarea, [data-testid="prompt-textarea"]');
            if (el) el.focus();
        })()`);
        await page.wait(0.3);
        return false;
    }
    return true;
}

/**
 * Check if ChatGPT is still generating.
 */
export async function isGenerating(page) {
    return await page.evaluate(`(() => {
        return Array.from(document.querySelectorAll('button')).some(b => {
            const label = b.getAttribute('aria-label') || '';
            const text = (b.innerText || '').trim();
            return label === 'Stop generating' || label === '停止產生' ||
                   (b.getAttribute('data-testid') || '') === 'stop-button' ||
                   text.includes('停止') || text.includes('思考');
        });
    })()`);
}

/**
 * Get image URLs from the latest assistant reply area.
 */
export async function getChatGPTVisibleImageUrls(page) {
    return await page.evaluate(`(() => {
        // Exclude the sidebar (chat history navigation) to avoid thumbnail false-positives
        const sidebar = document.querySelector('nav[aria-label*="歷程"], nav[aria-label*="History"], nav[aria-label*="Sidebar"]');

        const isChatGPTImageCdn = (src) =>
            src.includes('oaiusercontent') || src.includes('chatgpt.com/backend') || src.includes('p=fs') || src.includes('sig=');

        const isInSidebar = (el) => !!(sidebar && sidebar.contains(el));

        const candidates = [];
        const seen = new Set();

        for (const img of document.querySelectorAll('img')) {
            const src = img.currentSrc || img.src || '';
            if (!src || src.includes('svg') || src.includes('data:')) continue;
            if (isInSidebar(img)) continue;

            const w = img.naturalWidth || img.width || 0;
            const h = img.naturalHeight || img.height || 0;
            const alt = (img.getAttribute('alt') || '').toLowerCase();
            const cls = (img.className || '').toLowerCase();

            if (alt.includes('avatar') || alt.includes('profile') || alt.includes('logo') || alt.includes('icon')) continue;
            if (cls.includes('avatar') || cls.includes('profile') || cls.includes('icon')) continue;
            // Must be large OR be a ChatGPT CDN image URL
            if (w < 128 && h < 128 && !isChatGPTImageCdn(src)) continue;
            if (seen.has(src)) continue;
            seen.add(src);

            const score = (src.includes('p=fs') ? 100 : 0) + (src.includes('sig=') ? 20 : 0) + w * h;
            candidates.push({ src, score });
        }

        candidates.sort((a, b) => b.score - a.score);
        return candidates.map(x => x.src);
    })()`);
}

/**
 * Wait for image generation to complete.
 * Primary signal: "編輯" / "Edit" button appears next to the generated image.
 * Fallback: new images detected in assistant message area.
 */
export async function waitForChatGPTImages(page, beforeUrls, timeoutSeconds, conversationUrl) {
    const beforeSet = new Set(beforeUrls || []);
    const startTime = Date.now();
    const timeoutMs = (timeoutSeconds || 120) * 1000;
    let lastKey = '';
    let stableCount = 0;
    let attached = false;

    // Initial wait for ChatGPT to start generating before first poll
    await page.wait(6).catch(() => {});

    while (Date.now() - startTime < timeoutMs) {
        try {
            const rawUrls = await getChatGPTVisibleImageUrls(page);
            const freshUrls = rawUrls.filter(u => !beforeSet.has(u));

            if (freshUrls.length) {
                const key = freshUrls.join('|');
                if (key === lastKey) {
                    stableCount++;
                    if (stableCount >= 2) return freshUrls;
                } else {
                    lastKey = key;
                    stableCount = 1;
                }
            }
        } catch (e) {
            // Page went stale after SPA navigation (chatgpt.com → chatgpt.com/c/<id>).
            // Re-attach once; after that stay on the live page — don't keep reloading.
            if (conversationUrl && !attached) {
                await page.goto(conversationUrl, { settleMs: 4000 }).catch(() => {});
                attached = true;
                await page.wait(3).catch(() => {}); // let live DOM settle after re-attach
            }
        }

        await page.wait(4).catch(() => {});
    }

    return lastKey ? lastKey.split('|') : [];
}

/**
 * Open the full-resolution image dialog by clicking the "編輯" / "Edit" button.
 * Returns true if dialog opened successfully.
 */
export async function openChatGPTImageDialog(page) {
    // Click "Edit"/"編輯" only inside the last ASSISTANT message — not the user-message edit button
    await page.evaluate(`(() => {
        const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
        const last = msgs.length ? msgs[msgs.length - 1] : null;
        if (!last) return;
        const container = last.closest('[data-message-id]') || last.parentElement || last;
        const btn = Array.from(container.querySelectorAll('button')).find(b => {
            const t = (b.innerText || '').trim();
            return t.includes('編輯') || t === 'Edit';
        });
        if (btn) btn.click();
    })()`);
    await page.wait(4);

    const dialogOpen = await page.evaluate(`(() => {
        return !!document.querySelector('[role="dialog"]');
    })()`).catch(() => false);

    if (!dialogOpen) {
        // Fallback: click the generated image directly
        await page.evaluate(`(() => {
            const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
            const last = msgs.length ? msgs[msgs.length - 1] : null;
            const img = last && Array.from(last.querySelectorAll('img'))
                .find(i => i.src && !i.src.includes('svg'));
            if (img) img.click();
        })()`);
        await page.wait(3);
    }

    return await page.evaluate(`(() => !!document.querySelector('[role="dialog"]'))()`).catch(() => false);
}

/**
 * Download generated images as base64 data URLs.
 * Tries the full-res dialog image first; falls back to assistant message images.
 * Uses async fetch with session credentials — works from within the ChatGPT page context.
 */
export async function getChatGPTImageAssets(page, urls) {
    const urlsJson = JSON.stringify(urls || []);
    return await page.evaluate(`
        (async (targetUrls) => {
            const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(String(reader.result || ''));
                reader.onerror = () => reject(new Error('FileReader error'));
                reader.readAsDataURL(blob);
            });

            const inferMime = (value, fallbackUrl) => {
                if (value && value !== 'application/octet-stream') return value;
                const lower = String(fallbackUrl || '').toLowerCase();
                if (lower.includes('.png')) return 'image/png';
                if (lower.includes('.webp')) return 'image/webp';
                if (lower.includes('.gif')) return 'image/gif';
                return 'image/jpeg';
            };

            const results = [];

            for (const targetUrl of targetUrls) {
                if (!targetUrl) continue;

                let dataUrl = '';
                let mimeType = 'image/jpeg';
                let width = 0;
                let height = 0;

                const imgEl = Array.from(document.querySelectorAll('img'))
                    .find(el => (el.currentSrc || el.src || '') === targetUrl);

                if (imgEl) {
                    width = imgEl.naturalWidth || imgEl.width || 0;
                    height = imgEl.naturalHeight || imgEl.height || 0;
                }

                if (String(targetUrl).startsWith('data:')) {
                    dataUrl = String(targetUrl);
                    mimeType = (String(targetUrl).match(/^data:([^;]+);/i) || [])[1] || 'image/png';
                } else {
                    try {
                        const res = await fetch(targetUrl, { credentials: 'include' });
                        if (res.ok) {
                            const blob = await res.blob();
                            mimeType = inferMime(blob.type, targetUrl);
                            dataUrl = await blobToDataUrl(blob);
                        }
                    } catch (e) {
                        // fetch failed — try canvas fallback
                    }

                    // Canvas fallback (may produce blank if cross-origin taint)
                    if (!dataUrl && imgEl instanceof HTMLImageElement) {
                        try {
                            const c = document.createElement('canvas');
                            c.width = imgEl.naturalWidth || imgEl.width || 512;
                            c.height = imgEl.naturalHeight || imgEl.height || 512;
                            const ctx = c.getContext('2d');
                            if (ctx) {
                                ctx.drawImage(imgEl, 0, 0);
                                dataUrl = c.toDataURL('image/png');
                                mimeType = 'image/png';
                            }
                        } catch (e) { }
                    }
                }

                if (dataUrl) {
                    results.push({ url: String(targetUrl), dataUrl, mimeType, width, height });
                }
            }

            return results;
        })(${urlsJson})
    `, urls);
}
