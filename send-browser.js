/**
 * ==============================================================================
 * WhatsApp Web Bulk Message Automation
 * ==============================================================================
 * Requirements Satisfied:
 * - Browser automation via Puppeteer (opens WhatsApp Web for manual QR scan)
 * - Persistent browser profile to avoid repeated QR scans
 * - Reads contacts from CSV with country code handling
 * - Custom message loaded from content.txt / config.json with {{name}} placeholders
 * - Sequential sending with randomized natural delays
 * - Idempotency & duplicate prevention via data/tracker.json
 * - Interactive pause ('p'), resume ('r'), and quit ('q') controls
 * - Success and failure logs written to separate files in logs/
 * - Explicit user authorization required before sending any messages
 * ==============================================================================
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const puppeteer = require('puppeteer');

// Paths
const CONFIG_FILE = path.join(__dirname, 'config.json');
const DATA_DIR = path.join(__dirname, 'data');
const LOGS_DIR = path.join(__dirname, 'logs');
const TRACKER_FILE = path.join(DATA_DIR, 'tracker.json');
const SUCCESS_LOG_FILE = path.join(LOGS_DIR, 'success.log');
const FAILED_LOG_FILE = path.join(LOGS_DIR, 'failed.log');

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

// Global runtime control flags
let isPaused = false;
let isStopping = false;

/**
 * Load and validate configuration
 */
function loadConfig() {
    if (!fs.existsSync(CONFIG_FILE)) {
        throw new Error(`Configuration file not found at ${CONFIG_FILE}`);
    }
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    const config = JSON.parse(raw);

    // Set defaults if not present
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
    config.sessionDirectory = config.sessionDirectory || './whatsapp_browser_session';
    config.headless = config.headless !== undefined ? config.headless : false;
    config.pageTimeoutSeconds = config.pageTimeoutSeconds || 60;
    config.requireExplicitConfirmation = config.requireExplicitConfirmation !== false;

    return config;
}

/**
 * Load custom message from file or config
 */
function loadMessage(config) {
    const msgPath = path.resolve(__dirname, config.messageFilePath);
    if (fs.existsSync(msgPath)) {
        return fs.readFileSync(msgPath, 'utf-8').trim();
    }
    if (config.messageTemplate) {
        return config.messageTemplate.trim();
    }
    throw new Error(`Message file not found at ${msgPath} and no messageTemplate found in config.json.`);
}

/**
 * Load or initialize tracker to prevent duplicate sends and support resuming
 */
function loadTracker() {
    if (fs.existsSync(TRACKER_FILE)) {
        try {
            const data = JSON.parse(fs.readFileSync(TRACKER_FILE, 'utf-8'));
            return {
                sent: new Set(data.sent || []),
                failed: new Set(data.failed || []),
                lastRun: data.lastRun || null,
            };
        } catch (e) {
            console.warn(`[WARN] Could not parse tracker.json, starting fresh: ${e.message}`);
        }
    }
    return {
        sent: new Set(),
        failed: new Set(),
        lastRun: null,
    };
}

/**
 * Save tracker state to disk
 */
function saveTracker(tracker) {
    const payload = {
        lastRun: new Date().toISOString(),
        totalSent: tracker.sent.size,
        totalFailed: tracker.failed.size,
        sent: Array.from(tracker.sent),
        failed: Array.from(tracker.failed),
    };
    fs.writeFileSync(TRACKER_FILE, JSON.stringify(payload, null, 2), 'utf-8');
}

/**
 * Append entry to log file
 */
function appendLog(filePath, entry) {
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    fs.appendFileSync(filePath, `[${timestamp}] ${entry}\n`, 'utf-8');
}

/**
 * Read and normalize contacts from CSV file
 */
function loadContacts(csvPath, defaultCountryCode) {
    const fullPath = path.resolve(__dirname, csvPath);
    if (!fs.existsSync(fullPath)) {
        throw new Error(`Contacts CSV file not found at ${fullPath}`);
    }

    const content = fs.readFileSync(fullPath, 'utf-8');
    const lines = content.split(/\r?\n/).filter(line => line.trim().length > 0);

    if (lines.length === 0) {
        throw new Error(`CSV file ${fullPath} is empty.`);
    }

    const contacts = [];
    let headerLine = lines[0];
    let phoneColIndex = -1;
    let nameColIndex = -1;

    // Check if first line is a header
    const firstCols = headerLine.split(',').map(c => c.trim().toLowerCase().replace(/['"]/g, ''));
    if (firstCols.some(c => c.includes('phone') || c.includes('number') || c.includes('mobile') || c.includes('contact'))) {
        phoneColIndex = firstCols.findIndex(c => c.includes('phone') || c.includes('number') || c.includes('mobile') || c.includes('contact'));
        nameColIndex = firstCols.findIndex(c => c.includes('name'));
        lines.shift(); // Remove header line
    } else {
        // Assume column 0 is phone, column 1 is name (if exists)
        phoneColIndex = 0;
        nameColIndex = firstCols.length > 1 ? 1 : -1;
    }

    for (let i = 0; i < lines.length; i++) {
        const rawLine = lines[i];
        const cols = rawLine.split(',').map(c => c.trim().replace(/^["']|["']$/g, ''));
        const rawPhone = cols[phoneColIndex] || '';
        const rawName = nameColIndex >= 0 ? (cols[nameColIndex] || '') : '';

        // Clean phone number: remove non-digits
        const digits = rawPhone.replace(/\D/g, '');

        if (!digits || digits.length < 7) {
            contacts.push({
                raw: rawPhone,
                phone: null,
                name: rawName,
                valid: false,
                error: 'Too short or no digits found',
            });
            continue;
        }

        let formattedPhone = digits;
        // If 10 digits and defaultCountryCode is provided, prepend it
        if (digits.length === 10 && defaultCountryCode) {
            formattedPhone = defaultCountryCode + digits;
        }

        contacts.push({
            raw: rawPhone,
            phone: formattedPhone,
            name: rawName,
            valid: true,
        });
    }

    return contacts;
}

/**
 * Helper to prompt user via console
 */
function promptUser(query) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    return new Promise(resolve => rl.question(query, ans => {
        rl.close();
        resolve(ans.trim());
    }));
}

/**
 * Sleep helper with cancellation / pause support
 */
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

/**
 * Setup keyboard listener for Pause / Resume / Quit
 */
function setupKeyboardControls() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    rl.on('line', (line) => {
        const cmd = line.trim().toLowerCase();
        if (cmd === 'p') {
            if (!isPaused) {
                isPaused = true;
                console.log('\n>>> [PAUSE REQUESTED] Execution paused. Type "r" + Enter to resume. <<<');
            }
        } else if (cmd === 'r') {
            if (isPaused) {
                isPaused = false;
                console.log('\n>>> [RESUMED] Execution resumed. Continuing queue. <<<');
            }
        } else if (cmd === 'q') {
            console.log('\n>>> [STOP REQUESTED] Gracefully finishing current operation and exiting... <<<');
            isStopping = true;
        }
    });

    return rl;
}

/**
 * Wait for WhatsApp Web to be fully logged in
 */
async function waitForWhatsAppLogin(page) {
    console.log('\n============================================================');
    console.log('  OPENING WHATSAPP WEB');
    console.log('============================================================');
    console.log('>> If this is your first time or session expired:');
    console.log('>> Please SCAN THE QR CODE in the opened Chrome browser window.');
    console.log('>> Waiting for login detection...');
    console.log('============================================================\n');

    await page.goto('https://web.whatsapp.com', {
        waitUntil: 'networkidle2',
        timeout: 90000,
    });

    // Selectors that indicate the user is logged into WhatsApp Web
    const loggedInSelectors = [
        'div[data-testid="chat-list"]',
        'div[aria-label="Chat list"]',
        '#pane-side',
        'header',
        'div[contenteditable="true"][data-tab="3"]', // search bar
        'div[data-testid="chat-list-search"]'
    ];

    let loggedIn = false;
    const startTime = Date.now();
    const maxWaitTime = 180000; // 3 minutes for QR scan

    while (!loggedIn && (Date.now() - startTime) < maxWaitTime) {
        for (const selector of loggedInSelectors) {
            const element = await page.$(selector);
            if (element) {
                loggedIn = true;
                break;
            }
        }
        if (!loggedIn) {
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    if (!loggedIn) {
        console.log('\n[!] Automatic login detection timed out. If you have scanned the QR code');
        const ans = await promptUser('Press Enter once WhatsApp Web has fully loaded in the browser, or type "exit": ');
        if (ans.toLowerCase() === 'exit') {
            throw new Error('User cancelled during QR code login.');
        }
    }

    console.log('[+] WhatsApp Web is connected and ready!\n');
}

/**
 * Send a message to a single contact (with optional image attachment)
 */
async function sendMessageToContact(page, phone, messageText, timeoutSeconds, imagePath = null) {
    if (imagePath && fs.existsSync(imagePath)) {
        try {
            // Navigate directly to contact chat
            const chatUrl = `https://web.whatsapp.com/send?phone=${phone}`;
            await page.goto(chatUrl, { waitUntil: 'domcontentloaded', timeout: timeoutSeconds * 1000 });

            // Check for invalid popup first
            await new Promise(r => setTimeout(r, 2500));
            const isInvalid = await page.evaluate(() => {
                const dialog = document.querySelector('div[role="dialog"]');
                if (!dialog) return false;
                const text = dialog.innerText || '';
                return text.includes('invalid') || text.includes('not on WhatsApp');
            });

            if (isInvalid) {
                await page.evaluate(() => {
                    const btn = document.querySelector('div[role="dialog"] button');
                    if (btn) btn.click();
                });
                return { success: false, reason: 'Invalid number or not registered on WhatsApp' };
            }

            // Look for file input
            const fileInput = await page.$('input[type="file"]');
            if (fileInput) {
                await fileInput.uploadFile(imagePath);
                await new Promise(r => setTimeout(r, 3000));

                // Find caption box in the media preview screen
                const captionBox = await page.$('div[contenteditable="true"]');
                if (captionBox) {
                    await captionBox.focus();
                    await page.evaluate((el, text) => {
                        el.focus();
                        document.execCommand('insertText', false, text);
                    }, captionBox, messageText);
                }

                await new Promise(r => setTimeout(r, 1500));

                // Click send button
                const sendBtn = await page.$('span[data-icon="send"], button[aria-label="Send"]');
                if (sendBtn) {
                    await sendBtn.click();
                    await new Promise(r => setTimeout(r, 3000));
                    return { success: true };
                }
            }
        } catch (e) {
            console.warn(`[WARN] Image upload failed for ${phone}: ${e.message}. Falling back to text message.`);
        }
    }

    // Standard text delivery fallback
    const encodedText = encodeURIComponent(messageText);
    const chatUrl = `https://web.whatsapp.com/send?phone=${phone}&text=${encodedText}`;

    await page.goto(chatUrl, {
        waitUntil: 'domcontentloaded',
        timeout: timeoutSeconds * 1000,
    });

    const checkInterval = 600;
    const maxChecks = Math.floor((timeoutSeconds * 1000) / checkInterval);

    for (let check = 0; check < maxChecks; check++) {
        if (isStopping) {
            return { success: false, reason: 'Aborted by user' };
        }

        // Check for invalid phone number dialog popup
        const isInvalidPopup = await page.evaluate(() => {
            const dialog = document.querySelector('div[role="dialog"]');
            if (!dialog) return false;
            const text = dialog.innerText || '';
            const isInvalidText = text.includes('Phone number shared via url is invalid') ||
                text.includes('invalid') ||
                text.includes('not on WhatsApp');
            if (isInvalidText) {
                const okBtn = dialog.querySelector('button');
                if (okBtn) okBtn.click();
                return true;
            }
            return false;
        });

        if (isInvalidPopup) {
            return { success: false, reason: 'Invalid number or not registered on WhatsApp' };
        }

        // Check for Send button or message input box
        const sendStatus = await page.evaluate(() => {
            const sendButton = document.querySelector('button[aria-label="Send"], span[data-icon="send"], button[data-testid="compose-btn-send"]');
            if (sendButton) {
                const btn = sendButton.tagName.toLowerCase() === 'button' ? sendButton : sendButton.closest('button');
                if (btn) {
                    btn.click();
                    return 'CLICKED_BUTTON';
                }
            }

            const inputBox = document.querySelector('footer div[contenteditable="true"]');
            if (inputBox && inputBox.innerText.trim().length > 0) {
                inputBox.focus();
                return 'INPUT_READY';
            }

            return null;
        });

        if (sendStatus === 'CLICKED_BUTTON') {
            await new Promise(r => setTimeout(r, 2000));
            return { success: true };
        } else if (sendStatus === 'INPUT_READY') {
            await page.keyboard.press('Enter');
            await new Promise(r => setTimeout(r, 2000));
            return { success: true };
        }

        await new Promise(r => setTimeout(r, checkInterval));
    }

    return { success: false, reason: 'Page load or send button timeout' };
}

/**
 * Main Execution Function
 */
async function main() {
    console.log('============================================================');
    console.log('  WHATSAPP BULK MESSAGING AUTOMATION (BROWSER / WHATSAPP WEB)');
    console.log('============================================================');

    // 1. Load configuration and message
    const config = loadConfig();
    const rawMessage = loadMessage(config);
    const tracker = loadTracker();
    const contacts = loadContacts(config.csvFilePath, config.defaultCountryCode);

    // Filter contacts based on tracker
    const validContacts = contacts.filter(c => c.valid);
    const invalidContacts = contacts.filter(c => !c.valid);

    const pendingContacts = validContacts.filter(c => !tracker.sent.has(c.phone));
    const alreadySentCount = validContacts.length - pendingContacts.length;

    // Log already known invalid contacts
    for (const inv of invalidContacts) {
        if (!tracker.failed.has(inv.raw)) {
            tracker.failed.add(inv.raw);
            appendLog(FAILED_LOG_FILE, `SKIPPED | Raw: ${inv.raw} | Reason: ${inv.error}`);
        }
    }
    saveTracker(tracker);

    // Calculate time estimate
    const avgDelay = (config.delayMinSeconds + config.delayMaxSeconds) / 2;
    const estMinutes = Math.round((pendingContacts.length * (avgDelay + 5)) / 60);

    // 2. Display summary
    console.log('\n[CONFIGURATION SUMMARY]');
    console.log(`- CSV File:               ${config.csvFilePath}`);
    console.log(`- Total Contacts in CSV:  ${contacts.length}`);
    console.log(`- Valid Contacts:         ${validContacts.length}`);
    console.log(`- Invalid Numbers:        ${invalidContacts.length} (automatically skipped)`);
    console.log(`- Already Sent:           ${alreadySentCount} (preventing duplicates)`);
    console.log(`- Remaining to Send:      ${pendingContacts.length}`);
    console.log(`- Delay Between Messages: ${config.delayMinSeconds}s - ${config.delayMaxSeconds}s`);
    console.log(`- Batch Size:             ${config.batchSize} contacts per batch`);
    console.log(`- Batch Rest Break:       ${config.batchCooldownMinMinutes} - ${config.batchCooldownMaxMinutes} minutes`);
    const imageFullPath = path.resolve(__dirname, config.imageFilePath);
    const hasImage = config.sendImage && fs.existsSync(imageFullPath);
    console.log(`- Image Attachment:       ${hasImage ? config.imageFilePath + ' (sent with announcement caption)' : 'None (Text only)'}`);
    console.log(`- Estimated Duration:     ~${estMinutes} minutes`);
    console.log(`- Session Directory:      ${config.sessionDirectory}`);
    console.log('\n[MESSAGE PREVIEW]');
    console.log('------------------------------------------------------------');
    console.log(rawMessage.length > 250 ? rawMessage.substring(0, 250) + '...\n[truncated]' : rawMessage);
    console.log('------------------------------------------------------------');

    console.log('\n[CRITICAL NOTICE & BAN RISK WARNING]');
    console.log('1. Automated messaging using WhatsApp Web is strictly for consented recipients.');
    console.log('2. Sending messages too fast or to contacts who report or block your number');
    console.log('   WILL cause WhatsApp to flag or permanently ban your phone number.');
    console.log('3. Safe messaging speed is typically 15-30+ seconds between messages with reasonable batch sizes.');

    // 3. Explicit User Authorization (Requirement 13)
    if (config.requireExplicitConfirmation) {
        console.log('\n============================================================');
        console.log('  AUTHORIZATION REQUIRED (Requirement 13)');
        console.log('============================================================');
        const auth = await promptUser('To confirm and authorize sending messages, type "START" and press Enter: ');
        if (auth !== 'START') {
            console.log('\n[ABORTED] Authorization not provided. No messages were sent. Exiting cleanly.');
            process.exit(0);
        }
    }

    if (pendingContacts.length === 0) {
        console.log('\n[DONE] All contacts have already been processed in previous sessions! Nothing to send.');
        process.exit(0);
    }

    // 4. Launch Puppeteer browser
    console.log('\nLaunching Chrome browser via Puppeteer...');
    const sessionPath = path.resolve(__dirname, config.sessionDirectory);

    const browser = await puppeteer.launch({
        headless: config.headless,
        userDataDir: sessionPath,
        defaultViewport: null,
        args: [
            '--start-maximized',
            '--disable-blink-features=AutomationControlled',
            '--no-sandbox',
            '--disable-setuid-sandbox',
        ],
    });

    const pages = await browser.pages();
    const page = pages.length > 0 ? pages[0] : await browser.newPage();

    // Set standard user agent
    await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
    );

    // Setup interactive pause / resume listener
    setupKeyboardControls();

    try {
        // Wait for WhatsApp Web QR scan / login
        await waitForWhatsAppLogin(page);

        console.log('============================================================');
        console.log('  STARTING MESSAGE QUEUE');
        console.log('  Controls: Type "p" + Enter to PAUSE, "r" to RESUME, "q" to STOP');
        console.log('============================================================\n');

        let sentInThisSession = 0;
        let failedInThisSession = 0;
        let batchCounter = 0;
        const totalToProcess = pendingContacts.length;

        for (let i = 0; i < pendingContacts.length; i++) {
            if (isStopping) {
                console.log('\n[STOPPED] Stopping execution as requested by user.');
                break;
            }

            // Check if paused
            while (isPaused && !isStopping) {
                process.stdout.write(`\r[PAUSED] Process is paused. Press 'r' + Enter to resume...     `);
                await new Promise(r => setTimeout(r, 1000));
            }

            if (isStopping) break;

            const contact = pendingContacts[i];
            const currentTotalSent = tracker.sent.size;
            const currentTotalFailed = tracker.failed.size;
            const overallProgress = (((alreadySentCount + i) / validContacts.length) * 100).toFixed(1);

            console.log(`\n[Contact ${alreadySentCount + i + 1}/${validContacts.length}] [Batch: ${batchCounter + 1}/${config.batchSize}] (${overallProgress}%)`);
            console.log(`Target: ${contact.phone} ${contact.name ? `(${contact.name})` : ''}`);

            // Replace personalization placeholders if present
            const personalizedMessage = rawMessage.replace(/\{\{name\}\}/gi, contact.name || 'Friend');

            try {
                const imageToSend = (config.sendImage && fs.existsSync(imageFullPath)) ? imageFullPath : null;
                const result = await sendMessageToContact(page, contact.phone, personalizedMessage, config.pageTimeoutSeconds, imageToSend);

                if (result.success) {
                    tracker.sent.add(contact.phone);
                    sentInThisSession++;
                    batchCounter++;
                    appendLog(SUCCESS_LOG_FILE, `SENT | Phone: +${contact.phone} | Name: ${contact.name || 'N/A'}`);
                    console.log(`[SUCCESS] Message delivered to +${contact.phone}`);
                } else {
                    tracker.failed.add(contact.phone);
                    failedInThisSession++;
                    appendLog(FAILED_LOG_FILE, `FAILED | Phone: +${contact.phone} | Reason: ${result.reason}`);
                    console.log(`[FAILED] Could not send to +${contact.phone}: ${result.reason}`);
                }
            } catch (err) {
                tracker.failed.add(contact.phone);
                failedInThisSession++;
                appendLog(FAILED_LOG_FILE, `ERROR | Phone: +${contact.phone} | Error: ${err.message}`);
                console.log(`[ERROR] Exception while sending to +${contact.phone}: ${err.message}`);
            }

            // Persist tracker state after every single message
            saveTracker(tracker);

            // Print stats line
            console.log(`Session stats: Sent: ${sentInThisSession} | Failed: ${failedInThisSession} | Total Remaining: ${totalToProcess - (i + 1)}`);

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

        console.log('\n============================================================');
        console.log('  RUN SUMMARY');
        console.log('============================================================');
        console.log(`- Sent in this session:      ${sentInThisSession}`);
        console.log(`- Failed in this session:    ${failedInThisSession}`);
        console.log(`- Total successfully sent:   ${tracker.sent.size}/${validContacts.length}`);
        console.log(`- Tracker file saved at:     ${TRACKER_FILE}`);
        console.log(`- Success logs:              ${SUCCESS_LOG_FILE}`);
        console.log(`- Failure logs:              ${FAILED_LOG_FILE}`);
        console.log('============================================================\n');

    } catch (err) {
        console.error('\n[FATAL ERROR]', err);
    } finally {
        saveTracker(tracker);
        console.log('Closing browser session...');
        try {
            await browser.close();
        } catch (e) {
            // ignore
        }
        console.log('Exited safely.');
        process.exit(0);
    }
}

// Handle unexpected termination cleanly
process.on('SIGINT', () => {
    console.log('\n[SIGINT detected] Exiting gracefully...');
    isStopping = true;
});

// Run
main().catch(err => {
    console.error('Fatal initialization error:', err);
    process.exit(1);
});
