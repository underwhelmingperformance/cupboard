import { createHash } from 'node:crypto';

import { nixSha256HashSchema } from '@cupboard/nix-store/scalars';
import { type UploadId, uploadIdSchema } from '@cupboard/protocol/upload';
import { describe, expect, it } from 'vitest';

import { MemoryNarSource } from '../../../../tests/support/nar-source.ts';
import type { CommitSession } from '../client/commit-socket.ts';
import { NixSha256Hash } from '../nix/nar.ts';

import type { CompressedNarUpload, NarUploadObserver } from './nar-upload.ts';
import type { PushClient } from './push.ts';
import {
	sendUpload,
	type UploadClock,
	uploadNarFromSource
} from './upload-transfer.ts';

const uploadId = uploadIdSchema.parse('upload-1');

// Runs each scheduled tick only when the test calls `tick`, records when the
// schedule is cancelled, and reads the time from `times` in order.
function manualClock(
	events: string[],
	times: readonly number[]
): { readonly clock: UploadClock; readonly tick: () => void } {
	let scheduled: (() => void) | undefined;
	let reads = 0;

	return {
		clock: {
			now: () => {
				const time = times[reads] ?? 0;
				reads += 1;

				return time;
			},
			schedule: (tick, intervalMs) => {
				events.push(`schedule ${String(intervalMs)}`);
				scheduled = tick;

				return () => {
					events.push('cancel');
					scheduled = undefined;
				};
			}
		},
		tick: () => {
			scheduled?.();
		}
	};
}

function renewingSession(events: string[]): CommitSession {
	return {
		commit: () => Promise.reject(new Error('unexpected commit')),
		renewUploads: (uploadIds: readonly UploadId[]) => {
			events.push(`renew ${uploadIds.join(',')}`);

			return Promise.resolve();
		},
		close() {
			return;
		}
	};
}

describe('sendUpload', () => {
	it('renews while the transfer runs, stops when it ends and returns its result and duration', async () => {
		const events: string[] = [];
		const { clock, tick } = manualClock(events, [1000, 4000]);
		const transfer = Promise.withResolvers<string>();
		const sending = sendUpload(
			renewingSession(events),
			uploadId,
			() => transfer.promise,
			clock
		);

		tick();
		tick();
		transfer.resolve('sent');
		const sent = await sending;
		tick();

		expect({ sent, events }).toStrictEqual({
			sent: { durationMs: 3000, result: 'sent' },
			events: ['schedule 300000', 'renew upload-1', 'renew upload-1', 'cancel']
		});
	});

	it('stops renewing when the transfer fails', async () => {
		const events: string[] = [];
		const { clock, tick } = manualClock(events, [0]);
		const failure = new Error('transfer failed');
		const sending = sendUpload(
			renewingSession(events),
			uploadId,
			() => Promise.reject(failure),
			clock
		);

		await expect(sending).rejects.toBe(failure);
		tick();

		expect(events).toStrictEqual(['schedule 300000', 'cancel']);
	});

	it.each([
		{ name: 'no session', session: undefined },
		{
			name: 'a session without renewal',
			session: {
				commit: () => Promise.reject(new Error('unexpected commit')),
				close() {
					return;
				}
			}
		}
	])('only times the transfer for $name', async ({ session }) => {
		const events: string[] = [];
		const { clock } = manualClock(events, [500, 2500]);

		await expect(
			sendUpload(session, uploadId, () => Promise.resolve(), clock)
		).resolves.toStrictEqual({ durationMs: 2000, result: undefined });
		expect(events).toStrictEqual([]);
	});
});

describe('uploadNarFromSource', () => {
	const narHash = NixSha256Hash.fromDigest(new Uint8Array(32));
	const upload: CompressedNarUpload = {
		digest: { narHash, narSize: 4 },
		blob: {
			fileHash: nixSha256HashSchema.parse('sha256:' + '1'.repeat(52)),
			fileSize: 3
		},
		compression: {
			narBytes: 4,
			compressedBytes: 3,
			frames: 1,
			compressionMs: 2
		},
		transfer: {
			isSingleRequest: false,
			bufferedParts: 1,
			streamedParts: 1,
			retries: 1,
			recompressions: 1,
			resentBytes: 3,
			paddingBytes: 0
		}
	};

	it('renews the upload while the client recompresses a failed part', async () => {
		const events: string[] = [];
		const { clock, tick } = manualClock(events, [0, 7000]);
		const recompressing = Promise.withResolvers<undefined>();
		const observer: NarUploadObserver = {};
		const client: Pick<PushClient, 'uploadNar' | 'uploadCompressedNar'> = {
			uploadNar: () => Promise.reject(new Error('unexpected uploadNar')),
			uploadCompressedNar: async (r2Key, _source, narSize, given) => {
				events.push(
					`upload ${r2Key} ${String(narSize)}`,
					given === observer ? 'observed' : 'unobserved'
				);
				await recompressing.promise;

				return upload;
			}
		};
		const uploading = uploadNarFromSource(
			{
				client,
				session: renewingSession(events),
				clock,
				compressNar: () => {
					throw new Error('unexpected compression');
				},
				observer
			},
			{ uploadId, r2Key: 'nar/a.nar.zst' },
			MemoryNarSource.of(new Uint8Array(4)),
			4
		);

		tick();
		recompressing.resolve(undefined);
		const completed = await uploading;

		expect({ completed, events }).toStrictEqual({
			completed: { durationMs: 7000, ...upload },
			events: [
				'schedule 300000',
				'upload nar/a.nar.zst 4',
				'observed',
				'renew upload-1',
				'cancel'
			]
		});
	});

	it('compresses the NAR and sends its bytes through a client that cannot compress', async () => {
		const events: string[] = [];
		const { clock } = manualClock(events, [0, 10]);
		let counted = 0;
		const sent: number[] = [];
		const client: Pick<PushClient, 'uploadNar' | 'uploadCompressedNar'> = {
			uploadNar: async (r2Key, body) => {
				events.push(`upload ${r2Key}`);
				const bytes = await new Response(body).arrayBuffer();
				sent.push(bytes.byteLength);
			}
		};

		const completed = await uploadNarFromSource(
			{
				client,
				session: undefined,
				clock,
				compressNar: () => ({
					body: new Response(new Uint8Array(3)).body ?? new ReadableStream(),
					digest: () => upload.digest,
					compression: () => upload.compression
				}),
				observer: {
					onBytes: (count) => {
						counted += count;
					}
				}
			},
			{ uploadId, r2Key: 'nar/a.nar.zst' },
			MemoryNarSource.of(new Uint8Array(4)),
			4
		);

		const expectedFileHash = NixSha256Hash.fromDigest(
			createHash('sha256').update(new Uint8Array(3)).digest()
		).toString();

		expect({ completed, events, sent, counted }).toStrictEqual({
			completed: {
				durationMs: 10,
				digest: upload.digest,
				compression: upload.compression,
				blob: {
					fileHash: expectedFileHash,
					fileSize: 3
				}
			},
			events: ['upload nar/a.nar.zst'],
			sent: [3],
			counted: 3
		});
	});
});
