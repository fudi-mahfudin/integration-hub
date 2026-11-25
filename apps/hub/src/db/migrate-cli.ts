import { loadConfig } from '../config.js';
import { runMigrations } from './migrate.js';

try {
  const results = await runMigrations(loadConfig(process.env).databaseUrl);
  for (const r of results) console.log(`${r.status}: ${r.migrationName}`);
  console.log(results.length === 0 ? 'migrate: schema already up to date' : 'migrate: done');
} catch (err) {
  console.error('migrate: failed', err);
  process.exitCode = 1;
}
