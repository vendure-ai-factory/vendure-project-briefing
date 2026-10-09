const fs = require('fs-extra');
const path = require('path');

const ARCHIVE_ROOT = process.env.ARCHIVE_ROOT || path.resolve(__dirname, '../../../artifacts/archive')
const BATCH_DIR = path.join(ARCHIVE_ROOT, 'BATCH-1771583630984');

try {
    const all = fs.readdirSync(BATCH_DIR);
    console.log(`Contents of ${BATCH_DIR}:`);
    for (const f of all) {
        const stat = fs.statSync(path.join(BATCH_DIR, f));
        console.log(` - ${f} (${stat.isDirectory() ? 'DIR' : 'FILE'})`);
    }
} catch (e) {
    console.error(e.message);
}
