import { type NixSha256HashString } from '@cupboard/nix-store/scalars';
import {
	type CheckDiscrepancyInput,
	type CheckReportInput
} from '@cupboard/protocol/reports';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import { asc, count, inArray } from 'drizzle-orm';

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

import { chunk, maxInClauseValues, maxOutgoingConnections } from './bulk.ts';
import { type ServerContext } from './context.ts';

interface BlobFact {
	fileHash: NixSha256HashString;
	fileSize: number;
	incarnation: number;
}

export class IntegrityCheckService {
	constructor(private readonly context: ServerContext) {}

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

	// Fetch the canonical compressed-file facts in bounded batches rather than
	// issuing one D1 query for each NAR.
	private async blobFactsFor(
		narHashes: readonly NixSha256HashString[]
	): Promise<Map<NixSha256HashString, BlobFact>> {
		const hashChunks = chunk(narHashes, maxInClauseValues);

		const pages = await mapWithConcurrency(
			hashChunks,
			maxOutgoingConnections,
			(narHashBatch) => {
				const inBatch = inArray(d1Schema.blobState.narHash, narHashBatch);

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

	async check(isDeep: boolean): Promise<CheckReportInput> {
		const total =
			this.context.db.select({ count: count() }).from(schema.narInfos).get()
				?.count ?? 0;
		const rows = this.context.db
			.select()
			.from(schema.narInfos)
			.orderBy(asc(schema.narInfos.cacheId), asc(schema.narInfos.storePathHash))
			.limit(checkBatchSize)
			.all();

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

		for (const row of rows) {
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
		}

		return {
			narInfosChecked: rows.length,
			narBlobsChecked,
			complete: rows.length === total,
			discrepancies
		};
	}
}
