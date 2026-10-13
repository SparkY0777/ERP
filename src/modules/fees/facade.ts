import { Injectable } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { GetBalance, RecordPayment } from './contracts';

@Injectable()
export class FeesFacade {
  constructor(private readonly commands: CommandBus, private readonly queries: QueryBus) {}

  balance(tenantId: string, studentId: string) {
    return this.queries.execute(new GetBalance(tenantId, studentId));
  }

  recordPayment(tenantId: string, studentId: string, paymentId: string, amountMinor: number) {
    return this.commands.execute(new RecordPayment(tenantId, studentId, paymentId, amountMinor));
  }
}
