import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';

export class QueryScoutingReportsDto {
  @IsEnum(['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED'])
  @IsOptional()
  status?: string;

  @IsUUID()
  @IsOptional()
  scoutId?: string;

  @IsUUID()
  @IsOptional()
  playerId?: string;

  @IsEnum(['STRONG_SIGN', 'SIGN', 'MONITOR', 'NOT_SUITABLE'])
  @IsOptional()
  recommendation?: string;

  @IsString()
  @IsOptional()
  dateFrom?: string;

  @IsString()
  @IsOptional()
  dateTo?: string;

  @IsOptional()
  page?: number = 1;

  @IsOptional()
  limit?: number = 20;
}
