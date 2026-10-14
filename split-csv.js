/**
 * ==============================================================================
 * CSV Splitter - Splits Large CSV Contact Lists into Batches of 100 Contacts
 * ==============================================================================
 */

const fs = require('fs');
const path = require('path');

function loadConfig() {
    try {
        const p = path.join(__dirname, 'config.json');
        if (fs.existsSync(p)) {
            return JSON.parse(fs.readFileSync(p, 'utf-8'));
        }
    } catch (e) { }
    return { defaultCountryCode: '91' };
}

/**
 * Parse lines considering potential quoted commas/newlines
 */
function parseCsvRows(content) {
    const rows = [];
    let currentRow = [];
    let currentField = '';
    let insideQuotes = false;

    for (let i = 0; i < content.length; i++) {
        const char = content[i];
        const nextChar = content[i + 1];

        if (char === '"') {
            if (insideQuotes && nextChar === '"') {
                currentField += '"';
                i++;
            } else {
                insideQuotes = !insideQuotes;
            }
        } else if (char === ',' && !insideQuotes) {
            currentRow.push(currentField);
            currentField = '';
        } else if ((char === '\r' || char === '\n') && !insideQuotes) {
            if (char === '\r' && nextChar === '\n') {
                i++;
            }
            currentRow.push(currentField);
            currentField = '';
            if (currentRow.some(c => c.trim().length > 0)) {
                rows.push(currentRow);
            }
            currentRow = [];
        } else {
            currentField += char;
        }
    }

    if (currentField.length > 0 || currentRow.length > 0) {
        currentRow.push(currentField);
        if (currentRow.some(c => c.trim().length > 0)) {
            rows.push(currentRow);
        }
    }

    return rows;
}

/**
 * Extract contacts from parsed rows
 */
function extractContacts(rows, defaultCountryCode = '91') {
    if (!rows || rows.length === 0) return [];

    const headers = rows[0].map(h => h.trim());
    const headerLower = headers.map(h => h.toLowerCase());

    // Detect column indexes
    let phoneColIndex = -1;
    let nameColIndex = -1;
    let notesColIndex = headerLower.findIndex(h => h === 'notes');

    // Look for Phone column (prioritize columns with 'value', avoid 'phonetic' and 'label')
    const candidatePhones = [];
    headerLower.forEach((h, idx) => {
        if (h.includes('phonetic') || h.includes('label')) return;
        if (h.includes('phone') || h.includes('mobile') || h.includes('contact') || h.includes('cell') || h.includes('number')) {
            candidatePhones.push({ idx, name: h, isValue: h.includes('value') });
        }
    });

    candidatePhones.sort((a, b) => (b.isValue ? 1 : 0) - (a.isValue ? 1 : 0));
    if (candidatePhones.length > 0) {
        phoneColIndex = candidatePhones[0].idx;
    }

    // Name column
    nameColIndex = headerLower.findIndex(h => h === 'name' || h === 'first name' || h.includes('name'));

    // If no header matches, assume col 0 is phone or col 1 is phone
    const hasHeader = phoneColIndex !== -1 || nameColIndex !== -1;
    const dataRows = hasHeader ? rows.slice(1) : rows;

    if (!hasHeader) {
        phoneColIndex = 0;
        nameColIndex = 1;
    }

    const contactsMap = new Map();

    for (const row of dataRows) {
        let rawPhone = phoneColIndex >= 0 ? (row[phoneColIndex] || '').trim() : '';
        let rawName = nameColIndex >= 0 ? (row[nameColIndex] || '').trim() : '';

        // If no phone found in primary col, search other candidate columns
        if (!rawPhone) {
            for (const cand of candidatePhones) {
                if (row[cand.idx] && row[cand.idx].trim()) {
                    rawPhone = row[cand.idx].trim();
                    break;
                }
            }
        }

        // If still no phone, check Notes for phone numbers
        if (!rawPhone && notesColIndex >= 0 && row[notesColIndex]) {
            const match = row[notesColIndex].match(/(?:\+?\d{1,4}[-.\s]?)?[6-9]\d{9}/);
            if (match) rawPhone = match[0];
        }

        let digits = rawPhone.replace(/\D/g, '');
        if (!digits || digits.length < 7) continue;

        // Apply country code if 10 digits
        if (digits.length === 10 && defaultCountryCode) {
            digits = defaultCountryCode + digits;
        }

        const candidateName = rawName || 'Friend';

        if (contactsMap.has(digits)) {
            // If already present, prefer name with actual letters over pure numbers or short names
            const existing = contactsMap.get(digits);
            const currentLetterCount = (existing.name.match(/[a-zA-Z]/g) || []).length;
            const newLetterCount = (candidateName.match(/[a-zA-Z]/g) || []).length;
            if (newLetterCount > currentLetterCount) {
                existing.name = candidateName;
            }
        } else {
            contactsMap.set(digits, {
                name: candidateName,
                phone: digits
            });
        }
    }

    return Array.from(contactsMap.values());
}

/**
 * Split source CSV into files of up to chunkSize contacts each
 */
function splitCsv(sourcePath, chunkSize = 100) {
    const config = loadConfig();
    const csvDir = path.join(__dirname, 'csv_files');
    if (!fs.existsSync(csvDir)) {
        fs.mkdirSync(csvDir, { recursive: true });
    }

    // Find source file if not explicitly passed
    let fileToSplit = sourcePath;
    if (!fileToSplit) {
        const candidates = [
            path.join(csvDir, 'contacts (2).csv'),
            path.join(csvDir, 'contacts.csv'),
            path.join(__dirname, 'contacts.csv'),
        ];

        if (fs.existsSync(csvDir)) {
            const files = fs.readdirSync(csvDir)
                .filter(f => f.toLowerCase().endsWith('.csv') && !f.startsWith('contacts_part'))
                .map(f => path.join(csvDir, f));
            candidates.push(...files);
        }

        fileToSplit = candidates.find(f => fs.existsSync(f));
    }

    if (!fileToSplit || !fs.existsSync(fileToSplit)) {
        throw new Error(`Source CSV file not found to split! Looked in csv_files/`);
    }

    console.log(`[SPLIT] Reading contacts from: "${fileToSplit}"`);
    const content = fs.readFileSync(fileToSplit, 'utf-8');
    const rows = parseCsvRows(content);
    const contacts = extractContacts(rows, config.defaultCountryCode || '91');

    console.log(`[SPLIT] Found ${contacts.length} unique contacts.`);
    if (contacts.length === 0) {
        throw new Error('No valid contacts found in the file.');
    }

    const createdFiles = [];
    let fileIndex = 1;

    for (let i = 0; i < contacts.length; i += chunkSize) {
        const chunk = contacts.slice(i, i + chunkSize);
        const fileName = `contacts_part${fileIndex}.csv`;
        const filePath = path.join(csvDir, fileName);

        // Build CSV content
        let csvContent = 'Name,Phone\r\n';
        chunk.forEach(c => {
            const safeName = `"${c.name.replace(/"/g, '""')}"`;
            csvContent += `${safeName},+${c.phone}\r\n`;
        });

        fs.writeFileSync(filePath, csvContent, 'utf-8');
        createdFiles.push(`csv_files/${fileName}`);
        console.log(`[SPLIT] Created ${fileName} with ${chunk.length} contacts.`);
        fileIndex++;
    }

    return createdFiles;
}

if (require.main === module) {
    try {
        const created = splitCsv();
        console.log(`\n✅ Successfully generated ${created.length} CSV files in csv_files/!`);
        created.forEach(f => console.log(`   - ${f}`));
    } catch (err) {
        console.error('❌ Error splitting CSV:', err.message);
        process.exit(1);
    }
}

module.exports = { splitCsv, parseCsvRows, extractContacts };
