import { Module } from '@nestjs/common';
import { FeesModule } from '../fees';
import { SisController } from './controller';
import { SisFacade } from './facade';
import { EnrolStudentHandler, GetClearanceHandler, StudentStore } from './handlers';

@Module({
  imports: [FeesModule],
  controllers: [SisController],
  providers: [SisFacade, StudentStore, EnrolStudentHandler, GetClearanceHandler],
  exports: [SisFacade],
})
export class SisModule {}
