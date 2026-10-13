import { Injectable } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { EnrolStudent, GetClearance } from './contracts';

@Injectable()
export class SisFacade {
  constructor(private readonly commands: CommandBus, private readonly queries: QueryBus) {}

  enrol(tenantId: string, name: string) {
    return this.commands.execute(new EnrolStudent(tenantId, name));
  }

  clearance(tenantId: string, studentId: string) {
    return this.queries.execute(new GetClearance(tenantId, studentId));
  }
}
