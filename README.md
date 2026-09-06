# 📱 WhatsApp Web Bulk Messenger (`whatsapp-web.js`)

[![Node.js](https://img.shields.io/badge/Node.js-v16%2B-green.svg)](https://nodejs.org/)
[![whatsapp-web.js](https://img.shields.io/badge/whatsapp--web.js-v1.34.6-brightgreen.svg)](https://wwebjs.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A robust, automated WhatsApp bulk messaging utility built using **Node.js** and **`whatsapp-web.js`**. Designed for student organizations, teams, and committees (e.g., GDSC) to automate event announcements, interview invitations, and member updates reliably while maintaining strict anti-spam protections.

---

## ✨ Features

- 📲 **QR Code Terminal Auth**: Log in quickly by scanning a terminal QR code with WhatsApp's "Linked Devices".
- 🔐 **Persistent Session Management**: Session data is cached locally via `LocalAuth` so you only scan the QR code once.
- 📄 **Robust CSV Contact Parsing**: Reads contacts directly from CSV files with flexible multi-row headers and column count tolerance.
- 🔀 **Spintax & Text Variation Engine**: Supports `{Hey|Hi|Hello}` spintax in both `intro.txt` and `template.txt` to generate unique variations per contact and evade automated spam fingerprinting.
- 🔄 **Multi-Template & Intro Rotation**: Rotates through multiple message variations separated by `---` or loaded from `intro1.txt`/`template1.txt`.
- 🎯 **Per-Run Batch Limiting (`--limit=N`)**: Safely cap sending volume (default 50 contacts per run, customizable via `--limit=20`, `--limit=100`, or `--limit=all`).
- 🖼️ **Optimized Media Delivery**: Automatically attaches poster images (`poster.jpg`) and lightened PDF brochures (`BNB_26_Maharashtra_Brochure.pdf`, ~3.6 MB compressed) without crashing Puppeteer memory.
- 📝 **Smart Logging & Unregistered Number Caching**: Records sent and unregistered numbers immediately in `sent_log.json` to prevent duplicate messaging and redundant network checks.
- 🛡️ **Anti-Spam Batching & Rate Limiting**: Sends messages in batches of 5 contacts with random delays between individual contacts and mandatory pauses between batches.
- 💻 **Cross-Platform**: Operates out-of-the-box on Linux, macOS, and Windows.

---

## 📁 Repository Structure

```
whatsapp-pr-messaging/
├── index.js                          # Main bulk messaging script with batching & limits
├── test_send.js                      # Dedicated test script for 3-step sequence
├── intro.txt                         # Step 1: Intro message text (supports '---' variations & spintax)
├── template.txt                      # Step 2: PR message caption (supports '---' variations & spintax)
├── poster.jpg                        # Step 2: Event poster image
├── BNB_26_Maharashtra_Brochure.pdf   # Step 3: Official compressed BNB '26 Event Brochure (3.6 MB)
├── contacts_sample.csv               # Sample CSV phone number file
├── package.json                      # NPM configuration and scripts
├── .gitignore                        # Excludes session data, contacts.csv, sent_log.json
└── README.md                         # Project documentation
```

---

## 🚀 Quick Start

### Prerequisites

- **Node.js**: v16.x or higher ([Download Node.js](https://nodejs.org/))
- **Google Chrome** or **Chromium** browser installed on your machine
- A WhatsApp account on your mobile phone

### 1. Install Dependencies

```bash
git clone https://github.com/Xombi17/whatsapp-pr-messaging.git
cd whatsapp-pr-messaging
npm install
```

---

## 📖 Usage & Features Guide

### Step 1: Prepare Contacts (`contacts.csv`)

Create `contacts.csv` (or use `contacts_sample.csv`). Single-column or multi-column formats are both supported:

```csv
Phone
9876543210
919876543211
```

* **Phone Number Normalization**: 10-digit Indian numbers automatically receive the `91` country code.

---

### Step 2: Set Up Spintax & Multi-Text Variations

To prevent WhatsApp from flagging identical text across hundreds of contacts, add **Spintax** and **multi-intro variations** in `intro.txt` and `template.txt`.

#### Example `intro.txt` (3 Rotated Variations with Spintax):
```text
{Hey|Hi|Hello}! This is Varad from GDG CRCE. We saw that you are part of active tech/hackathon communities. We are {excited|thrilled} to announce BIT N BUILD '26!
---
{Greetings|Hello|Hey there}! Hope you are doing well. Varad Joshi here from GDG CRCE. We are officially opening registrations for BIT N BUILD '26.
---
{Hi|Hey there}! Varad here from GDSC/GDG CRCE. Reaching out with an exciting opportunity for BIT N BUILD '26!
```

#### Example `template.txt` (PR Caption with Spintax):
```text
*{The|Our}* _Ultimate Stage_ *to compete against IITs, NITs, and premier global institutions* 🌍

{Announcing|Presenting|Introducing} *Bit N Build '26*, the flagship International Hackathon presented by *Google Developer Groups (GDG)* at Fr. CRCE, Mumbai.
...
```

---

### Step 3: Run the Messenger

Execute the main script:

```bash
# 1. Standard Run (Processes first 50 unmessaged contacts by default)
npm start

# 2. Specify Custom Contact Limit (e.g. 20 contacts)
node index.js contacts.csv --limit=20

# 3. Process ALL Remaining Contacts (No Limit)
node index.js contacts.csv --limit=all

# 4. Custom Limit via Environment Variable
LIMIT=30 npm start
```

### Testing (`test_send.js`)

Run a test batch using test contacts:

```bash
npm test
# Or with custom limit:
node test_send.js test_contacts.csv --limit=5
```

---

### Step 4: Scan the QR Code

1. On first launch, a **QR Code** will render in your terminal.
2. Open **WhatsApp** on your phone > **Settings / Menu** > **Linked Devices** > **Link a Device**.
3. Scan the terminal QR code.
4. Session data will save automatically to `.wwebjs_auth/` for future runs.

---

### Dry Run (no messages sent)

`dry_run.js` runs the real `index.js` logic against a mock WhatsApp client — no QR scan, no browser, nothing delivered. Use it to sanity-check CSV parsing, phone normalisation, spintax coverage and the contact save/delete cycle before touching live numbers.

```bash
node dry_run.js test_contacts.csv --limit=12 --fast          # index.js pipeline
node dry_run.js test_contacts.csv --limit=12 --fast --single # send_single.js pipeline
```

`--fast` collapses all the anti-spam waiting. Drop it to rehearse the real pacing. `DRY_RUN_FAIL_ON=<substring>` forces send failures so you can confirm temporary contacts are still cleaned up.

---

### Temporary Contact Handling

Before messaging each recipient the scripts save them to the WhatsApp address book (`saveOrEditAddressbookContact`), send, then delete the entry again (`deleteAddressbookContact`). Messaging a long run of *unsaved* numbers is one of the behavioural patterns WhatsApp's anti-spam heuristics weight; a saved contact makes the conversation look like an ordinary 1:1 chat. Cleanup runs even if a send fails.

| Flag | Env var | Effect |
| --- | --- | --- |
| *(default)* | — | Save before send, delete after |
| `--no-save-contact` | `SAVE_CONTACTS=false` | Never save; message numbers unsaved |
| `--keep-contacts` | `KEEP_CONTACTS=true` | Save but keep the entry afterwards |
| `--sync-addressbook` | `SYNC_ADDRESSBOOK=true` | Also push the entry to your phone's address book |

This reduces risk; it does not eliminate it. Recipient **blocks and spam reports** remain the dominant ban signal — no amount of pacing offsets a list that does not want your message.

---

## 🛡️ Anti-Ban Pipeline (`pacing.js`)

All timing, budgeting and media-fingerprint logic lives in `pacing.js` and is
shared by `index.js` and `send_single.js`.

**None of this defeats WhatsApp's detection.** It removes the *automation*
signatures from your traffic. The dominant ban signal remains recipients
tapping "Report spam" or blocking you — pacing cannot fix a message people
don't want to receive.

### What changed and why

| Signature removed | How |
| --- | --- |
| Pause on exactly every 5th message | Batch size drawn from an uneven pool (3,4,6,7,4,8,3,5,6,4), reshuffled when exhausted — the average stays near 5, the pattern never repeats |
| Flat (uniform) delay histogram with a hard floor and ceiling | Log-normal delays around a median, plus a ~12% chance of a 2–5× "put the phone down" outlier |
| Identical media hash in hundreds of unrelated chats | `freshMedia()` appends random bytes after the JPEG EOI / PNG IEND (or a PDF comment line), so every send has a unique hash while the image is byte-for-byte identical when decoded |
| 3 media sends per contact in ~3 seconds | The PDF is **off by default**; inter-step gaps are now 4–5s medians, humanised |
| Send order mirroring the CSV | Contact list is shuffled, so teammates registered together don't receive back-to-back messages |
| Injected messages with no presence events | `simulateTyping()` sends `sendSeen` → `sendStateTyping` for a duration scaled to message length, then clears state |
| Sending at 3am / unbounded daily volume | Quiet hours 22:00–09:00 and a per-day cap tracked in `send_state.json` |
| Full volume on a freshly recovered number | Warm-up ramp: 20 → 35 → 50 → 70 → 100 over the first five days |
| Hammering a session WhatsApp has started refusing | Aborts after 3 consecutive send failures |

### Pacing defaults

| | `index.js` (3-step) | `send_single.js` (1-step) |
| --- | --- | --- |
| Median contact gap | ~40s | ~55s |
| Median batch pause | ~2.5 min | ~3 min |
| Batch size | 3–8, uneven | 3–8, uneven |
| Session length | 15–25 contacts | 15–25 contacts |
| Session break | ~35 min median | ~35 min median |

At these settings **100 messages takes roughly 4–5 hours of wall clock**, which
fits comfortably inside the 09:00–22:00 window. Start the run in the morning
and leave it.

### Daily budget

`send_state.json` (created automatically) records messages sent per calendar
day. It is separate from `sent_log.json`, which only prevents duplicate sends.

```
{ "days": { "2026-09-06": 42 }, "firstRunDate": "2026-09-06" }
```

The run exits when the cap is reached. Edit `DEFAULTS` in `pacing.js` to change
the cap, quiet hours, session sizes or the warm-up ramp.

### New flags

```bash
# Safest shape: one poster + caption per contact, no PDF, no follow-up burst
node send_single.js contacts.csv --limit=100

# 3-step sequence, PDF still skipped by default
node index.js contacts.csv

# Explicitly include the PDF brochure (adds a third media send per contact)
node index.js contacts.csv --pdf

# Bypass the 22:00-09:00 quiet-hours guard (not recommended)
node send_single.js contacts.csv --ignore-quiet-hours
```

### Recovering from a block

1. **Do not** run the script for 48–72 hours after the block lifts. Use the
   number normally — reply to people, be in chats.
2. Delete `send_state.json` so the warm-up ramp restarts from day 0 (20/day).
3. Prefer `send_single.js` over `index.js`. One send per contact is far safer
   than three.
4. Reply to anyone who answers. Two-way conversation is the strongest positive
   signal WhatsApp has, and inbound replies materially offset spam reports.
5. If you have a second number, split the list across both rather than pushing
   one number harder.

### Things pacing cannot fix

- **The link in the message.** `shorturl.at` is a URL shortener, and shorteners
  in bulk broadcasts are heavily weighted. Use the real
  `bitnbuild.gdgcrce.com` domain instead — it is yours, it is not a redirector,
  and it looks legitimate to both WhatsApp and the reader.
- **Messaging people who never opted in.** Contacts scraped from a registration
  sheet for a *different* event have no relationship with you. Their "report"
  taps are what got the number blocked.
- **The message itself.** A wall of bold text, emoji and a price is
  advertising, and it reads as advertising. Shorter and more personal gets
  reported less.
- **Broadcast lists.** WhatsApp's native broadcast list only delivers to people
  who have *you* saved. That restriction is the point — it is the sanctioned
  path, and it does not get you banned.

---

## 📄 License

Distributed under the MIT License. See `LICENSE` for details.

---

**Crafted with ❤️ for GDG CRCE & Community Leaders**
