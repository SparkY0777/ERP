import { Controller, Get, Injectable, InternalServerErrorException, Module, OnModuleInit, Param, ParseUUIDPipe } from '@nestjs/common';
import { OnOutboxMessage, OutboxHandlerContext } from '@nestjs/outbox';
import { count, eq, sql } from 'drizzle-orm';
import { StudentEnrolled } from '../sis/contracts';
import { PaymentRecorded } from '../fees/contracts';
import { Database, Transaction } from '../../shared/database';
import { collections, enrolments, initialMigration } from './schema';

@Injectable()
class ReportingStore implements OnModuleInit {
  constructor(private readonly database: Database) {}

  async onModuleInit() { await this.database.migrate('reporting', 1, initialMigration); }

  async enrolled(tx: Transaction, event: StudentEnrolled) {
    await tx.insert(enrolments).values({ tenantId: event.tenantId, studentId: event.studentId }).onConflictDoNothing();
  }

  async paid(tx: Transaction, event: PaymentRecorded) {
    await tx.insert(collections).values({
      tenantId: event.tenantId, paymentId: event.paymentId, amountMinor: event.amountMinor,
    }).onConflictDoNothing();
  }

  async summary(tenantId: string) {
    const [students] = await this.database.db.select({ total: count() }).from(enrolments)
      .where(eq(enrolments.tenantId, tenantId));
    const [payments] = await this.database.db.select({
      total: count(), collected: sql`coalesce(sum(${collections.amountMinor}), 0)`.mapWith(Number),
    }).from(collections).where(eq(collections.tenantId, tenantId));
    if (!Number.isSafeInteger(payments.collected)) throw new InternalServerErrorException('Reporting total exceeds safe integer range');
    return {
      enrolledStudents: students.total, recordedPayments: payments.total,
      collectedMinor: payments.collected, currency: 'INR',
    };
  }
}

@Injectable()
class ProjectEnrolment {
  constructor(private readonly store: ReportingStore, private readonly database: Database) {}

  @OnOutboxMessage(StudentEnrolled.topic, { consumer: 'reporting.enrolments.v1' })
  async handle(event: StudentEnrolled, context: OutboxHandlerContext<Transaction>) {
    await this.database.db.transaction(async (tx) => {
      await context.processInTransaction(tx, () => this.store.enrolled(tx, event));
    });
  }
}

@Injectable()
class ProjectPayment {
  constructor(private readonly store: ReportingStore, private readonly database: Database) {}

  @OnOutboxMessage(PaymentRecorded.topic, { consumer: 'reporting.collections.v1' })
  async handle(event: PaymentRecorded, context: OutboxHandlerContext<Transaction>) {
    await this.database.db.transaction(async (tx) => {
      await context.processInTransaction(tx, () => this.store.paid(tx, event));
    });
  }
}

@Controller('tenants/:tenantId/reports')
class ReportingController {
  constructor(private readonly store: ReportingStore) {}

  @Get('summary')
  summary(@Param('tenantId', ParseUUIDPipe) tenantId: string) { return this.store.summary(tenantId); }
}

@Module({
  controllers: [ReportingController],
  providers: [ReportingStore, ProjectEnrolment, ProjectPayment],
})
export class ReportingModule {}
