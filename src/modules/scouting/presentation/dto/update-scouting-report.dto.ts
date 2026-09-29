import { PartialType } from '@nestjs/mapped-types';
import { CreateScoutingReportDto } from './create-scouting-report.dto';
import { IsEnum, IsOptional } from 'class-validator';

export class UpdateScoutingReportDto extends PartialType(
  CreateScoutingReportDto,
) {
  @IsEnum(['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED'])
  @IsOptional()
  status?: string;
}
