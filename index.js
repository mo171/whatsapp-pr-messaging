const fs = require('fs');
const path = require('path');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { parse } = require('csv-parse/sync');
const { getContactOptions, saveContact, removeContact, describeContactOptions } = require('./contact_manager');
const pacing = require('./pacing');

// Log file to track sent messages and avoid duplicates across runs
const LOG_FILE = './sent_log.json';

// Positional file arguments, ignoring any --flags (e.g. --limit=20, --keep-contacts)
const ARGS = process.argv.slice(2).filter(a => !a.startsWith('--'));

// Rate Limiting & Batching Configuration
//
// Delays are log-normal medians, not min/max windows, and the batch size is
// drawn from an uneven pool rather than being a constant. See pacing.js for
// why a flat random range and an every-Nth pause are both automation tells.
const CONTACT_DELAY_MEDIAN = 40000;      // ~40s typical gap between contacts
const BATCH_PAUSE_MEDIAN = 150000;       // ~2.5min typical pause after a batch
const nextBatchSize = pacing.makeBatchSizer();   // uneven batch sizes, 3-8

const delay = pacing.delay;

/**
 * Utility helper for Spintax resolution.
 * Replaces patterns like "{Hey|Hi|Hello}" with a randomly selected choice per message.
 */
function applySpintax(text) {
    if (!text) return '';
    return text.replace(/\{([^{}]+)\}/g, (match, choices) => {
        const options = choices.split('|');
        return options[Math.floor(Math.random() * options.length)].trim();
    });
}


// Default text fallbacks if text files are missing
const DEFAULT_INTRO = `Hey this is Varad from GDG CRCE. We are excited to announce that we are back with our flagship international hackathon BIT N BUILD. Looking forward to see you there!`;

const DEFAULT_PR_MESSAGE = `*The* _Ultimate Stage_ *to compete against IITs, NITs, and premier global institutions* 🌍

Announcing *Bit N Build '26*, the flagship International Hackathon presented by *Google Developer Groups (GDG)* at Fr. Conceicao Rodrigues College of Engineering, Mumbai.

📋Event Details:
_Phase 1:_ *Maharashtra State Level Hackathon (ONLINE)*
🗓️ Date: 3rd-4th October, 2026
👥 Team Size: 2-4 participants 
💳 Fee: ₹200
👉 https://shorturl.at/BRGJK

_Phase 2:_ *Grand Finale (OFFLINE)*
🗓️ Date: 31st October - 1st November, 2026
📍 Location: Fr. CRCE, Bandra, Mumbai
🏆 Prize Pool: ₹1,00,000+ cash prizes
🔖 Participation Certificates + Goodies for all valid submissions 

💎  Why Join?
• Compete with IIT, NIT, IIIT & top global institutes. 
• Get mentored by industry leaders & connect with recruiters
• Curated merchandise & participation certificates for all valid submissions 

Website: https://bitnbuild.gdgcrce.com/

📞 Queries: 
Varad Joshi:  +91 90821 58583
Kevin Synet:  +91 84468 58648
Scarlett Menezes: +91 99217 58998

*Register Now!*`;

/**
 * Configure Puppeteer launch options cross-platform (Windows, macOS, Linux).
 */
function getPuppeteerOptions() {
    const options = {
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
    } else if (process.platform === 'linux' && fs.existsSync('/opt/google/chrome/google-chrome')) {
        options.executablePath = '/opt/google/chrome/google-chrome';
    } else if (process.platform === 'darwin' && fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')) {
        options.executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
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

// Initialize WhatsApp Web Client with LocalAuth (persists session QR scan)
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: getPuppeteerOptions()
});

// Display QR code in the terminal when authentication is needed
client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
    console.log('\n📲 QR Code generated! Scan it using WhatsApp on your phone (Linked Devices).\n');
});

// Event triggered once WhatsApp Web authentication succeeds
client.on('ready', async () => {
    console.log('\n✅ WhatsApp Client is authenticated and ready!');

    try {
        // Determine input CSV file path
        const csvFile = ARGS[0] || (fs.existsSync('./contacts.csv') ? './contacts.csv' : null);

        if (!csvFile) {
            console.error('❌ Error: No CSV file provided!');
            console.log('Usage: node index.js <contacts.csv> [intro.txt] [template.txt] [brochure.pdf] [poster.jpg]');
            console.log('Example: node index.js contacts.csv');
            await client.destroy();
            process.exit(1);
        }

        if (!fs.existsSync(csvFile)) {
            console.error(`❌ Error: CSV file "${csvFile}" not found.`);
            await client.destroy();
            process.exit(1);
        }

        console.log(`📂 Reading contact numbers from "${csvFile}"...`);
        const csvText = fs.readFileSync(csvFile, 'utf-8');
        const records = parse(csvText, { skip_empty_lines: true, relax_column_count: true });

        if (records.length === 0) {
            console.log('⚠️ CSV file is empty. Nothing to process.');
            await client.destroy();
            process.exit(0);
        }

        // Determine column indexes dynamically across first few rows for 1-column / multi-column CSVs
        let phoneIndex = 0;
        let nameIndex = -1;
        let startIndex = 0;

        for (let r = 0; r < Math.min(5, records.length); r++) {
            const rowStr = records[r].map(cell => (cell || '').toString().trim().toLowerCase());
            const detectedPhoneIdx = rowStr.findIndex(h => h.includes('phone') || h.includes('number') || h.includes('mobile'));
            const detectedNameIdx = rowStr.findIndex(h => h.includes('name') || h.includes('first'));

            if (detectedPhoneIdx !== -1) {
                phoneIndex = detectedPhoneIdx;
                if (detectedNameIdx !== -1 && detectedNameIdx !== phoneIndex) nameIndex = detectedNameIdx;
                startIndex = r + 1; // Skip up to this header row
            }
        }

        const allContacts = [];
        for (let i = startIndex; i < records.length; i++) {
            const row = records[i];
            
            let rawPhone = '';
            let rawName = '';

            if (row.length === 1) {
                rawPhone = (row[0] || '').toString().trim();
            } else {
                rawPhone = (row[phoneIndex] || row[0] || '').toString().trim();
                if (nameIndex !== -1 && row[nameIndex]) {
                    rawName = row[nameIndex].toString().trim();
                }
            }

            if (!rawPhone || rawPhone.toLowerCase() === 'phone' || rawPhone.toLowerCase() === 'number') continue;

            // Normalize phone number into E.164 format without '+' prefix (e.g. 91XXXXXXXXXX)
            let cleanedNumber = rawPhone.replace(/\D/g, '');

            if (cleanedNumber.length === 10) {
                cleanedNumber = '91' + cleanedNumber; // Default country code: India (+91)
            }

            if (cleanedNumber.length < 11 || cleanedNumber.length > 15) {
                console.log(`⚠️ Skipping invalid phone number "${rawPhone}" (normalized: "${cleanedNumber}")`);
                continue;
            }

            allContacts.push({
                number: cleanedNumber,
                name: rawName
            });
        }

        // Initialize or load sent_log.json to prevent duplicate sends
        let sentLogData = [];
        if (fs.existsSync(LOG_FILE)) {
            try {
                sentLogData = JSON.parse(fs.readFileSync(LOG_FILE, 'utf-8'));
            } catch (e) {
                sentLogData = [];
            }
        } else {
            // Automatically create sent_log.json on first run
            fs.writeFileSync(LOG_FILE, JSON.stringify([], null, 2));
            console.log(`📄 Created log file "${LOG_FILE}" to track sent contacts.`);
        }
        const sentLog = new Set(sentLogData);

        // Filter out contacts that were already messaged in previous runs
        const uniqueContacts = [];
        let skippedCount = 0;
        for (const contact of allContacts) {
            if (!sentLog.has(contact.number)) {
                uniqueContacts.push(contact);
                sentLog.add(contact.number); // Prevent intra-CSV duplicates
            } else {
                skippedCount++;
            }
        }

        console.log(`📊 Total Valid Phone Numbers: ${allContacts.length}`);
        if (skippedCount > 0) {
            console.log(`⏭️  Already Messaged Previously: ${skippedCount} (Skipped automatically)`);
        }
        console.log(`✉️  New Unmessaged Contacts Remaining: ${uniqueContacts.length}`);

        if (uniqueContacts.length === 0) {
            console.log('🎉 All contacts have already been messaged! Exiting...');
            await client.destroy();
            process.exit(0);
        }

        // Determine max contacts limit for this run (--limit=50 or LIMIT=50)
        let maxLimit = 50; // Default limit per run
        const limitArg = process.argv.find(arg => arg.startsWith('--limit='));
        if (limitArg) {
            const val = limitArg.split('=')[1].trim().toLowerCase();
            if (val === 'all' || val === '0' || val === 'false') {
                maxLimit = Infinity;
            } else {
                maxLimit = parseInt(val, 10) || 50;
            }
        } else if (process.env.LIMIT) {
            const val = process.env.LIMIT.trim().toLowerCase();
            if (val === 'all' || val === '0' || val === 'false') {
                maxLimit = Infinity;
            } else {
                maxLimit = parseInt(process.env.LIMIT, 10) || 50;
            }
        }

        // ── Daily budget & quiet hours ────────────────────────────────
        // send_state.json tracks how many messages went out per calendar day,
        // independently of sent_log.json (which only prevents duplicates).
        const state = pacing.loadState();
        const cap = pacing.todaysCap(state);
        const already = pacing.sentToday(state);
        const remainingToday = Math.max(0, cap - already);

        if (pacing.inQuietHours()) {
            console.log(`🌙 Quiet hours (${pacing.DEFAULTS.quietStartHour}:00-${pacing.DEFAULTS.quietEndHour}:00). Bulk sending at 3am is not something a human does — exiting.`);
            console.log('   Override with --ignore-quiet-hours if you really mean to.');
            if (!process.argv.includes('--ignore-quiet-hours')) {
                await client.destroy();
                process.exit(0);
            }
        }

        console.log(`📅 Today's budget: ${already}/${cap} used, ${remainingToday} remaining.`);
        if (remainingToday === 0) {
            console.log('🛑 Daily cap reached. Stopping — come back tomorrow.');
            await client.destroy();
            process.exit(0);
        }

        // Shuffle so the send order does not mirror the CSV (registration
        // order clusters teammates, who then compare identical messages).
        let contactsToProcess = pacing.shuffle([...uniqueContacts]);

        const effectiveLimit = Math.min(maxLimit, remainingToday);
        if (effectiveLimit < contactsToProcess.length) {
            console.log(`🎯 Limit Applied: Processing ${effectiveLimit} contacts out of ${uniqueContacts.length} available (run limit ${maxLimit === Infinity ? 'none' : maxLimit}, daily remaining ${remainingToday}).`);
            contactsToProcess = contactsToProcess.slice(0, effectiveLimit);
        } else {
            console.log(`🎯 Limit: Processing all ${contactsToProcess.length} contact(s) for this run.`);
        }

        console.log(`⚙️  Pacing: uneven batches (3-8), ~${CONTACT_DELAY_MEDIAN / 1000}s median contact gap, ~${(BATCH_PAUSE_MEDIAN / 60000).toFixed(1)}min median batch pause\n`);

        // Step 1 Text: Intro Message Variations & Spintax Support
        let introVariations = [];
        const introFile = ARGS[1] || (fs.existsSync('./intro.txt') ? './intro.txt' : null);

        if (introFile && fs.existsSync(introFile)) {
            const rawIntro = fs.readFileSync(introFile, 'utf-8').trim();
            if (rawIntro.includes('---')) {
                introVariations = rawIntro.split('---').map(s => s.trim()).filter(Boolean);
                console.log(`📝 Loaded ${introVariations.length} Intro Message variations from "${introFile}" (separated by '---')`);
            } else {
                introVariations.push(rawIntro);
                console.log(`📝 Loaded Step 1 Intro Message from "${introFile}"`);
            }
        }

        // Check for standalone files (intro1.txt, intro2.txt, intro3.txt)
        const standaloneIntroFiles = ['./intro1.txt', './intro2.txt', './intro3.txt', './intro_1.txt', './intro_2.txt', './intro_3.txt'];
        for (const file of standaloneIntroFiles) {
            if (fs.existsSync(file)) {
                const content = fs.readFileSync(file, 'utf-8').trim();
                if (content && !introVariations.includes(content)) {
                    introVariations.push(content);
                    console.log(`📝 Loaded additional Intro variation from "${file}"`);
                }
            }
        }

        if (introVariations.length === 0) {
            introVariations = [DEFAULT_INTRO];
        }

        console.log(`ℹ️  Total active Intro Message variations: ${introVariations.length}`);

        // Step 2 Caption: PR Message Variations & Spintax Support
        let prVariations = [];
        const templateFile = ARGS[2] || (fs.existsSync('./template.txt') ? './template.txt' : null);

        if (templateFile && fs.existsSync(templateFile)) {
            const rawTemplate = fs.readFileSync(templateFile, 'utf-8').trim();
            if (rawTemplate.includes('---')) {
                prVariations = rawTemplate.split('---').map(s => s.trim()).filter(Boolean);
                console.log(`📝 Loaded ${prVariations.length} PR Message variations from "${templateFile}" (separated by '---')`);
            } else {
                prVariations.push(rawTemplate);
                console.log(`📝 Loaded Step 2 PR Message Caption from "${templateFile}"`);
            }
        }

        // Check for standalone template files (template1.txt, template2.txt, template3.txt)
        const standaloneTemplateFiles = ['./template1.txt', './template2.txt', './template3.txt', './template_1.txt', './template_2.txt', './template_3.txt'];
        for (const file of standaloneTemplateFiles) {
            if (fs.existsSync(file)) {
                const content = fs.readFileSync(file, 'utf-8').trim();
                if (content && !prVariations.includes(content)) {
                    prVariations.push(content);
                    console.log(`📝 Loaded additional PR Message variation from "${file}"`);
                }
            }
        }

        if (prVariations.length === 0) {
            prVariations = [DEFAULT_PR_MESSAGE];
        }

        console.log(`ℹ️  Total active PR Message variations: ${prVariations.length}`);

        // Step 2 Image: Poster Image (poster.jpg, poster.png, BNB_Poster.jpg, etc.)
        let posterMedia = null;
        const posterCandidates = ['./poster.jpg', './poster.png', './poster.jpeg', './BNB_Poster.jpg', './BNB_Poster.png'];
        const customPosterArg = ARGS[4];
        let posterPath = customPosterArg;

        if (!posterPath) {
            for (const cand of posterCandidates) {
                if (fs.existsSync(cand)) {
                    posterPath = cand;
                    break;
                }
            }
        }

        if (posterPath && fs.existsSync(posterPath)) {
            posterMedia = MessageMedia.fromFilePath(posterPath);
            console.log(`🖼️  Loaded Step 2 Poster Image: "${posterPath}"`);
        }

        // Step 3 Document: PDF Brochure
        let pdfMedia = null;
        const defaultBnbPdf = './BNB_26_Maharashtra_Brochure.pdf';
        // The PDF is OFF by default. A third media send per contact, carrying a
        // byte-identical document hash into every chat, is one of the loudest
        // bulk signals available. Re-enable deliberately with --pdf.
        const wantPdf = process.argv.includes('--pdf');
        const pdfArg = wantPdf ? (ARGS[3] || (fs.existsSync(defaultBnbPdf) ? defaultBnbPdf : null)) : null;
        if (!wantPdf) console.log('📎 PDF brochure skipped (pass --pdf to include it).');
        if (pdfArg && fs.existsSync(pdfArg)) {
            pdfMedia = MessageMedia.fromFilePath(pdfArg);
            pdfMedia.filename = "BNB'26 Maharashtra Brochure.pdf";
            console.log(`📎 Loaded Step 3 PDF Brochure: "${pdfArg}" (WhatsApp Display Title: "${pdfMedia.filename}")`);
        }

        // Temporary address-book handling (save before send, delete after)
        const contactOptions = getContactOptions();
        console.log(`👤 ${describeContactOptions(contactOptions)}`);

        console.log(`\n🚀 Executing 3-Step Delivery Sequence for ${contactsToProcess.length} recipient(s):\n 1. Intro Message\n 2. Poster Image + Attached PR Caption\n 3. PDF Brochure Document\n`);

        // Batch and session counters. Both targets are re-drawn every time
        // they are hit, so no pause ever lands on a fixed multiple.
        let batchTarget = nextBatchSize();
        let sessionTarget = pacing.randInt(pacing.DEFAULTS.sessionMin, pacing.DEFAULTS.sessionMax);
        let sentInBatch = 0;
        let sentInSession = 0;
        let consecutiveFailures = 0;

        for (let i = 0; i < contactsToProcess.length; i++) {
            const { number, name } = contactsToProcess[i];
            const chatId = `${number}@c.us`;
            let savedContact = false;

            console.log(`[${i + 1}/${contactsToProcess.length}] Processing number (${number})...`);

            try {
                const isRegistered = await client.isRegisteredUser(chatId);
                if (!isRegistered) {
                    console.log(`❌ Number ${number} is not registered on WhatsApp. Logging and skipping.`);
                    sentLogData.push(number);
                    fs.writeFileSync(LOG_FILE, JSON.stringify(sentLogData, null, 2));
                } else {
                    // Rotate through available intro and PR template variations
                    const rawIntro = introVariations[i % introVariations.length];
                    const rawPR = prVariations[i % prVariations.length];
                    let finalIntro = rawIntro;
                    let finalPR = rawPR;

                    // Clean up any residual {{name}} placeholder safely
                    finalIntro = finalIntro.replace(/\{\{name\}\}\s*/g, '');
                    finalPR = finalPR.replace(/\{\{name\}\}\s*/g, '');

                    // Apply Spintax resolution (e.g. "{Hey|Hi|Hello}")
                    finalIntro = applySpintax(finalIntro);
                    finalPR = applySpintax(finalPR);

                    // ── STEP 0: Temporarily save the recipient as a contact ───────
                    savedContact = await saveContact(client, number, name, contactOptions);

                    // ── STEP 1: Send Standalone Intro Message ──────────────────────
                    console.log(`📤 [Step 1/3] Sending Intro Text Message to ${number}...`);
                    await pacing.simulateTyping(client, chatId, finalIntro);
                    await client.sendMessage(chatId, finalIntro);
                    console.log(`✅ Step 1: Intro Message sent to ${number}`);

                    await delay(pacing.humanDelay(4000, { sigma: 0.45 })); // pause between Step 1 and Step 2

                    // ── STEP 2: Send Poster Image + Attached PR Message Caption ───
                    if (posterMedia) {
                        console.log(`📤 [Step 2/3] Sending Poster Image with attached PR Caption...`);
                        // Fresh bytes per send: an identical poster hash landing in
                        // hundreds of unrelated chats is the clearest broadcast signal.
                        await pacing.simulateTyping(client, chatId, finalPR);
                        await client.sendMessage(chatId, pacing.freshMedia(MessageMedia, posterPath), { caption: finalPR });
                        console.log(`✅ Step 2: Poster Image + PR Caption sent to ${number}`);
                    } else {
                        console.log(`📤 [Step 2/3] Sending PR Message Text...`);
                        await pacing.simulateTyping(client, chatId, finalPR);
                        await client.sendMessage(chatId, finalPR);
                        console.log(`✅ Step 2: PR Text sent to ${number}`);
                    }

                    await delay(pacing.humanDelay(5000, { sigma: 0.45 })); // pause between Step 2 and Step 3

                    // ── STEP 3: Send PDF Brochure Document ────────────────────────
                    if (pdfMedia) {
                        console.log(`📤 [Step 3/3] Sending PDF Brochure Document ("${pdfMedia.filename}")...`);
                        const freshPdf = pacing.freshMedia(MessageMedia, pdfArg);
                        freshPdf.filename = pdfMedia.filename;
                        await client.sendMessage(chatId, freshPdf, { sendMediaAsDocument: true });
                        console.log(`✅ Step 3: PDF Brochure Document sent to ${number}`);
                    }

                    // Log sent contact immediately to sent_log.json
                    sentLogData.push(number);
                    fs.writeFileSync(LOG_FILE, JSON.stringify(sentLogData, null, 2));
                    pacing.recordSend(state);
                    consecutiveFailures = 0;
                }
            } catch (err) {
                console.error(`❌ Failed to send to ${number}:`, err.message);
                consecutiveFailures++;
            }

            // Always clean up the temporary contact, even if a send failed above
            await removeContact(client, number, contactOptions, savedContact);

            // Bail out early rather than hammering a number WhatsApp has
            // already started refusing — repeated failures usually mean the
            // session is flagged, and continuing turns a warning into a ban.
            if (consecutiveFailures >= 3) {
                console.error(`\n🛑 ${consecutiveFailures} consecutive failures. Aborting this run to protect the account.\n`);
                break;
            }

            const isLastContact = (i === contactsToProcess.length - 1);
            if (isLastContact) continue;

            sentInBatch++;
            sentInSession++;

            if (sentInSession >= sessionTarget) {
                const sessionBreak = pacing.humanDelay(pacing.DEFAULTS.sessionBreakMedian, { sigma: 0.3 });
                console.log(`\n☕ [Session Completed] ${sentInSession} contacts done. Long break of ${(sessionBreak / 60000).toFixed(1)} minutes before the next session...\n`);
                await delay(sessionBreak);
                sentInSession = 0;
                sentInBatch = 0;
                sessionTarget = pacing.randInt(pacing.DEFAULTS.sessionMin, pacing.DEFAULTS.sessionMax);
                batchTarget = nextBatchSize();
            } else if (sentInBatch >= batchTarget) {
                const batchPause = pacing.humanDelay(BATCH_PAUSE_MEDIAN, { sigma: 0.45 });
                console.log(`\n⏸️  [Batch of ${batchTarget} Completed] Pausing ${(batchPause / 1000).toFixed(1)}s...\n`);
                await delay(batchPause);
                sentInBatch = 0;
                batchTarget = nextBatchSize();
            } else {
                const contactDelay = pacing.humanDelay(CONTACT_DELAY_MEDIAN);
                console.log(`⏳ Waiting ${(contactDelay / 1000).toFixed(1)}s before next contact...`);
                await delay(contactDelay);
            }
        }

        console.log('⏳ Waiting 8 seconds to allow WhatsApp network sync to finish...');
        await delay(8000);

        console.log('\n🎉 Bulk message delivery completed successfully!');
        await client.destroy();
        process.exit(0);

    } catch (error) {
        console.error('❌ An unexpected error occurred during execution:', error);
        if (client) await client.destroy();
        process.exit(1);
    }
});

// Start WhatsApp Client initialization
client.initialize();
