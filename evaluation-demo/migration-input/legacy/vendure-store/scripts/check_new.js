const fs = require('fs-extra');
const path = require('path');

const NEW_DIR = process.env.INPUT_DIR || path.resolve(__dirname, '../../../fixtures/美甲图案');

try {
    const all = fs.readdirSync(NEW_DIR);
    console.log(`Contents of ${NEW_DIR}:`);
    for (const f of all) {
        const stat = fs.statSync(path.join(NEW_DIR, f));
        console.log(` - ${f} (${stat.isDirectory() ? 'DIR' : 'FILE'})`);
    }
} catch (e) {
    console.error(e.message);
}
