import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { CommandHandler, ICommandHandler, IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { OnOutboxMessage, Outbox, OutboxHandlerContext } from '@nestjs/outbox';
import { and, eq } from 'drizzle-orm';
import { StudentEnrolled } from '../sis/contracts';
import { Database, Transaction } from '../../shared/database';
import { FeeAccountDto, GetBalance, PaymentRecorded, RecordPayment } from './contracts';
import { accounts, initialMigration, payments } from './schema';

@Injectable()
export class FeeStore implements OnModuleInit {
  constructor(private readonly database: Database) {}

  async onModuleInit() { await this.database.migrate('fees', 1, initialMigration); }

  async open(tx: Transaction, tenantId: string, studentId: string) {
    // shortcut: fixed INR 1,000 demo charge, replace with fee-plan rules for real schools.
    await tx.insert(accounts).values({ tenantId, studentId, chargedMinor: 100_000 }).onConflictDoNothing();
  }

  async get(tenantId: string, studentId: string, tx?: Transaction): Promise<FeeAccountDto> {
    const query = (tx ?? this.database.db).select({
      studentId: accounts.studentId, chargedMinor: accounts.chargedMinor, paidMinor: accounts.paidMinor,
    }).from(accounts).where(and(eq(accounts.tenantId, tenantId), eq(accounts.studentId, studentId)));
    const [account] = await (tx ? query.for('update') : query);
    if (!account) throw new NotFoundException('Fee account not found');
    return { ...account, currency: 'INR', outstandingMinor: account.chargedMinor - account.paidMinor };
  }

  async pay(tx: Transaction, command: RecordPayment): Promise<boolean> {
    if (!Number.isSafeInteger(command.amountMinor) || command.amountMinor <= 0) {
      throw new BadRequestException('amountMinor must be a positive safe integer');
    }
    const balance = await this.get(command.tenantId, command.studentId, tx);
    const identity = and(eq(payments.tenantId, command.tenantId), eq(payments.paymentId, command.paymentId));
    const [previous] = await tx.select().from(payments).where(identity);
    if (previous) {
      this.checkRetry(previous, command);
      return false;
    }
    if (command.amountMinor > balance.outstandingMinor) throw new ConflictException('Payment exceeds outstanding balance');
    const inserted = await tx.insert(payments).values({
      tenantId: command.tenantId, studentId: command.studentId,
      paymentId: command.paymentId, amountMinor: command.amountMinor,
    }).onConflictDoNothing().returning();
    if (!inserted.length) {
      const [concurrent] = await tx.select().from(payments).where(identity);
      this.checkRetry(concurrent, command);
      return false;
    }
    await tx.update(accounts).set({ paidMinor: balance.paidMinor + command.amountMinor })
      .where(and(eq(accounts.tenantId, command.tenantId), eq(accounts.studentId, command.studentId)));
    return true;
  }

  private checkRetry(previous: { studentId: string; amountMinor: number }, command: RecordPayment) {
    if (previous.studentId !== command.studentId.toLowerCase() || previous.amountMinor !== command.amountMinor) {
      throw new ConflictException('paymentId already used with different payment details');
    }
  }
}

@Injectable()
export class OpenAccountOnEnrolment {
  constructor(private readonly store: FeeStore, private readonly database: Database) {}

  @OnOutboxMessage(StudentEnrolled.topic, { consumer: 'fees.open-account.v1' })
  async handle(event: StudentEnrolled, context: OutboxHandlerContext<Transaction>) {
    await this.database.db.transaction(async (tx) => {
      await context.processInTransaction(tx, () => this.store.open(tx, event.tenantId, event.studentId));
    });
  }
}

@QueryHandler(GetBalance)
export class GetBalanceHandler implements IQueryHandler<GetBalance> {
  constructor(private readonly store: FeeStore) {}
  async execute(query: GetBalance) { return this.store.get(query.tenantId, query.studentId); }
}

@CommandHandler(RecordPayment)
export class RecordPaymentHandler implements ICommandHandler<RecordPayment> {
  constructor(
    private readonly store: FeeStore,
    private readonly database: Database,
    private readonly outbox: Outbox<Transaction>,
  ) {}

  async execute(command: RecordPayment) {
    const result = await this.database.db.transaction(async (tx) => {
      if (await this.store.pay(tx, command)) {
        const event = new PaymentRecorded(
          randomUUID(), command.tenantId, command.studentId, command.paymentId, command.amountMinor,
        );
        await this.outbox.add(tx, {
          id: event.eventId, topic: PaymentRecorded.topic,
          key: `${command.tenantId}:${command.studentId}`.toLowerCase(), payload: event,
        });
      }
      return this.store.get(command.tenantId, command.studentId, tx);
    });
    this.outbox.notify();
    return result;
  }
}
