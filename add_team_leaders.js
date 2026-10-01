/**
 * add_team_leaders.js
 *
 * Automatically parses Team Leaders from t1.csv (or a custom CSV),
 * connects to WhatsApp Web via whatsapp-web.js, finds the group
 * "BnB'26 Internal Round", checks admin privileges, and adds the
 * Team Leaders to the group with fast/safe pacing and auto-invite fallbacks.
 *
 * Usage:
 *   node add_team_leaders.js
 *   node add_team_leaders.js t1.csv
 *   node add_team_leaders.js --dry-run
 *   node add_team_leaders.js --group="BnB'26 Internal Round"
 *   node add_team_leaders.js --limit=10
 */

const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { parseTeamLeadersFromCsv } = require('./csv_leader_parser');

// ── Run Lock Management ───────────────────────────────────────────────────────
const RUN_LOCK_FILE = path.resolve('.whatsapp-group-adder.lock');

function acquireRunLock() {
    if (fs.existsSync(RUN_LOCK_FILE)) {
        const previousPid = Number.parseInt(fs.readFileSync(RUN_LOCK_FILE, 'utf8').trim(), 10);
        if (Number.isInteger(previousPid)) {
            try {
                process.kill(previousPid, 0);
                throw new Error(`Another group adder run is already active (PID ${previousPid}). Stop it before starting again.`);
            } catch (error) {
                if (error.code !== 'ESRCH') throw error;
            }
        }
        fs.rmSync(RUN_LOCK_FILE, { force: true });
    }
    fs.writeFileSync(RUN_LOCK_FILE, String(process.pid), { flag: 'wx' });
}

function releaseRunLock() {
    try {
        if (fs.existsSync(RUN_LOCK_FILE)) {
            const ownerPid = Number.parseInt(fs.readFileSync(RUN_LOCK_FILE, 'utf8').trim(), 10);
            if (ownerPid === process.pid) fs.rmSync(RUN_LOCK_FILE, { force: true });
        }
    } catch (error) {
        console.error('⚠️  Could not remove run lock:', error.message);
    }
}

// ── CLI Arguments & Options ──────────────────────────────────────────────────
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const isInspectOnly = args.includes('--inspect-csv') || args.includes('--list');

// Check for custom limit
const limitArg = args.find(a => a.startsWith('--limit='));
const participantLimit = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity;

// Check for custom group name override
const groupArg = args.find(a => a.startsWith('--group='));
const TARGET_GROUP_NAME = groupArg ? groupArg.split('=')[1] : "BnB'26 Internal Round";

// Check for CSV file path
const csvFileArg = args.find(a => !a.startsWith('--'));
const CSV_FILE = csvFileArg || 't1.csv';

// Offline inspection mode: parse and list leaders immediately without opening browser
if (isInspectOnly) {
    console.log(`\n🔍 Inspecting Team Leaders from "${CSV_FILE}" (Offline Mode)...`);
    if (!fs.existsSync(CSV_FILE)) {
        console.error(`❌ CSV file not found: ${CSV_FILE}`);
        process.exit(1);
    }
    const leaders = parseTeamLeadersFromCsv(CSV_FILE);
    console.log(`🎯 Total unique Team Leaders found: ${leaders.length}\n`);
    leaders.forEach((l, i) => {
        console.log(`   ${String(i + 1).padStart(3, ' ')}. ${l.name.padEnd(28, ' ')} | +${l.number} | Team: "${l.teamName || 'N/A'}"`);
    });
    console.log(`\n✅ Inspection complete. Run 'node add_team_leaders.js' to add them to "${TARGET_GROUP_NAME}".\n`);
    process.exit(0);
}

acquireRunLock();
process.once('exit', releaseRunLock);
process.once('SIGINT', () => { releaseRunLock(); process.exit(130); });
process.once('SIGTERM', () => { releaseRunLock(); process.exit(143); });

// Pacing configuration (Fast pacing selected by user: 1.0s - 2.0s jitter)
const MIN_DELAY_MS = 1000;
const MAX_DELAY_MS = 2000;
const BATCH_SIZE = 15;
const BATCH_PAUSE_MS = 6000;

const delay = ms => new Promise(res => setTimeout(res, ms));
const randomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// State log file to track and resume progress across runs
const LOG_FILE = path.resolve('add_leaders_log.json');

function loadStateLog() {
    if (fs.existsSync(LOG_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
        } catch {
            return { added: [], invited: [], already_member: [], not_found: [], failed: [] };
        }
    }
    return { added: [], invited: [], already_member: [], not_found: [], failed: [] };
}

function saveStateLog(logData) {
    fs.writeFileSync(LOG_FILE, JSON.stringify(logData, null, 2), 'utf8');
}

// ── Chrome & Puppeteer Configuration ─────────────────────────────────────────
function getPuppeteerOptions() {
    const options = {
        headless: false,
        protocolTimeout: 300000,
        timeout: 60000,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    };

    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        options.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    } else if (process.platform === 'win32') {
        const winChrome64 = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
        const winChrome32 = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
        if (fs.existsSync(winChrome64)) {
            options.executablePath = winChrome64;
        } else if (fs.existsSync(winChrome32)) {
            options.executablePath = winChrome32;
        }
    }
    return options;
}

const dismissWhatsAppWelcome = () => {
    const clickContinue = () => {
        const buttons = [...document.querySelectorAll('button, [role="button"]')];
        const continueButton = buttons.find(button => {
            const text = (button.textContent || '').trim().toLowerCase();
            return text === 'continue' && button.offsetParent !== null;
        });
        if (continueButton) continueButton.click();
    };
    new MutationObserver(clickContinue).observe(document, { childList: true, subtree: true });
    setTimeout(clickContinue, 1000);
};

// ── WhatsApp Client Setup ────────────────────────────────────────────────────
console.log('🚀 Initializing WhatsApp Client for Group Adder...');
console.log(`📁 Target CSV: ${CSV_FILE}`);
console.log(`👥 Target Group: "${TARGET_GROUP_NAME}"`);
if (isDryRun) {
    console.log('🧪 DRY-RUN MODE: No participants will actually be added.');
}

const client = new Client({
    authStrategy: new LocalAuth(),
    authTimeoutMs: 60000,
    qrMaxRetries: 5,
    userAgent: false,
    evalOnNewDoc: dismissWhatsAppWelcome,
    puppeteer: getPuppeteerOptions()
});

client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
    console.log('\n📲 QR Code generated! Please scan with WhatsApp on your phone.\n');
});

client.on('auth_failure', (msg) => {
    console.error('❌ WhatsApp Authentication Failure:', msg);
});

client.on('disconnected', (reason) => {
    console.warn('⚠️  WhatsApp Client disconnected:', reason);
});

// Normalize titles for comparison (removes smart quotes, extra spaces, casing)
function normalizeTitle(str) {
    return (str || '')
        .replace(/[\u2018\u2019`]/g, "'")
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

client.on('ready', async () => {
    console.log('\n✅ WhatsApp Client is authenticated and connected!');
    try {
        await processGroupAddition();
    } catch (err) {
        console.error('\n❌ Fatal error during execution:', err);
    } finally {
        console.log('\n🔒 Closing WhatsApp session...');
        await client.destroy();
        releaseRunLock();
        process.exit(0);
    }
});

client.initialize();

// ── Main Group Addition Logic ────────────────────────────────────────────────
async function processGroupAddition() {
    // Step 1: Parse CSV
    console.log(`\n📄 Parsing Team Leaders from "${CSV_FILE}"...`);
    if (!fs.existsSync(CSV_FILE)) {
        console.error(`❌ CSV file not found: ${CSV_FILE}`);
        return;
    }

    const leaders = parseTeamLeadersFromCsv(CSV_FILE);
    console.log(`🎯 Found ${leaders.length} unique Team Leaders with valid phone numbers in ${CSV_FILE}.`);

    if (leaders.length === 0) {
        console.log('ℹ️  No Team Leaders found. Exiting.');
        return;
    }

    // Step 2: Locate Target Group
    console.log(`\n🔍 Searching for group "${TARGET_GROUP_NAME}"...`);
    const chats = await client.getChats();
    const groupChats = chats.filter(c => c.isGroup);

    const normalizedTarget = normalizeTitle(TARGET_GROUP_NAME);
    let targetGroup = groupChats.find(c => normalizeTitle(c.name) === normalizedTarget);

    if (!targetGroup) {
        // Fallback: search for partial match
        targetGroup = groupChats.find(c => {
            const n = normalizeTitle(c.name);
            return n.includes("bnb'26") || n.includes("internal round");
        });
    }

    if (!targetGroup) {
        console.error(`❌ Could not find group matching "${TARGET_GROUP_NAME}".`);
        console.log('\n📋 Available groups on your WhatsApp account:');
        groupChats.slice(0, 15).forEach((g, idx) => console.log(`   ${idx + 1}. ${g.name}`));
        if (groupChats.length > 15) console.log(`   ...and ${groupChats.length - 15} more.`);
        return;
    }

    console.log(`✅ Found group: "${targetGroup.name}" (ID: ${targetGroup.id._serialized})`);

    // Step 3: Verify Admin Rights
    const clientUser = client.info.wid.user;
    const clientSerialized = client.info.wid._serialized;
    const participants = targetGroup.participants || [];

    const myParticipantEntry = participants.find(p => 
        p.id._serialized === clientSerialized || p.id.user === clientUser
    );

    const isAdmin = myParticipantEntry && (myParticipantEntry.isAdmin || myParticipantEntry.isSuperAdmin);

    console.log(`📊 Current group participants count: ${participants.length}/1024`);
    console.log(`🛡️  Admin check for ${client.info.pushname || clientUser}: ${isAdmin ? '✅ Verified (You are Admin)' : '❌ Not Admin'}`);

    if (!isAdmin) {
        console.error(`\n❌ Error: Your WhatsApp account is NOT an admin of "${targetGroup.name}".`);
        console.error('   WhatsApp restricts adding members to group admins only.');
        console.error('   Please promote your account to Admin in WhatsApp and run this script again.');
        return;
    }

    // Step 4: Map existing participants to avoid re-adding
    const existingWids = new Set(participants.map(p => p.id._serialized));
    const existingUsers = new Set(participants.map(p => p.id.user));

    // Step 5: Load previous state log
    const stateLog = loadStateLog();
    const alreadyProcessedInLog = new Set([
        ...stateLog.added,
        ...stateLog.invited,
        ...stateLog.already_member
    ]);

    // Step 6: Categorize Team Leaders
    const pendingLeaders = [];
    let alreadyInGroupCount = 0;
    let previouslyLoggedCount = 0;

    for (const leader of leaders) {
        if (existingWids.has(leader.wid) || existingUsers.has(leader.number)) {
            alreadyInGroupCount++;
            if (!stateLog.already_member.includes(leader.number)) {
                stateLog.already_member.push(leader.number);
            }
            continue;
        }

        if (alreadyProcessedInLog.has(leader.number)) {
            previouslyLoggedCount++;
            continue;
        }

        pendingLeaders.push(leader);
    }

    console.log(`\n📋 Pre-flight Analysis:`);
    console.log(`   • Total Team Leaders in CSV : ${leaders.length}`);
    console.log(`   • Already in WhatsApp group : ${alreadyInGroupCount}`);
    console.log(`   • Logged in previous runs   : ${previouslyLoggedCount}`);
    console.log(`   • Ready to be added now     : ${pendingLeaders.length}`);

    const leadersToProcess = pendingLeaders.slice(0, participantLimit);

    if (participantLimit < pendingLeaders.length) {
        console.log(`   ⚡ Limited to ${participantLimit} leaders by --limit flag.`);
    }

    if (leadersToProcess.length === 0) {
        console.log('\n🎉 All Team Leaders are already present in the group or processed! Nothing to do.');
        saveStateLog(stateLog);
        return;
    }

    if (isDryRun) {
        console.log('\n--- 🧪 DRY-RUN PREVIEW OF TEAM LEADERS TO BE ADDED ---');
        leadersToProcess.forEach((l, i) => {
            console.log(`[${i + 1}/${leadersToProcess.length}] ${l.name} (+${l.number}) | Team: "${l.teamName || 'N/A'}"`);
        });
        console.log('\n✅ Dry run completed successfully. Run without --dry-run to add them.');
        return;
    }

    // Step 7: Add Participants with Pacing
    console.log(`\n🚀 Starting group addition for ${leadersToProcess.length} Team Leaders...`);
    console.log(`⏱️  Pacing: ${MIN_DELAY_MS}-${MAX_DELAY_MS}ms per contact, ${BATCH_PAUSE_MS/1000}s rest every ${BATCH_SIZE} additions.\n`);

    const summary = {
        success: 0,
        invited: 0,
        alreadyMember: 0,
        notRegistered: 0,
        failed: 0
    };

    for (let i = 0; i < leadersToProcess.length; i++) {
        const leader = leadersToProcess[i];
        const progress = `[${i + 1}/${leadersToProcess.length}]`;
        const prefix = `${progress} ${leader.name} (+${leader.number} | "${leader.teamName || 'N/A'}"):`;

        try {
            // Call WhatsApp addParticipants API
            const result = await targetGroup.addParticipants([leader.wid], { autoSendInviteV4: true });
            
            // Result is keyed by serialized wid
            const res = (result && typeof result === 'object' && result[leader.wid]) ? result[leader.wid] : {};
            const code = res.code;

            if (code === 200 || result === true) {
                console.log(`${prefix} ✅ Added successfully`);
                summary.success++;
                if (!stateLog.added.includes(leader.number)) stateLog.added.push(leader.number);
            } else if (code === 403 || res.isInviteV4Sent) {
                console.log(`${prefix} 📩 Privacy restricted -> Sent private group invite DM`);
                summary.invited++;
                if (!stateLog.invited.includes(leader.number)) stateLog.invited.push(leader.number);
            } else if (code === 409) {
                console.log(`${prefix} ℹ️  Already a group member`);
                summary.alreadyMember++;
                if (!stateLog.already_member.includes(leader.number)) stateLog.already_member.push(leader.number);
            } else if (code === 404) {
                console.log(`${prefix} ⚠️  Phone number not registered on WhatsApp`);
                summary.notRegistered++;
                if (!stateLog.not_found.includes(leader.number)) stateLog.not_found.push(leader.number);
            } else if (code === 419) {
                console.error(`${prefix} 🛑 Group is FULL! WhatsApp group limit reached.`);
                break;
            } else {
                console.log(`${prefix} ⚠️  Response: ${res.message || JSON.stringify(result)}`);
                summary.failed++;
                if (!stateLog.failed.includes(leader.number)) stateLog.failed.push(leader.number);
            }
        } catch (err) {
            console.error(`${prefix} ❌ Error adding participant:`, err.message);
            summary.failed++;
            if (!stateLog.failed.includes(leader.number)) stateLog.failed.push(leader.number);
        }

        // Save progress to state log file periodically
        saveStateLog(stateLog);

        // Pacing: Delay before next addition
        if (i < leadersToProcess.length - 1) {
            if ((i + 1) % BATCH_SIZE === 0) {
                console.log(`☕ Batch of ${BATCH_SIZE} completed. Pausing for ${BATCH_PAUSE_MS / 1000}s to maintain session health...`);
                await delay(BATCH_PAUSE_MS);
            } else {
                const waitTime = randomDelay(MIN_DELAY_MS, MAX_DELAY_MS);
                await delay(waitTime);
            }
        }
    }

    // Step 8: Final Summary Table
    console.log('\n==================================================');
    console.log('🏁 GROUP ADDITION PROCESS COMPLETED');
    console.log('==================================================');
    console.log(`Target Group        : "${targetGroup.name}"`);
    console.log(`Total Leaders in CSV: ${leaders.length}`);
    console.log(`Pre-existing Members: ${alreadyInGroupCount}`);
    console.log(`Successfully Added  : ${summary.success}`);
    console.log(`Private Invites Sent: ${summary.invited}`);
    console.log(`Already Members     : ${summary.alreadyMember}`);
    console.log(`Not on WhatsApp     : ${summary.notRegistered}`);
    console.log(`Failed / Errors     : ${summary.failed}`);
    console.log(`Log File Updated    : ${LOG_FILE}`);
    console.log('==================================================\n');
}
