/**
 * ==============================================================================
 * WhatsApp Bulk Message Automation (Using Baileys Socket Engine)
 * ==============================================================================
 * Alternative to browser automation: Uses @whiskeysockets/baileys directly
 * for lightweight and fast execution without opening Chrome.
 * ==============================================================================
 */

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    delay,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const qrcode = require('qrcode-terminal');

// File paths
const CONFIG_FILE = path.join(__dirname, 'config.json');
const DATA_DIR = path.join(__dirname, 'data');
const LOGS_DIR = path.join(__dirname, 'logs');
const TRACKER_FILE = path.join(DATA_DIR, 'tracker.json');
const SUCCESS_LOG_FILE = path.join(LOGS_DIR, 'success.log');
const FAILED_LOG_FILE = path.join(LOGS_DIR, 'failed.log');
const SESSIONS_DIR = path.join(__dirname, 'sessions', 'cli_session');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

let isPaused = false;
let isStopping = false;

function loadConfig() {
    if (!fs.existsSync(CONFIG_FILE)) {
        throw new Error(`Configuration file not found at ${CONFIG_FILE}`);
    }
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    config.csvFilePath = config.csvFilePath || 'contacts.csv';
    config.messageFilePath = config.messageFilePath || 'content.txt';
    config.defaultCountryCode = config.defaultCountryCode || '91';
    config.delayMinSeconds = config.delayMinSeconds || 2;
    config.delayMaxSeconds = config.delayMaxSeconds || 3;
    config.sendImage = config.sendImage !== false;
    config.imageFilePath = config.imageFilePath || 'image.png';
    config.batchSize = config.batchSize || 20;
    config.batchCooldownMinMinutes = config.batchCooldownMinMinutes || 2;
    config.batchCooldownMaxMinutes = config.batchCooldownMaxMinutes || 5;
    config.requireExplicitConfirmation = config.requireExplicitConfirmation !== false;
    return config;
}

function loadMessage(config) {
    const msgPath = path.resolve(__dirname, config.messageFilePath);
    if (fs.existsSync(msgPath)) {
        return fs.readFileSync(msgPath, 'utf-8').trim();
    }
    if (config.messageTemplate) {
        return config.messageTemplate.trim();
    }
    throw new Error(`Message file not found at ${msgPath}`);
}

function loadTracker() {
    if (fs.existsSync(TRACKER_FILE)) {
        try {
            const data = JSON.parse(fs.readFileSync(TRACKER_FILE, 'utf-8'));
            return {
                sent: new Set(data.sent || []),
                failed: new Set(data.failed || []),
                completedCsvFiles: new Set(data.completedCsvFiles || []),
            };
        } catch (e) {
            console.warn(`[WARN] Could not parse tracker.json: ${e.message}`);
        }
    }
    return { sent: new Set(), failed: new Set(), completedCsvFiles: new Set() };
}

function saveTracker(tracker) {
    const payload = {
        lastRun: new Date().toISOString(),
        completedCsvFiles: Array.from(tracker.completedCsvFiles || []),
        totalSent: tracker.sent.size,
        totalFailed: tracker.failed.size,
        sent: Array.from(tracker.sent),
        failed: Array.from(tracker.failed),
    };
    fs.writeFileSync(TRACKER_FILE, JSON.stringify(payload, null, 2), 'utf-8');
}

/**
 * Discover all available CSV files and find the next pending file
 */
function getCsvQueue(tracker) {
    const queueDir = path.join(__dirname, 'csv_files');
    let allFiles = [];

    // 1. Files inside csv_files directory
    if (fs.existsSync(queueDir)) {
        const dirFiles = fs.readdirSync(queueDir)
            .filter(f => f.toLowerCase().endsWith('.csv'))
            .map(f => path.join('csv_files', f).replace(/\\/g, '/'));
        allFiles.push(...dirFiles);
    }

    // 2. Any additional contacts_*.csv or batch_*.csv in root
    const rootFiles = fs.readdirSync(__dirname)
        .filter(f => f.toLowerCase().endsWith('.csv') && f.toLowerCase() !== 'contacts.csv')
        .map(f => f);
    allFiles.push(...rootFiles);

    // 3. Fallback to contacts.csv if no other files exist
    if (allFiles.length === 0 && fs.existsSync(path.join(__dirname, 'contacts.csv'))) {
        allFiles.push('contacts.csv');
    }

    allFiles.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    allFiles = Array.from(new Set(allFiles));

    const completed = tracker ? tracker.completedCsvFiles : new Set();
    const pending = allFiles.filter(f => !completed.has(f));
    const activeFile = pending.length > 0 ? pending[0] : null;

    return {
        allFiles,
        completedFiles: Array.from(completed || []),
        pendingFiles: pending,
        activeFile,
        isQueueFinished: (allFiles.length > 0 && pending.length === 0)
    };
}

function appendLog(filePath, entry) {
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    fs.appendFileSync(filePath, `[${timestamp}] ${entry}\n`, 'utf-8');
}

function loadContacts(csvPath, defaultCountryCode) {
    const fullPath = path.resolve(__dirname, csvPath);
    if (!fs.existsSync(fullPath)) throw new Error(`CSV not found: ${fullPath}`);

    const lines = fs.readFileSync(fullPath, 'utf-8').split(/\r?\n/).filter(l => l.trim().length > 0);
    if (lines.length === 0) throw new Error('CSV is empty');

    const contacts = [];
    let phoneColIndex = -1;
    let nameColIndex = -1;

    const firstCols = lines[0].split(',').map(c => c.trim().toLowerCase().replace(/['"]/g, ''));
    if (firstCols.some(c => c.includes('phone') || c.includes('number') || c.includes('mobile') || c.includes('contact'))) {
        phoneColIndex = firstCols.findIndex(c => c.includes('phone') || c.includes('number') || c.includes('mobile') || c.includes('contact'));
        nameColIndex = firstCols.findIndex(c => c.includes('name'));
        lines.shift();
    } else {
        phoneColIndex = 0;
        nameColIndex = firstCols.length > 1 ? 1 : -1;
    }

    for (const rawLine of lines) {
        const cols = rawLine.split(',').map(c => c.trim().replace(/^["']|["']$/g, ''));
        const rawPhone = cols[phoneColIndex] || '';
        const rawName = nameColIndex >= 0 ? (cols[nameColIndex] || '') : '';
        const digits = rawPhone.replace(/\D/g, '');

        if (!digits || digits.length < 7) {
            contacts.push({ raw: rawPhone, phone: null, name: rawName, valid: false, error: 'Too short' });
            continue;
        }

        let formatted = digits;
        if (digits.length === 10 && defaultCountryCode) {
            formatted = defaultCountryCode + digits;
        }

        contacts.push({ raw: rawPhone, phone: formatted, name: rawName, valid: true });
    }
    return contacts;
}

function promptUser(query) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(query, ans => {
        rl.close();
        resolve(ans.trim());
    }));
}

async function waitWithCountdown(seconds) {
    for (let remaining = seconds; remaining > 0; remaining--) {
        if (isStopping) break;
        while (isPaused && !isStopping) {
            process.stdout.write(`\r[PAUSED] Process is paused. Press 'r' + Enter to resume...     `);
            await new Promise(r => setTimeout(r, 1000));
        }
        process.stdout.write(`\r[WAITING] Next message in ${remaining}s... (Type 'p' to pause, 'q' to quit) `);
        await new Promise(r => setTimeout(r, 1000));
    }
    process.stdout.write('\r' + ' '.repeat(75) + '\r');
}

function setupKeyboardControls() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on('line', (line) => {
        const cmd = line.trim().toLowerCase();
        if (cmd === 'p') {
            if (!isPaused) {
                isPaused = true;
                console.log('\n>>> [PAUSED] Execution paused. Type "r" + Enter to resume. <<<');
            }
        } else if (cmd === 'r') {
            if (isPaused) {
                isPaused = false;
                console.log('\n>>> [RESUMED] Resuming sending queue. <<<');
            }
        } else if (cmd === 'q') {
            console.log('\n>>> [STOPPING] Gracefully finishing and stopping. <<<');
            isStopping = true;
        }
    });
}

/**
 * Connect to WhatsApp using Baileys
 */
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(SESSIONS_DIR);
    const { version } = await fetchLatestBaileysVersion();
    const logger = pino({ level: 'silent' });

    return new Promise(async (resolve, reject) => {
        const sock = makeWASocket({
            version,
            logger,
            printQRInTerminal: false,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            browser: ["Chrome", "Windows", "10.0"],
            markOnlineOnConnect: true,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('\n============================================================');
                console.log('  SCAN QR CODE (WhatsApp > Linked Devices > Link a Device)');
                console.log('============================================================');
                qrcode.generate(qr, { small: true });
                console.log('============================================================\n');
            }

            if (connection === 'close') {
                const statusCode = (lastDisconnect?.error)?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log(`[DISCONNECT] Connection closed (Status: ${statusCode}). Reconnect: ${shouldReconnect}`);
                if (shouldReconnect) {
                    console.log('Reconnecting...');
                    connectToWhatsApp().then(resolve).catch(reject);
                } else {
                    try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); } catch (e) {}
                    reject(new Error('Session logged out. Cleaned sessions/cli_session. Run again to scan new QR code.'));
                }
            } else if (connection === 'open') {
                console.log('\n[CONNECTED] Successfully connected to WhatsApp via Baileys!\n');
                resolve(sock);
            }
        });
    });
}

async function main() {
    console.log('============================================================');
    console.log('  WHATSAPP BULK SENDER (BAILEYS SOCKET ENGINE)');
    console.log('============================================================');

    const config = loadConfig();
    const rawMessage = loadMessage(config);
    const tracker = loadTracker();
    const queue = getCsvQueue(tracker);

    if (queue.isQueueFinished || !queue.activeFile) {
        console.log('\n[INFO] All CSV files in the queue have already been processed!');
        console.log('To restart, delete data/tracker.json or clear completedCsvFiles.');
        process.exit(0);
    }

    const currentFile = queue.activeFile;
    const fileIndex = queue.completedFiles.length + 1;
    const totalFiles = queue.allFiles.length;

    console.log(`- Active CSV File:       ${currentFile} (File ${fileIndex} of ${totalFiles})`);

    const contacts = loadContacts(currentFile, config.defaultCountryCode);

    const validContacts = contacts.filter(c => c.valid);
    const invalidContacts = contacts.filter(c => !c.valid);
    const pendingContacts = validContacts.filter(c => !tracker.sent.has(c.phone));
    const alreadySentCount = validContacts.length - pendingContacts.length;

    for (const inv of invalidContacts) {
        if (!tracker.failed.has(inv.raw)) {
            tracker.failed.add(inv.raw);
            appendLog(FAILED_LOG_FILE, `SKIPPED | Raw: ${inv.raw} | Reason: ${inv.error}`);
        }
    }
    saveTracker(tracker);

    const avgDelay = (config.delayMinSeconds + config.delayMaxSeconds) / 2;
    const estMinutes = Math.round((pendingContacts.length * (avgDelay + 2)) / 60);

    console.log('\n[SUMMARY]');
    console.log(`- Current File:          ${currentFile} [${fileIndex}/${totalFiles}]`);
    console.log(`- Contacts in this File: ${contacts.length}`);
    console.log(`- Valid Contacts:        ${validContacts.length}`);
    console.log(`- Invalid Numbers:       ${invalidContacts.length} (skipped)`);
    console.log(`- Already Sent:          ${alreadySentCount}`);
    console.log(`- Remaining in File:     ${pendingContacts.length}`);
    console.log(`- Delay Range:           ${config.delayMinSeconds}s - ${config.delayMaxSeconds}s`);
    console.log(`- Estimated Time:        ~${estMinutes} minutes`);
    console.log('\n[MESSAGE PREVIEW]');
    console.log('------------------------------------------------------------');
    console.log(rawMessage.length > 250 ? rawMessage.substring(0, 250) + '...\n[truncated]' : rawMessage);
    console.log('------------------------------------------------------------');

    // Prepare image attachment if configured
    let imageBuffer = null;
    const imageFullPath = path.resolve(__dirname, config.imageFilePath);
    if (config.sendImage && fs.existsSync(imageFullPath)) {
        imageBuffer = fs.readFileSync(imageFullPath);
        console.log(`- Attachment:            ${config.imageFilePath} (${(imageBuffer.length / 1024 / 1024).toFixed(2)} MB) with caption`);
    } else if (config.sendImage) {
        console.log(`- Attachment:            [WARN] File not found at ${imageFullPath}. Sending text only.`);
    } else {
        console.log(`- Attachment:            None (Text only)`);
    }

    // Explicit confirmation
    if (config.requireExplicitConfirmation) {
        console.log('\n============================================================');
        console.log('  AUTHORIZATION REQUIRED');
        console.log('============================================================');
        const auth = await promptUser('To authorize and start sending, type "START" and press Enter: ');
        if (auth !== 'START') {
            console.log('\n[CANCELLED] Sending aborted by user.');
            process.exit(0);
        }
    }

    if (pendingContacts.length === 0) {
        console.log('\n[DONE] All contacts have already received the message.');
        process.exit(0);
    }

    console.log('\nInitializing WhatsApp connection...');
    const sock = await connectToWhatsApp();
    setupKeyboardControls();

    console.log('============================================================');
    console.log('  SENDING MESSAGES');
    console.log('  Controls: Type "p" to Pause, "r" to Resume, "q" to Stop');
    console.log('============================================================\n');

    let sentCount = 0;
    let failedCount = 0;
    let batchCounter = 0;

    for (let i = 0; i < pendingContacts.length; i++) {
        if (isStopping) break;

        while (isPaused && !isStopping) {
            process.stdout.write(`\r[PAUSED] Press 'r' + Enter to resume...     `);
            await new Promise(r => setTimeout(r, 1000));
        }

        if (isStopping) break;

        const contact = pendingContacts[i];
        const jid = `${contact.phone}@s.whatsapp.net`;
        const personalizedMsg = rawMessage.replace(/\{\{name\}\}/gi, contact.name || 'Friend');

        console.log(`\n[Contact ${alreadySentCount + i + 1}/${validContacts.length}] [Batch: ${batchCounter + 1}/${config.batchSize}] Sending to +${contact.phone} (${contact.name || 'No Name'})...`);

        try {
            // Check if user is on WhatsApp
            const [onWa] = await sock.onWhatsApp(jid);
            if (!onWa || !onWa.exists) {
                console.log(`[FAILED] Number +${contact.phone} is not registered on WhatsApp.`);
                tracker.failed.add(contact.phone);
                failedCount++;
                appendLog(FAILED_LOG_FILE, `FAILED | Phone: +${contact.phone} | Reason: Not registered on WhatsApp`);
                saveTracker(tracker);
                continue;
            }

            // Send image with caption if available, otherwise text only
            if (imageBuffer) {
                await sock.sendMessage(jid, {
                    image: imageBuffer,
                    caption: personalizedMsg,
                    mimetype: 'image/png'
                });
            } else {
                await sock.sendMessage(jid, { text: personalizedMsg });
            }

            tracker.sent.add(contact.phone);
            sentCount++;
            batchCounter++;
            appendLog(SUCCESS_LOG_FILE, `SENT | Phone: +${contact.phone} | Name: ${contact.name || 'N/A'}`);
            console.log(`[SUCCESS] Message with image delivered to +${contact.phone}`);

        } catch (err) {
            tracker.failed.add(contact.phone);
            failedCount++;
            appendLog(FAILED_LOG_FILE, `ERROR | Phone: +${contact.phone} | Error: ${err.message}`);
            console.log(`[ERROR] Failed to send to +${contact.phone}: ${err.message}`);
        }

        saveTracker(tracker);
        console.log(`Progress: Sent: ${sentCount} | Failed: ${failedCount} | Remaining: ${pendingContacts.length - (i + 1)}`);

        // Check if batch limit (e.g. 20) reached
        if (config.batchSize && batchCounter >= config.batchSize && i < pendingContacts.length - 1 && !isStopping) {
            batchCounter = 0;
            const cooldownMinutes = Math.floor(
                Math.random() * (config.batchCooldownMaxMinutes - config.batchCooldownMinMinutes + 1) + config.batchCooldownMinMinutes
            );
            const cooldownSeconds = cooldownMinutes * 60;
            console.log('\n============================================================');
            console.log(`  [BATCH COMPLETE] Sent batch of ${config.batchSize} contacts!`);
            console.log(`  Taking a rest break of ${cooldownMinutes} minutes (${cooldownSeconds}s) before next batch...`);
            console.log('============================================================');
            await waitWithCountdown(cooldownSeconds);
        } else if (i < pendingContacts.length - 1 && !isStopping) {
            const randomDelay = Math.floor(
                Math.random() * (config.delayMaxSeconds - config.delayMinSeconds + 1) + config.delayMinSeconds
            );
            await waitWithCountdown(randomDelay);
        }
    }

    if (!isStopping) {
        tracker.completedCsvFiles.add(currentFile);
        saveTracker(tracker);

        const nextQueue = getCsvQueue(tracker);
        if (nextQueue.activeFile) {
            console.log('\n============================================================');
            console.log(`  [FILE COMPLETED] Finished processing "${currentFile}"!`);
            console.log(`  [NEXT QUEUED] Next file ready: "${nextQueue.activeFile}" (${nextQueue.completedFiles.length + 1} of ${nextQueue.allFiles.length}).`);
            console.log(`  Process stopped. Run again whenever you are ready for the next file!`);
            console.log('============================================================\n');
        } else {
            console.log('\n============================================================');
            console.log(`  [ALL COMPLETED] All ${totalFiles} CSV files in queue finished!`);
            console.log('============================================================\n');
        }
    }

    console.log('============================================================');
    console.log('  RUN SUMMARY');
    console.log(`- Sent in this run:       ${sentCount}`);
    console.log(`- Failed in this run:     ${failedCount}`);
    console.log(`- Total sent in tracker:  ${tracker.sent.size}`);
    console.log(`- Logs saved to:          logs/`);
    console.log('============================================================\n');

    process.exit(0);
}

process.on('SIGINT', () => {
    console.log('\n[SIGINT] Exiting cleanly...');
    isStopping = true;
});

main().catch(err => {
    console.error('Execution error:', err);
    process.exit(1);
});
