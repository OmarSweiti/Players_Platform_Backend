import { PartialType } from '@nestjs/mapped-types';
import { CreateAssignmentDto } from './create-assignment.dto';
import { IsEnum, IsOptional } from 'class-validator';

export class UpdateAssignmentDto extends PartialType(CreateAssignmentDto) {
  @IsEnum(['OPEN', 'IN_PROGRESS', 'COMPLETED'])
  @IsOptional()
  status?: string;
}
