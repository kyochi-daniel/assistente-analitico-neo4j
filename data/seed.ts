import { seedDatabase } from './seedHelpers.ts';

if (!process.argv.includes('--reset') || !process.argv.includes('--confirm-dedicated-db')) {
  throw new Error('O seed APAGA sales-demo. Execute npm run seed -- --reset --confirm-dedicated-db somente no banco descartável.');
}
await seedDatabase(true);
