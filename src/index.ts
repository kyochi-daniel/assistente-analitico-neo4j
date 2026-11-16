import { createServer } from './server.ts';

const app = createServer();
await app.listen({ port: 4000, host: '127.0.0.1' });
console.log('Servidor em http://127.0.0.1:4000');
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => { await app.close(); });
}
