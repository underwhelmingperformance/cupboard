import {
	type CommitSessionFrameInput,
	type SessionId,
	type UploadGraceFact,
	type UploadId,
	type UploadStatusResponse
} from '@cupboard/protocol/upload';

import { type ResolvedCache } from '../db/cache.ts';
import type * as schema from '../db/schema.ts';

import { sendCommitSessionFrame } from './commit-socket.ts';
import { type ServerContext } from './context.ts';
import { parseStoredGraceDecision, storedGraceFact } from './grace-decision.ts';
import { parseStoredUploadPathMetadata } from './upload-metadata.ts';

/**
The columns of a pending upload that its verdict frame reads.
*/
export type VerdictUpload = Pick<
	typeof schema.pendingUploads.$inferSelect,
	'id' | 'cacheId' | 'metadataJson' | 'graceDecisionJson'
>;

// Read grace at notification time so a replayed verdict reports the current
// deadline.
function servableGraceFact(
	context: ServerContext,
	upload: VerdictUpload,
	cache: ResolvedCache
): UploadGraceFact {
	const metadata = parseStoredUploadPathMetadata(
		upload.id,
		upload.metadataJson
	);

	return storedGraceFact(context.db, cache, metadata.storePathHash);
}

/**
Builds the verdict frame of an upload that did not become servable. The frame
includes an empty grace fact only when the upload accepted grace facts, so a
legacy upload's frame keeps the legacy shape.
*/
export function unservableVerdictFrame(
	uploadId: UploadId,
	graceDecisionJson: string | null,
	status: Exclude<UploadStatusResponse['status'], 'servable'>
): CommitSessionFrameInput {
	const graceDecision = parseStoredGraceDecision(graceDecisionJson);

	return {
		ev: 'verdict',
		uploadId,
		status,
		...(graceDecision?.reportsGrace === true && { grace: {} })
	};
}

/**
Builds an upload's verdict frame. A `servable` frame of an upload that
accepted grace facts includes the path's current grace deadline. `cache` is
the upload's cache when the caller has already resolved it. Any other verdict
comes from {@link unservableVerdictFrame}.
*/
export function uploadVerdictFrame(
	context: ServerContext,
	upload: VerdictUpload,
	status: UploadStatusResponse['status'],
	cache?: ResolvedCache
): CommitSessionFrameInput {
	if (status !== 'servable') {
		return unservableVerdictFrame(upload.id, upload.graceDecisionJson, status);
	}

	const graceDecision = parseStoredGraceDecision(upload.graceDecisionJson);

	return {
		ev: 'verdict',
		uploadId: upload.id,
		status,
		...(graceDecision?.reportsGrace === true && {
			grace: servableGraceFact(
				context,
				upload,
				cache ?? context.cacheRepository.resolvedForId(upload.cacheId)
			)
		})
	};
}

/**
Sends an upload's verdict frame to every socket of a commit session.
*/
export function sendUploadVerdict(
	context: ServerContext,
	sessionId: SessionId,
	upload: VerdictUpload,
	status: UploadStatusResponse['status']
): void {
	const frame = uploadVerdictFrame(context, upload, status);

	for (const socket of context.ctx.getWebSockets(sessionId)) {
		sendCommitSessionFrame(socket, frame);
	}
}
