import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  UseGuards,
  DefaultValuePipe,
  ParseIntPipe,
  Request,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiBearerAuth,
  ApiBody,
} from '@nestjs/swagger';
import { CreditsService, IssueCreditDto } from './credits.service';
import { CreditMetadata } from '../shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PageResult } from './credit.repository';
import { ExpireCreditDto } from './dto/expire-credit.dto';
import { DisputeCreditDto } from './dto/dispute-credit.dto';
import { ResolveDisputeDto } from './dto/resolve-dispute.dto';
import { BatchStatusTransitionDto } from './dto/batch-status-transition.dto';

@ApiTags('credits')
@Controller('credits')
export class CreditsController {
  constructor(private readonly creditsService: CreditsService) {}

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /credits/issue
  // ─────────────────────────────────────────────────────────────────────────────

  @ApiOperation({
    summary: 'Issue a new carbon credit',
    description:
      'Submit a new carbon credit issuance request. The credit is persisted in the off-chain index with Pending status until a verifier approves it on-chain.',
  })
  @ApiBearerAuth()
  @ApiBody({ type: IssueCreditDto })
  @ApiResponse({
    status: 201,
    description: 'Credit issued successfully. Returns the new credit ID.',
    schema: { example: { creditId: 'abc123def456...' } },
  })
  @ApiResponse({ status: 400, description: 'Invalid request body or validation error.' })
  @ApiResponse({ status: 401, description: 'Unauthorized — valid JWT required.' })
  @UseGuards(JwtAuthGuard)
  @Post('issue')
  issueCredit(@Body() dto: IssueCreditDto): Promise<{ creditId: string }> {
    return this.creditsService.issueCredit(dto);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /credits/bulk
  // ─────────────────────────────────────────────────────────────────────────────

  @ApiOperation({
    summary: 'Fetch multiple credits by ID in one request',
    description:
      'Returns metadata for up to 100 credits. Credits not found are silently skipped.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          example: ['abc123', 'def456'],
          description: 'Array of credit IDs to fetch (max 100)',
        },
      },
      required: ['ids'],
    },
  })
  @ApiResponse({
    status: 201,
    description: 'Array of credit metadata objects for each found credit.',
  })
  @ApiResponse({ status: 400, description: 'Empty array or more than 100 IDs provided.' })
  @Post('bulk')
  async getBulkCredits(
    @Body() dto: { ids: string[] },
  ): Promise<CreditMetadata[]> {
    return this.creditsService.getBulkCredits(dto.ids);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /credits/batch-transition  (#1106)
  // ─────────────────────────────────────────────────────────────────────────────

  @ApiOperation({
    summary: 'Batch expire or dispute multiple credits (admin only)',
    description:
      'Processes each credit sequentially. Returns separate succeeded and failed arrays (partial success mode). ' +
      'Use action="expire" for vintage-year sweeps or action="dispute" with evidenceIpfsHash for bulk disputes.',
  })
  @ApiBearerAuth()
  @ApiBody({ type: BatchStatusTransitionDto })
  @ApiResponse({
    status: 201,
    description: 'Batch transition complete. Returns succeeded and failed arrays.',
    schema: {
      example: {
        succeeded: ['credit-id-1', 'credit-id-2'],
        failed: [{ creditId: 'credit-id-3', error: 'Credit credit-id-3 not found' }],
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Invalid request body or missing evidenceIpfsHash for dispute action.' })
  @ApiResponse({ status: 401, description: 'Unauthorized — valid JWT required.' })
  @UseGuards(JwtAuthGuard)
  @Post('batch-transition')
  async batchTransitionCredits(
    @Body() dto: BatchStatusTransitionDto,
    @Request() req: any,
  ): Promise<{
    succeeded: string[];
    failed: Array<{ creditId: string; error: string }>;
  }> {
    return this.creditsService.batchTransitionCredits(dto, req.user.account);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // GET /credits
  // ─────────────────────────────────────────────────────────────────────────────

  @ApiOperation({
    summary: 'List credits with optional filters and pagination',
    description:
      'Returns a paginated list of credits. Defaults to Active credits when no status filter is provided. ' +
      'Supports filtering by methodology, geography, vintage year, status, and tonnes range.',
  })
  @ApiQuery({
    name: 'methodology',
    required: false,
    description: 'Filter by methodology (e.g. VCS, REDD+, Gold Standard)',
    example: 'VCS',
  })
  @ApiQuery({
    name: 'geography',
    required: false,
    description: 'Filter by ISO 3166-1 alpha-2 country code',
    example: 'NG',
  })
  @ApiQuery({
    name: 'vintage_year',
    required: false,
    description: 'Filter by vintage year (e.g. 2024)',
    example: '2024',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    description: 'Filter by credit status: Active, Pending, Retired, Flagged, Expired, Disputed',
    example: 'Active',
  })
  @ApiQuery({
    name: 'min_tonnes',
    required: false,
    description: 'Minimum tonnes value (inclusive), expressed in credit units (1 tonne = 1,000,000 units)',
    example: '1000000',
  })
  @ApiQuery({
    name: 'max_tonnes',
    required: false,
    description: 'Maximum tonnes value (inclusive), expressed in credit units',
    example: '100000000',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    description: 'Page number (1-based)',
    example: '1',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Number of results per page (default 10)',
    example: '10',
  })
  @ApiResponse({
    status: 200,
    description: 'Paginated list of credits matching the filters.',
    schema: {
      example: {
        data: [{ id: 'abc123', status: 'Active', tonnes: '1000000', methodology: 'VCS' }],
        total: 42,
        page: 1,
        limit: 10,
      },
    },
  })
  @Get()
  async listCredits(
    @Query('methodology') methodology?: string,
    @Query('geography') geography?: string,
    @Query('vintage_year') vintageYear?: string,
    @Query('status') status?: string,
    @Query('min_tonnes') minTonnes?: string,
    @Query('max_tonnes') maxTonnes?: string,
    @Query('page') page: string = '1',
    @Query('limit') limit: string = '10',
  ): Promise<{
    data: CreditMetadata[];
    total: number;
    page: number;
    limit: number;
  }> {
    return this.creditsService.listCredits({
      methodology,
      geography,
      vintageYear: vintageYear ? parseInt(vintageYear, 10) : undefined,
      status,
      minTonnes,
      maxTonnes,
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // GET /credits/verifier/:address/pending-count  (#1105)
  // ─────────────────────────────────────────────────────────────────────────────

  @ApiOperation({
    summary: 'Get pending credit count for a verifier',
    description:
      'Returns the number of credits in Pending status awaiting verifier approval. ' +
      'Cached with a 30-second TTL for live dashboard use.',
  })
  @ApiParam({
    name: 'address',
    description: 'Stellar public key of the verifier',
    example: 'GABC...XYZ',
  })
  @ApiResponse({
    status: 200,
    description: 'Pending credit count for the verifier.',
    schema: {
      example: { address: 'GABC...XYZ', pendingCount: 7 },
    },
  })
  @ApiResponse({ status: 404, description: 'Verifier address not found.' })
  @Get('verifier/:address/pending-count')
  async getVerifierPendingCount(
    @Param('address') address: string,
  ): Promise<{ address: string; pendingCount: number }> {
    return this.creditsService.getVerifierPendingCount(address);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // GET /credits/:id
  // ─────────────────────────────────────────────────────────────────────────────

  @ApiOperation({
    summary: 'Get a single credit by ID',
    description:
      'Returns full credit metadata. Checks the Redis cache first, then the off-chain index, then falls back to on-chain contract read.',
  })
  @ApiParam({ name: 'id', description: 'Hex-encoded credit ID', example: 'abc123def456' })
  @ApiResponse({ status: 200, description: 'Credit metadata.' })
  @ApiResponse({ status: 404, description: 'Credit not found.' })
  @Get(':id')
  async getCredit(@Param('id') id: string): Promise<CreditMetadata> {
    return this.creditsService.getCredit(id);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // GET /credits/:id/provenance
  // ─────────────────────────────────────────────────────────────────────────────

  @ApiOperation({
    summary: 'Get full lifecycle provenance of a credit',
    description:
      'Returns all lifecycle events for a credit in chronological order: submitted → approved → transferred → retired/flagged.',
  })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', description: 'Hex-encoded credit ID', example: 'abc123def456' })
  @ApiResponse({
    status: 200,
    description: 'Ordered array of lifecycle events.',
    schema: {
      example: [
        { action: 'Submitted', actor: 'GABC...', timestamp: 1700000000, txHash: 'tx123' },
        { action: 'Approved', actor: 'GVFY...', timestamp: 1700001000, txHash: 'tx456' },
      ],
    },
  })
  @ApiResponse({ status: 401, description: 'Unauthorized — valid JWT required.' })
  @ApiResponse({ status: 404, description: 'Credit not found or provenance unavailable.' })
  @UseGuards(JwtAuthGuard)
  @Get(':id/provenance')
  async getCreditProvenance(
    @Param('id') creditId: string,
  ): Promise<Array<{
    action: string;
    actor: string;
    timestamp: number;
    txHash: string;
  }>> {
    return this.creditsService.getCreditProvenance(creditId);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // GET /credits/project/:projectId
  // ─────────────────────────────────────────────────────────────────────────────

  @ApiOperation({
    summary: 'List credits by project ID',
    description: 'Returns the IDs of all credits associated with the given project.',
  })
  @ApiParam({ name: 'projectId', description: 'Project identifier', example: 'PROJ-001' })
  @ApiQuery({ name: 'page', required: false, description: 'Page number (1-based)', example: '1' })
  @ApiQuery({ name: 'limit', required: false, description: 'Results per page', example: '20' })
  @ApiResponse({
    status: 200,
    description: 'Array of credit IDs for the project.',
    schema: { example: ['abc123', 'def456'] },
  })
  @ApiResponse({ status: 404, description: 'Project not found.' })
  @Get('project/:projectId')
  async listByProject(
    @Param('projectId') projectId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) _page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) _limit: number,
  ): Promise<string[]> {
    return this.creditsService.listCreditsByProject(projectId);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /credits/:id/transfer
  // ─────────────────────────────────────────────────────────────────────────────

  @ApiOperation({
    summary: 'Transfer a credit to another address',
    description:
      'Transfers ownership of an Active credit to a new Stellar address. Caller must be the current owner.',
  })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', description: 'Hex-encoded credit ID', example: 'abc123def456' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: { to: { type: 'string', example: 'GDEST...XYZ', description: 'Recipient Stellar public key' } },
      required: ['to'],
    },
  })
  @ApiResponse({ status: 201, description: 'Credit transferred. Returns updated credit metadata.' })
  @ApiResponse({ status: 400, description: 'Credit is not in Active status.' })
  @ApiResponse({ status: 401, description: 'Unauthorized — valid JWT required.' })
  @ApiResponse({ status: 404, description: 'Credit not found.' })
  @UseGuards(JwtAuthGuard)
  @Post(':id/transfer')
  async transferCredit(
    @Param('id') creditId: string,
    @Body() dto: { to: string },
    @Request() req: any,
  ): Promise<CreditMetadata> {
    return this.creditsService.transferCredit(creditId, dto.to, req.user.account);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /credits/:id/split
  // ─────────────────────────────────────────────────────────────────────────────

  @ApiOperation({
    summary: 'Split a credit into two child credits',
    description:
      'Splits an Active credit into two child credits. The parent credit is retired. ' +
      'splitTonnes must be a multiple of MIN_CREDIT_UNIT (100,000) and must be less than the credit\'s total tonnes.',
  })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', description: 'Hex-encoded credit ID to split', example: 'abc123def456' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        splitTonnes: {
          type: 'number',
          example: 500000,
          description: 'Tonnes for the first child credit (must be multiple of 100,000 and < parent tonnes)',
        },
      },
      required: ['splitTonnes'],
    },
  })
  @ApiResponse({
    status: 201,
    description: 'Credit split successfully. Returns IDs of both child credits.',
    schema: { example: { childCredit1: 'abc123-split-1', childCredit2: 'abc123-split-2' } },
  })
  @ApiResponse({ status: 400, description: 'splitTonnes is not a valid multiple or exceeds parent tonnes.' })
  @ApiResponse({ status: 401, description: 'Unauthorized — valid JWT required.' })
  @ApiResponse({ status: 404, description: 'Credit not found.' })
  @UseGuards(JwtAuthGuard)
  @Post(':id/split')
  async splitCredit(
    @Param('id') creditId: string,
    @Body() dto: { splitTonnes: number },
    @Request() req: any,
  ): Promise<{ childCredit1: string; childCredit2: string }> {
    return this.creditsService.splitCredit(creditId, dto.splitTonnes, req.user.account);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /credits/:id/expire  (#1103)
  // ─────────────────────────────────────────────────────────────────────────────

  @ApiOperation({
    summary: 'Expire a credit (admin only)',
    description:
      'Transitions an Active or Pending credit to Expired status. ' +
      'Only administrators may expire credits. Already Retired, Flagged, or Expired credits return 400.',
  })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', description: 'Hex-encoded credit ID', example: 'abc123def456' })
  @ApiBody({ type: ExpireCreditDto })
  @ApiResponse({
    status: 201,
    description: 'Credit expired successfully. Returns updated credit metadata.',
  })
  @ApiResponse({ status: 400, description: 'Credit is already in a terminal state (Retired, Flagged, or Expired).' })
  @ApiResponse({ status: 401, description: 'Unauthorized — valid JWT required.' })
  @ApiResponse({ status: 404, description: 'Credit not found.' })
  @UseGuards(JwtAuthGuard)
  @Post(':id/expire')
  async expireCredit(
    @Param('id') creditId: string,
    @Body() dto: ExpireCreditDto,
  ): Promise<CreditMetadata> {
    return this.creditsService.expireCredit(creditId, dto);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /credits/:id/dispute  (#1103)
  // ─────────────────────────────────────────────────────────────────────────────

  @ApiOperation({
    summary: 'Raise a dispute on a credit',
    description:
      'Transitions an Active credit to Disputed status. ' +
      'The caller must be the credit owner or a registered verifier. ' +
      'Evidence IPFS hash is stored and retrievable via GET /credits/:id.',
  })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', description: 'Hex-encoded credit ID', example: 'abc123def456' })
  @ApiBody({ type: DisputeCreditDto })
  @ApiResponse({
    status: 201,
    description: 'Credit disputed successfully. Returns updated credit metadata with evidenceIpfsHash stored.',
  })
  @ApiResponse({ status: 400, description: 'Credit is already Retired or Disputed.' })
  @ApiResponse({ status: 401, description: 'Unauthorized — valid JWT required.' })
  @ApiResponse({ status: 403, description: 'Forbidden — caller is not the owner or a registered verifier.' })
  @ApiResponse({ status: 404, description: 'Credit not found.' })
  @UseGuards(JwtAuthGuard)
  @Post(':id/dispute')
  async disputeCredit(
    @Param('id') creditId: string,
    @Body() dto: DisputeCreditDto,
    @Request() req: any,
  ): Promise<CreditMetadata> {
    return this.creditsService.disputeCredit(creditId, dto, req.user.account);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /credits/:id/resolve-dispute  (#1103)
  // ─────────────────────────────────────────────────────────────────────────────

  @ApiOperation({
    summary: 'Resolve a dispute on a credit (admin only)',
    description:
      'Resolves a Disputed credit. Outcome codes: 0 = reinstate to Active, 1 = Flag, 2 = Retire. ' +
      'Only administrators may resolve disputes. Non-Disputed credits return 400.',
  })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', description: 'Hex-encoded credit ID', example: 'abc123def456' })
  @ApiBody({ type: ResolveDisputeDto })
  @ApiResponse({
    status: 201,
    description: 'Dispute resolved. Returns updated credit metadata with new status.',
    schema: {
      example: { id: 'abc123', status: 'Active', tonnes: '1000000', methodology: 'VCS' },
    },
  })
  @ApiResponse({ status: 400, description: 'Credit is not in Disputed status, or invalid outcome code.' })
  @ApiResponse({ status: 401, description: 'Unauthorized — valid JWT required.' })
  @ApiResponse({ status: 404, description: 'Credit not found.' })
  @UseGuards(JwtAuthGuard)
  @Post(':id/resolve-dispute')
  async resolveDispute(
    @Param('id') creditId: string,
    @Body() dto: ResolveDisputeDto,
  ): Promise<CreditMetadata> {
    return this.creditsService.resolveDispute(creditId, dto);
  }
}
