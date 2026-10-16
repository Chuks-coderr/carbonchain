/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StellarService } from '../stellar/stellar.service';
import { StellarKeypairService } from '../stellar/stellar-keypair.service';
import { scValToNative, nativeToScVal } from '@stellar/stellar-sdk';
import { CreditMetadata, CreditStatus } from '../shared';
import { CreditEntity } from './credit.entity';
import type { ICreditRepository, PageResult } from './credit.repository';
import { CREDIT_REPOSITORY } from './credit.repository';
import { CacheService } from '../common/cache.service';
import { ExpireCreditDto } from './dto/expire-credit.dto';
import { DisputeCreditDto } from './dto/dispute-credit.dto';
import { ResolveDisputeDto } from './dto/resolve-dispute.dto';
import { BatchStatusTransitionDto } from './dto/batch-status-transition.dto';

// Cache key helpers
const CREDIT_KEY = (id: string) => `credits:${id}`;
const LIST_CREDITS_KEY = (filter: string) => `credits:list:${filter}`;
const PENDING_COUNT_KEY = (address: string) =>
  `credits:verifier:${address}:pending-count`;
const CREDIT_TTL = 120; // seconds
const PENDING_COUNT_TTL = 30; // seconds — short TTL for live dashboard data

export class IssueCreditDto {
  issuerPublicKey: string;
  projectId: string;
  vintageYear: number;
  methodology: string;
  geography: string;
  tonnes: string;
  ipfsHash: string;
}

interface ListCreditsFilter {
  methodology?: string;
  geography?: string;
  vintageYear?: number;
  status?: string;
  minTonnes?: string;
  maxTonnes?: string;
  page: number;
  limit: number;
}

@Injectable()
export class CreditsService {
  private readonly logger = new Logger(CreditsService.name);
  private readonly contractId: string;
  private creditsCache: Map<string, CreditMetadata> = new Map();

  constructor(
    private stellarService: StellarService,
    private configService: ConfigService,
    private keypairService: StellarKeypairService,
    @Inject(CREDIT_REPOSITORY) private readonly creditRepo: ICreditRepository,
    private readonly cache: CacheService,
  ) {
    this.contractId =
      this.configService.get<string>('CREDIT_REGISTRY_CONTRACT_ID') || '';
  }

  async issueCredit(dto: IssueCreditDto): Promise<{ creditId: string }> {
    this.logger.log(`Issuing credit for project ${dto.projectId}`);
    const args = [
      nativeToScVal(dto.issuerPublicKey, { type: 'address' }),
      nativeToScVal(dto.projectId, { type: 'string' }),
      nativeToScVal(dto.vintageYear, { type: 'u32' }),
      nativeToScVal(dto.methodology, { type: 'string' }),
      nativeToScVal(dto.geography, { type: 'string' }),
      nativeToScVal(BigInt(dto.tonnes), { type: 'i128' }),
      nativeToScVal(dto.ipfsHash, { type: 'string' }),
    ];
    const signer = this.keypairService.getAdminKeypair();
    const response = await this.stellarService.invokeContract(
      this.contractId,
      'submit_credit',
      args,
      signer,
    );
    const rv = (response as unknown as Record<string, unknown>).returnValue;
    const creditId = rv
      ? Buffer.from(
          scValToNative(
            rv as Parameters<typeof scValToNative>[0],
          ) as Uint8Array,
        ).toString('hex')
      : 'unknown';

    // Persist to off-chain index
    const entity = new CreditEntity();
    entity.id = creditId;
    entity.projectId = dto.projectId;
    entity.issuer = dto.issuerPublicKey;
    entity.vintageYear = dto.vintageYear;
    entity.methodology = dto.methodology;
    entity.geography = dto.geography;
    entity.tonnes = dto.tonnes;
    entity.ipfsHash = dto.ipfsHash;
    entity.status = CreditStatus.Pending;
    entity.issuedAt = Math.floor(Date.now() / 1000);
    await this.creditRepo.save(entity);

    return { creditId };
  }

  async getCredit(creditId: string): Promise<CreditMetadata> {
    // 1. Try Redis cache
    const cached = await this.cache.get<CreditMetadata>(CREDIT_KEY(creditId));
    if (cached) {
      this.logger.debug(`Cache HIT for credit ${creditId}`);
      return cached;
    }

    // 2. Try off-chain index
    const indexed = await this.creditRepo.findById(creditId);
    if (indexed) {
      const metadata = this.entityToMetadata(indexed);
      await this.cache.set(CREDIT_KEY(creditId), metadata, CREDIT_TTL);
      return metadata;
    }

    // 3. Fall back to on-chain read
    try {
      this.logger.log(`Fetching credit metadata for ID: ${creditId}`);
      const args = [
        nativeToScVal(Buffer.from(creditId, 'hex'), { type: 'bytes' }),
      ];
      const retval = await this.stellarService.readContract(
        this.contractId,
        'get_credit',
        args,
      );
      if (!retval)
        throw new NotFoundException(
          `Credit with ID ${creditId} not found on-chain`,
        );
      const native = scValToNative(retval);
      const metadata = this.mapToCreditMetadata(creditId, native);
      await this.cache.set(CREDIT_KEY(creditId), metadata, CREDIT_TTL);
      return metadata;
    } catch (error: unknown) {
      this.logger.error(
        `Failed to fetch credit ${creditId}: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  async getBulkCredits(creditIds: string[]): Promise<CreditMetadata[]> {
    if (!creditIds || creditIds.length === 0) {
      throw new BadRequestException('Credit IDs array cannot be empty');
    }
    if (creditIds.length > 100) {
      throw new BadRequestException('Maximum 100 credits per bulk request');
    }

    this.logger.log(`Fetching ${creditIds.length} credits in bulk`);
    const results: CreditMetadata[] = [];

    for (const creditId of creditIds) {
      try {
        const credit = await this.getCredit(creditId);
        results.push(credit);
      } catch (error: unknown) {
        this.logger.warn(
          `Failed to fetch credit ${creditId}: ${(error as Error).message}`,
        );
      }
    }

    return results;
  }

  async listCredits(filter: ListCreditsFilter): Promise<{
    data: CreditMetadata[];
    total: number;
    page: number;
    limit: number;
  }> {
    // Default to Active-only when no status is requested, so Retired and Flagged
    // credits are never included unless the caller explicitly opts in.
    const effectiveStatus: string = filter.status ?? CreditStatus.Active;
    const effectiveFilter = { ...filter, status: effectiveStatus };

    // Default to Active when client does not provide a status filter
    if (!filter.status) {
      filter.status = CreditStatus.Active;
    }

    const cacheKey = LIST_CREDITS_KEY(JSON.stringify(filter));
    const cachedResult = await this.cache.get<{
      data: CreditMetadata[];
      total: number;
      page: number;
      limit: number;
    }>(cacheKey);
    if (cachedResult) {
      this.logger.debug(`Cache HIT for list credits`);
      return cachedResult;
    }

    // Fetch all credits from the off-chain repository and map to metadata.
    // Use a large limit to retrieve the full index for server-side filtering.
    let allCredits: CreditMetadata[] = [];
    try {
      const repoResult = await this.creditRepo.findAll(1, 1000000);
      allCredits = repoResult.data.map((e) => this.entityToMetadata(e));
    } catch (err) {
      this.logger.warn(
        `Failed to fetch credits from repo: ${(err as Error).message}`,
      );
      allCredits = [];
    }

    // Apply secondary filters
    let filtered = allCredits;

    if (filter.status) {
      filtered = filtered.filter((c) => c.status === filter.status);
    }

    if (filter.methodology) {
      filtered = filtered.filter(
        (c) =>
          c.methodology.toLowerCase() === filter.methodology!.toLowerCase(),
      );
    }

    if (filter.geography) {
      filtered = filtered.filter(
        (c) => c.geography.toLowerCase() === filter.geography!.toLowerCase(),
      );
    }

    if (filter.vintageYear) {
      filtered = filtered.filter((c) => c.vintage_year === filter.vintageYear);
    }

    if (filter.minTonnes) {
      const minVal = BigInt(filter.minTonnes);
      filtered = filtered.filter((c) => BigInt(c.tonnes) >= minVal);
    }

    if (filter.maxTonnes) {
      const maxVal = BigInt(filter.maxTonnes);
      filtered = filtered.filter((c) => BigInt(c.tonnes) <= maxVal);
    }

    const total = filtered.length;
    const start = (filter.page - 1) * filter.limit;
    const data = filtered.slice(start, start + filter.limit);

    const result = { data, total, page: filter.page, limit: filter.limit };
    await this.cache.set(cacheKey, result, CREDIT_TTL);
    return result;
  }

  /**
   * Get the full lifecycle/provenance of a credit including all lifecycle events.
   * Returns ordered events showing submit → approval → transfers → retirement.
   */
  async getCreditProvenance(creditId: string): Promise<Array<{
    action: string;
    actor: string;
    timestamp: number;
    txHash: string;
  }>> {
    this.logger.log(`Fetching provenance for credit ${creditId}`);

    try {
      // Fetch all events from the credit registry contract
      const events = await this.stellarService.getContractEvents(
        this.contractId,
      );

      const creditIdHex = creditId.toLowerCase();
      const provenanceEvents: Array<{
        action: string;
        actor: string;
        timestamp: number;
        txHash: string;
        ledger: number; // for sorting
      }> = [];

      for (const event of events) {
        const eventType = this.parseEventType(event);
        const topics = event.topic || [];
        const data = event.value || {};

        // Map events to provenance records
        if (eventType === 'CreditSubmitted') {
          const creditIdData = data.credit_id as string | undefined;
          if (creditIdData && creditIdData.toLowerCase().includes(creditIdHex)) {
            provenanceEvents.push({
              action: 'Submitted',
              actor: String(data.issuer || 'unknown'),
              timestamp: this.parseEventTimestamp(event),
              txHash: event.txHash || '',
              ledger: event.ledger || 0,
            });
          }
        } else if (eventType === 'CreditMinted') {
          const creditIdData = data.id as string | undefined;
          if (creditIdData && creditIdData.toLowerCase().includes(creditIdHex)) {
            provenanceEvents.push({
              action: 'Approved',
              actor: String(data.verifier || 'unknown'),
              timestamp: this.parseEventTimestamp(event),
              txHash: event.txHash || '',
              ledger: event.ledger || 0,
            });
          }
        } else if (eventType === 'CreditTransferred') {
          const creditIdData = data.credit_id as string | undefined;
          if (creditIdData && creditIdData.toLowerCase().includes(creditIdHex)) {
            provenanceEvents.push({
              action: 'Transferred',
              actor: String(data.from || 'unknown'),
              timestamp: this.parseEventTimestamp(event),
              txHash: event.txHash || '',
              ledger: event.ledger || 0,
            });
          }
        } else if (eventType === 'CreditRetired') {
          // CreditRetired events come from retirement contract
          const creditIdData = data.credit_id as string | undefined;
          if (creditIdData && creditIdData.toLowerCase().includes(creditIdHex)) {
            provenanceEvents.push({
              action: 'Retired',
              actor: String(data.buyer || 'unknown'),
              timestamp: this.parseEventTimestamp(event),
              txHash: event.txHash || '',
              ledger: event.ledger || 0,
            });
          }
        } else if (eventType === 'CreditFlagged') {
          const creditIdData = data.id as string | undefined;
          if (creditIdData && creditIdData.toLowerCase().includes(creditIdHex)) {
            provenanceEvents.push({
              action: 'Flagged',
              actor: 'system',
              timestamp: this.parseEventTimestamp(event),
              txHash: event.txHash || '',
              ledger: event.ledger || 0,
            });
          }
        }
      }

      // Sort by ledger (timestamp) to maintain chronological order
      provenanceEvents.sort((a, b) => a.ledger - b.ledger);

      // Remove the temporary ledger field before returning
      return provenanceEvents.map(({ ledger, ...rest }) => rest);
    } catch (error: unknown) {
      this.logger.error(
        `Failed to fetch provenance for credit ${creditId}: ${(error as Error).message}`,
      );
      throw new NotFoundException(
        `Could not retrieve provenance for credit ${creditId}`,
      );
    }
  }

  /**
   * Expire a credit (admin-only). Transitions Active → Expired.
   * #1103
   */
  async expireCredit(
    creditId: string,
    dto: ExpireCreditDto,
  ): Promise<CreditMetadata> {
    this.logger.log(`Expiring credit ${creditId}`);
    const entity = await this.creditRepo.findById(creditId);
    if (!entity) {
      throw new NotFoundException(`Credit ${creditId} not found`);
    }

    const nonExpirableStatuses: CreditStatus[] = [
      CreditStatus.Retired,
      CreditStatus.Flagged,
      CreditStatus.Expired,
    ];
    if (nonExpirableStatuses.includes(entity.status)) {
      throw new BadRequestException(
        `Credit ${creditId} cannot be expired — current status: ${entity.status}`,
      );
    }

    entity.status = CreditStatus.Expired;
    await this.creditRepo.save(entity);
    await this.invalidateCreditCache(creditId);

    const metadata = this.entityToMetadata(entity);
    this.logger.log(`Credit ${creditId} expired. Reason: ${dto.reason}`);
    return metadata;
  }

  /**
   * Raise a dispute on a credit. Transitions Active → Disputed.
   * Only the issuer (owner) or a verifier role may call this.
   * #1103
   */
  async disputeCredit(
    creditId: string,
    dto: DisputeCreditDto,
    callerPublicKey: string,
  ): Promise<CreditMetadata> {
    this.logger.log(`Disputing credit ${creditId} by ${callerPublicKey}`);
    const entity = await this.creditRepo.findById(creditId);
    if (!entity) {
      throw new NotFoundException(`Credit ${creditId} not found`);
    }

    const nonDisputeStatuses: CreditStatus[] = [
      CreditStatus.Retired,
      CreditStatus.Disputed,
    ];
    if (nonDisputeStatuses.includes(entity.status)) {
      throw new BadRequestException(
        `Credit ${creditId} cannot be disputed — current status: ${entity.status}`,
      );
    }

    entity.status = CreditStatus.Disputed;
    // Store evidence hash on entity's ipfsHash field as dispute evidence
    entity.ipfsHash = dto.evidenceIpfsHash;
    await this.creditRepo.save(entity);
    await this.invalidateCreditCache(creditId);

    const metadata = this.entityToMetadata(entity);
    this.logger.log(
      `Credit ${creditId} disputed. Evidence: ${dto.evidenceIpfsHash}`,
    );
    return metadata;
  }

  /**
   * Resolve a dispute (admin-only). Transitions Disputed → Active | Flagged | Retired.
   * Outcome: 0 = Active, 1 = Flagged, 2 = Retired
   * #1103
   */
  async resolveDispute(
    creditId: string,
    dto: ResolveDisputeDto,
  ): Promise<CreditMetadata> {
    this.logger.log(
      `Resolving dispute for credit ${creditId} with outcome ${dto.outcome}`,
    );
    const entity = await this.creditRepo.findById(creditId);
    if (!entity) {
      throw new NotFoundException(`Credit ${creditId} not found`);
    }

    if (entity.status !== CreditStatus.Disputed) {
      throw new BadRequestException(
        `Credit ${creditId} is not in Disputed status — current status: ${entity.status}`,
      );
    }

    const outcomeMap: Record<number, CreditStatus> = {
      0: CreditStatus.Active,
      1: CreditStatus.Flagged,
      2: CreditStatus.Retired,
    };

    const newStatus = outcomeMap[dto.outcome];
    if (newStatus === undefined) {
      throw new BadRequestException(
        `Invalid outcome ${dto.outcome}. Must be 0 (Active), 1 (Flagged), or 2 (Retired)`,
      );
    }

    entity.status = newStatus;
    await this.creditRepo.save(entity);
    await this.invalidateCreditCache(creditId);

    const metadata = this.entityToMetadata(entity);
    this.logger.log(
      `Dispute resolved for credit ${creditId}: new status ${newStatus}`,
    );
    return metadata;
  }

  /**
   * Get the number of pending (unreviewed) credits for a given verifier address.
   * Cached with a short TTL (30 s) for live dashboard use.
   * #1105
   */
  async getVerifierPendingCount(
    verifierAddress: string,
  ): Promise<{ address: string; pendingCount: number }> {
    this.logger.log(
      `Getting pending credit count for verifier ${verifierAddress}`,
    );

    const cacheKey = PENDING_COUNT_KEY(verifierAddress);
    const cached = await this.cache.get<{
      address: string;
      pendingCount: number;
    }>(cacheKey);
    if (cached) {
      this.logger.debug(
        `Cache HIT for pending count of verifier ${verifierAddress}`,
      );
      return cached;
    }

    // Count all credits with Pending status from the off-chain index
    let pendingCount = 0;
    try {
      const result = await this.creditRepo.findByStatus(
        CreditStatus.Pending,
        1,
        1000000,
      );
      pendingCount = result.total;
    } catch (err) {
      this.logger.warn(
        `Failed to count pending credits: ${(err as Error).message}`,
      );
      pendingCount = 0;
    }

    const response = { address: verifierAddress, pendingCount };
    await this.cache.set(cacheKey, response, PENDING_COUNT_TTL);
    return response;
  }

  /**
   * Batch transition multiple credits to Expired or Disputed in one call.
   * Processes sequentially with partial-success mode (collect succeeded + failed).
   * Admin-only for expire; caller public key used for dispute.
   * #1106
   */
  async batchTransitionCredits(
    dto: BatchStatusTransitionDto,
    callerPublicKey: string,
  ): Promise<{
    succeeded: string[];
    failed: Array<{ creditId: string; error: string }>;
  }> {
    this.logger.log(
      `Batch transition: action=${dto.action} on ${dto.creditIds.length} credits`,
    );

    if (dto.action === 'dispute' && !dto.evidenceIpfsHash) {
      throw new BadRequestException(
        'evidenceIpfsHash is required for dispute action',
      );
    }

    const succeeded: string[] = [];
    const failed: Array<{ creditId: string; error: string }> = [];

    for (const creditId of dto.creditIds) {
      try {
        if (dto.action === 'expire') {
          await this.expireCredit(creditId, {
            reason: dto.reason ?? 'Batch expiry',
          });
        } else {
          await this.disputeCredit(
            creditId,
            {
              evidenceIpfsHash: dto.evidenceIpfsHash!,
              reason: dto.reason ?? 'Batch dispute',
            },
            callerPublicKey,
          );
        }
        succeeded.push(creditId);
      } catch (error: unknown) {
        failed.push({
          creditId,
          error: (error as Error).message,
        });
        this.logger.warn(
          `Batch transition failed for credit ${creditId}: ${(error as Error).message}`,
        );
      }
    }

    this.logger.log(
      `Batch transition complete: ${succeeded.length} succeeded, ${failed.length} failed`,
    );
    return { succeeded, failed };
  }

  /**
   * Invalidate all cached entries for a specific credit and the list cache.
   * Call this whenever a credit's status changes (approve, retire, flag).
   */
  async invalidateCreditCache(creditId: string): Promise<void> {
    await this.cache.del(CREDIT_KEY(creditId));
    await this.cache.delPattern('credits:list:*');
    this.logger.debug(`Cache invalidated for credit ${creditId}`);
  }

  async listCreditsByProject(projectId: string): Promise<string[]> {
    try {
      this.logger.log(`Listing credits for project: ${projectId}`);
      const args = [nativeToScVal(projectId, { type: 'string' })];
      const retval = await this.stellarService.readContract(
        this.contractId,
        'list_credits_by_project',
        args,
      );
      if (!retval) return [];
      const native = scValToNative(retval) as Buffer[];
      return native.map((buf) => buf.toString('hex'));
    } catch (error: unknown) {
      this.logger.error(
        `Failed to list credits for project ${projectId}: ${(error as Error).message}`,
      );
      return [];
    }
  }

  async transferCredit(
    creditId: string,
    to: string,
    callerPublicKey: string,
  ): Promise<CreditMetadata> {
    this.logger.log(
      `Transferring credit ${creditId} from ${callerPublicKey} to ${to}`,
    );
    const entity = await this.creditRepo.findById(creditId);
    if (!entity) {
      throw new NotFoundException(`Credit ${creditId} not found`);
    }
    if (entity.status !== CreditStatus.Active) {
      throw new BadRequestException(
        `Credit ${creditId} is not Active and cannot be transferred`,
      );
    }
    entity.issuer = to;
    await this.creditRepo.save(entity);
    await this.invalidateCreditCache(creditId);
    return this.entityToMetadata(entity);
  }

  async splitCredit(
    creditId: string,
    splitTonnes: number,
    callerPublicKey: string,
  ): Promise<{ childCredit1: string; childCredit2: string }> {
    this.logger.log(
      `Splitting credit ${creditId} with splitTonnes=${splitTonnes}`,
    );
    const entity = await this.creditRepo.findById(creditId);
    if (!entity) {
      throw new NotFoundException(`Credit ${creditId} not found`);
    }

    const MIN_CREDIT_UNIT = 100_000;
    const totalTonnes = Number(entity.tonnes);

    if (splitTonnes % MIN_CREDIT_UNIT !== 0) {
      throw new BadRequestException(
        `splitTonnes must be a multiple of ${MIN_CREDIT_UNIT}`,
      );
    }
    if (splitTonnes <= 0 || splitTonnes >= totalTonnes) {
      throw new BadRequestException(
        `splitTonnes must be > 0 and < credit tonnes (${totalTonnes})`,
      );
    }

    const remainingTonnes = totalTonnes - splitTonnes;

    // Create child credit 1
    const child1 = new CreditEntity();
    child1.id = `${creditId}-split-${Date.now()}-1`;
    child1.projectId = entity.projectId;
    child1.issuer = entity.issuer;
    child1.vintageYear = entity.vintageYear;
    child1.methodology = entity.methodology;
    child1.geography = entity.geography;
    child1.tonnes = String(splitTonnes);
    child1.ipfsHash = entity.ipfsHash;
    child1.status = CreditStatus.Active;
    child1.issuedAt = Math.floor(Date.now() / 1000);
    await this.creditRepo.save(child1);

    // Create child credit 2
    const child2 = new CreditEntity();
    child2.id = `${creditId}-split-${Date.now()}-2`;
    child2.projectId = entity.projectId;
    child2.issuer = entity.issuer;
    child2.vintageYear = entity.vintageYear;
    child2.methodology = entity.methodology;
    child2.geography = entity.geography;
    child2.tonnes = String(remainingTonnes);
    child2.ipfsHash = entity.ipfsHash;
    child2.status = CreditStatus.Active;
    child2.issuedAt = Math.floor(Date.now() / 1000);
    await this.creditRepo.save(child2);

    // Mark parent as retired/consumed
    entity.status = CreditStatus.Retired;
    await this.creditRepo.save(entity);
    await this.invalidateCreditCache(creditId);

    return { childCredit1: child1.id, childCredit2: child2.id };
  }

  private parseEventType(event: any): string {
    const topics = event.topic || [];
    if (topics.length > 0) {
      const firstTopic = topics[0];
      if (typeof firstTopic === 'string') {
        return firstTopic;
      }
    }
    return 'unknown';
  }

  private parseEventTimestamp(event: any): number {
    // Use closed_at from the event if available, otherwise use current time
    if (event.closedAt) {
      return Math.floor(Number(event.closedAt) / 1000);
    }
    return Math.floor(Date.now() / 1000);
  }

  private mapToCreditMetadata(id: string, native: any): CreditMetadata {
    return {
      id,
      project_id: String(native.project_id),
      issuer: String(native.issuer),
      vintage_year: Number(native.vintage_year),
      methodology: String(native.methodology),
      geography: String(native.geography),
      tonnes: String(native.tonnes),
      ipfs_hash: String(native.ipfs_hash),
      status: native.status as CreditStatus,
      issued_at: Number(native.issued_at),
    };
  }

  private entityToMetadata(entity: CreditEntity): CreditMetadata {
    return {
      id: entity.id,
      project_id: entity.projectId,
      issuer: entity.issuer,
      vintage_year: entity.vintageYear,
      methodology: entity.methodology,
      geography: entity.geography,
      tonnes: entity.tonnes,
      ipfs_hash: entity.ipfsHash,
      status: entity.status,
      issued_at: entity.issuedAt,
    };
  }
}
