const path = require('node:path');
const { closeDatabase, initializeDatabase } = require('./database');
const { migrateLegacyFiles } = require('./storage');

async function main() {
  const dataFile = path.resolve(process.argv[2] || path.join(__dirname, 'data.json'));
  await initializeDatabase();
  const result = await migrateLegacyFiles(dataFile);
  console.log(`Imported shipments: ${result.importedShipments}`);
  console.log(`Skipped existing shipments: ${result.skippedShipments}`);
}

main().catch((error) => {
  console.error('Legacy file migration failed:', error.message);
  process.exitCode = 1;
}).finally(async () => {
  await closeDatabase();
});