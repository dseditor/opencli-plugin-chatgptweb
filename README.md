# opencli chatgpt adapter — image & edit

Custom adapters for `opencli chatgpt image` and `opencli chatgpt edit`.

Fixes the broken `edit` command and improves the `image` command navigation.

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

Copy the three files to your opencli user adapter directory:

```bash
# macOS / Linux
mkdir -p ~/.opencli/clis/chatgpt
cp edit.js image.js utils.js ~/.opencli/clis/chatgpt/

# Windows (PowerShell)
New-Item -ItemType Directory -Force "$env:USERPROFILE\.opencli\clis\chatgpt"
Copy-Item edit.js, image.js, utils.js "$env:USERPROFILE\.opencli\clis\chatgpt\"
```

## Usage

```bash
# Generate an image
opencli chatgpt image "a cat sitting on the moon"

# Edit a reference image
opencli chatgpt edit ./my-photo.jpg "add a flower crown on her head"
```

## Key fixes in this version

- `edit`: replaced `document.execCommand('insertText')` with `page.nativeType()` (CDP Input.insertText) so React properly enables the send button
- `edit`: navigates directly to `/new` instead of relying on clicking "New Chat", preventing stale conversation URL false-positives in image detection
- `edit`: send is verified (URL changes to `/c/<id>` or stop button appears) before starting image polling
- `utils.js`: improved image URL detection with CDN URL scoring, sidebar exclusion, and stable polling
