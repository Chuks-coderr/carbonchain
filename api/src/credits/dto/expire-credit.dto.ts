import { IsString, IsNotEmpty, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ExpireCreditDto {
  @ApiProperty({
    example: 'admin-reason-expired-vintage',
    description: 'Reason for expiring the credit (e.g. vintage year passed)',
  })
  @IsString()
  @IsNotEmpty()
  reason: string;

  @ApiPropertyOptional({
    example: 'GABC...XYZ',
    description: 'Stellar public key of the admin performing the expiry',
  })
  @IsOptional()
  @IsString()
  adminPublicKey?: string;
}
