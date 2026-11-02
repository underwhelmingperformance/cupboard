import type { CacheScope, StorePathHash } from '@cupboard/nix-store/scalars';
import {
	publicationCleanupMarginMs,
	publicationRecoveryMs,
	uploadConfirmPresentMaxCanonicalBytes
} from '@cupboard/protocol/publication';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import {
	uploadConfirmPresentMaxPaths,
	type UploadConfirmPresentPath,
	type UploadConfirmPresentRequest,
	uploadConfirmPresentRequestSchema,
	type UploadConfirmPresentResponse,
	uploadConfirmPresentResponseSchema
} from '@cupboard/protocol/upload';
import { and, eq, inArray } from 'drizzle-orm';

import type { NarInfoReferenceVersion } from '../blob/narinfo-object-metadata.ts';
import { pushIdExpiresAtSeconds } from '../blob/push-id.ts';
import type { ResolvedCache } from '../db/cache.ts';
import { currentCacheGeneration } from '../db/cache-generation.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import {
	ConfirmationAvailabilityChangedError,
	InvalidPushIdError,
	PublicationConflictError,
	PublicationRecoveryExpiredError,
	RequestBodyTooLargeError,
	TenantWritesStoppedError,
	UploadRequestLimitExceededError
} from '../errors.ts';
import { assertRetentionMigrationSettled } from '../migration/cache-retention.ts';
import { requireServedStorePaths } from '../policy/served-store.ts';
import { authorisedNarInfoVersions } from '../read/read.ts';

import { CacheClosureService } from './cache-closure-service.ts';
import {
	confirmationIdentity,
	ConfirmationStore
} from './confirmation-store.ts';
import type { ServerContext } from './context.ts';
import { confirmGraceBatch, serialiseGraceDecision } from './grace-decision.ts';
import { jsonValueLists } from './json-list.ts';
import type { NarInfoObjectsService } from './narinfo-objects-service.ts';
import { PathReadAuthorityService } from './path-read-authority-service.ts';
import { PublicationManifestAvailabilityStore } from './publication-manifest-availability-store.ts';
import type { RetentionService } from './retention-service.ts';
import type { RootsService } from './roots-service.ts';

export class ConfirmationService {
	constructor(
		private readonly context: ServerContext,
		private readonly narInfoObjects: NarInfoObjectsService,
		private readonly retention: RetentionService,
		private readonly roots: RootsService
	) {}

	private requireCurrentCache(cache: ResolvedCache): void {
		if (this.context.offboarding) {
			throw new TenantWritesStoppedError(
				this.context.requireTenant(),
				'offboarding'
			);
		}
		const current = this.context.cacheRepository.resolve(cache.scope);
		if (current?.id !== cache.id || current.generation !== cache.generation) {
			throw new PublicationConflictError(
				'The cache generation changed. Start a fresh push.',
				'generation-conflict'
			);
		}
		new CacheClosureService(this.context).assertWritable(cache);
		assertRetentionMigrationSettled(this.context.db);
	}

	async confirmPresent(
		scope: CacheScope,
		input: UploadConfirmPresentRequest
	): Promise<UploadConfirmPresentResponse> {
		if (input.paths.length > uploadConfirmPresentMaxPaths) {
			throw new UploadRequestLimitExceededError(uploadConfirmPresentMaxPaths);
		}
		const request = uploadConfirmPresentRequestSchema.parse(input);
		requireServedStorePaths(request.paths.map((path) => path.storePath));
		const tenant = this.context.requireTenant();
		const { id, canonical } = await confirmationIdentity(
			tenant,
			scope,
			request
		);
		// A receipt is one SQLite row; each bound text value has a 2,000,000-byte
		// platform limit, independently of the raw HTTP frame limit.
		if (
			new TextEncoder().encode(canonical).byteLength >
			uploadConfirmPresentMaxCanonicalBytes
		) {
			throw new RequestBodyTooLargeError(uploadConfirmPresentMaxCanonicalBytes);
		}
		const store = new ConfirmationStore(this.context);
		const original = store.get(id);
		const pushExpiry = pushIdExpiresAtSeconds(request.pushId);
		// A receipt can recover an expired push, but never another tenant's ID.
		const isIssued = await this.context
			.pushCredentials()
			.isIssuedToTenant(request.pushId);
		const isValidPush = await this.context
			.pushCredentials()
			.verify(request.pushId);
		if (
			!isIssued ||
			pushExpiry === undefined ||
			(original === undefined && !isValidPush)
		) {
			throw new InvalidPushIdError();
		}
		if (
			original !== undefined &&
			Date.parse(original.recoveryDeadline) <= Date.now()
		) {
			throw new PublicationRecoveryExpiredError();
		}
		const account = await this.context.d1
			.select({
				generation: currentCacheGeneration(tenant, scope),
				status: d1Schema.tenant.status
			})
			.from(d1Schema.tenant)
			.where(eq(d1Schema.tenant.id, tenant))
			.get();
		if (this.context.offboarding || account?.status !== 'active') {
			throw new TenantWritesStoppedError(
				tenant,
				this.context.offboarding ? 'offboarding' : account?.status
			);
		}
		if (account.generation !== request.cacheGeneration) {
			throw new PublicationConflictError(
				'The cache generation changed. Start a fresh push.',
				'generation-conflict'
			);
		}
		await new PathReadAuthorityService(this.context).requireWritable();
		// Unlike publication, confirmation must not register an absent cache.
		const cache = this.context.cacheRepository.require(scope);
		if (
			cache.generation !== request.cacheGeneration ||
			(original !== undefined && original.cacheId !== cache.id)
		) {
			throw new PublicationConflictError(
				'The cache generation changed. Start a fresh push.',
				'generation-conflict'
			);
		}
		this.requireCurrentCache(cache);
		const closure = new CacheClosureService(this.context);
		const epoch = closure.epoch(cache);
		const hashes = request.paths.map((path) => path.storePathHash);
		const requestedPaths = new Map(
			request.paths.map((path) => [path.storePathHash, path.storePath])
		);
		const availability = new PublicationManifestAvailabilityStore(
			this.context.db
		);
		const observations = new Map(
			jsonValueLists(hashes)
				.flatMap((list) =>
					this.context.db
						.select({
							storePathHash: schema.narInfos.storePathHash,
							generation: schema.narInfos.generation,
							storePath: schema.narInfos.storePath,
							narHash: schema.narInfos.narHash
						})
						.from(schema.narInfos)
						.where(
							and(
								eq(schema.narInfos.cacheId, cache.id),
								inArray(schema.narInfos.storePathHash, list)
							)
						)
						.all()
				)
				.map((row) => {
					const version = {
						cacheId: cache.id,
						cacheGeneration: cache.generation,
						storePathHash: row.storePathHash,
						generation: row.generation,
						storePath: row.storePath,
						narHash: row.narHash
					};
					return [
						row.storePathHash,
						{ version, snapshot: availability.snapshot(version) }
					] as const;
				})
		);
		// These probes include committed edges, canonical bytes and narinfo repair.
		// No remote work is permitted in the local-only input gate below.
		const served = await this.narInfoObjects.servableNarInfoVersions(
			cache,
			hashes
		);
		// A committed edge can be protected or revoked. Match the same readable
		// winner as cache reads, without acquiring or charging another reference.
		const readable = await authorisedNarInfoVersions(
			this.context.d1,
			tenant,
			scope,
			hashes
		);
		const response = await this.context.criticalSection(() => {
			this.requireCurrentCache(cache);
			return Promise.resolve(
				this.context.db.transaction((tx): UploadConfirmPresentResponse => {
					const receipt = store.get(id, tx);
					if (
						receipt !== undefined &&
						(receipt.canonicalJson !== canonical ||
							receipt.cacheId !== cache.id)
					) {
						throw new PublicationConflictError(
							'The confirmation parameters changed.'
						);
					}
					if (
						receipt !== undefined &&
						Date.parse(receipt.recoveryDeadline) <= Date.now()
					) {
						throw new PublicationRecoveryExpiredError();
					}
					const isUnchangedEpoch =
						closure.epoch(cache) === epoch &&
						(receipt === undefined || receipt.retentionEpoch === epoch);
					const rows = jsonValueLists(hashes).flatMap((list) =>
						tx
							.select()
							.from(schema.narInfos)
							.where(
								and(
									eq(schema.narInfos.cacheId, cache.id),
									inArray(schema.narInfos.storePathHash, list)
								)
							)
							.all()
					);
					const currentRows = new Map(
						rows.map((row) => [row.storePathHash, row])
					);
					const isMatchingVersion = (
						storePathHash: StorePathHash,
						version: NarInfoReferenceVersion
					): boolean => {
						const row = currentRows.get(storePathHash);
						const probed = served.get(storePathHash);
						const authorised = readable.get(storePathHash);
						const observation = observations.get(storePathHash);
						if (
							!isUnchangedEpoch ||
							row?.generation !== version.generation ||
							row.storePath !== requestedPaths.get(storePathHash) ||
							row.narHash !== version.narHash ||
							probed?.generation !== version.generation ||
							probed.narHash !== version.narHash ||
							authorised?.cacheGeneration !== cache.generation ||
							authorised.generation !== version.generation ||
							authorised.narHash !== version.narHash ||
							observation?.version.generation !== version.generation ||
							observation.version.storePath !== row.storePath ||
							observation.version.narHash !== version.narHash
						) {
							return false;
						}

						if (
							!availability.isCurrent(observation.version, observation.snapshot)
						) {
							throw new ConfirmationAvailabilityChangedError();
						}

						return true;
					};

					if (receipt !== undefined) {
						const saved = uploadConfirmPresentResponseSchema.parse(
							JSON.parse(receipt.resultJson)
						);
						return {
							paths: saved.paths.map((path) =>
								path.status === 'confirmed' &&
								!isMatchingVersion(path.storePathHash, path)
									? needsPublication(path.storePathHash)
									: path
							)
						};
					}
					if (!isValidPush || Date.now() >= pushExpiry * 1000) {
						throw new InvalidPushIdError();
					}
					const now = new Date();
					const graceSeconds = this.retention.resolveGraceSeconds(cache);
					const graceDeadline =
						graceSeconds === undefined || graceSeconds === 0
							? undefined
							: isoTimestamp(new Date(now.getTime() + graceSeconds * 1000));
					const decision = {
						reportsGrace: true,
						graceSeconds,
						retentionEpoch: epoch
					};
					const confirmed = request.paths.flatMap(({ storePathHash }) => {
						const version = served.get(storePathHash);
						return version !== undefined &&
							isMatchingVersion(storePathHash, version)
							? { storePathHash, ...version }
							: [];
					});
					const facts = confirmGraceBatch(
						this.context,
						this.retention,
						cache,
						confirmed,
						decision,
						{ database: tx, retainUntil: graceDeadline }
					);
					const targets = request.paths.filter((path) =>
						facts.has(path.storePathHash)
					);
					if (request.attachRoot !== undefined && targets.length > 0) {
						this.roots.bindRunRoot(
							cache,
							request.attachRoot.name,
							request.attachRoot.retention,
							tx
						);
						this.roots.attachRunRootTargets(
							cache,
							request.attachRoot.name,
							targets,
							tx
						);
					}
					const result: UploadConfirmPresentResponse = {
						paths: request.paths.map(({ storePathHash }) => {
							const version = served.get(storePathHash);
							const grace = facts.get(storePathHash);
							return version === undefined || grace === undefined
								? needsPublication(storePathHash)
								: { storePathHash, status: 'confirmed', ...version, grace };
						})
					};
					const recoveryDeadline = isoTimestamp(
						new Date(now.getTime() + publicationRecoveryMs)
					);
					const pruneAt =
						Math.max(pushExpiry * 1000, Date.parse(recoveryDeadline)) +
						publicationCleanupMarginMs;
					tx.insert(schema.confirmationReceipts)
						.values({
							id,
							canonicalJson: canonical,
							cacheId: cache.id,
							cacheGeneration: cache.generation,
							pushId: request.pushId,
							retentionEpoch: epoch,
							graceDecisionJson: serialiseGraceDecision(decision),
							graceDeadline,
							resultJson: JSON.stringify(result),
							acceptedAt: isoTimestamp(now),
							pushExpiresAt: isoTimestamp(new Date(pushExpiry * 1000)),
							recoveryDeadline,
							pruneAfter: isoTimestamp(new Date(pruneAt))
						})
						.run();
					return result;
				})
			);
		});
		await store.armAlarm();
		return response;
	}
}

function needsPublication(
	storePathHash: StorePathHash
): UploadConfirmPresentPath {
	return { storePathHash, status: 'needs-publication' };
}
