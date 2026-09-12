const fs = require('fs-extra');
const path = require('path');

const ARCHIVE_ROOT = process.env.ARCHIVE_ROOT || path.resolve(__dirname, '../../../artifacts/archive');
const INPUT_DIR = process.env.INPUT_DIR || path.resolve(__dirname, '../../../fixtures/美甲图案');
const ARCHIVE_SRC = path.join(ARCHIVE_ROOT, 'SKU-20260220-104108', '1');
const NEW_DEST = path.join(INPUT_DIR, '1');

async function restore() {
    if (fs.existsSync(ARCHIVE_SRC)) {
        console.log(`Restoring ${ARCHIVE_SRC} to ${NEW_DEST}...`);
        await fs.copy(ARCHIVE_SRC, NEW_DEST);
        console.log('Restoration complete.');
    } else {
        console.error(`Source ${ARCHIVE_SRC} not found!`);
    }
}

restore();
