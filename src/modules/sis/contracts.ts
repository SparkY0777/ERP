import { Command, Query } from '@nestjs/cqrs';

export interface StudentDto {
  id: string;
  name: string;
}

export interface ClearanceDto {
  studentId: string;
  outstandingMinor: number;
  eligible: boolean;
}

export class EnrolStudent extends Command<StudentDto> {
  constructor(public readonly tenantId: string, public readonly name: string) {
    super();
  }
}

export class GetClearance extends Query<ClearanceDto> {
  constructor(public readonly tenantId: string, public readonly studentId: string) {
    super();
  }
}

export class StudentEnrolled {
  static readonly topic = 'sis.student.enrolled.v1';
  constructor(
    public readonly eventId: string,
    public readonly tenantId: string,
    public readonly studentId: string,
    public readonly name: string,
  ) {}
}
