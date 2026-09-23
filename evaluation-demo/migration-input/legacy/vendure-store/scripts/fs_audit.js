const fs = require('fs-extra');
const path = require('path');

const NEW_DIR = process.env.INPUT_DIR || path.resolve(__dirname, '../../../fixtures/美甲图案');
const EFFECT_DIR = path.join(NEW_DIR, '1');

console.log('--- Evaluation input audit ---');
if (fs.existsSync(NEW_DIR)) {
    const entries = fs.readdirSync(NEW_DIR);
    console.log(`Files in ${NEW_DIR}:`);
    console.log(entries.join(', '));
}

if (fs.existsSync(EFFECT_DIR)) {
    console.log(`\nFiles in ${EFFECT_DIR}:`);
    const effectFiles = fs.readdirSync(EFFECT_DIR);
    console.log(effectFiles.join(', '));
} else {
    console.log(`\n${EFFECT_DIR} does not exist.`);
}
