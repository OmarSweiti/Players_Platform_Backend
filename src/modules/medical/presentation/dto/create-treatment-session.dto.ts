import {
  IsString,
  IsOptional,
  IsUUID,
  IsDateString,
  IsEnum,
  IsNumber,
  Min,
  Max,
} from 'class-validator';

export class CreateTreatmentSessionDto {
  @IsUUID()
  playerId!: string;

  @IsUUID()
  @IsOptional()
  medicalRecordId?: string;

  @IsDateString()
  sessionDate!: string;

  @IsNumber()
  @IsOptional()
  @Min(15)
  @Max(480)
  duration?: number;

  @IsEnum(['SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'])
  @IsOptional()
  status?: string;

  @IsString()
  treatmentType!: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @IsOptional()
  exercises?: string;

  @IsString()
  @IsOptional()
  progressNotes?: string;
}
