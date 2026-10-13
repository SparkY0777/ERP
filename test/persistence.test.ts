import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { NotFoundException } from '@nestjs/common';
import { NonRetryableMessageError, Outbox, OutboxDeadLetters, OutboxRelay } from '@nestjs/outbox';
import { PostgresOutboxStore } from '@nestjs/outbox/postgres';
import { count, eq } from 'drizzle-orm';
import { createApp } from '../src/app';
import { Database, Transaction } from '../src/shared/database';
import { SisFacade } from '../src/modules/sis';
import { StudentEnrolled } from '../src/modules/sis/contracts';
import { students } from '../src/modules/sis/schema';
import { FeesFacade } from '../src/modules/fees';
import { FeeStore } from '../src/modules/fees/handlers';
import { collections, enrolments } from '../src/modules/reporting/schema';

let app: Awaited<ReturnType<typeof createApp>>;

before(async () => {
  app = await createApp(false, { dataDir: 'memory://', relayEnabled: false });
  await app.init();
});
after(async () => { await app?.close(); });

test('student and outbox both roll back when event recording fails', async (t) => {
  const tenantId = randomUUID();
  const outbox = app.get(Outbox<Transaction>);
  const original = outbox.add.bind(outbox);
  t.mock.method(outbox, 'add', async (tx: Transaction, message: Parameters<typeof outbox.add>[1]) => {
    await original(tx, message);
    throw new Error('Simulated failure after outbox insert');
  });
  await assert.rejects(app.get(SisFacade).enrol(tenantId, 'Asha'), /Simulated failure/);
  const [result] = await app.get(Database).db.select({ total: count() }).from(students)
    .where(eq(students.tenantId, tenantId));
  assert.equal(result.total, 0);
  assert.equal((await app.get(OutboxRelay).stats()).pending, 0);
});

test('failed payment transaction rolls back balance, payment ID and outbox together', async (t) => {
  const tenantId = randomUUID();
  const student = await app.get(SisFacade).enrol(tenantId, 'Asha');
  await app.get(OutboxRelay).runOnce();
  const outbox = app.get(Outbox<Transaction>);
  const original = outbox.add.bind(outbox);
  const failure = t.mock.method(outbox, 'add', async (tx: Transaction, message: Parameters<typeof outbox.add>[1]) => {
    await original(tx, message);
    throw new Error('Simulated failure after payment event insert');
  });
  const paymentId = randomUUID();
  await assert.rejects(
    app.get(FeesFacade).recordPayment(tenantId, student.id, paymentId, 25_000), /Simulated failure/,
  );
  assert.equal((await app.get(FeesFacade).balance(tenantId, student.id)).paidMinor, 0);
  assert.equal((await app.get(OutboxRelay).stats()).pending, 0);
  failure.mock.restore();
  const paid = await app.get(FeesFacade).recordPayment(tenantId, student.id, paymentId, 25_000);
  assert.equal(paid.paidMinor, 25_000);
  await app.get(OutboxRelay).runOnce();
});

test('consumer failure rolls back its state and inbox; successful sibling remains committed', async (t) => {
  const tenantId = randomUUID();
  const student = await app.get(SisFacade).enrol(tenantId, 'Asha');
  const store = app.get(FeeStore);
  const original = store.open.bind(store);
  const failure = t.mock.method(store, 'open', async (tx: Transaction, tenant: string, id: string) => {
    await original(tx, tenant, id);
    throw new Error('Simulated consumer failure after account insert');
  });
  const result = await app.get(OutboxRelay).runOnce();
  assert.equal(result.retried, 1);
  await assert.rejects(app.get(FeesFacade).balance(tenantId, student.id), /Fee account not found/);
  const [projected] = await app.get(Database).db.select({ total: count() }).from(enrolments)
    .where(eq(enrolments.tenantId, tenantId));
  assert.equal(projected.total, 1);
  assert.equal((await app.get(OutboxRelay).stats()).pending, 1);
  failure.mock.restore();
  await delay(1100);
  assert.equal((await app.get(OutboxRelay).runOnce()).published, 1);
  assert.equal((await app.get(FeesFacade).balance(tenantId, student.id)).chargedMinor, 100_000);
  const [afterRetry] = await app.get(Database).db.select({ total: count() }).from(enrolments)
    .where(eq(enrolments.tenantId, tenantId));
  assert.equal(afterRetry.total, 1);
});

test('dead letters can be replayed without rerunning successful subscribers', async (t) => {
  const tenantId = randomUUID();
  const event = new StudentEnrolled(randomUUID(), tenantId, randomUUID(), 'Asha');
  await app.get(Database).db.transaction(async (tx) => {
    await app.get(Outbox<Transaction>).add(tx, { id: event.eventId, topic: StudentEnrolled.topic, payload: event });
  });
  const failure = t.mock.method(app.get(FeeStore), 'open', async () => {
    throw new NonRetryableMessageError('Operator repair required');
  });
  assert.equal((await app.get(OutboxRelay).runOnce()).deadLettered, 1);
  const inbox = app.get(PostgresOutboxStore);
  assert.equal(await inbox.hasInbox('fees.open-account.v1', event.eventId), false);
  assert.equal(await inbox.hasInbox('reporting.enrolments.v1', event.eventId), true);
  assert.ok(await app.get(OutboxDeadLetters).get(event.eventId));
  failure.mock.restore();
  assert.equal(await app.get(OutboxDeadLetters).requeue(event.eventId), 1);
  assert.equal((await app.get(OutboxRelay).runOnce()).published, 1);
  assert.equal(await inbox.hasInbox('fees.open-account.v1', event.eventId), true);
  assert.equal(await app.get(OutboxDeadLetters).get(event.eventId), undefined);
});

test('concurrent different payments cannot spend the same outstanding balance', async () => {
  const tenantId = randomUUID();
  const student = await app.get(SisFacade).enrol(tenantId, 'Asha');
  await app.get(OutboxRelay).runOnce();
  const results = await Promise.allSettled([
    app.get(FeesFacade).recordPayment(tenantId, student.id, randomUUID(), 60_000),
    app.get(FeesFacade).recordPayment(tenantId, student.id, randomUUID(), 60_000),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal((await app.get(FeesFacade).balance(tenantId, student.id)).paidMinor, 60_000);
  await app.get(OutboxRelay).runOnce();
});

test('automatic relay delivers committed events without manual draining', async (t) => {
  const automatic = await createApp(false, { dataDir: 'memory://', relayEnabled: true });
  t.after(() => automatic.close());
  await automatic.init();
  const tenantId = randomUUID();
  const student = await automatic.get(SisFacade).enrol(tenantId, 'Asha');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const balance = await automatic.get(FeesFacade).balance(tenantId, student.id);
      assert.equal(balance.chargedMinor, 100_000);
      const [projection] = await automatic.get(Database).db.select().from(enrolments)
        .where(eq(enrolments.tenantId, tenantId));
      if (projection) return;
    } catch (error) {
      if (!(error instanceof NotFoundException)) throw error;
    }
    await delay(25);
  }
  assert.fail('Automatic relay did not deliver enrolment within five seconds');
});

test('disk-backed restart retains students, balances, pending events and payment deduplication', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'erp-outbox-'));
  let current: Awaited<ReturnType<typeof createApp>> | undefined;
  t.after(async () => {
    await current?.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('erp-outbox-'));
    await rm(directory, { recursive: true, force: true });
  });
  async function restart() {
    await current?.close();
    current = undefined;
    current = await createApp(false, { dataDir: path.join(directory, 'nested', 'postgres'), relayEnabled: false });
    await current.init();
    return current;
  }
  const tenantId = randomUUID();
  let instance = await restart();
  const student = await instance.get(SisFacade).enrol(tenantId, 'Asha');
  assert.equal((await instance.get(OutboxRelay).stats()).pending, 1);
  await assert.rejects(instance.get(FeesFacade).balance(tenantId, student.id), /Fee account not found/);
  instance = await restart();
  assert.equal((await instance.get(OutboxRelay).runOnce()).published, 1);
  assert.equal((await instance.get(SisFacade).clearance(tenantId, student.id)).outstandingMinor, 100_000);
  const paymentId = randomUUID();
  await instance.get(FeesFacade).recordPayment(tenantId, student.id, paymentId, 25_000);
  instance = await restart();
  assert.equal((await instance.get(FeesFacade).balance(tenantId, student.id)).paidMinor, 25_000);
  assert.equal((await instance.get(OutboxRelay).stats()).pending, 1);
  assert.equal((await instance.get(OutboxRelay).runOnce()).published, 1);
  const [projection] = await instance.get(Database).db.select().from(collections)
    .where(eq(collections.tenantId, tenantId));
  assert.equal(projection.amountMinor, 25_000);
  await instance.get(FeesFacade).recordPayment(tenantId, student.id, paymentId, 25_000);
  assert.equal((await instance.get(FeesFacade).balance(tenantId, student.id)).paidMinor, 25_000);
  assert.equal((await instance.get(OutboxRelay).stats()).pending, 0);
});
