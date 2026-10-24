import { installDeno } from './shim.mjs';
installDeno();
await import('../src/server.js');
