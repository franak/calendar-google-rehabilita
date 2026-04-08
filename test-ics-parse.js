require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const ical = require('ical.js');
const { parse } = require('csv-parse/sync');

const sheetUrl = process.env.SHEET_CSV_URL;
const ICS_SOURCE_URL = process.env.ICS_SOURCE_URL;

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

        const nowUtc = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
        let vevents = '';

        for (const row of records) {
            const id = row[0];
            const title = row[1];
            if (id && /^[\\d\\.]+$/.test(String(id).trim()) && title) {
                const startStr = row[14];
                const endStr = row[15];
                
                const startIcs = formatIcsDate(startStr);
                const endIcs = formatIcsDate(endStr);

                if (startIcs) {
                    const dtIcsEnd = endIcs || startIcs; 
                    const description = (row[2] || '') + (row[3] ? ' - ' + row[3] : '');
                    
                    vevents += `BEGIN:VEVENT\\r\\n`;
                    vevents += `UID:sheet-event-${String(id).trim().replace(/\\./g, '-')}\\r\\n`;
                    vevents += `DTSTAMP:${nowUtc}\\r\\n`;
                    vevents += `SUMMARY:${title}\\r\\n`;
                    if (description) vevents += `DESCRIPTION:${description}\\r\\n`;
                    vevents += `DTSTART;VALUE=DATE:${startIcs}\\r\\n`;
                    vevents += `DTEND;VALUE=DATE:${dtIcsEnd}\\r\\n`;
                    vevents += `END:VEVENT\\r\\n`;
                }
            }
        }
        return vevents;
    } catch (error) {
        console.error(`Error sheet: ${error.message}`);
        return '';
    }
}

async function run() {
    const res = await axios.get(ICS_SOURCE_URL);
    let ic = res.data;
    const sheetEvents = await fetchSheetEventsAsIcs();
    if(sheetEvents) {
        ic = ic.replace('END:VCALENDAR', sheetEvents + 'END:VCALENDAR');
    }
    
    fs.writeFileSync('TEST_COMBINED.ics', ic);
    console.log("Written TEST_COMBINED.ics");
    try {
        ical.parse(ic);
        console.log("Parse OK!");
    } catch(e) {
        console.error("Parse Error:", e.message);
        console.log("Last 500 chars of ics: ");
        console.log(ic.slice(-500));
    }
}
run();
