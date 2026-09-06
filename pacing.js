/**
 * pacing.js
 *
 * Human-like pacing, daily budgeting and media-fingerprint breaking for the
 * WhatsApp senders.
 *
 * The old pacing used a fixed batch size of 5 and uniform random delays. Both
 * are machine signatures: a uniform distribution has a flat histogram and a
 * hard floor/ceiling, and a pause that lands on exactly every 5th message is
 * perfectly periodic. Real typing behaviour is right-skewed (log-normal) with
 * occasional long outliers where the person got distracted.
 *
 * Nothing here defeats WhatsApp's detection. It reduces the *automation*
 * signal. The dominant ban signal remains recipients tapping "Report spam" or
 * blocking you — no amount of pacing fixes a message people don't want.
 */

const fs = require('fs');

const STATE_FILE = './send_state.json';

const delay = ms => new Promise(res => setTimeout(res, ms));

// ── Random helpers ────────────────────────────────────────────────────────────

/** Uniform integer in [min, max]. */
function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Standard normal via Box-Muller. */
function gaussian() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Log-normal delay in ms, right-skewed around `median`.
 *
 * `sigma` controls spread (0.35 ≈ most samples within 0.5x-2x of median).
 * Roughly `outlierChance` of the time we multiply by 2-5x to imitate the user
 * putting the phone down mid-run. Clamped to [median*0.35, median*hardCapX].
 */
function humanDelay(median, { sigma = 0.4, outlierChance = 0.12, hardCapX = 6 } = {}) {
    let ms = median * Math.exp(gaussian() * sigma);
    if (Math.random() < outlierChance) ms *= 2 + Math.random() * 3;
    return Math.round(Math.min(Math.max(ms, median * 0.35), median * hardCapX));
}

/** Fisher-Yates shuffle, in place, returns the array. */
function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

// ── Uneven batch sizes ────────────────────────────────────────────────────────

/**
 * Batch sizes are drawn from an uneven pool rather than being a constant, so
 * the pause never lands on a fixed multiple. The pool is shuffled and consumed,
 * then reshuffled — this keeps the long-run average near 5 without ever
 * producing a periodic pattern.
 */
const BATCH_POOL = [3, 4, 6, 7, 4, 8, 3, 5, 6, 4];

function makeBatchSizer(pool = BATCH_POOL) {
    let queue = [];
    return function nextBatchSize() {
        if (queue.length === 0) queue = shuffle([...pool]);
        return queue.pop();
    };
}

// ── Daily budget / quiet hours ────────────────────────────────────────────────

const DEFAULTS = {
    dailyCap: 100,          // messages per calendar day
    sessionMin: 15,         // contacts before a long "put the phone down" break
    sessionMax: 25,
    sessionBreakMedian: 35 * 60 * 1000,  // ~35 min between sessions
    quietStartHour: 22,     // no sends from 22:00 ...
    quietEndHour: 9,        // ... until 09:00 local time
    warmupDays: [20, 35, 50, 70, 100], // ramp on a fresh / recovered number
};

function todayKey(d = new Date()) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function loadState(file = STATE_FILE) {
    let state = { days: {}, firstRunDate: null, consecutiveFailures: 0 };
    if (fs.existsSync(file)) {
        try { state = { ...state, ...JSON.parse(fs.readFileSync(file, 'utf-8')) }; } catch (e) { /* corrupt: start fresh */ }
    }
    if (!state.firstRunDate) state.firstRunDate = todayKey();
    return state;
}

function saveState(state, file = STATE_FILE) {
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

function sentToday(state) {
    return state.days[todayKey()] || 0;
}

function recordSend(state, file = STATE_FILE) {
    const k = todayKey();
    state.days[k] = (state.days[k] || 0) + 1;
    saveState(state, file);
}

/** Days elapsed since the very first run, used to pick a warm-up cap. */
function daysSinceFirstRun(state) {
    const start = new Date(state.firstRunDate + 'T00:00:00');
    return Math.floor((Date.now() - start.getTime()) / 86400000);
}

/**
 * Effective cap for today: the warm-up ramp for the first few days, then the
 * configured daily cap. Warm-up matters most right after an unblock — jumping
 * straight back to 100/day on a freshly restored number is the fastest way to
 * get re-banned.
 */
function todaysCap(state, cfg = DEFAULTS) {
    const d = daysSinceFirstRun(state);
    if (d < cfg.warmupDays.length) return Math.min(cfg.warmupDays[d], cfg.dailyCap);
    return cfg.dailyCap;
}

function inQuietHours(cfg = DEFAULTS, now = new Date()) {
    const h = now.getHours();
    return cfg.quietEndHour > cfg.quietStartHour
        ? (h >= cfg.quietStartHour && h < cfg.quietEndHour)
        : (h >= cfg.quietStartHour || h < cfg.quietEndHour);
}

// ── Typing simulation ─────────────────────────────────────────────────────────

/**
 * Mark the chat seen and hold the "typing..." state for a length of time
 * proportional to the message, so the recipient's client sees the same
 * presence sequence a real sender produces. Failures are non-fatal.
 */
async function simulateTyping(client, chatId, text) {
    try {
        const chat = await client.getChatById(chatId);
        await chat.sendSeen();
        await delay(humanDelay(900, { sigma: 0.5, outlierChance: 0.05 }));
        await chat.sendStateTyping();
        // ~45 wpm-ish, capped so a long PR blurb doesn't stall the run.
        const chars = (text || '').length;
        const typingMs = Math.min(2000 + chars * 18, 14000);
        await delay(humanDelay(typingMs, { sigma: 0.25, outlierChance: 0.08, hardCapX: 2 }));
        await chat.clearState();
    } catch (e) {
        // Presence APIs are best-effort; never abort a send over them.
    }
}

// ── Media fingerprint breaking ────────────────────────────────────────────────

/**
 * Return a MessageMedia whose bytes differ on every send.
 *
 * Sending the byte-identical poster to hundreds of numbers gives WhatsApp a
 * single media hash appearing in a burst of unrelated chats — the clearest
 * bulk-broadcast signal there is. Appending a few random bytes after the JPEG
 * EOI marker (or into a PNG tEXt-safe trailer) changes the hash while every
 * decoder still renders the identical image.
 */
function freshMedia(MessageMedia, filePath) {
    const buf = fs.readFileSync(filePath);
    const ext = filePath.split('.').pop().toLowerCase();
    const mime = ext === 'png' ? 'image/png'
        : ext === 'pdf' ? 'application/pdf'
        : 'image/jpeg';

    // JPEG decoders stop at EOI and PNG decoders at IEND, so trailing bytes are
    // ignored. A PDF is padded with a comment line instead — raw junk after
    // %%EOF can push `startxref` out of a strict reader's tail scan.
    const rand = require('crypto').randomBytes(randInt(16, 48)).toString('hex');
    const noise = mime === 'application/pdf'
        ? Buffer.from(`\n%${rand}\n`, 'latin1')
        : Buffer.from(rand, 'hex');
    const mixed = Buffer.concat([buf, noise]);
    return new MessageMedia(mime, mixed.toString('base64'), filePath.split(/[\/]/).pop());
}

module.exports = {
    DEFAULTS,
    STATE_FILE,
    delay,
    randInt,
    humanDelay,
    shuffle,
    makeBatchSizer,
    loadState,
    saveState,
    sentToday,
    recordSend,
    todaysCap,
    inQuietHours,
    todayKey,
    simulateTyping,
    freshMedia,
};
