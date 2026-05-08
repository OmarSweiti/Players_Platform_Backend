import { IsString, IsOptional, IsNumber, IsUUID, IsDateString, Min, Max, IsEnum } from 'class-validator';
import { PlayerPosition } from '@prisma/client';

export class CreateScoutingReportDto {
  @IsUUID()
  playerId?: string;

  @IsString()
  @IsOptional()
  prospectName?: string;

  @IsNumber()
  @IsOptional()
  @Min(15)
  @Max(40)
  prospectAge?: number;

  @IsString()
  @IsOptional()
  prospectClub?: string;

  @IsEnum(PlayerPosition)
  @IsOptional()
  prospectPosition?: PlayerPosition;

  @IsString()
  @IsOptional()
  prospectNationality?: string;

  @IsEnum(['STRONG_SIGN', 'SIGN', 'MONITOR', 'NOT_SUITABLE'])
  @IsOptional()
  recommendation?: string;

  @IsNumber({ maxDecimalPlaces: 1 })
  @IsOptional()
  @Min(1)
  @Max(10)
  technicalScore?: number;

  @IsNumber({ maxDecimalPlaces: 1 })
  @IsOptional()
  @Min(1)
  @Max(10)
  physicalScore?: number;

  @IsNumber({ maxDecimalPlaces: 1 })
  @IsOptional()
  @Min(1)
  @Max(10)
  tacticalScore?: number;

  @IsNumber({ maxDecimalPlaces: 1 })
  @IsOptional()
  @Min(1)
  @Max(10)
  mentalScore?: number;

  @IsString()
  @IsOptional()
  strengths?: string;

  @IsString()
  @IsOptional()
  weaknesses?: string;

  @IsString()
  @IsOptional()
  personalityNotes?: string;

  @IsString()
  @IsOptional()
  tacticalFit?: string;

  @IsNumber({ maxDecimalPlaces: 1 })
  @IsOptional()
  @Min(1)
  @Max(10)
  overallRating?: number;

  @IsNumber({ maxDecimalPlaces: 1 })
  @IsOptional()
  @Min(1)
  @Max(10)
  potentialRating?: number;

  @IsString()
  @IsOptional()
  matchObserved?: string;
}
