import { PartialType } from '@nestjs/mapped-types';
import { CreateTreatmentSessionDto } from './create-treatment-session.dto';
import { IsEnum, IsOptional } from 'class-validator';

export class UpdateTreatmentSessionDto extends PartialType(CreateTreatmentSessionDto) {
  @IsEnum(['SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'])
  @IsOptional()
  status?: string;
}
