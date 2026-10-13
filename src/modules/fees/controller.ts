import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { IsInt, IsUUID, Max, Min } from 'class-validator';
import { FeesFacade } from './facade';

class PaymentBody {
  @IsUUID()
  paymentId!: string;

  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  amountMinor!: number;
}

@Controller('tenants/:tenantId/fees/:studentId')
export class FeesController {
  constructor(private readonly fees: FeesFacade) {}

  @Get()
  balance(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('studentId', ParseUUIDPipe) studentId: string,
  ) {
    return this.fees.balance(tenantId, studentId);
  }

  @Post('payments')
  pay(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Body() body: PaymentBody,
  ) {
    return this.fees.recordPayment(tenantId, studentId, body.paymentId, body.amountMinor);
  }
}
