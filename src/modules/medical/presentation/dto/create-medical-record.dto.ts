import {
  IsString,
  IsOptional,
  IsBoolean,
  IsUUID,
  IsDateString,
} from 'class-validator';

export class CreateMedicalRecordDto {
  @IsUUID()
  playerId: string;

  @IsString()
  injuryType: string;

  @IsString()
  @IsOptional()
  bodyPart?: string;

  @IsString()
  @IsOptional()
  severity?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @IsOptional()
  treatment?: string;

  @IsDateString()
  @IsOptional()
  injuryDate?: string;

  @IsDateString()
  @IsOptional()
  recoveryDate?: string;

  @IsDateString()
  @IsOptional()
  returnToPlayDate?: string;

  @IsBoolean()
  @IsOptional()
  isConfidential?: boolean;
}
