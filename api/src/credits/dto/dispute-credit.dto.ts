import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class DisputeCreditDto {
  @ApiProperty({
    example: 'bafybeihdwdcefgh...',
    description: 'IPFS CID of the evidence document supporting the dispute',
  })
  @IsString()
  @IsNotEmpty()
  evidenceIpfsHash: string;

  @ApiProperty({
    example: 'Satellite imagery shows deforestation in the project area',
    description: 'Human-readable reason for raising the dispute',
  })
  @IsString()
  @IsNotEmpty()
  reason: string;
}
