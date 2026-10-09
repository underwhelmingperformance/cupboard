import {
	type NixSha256HashString,
	type TenantId
} from '@cupboard/nix-store/scalars';
import {
	type CheckDiscrepancyInput,
	type CheckReportInput,
	type SharedAccessReport
} from '@cupboard/protocol/reports';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import { verifyDecompressedNar } from '../blob/nar-verify.ts';
import { verifyStoredBlob } from '../blob/upload-verification.ts';
import {
	authorisedByCacheGeneration,
	referencedCacheLifecycle
} from '../db/cache-generation.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import {
	UploadedObjectChecksumMismatchError,
	UploadedObjectChecksumMissingError,
	UploadedObjectSizeMismatchError
} from '../errors.ts';
import {
	checkBatchSize,
	narInfoObjectKey,
	narObjectKey
} from '../http/http.ts';

import { maxOutgoingConnections } from './bulk.ts';
import { type ServerContext } from './context.ts';
import { jsonValueList, jsonValueLists } from './json-list.ts';
import { hasSubrequestsFor } from './subrequest-slice.ts';

/**
 * The last row checked by the previous pass. The next pass resumes after it.
 * Cache `0` and an empty hash start a new scan.
 */
export interface CheckCursor {
	readonly cache: number;
	readonly storePathHash: string;
}

interface BlobFact {
	fileHash: NixSha256HashString;
	fileSize: number;
	incarnation: number;
}

export class IntegrityCheckService {
	constructor(
		private readonly context: ServerContext,
		private readonly pageSize: number = checkBatchSize
	) {}

	private async checkNarBlob(
		row: typeof schema.narInfos.$inferSelect,
		isDeep: boolean,
		blobFacts: Map<NixSha256HashString, BlobFact>
	): Promise<CheckDiscrepancyInput['kind'] | undefined> {
		const blobFact = blobFacts.get(row.narHash);

		if (blobFact === undefined) {
			return 'missing-nar';
		}

		const object = await this.context.env.BLOBS.head(
			narObjectKey(row.narHash, blobFact.incarnation)
		);

		if (object === null) {
			return 'missing-nar';
		}

		if (!isDeep) {
			return undefined;
		}

		// `blob_state` supplies the compressed checksum and size for the current
		// physical object. Verify them before decompressing and re-deriving the NAR
		// hash.
		try {
			verifyStoredBlob(object, {
				narHash: row.narHash,
				fileHash: blobFact.fileHash,
				fileSize: blobFact.fileSize
			});
		} catch (error) {
			if (
				error instanceof UploadedObjectSizeMismatchError ||
				error instanceof UploadedObjectChecksumMissingError ||
				error instanceof UploadedObjectChecksumMismatchError
			) {
				return 'file-hash-mismatch';
			}

			throw error;
		}

		// A deep check also re-derives the uncompressed NAR hash, catching a stored
		// blob whose bytes no longer match the hash its narinfo signed.
		const blob = await this.context.env.BLOBS.get(
			narObjectKey(row.narHash, blobFact.incarnation)
		);

		if (blob === null) {
			return 'missing-nar';
		}

		const verification = await verifyDecompressedNar(blob.body, {
			narHash: row.narHash,
			narSize: row.narSize
		});

		if (!verification.ok) {
			return verification.reason;
		}

		return undefined;
	}

	// Fetch the canonical compressed-file facts with one read per list, however
	// many NARs the batch holds.
	private async blobFactsFor(
		narHashes: readonly NixSha256HashString[]
	): Promise<Map<NixSha256HashString, BlobFact>> {
		const pages = await mapWithConcurrency(
			jsonValueLists(narHashes),
			maxOutgoingConnections,
			(list) => {
				const inBatch = inArray(d1Schema.blobState.narHash, list);

				return this.context.d1
					.select({
						narHash: d1Schema.blobState.narHash,
						fileHash: d1Schema.blobState.fileHash,
						fileSize: d1Schema.blobState.fileSize,
						incarnation: d1Schema.blobState.incarnation
					})
					.from(d1Schema.blobState)
					.where(inBatch)
					.all();
			}
		);

		return new Map(
			pages.flat().map((row) => [
				row.narHash,
				{
					fileHash: row.fileHash,
					fileSize: row.fileSize,
					incarnation: row.incarnation
				}
			])
		);
	}

	async sharedAccess(
		cursor: SharedAccessReport['cursor']
	): Promise<SharedAccessReport> {
		const tenant = this.context.requireTenant();
		const owned = await this.context.d1
			.select({ narHash: d1Schema.tenantBlob.narHash })
			.from(d1Schema.tenantBlob)
			.where(
				and(
					eq(d1Schema.tenantBlob.tenant, tenant),
					cursor === '' ? undefined : gt(d1Schema.tenantBlob.narHash, cursor)
				)
			)
			.orderBy(asc(d1Schema.tenantBlob.narHash))
			.limit(this.pageSize + 1);
		const page = owned.slice(0, this.pageSize);
		const nextCursor =
			owned.length > this.pageSize ? (page.at(-1)?.narHash ?? '') : '';
		if (page.length === 0) {
			return { narHashes: [], cursor: nextCursor };
		}

		const shared = await sharedAccessReferenceSelect(
			this.context.d1,
			tenant,
			page.map(({ narHash }) => narHash)
		);
		return {
			narHashes: shared.map(({ narHash }) => narHash),
			cursor: nextCursor
		};
	}

	/**
	 * Checks narinfo rows in (cache, store path hash) order after the cursor.
	 * When another row exists or the subrequest slice ends, the report's cursor
	 * identifies the last checked row. Pass that cursor back until it is empty
	 * to check every path.
	 */
	async check(isDeep: boolean, cursor: CheckCursor): Promise<CheckReportInput> {
		const isResuming = cursor.cache !== 0 || cursor.storePathHash !== '';
		const page = this.context.db
			.select()
			.from(schema.narInfos)
			.where(
				isResuming
					? sql`(${schema.narInfos.cacheId}, ${schema.narInfos.storePathHash}) > (${cursor.cache}, ${cursor.storePathHash})`
					: undefined
			)
			.orderBy(asc(schema.narInfos.cacheId), asc(schema.narInfos.storePathHash))
			.limit(this.pageSize + 1)
			.all();
		const rows = page.slice(0, this.pageSize);
		const hasMore = page.length > this.pageSize;

		const discrepancies: CheckDiscrepancyInput[] = [];

		// NAR blobs are content-addressed and shared, so check each distinct hash
		// once but attribute a fault to every narinfo that depends on it: the
		// operator sees each affected store path.
		const blobVerdicts = new Map<
			string,
			CheckDiscrepancyInput['kind'] | undefined
		>();
		let narBlobsChecked = 0;

		const tenant = this.context.requireTenant();

		const distinctNarHashes = [...new Set(rows.map((row) => row.narHash))];
		const blobFacts = await this.blobFactsFor(distinctNarHashes);

		// A row costs a narinfo head, a NAR head for a hash not seen yet, and in
		// deep mode a read of that NAR. Ask for all three, so a row that starts is
		// a row that can finish and the report never describes half of one.
		const subrequestsPerRow = isDeep ? 3 : 2;
		let hasStoppedOnSlice = false;
		let checked = 0;

		for (const row of rows) {
			if (!hasSubrequestsFor(subrequestsPerRow)) {
				hasStoppedOnSlice = true;
				break;
			}

			const cache = this.context.cacheRepository.resolvedForId(row.cacheId);
			const narInfoObject = await this.context.env.BLOBS.head(
				narInfoObjectKey(
					tenant,
					row.storePathHash,
					cache.scope,
					cache.generation
				)
			);

			if (narInfoObject === null) {
				discrepancies.push({
					kind: 'missing-narinfo-object',
					cache: cache.scope,
					storePathHash: row.storePathHash,
					narHash: row.narHash
				});
			}

			if (!blobVerdicts.has(row.narHash)) {
				blobVerdicts.set(
					row.narHash,
					await this.checkNarBlob(row, isDeep, blobFacts)
				);
				narBlobsChecked += 1;
			}

			const blobVerdict = blobVerdicts.get(row.narHash);

			if (blobVerdict !== undefined) {
				discrepancies.push({
					kind: blobVerdict,
					cache: cache.scope,
					storePathHash: row.storePathHash,
					narHash: row.narHash
				});
			}

			checked += 1;
		}

		// The cursor names the last row this pass checked; the next pass starts
		// after it. A pass that stopped on its slice therefore reports the row
		// before the one it did not start, and a pass that checked nothing
		// returns the cursor it was given.
		let resumeAfter: CheckCursor | undefined;

		if (hasStoppedOnSlice || hasMore) {
			const last = rows[checked - 1];
			resumeAfter =
				checked === 0
					? cursor
					: last === undefined
						? undefined
						: { cache: last.cacheId, storePathHash: last.storePathHash };
		}

		return {
			narInfosChecked: checked,
			narBlobsChecked,
			cursor: resumeAfter?.storePathHash ?? '',
			cursorCache: resumeAfter?.cache ?? 0,
			discrepancies
		};
	}
}

export function sharedAccessReferenceSelect(
	database: DrizzleD1Database<typeof d1Schema>,
	tenant: TenantId,
	narHashes: readonly NixSha256HashString[]
) {
	const reference = d1Schema.blobReference;
	const hashes = jsonValueList(narHashes);
	return database
		.select({ narHash: reference.narHash })
		.from(reference)
		.innerJoin(d1Schema.cacheLifecycle, referencedCacheLifecycle())
		.where(
			and(
				eq(reference.tenant, tenant),
				inArray(reference.narHash, hashes),
				eq(reference.readable, true),
				authorisedByCacheGeneration()
			)
		)
		.groupBy(reference.narHash)
		.having(sql`count(distinct ${d1Schema.cacheLifecycle.access}) = 2`)
		.orderBy(asc(reference.narHash));
}
