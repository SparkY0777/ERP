import { randomUUID } from 'node:crypto';
import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { CommandHandler, ICommandHandler, IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { Outbox } from '@nestjs/outbox';
import { and, eq } from 'drizzle-orm';
import { FeesFacade } from '../fees';
import { Database, Transaction } from '../../shared/database';
import { EnrolStudent, GetClearance, StudentDto, StudentEnrolled } from './contracts';
import { initialMigration, students } from './schema';

@Injectable()
export class StudentStore implements OnModuleInit {
  constructor(private readonly database: Database) {}

  async onModuleInit() { await this.database.migrate('sis', 1, initialMigration); }

  async add(tx: Transaction, tenantId: string, name: string): Promise<StudentDto> {
    const student = { id: randomUUID(), name };
    await tx.insert(students).values({ tenantId, ...student });
    return student;
  }

  async get(tenantId: string, studentId: string): Promise<StudentDto> {
    const [student] = await this.database.db.select({ id: students.id, name: students.name })
      .from(students).where(and(eq(students.tenantId, tenantId), eq(students.id, studentId)));
    if (!student) throw new NotFoundException('Student not found');
    return student;
  }
}

@CommandHandler(EnrolStudent)
export class EnrolStudentHandler implements ICommandHandler<EnrolStudent> {
  constructor(
    private readonly store: StudentStore,
    private readonly database: Database,
    private readonly outbox: Outbox<Transaction>,
  ) {}

  async execute(command: EnrolStudent) {
    const name = command.name.trim();
    if (!name || name.length > 100) throw new BadRequestException('Name must contain 1-100 characters');
    const student = await this.database.db.transaction(async (tx) => {
      const result = await this.store.add(tx, command.tenantId, name);
      const event = new StudentEnrolled(randomUUID(), command.tenantId, result.id, result.name);
      await this.outbox.add(tx, {
        id: event.eventId, topic: StudentEnrolled.topic,
        key: `${command.tenantId}:${result.id}`.toLowerCase(), payload: event,
      });
      return result;
    });
    this.outbox.notify();
    return student;
  }
}

@QueryHandler(GetClearance)
export class GetClearanceHandler implements IQueryHandler<GetClearance> {
  constructor(private readonly store: StudentStore, private readonly fees: FeesFacade) {}

  async execute(query: GetClearance) {
    await this.store.get(query.tenantId, query.studentId);
    const account = await this.fees.balance(query.tenantId, query.studentId);
    return {
      studentId: query.studentId,
      outstandingMinor: account.outstandingMinor,
      eligible: account.outstandingMinor === 0,
    };
  }
}
