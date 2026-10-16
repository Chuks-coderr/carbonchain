import { IsInt, Min, Max } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Outcome codes for resolving a dispute:
 *  0 — Reinstate to Active
 *  1 — Flag the credit
 *  2 — Retire the credit
 */
export class ResolveDisputeDto {
  @ApiProperty({
    example: 0,
    description:
      'Resolution outcome: 0 = reinstate to Active, 1 = Flag the credit, 2 = Retire the credit',
    minimum: 0,
    maximum: 2,
  })
  @IsInt()
  @Min(0)
  @Max(2)
  outcome: number;
}
