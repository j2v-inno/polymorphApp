import 'dotenv/config';
import { createApp } from './app.js';
import { config } from './config.js';

const app = createApp();

app.listen(config.port, () => {
  console.log(`transapp backend listening on :${config.port}`);
});
