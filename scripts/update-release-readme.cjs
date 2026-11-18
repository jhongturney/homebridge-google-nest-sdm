const assert = require('node:assert/strict');
const fs = require('node:fs');
const {OLD_VERSION, VERSION} = process.env;
assert.match(OLD_VERSION ?? '', /^\d+\.\d+\.\d+$/);
assert.match(VERSION ?? '', /^\d+\.\d+\.\d+$/);
const filename = 'README.md';
const readme = fs.readFileSync(filename, 'utf8');
const oldAsset = `/releases/download/v${OLD_VERSION}/homebridge-google-nest-sdm-${OLD_VERSION}.tgz`;
assert.ok(readme.includes(oldAsset), 'README installation link must match the current version');
const updated = readme.replaceAll(oldAsset, `/releases/download/v${VERSION}/homebridge-google-nest-sdm-${VERSION}.tgz`)
    .replaceAll(`plugin version \`${OLD_VERSION}\``, `plugin version \`${VERSION}\``);
fs.writeFileSync(filename, updated);
