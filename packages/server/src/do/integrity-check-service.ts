import { type NixSha256HashString } from '@cupboard/nix-store/scalars';
import {
	type CheckDiscrepancyInput,
	type CheckReportInput
} from '@cupboard/protocol/reports';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import { asc, inArray, sql } from 'drizzle-orm';

import { verifyDecompressedNar } from '../blob/nar-verify.ts';
import { verifyStoredBlob } from '../blob/upload-verification.ts';
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
import { jsonValueLists } from './json-list.ts';
import { hasSubrequestsFor } from './subrequest-slice.ts';

/**
 * Where a pass starts: the last row the previous pass checked, or two empty
 * strings for the beginning of the scan.
 */
export interface CheckCursor {
	readonly cache: string;
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

		const verification = await verifyDecompressedNar(
			blob.body as ReadableStream<Uint8Array>,
			{ narHash: row.narHash, narSize: row.narSize }
		);

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

	/**
	 * Checks one page of narinfo rows in (cache, store path hash) order, starting
	 * after the row the cursor names. The pass reads one row beyond its page;
	 * when that row exists, or the pass stops on its subrequest slice, the report
	 * names the last row checked as the cursor, and a caller checks every path
	 * by passing it back until it comes back empty.
	 */
	async check(isDeep: boolean, cursor: CheckCursor): Promise<CheckReportInput> {
		const isResuming = cursor.cache !== '' || cursor.storePathHash !== '';
		const page = this.context.db
			.select()
			.from(schema.narInfos)
			.where(
				isResuming
					? sql`(${schema.narInfos.cache}, ${schema.narInfos.storePathHash}) > (${cursor.cache}, ${cursor.storePathHash})`
					: undefined
			)
			.orderBy(asc(schema.narInfos.cache), asc(schema.narInfos.storePathHash))
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
				narInfoObjectKey(tenant, row.storePathHash, cache.scope)
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
			resumeAfter = checked === 0 ? cursor : rows[checked - 1];
		}

		return {
			narInfosChecked: checked,
			narBlobsChecked,
			cursor: resumeAfter?.storePathHash ?? '',
			cursorCache: resumeAfter?.cache ?? '',
			discrepancies
		};
	}
}
