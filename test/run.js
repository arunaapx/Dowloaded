// Every app-side suite, run in one go.
//
//   npm test
//
// These cover the parts that decide whether someone paid: which machine this
// is, and where the licence lives. They need nothing installed.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const suites = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort();
let failed = 0;
for (const suite of suites) {
  console.log('─'.repeat(64));
  console.log(suite);
  console.log('─'.repeat(64));
  const r = spawnSync(process.execPath, [path.join(__dirname, suite)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
  console.log('');
}
if (failed) {
  console.log(`${failed} of ${suites.length} suites FAILED`);
  process.exit(1);
}
console.log(`all ${suites.length} suites passed`);
