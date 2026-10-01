const assert = require('assert');
const path = require('path');
const { parseTeamLeadersFromCsv, normalizePhoneNumber } = require('./csv_leader_parser');

console.log('🧪 Running CSV Leader Parser Tests...\n');

// Test 1: Phone number normalization
console.log('Test 1: normalizePhoneNumber()');
assert.strictEqual(normalizePhoneNumber('917498748705'), '917498748705', 'Already 12-digit should stay same');
assert.strictEqual(normalizePhoneNumber('+91 74987-48705'), '917498748705', 'Formatted string should strip chars and plus');
assert.strictEqual(normalizePhoneNumber('7498748705'), '917498748705', '10-digit number should prepend 91');
assert.strictEqual(normalizePhoneNumber('12345'), null, 'Short number should return null');
assert.strictEqual(normalizePhoneNumber(''), null, 'Empty string should return null');
console.log('✅ Test 1 passed!\n');

// Test 2: In-memory CSV parsing and filtering
console.log('Test 2: parseTeamLeadersFromCsv() with mock content');
const mockCsv = `Team ID,Team Name,Candidate role,Candidate's Name,Candidate's Mobile
T01,Alpha,Team Leader,Alice Smith,919876543210
T01,Alpha,Team Member,Bob Jones,919876543211
T02,Beta,team leader,Charlie Brown,9876543212
T03,Gamma,Leader,Diana Prince,+91 9876543213
T04,Delta,Volunteer,Eve Adams,919876543214
`;

const leaders = parseTeamLeadersFromCsv(mockCsv);
assert.strictEqual(leaders.length, 3, 'Should extract only 3 leaders (Alice, Charlie, Diana)');
assert.strictEqual(leaders[0].name, 'Alice Smith');
assert.strictEqual(leaders[0].number, '919876543210');
assert.strictEqual(leaders[0].teamName, 'Alpha');
assert.strictEqual(leaders[0].wid, '919876543210@c.us');

assert.strictEqual(leaders[1].name, 'Charlie Brown');
assert.strictEqual(leaders[1].number, '919876543212'); // prepended 91

assert.strictEqual(leaders[2].name, 'Diana Prince');
assert.strictEqual(leaders[2].number, '919876543213');
console.log('✅ Test 2 passed!\n');

// Test 3: Deduplication
console.log('Test 3: Deduplication of duplicate mobile numbers');
const duplicateCsv = `Candidate role,Candidate's Name,Mobile
Team Leader,Alice,919876543210
Team Leader,Alice Duplicate,919876543210
`;
const deduplicated = parseTeamLeadersFromCsv(duplicateCsv);
assert.strictEqual(deduplicated.length, 1, 'Duplicate mobile numbers should be deduplicated');
console.log('✅ Test 3 passed!\n');

console.log('🎉 All Unit Tests Passed Successfully!');
