import { isUUID } from 'class-validator';
import { OutboxDeadLetters, OutboxRelay } from '@nestjs/outbox';
import { createApp } from './app';

async function main() {
  const command = process.argv[2] ?? 'status';
  const id = process.argv[3];
  if (!['status', 'drain', 'retry'].includes(command) ||
      (command === 'retry' && (!id || !isUUID(id))) ||
      (command !== 'retry' && id !== undefined) || process.argv.length > 4) {
    throw new Error('Usage: npm run outbox -- status | drain | retry <event-uuid>');
  }
  const app = await createApp(false, { relayEnabled: false });
  try {
    await app.init();
    const relay = app.get(OutboxRelay);
    const deadLetters = app.get(OutboxDeadLetters);
    if (command === 'status') {
      console.log(JSON.stringify({ stats: await relay.stats(), deadLetters: await deadLetters.list() }, null, 2));
    } else if (command === 'drain') {
      console.log(JSON.stringify(await relay.runOnce(), null, 2));
    } else {
      console.log(JSON.stringify({ requeued: await deadLetters.requeue(id!) }));
    }
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
