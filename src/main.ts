import { createApp } from './app';

async function bootstrap() {
  const app = await createApp();
  // shortcut: unauthenticated demo, keep loopback binding until authentication is added.
  try {
    await app.listen(3000, '127.0.0.1');
  } catch (error) {
    await app.close();
    throw error;
  }
}

bootstrap().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
