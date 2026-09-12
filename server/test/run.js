// Runs every suite in this folder and sums the results.
//
//   npm test
//   VELOX_TEST_BASE=http://127.0.0.1:4011 npm test
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const suites = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort();
const target = process.env.VELOX_TEST_BASE || 'a throwaway Node server';
console.log(`Running ${suites.length} suites against ${target}\n`);

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
