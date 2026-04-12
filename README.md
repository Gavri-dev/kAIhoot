<p align="center">
  <img src="https://github.com/user-attachments/assets/ff6ed9e2-087a-46c3-8a79-280eb651bdb4" alt="kAIhoot - AI-Powered Kahoot Bot Chrome Extension" width="800">
</p>

<div align="center">

#  kAIhoot

### AI-Powered Kahoot Bot Auto-Answer Chrome Extension

**The most complete Kahoot AI assistant - supports every question type, including ones no other tool can handle.**

[![Version](https://img.shields.io/badge/Version-3.5.0-blueviolet?style=for-the-badge)](https://github.com/Gavri-dev/kAIhoot/releases)
[![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)](LICENSE)
[![Chrome MV3](https://img.shields.io/badge/Chrome-Manifest_V3-blue?style=for-the-badge&logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)
[![OpenAI](https://img.shields.io/badge/Powered_by-OpenAI-412991?style=for-the-badge&logo=openai&logoColor=white)](https://platform.openai.com/api-keys)

**No quiz ID needed · No paywall · No server · Bring your own API key · Works on any live game**

> ⚠️ The host needs to have **"Show questions & answers on players' devices"** enabled in their Kahoot settings. This is on by default for most games. If the host turns it off, the extension won't have any question data to work with.

</div>

##  Table of Contents

| | |
| --- | --- |
| [• What Makes This Different](#-what-makes-this-different) | [• How It Works](#️-how-it-works) |
| [• Supported Question Types](#-supported-question-types) | [• Privacy](#-privacy) |
| [• Installation](#️-installation) | [• API Cost](#-api-cost) |
| [• Settings](#️-settings) | [• Troubleshooting](#-troubleshooting) |

##  • What Makes This Different

Most Kahoot tools only handle basic multiple-choice. Some need the Quiz ID beforehand. Others are paywalled or use a shared server that gets rate-limited.

kAIhoot works on **every** question type Kahoot offers, answers in real-time during live games, and runs entirely on your own OpenAI key. There's no middleman and no account to create.

| Feature | kAIhoot | QuizGPT | KahootGPT |
|---|:---:|:---:|:---:|
| Multiple Choice | ✅ | ✅ | ✅ |
| True/False | ✅ | ✅ | ✅ |
| Multi-Select | ✅ | ✅ | ✅ |
| Pin-It (Map/Image) 🔥 | ✅ | ❌ | ❌ |
| Jumble (Reorder) 🔥 | ✅ | ❌ | ❌ |
| Slider (Numeric) 🔥 | ✅ | ❌ | ❌ |
| Open-Ended (Type) 🔥 | ✅ | ❌ | ❌ |
| Vision AI for images 🔥 | ✅ | ❌ | ❌ |
| Works on custom quizzes | ✅ | ✅ | ❌ |
| No Quiz ID needed | ✅ | ✅ | ❌ |
| Bring your own API key | ✅ | ❌ | ❌ |
| GPT-5 support | ✅ | ❌ | ❌ |
| Answer delay (stealth) | ✅ | ✅ | ✅ |
| Silent mode | ✅ | ✅ | ❌ |
| Free & open source | ✅ | ❌ | ❌ |

##  • Supported Question Types

**Multiple Choice & True/False** - Reads the question and all choices from the WebSocket, sends to GPT, highlights and clicks the correct answer. Handles image-based choices by reading `aria-label` attributes.

**Multi-Select** - Evaluates each option independently with a YES/NO per-option prompt. Filters out fabricated or nonsensical choices and selects all correct answers (typically 2-4 out of the options).

**Pin-It (Map & Image Questions)** - Sends the image to the vision model with a step-by-step spatial reasoning prompt. The AI describes what it sees, finds visible landmarks, and estimates coordinates relative to them. Works with any image - world maps, regional maps, photos, diagrams, floor plans. Places the pin via SVG coordinate injection. No other Kahoot tool does this.

**Jumble (Reorder)** - Reads shuffled tiles, asks GPT for the correct order, computes the tile permutation, then reorders through React fiber tree manipulation and drag-click simulation.

**Slider (Numeric)** - Asks GPT the factual question, snaps the answer to the nearest valid step value using offset math (`min + round((value - min) / step) * step`), sends the WS answer during the loading animation, then sets the visual slider and clicks submit. Handles negative ranges too.

**Open-Ended (Type Answer)** - Generates a short answer within the character limit, strips any extra formatting the AI might add, types it character-by-character with simulated keyboard events (keydown → InputEvent → keyup) to work with React controlled inputs, then submits.

**Image-Based Questions (Vision Fallback)** - When any question has an attached image containing critical content (code snippets, diagrams, equations, graphs), the text model automatically detects that it can't answer without seeing the image and retries with the vision model. Works across all question types and languages — no hardcoded keyword detection.

##  • Installation

### Step 1: Download the extension

**Option A: Download ZIP (easiest, no git needed)**

1. Click the green **"Code"** button at the top of this page
2. Click **"Download ZIP"**
3. Extract/unzip the downloaded file to a folder on your computer (right-click → "Extract All" on Windows)
4. Remember where you extracted it, you'll need the folder path in the next step

**Option B: Clone with Git**

If you have Git installed, open a terminal and run:
```bash
git clone https://github.com/Gavri-dev/kAIhoot.git
```

### Step 2: Load the extension in Chrome

1. Open Chrome and type `chrome://extensions/` in the address bar, then press Enter
2. In the top-right corner, flip the **"Developer mode"** toggle to ON
3. Three new buttons appear at the top. Click **"Load unpacked"**
4. Navigate to the folder where you extracted/cloned kAIhoot and select it
5. The extension should now appear in your extensions list with the kAIhoot icon

If you see an error about `manifest.json`, make sure you selected the folder that directly contains `manifest.json`, not a parent folder.

### Step 3: Get an OpenAI API key

The extension needs an OpenAI API key to work. This is what lets it talk to GPT. You'll need to add a small amount of credit to your OpenAI account (a few dollars is plenty, a full 20-question game costs about 1-3 cents).

1. Go to [platform.openai.com](https://platform.openai.com) and create an account (or sign in)
2. Go to [platform.openai.com/settings/organization/billing](https://platform.openai.com/settings/organization/billing) and add a payment method. You can start with as little as $5, which will last hundreds of games
3. Go to [platform.openai.com/api-keys](https://platform.openai.com/api-keys) and click **"Create new secret key"**
4. Give it any name (like "kAIhoot") and click **"Create"**
5. Copy the key that appears. It starts with `sk-`. **Save it somewhere safe** because OpenAI won't show it again

### Step 4: Configure the extension

1. Click the puzzle piece icon in Chrome's top-right toolbar to see your extensions
2. Click on **kAIhoot** to open the popup
3. Click **"API Configuration"** to expand the settings panel
4. Paste your API key into the **"API Key"** field
5. Leave the model as `gpt-5-mini` (fastest and cheapest option). You can change it later
6. Click **Save**
7. The status should change from "No key" to "Connected"

### Step 5: Play

1. Go to [kahoot.it](https://kahoot.it) and join a game with a PIN like normal
2. The extension activates automatically. You'll see a small "kAIhoot: Ready" badge in the top-right corner of the screen
3. When a question appears, the extension reads it, sends it to GPT, and highlights + clicks the correct answer

That's it. If you want the extension to wait before answering (so it doesn't look suspicious), drag the **Answer Delay** slider in the popup to add a few seconds of wait time.

##  • Settings

| Setting | Default | What it does |
|---|---|---|
| Highlight Answer | ✅ On | Green glow on the correct answer |
| Auto-Click | ✅ On | Automatically clicks/submits the answer |
| Pin: Show Crosshair | ✅ On | Shows a crosshair where the pin should go |
| Pin: Auto-Place | ❌ Off | Automatically places the pin (off by default since pin accuracy can vary) |
| Answer Delay | Off | Wait 0-30 seconds before answering (shows a countdown) |
| Silent Mode | ❌ Off | Hides all on-screen indicators (status badge, timer, highlights) |
| Model | `gpt-5-mini` | Dropdown with all available models, grouped by speed/intelligence |
| Vision Model | `gpt-4.1` | Model used for pin-it and image-dependent questions |

##  • How It Works

When you join a Kahoot game, the extension intercepts the WebSocket connection between your browser and Kahoot's servers. Every time a new question gets sent to your client, kAIhoot grabs it before the UI even renders, sends it to OpenAI, and uses the response to answer automatically.

```
┌─────────────────────────────────────────────────────┐
│  Kahoot.it (Browser Tab)                            │
│                                                     │
│  ┌─────────────┐     ┌──────────────┐               │
│  │ injected.js │◄───►│  Kahoot WS   │               │
│  │ (page ctx)  │     │  Server      │               │
│  └──────┬──────┘     └──────────────┘               │
│         │ CustomEvents                              │
│  ┌──────▼──────┐                                    │
│  │ content.js  │  DOM manipulation, status UI,      │
│  │ (content)   │  answer delay, pin/jumble/slider   │
│  └──────┬──────┘                                    │
│         │ chrome.runtime messages                   │
└─────────┼───────────────────────────────────────────┘
          │
┌─────────▼───────────────────────────────────────────┐
│  autoresponder.js (Service Worker)                  │
│  Routes questions to the right handler              │
│         │                                           │
│  ┌──────▼──────┐     ┌──────────────┐               │
│  │  openai.js  │────►│  OpenAI API  │               │
│  │             │◄────│              │               │
│  └─────────────┘     └──────────────┘               │
└─────────────────────────────────────────────────────┘
```

`injected.js` hooks into the WebSocket and intercepts question data as Kahoot sends it. `content.js` enriches the question (image labels, slider range from the DOM) and passes it to the service worker. `autoresponder.js` routes it to the right handler in `openai.js`, and the answer flows back through the chain into DOM manipulation + WS submission.

Questions get sent to AI the instant they arrive via WebSocket, during the loading animation. Slider and jumble answers are submitted via WS before the UI is even interactive. Pin placement polls the SVG at 100ms intervals instead of waiting for buffers.

##  • Privacy

Your API key is stored locally in `chrome.storage.local` and only ever sent to OpenAI. There's no backend, no analytics, no telemetry, no data collection. The extension only requests permissions for `storage`, `kahoot.it`, and `api.openai.com`.

##  • API Cost

A typical 20-question game on `gpt-5-mini` costs about $0.01-0.03. Questions that use the vision model (pin-it and image-dependent questions) cost a bit more (~$0.02 each). $5 of OpenAI credit will last you a very long time.

##  • Troubleshooting

**Extension doesn't activate / no status badge appears**
- Make sure you're on `kahoot.it` (not `kahoot.com` or `create.kahoot.com`)
- Try refreshing the page after loading the extension
- Check `chrome://extensions/` and make sure kAIhoot is enabled (toggle is blue)

**"No API key" error**
- Open the extension popup and check that your key is saved
- Make sure the key starts with `sk-` and doesn't have extra spaces

**Answers are wrong or empty**
- Check that your OpenAI account has credit at [platform.openai.com/settings/organization/billing](https://platform.openai.com/settings/organization/billing)
- Try switching to a smarter model from the dropdown (like `gpt-5` or `gpt-5.4`) for harder questions

**Extension doesn't answer some question types**
- The host might have disabled "Show questions & answers on players' devices"
- Surveys and polls are intentionally skipped since they're non-scored

**"manifest.json" error when loading**
- You probably selected the wrong folder. Make sure you pick the folder that has `manifest.json` directly inside it, not a parent folder or a subfolder

##  • Tested With

Standard quiz (4-choice), true/false, multi-select (2-4 correct), pin-it with world maps and custom images, jumble (3-8 tiles), slider with numeric ranges (including negative values), open-ended with character limits, image-based answer choices, and image-dependent questions (code in images, diagrams, equations). Also works with mixed-type quizzes. Surveys and polls are auto-skipped since they're non-scored.

##  • Credits

Built by [@Gavri-dev](https://github.com/Gavri-dev). Originally based on [QuizGPT](https://github.com/im23b-busere/QuizGPT) by [@im23b-busere](https://github.com/im23b-busere) (MIT License). Extended with full question type coverage, vision AI, React DOM manipulation, WS-first submission, and a lot of speed/robustness work.

## ⚠️ Disclaimer

Educational and research purposes only. Demonstrates how browser extensions can interact with web applications through WebSocket interception and DOM manipulation. Not affiliated with Kahoot! or OpenAI. Use responsibly.

##  • License

[MIT](LICENSE) - do whatever you want, just keep the copyright notice.

<div align="center">

**If this helped you, drop a ⭐**

</div>
