import 'dotenv/config';
import { createApp } from './app.js';
import { config } from './config.js';
import { startServerMonitor } from './monitor/hub.js';

startServerMonitor();
const app = createApp();

app.listen(config.port, () => {
  console.log(`transapp backend listening on :${config.port}`);
});
