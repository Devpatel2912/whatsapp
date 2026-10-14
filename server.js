/**
 * ==============================================================================
 * WhatsApp Campaign Web Dashboard Server
 * ==============================================================================
 * Express server providing:
 * - Beautiful web dashboard (HTML / CSS / JS) on http://localhost:3000
 * - Live QR code stream for seamless phone camera scanning
 * - Automated campaign runner sending image.png + custom text caption
 * - 20-contact batches with 2 to 5 min cooldown pauses
 * - Real-time Server-Sent Events (SSE) for live progress, logs, and countdowns
 * ==============================================================================
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    delay,
} = require('@whiskeysockets/baileys');
const pino = require('pino');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Serve flyer image directly
app.get('/image.png', (req, res) => {
    const imgPath = path.join(__dirname, 'image.png');
    if (fs.existsSync(imgPath)) {
        res.sendFile(imgPath);
    } else {
        res.status(404).send('Image not found');
    }
});

// Paths
const DATA_DIR = path.join(__dirname, 'data');
const LOGS_DIR = path.join(__dirname, 'logs');
const SESSIONS_DIR = path.join(__dirname, 'sessions', 'dashboard_session');
const CONFIG_FILE = path.join(__dirname, 'config.json');
const TRACKER_FILE = path.join(DATA_DIR, 'tracker.json');
const SUCCESS_LOG_FILE = path.join(LOGS_DIR, 'success.log');
const FAILED_LOG_FILE = path.join(LOGS_DIR, 'failed.log');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// State
let sock = null;
let connectionStatus = 'initializing'; // 'disconnected', 'connecting', 'qr_ready', 'connected'
let currentQRCodeDataUrl = null;
let isManualReset = true; // Lock QR until user explicitly clicks Reset QR
let connectedUser = null;

// Campaign State
let isRunning = false;
let isPaused = false;
let isStopping = false;
let sseClients = [];

let campaignStats = {
    totalContacts: 0,
    sent: 0,
    failed: 0,
    remaining: 0,
    currentBatch: 0,
    batchInfo: 'Idle',
    actionStatus: 'Ready',
};

// Logger
const logger = pino({ level: 'silent' });

/**
 * Broadcast event to all SSE connected dashboard browsers
 */
function broadcastSSE(data) {
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    sseClients.forEach(client => {
        try {
            client.write(payload);
        } catch (e) {
            // client disconnected
        }
    });
}

function broadcastLog(message, level = 'info') {
    broadcastSSE({ type: 'log', message, level });
}

function broadcastStats() {
    broadcastSSE({
        type: 'stats',
        stats: campaignStats,
        batchInfo: campaignStats.batchInfo,
    });
}

/**
 * Helper: Append to disk log
 */
function appendLog(filePath, entry) {
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    fs.appendFileSync(filePath, `[${timestamp}] ${entry}\n`, 'utf-8');
}

/**
 * Helper: Load configuration
 */
function loadConfig() {
    if (!fs.existsSync(CONFIG_FILE)) {
        return {
            csvFilePath: 'contacts.csv',
            messageFilePath: 'content.txt',
            sendImage: true,
            imageFilePath: 'image.png',
            defaultCountryCode: '91',
            delayMinSeconds: 2,
            delayMaxSeconds: 3,
            batchSize: 20,
            batchCooldownMinMinutes: 2,
            batchCooldownMaxMinutes: 5,
        };
    }
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    cfg.batchSize = (cfg.batchSize !== undefined) ? Number(cfg.batchSize) : 20;
    cfg.batchCooldownMinMinutes = (cfg.batchCooldownMinMinutes !== undefined) ? Number(cfg.batchCooldownMinMinutes) : 2;
    cfg.batchCooldownMaxMinutes = (cfg.batchCooldownMaxMinutes !== undefined) ? Number(cfg.batchCooldownMaxMinutes) : 5;
    cfg.delayMinSeconds = (cfg.delayMinSeconds !== undefined) ? Number(cfg.delayMinSeconds) : 2;
    cfg.delayMaxSeconds = (cfg.delayMaxSeconds !== undefined) ? Number(cfg.delayMaxSeconds) : 3;
    return cfg;
}

/**
 * Helper: Load Tracker
 */
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
            // fallback
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
        let dirFiles = fs.readdirSync(queueDir)
            .filter(f => f.toLowerCase().endsWith('.csv'));

        // If split part files exist, prioritize them and exclude raw un-split files
        const partFiles = dirFiles.filter(f => f.toLowerCase().startsWith('contacts_part') || f.toLowerCase().startsWith('batch_'));
        if (partFiles.length > 0) {
            dirFiles = partFiles;
        }

        allFiles.push(...dirFiles.map(f => path.join('csv_files', f).replace(/\\/g, '/')));
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

    // Natural sort: contacts_part1.csv, contacts_part2.csv, etc.
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

/**
 * Helper: Load Contacts from CSV (supports standard, Google Contacts, and custom formats)
 */
function loadContacts(csvPath, defaultCountryCode) {
    const fullPath = path.resolve(__dirname, csvPath);
    if (!fs.existsSync(fullPath)) return [];

    try {
        const { parseCsvRows, extractContacts } = require('./split-csv');
        const content = fs.readFileSync(fullPath, 'utf-8');
        const rows = parseCsvRows(content);
        return extractContacts(rows, defaultCountryCode);
    } catch (e) {
        console.error('Error loading contacts:', e);
        return [];
    }
}

/**
 * Helper: Load announcement message
 */
function loadMessage(msgPath) {
    const fullPath = path.resolve(__dirname, msgPath);
    if (fs.existsSync(fullPath)) {
        return fs.readFileSync(fullPath, 'utf-8').trim();
    }
    return '';
}

/**
 * Initialize WhatsApp Baileys Socket for Web Dashboard
 * @param {boolean} resetRequested - if true, clears current QR code and forces fresh generation
 */
async function initWhatsApp(resetRequested = false) {
    if (resetRequested) {
        isManualReset = true;
        currentQRCodeDataUrl = null;
    }

    if (!currentQRCodeDataUrl) {
        connectionStatus = 'connecting';
    }
    broadcastSSE({ type: 'status_change' });

    try {
        if (sock) {
            try { sock.ev.removeAllListeners(); } catch (e) {}
            try { sock.end(undefined); } catch (e) {}
            sock = null;
        }

        if (!fs.existsSync(SESSIONS_DIR)) {
            fs.mkdirSync(SESSIONS_DIR, { recursive: true });
        }

        const { state, saveCreds } = await useMultiFileAuthState(SESSIONS_DIR);
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            logger,
            printQRInTerminal: false,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            browser: ["Chrome", "Windows", "10.0"],
            markOnlineOnConnect: true,
            connectTimeoutMs: 120000,
            defaultQueryTimeoutMs: 120000,
            keepAliveIntervalMs: 25000,
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                // Only update QR if no QR currently displayed OR if user explicitly requested a reset
                if (!currentQRCodeDataUrl || isManualReset) {
                    try {
                        currentQRCodeDataUrl = await QRCode.toDataURL(qr, { margin: 1, scale: 7 });
                        connectionStatus = 'qr_ready';
                        isManualReset = false;
                        broadcastSSE({ type: 'status_change' });
                        broadcastLog('QR code ready! (Locked for sharing — will not change until you click "Reset QR")', 'system');
                    } catch (e) {
                        console.error('QR code generation error:', e);
                    }
                }
            }

            if (connection === 'close') {
                const statusCode = (lastDisconnect?.error)?.output?.statusCode;
                const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;

                if (connectionStatus === 'connected') {
                    connectionStatus = 'disconnected';
                    connectedUser = null;
                    currentQRCodeDataUrl = null;
                    isManualReset = true;
                    broadcastSSE({ type: 'status_change' });
                    broadcastLog(`Connection closed (code: ${statusCode}). Reconnect: ${!isLoggedOut}`, 'warn');
                }

                if (isLoggedOut) {
                    broadcastLog('Session logged out or expired. Click "Reset QR" to scan again.', 'warn');
                    try {
                        if (fs.existsSync(SESSIONS_DIR)) {
                            fs.rmSync(SESSIONS_DIR, { recursive: true, force: true });
                        }
                    } catch (e) {}
                } else if (currentQRCodeDataUrl) {
                    // QR is already generated and displayed for the user to share!
                    // DO NOT wipe the QR image. Silently maintain socket connection in background.
                    setTimeout(() => {
                        if (connectionStatus !== 'connected' && currentQRCodeDataUrl) {
                            initWhatsApp(false);
                        }
                    }, 5000);
                } else {
                    setTimeout(() => initWhatsApp(false), 3000);
                }
            } else if (connection === 'open') {
                connectionStatus = 'connected';
                currentQRCodeDataUrl = null;
                isManualReset = false;
                connectedUser = sock?.user?.id ? sock.user.id.split(':')[0] : 'Linked Device';
                broadcastSSE({ type: 'status_change' });
                broadcastLog(`WhatsApp connected! Linked user: +${connectedUser}`, 'success');
            }
        });

    } catch (err) {
        console.error('Failed to initialize WhatsApp socket:', err);
        if (!currentQRCodeDataUrl) {
            connectionStatus = 'disconnected';
            broadcastSSE({ type: 'status_change' });
            broadcastLog(`WhatsApp error: ${err.message}. Retrying in 5s...`, 'error');
        }
        setTimeout(() => initWhatsApp(false), 5000);
    }
}

/**
 * Run Automated Campaign in Batches
 */
async function startCampaignExecution() {
    if (isRunning) return;
    isRunning = true;
    isPaused = false;
    const config = loadConfig();
    const rawMessage = loadMessage(config.messageFilePath || 'content.txt');
    const tracker = loadTracker();
    const queue = getCsvQueue(tracker);

    if (queue.isQueueFinished || !queue.activeFile) {
        broadcastLog('⚠️ All CSV files in the queue have already been processed!', 'warn');
        broadcastLog('To restart from the beginning, click "Reset Queue".', 'info');
        campaignStats.actionStatus = 'Queue Finished';
        campaignStats.batchInfo = 'All CSV Files Done';
        broadcastStats();
        isRunning = false;
        return;
    }

    const currentFile = queue.activeFile;
    const fileIndex = queue.completedFiles.length + 1;
    const totalFiles = queue.allFiles.length;

    broadcastLog(`====================================================`, 'system');
    broadcastLog(`[ACTIVE CSV] Processing: "${currentFile}" (File ${fileIndex} of ${totalFiles})`, 'system');
    broadcastLog(`====================================================`, 'system');

    const contacts = loadContacts(currentFile, config.defaultCountryCode);
    const pending = contacts.filter(c => !tracker.sent.has(c.phone));

    campaignStats.totalContacts = contacts.length;
    campaignStats.sent = tracker.sent.size;
    campaignStats.failed = tracker.failed.size;
    campaignStats.remaining = pending.length;
    campaignStats.actionStatus = `File ${fileIndex}/${totalFiles}: ${path.basename(currentFile)}`;
    campaignStats.batchInfo = `Processing ${pending.length} contacts`;

    broadcastStats();
    broadcastLog(`Loaded ${contacts.length} contacts from "${currentFile}" (${pending.length} pending)...`, 'info');

    // Prepare image flyer attachment
    let imageBuffer = null;
    const imgFullPath = path.resolve(__dirname, config.imageFilePath || 'image.png');
    if (config.sendImage && fs.existsSync(imgFullPath)) {
        imageBuffer = fs.readFileSync(imgFullPath);
        broadcastLog(`Flyer attached: ${config.imageFilePath} (${(imageBuffer.length / 1024 / 1024).toFixed(2)} MB)`, 'info');
    }

    let batchCount = 0;
    const batchLimit = config.batchSize || 20;

    for (let i = 0; i < pending.length; i++) {
        if (isStopping) {
            broadcastLog('Campaign stopped by user.', 'warn');
            break;
        }

        // Handle pause
        while (isPaused && !isStopping) {
            campaignStats.actionStatus = 'Paused';
            broadcastStats();
            await new Promise(r => setTimeout(r, 1000));
        }

        if (isStopping) break;

        const contact = pending[i];
        const jid = `${contact.phone}@s.whatsapp.net`;
        const personalizedMsg = rawMessage.replace(/\{\{name\}\}/gi, contact.name || 'Friend');

        campaignStats.actionStatus = `Sending to +${contact.phone}...`;
        campaignStats.batchInfo = `Batch: ${batchCount + 1}/${batchLimit} (${i + 1}/${pending.length})`;
        broadcastStats();

        try {
            // Check if number exists on WhatsApp
            const [onWa] = await sock.onWhatsApp(jid);
            if (!onWa || !onWa.exists) {
                tracker.failed.add(contact.phone);
                campaignStats.failed++;
                appendLog(FAILED_LOG_FILE, `FAILED | Phone: +${contact.phone} | Reason: Not on WhatsApp`);
                broadcastLog(`[Failed] +${contact.phone} is not on WhatsApp`, 'error');
            } else {
                // Send image with caption if available
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
                campaignStats.sent++;
                batchCount++;
                appendLog(SUCCESS_LOG_FILE, `SENT | Phone: +${contact.phone} | Name: ${contact.name || 'N/A'}`);
                broadcastLog(`[Delivered] +${contact.phone} (${contact.name || 'Friend'})`, 'success');
            }

        } catch (err) {
            tracker.failed.add(contact.phone);
            campaignStats.failed++;
            appendLog(FAILED_LOG_FILE, `ERROR | Phone: +${contact.phone} | Error: ${err.message}`);
            broadcastLog(`[Error] +${contact.phone}: ${err.message}`, 'error');
        }

        saveTracker(tracker);
        campaignStats.remaining = pending.length - (i + 1);
        broadcastStats();

        // Check if batch finished (e.g. 20 contacts)
        if (batchCount >= batchLimit && i < pending.length - 1 && !isStopping) {
            batchCount = 0;
            const cooldownMins = Math.floor(
                Math.random() * (config.batchCooldownMaxMinutes - config.batchCooldownMinMinutes + 1) + config.batchCooldownMinMinutes
            );
            const totalSeconds = cooldownMins * 60;

            broadcastLog(`====================================================`, 'warn');
            broadcastLog(`[BATCH FINISHED] Sent ${batchLimit} messages! Cooling down for ${cooldownMins} minutes...`, 'warn');
            broadcastLog(`====================================================`, 'warn');

            for (let rem = totalSeconds; rem > 0; rem--) {
                if (isStopping) break;
                while (isPaused && !isStopping) {
                    await new Promise(r => setTimeout(r, 1000));
                }
                const m = Math.floor(rem / 60);
                const s = rem % 60;
                campaignStats.actionStatus = `Cooldown Rest: ${m}m ${s < 10 ? '0' : ''}${s}s`;
                broadcastStats();
                await new Promise(r => setTimeout(r, 1000));
            }
        } else if (i < pending.length - 1 && !isStopping) {
            // Natural pacing delay between contacts
            const randomSec = Math.floor(
                Math.random() * (config.delayMaxSeconds - config.delayMinSeconds + 1) + config.delayMinSeconds
            );
            for (let rem = randomSec; rem > 0; rem--) {
                if (isStopping) break;
                while (isPaused && !isStopping) {
                    await new Promise(r => setTimeout(r, 1000));
                }
                campaignStats.actionStatus = `Next contact in ${rem}s...`;
                broadcastStats();
                await new Promise(r => setTimeout(r, 1000));
            }
        }
    }

    isRunning = false;
    isPaused = false;

    if (!isStopping) {
        tracker.completedCsvFiles.add(currentFile);
        saveTracker(tracker);

        const nextQueue = getCsvQueue(tracker);
        if (nextQueue.activeFile) {
            broadcastLog(`====================================================`, 'success');
            broadcastLog(`✅ [FILE COMPLETED] Finished processing "${currentFile}"!`, 'success');
            broadcastLog(`⏭️ [NEXT FILE READY] "${nextQueue.activeFile}" (${nextQueue.completedFiles.length + 1} of ${nextQueue.allFiles.length})`, 'info');
            broadcastLog(`Process stopped for this file. Start again whenever you want to process the next file!`, 'info');
            broadcastLog(`====================================================`, 'success');
            campaignStats.actionStatus = `Done: ${path.basename(currentFile)}`;
            campaignStats.batchInfo = `Next: ${path.basename(nextQueue.activeFile)}`;
        } else {
            broadcastLog(`====================================================`, 'success');
            broadcastLog(`🎉 [ALL FILES COMPLETED] All ${totalFiles} CSV files in queue are finished!`, 'success');
            broadcastLog(`====================================================`, 'success');
            campaignStats.actionStatus = 'All Files Completed';
            campaignStats.batchInfo = 'All Done';
        }
    } else {
        campaignStats.actionStatus = 'Stopped by User';
    }

    broadcastStats();
}

// =============================================
// API Routes
// =============================================

// GET /api/status - WhatsApp connection state & QR
app.get('/api/status', (req, res) => {
    res.json({
        status: connectionStatus,
        user: connectedUser,
        qrCodeDataUrl: currentQRCodeDataUrl,
        campaign: {
            isRunning,
            isPaused,
            stats: campaignStats,
        }
    });
});

// GET /api/campaign - Campaign metadata
app.get('/api/campaign', (req, res) => {
    const config = loadConfig();
    const msg = loadMessage(config.messageFilePath || 'content.txt');
    const tracker = loadTracker();
    const queue = getCsvQueue(tracker);

    const activeTargetFile = queue.activeFile || 'None (Queue Complete)';
    const contacts = queue.activeFile ? loadContacts(queue.activeFile, config.defaultCountryCode) : [];

    campaignStats.totalContacts = contacts.length;
    campaignStats.sent = tracker.sent.size;
    campaignStats.failed = tracker.failed.size;
    campaignStats.remaining = queue.activeFile ? contacts.filter(c => !tracker.sent.has(c.phone)).length : 0;

    res.json({
        success: true,
        message: msg,
        queue: {
            activeFile: queue.activeFile,
            completedFiles: queue.completedFiles,
            pendingFiles: queue.pendingFiles,
            totalFiles: queue.allFiles.length,
            isFinished: queue.isQueueFinished,
        },
        totalContacts: contacts.length,
        config,
        stats: campaignStats,
    });
});

// POST /api/reset-queue - Reset completed CSV files to start from first file
app.post('/api/reset-queue', (req, res) => {
    const tracker = loadTracker();
    tracker.completedCsvFiles = new Set();
    saveTracker(tracker);
    broadcastLog('🔄 CSV file queue has been reset to File 1!', 'system');
    res.json({ success: true, message: 'Queue reset to first file.' });
});

// POST /api/split-csv - Split contacts.csv into 100-contact files
app.post('/api/split-csv', (req, res) => {
    try {
        const { splitCsv } = require('./split-csv');
        const createdFiles = splitCsv();
        broadcastLog(`✂️ Split contacts into ${createdFiles.length} files of up to 100 contacts each!`, 'system');
        res.json({ success: true, files: createdFiles });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/start - Start sending
app.post('/api/start', (req, res) => {
    if (connectionStatus !== 'connected') {
        return res.status(400).json({ success: false, message: 'WhatsApp not connected. Please scan QR first.' });
    }
    if (isRunning) {
        return res.json({ success: true, message: 'Already running.' });
    }
    startCampaignExecution().catch(e => console.error('Campaign error:', e));
    res.json({ success: true, message: 'Campaign started' });
});

// POST /api/pause - Pause
app.post('/api/pause', (req, res) => {
    isPaused = true;
    res.json({ success: true, message: 'Paused' });
});

// POST /api/resume - Resume
app.post('/api/resume', (req, res) => {
    isPaused = false;
    res.json({ success: true, message: 'Resumed' });
});

// POST /api/stop - Stop
app.post('/api/stop', (req, res) => {
    isStopping = true;
    res.json({ success: true, message: 'Stopping' });
});

// POST /api/relink - Wipe session and re-scan
app.post('/api/relink', async (req, res) => {
    try {
        if (sock) {
            try { sock.ev.removeAllListeners(); } catch (e) {}
            try { await sock.logout(); } catch (e) { }
            try { sock.end(undefined); } catch (e) {}
            sock = null;
        }
        try {
            if (fs.existsSync(SESSIONS_DIR)) {
                fs.rmSync(SESSIONS_DIR, { recursive: true, force: true });
            }
        } catch (e) { }
        broadcastLog('Session reset requested. Generating fresh QR code...', 'system');
        initWhatsApp(true);
        res.json({ success: true, message: 'Session reset. New QR code generating.' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /api/events - Server-Sent Events (SSE)
app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    sseClients.push(res);

    req.on('close', () => {
        sseClients = sseClients.filter(c => c !== res);
    });
});

// Start Express and WhatsApp Engine
app.listen(PORT, () => {
    console.log('============================================================');
    console.log(`  WHATSAPP DASHBOARD SERVER RUNNING AT:`);
    console.log(`  👉 http://localhost:${PORT}`);
    console.log('============================================================');
    initWhatsApp();
});
