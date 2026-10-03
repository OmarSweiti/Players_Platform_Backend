import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';

export class AddToWatchlistDto {
  @IsUUID()
  playerId!: string;

  @IsEnum(['HIGH', 'MEDIUM', 'LOW'])
  @IsOptional()
  priority?: string;

  @IsString()
  @IsOptional()
  notes?: string;
}
