import { migrateData, dataDir } from './lib/storage.js';

const source = process.argv[2];
if (!source) {
  console.error('Usage: npm run migrate -- "/path/to/old/agent-art-world/data"');
  process.exitCode = 1;
} else {
  try {
    const result = await migrateData(source);
    console.log(`Copied experiment from ${result.source} to ${dataDir}. The old folder was not modified.`);
    console.log('Start the app normally to see your previous works and model assignments.');
  } catch (error) {
    console.error(`Migration failed: ${error.message}`);
    process.exitCode = 1;
  }
}
