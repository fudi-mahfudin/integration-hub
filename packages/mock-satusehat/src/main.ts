import { loadMockConfig } from './config.js';
import { startMock } from './server.js';

const mock = await startMock(loadMockConfig(process.env));
console.log(`mock SATUSEHAT listening on ${mock.baseUrl}`);

process.once('SIGTERM', () => {
  void mock.close().then(() => process.exit(0));
});
process.once('SIGINT', () => {
  void mock.close().then(() => process.exit(0));
});
