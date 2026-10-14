/**
 * ==============================================================================
 * WhatsApp Campaign Manager - Client Application
 * ==============================================================================
 */

document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements - Status
    const connectionStatusBadge = document.getElementById('connectionStatusBadge');
    const connectionStatusText = document.getElementById('connectionStatusText');

    // DOM Elements - Login & QR
    const qrArea = document.getElementById('qrArea');
    const qrPlaceholder = document.getElementById('qrPlaceholder');
    const qrLoadingText = document.getElementById('qrLoadingText');
    const qrImage = document.getElementById('qrImage');
    const qrInstructions = document.getElementById('qrInstructions');
    const connectedBanner = document.getElementById('connectedBanner');
    const connectedUserText = document.getElementById('connectedUserText');
    const reconnectBtn = document.getElementById('reconnectBtn');
    const qrActions = document.getElementById('qrActions');
    const downloadQrBtn = document.getElementById('downloadQrBtn');
    const copyQrBtn = document.getElementById('copyQrBtn');

    // DOM Elements - Campaign Preview
    const campaignImagePreview = document.getElementById('campaignImagePreview');
    const messageTextContent = document.getElementById('messageTextContent');
    const metricTotalContacts = document.getElementById('metricTotalContacts');
    const metricBatchSize = document.getElementById('metricBatchSize');
    const metricCooldown = document.getElementById('metricCooldown');
    const metricDelay = document.getElementById('metricDelay');

    // DOM Elements - Queue
    const activeFileNameText = document.getElementById('activeFileNameText');
    const queueProgressBadge = document.getElementById('queueProgressBadge');
    const resetQueueBtn = document.getElementById('resetQueueBtn');

    // DOM Elements - Actions
    const startCampaignBtn = document.getElementById('startCampaignBtn');
    const pauseCampaignBtn = document.getElementById('pauseCampaignBtn');
    const resumeCampaignBtn = document.getElementById('resumeCampaignBtn');
    const stopCampaignBtn = document.getElementById('stopCampaignBtn');

    // DOM Elements - Progress & Stats
    const liveBatchSubtitle = document.getElementById('liveBatchSubtitle');
    const progressBarFill = document.getElementById('progressBarFill');
    const progressPercentText = document.getElementById('progressPercentText');
    const progressSummaryText = document.getElementById('progressSummaryText');
    const statSent = document.getElementById('statSent');
    const statFailed = document.getElementById('statFailed');
    const statCurrentBatch = document.getElementById('statCurrentBatch');
    const statCurrentAction = document.getElementById('statCurrentAction');
    const terminalBody = document.getElementById('terminalBody');
    const clearLogsBtn = document.getElementById('clearLogsBtn');

    let isConnected = false;
    let isRunning = false;
    let isPaused = false;

    /**
     * Append message to live terminal console
     */
    function appendLog(text, type = 'info') {
        const line = document.createElement('div');
        line.className = `log-line log-${type}`;
        const time = new Date().toLocaleTimeString();
        line.textContent = `[${time}] ${text}`;
        terminalBody.appendChild(line);
        terminalBody.scrollTop = terminalBody.scrollHeight;
    }

    /**
     * Clear terminal logs
     */
    clearLogsBtn.addEventListener('click', () => {
        terminalBody.innerHTML = '';
        appendLog('Console cleared.', 'system');
    });

    /**
     * Reset CSV file queue to File 1
     */
    resetQueueBtn.addEventListener('click', async () => {
        const confirmReset = confirm('Do you want to reset the CSV file queue back to File 1?');
        if (!confirmReset) return;

        try {
            const res = await fetch('/api/reset-queue', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                appendLog('CSV queue reset to beginning!', 'success');
                loadCampaignInfo();
            }
        } catch (e) {
            appendLog(`Reset queue error: ${e.message}`, 'error');
        }
    });

    const splitCsvBtn = document.getElementById('splitCsvBtn');
    if (splitCsvBtn) {
        splitCsvBtn.addEventListener('click', async () => {
            const confirmSplit = confirm('Do you want to split contacts.csv into 100-number files inside csv_files/?');
            if (!confirmSplit) return;

            try {
                const res = await fetch('/api/split-csv', { method: 'POST' });
                const data = await res.json();
                if (data.success) {
                    appendLog(`Created ${data.files.length} files of up to 100 contacts each in csv_files/!`, 'success');
                    loadCampaignInfo();
                } else {
                    alert(`Error: ${data.error}`);
                }
            } catch (e) {
                appendLog(`Split error: ${e.message}`, 'error');
            }
        });
    }

    /**
     * Fetch initial campaign info
     */
    async function loadCampaignInfo() {
        try {
            const res = await fetch('/api/campaign');
            const data = await res.json();

            if (data.success) {
                messageTextContent.textContent = data.message || '(Empty message)';
                metricTotalContacts.textContent = data.totalContacts || 0;
                metricBatchSize.textContent = data.config.batchSize || 20;
                metricCooldown.textContent = `${data.config.batchCooldownMinMinutes} - ${data.config.batchCooldownMaxMinutes} min`;
                metricDelay.textContent = `${data.config.delayMinSeconds} - ${data.config.delayMaxSeconds}s`;

                // Queue details
                if (data.queue) {
                    if (data.queue.activeFile) {
                        activeFileNameText.textContent = data.queue.activeFile;
                        queueProgressBadge.textContent = `File ${data.queue.completedFiles.length + 1} of ${data.queue.totalFiles}`;
                        queueProgressBadge.style.background = 'rgba(59, 130, 246, 0.2)';
                        queueProgressBadge.style.color = '#93C5FD';
                    } else {
                        activeFileNameText.textContent = 'All Files Completed 🎉';
                        queueProgressBadge.textContent = 'Queue Done';
                        queueProgressBadge.style.background = 'rgba(16, 185, 129, 0.2)';
                        queueProgressBadge.style.color = '#34D399';
                    }
                }

                // Progress initial state
                updateProgressUI(data.stats);
            }
        } catch (err) {
            console.error('Failed to load campaign data:', err);
            appendLog('Could not reach backend API server.', 'error');
        }
    }

    /**
     * Update progress UI bars and counters
     */
    function updateProgressUI(stats) {
        if (!stats) return;

        const total = stats.totalContacts || 0;
        const sent = stats.sent || 0;
        const failed = stats.failed || 0;
        const processed = sent + failed;
        const percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;

        progressBarFill.style.width = `${percent}%`;
        progressPercentText.textContent = `${percent}%`;
        progressSummaryText.textContent = `${processed} of ${total} processed`;

        statSent.textContent = sent;
        statFailed.textContent = failed;

        if (stats.batchInfo) {
            statCurrentBatch.textContent = stats.batchInfo;
        }

        if (stats.actionStatus) {
            statCurrentAction.textContent = stats.actionStatus;
        }
    }

    /**
     * Poll connection status & QR Code
     */
    async function checkStatus() {
        try {
            const res = await fetch('/api/status');
            const data = await res.json();

            if (data.status === 'connected') {
                if (!isConnected) {
                    isConnected = true;
                    appendLog('WhatsApp account connected successfully!', 'success');
                }

                // Update status badge
                connectionStatusBadge.className = 'status-pill status-connected';
                connectionStatusText.textContent = `Connected: +${data.user || 'Active'}`;

                // Hide QR, show connected card
                qrArea.classList.add('hidden');
                qrInstructions.classList.add('hidden');
                if (qrActions) qrActions.classList.add('hidden');
                connectedBanner.classList.remove('hidden');
                connectedUserText.textContent = `Phone: +${data.user || 'Sender Connected'}`;

                // Enable start button if not already running
                if (!isRunning) {
                    startCampaignBtn.disabled = false;
                }
            } else {
                isConnected = false;
                connectedBanner.classList.add('hidden');
                qrArea.classList.remove('hidden');
                qrInstructions.classList.remove('hidden');

                if (data.status === 'connecting' || data.status === 'qr_ready') {
                    connectionStatusBadge.className = 'status-pill status-connecting';
                    connectionStatusText.textContent = data.qrCodeDataUrl ? 'Scan QR Code' : 'Connecting...';
                } else {
                    connectionStatusBadge.className = 'status-pill status-disconnected';
                    connectionStatusText.textContent = data.qrCodeDataUrl ? 'Scan QR Code' : 'Disconnected';
                }

                if (data.qrCodeDataUrl) {
                    qrPlaceholder.classList.add('hidden');
                    qrImage.classList.remove('hidden');
                    qrImage.src = data.qrCodeDataUrl;
                    if (qrActions) qrActions.classList.remove('hidden');
                } else {
                    qrPlaceholder.classList.remove('hidden');
                    qrImage.classList.add('hidden');
                    qrLoadingText.textContent = 'Generating QR code...';
                    if (qrActions) qrActions.classList.add('hidden');
                }

                startCampaignBtn.disabled = true;
            }

            // Sync campaign run state
            if (data.campaign) {
                isRunning = data.campaign.isRunning;
                isPaused = data.campaign.isPaused;
                updateButtonStates();
                updateProgressUI(data.campaign.stats);
            }

        } catch (err) {
            connectionStatusBadge.className = 'status-pill status-disconnected';
            connectionStatusText.textContent = 'Server Offline';
        }
    }

    /**
     * Update button visibility based on running / paused states
     */
    function updateButtonStates() {
        if (isRunning) {
            startCampaignBtn.classList.add('hidden');
            stopCampaignBtn.classList.remove('hidden');

            if (isPaused) {
                pauseCampaignBtn.classList.add('hidden');
                resumeCampaignBtn.classList.remove('hidden');
            } else {
                pauseCampaignBtn.classList.remove('hidden');
                resumeCampaignBtn.classList.add('hidden');
            }
        } else {
            startCampaignBtn.classList.remove('hidden');
            startCampaignBtn.disabled = !isConnected;
            pauseCampaignBtn.classList.add('hidden');
            resumeCampaignBtn.classList.add('hidden');
            stopCampaignBtn.classList.add('hidden');
        }
    }

    /**
     * Start Campaign Button Action
     */
    startCampaignBtn.addEventListener('click', async () => {
        if (!isConnected) {
            alert('Please link WhatsApp by scanning the QR code first!');
            return;
        }

        const confirmStart = confirm('Are you ready to begin sending the Grand Opening announcement with image flyer to your contact list?');
        if (!confirmStart) return;

        startCampaignBtn.disabled = true;
        appendLog('Starting bulk campaign...', 'system');

        try {
            const res = await fetch('/api/start', { method: 'POST' });
            const data = await res.json();

            if (data.success) {
                isRunning = true;
                isPaused = false;
                updateButtonStates();
                appendLog('Campaign started! First batch in progress...', 'success');
            } else {
                alert(`Error: ${data.message}`);
                startCampaignBtn.disabled = false;
            }
        } catch (err) {
            appendLog(`Failed to start: ${err.message}`, 'error');
            startCampaignBtn.disabled = false;
        }
    });

    /**
     * Pause Campaign Action
     */
    pauseCampaignBtn.addEventListener('click', async () => {
        try {
            const res = await fetch('/api/pause', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                isPaused = true;
                updateButtonStates();
                appendLog('Campaign paused by user.', 'warn');
            }
        } catch (err) {
            appendLog(`Pause request failed: ${err.message}`, 'error');
        }
    });

    /**
     * Resume Campaign Action
     */
    resumeCampaignBtn.addEventListener('click', async () => {
        try {
            const res = await fetch('/api/resume', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                isPaused = false;
                updateButtonStates();
                appendLog('Campaign resumed.', 'success');
            }
        } catch (err) {
            appendLog(`Resume request failed: ${err.message}`, 'error');
        }
    });

    /**
     * Stop Campaign Action
     */
    stopCampaignBtn.addEventListener('click', async () => {
        const confirmStop = confirm('Are you sure you want to stop the campaign? Current progress will be saved in tracker.json.');
        if (!confirmStop) return;

        try {
            const res = await fetch('/api/stop', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                isRunning = false;
                isPaused = false;
                updateButtonStates();
                appendLog('Campaign stopped safely. Progress saved.', 'warn');
            }
        } catch (err) {
            appendLog(`Stop request failed: ${err.message}`, 'error');
        }
    });

    /**
     * Re-link Session Button
     */
    async function triggerRelink() {
        try {
            appendLog('Logging out and requesting fresh QR code...', 'system');
            await fetch('/api/relink', { method: 'POST' });
            checkStatus();
        } catch (err) {
            appendLog(`Re-link error: ${err.message}`, 'error');
        }
    }

    if (reconnectBtn) {
        reconnectBtn.addEventListener('click', async () => {
            const confirmRelink = confirm('Do you want to log out and re-scan a new QR code?');
            if (!confirmRelink) return;
            await triggerRelink();
        });
    }

    const cardRelinkBtn = document.getElementById('cardRelinkBtn');
    if (cardRelinkBtn) {
        cardRelinkBtn.addEventListener('click', async () => {
            await triggerRelink();
        });
    }

    // Download QR image
    if (downloadQrBtn) {
        downloadQrBtn.addEventListener('click', () => {
            if (!qrImage.src) return;
            const a = document.createElement('a');
            a.href = qrImage.src;
            a.download = 'whatsapp-sender-qr.png';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            appendLog('QR code image downloaded. You can share this image to link phone!', 'success');
        });
    }

    // Copy QR image to clipboard
    if (copyQrBtn) {
        copyQrBtn.addEventListener('click', async () => {
            if (!qrImage.src) return;
            try {
                const res = await fetch(qrImage.src);
                const blob = await res.blob();
                await navigator.clipboard.write([
                    new ClipboardItem({ 'image/png': blob })
                ]);
                appendLog('✅ QR code copied to clipboard! You can paste (Ctrl+V) directly in chat to send.', 'success');
            } catch (err) {
                // Fallback: download
                const a = document.createElement('a');
                a.href = qrImage.src;
                a.download = 'whatsapp-sender-qr.png';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                appendLog('QR downloaded (clipboard not supported on this browser context).', 'info');
            }
        });
    }

    /**
     * Setup Server-Sent Events (SSE) for Real-Time Live Feed
     */
    function setupSSE() {
        const eventSource = new EventSource('/api/events');

        eventSource.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);

                if (data.type === 'log') {
                    appendLog(data.message, data.level || 'info');
                } else if (data.type === 'stats') {
                    updateProgressUI(data.stats);
                    if (data.batchInfo) liveBatchSubtitle.textContent = data.batchInfo;
                } else if (data.type === 'status_change') {
                    checkStatus();
                }
            } catch (e) {
                // Ignore parse errors
            }
        };

        eventSource.onerror = () => {
            // Reconnects automatically
        };
    }

    // Initialize
    loadCampaignInfo();
    checkStatus();
    setupSSE();

    // Poll status every 3 seconds for QR updates and connection changes
    setInterval(checkStatus, 3000);
});
