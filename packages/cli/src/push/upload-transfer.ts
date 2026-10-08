import type { UploadId } from '@cupboard/protocol/upload';
import { formatDuration, type Reporter } from '@cupboard/reporter';

import type { CommitSession } from '../client/commit-socket.ts';
import { countingByteStream } from '../io/byte-stream.ts';
import { type NarCompressionFacts, sendCompressedNar } from '../nix/blob.ts';
import type { NarDigest } from '../nix/nar.ts';
import type { NarSource } from '../nix/nar-source.ts';

import type { NarTransferFacts, NarUploadObserver } from './nar-upload.ts';
import type { CompressNar, PushClient } from './push.ts';

/**
 * How often an upload is renewed while its bytes are being sent. Each renewal
 * sets the upload's expiry to 15 minutes after the renewal, so two renewals in
 * a row can be missed before the upload expires.
 */
export const uploadRenewalIntervalMs = 5 * 60 * 1000;

/**
 * Calls `tick` every `intervalMs` until the returned function cancels it.
 */
export type RenewalSchedule = (
	tick: () => void,
	intervalMs: number
) => () => void;

/**
 * Times uploads and schedules their renewals. Tests replace it to drive both
 * without a real clock.
 */
export interface UploadClock {
	/**
	Returns milliseconds from an arbitrary origin.
	*/
	readonly now: () => number;
	readonly schedule: RenewalSchedule;
}

export const systemUploadClock: UploadClock = {
	now: () => performance.now(),
	schedule: (tick, intervalMs) => {
		const timer = setInterval(tick, intervalMs);
		timer.unref();

		return () => {
			clearInterval(timer);
		};
	}
};

/**
 * The result of an upload's transfer, and how long the transfer took in
 * milliseconds.
 */
export interface SentUpload<T> {
	readonly durationMs: number;
	readonly result: T;
}

/**
 * Runs `transfer`, which sends the bytes of one upload, and returns its result
 * and how long it took. Until the transfer finishes or fails, the upload is
 * renewed over `session` at every interval. Without a session that supports
 * renewal, the transfer is only timed.
 */
export async function sendUpload<T>(
	session: CommitSession | undefined,
	uploadId: UploadId,
	transfer: () => Promise<T>,
	clock: UploadClock = systemUploadClock
): Promise<SentUpload<T>> {
	const startedAt = clock.now();
	const cancel =
		session?.renewUploads === undefined
			? undefined
			: clock.schedule(() => {
					void renewQuietly(session, uploadId);
				}, uploadRenewalIntervalMs);

	let result: T;

	try {
		result = await transfer();
	} finally {
		cancel?.();
	}

	return { durationMs: clock.now() - startedAt, result };
}

// A renewal is advisory: the next tick sends another, and the commit decides
// whether the upload is still live.
async function renewQuietly(
	session: CommitSession,
	uploadId: UploadId
): Promise<void> {
	try {
		await session.renewUploads?.([uploadId]);
	} catch {
		return;
	}
}

/**
 * Reports how long one path's upload took. The message appears with `--debug`
 * and in every JSON event stream, so a slow upload is visible after a run.
 */
export function reportUploadDuration(
	reporter: Pick<Reporter, 'info'>,
	storePathName: string,
	durationMs: number
): void {
	reporter.info(`${storePathName}: uploaded in ${formatDuration(durationMs)}`, {
		level: 'debug'
	});
}

/**
 * One NAR's completed upload: how long it took, the uncompressed NAR's digest,
 * and the compression and transfer facts that the client reported.
 */
export interface CompletedNarUpload {
	readonly durationMs: number;
	readonly digest: NarDigest;
	readonly compression?: NarCompressionFacts;
	readonly transfer?: NarTransferFacts;
}

/**
 * Receives the NAR uploads of a run. `observe` returns the observer for one
 * path's upload, and `completed` receives the upload once it has finished.
 */
export interface UploadReport {
	observe(storePath: string): NarUploadObserver;
	completed(storePath: string, upload: CompletedNarUpload): void;
}

export interface NarUploadContext {
	readonly client: Pick<PushClient, 'uploadNar' | 'uploadCompressedNar'>;
	readonly session: CommitSession | undefined;
	readonly clock: UploadClock;
	/**
	 * Compresses the NAR for a client that has no `uploadCompressedNar`.
	 */
	readonly compressNar: CompressNar;
	readonly observer: NarUploadObserver;
}

/**
 * Uploads a NAR to the staging key that negotiation returned, renewing the
 * upload until it finishes. A client with `uploadCompressedNar` compresses
 * and sends the NAR itself, and can read the source again to send a part
 * again. For any other client, the NAR is compressed here and its bytes go to
 * `uploadNar`.
 */
export async function uploadNarFromSource(
	context: NarUploadContext,
	decision: { readonly uploadId: UploadId; readonly r2Key: string },
	source: NarSource,
	narSize: number
): Promise<CompletedNarUpload> {
	const { durationMs, result } = await sendUpload(
		context.session,
		decision.uploadId,
		() => transferNar(context, decision.r2Key, source, narSize),
		context.clock
	);

	return { durationMs, ...result };
}

async function transferNar(
	context: NarUploadContext,
	r2Key: string,
	source: NarSource,
	narSize: number
): Promise<Omit<CompletedNarUpload, 'durationMs'>> {
	if (context.client.uploadCompressedNar !== undefined) {
		return context.client.uploadCompressedNar(
			r2Key,
			source,
			narSize,
			context.observer
		);
	}

	const upload = context.compressNar(source, narSize);
	const { onBytes } = context.observer;
	await sendCompressedNar(
		onBytes === undefined
			? upload.body
			: countingByteStream(upload.body, onBytes),
		(body) => context.client.uploadNar(r2Key, body)
	);
	const compression = upload.compression?.();

	return {
		digest: upload.digest(),
		...(compression !== undefined && { compression })
	};
}
