import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { SisFacade } from './facade';

class EnrolStudentBody {
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;
}

@Controller('tenants/:tenantId/students')
export class SisController {
  constructor(private readonly sis: SisFacade) {}

  @Post()
  enrol(@Param('tenantId', ParseUUIDPipe) tenantId: string, @Body() body: EnrolStudentBody) {
    return this.sis.enrol(tenantId, body.name);
  }

  @Get(':studentId/clearance')
  clearance(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('studentId', ParseUUIDPipe) studentId: string,
  ) {
    return this.sis.clearance(tenantId, studentId);
  }
}
