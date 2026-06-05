import {
	type CheckDiscrepancy,
	type CheckReport
} from '@cupboard/protocol/reports';
import { asc, count, eq } from 'drizzle-orm';

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

import { type AuthKeysService } from './auth-keys-service.ts';
import { type ServerContext } from './context.ts';

export class IntegrityCheckService {
	constructor(
		private readonly context: ServerContext,
		private readonly authKeys: AuthKeysService
	) {}

	async handleCheck(request: Request): Promise<Response> {
		await this.authKeys.requireScope(request, 'admin');

		const deep = new URL(request.url).searchParams.get('deep') === 'true';

		const total =
			this.context.db.select({ count: count() }).from(schema.narInfos).get()
				?.count ?? 0;
		const rows = this.context.db
			.select()
			.from(schema.narInfos)
			.orderBy(asc(schema.narInfos.cache), asc(schema.narInfos.storePathHash))
			.limit(checkBatchSize)
			.all();

		const discrepancies: CheckDiscrepancy[] = [];

		// NAR blobs are content-addressed and shared, so check each distinct hash
		// once but attribute a fault to every narinfo that depends on it: the
		// operator sees each affected store path.
		const blobVerdicts = new Map<
			string,
			CheckDiscrepancy['kind'] | undefined
		>();
		let narBlobsChecked = 0;

		for (const row of rows) {
			const narInfoObject = await this.context.env.BLOBS.head(
				narInfoObjectKey(row.storePathHash, row.cache)
			);

			if (narInfoObject === null) {
				discrepancies.push({
					kind: 'missing-narinfo-object',
					cache: row.cache,
					storePathHash: row.storePathHash,
					narHash: row.narHash
				});
			}

			if (!blobVerdicts.has(row.narHash)) {
				blobVerdicts.set(row.narHash, await this.checkNarBlob(row, deep));
				narBlobsChecked += 1;
			}

			const blobVerdict = blobVerdicts.get(row.narHash);

			if (blobVerdict !== undefined) {
				discrepancies.push({
					kind: blobVerdict,
					cache: row.cache,
					storePathHash: row.storePathHash,
					narHash: row.narHash
				});
			}
		}

		return Response.json({
			narInfosChecked: rows.length,
			narBlobsChecked,
			complete: rows.length === total,
			discrepancies
		} satisfies CheckReport);
	}

	private async checkNarBlob(
		row: typeof schema.narInfos.$inferSelect,
		deep: boolean
	): Promise<CheckDiscrepancy['kind'] | undefined> {
		const object =
			(await this.context.env.BLOBS.head(narObjectKey(row.narHash))) ??
			undefined;

		if (object === undefined) {
			return 'missing-nar';
		}

		if (!deep) {
			return undefined;
		}

		// The compressed checksum to verify against is the canonical fact in
		// `blob_state`, not a field on the narinfo row. When it is present, check the
		// stored object's `fileHash`/`fileSize`; the uncompressed re-derivation below
		// runs regardless, since it needs only the row's `narHash`/`narSize`.
		const blobFact = await this.context.d1
			.select({
				fileHash: d1Schema.blobState.fileHash,
				fileSize: d1Schema.blobState.fileSize
			})
			.from(d1Schema.blobState)
			.where(eq(d1Schema.blobState.narHash, row.narHash))
			.get();

		if (blobFact !== undefined) {
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
		}

		// A deep check also re-derives the uncompressed NAR hash, catching a stored
		// blob whose bytes no longer match the hash its narinfo signed.
		const blob = await this.context.env.BLOBS.get(narObjectKey(row.narHash));

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
}
