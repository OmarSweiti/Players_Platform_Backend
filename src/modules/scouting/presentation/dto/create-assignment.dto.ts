import {
  IsString,
  IsOptional,
  IsNumber,
  IsUUID,
  IsDateString,
  IsEnum,
  Min,
  Max,
} from 'class-validator';
import { PlayerPosition } from '@prisma/client';

export class CreateAssignmentDto {
  @IsUUID()
  assignedToId!: string;

  @IsString()
  @IsOptional()
  region?: string;

  @IsString()
  @IsOptional()
  competition?: string;

  @IsEnum(PlayerPosition)
  @IsOptional()
  targetPosition?: PlayerPosition;

  @IsNumber()
  @IsOptional()
  @Min(15)
  @Max(40)
  minAge?: number;

  @IsNumber()
  @IsOptional()
  @Min(15)
  @Max(40)
  maxAge?: number;

  @IsDateString()
  @IsOptional()
  dueDate?: string;

  @IsString()
  @IsOptional()
  notes?: string;
}
