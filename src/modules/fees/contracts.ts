import { Command, Query } from '@nestjs/cqrs';

export interface FeeAccountDto {
  studentId: string;
  currency: 'INR';
  chargedMinor: number;
  paidMinor: number;
  outstandingMinor: number;
}

export class GetBalance extends Query<FeeAccountDto> {
  constructor(public readonly tenantId: string, public readonly studentId: string) {
    super();
  }
}

export class RecordPayment extends Command<FeeAccountDto> {
  constructor(
    public readonly tenantId: string,
    public readonly studentId: string,
    public readonly paymentId: string,
    public readonly amountMinor: number,
  ) {
    super();
  }
}

export class PaymentRecorded {
  static readonly topic = 'fees.payment.recorded.v1';
  constructor(
    public readonly eventId: string,
    public readonly tenantId: string,
    public readonly studentId: string,
    public readonly paymentId: string,
    public readonly amountMinor: number,
  ) {}
}
