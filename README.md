# WhatsApp Bulk Messenger Automation

A robust, configurable Node.js automation project for sending personalized WhatsApp messages to contacts without using paid official APIs. Designed for legitimate messaging to opted-in recipients, featuring duplicate protection, manual QR code login, configurable delays, and real-time pause/resume controls.

---

## ⚠️ Important Disclaimer, Limitations & Account Ban Risks

### 1. WhatsApp Anti-Spam Policies & Account-Ban Risks
* **WhatsApp strictly monitors bulk and automated messaging.**
* If your phone number sends 700 messages in a very short window or sends messages to recipients who do not have your number saved in their address book, recipients may report or block your number.
* Even **a few user spam reports ("Report & Block")** can trigger an **automated, immediate ban** of your WhatsApp account.
* **Warm-up requirement:** Never send hundreds of messages from a freshly registered SIM card or fresh WhatsApp number.

### 2. Best Practices for Legitimate Messaging
* **Obtain explicit consent:** Only message individuals who have consented to receive announcements from your business.
* **Pacing & Natural Delays:** Keep the delay between messages between **15 to 35 seconds**. Sending too fast triggers WhatsApp's algorithmic activity spikes.
* **Send in smaller batches:** Instead of sending to 700 numbers in one single burst, send 100–150 contacts per session across several days or morning/evening windows.
* **No Anti-Detection Hacks:** This project does not use bypass tools, CAPTCHA crackers, or signature spoofing. It uses standard browser navigation or official WebSocket handshake protocols.

---

## 📁 Project Structure

```text
d:\whatsapp send msg\
├── config.json                 # Main configuration (delays, paths, country code)
├── content.txt                 # The message text to send (Grand opening announcement)
├── image.png                   # Flyer/banner image (optional attachment)
├── contacts.csv                # CSV file containing phone numbers and names
├── send-browser.js             # Puppeteer browser automation (WhatsApp Web)
├── send-baileys.js             # Standalone CLI sender using Baileys socket
├── server.js                   # Express API server for Baileys connections
├── data/
│   └── tracker.json            # Automatically tracks sent & failed numbers (prevents duplicates)
├── logs/
│   ├── success.log             # Logs of successfully delivered messages
│   └── failed.log              # Logs of failed or invalid numbers
├── whatsapp_browser_session/   # Stores WhatsApp Web login cookies (persists your login)
├── package.json                # Project dependencies and npm scripts
└── README.md                   # Complete documentation
```

---

## 🛠️ Prerequisites & Setup (Windows)

### 1. Verify Node.js
Ensure Node.js (v18+) is installed. Check by running:
```powershell
node -v
npm -v
```

### 2. Installed Dependencies
The required packages are already recorded in `package.json`:
* `puppeteer` (Chromium browser automation)
* `@whiskeysockets/baileys` (Socket-level WhatsApp connection)
* `express`, `cors`, `pino`

If you ever need to reinstall:
```powershell
npm install
```

---

## ⚙️ Configuration

### 1. `config.json`
Edit `config.json` to configure sending behavior:
```json
{
  "csvFilePath": "contacts.csv",
  "messageFilePath": "content.txt",
  "sendImage": true,
  "imageFilePath": "image.png",
  "defaultCountryCode": "91",
  "delayMinSeconds": 10,
  "delayMaxSeconds": 20,
  "batchSize": 20,
  "batchCooldownMinMinutes": 2,
  "batchCooldownMaxMinutes": 5,
  "requireExplicitConfirmation": true
}
```
* `sendImage`: When `true`, sends `image.png` with your announcement text as its caption.
* `batchSize`: Sends 20 contacts per batch.
* `batchCooldownMinMinutes` & `batchCooldownMaxMinutes`: Rest break of 2 to 5 minutes after every 20 contacts.
* `delayMinSeconds` & `delayMaxSeconds`: Randomized delay range in seconds between individual messages in a batch.
* `requireExplicitConfirmation`: Prompts you to type `START` in the terminal before sending.

### 2. Message Customization (`content.txt`)
Place your message inside `content.txt`. You can use the `{{name}}` placeholder for personalized greetings:
```text
Hello {{name}},

🎉 Grand Opening Announcement 🎉
We are delighted to announce that our store was launched during the auspicious festival of Navratri! 🙏✨
...
```

### 3. Contact List (`contacts.csv`)
Prepare your 700 contacts in `contacts.csv`. The script supports files with or without headers:
```csv
phone,name
919876543210,Rahul
919876543211,Priya
9876543212,Amit
```
* Numbers can start with `+91`, `91`, or `98...` (10 digits).
* Spaces, dashes, and parentheses are automatically stripped and cleaned.
* Invalid phone numbers are automatically skipped and logged to `logs/failed.log`.

---

## 🚀 How to Run

### Method 1: WhatsApp Web Browser Automation (Recommended)
### Method 1: Interactive Web Dashboard (Recommended)
This opens a complete browser dashboard with a visual QR code, live campaign preview, flyer image thumbnail, and start/pause/stop buttons.

1. In PowerShell, run:
   ```powershell
   npm start
   ```
   *(or `node server.js`)*
2. Open your browser to:
   **`http://localhost:3000`**
3. Scan the high-resolution QR code displayed on the webpage with your phone:
   * **WhatsApp > Linked Devices > Link a Device**
4. Once scanned, the status badge turns green **"Connected"**.
5. Click **"Start Sending Campaign"**!
   * The dashboard sends `image.png` flyer with your announcement caption.
   * Progress bar, batch counters, and live activity feed update in real-time.
   * Features instant **Pause**, **Resume**, and **Stop** buttons right on the page.

---

### Method 2: Headless CLI Engine (Terminal Only)
If you prefer running strictly from the terminal without opening a browser:
1. Run:
   ```powershell
   npm run send:baileys
   ```
2. Terminal displays the ASCII QR code to scan.
3. Type `START` to confirm and begin sending in batches of 20 with 2–5 min breaks.

---

### Method 3: Browser Automation (Puppeteer WhatsApp Web)
1. Run:
   ```powershell
   npm run send:browser
   ```

---

## ⏸️ Interactive Controls During Sending

While the script is running, you have live interactive controls in the terminal:
* Press **`p` + Enter**: **PAUSE** the sending process.
* Press **`r` + Enter**: **RESUME** sending.
* Press **`q` + Enter** or **Ctrl+C**: **STOP** safely. The script flushes current progress to `data/tracker.json` before exiting.

---

## 🔄 Duplicate Prevention & Resuming

* Every successful number is recorded in `data/tracker.json`.
* If you pause, stop, or restart the script, it compares `contacts.csv` against `data/tracker.json`.
* **Already contacted numbers will NEVER be messaged twice.**
* To reset and start a campaign from scratch, simply delete `data/tracker.json`.

---

## 📊 Logs

* **Successful Deliveries**: Check `logs/success.log`
* **Failed / Skipped Numbers**: Check `logs/failed.log`
