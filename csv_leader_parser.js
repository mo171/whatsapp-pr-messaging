const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

/**
 * Normalizes phone numbers into E.164 digits without leading '+'.
 * Automatically prepends '91' (India) for 10-digit numbers.
 * @param {string|number} raw 
 * @returns {string|null} Cleaned phone number or null if invalid
 */
function normalizePhoneNumber(raw) {
    if (!raw) return null;
    let cleaned = String(raw).replace(/\D/g, '');
    if (!cleaned) return null;

    if (cleaned.length === 10) {
        cleaned = '91' + cleaned;
    }

    if (cleaned.length < 11 || cleaned.length > 15) {
        return null;
    }

    return cleaned;
}

/**
 * Finds the best matching column name from a list of record keys.
 * @param {string[]} headers 
 * @param {string[]} candidates 
 * @returns {string|null}
 */
function findColumn(headers, candidates) {
    for (const cand of candidates) {
        const found = headers.find(h => h.trim().toLowerCase() === cand.toLowerCase());
        if (found) return found;
    }
    for (const cand of candidates) {
        const found = headers.find(h => h.trim().toLowerCase().includes(cand.toLowerCase()));
        if (found) return found;
    }
    return null;
}

/**
 * Parses Team Leaders from CSV content or file path.
 * Filters for rows where the candidate role is 'Team Leader' (or contains 'leader').
 * 
 * @param {string} input CSV string content or path to a .csv file
 * @returns {Array<{ name: string, number: string, wid: string, teamName: string, role: string, originalRow: Object }>}
 */
function parseTeamLeadersFromCsv(input) {
    let content = input;
    if (typeof input === 'string' && (input.endsWith('.csv') || fs.existsSync(input))) {
        content = fs.readFileSync(input, 'utf8');
    }

    const records = parse(content, {
        columns: true,
        skip_empty_lines: true,
        trim: true
    });

    if (!records || records.length === 0) {
        return [];
    }

    const headers = Object.keys(records[0]);

    // Detect column mappings dynamically
    const roleCol = findColumn(headers, ['candidate role', 'role', 'candidate_role', 'designation']);
    const mobileCol = findColumn(headers, ["candidate's mobile", 'mobile', 'candidate mobile', 'phone', 'contact number', 'number']);
    const nameCol = findColumn(headers, ["candidate's name", 'name', 'candidate name', 'full name']);
    const teamCol = findColumn(headers, ['team name', 'team_name', 'team', 'team id']);

    const leaders = [];
    const seenNumbers = new Set();

    for (let i = 0; i < records.length; i++) {
        const row = records[i];
        const role = (roleCol && row[roleCol] ? String(row[roleCol]).trim() : '');
        
        // Check if role signifies a Team Leader (case-insensitive)
        const isLeader = role.toLowerCase().includes('leader');
        if (!isLeader) {
            continue;
        }

        const rawPhone = mobileCol && row[mobileCol] ? String(row[mobileCol]).trim() : '';
        const cleanedNumber = normalizePhoneNumber(rawPhone);

        if (!cleanedNumber) {
            console.warn(`⚠️  Row ${i + 1}: Skipping leader "${row[nameCol] || 'Unknown'}" with invalid phone: "${rawPhone}"`);
            continue;
        }

        if (seenNumbers.has(cleanedNumber)) {
            continue; // Deduplicate
        }
        seenNumbers.add(cleanedNumber);

        leaders.push({
            name: nameCol && row[nameCol] ? String(row[nameCol]).trim() : 'Participant',
            number: cleanedNumber,
            wid: `${cleanedNumber}@c.us`,
            teamName: teamCol && row[teamCol] ? String(row[teamCol]).trim() : '',
            role: role,
            originalRow: row
        });
    }

    return leaders;
}

module.exports = {
    normalizePhoneNumber,
    parseTeamLeadersFromCsv
};
