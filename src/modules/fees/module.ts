import { Module } from '@nestjs/common';
import { FeesController } from './controller';
import { FeesFacade } from './facade';
import { FeeStore, GetBalanceHandler, OpenAccountOnEnrolment, RecordPaymentHandler } from './handlers';

@Module({
  controllers: [FeesController],
  providers: [FeesFacade, FeeStore, OpenAccountOnEnrolment, GetBalanceHandler, RecordPaymentHandler],
  exports: [FeesFacade],
})
export class FeesModule {}
