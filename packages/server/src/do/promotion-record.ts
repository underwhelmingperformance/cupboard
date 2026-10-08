import { type Logger } from '@cupboard/logger';
import { type NixSha256HashString } from '@cupboard/nix-store/scalars';
import { type UploadStatusResponse } from '@cupboard/protocol/upload';
import { type DrizzleD1Database } from 'drizzle-orm/d1';
import { z } from 'zod';

import { abandonWrittenBlob } from '../blob/promote-blob.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';

import { parseStoredUploadPathMetadata } from './upload-metadata.ts';

type PendingUploadRow = typeof schema.pendingUploads.$inferSelect;

const promotionRecordSchema = z.strictObject({
	mode: z.enum(['fused', 'copy']),
	bytes: z.number().int().nonnegative().optional(),
	durationMs: z.number().nonnegative().optional(),
	r2ErrorCode: z.number().int().optional(),
	reservation: z
		.strictObject({
			incarnation: z.number().int().positive(),
			owner: z.string()
		})
		.optional()
});

/**
 * The latest attempt to create an upload's canonical object, as the upload row
 * stores it. In `fused` mode the queue consumer writes the object while it
 * verifies the staged object; in `copy` mode the Durable Object copies the
 * staged object after verification. `bytes` and `durationMs` describe the R2
 * transfer once the attempt has reported it, and `r2ErrorCode` is the code of
 * the R2 error that stopped the attempt.
 *
 * `reservation` is an incarnation that the queue consumer was allowed to write
 * and that no promotion has activated. The upload gives it up when the upload
 * row leaves verification.
 */
export type PromotionRecord = z.output<typeof promotionRecordSchema>;

/**
 * Parses a stored promotion record, or returns `undefined` when the row has
 * none or this build cannot read it.
 */
export function parsePromotionRecord(
	promotionJson: string | null
): PromotionRecord | undefined {
	if (promotionJson === null) {
		return undefined;
	}

	let document: unknown;

	try {
		document = JSON.parse(promotionJson);
	} catch {
		return undefined;
	}

	const parsed = promotionRecordSchema.safeParse(document);

	return parsed.success ? parsed.data : undefined;
}

/**
 * The status with which an upload leaves verification.
 */
export type UploadOutcome = Exclude<UploadStatusResponse['status'], 'pending'>;

/**
 * The logger for an upload's terminal transition and the status with which the
 * upload leaves verification.
 */
export interface UploadConclusion {
	readonly logger: Logger;
	readonly outcome: UploadOutcome;
}

/**
 * The path that one upload provides.
 */
export interface PromotedPath {
	readonly uploadId: string;
	readonly storePathHash: string;
	readonly narHash: NixSha256HashString;
}

/**
 * Facts of a failed or interrupted promotion attempt.
 */
export interface FailedPromotionAttempt {
	readonly mode: PromotionRecord['mode'];
	readonly outcome: 'failed' | 'aborted';
	readonly bytes: number;
	readonly durationMs: number;
	readonly r2ErrorCode?: number;
}

/**
 * Reports a failed or interrupted promotion attempt. The upload's terminal
 * transition reports the final outcome separately through `concludePromotion`.
 */
export function logPromotionAttemptFailed(
	logger: Logger,
	path: PromotedPath,
	attempt: FailedPromotionAttempt
): void {
	logger.info('nar promotion attempt failed', { ...path, ...attempt });
}

/**
 * Logs the one `nar promotion finished` event of an upload that has just left
 * verification, then gives up a reserved incarnation that no promotion
 * activated. Call it once, from the transition that removed the upload from
 * verification. An upload without a promotion record never started a
 * promotion and emits no promotion event.
 *
 * A failure to give up the incarnation is logged and otherwise ignored. The
 * registry's recovery pass later activates such an incarnation.
 */
export async function concludePromotion(
	d1: DrizzleD1Database<typeof d1Schema>,
	upload: PendingUploadRow,
	{ logger, outcome }: UploadConclusion
): Promise<void> {
	const record = parsePromotionRecord(upload.promotionJson);

	if (record === undefined) {
		return;
	}

	const metadata = parseStoredUploadPathMetadata(
		upload.id,
		upload.metadataJson
	);
	const commitToServableMs =
		outcome === 'servable' && upload.committedAt !== null
			? Date.now() - Date.parse(upload.committedAt)
			: undefined;

	logger.info('nar promotion finished', {
		uploadId: upload.id,
		storePathHash: metadata.storePathHash,
		narHash: metadata.narHash,
		mode: record.mode,
		outcome,
		...(record.bytes !== undefined && { bytes: record.bytes }),
		...(record.durationMs !== undefined && { durationMs: record.durationMs }),
		...(record.r2ErrorCode !== undefined && {
			r2ErrorCode: record.r2ErrorCode
		}),
		...(commitToServableMs !== undefined && { commitToServableMs })
	});

	const { reservation } = record;

	if (reservation === undefined) {
		return;
	}

	try {
		await abandonWrittenBlob(
			d1,
			metadata.narHash,
			reservation.incarnation,
			reservation.owner
		);
	} catch (error) {
		logger.warn('reserved canonical incarnation not given up', {
			uploadId: upload.id,
			narHash: metadata.narHash,
			incarnation: reservation.incarnation,
			error
		});
	}
}
