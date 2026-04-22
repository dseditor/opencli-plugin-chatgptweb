# opencli-plugin-chatgptweb

OpenCLI plugin for **ChatGPT web** (browser-based) — image generation and editing.

This is the web version plugin (`chatgptweb`), distinct from the official Mac app adapter.
Commands: `opencli chatgptweb image` and `opencli chatgptweb edit`.

## What's included

| File | Command | Description |
|------|---------|-------------|
| `image.js` | `opencli chatgpt image <prompt>` | Generate images with ChatGPT |
| `edit.js` | `opencli chatgpt edit <image> <prompt>` | Upload a reference image and edit it |
| `utils.js` | (shared) | Shared browser automation helpers |

## Requirements

- [OpenCLI](https://github.com/jackwener/OpenCLI) installed (`npm install -g @jackwener/opencli`)
- Logged into ChatGPT in the automation browser (`opencli browser open https://chatgpt.com`)
- ChatGPT Plus (image generation requires DALL-E / GPT-4o)

## Installation

```bash
opencli plugin install github:dseditor/opencli-plugin-chatgptweb
```

## Usage

```bash
# Generate an image
opencli chatgptweb image "a cat sitting on the moon"

# Edit a reference image
opencli chatgptweb edit ./my-photo.jpg "add a flower crown on her head"
```

## Key fixes in this version

- `edit`: replaced `document.execCommand('insertText')` with `page.nativeType()` (CDP Input.insertText) so React properly enables the send button
- `edit`: navigates directly to `/new` instead of relying on clicking "New Chat", preventing stale conversation URL false-positives in image detection
- `edit`: send is verified (URL changes to `/c/<id>` or stop button appears) before starting image polling
- `utils.js`: improved image URL detection with CDN URL scoring, sidebar exclusion, and stable polling
