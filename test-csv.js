require('dotenv').config();
const axios = require('axios');
const { parse } = require('csv-parse/sync');

const sheetUrl = process.env.SHEET_CSV_URL;

function formatIcsDate(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return null;
    const parts = dateStr.trim().split('/');
    if (parts.length === 3) {
        const d = parts[0].trim().padStart(2, '0');
        const m = parts[1].trim().padStart(2, '0');
        const y = parts[2].trim().length === 2 ? '20' + parts[2].trim() : parts[2].trim();
        return `${y}${m}${d}`;
    }
    return null;
}

async function fetchSheetEventsAsIcs() {
    try {
        const response = await axios.get(sheetUrl, { timeout: 10000 });
        const records = parse(response.data, { skip_empty_lines: true });

        console.log("Total records fetched:", records.length);
        console.log("Header row:", records[3]);

        let matchedCount = 0;

        for (let i = 4; i < Math.min(20, records.length); i++) {
            const row = records[i];
            const id = row[0] ? String(row[0]).trim() : '';
            const title = row[1] ? String(row[1]).trim() : '';
            
            console.log(`Row ${i}: id="${id}", title="${title}" FIni="${row[14]}" FFin="${row[15]}"`);
            
            if (id && /^\\d+\\.\\d+$/.test(id) && title) {
                matchedCount++;
            }
        }
        console.log("Matched events:", matchedCount);
    } catch (error) {
        console.error("Error:", error.message);
    }
}

fetchSheetEventsAsIcs();
