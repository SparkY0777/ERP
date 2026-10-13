import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Outbox, OutboxRelay } from '@nestjs/outbox';
import { createApp } from '../src/app';
import { StudentEnrolled } from '../src/modules/sis/contracts';
import { FeesFacade } from '../src/modules/fees';
import { Database, Transaction } from '../src/shared/database';

let app: Awaited<ReturnType<typeof createApp>>;
let base: string;

before(async () => {
  app = await createApp(false, { dataDir: 'memory://', relayEnabled: false });
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});

after(async () => { await app?.close(); });

async function request(path: string, body?: unknown, expected = 200) {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  assert.equal(response.status, expected, JSON.stringify(result));
  if (response.ok && body !== undefined) {
    const result = await app.get(OutboxRelay).runOnce();
    assert.equal(result.retried, 0);
    assert.equal(result.deadLettered, 0);
  }
  return result;
}

async function enrol(tenantId: string) {
  return request(`/tenants/${tenantId}/students`, { name: '  Asha  ' }, 201);
}

test('enrolment fans out to Fees and Reporting; payment updates cross-module clearance', async () => {
  const tenantId = randomUUID();
  const student = await enrol(tenantId);
  assert.equal(student.name, 'Asha');
  const feesPath = `/tenants/${tenantId}/fees/${student.id}`;
  const clearancePath = `/tenants/${tenantId}/students/${student.id}/clearance`;
  assert.deepEqual(await request(clearancePath), {
    studentId: student.id, outstandingMinor: 100_000, eligible: false,
  });
  const paid = await request(`${feesPath}/payments`, { paymentId: randomUUID(), amountMinor: 100_000 }, 201);
  assert.equal(paid.outstandingMinor, 0);
  assert.equal((await request(clearancePath)).eligible, true);
  assert.deepEqual(await request(`/tenants/${tenantId}/reports/summary`), {
    enrolledStudents: 1, recordedPayments: 1, collectedMinor: 100_000, currency: 'INR',
  });
});

test('retrying the same payment does not charge or publish twice', async () => {
  const tenantId = randomUUID();
  const student = await enrol(tenantId);
  const path = `/tenants/${tenantId}/fees/${student.id}/payments`;
  const payment = { paymentId: randomUUID(), amountMinor: 25_000 };
  const results = await Promise.all([request(path, payment, 201), request(path, payment, 201)]);
  for (const result of results) assert.equal(result.paidMinor, 25_000);
  const summary = await request(`/tenants/${tenantId}/reports/summary`);
  assert.equal(summary.recordedPayments, 1);
  assert.equal(summary.collectedMinor, 25_000);
  const uppercaseRetry = await request(
    `/tenants/${tenantId.toUpperCase()}/fees/${student.id.toUpperCase()}/payments`,
    { ...payment, paymentId: payment.paymentId.toUpperCase() }, 201,
  );
  assert.equal(uppercaseRetry.paidMinor, 25_000);
  await request(path, { ...payment, amountMinor: 30_000 }, 409);
});

test('payment IDs cannot be reused for another student in the same tenant', async () => {
  const tenantId = randomUUID();
  const first = await enrol(tenantId);
  const second = await enrol(tenantId);
  const payment = { paymentId: randomUUID(), amountMinor: 10_000 };
  await request(`/tenants/${tenantId}/fees/${first.id}/payments`, payment, 201);
  await request(`/tenants/${tenantId}/fees/${second.id}/payments`, payment, 409);
  assert.equal((await request(`/tenants/${tenantId}/fees/${second.id}`)).paidMinor, 0);
});

test('overpayment is rejected without changing the account or projection', async () => {
  const tenantId = randomUUID();
  const student = await enrol(tenantId);
  const path = `/tenants/${tenantId}/fees/${student.id}`;
  await request(`${path}/payments`, { paymentId: randomUUID(), amountMinor: 100_001 }, 409);
  assert.equal((await request(path)).paidMinor, 0);
  assert.equal((await request(`/tenants/${tenantId}/reports/summary`)).recordedPayments, 0);
});

test('HTTP validation rejects malformed IDs, empty names, unknown fields and invalid money', async () => {
  const tenantId = randomUUID();
  await request(`/tenants/${tenantId}/students`, { name: '   ' }, 400);
  await request(`/tenants/${tenantId}/students`, { name: 'Asha', admin: true }, 400);
  await request('/tenants/not-a-uuid/students', { name: 'Asha' }, 400);
  const student = await enrol(tenantId);
  const path = `/tenants/${tenantId}/fees/${student.id}/payments`;
  for (const amountMinor of [0, -1, 0.5, '100', Number.MAX_SAFE_INTEGER + 1]) {
    await request(path, { paymentId: randomUUID(), amountMinor }, 400);
  }
  await request(path, { paymentId: 'invalid', amountMinor: 100 }, 400);
  assert.equal((await request(`/tenants/${tenantId}/fees/${student.id}`)).paidMinor, 0);
});

test('commands enforce money invariants even when HTTP validation is bypassed', async () => {
  const tenantId = randomUUID();
  const student = await enrol(tenantId);
  await assert.rejects(
    app.get(FeesFacade).recordPayment(tenantId, student.id, randomUUID(), 0.5),
    { message: 'amountMinor must be a positive safe integer' },
  );
});

test('tenant keys isolate student records, fees, reports and payment IDs', async () => {
  const firstTenant = randomUUID();
  const secondTenant = randomUUID();
  const first = await enrol(firstTenant);
  await request(`/tenants/${secondTenant}/fees/${first.id}`, undefined, 404);
  await request(`/tenants/${secondTenant}/students/${first.id}/clearance`, undefined, 404);
  await request(`/tenants/${secondTenant}/fees/${first.id}/payments`, {
    paymentId: randomUUID(), amountMinor: 100,
  }, 404);
  assert.equal((await request(`/tenants/${secondTenant}/reports/summary`)).enrolledStudents, 0);
  const second = await enrol(secondTenant);
  const payment = { paymentId: randomUUID(), amountMinor: 100 };
  await request(`/tenants/${firstTenant}/fees/${first.id}/payments`, payment, 201);
  await request(`/tenants/${secondTenant}/fees/${second.id}/payments`, payment, 201);
  assert.equal((await request(`/tenants/${firstTenant}/reports/summary`)).collectedMinor, 100);
  assert.equal((await request(`/tenants/${secondTenant}/reports/summary`)).collectedMinor, 100);
});

test('replaying enrolment does not reset Fees or count the student twice', async () => {
  const tenantId = randomUUID();
  const student = await enrol(tenantId);
  await request(`/tenants/${tenantId}/fees/${student.id}/payments`, {
    paymentId: randomUUID(), amountMinor: 10_000,
  }, 201);
  const event = new StudentEnrolled(randomUUID(), tenantId, student.id, student.name);
  for (let replay = 0; replay < 2; replay++) {
    await app.get(Database).db.transaction(async (tx) => {
      await app.get(Outbox<Transaction>).add(tx, {
        topic: StudentEnrolled.topic, payload: event,
      });
    });
    await app.get(OutboxRelay).runOnce();
  }
  assert.equal((await request(`/tenants/${tenantId}/fees/${student.id}`)).paidMinor, 10_000);
  assert.equal((await request(`/tenants/${tenantId}/reports/summary`)).enrolledStudents, 1);
});

test('missing students and accounts are errors, never a zero balance', async () => {
  const tenantId = randomUUID();
  const studentId = randomUUID();
  await request(`/tenants/${tenantId}/students/${studentId}/clearance`, undefined, 404);
  await request(`/tenants/${tenantId}/fees/${studentId}`, undefined, 404);
});
