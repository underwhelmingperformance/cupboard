import { createHash } from 'node:crypto';
import { PassThrough, Transform } from 'node:stream';
import { setTimeout as sleepFor } from 'node:timers/promises';

import {
	CompleteMultipartUploadCommand,
	CreateMultipartUploadCommand,
	S3Client,
	UploadPartCommand
} from '@aws-sdk/client-s3';
import { ZstdDecoder } from '@cupboard/nix-store/zstd';
import {
	type PushCredential,
	pushCredentialSchema
} from '@cupboard/protocol/upload';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it } from 'vitest';

import {
	fingerprint,
	pseudoRandomBytes
} from '../../../../tests/support/bytes.ts';
import {
	FakeS3,
	type FakeS3Event,
	type FakeS3Options,
	type FakeS3Schedule
} from '../../../../tests/support/fake-s3.ts';
import { ManualClock } from '../../../../tests/support/manual-clock.ts';
import { MemoryNarSource } from '../../../../tests/support/nar-source.ts';
import { byteStream } from '../io/byte-stream.ts';
import {
	compressNarToStream,
	type NarCompressionOptions,
	NarFrames,
	RecompressedNarMismatchError
} from '../nix/blob.ts';
import { NixSha256Hash } from '../nix/nar.ts';
import { SequentialNarSource } from '../nix/nar-source.ts';

import {
	maxPartsPerUpload,
	maxRequestAttempts,
	multipartEtag,
	type NarPaddingReport,
	type NarPartReport,
	type NarRecompressionReport,
	type NarRetryReport,
	type NarUploadObserver,
	ObjectStoreRequestError,
	partSizeFor,
	UnverifiedMultipartUploadError
} from './nar-upload.ts';
import {
	awsCredentials,
	type BlobUploader,
	r2BlobUploader
} from './r2-upload.ts';

const mebibyte = 1024 * 1024;
const partSize = 8 * mebibyte;
const bucket = 'cupboard-blobs';
const key = 'staging/push-1/nar.zst';

// A reset reaches the client as ECONNRESET, or as EPIPE when the client was
// still writing the body.
const connectionReset: unknown = expect.stringMatching(
	/^E(?:CONNRESET|PIPE)$/u
);

const credential = pushCredentialSchema.parse({
	pushId: 'push-1',
	accessKeyId: 'access-key',
	secretAccessKey: 'secret-key',
	sessionToken: 'session-token',
	endpoint: 'https://acct.r2.cloudflarestorage.com',
	bucket,
	expiresAt: '2026-06-29T12:10:00.000Z'
});

// Compressors that pass the NAR through unchanged, so a test can choose the
// exact compressed size.
const identity: NarCompressionOptions = {
	createFrameCompressor: () => new PassThrough(),
	now: () => 0
};

// Compressors that drop every zero byte, so a run of zeros compresses to
// nothing.
const droppingZeros: NarCompressionOptions = {
	createFrameCompressor: () =>
		new Transform({
			transform(chunk: Buffer, _encoding, callback) {
				const kept = Buffer.allocUnsafe(chunk.byteLength);
				let length = 0;

				for (let index = 0; index < chunk.byteLength; index += 1) {
					const byte = chunk[index] ?? 0;

					if (byte === 0) {
						continue;
					}

					kept[length] = byte;
					length += 1;
				}

				callback(undefined, kept.subarray(0, length));
			}
		}),
	now: () => 0
};

// Compressors that keep the first `keep(length)` bytes of a frame of
// `length` bytes and drop the rest. A test uses them to make the compressed
// NAR end much earlier than its compression ratio so far predicts.
function keepingPrefixes(
	keep: (length: number) => number
): NarCompressionOptions {
	return {
		createFrameCompressor: (length) => {
			let remaining = keep(length);

			return new Transform({
				transform(chunk: Buffer, _encoding, callback) {
					const kept = chunk.subarray(0, remaining);
					remaining -= kept.byteLength;
					callback(undefined, kept);
				}
			});
		},
		now: () => 0
	};
}

describe('awsCredentials', () => {
	it('maps a push credential to the S3 client identity with an expiry', () => {
		expect(awsCredentials(credential)).toStrictEqual({
			accessKeyId: 'access-key',
			secretAccessKey: 'secret-key',
			sessionToken: 'session-token',
			expiration: new Date('2026-06-29T12:10:00.000Z')
		});
	});
});

describe('multipartEtag', () => {
	it('derives the ETag of a completed multipart upload from its part ETags, as R2 documents', () => {
		expect(
			multipartEtag([
				'"bce6bf66aeb76c7040fdd5f4eccb78e6"',
				'8165449fc15bbf43d3b674595cbcc406'
			])
		).toBe('f77dc0eecdebcd774a2a22cb393ad2ff-2');
	});
});

describe('partSizeFor', () => {
	const frame = 16 * mebibyte;

	// A NAR of 4,980 whole frames has a compressed bound just under 9,999
	// parts of 8 MiB, and one more frame takes it over.
	it.each([
		{ name: 'an empty NAR', narSize: 0, partBytes: 8 * mebibyte },
		{ name: 'a NAR of one byte', narSize: 1, partBytes: 8 * mebibyte },
		{
			name: 'the largest NAR for 8 MiB parts',
			narSize: 4980 * frame,
			partBytes: 8 * mebibyte
		},
		{
			name: 'one more frame',
			narSize: 4981 * frame,
			partBytes: 9 * mebibyte
		},
		{
			name: 'a NAR of 1 TiB',
			narSize: 65_536 * frame,
			partBytes: 106 * mebibyte
		}
	])('sizes the parts for $name', ({ narSize, partBytes }) => {
		const frames = new NarFrames(narSize);
		const size = partSizeFor(frames);

		expect({
			size,
			partsAtBound:
				Math.ceil(frames.compressedBound() / size) <= maxPartsPerUpload - 1
		}).toStrictEqual({ size: partBytes, partsAtBound: true });
	});
});

describe('the fake S3 endpoint', () => {
	it.each([
		{ name: 'a short part before the last', lengths: [10, 5, 10] },
		{ name: 'a last part longer than the others', lengths: [10, 10, 11] }
	])('refuses to complete an upload with $name', async ({ lengths }) => {
		await withFake({}, async (fake) => {
			const client = rawClient(fake);
			const { UploadId } = await client.send(
				new CreateMultipartUploadCommand({ Bucket: bucket, Key: key })
			);
			const parts = [];

			for (const [index, length] of lengths.entries()) {
				const { ETag } = await client.send(
					new UploadPartCommand({
						Bucket: bucket,
						Key: key,
						UploadId,
						PartNumber: index + 1,
						Body: new Uint8Array(length)
					})
				);
				parts.push({ PartNumber: index + 1, ETag });
			}

			const error = await rejectionOf(
				client.send(
					new CompleteMultipartUploadCommand({
						Bucket: bucket,
						Key: key,
						UploadId,
						MultipartUpload: { Parts: parts }
					})
				)
			);

			expect({
				name: error instanceof Error ? error.name : undefined,
				objects: fake.objects().keys().toArray()
			}).toStrictEqual({ name: 'InvalidPart', objects: [] });
		});
	});

	it('refuses to complete an upload that lists the ETag of a replaced part', async () => {
		await withFake({}, async (fake) => {
			const client = rawClient(fake);
			const { UploadId } = await client.send(
				new CreateMultipartUploadCommand({ Bucket: bucket, Key: key })
			);
			const uploadPart = async (
				body: Uint8Array
			): Promise<string | undefined> => {
				const output = await client.send(
					new UploadPartCommand({
						Bucket: bucket,
						Key: key,
						UploadId,
						PartNumber: 1,
						Body: body
					})
				);

				return output.ETag;
			};
			const replaced = await uploadPart(new Uint8Array(10));
			await uploadPart(new Uint8Array(10).fill(1));

			const error = await rejectionOf(
				client.send(
					new CompleteMultipartUploadCommand({
						Bucket: bucket,
						Key: key,
						UploadId,
						MultipartUpload: { Parts: [{ PartNumber: 1, ETag: replaced }] }
					})
				)
			);

			expect({
				name: error instanceof Error ? error.name : undefined,
				objects: fake.objects().keys().toArray()
			}).toStrictEqual({ name: 'InvalidPart', objects: [] });
		});
	});
});

// Each test compresses and sends tens of MiB through a loopback S3 endpoint.
describe('r2BlobUploader', { timeout: 30_000 }, () => {
	it('signs each request with a credential from the provider', async () => {
		await withFake({}, async (fake) => {
			let issued = 0;
			// A credential that expires within the SDK's refresh window is
			// renewed before every request.
			const provider = (): Promise<PushCredential> => {
				issued += 1;
				const expiresAt = new Date(Date.now() + 60_000).toISOString();

				return Promise.resolve(
					pushCredentialSchema.parse({
						...credential,
						accessKeyId: `access-${String(issued)}`,
						expiresAt
					})
				);
			};
			const uploader = r2BlobUploader({
				endpoint: fake.endpoint,
				bucket,
				provider,
				compression: identity
			});

			await uploader.uploadNar(
				key,
				MemoryNarSource.of(pseudoRandomBytes(2 * partSize, 1)),
				2 * partSize
			);

			const keys = fake.requests.map((request) => request.accessKeyId);

			expect({
				requests: keys.length,
				renewed: new Set(keys).size
			}).toStrictEqual({ requests: 4, renewed: 4 });
		});
	});

	it('uploads a small object with one PutObject', async () => {
		await withFake({}, async (fake) => {
			const bytes = pseudoRandomBytes(1000, 2);

			await uploader(fake).uploadBytes(
				'attestations/bundle.json',
				byteStream([bytes])
			);

			expect({
				requests: requestLog(fake),
				object: fingerprint(
					fake.objects().get('attestations/bundle.json') ?? new Uint8Array()
				)
			}).toStrictEqual({
				requests: ['PutObject ok 1000'],
				object: fingerprint(bytes)
			});
		});
	});

	it.each([
		{ name: 'an empty NAR', nar: new Uint8Array(), compression: undefined },
		{
			name: 'a NAR that compresses to less than one part',
			nar: pseudoRandomBytes(3 * mebibyte, 3),
			compression: undefined
		},
		{
			name: 'a NAR that compresses to exactly one part',
			nar: pseudoRandomBytes(partSize, 4),
			compression: identity
		}
	])(
		'sends $name with one PutObject of its exact length',
		async ({ nar, compression }) => {
			await withFake({}, async (fake) => {
				const expected = await compressed(nar, compression);
				const observer = new RecordingObserver();

				const result = await uploader(fake, { compression }).uploadNar(
					key,
					MemoryNarSource.of(nar),
					nar.byteLength,
					observer
				);

				expect({
					requests: requestLog(fake),
					object: storedObject(fake),
					parts: observer.parts.map((part) => part.mode),
					handed: observer.bytes,
					transfer: result.transfer
				}).toStrictEqual({
					requests: [`PutObject ok ${String(expected.byteLength)}`],
					object: fingerprint(expected),
					parts: ['single-request'],
					handed: expected.byteLength,
					transfer: transferFacts({ isSingleRequest: true })
				});
			});
		}
	);

	it.each([
		{
			name: 'exactly two parts',
			narSize: 2 * partSize,
			modes: ['buffered', 'buffered'],
			lengths: [partSize, partSize]
		},
		{
			name: 'five and a half parts',
			narSize: 5.5 * partSize,
			modes: [
				'buffered',
				'streamed',
				'streamed',
				'streamed',
				'buffered',
				'buffered'
			],
			lengths: [partSize, partSize, partSize, partSize, partSize, partSize / 2]
		}
	])(
		'streams the middle parts of $name and buffers the first and last ones',
		async ({ narSize, modes, lengths }) => {
			await withFake({}, async (fake) => {
				const nar = pseudoRandomBytes(narSize, 5);
				const observer = new RecordingObserver();

				const result = await uploader(fake, {
					compression: identity
				}).uploadNar(key, MemoryNarSource.of(nar), narSize, observer);

				expect({
					parts: observer.parts.map((part) => part.mode),
					lengths: partLengths(fake),
					object: storedObject(fake),
					handed: observer.bytes,
					digest: result.digest.narSize,
					transfer: result.transfer
				}).toStrictEqual({
					parts: modes,
					lengths,
					object: fingerprint(nar),
					handed: narSize,
					digest: narSize,
					transfer: transferFacts({
						bufferedParts: modes.filter((mode) => mode === 'buffered').length,
						streamedParts: modes.filter((mode) => mode === 'streamed').length
					})
				});
			});
		}
	);

	it.each([
		{ name: 'at the end of the part', gap: 0, padding: 0, overflow: 0 },
		{ name: 'three bytes before the end', gap: 3, padding: 8, overflow: 5 },
		{ name: 'eight bytes before the end', gap: 8, padding: 8, overflow: 0 },
		{ name: '1000 bytes before the end', gap: 1000, padding: 1000, overflow: 0 }
	])(
		'pads a streamed part whose compressed bytes end $name as needed',
		async ({ gap, padding, overflow }) => {
			await withFake({}, async (fake) => {
				const { nar, compression, compressedSize } = earlyEndingNar(gap);
				const expected = await compressed(nar, compression);
				const observer = new RecordingObserver();

				const result = await uploader(fake, { compression }).uploadNar(
					key,
					MemoryNarSource.of(nar),
					nar.byteLength,
					observer
				);

				expect({
					compressedSize: expected.byteLength,
					parts: observer.parts.map((part) => part.mode),
					lengths: partLengths(fake),
					object: storedObject(fake),
					padding: observer.padding,
					handed: observer.bytes,
					transfer: result.transfer
				}).toStrictEqual({
					compressedSize,
					parts: [
						'buffered',
						'streamed',
						...(overflow > 0 ? ['buffered'] : [])
					],
					lengths: [partSize, partSize, ...(overflow > 0 ? [overflow] : [])],
					object: paddedFingerprint(expected, padding),
					padding:
						padding > 0
							? [
									{
										partNumber: 2,
										bytes: padding,
										continuesIntoNextPart: overflow > 0
									}
								]
							: [],
					handed: expected.byteLength + padding,
					transfer: transferFacts({
						bufferedParts: overflow > 0 ? 2 : 1,
						streamedParts: 1,
						paddingBytes: padding
					})
				});
			});
		}
	);

	it.each([
		{
			name: 'the start of a streamed part',
			partNumber: 2,
			afterBytes: 0,
			recompressed: undefined
		},
		{
			name: 'the middle of a streamed part that starts inside a frame',
			partNumber: 2,
			afterBytes: partSize / 2,
			recompressed: { opens: [0, 0] }
		},
		{
			name: 'the end of a streamed part',
			partNumber: 3,
			afterBytes: partSize,
			recompressed: { opens: [0, 16 * mebibyte] }
		},
		{
			name: 'the middle of a buffered part',
			partNumber: 1,
			afterBytes: partSize / 2,
			recompressed: { opens: [0], none: true }
		},
		{
			name: 'the last part',
			partNumber: 6,
			afterBytes: mebibyte,
			recompressed: { opens: [0], none: true }
		}
	])(
		'sends a part again after a reset at $name',
		async ({ partNumber, afterBytes, recompressed }) => {
			await withFake({}, async (fake) => {
				const nar = pseudoRandomBytes(5.5 * partSize, 6);
				const source = MemoryNarSource.of(nar);
				const observer = new RecordingObserver();
				fake.fail({
					operation: 'UploadPart',
					partNumber,
					afterBytes,
					response: { kind: 'reset' }
				});

				const result = await uploader(fake, {
					compression: identity
				}).uploadNar(key, source, nar.byteLength, observer);

				expect({
					object: storedObject(fake),
					attempts: fake.requests
						.filter((request) => request.partNumber === partNumber)
						.map((request) => request.outcome),
					retries: observer.retries.map((retry) => retry.target),
					handed: observer.bytes,
					retriesCounted: result.transfer.retries,
					...(recompressed !== undefined && {
						opens: source.opens,
						recompressions: observer.recompressions.length
					})
				}).toStrictEqual({
					object: fingerprint(nar),
					attempts: ['reset', 'ok'],
					retries: [{ kind: 'part', partNumber }],
					handed: nar.byteLength,
					retriesCounted: 1,
					...(recompressed !== undefined && {
						opens: recompressed.opens,
						recompressions: recompressed.none === true ? 0 : 1
					})
				});
			});
		}
	);

	it('recompresses a part with real zstd frames, and pads the part that ends early', async () => {
		await withFake({}, async (fake) => {
			// zstd cannot compress the first 30 MiB, so after part 1 the estimate
			// is that most of the NAR is still to come. The text at the end
			// compresses to almost nothing, so part 4 ends early and is padded.
			// Frame 0 compresses to slightly more than 16 MiB, so part 3 starts in
			// frame 0's last bytes and is recompressed from frame 0.
			const nar = Buffer.concat([
				pseudoRandomBytes(30 * mebibyte, 7),
				Buffer.from('a compressible tail '.repeat(1_000_000))
			]);
			const source = new MemoryNarSource({
				contents: () => nar,
				pieceSize: (open) => (open === 0 ? 100_003 : mebibyte)
			});
			const observer = new RecordingObserver();
			fake.fail({
				operation: 'UploadPart',
				partNumber: 3,
				afterBytes: partSize / 2,
				response: { kind: 'reset' }
			});

			await uploader(fake).uploadNar(key, source, nar.byteLength, observer);
			const padding = observer.padding.at(0)?.bytes ?? 0;
			const decoded = await decode(fake.objects().get(key));
			const expected = await compressed(nar);

			expect({
				parts: observer.parts.map((part) => part.mode),
				recompressions: observer.recompressions.map((report) => ({
					partNumber: report.partNumber,
					reason: report.reason,
					fromFrame: source.opens[1]
				})),
				paddedParts: observer.padding.map((report) => report.partNumber),
				decoded: fingerprint(decoded),
				object: storedObject(fake)
			}).toStrictEqual({
				parts: ['buffered', 'streamed', 'streamed', 'streamed'],
				recompressions: [
					{ partNumber: 3, reason: connectionReset, fromFrame: 0 }
				],
				paddedParts: [4],
				decoded: fingerprint(nar),
				object: paddedFingerprint(expected, padding)
			});
		});
	});

	it('recompresses a part from a source that can only stream the NAR from its start', async () => {
		await withFake({}, async (fake) => {
			const nar = pseudoRandomBytes(5.5 * partSize, 15);
			const requests: number[] = [];
			const source = new SequentialNarSource(() => {
				requests.push(requests.length);

				return MemoryNarSource.of(nar).open(0);
			});
			const observer = new RecordingObserver();
			fake.fail({
				operation: 'UploadPart',
				partNumber: 3,
				afterBytes: partSize / 2,
				response: { kind: 'reset' }
			});

			await uploader(fake, { compression: identity }).uploadNar(
				key,
				source,
				nar.byteLength,
				observer
			);

			expect({
				requests,
				recompressed: observer.recompressions.map(
					(report) => report.partNumber
				),
				object: storedObject(fake)
			}).toStrictEqual({
				requests: [0, 1],
				recompressed: [3],
				object: fingerprint(nar)
			});
		});
	});

	it('sends a part again after a reset inside its skippable frame', async () => {
		await withFake({}, async (fake) => {
			const { nar, compression } = earlyEndingNar(1000);
			const expected = await compressed(nar, compression);
			const observer = new RecordingObserver();
			fake.fail({
				operation: 'UploadPart',
				partNumber: 2,
				afterBytes: partSize - 500,
				response: { kind: 'reset' }
			});

			await uploader(fake, { compression }).uploadNar(
				key,
				MemoryNarSource.of(nar),
				nar.byteLength,
				observer
			);

			expect({
				object: storedObject(fake),
				recompressions: observer.recompressions.length,
				padding: observer.padding
			}).toStrictEqual({
				object: paddedFingerprint(expected, 1000),
				recompressions: 1,
				padding: [{ partNumber: 2, bytes: 1000, continuesIntoNextPart: false }]
			});
		});
	});

	it('reports a reset after the body stops producing bytes as an idle timeout', async () => {
		const clock = new ManualClock();
		const gate = new Gate();
		// The source pauses at NAR offset 12 MiB. Part 2 starts at 8 MiB, so it
		// can send 4 MiB before its body stops producing bytes.
		const sentBeforePause = Promise.withResolvers<undefined>();
		let part2Bytes = 0;
		const onEvent = (event: FakeS3Event): void => {
			if (event.kind !== 'data' || event.partNumber !== 2) {
				return;
			}

			part2Bytes += event.bytes;

			if (part2Bytes >= 4 * mebibyte) {
				sentBeforePause.resolve(undefined);
			}
		};

		await withFake(
			{ idleTimeoutMs: 15_000, schedule: scheduleOn(clock), onEvent },
			async (fake) => {
				const nar = pseudoRandomBytes(5.5 * partSize, 8);
				const source = new MemoryNarSource({
					contents: () => nar,
					beforePiece: (open, offset) =>
						open === 0 && offset === 12 * mebibyte ? gate.wait() : undefined
				});
				// The source resumes once the uploader has classified the reset, as
				// a stalled producer would some time after R2 resets the request.
				const observer = new RecordingObserver(() => {
					gate.open();
				});
				const uploading = uploader(fake, {
					compression: identity,
					now: clock.now
				}).uploadNar(key, source, nar.byteLength, observer);

				await sentBeforePause.promise;
				clock.advanceTo(15_000);
				await uploading;

				expect({
					retries: observer.retries,
					recompressions: observer.recompressions.map((report) => ({
						partNumber: report.partNumber,
						reason: report.reason
					})),
					part2: fake.requests
						.filter((request) => request.partNumber === 2)
						.map((request) => request.outcome),
					object: storedObject(fake)
				}).toStrictEqual({
					retries: [
						{
							target: { kind: 'part', partNumber: 2 },
							attempt: 1,
							reason: 'idle-timeout'
						}
					],
					recompressions: [{ partNumber: 2, reason: 'idle-timeout' }],
					part2: ['reset', 'ok'],
					object: fingerprint(nar)
				});
			}
		);
	});

	it.each([
		{
			name: 'before the part',
			changedAt: 2 * mebibyte,
			mismatchAt: partSize
		},
		{
			name: 'inside the part',
			changedAt: 9 * mebibyte,
			mismatchAt: 2 * partSize
		}
	])(
		'aborts the upload when the NAR changes $name and the part is recompressed',
		async ({ changedAt, mismatchAt }) => {
			await withFake({}, async (fake) => {
				const nar = pseudoRandomBytes(5.5 * partSize, 9);
				const changed = Buffer.from(nar);
				changed[changedAt] = (changed[changedAt] ?? 0) ^ 0xff;
				const source = new MemoryNarSource({
					contents: (open) => (open === 0 ? nar : changed)
				});
				// The error follows the whole body, so the first read reached the
				// end of part 2 and the replay checks the bytes up to there.
				fake.fail({
					operation: 'UploadPart',
					partNumber: 2,
					response: {
						kind: 'error',
						status: StatusCodes.INTERNAL_SERVER_ERROR,
						code: 'InternalError'
					}
				});

				const error = await rejectionOf(
					uploader(fake, { compression: identity }).uploadNar(
						key,
						source,
						nar.byteLength
					)
				);

				expect({
					error,
					part2Stored: fake.requests.some(
						(request) => request.partNumber === 2 && request.outcome === 'ok'
					),
					aborted: fake.requests.some(
						(request) =>
							request.operation === 'AbortMultipartUpload' &&
							request.outcome === 'ok'
					),
					openUploads: fake.openUploads(),
					objects: fake.objects().keys().toArray()
				}).toStrictEqual({
					error: new RecompressedNarMismatchError(0, mismatchAt),
					part2Stored: false,
					aborted: true,
					openUploads: [],
					objects: []
				});
			});
		}
	);

	it('aborts a cancelled upload without waiting for a source that never yields again', async () => {
		const controller = new AbortController();
		const reason = new UploadCancelledError();

		await withFake({}, async (fake) => {
			const nar = pseudoRandomBytes(5.5 * partSize, 10);
			// Part 3 starts at 16 MiB. The source stops for good at NAR offset
			// 20 MiB.
			const stalled = new Gate();
			const source = new MemoryNarSource({
				contents: () => nar,
				beforePiece: (open, offset) =>
					open === 0 && offset === 20 * mebibyte ? stalled.wait() : undefined
			});
			const uploading = rejectionOf(
				r2BlobUploader({
					endpoint: fake.endpoint,
					bucket,
					provider: () => Promise.resolve(credential),
					signal: controller.signal,
					compression: identity,
					backoff: () => Promise.resolve()
				}).uploadNar(key, source, nar.byteLength)
			);

			await stalled.reached;
			controller.abort(reason);

			expect({
				error: await uploading,
				aborted: fake.requests.some(
					(request) =>
						request.operation === 'AbortMultipartUpload' &&
						request.outcome === 'ok'
				),
				openUploads: fake.openUploads(),
				objects: fake.objects().keys().toArray()
			}).toStrictEqual({
				error: reason,
				aborted: true,
				openUploads: [],
				objects: []
			});
		});
	});

	it('completes the upload when the completion response is lost and the object matches the parts', async () => {
		await withFake({}, async (fake) => {
			const nar = pseudoRandomBytes(2 * partSize, 16);
			fake.fail({
				operation: 'CompleteMultipartUpload',
				response: { kind: 'lost-response' }
			});

			await uploader(fake, { compression: identity }).uploadNar(
				key,
				MemoryNarSource.of(nar),
				nar.byteLength
			);

			expect({
				requests: fake.requests
					.filter((request) => request.operation !== 'UploadPart')
					.map((request) => [request.operation, request.outcome, request.code]),
				object: storedObject(fake)
			}).toStrictEqual({
				requests: [
					['CreateMultipartUpload', 'ok', undefined],
					['CompleteMultipartUpload', 'reset', undefined],
					['CompleteMultipartUpload', 'error', 'NoSuchUpload'],
					['HeadObject', 'ok', undefined]
				],
				object: fingerprint(nar)
			});
		});
	});

	it.each([
		{
			name: 'another object replaced it',
			replacement: pseudoRandomBytes(1000, 17)
		},
		{ name: 'the object is missing', replacement: undefined }
	])(
		'fails the upload when the completion response is lost and $name',
		async ({ replacement }) => {
			const holder: { fake?: FakeS3 } = {};
			const onEvent = (event: FakeS3Event): void => {
				if (
					event.kind === 'end' &&
					event.request.operation === 'CompleteMultipartUpload' &&
					event.request.outcome === 'reset'
				) {
					holder.fake?.replaceObject(key, replacement);
				}
			};

			await withFake({ onEvent }, async (fake) => {
				holder.fake = fake;
				const nar = pseudoRandomBytes(2 * partSize, 18);
				fake.fail({
					operation: 'CompleteMultipartUpload',
					response: { kind: 'lost-response' }
				});

				const partEtags = [
					md5Hex(nar.subarray(0, partSize)),
					md5Hex(nar.subarray(partSize))
				];
				const error = await rejectionOf(
					uploader(fake, { compression: identity }).uploadNar(
						key,
						MemoryNarSource.of(nar),
						nar.byteLength
					)
				);

				if (!(error instanceof UnverifiedMultipartUploadError)) {
					throw new TypeError('expected an UnverifiedMultipartUploadError');
				}

				expect({
					key: error.key,
					expected: error.expected,
					found: error.found
				}).toStrictEqual({
					key,
					expected: {
						length: nar.byteLength,
						etag: multipartEtag(partEtags)
					},
					found:
						replacement === undefined
							? undefined
							: { length: replacement.byteLength, etag: md5Hex(replacement) }
				});
			});
		}
	);

	it.each([
		{
			name: 'every attempt is reset',
			faults: maxRequestAttempts,
			response: { kind: 'reset' } as const,
			expected: { isRetryable: true, reason: connectionReset, attempts: 5 }
		},
		{
			name: 'R2 refuses the request',
			faults: 1,
			response: {
				kind: 'error',
				status: StatusCodes.FORBIDDEN,
				code: 'AccessDenied'
			} as const,
			expected: { isRetryable: false, reason: 'AccessDenied', attempts: 1 }
		}
	])(
		'fails the upload and aborts it when $name',
		async ({ faults, response, expected }) => {
			await withFake({}, async (fake) => {
				for (let fault = 0; fault < faults; fault += 1) {
					fake.fail({
						operation: 'UploadPart',
						partNumber: 2,
						afterBytes: mebibyte,
						response
					});
				}

				const nar = pseudoRandomBytes(5.5 * partSize, 11);
				const error = await rejectionOf(
					uploader(fake, { compression: identity }).uploadNar(
						key,
						MemoryNarSource.of(nar),
						nar.byteLength
					)
				);

				if (!(error instanceof ObjectStoreRequestError)) {
					throw new TypeError('expected an ObjectStoreRequestError');
				}

				expect({
					error: { isRetryable: error.isRetryable, reason: error.reason },
					attempts: fake.requests.filter((request) => request.partNumber === 2)
						.length,
					aborted: fake.requests.some(
						(request) => request.operation === 'AbortMultipartUpload'
					),
					openUploads: fake.openUploads()
				}).toStrictEqual({
					error: { isRetryable: expected.isRetryable, reason: expected.reason },
					attempts: expected.attempts,
					aborted: true,
					openUploads: []
				});
			});
		}
	);

	it('retries a part that R2 asks the client to send more slowly', async () => {
		await withFake({}, async (fake) => {
			const nar = pseudoRandomBytes(5.5 * partSize, 12);
			const observer = new RecordingObserver();
			fake.fail({
				operation: 'UploadPart',
				partNumber: 3,
				response: {
					kind: 'error',
					status: StatusCodes.SERVICE_UNAVAILABLE,
					code: 'SlowDown'
				}
			});

			await uploader(fake, { compression: identity }).uploadNar(
				key,
				MemoryNarSource.of(nar),
				nar.byteLength,
				observer
			);

			expect({
				retries: observer.retries,
				object: storedObject(fake)
			}).toStrictEqual({
				retries: [
					{
						target: { kind: 'part', partNumber: 3 },
						attempt: 1,
						reason: 'SlowDown'
					}
				],
				object: fingerprint(nar)
			});
		});
	});

	it('recompresses a part from a store that allows one open NAR at a time', async () => {
		await withFake({}, async (fake) => {
			const nar = pseudoRandomBytes(5.5 * partSize, 20);
			const source = new MemoryNarSource({
				contents: () => nar,
				isExclusive: true
			});
			fake.fail({
				operation: 'UploadPart',
				partNumber: 3,
				afterBytes: partSize / 2,
				response: { kind: 'reset' }
			});

			await uploader(fake, { compression: identity }).uploadNar(
				key,
				source,
				nar.byteLength
			);

			expect({
				object: storedObject(fake),
				opens: source.opens,
				closed: source.closed
			}).toStrictEqual({
				object: fingerprint(nar),
				opens: [0, 16 * mebibyte],
				closed: 2
			});
		});
	});

	it.each([
		{
			name: 'part 2 twice',
			resets: [
				{ partNumber: 2, afterBytes: partSize / 2 },
				{ partNumber: 2, afterBytes: partSize / 4 }
			],
			opens: [0, 0, 0]
		},
		{
			name: 'part 2 and then part 3',
			resets: [
				{ partNumber: 2, afterBytes: partSize / 2 },
				{ partNumber: 3, afterBytes: partSize / 2 }
			],
			opens: [0, 0, 16 * mebibyte]
		}
	])(
		'hashes the NAR that it stores after resets of $name',
		async ({ resets, opens }) => {
			await withFake({}, async (fake) => {
				const nar = pseudoRandomBytes(5.5 * partSize, 26);
				const source = MemoryNarSource.of(nar);

				for (const { partNumber, afterBytes } of resets) {
					fake.fail({
						operation: 'UploadPart',
						partNumber,
						afterBytes,
						response: { kind: 'reset' }
					});
				}

				const result = await uploader(fake, {
					compression: identity
				}).uploadNar(key, source, nar.byteLength);

				expect({
					object: storedObject(fake),
					digest: result.digest,
					opens: source.opens
				}).toStrictEqual({
					object: fingerprint(nar),
					digest: {
						narHash: NixSha256Hash.fromDigest(
							createHash('sha256').update(nar).digest()
						),
						narSize: nar.byteLength
					},
					opens
				});
			});
		}
	);

	it('closes the NAR source when a retry is refused before its body is sent', async () => {
		await withFake({}, async (fake) => {
			const nar = pseudoRandomBytes(5.5 * partSize, 21);
			const source = MemoryNarSource.of(nar);
			fake.fail({
				operation: 'UploadPart',
				partNumber: 2,
				afterBytes: partSize / 2,
				response: { kind: 'reset' }
			});
			fake.fail({
				operation: 'UploadPart',
				partNumber: 2,
				response: {
					kind: 'refuse-before-body',
					status: StatusCodes.SERVICE_UNAVAILABLE,
					code: 'SlowDown'
				}
			});

			await uploader(fake, { compression: identity }).uploadNar(
				key,
				source,
				nar.byteLength
			);

			expect({
				object: storedObject(fake),
				part2: fake.requests
					.filter((request) => request.partNumber === 2)
					.map((request) => request.outcome),
				opens: source.opens.length,
				closed: source.closed
			}).toStrictEqual({
				object: fingerprint(nar),
				part2: ['reset', 'error', 'ok'],
				opens: 2,
				closed: 2
			});
		});
	});

	it.each([
		{
			name: 'the first part is compressed',
			stallAt: { open: 0, offset: 4 * mebibyte },
			reset: undefined
		},
		{
			name: 'a part is recompressed up to its start',
			stallAt: { open: 1, offset: 4 * mebibyte },
			reset: { partNumber: 2, afterBytes: partSize / 2 }
		}
	])(
		'cancels the upload without waiting for a stalled source while $name',
		async ({ stallAt, reset }) => {
			const controller = new AbortController();
			const reason = new UploadCancelledError();
			const stalled = new Gate();

			await withFake({}, async (fake) => {
				const nar = pseudoRandomBytes(5.5 * partSize, 22);
				const source = new MemoryNarSource({
					contents: () => nar,
					beforePiece: (open, offset) =>
						open === stallAt.open && offset === stallAt.offset
							? stalled.wait()
							: undefined
				});

				if (reset !== undefined) {
					fake.fail({
						operation: 'UploadPart',
						partNumber: reset.partNumber,
						afterBytes: reset.afterBytes,
						response: { kind: 'reset' }
					});
				}

				const uploading = rejectionOf(
					cancellableUploader(fake, controller.signal).uploadNar(
						key,
						source,
						nar.byteLength
					)
				);
				await stalled.reached;
				controller.abort(reason);

				expect({
					error: await uploading,
					openUploads: fake.openUploads(),
					objects: fake.objects().keys().toArray()
				}).toStrictEqual({ error: reason, openUploads: [], objects: [] });
			});
		}
	);

	it('cancels the upload while it waits for a stalled source after an idle reset', async () => {
		const clock = new ManualClock();
		const controller = new AbortController();
		const reason = new UploadCancelledError();
		const stalled = new Gate();
		const sentBeforePause = Promise.withResolvers<undefined>();
		let part2Bytes = 0;
		const onEvent = (event: FakeS3Event): void => {
			if (event.kind !== 'data' || event.partNumber !== 2) {
				return;
			}

			part2Bytes += event.bytes;

			if (part2Bytes >= 4 * mebibyte) {
				sentBeforePause.resolve(undefined);
			}
		};

		await withFake(
			{ idleTimeoutMs: 15_000, schedule: scheduleOn(clock), onEvent },
			async (fake) => {
				const nar = pseudoRandomBytes(5.5 * partSize, 23);
				const source = new MemoryNarSource({
					contents: () => nar,
					beforePiece: (open, offset) =>
						open === 0 && offset === 12 * mebibyte ? stalled.wait() : undefined
				});
				const uploading = rejectionOf(
					r2BlobUploader({
						endpoint: fake.endpoint,
						bucket,
						provider: () => Promise.resolve(credential),
						signal: controller.signal,
						compression: identity,
						backoff: () => Promise.resolve(),
						now: clock.now
					}).uploadNar(key, source, nar.byteLength, {
						onRetry: () => {
							controller.abort(reason);
						}
					})
				);

				await sentBeforePause.promise;
				clock.advanceTo(15_000);

				expect({
					error: await uploading,
					openUploads: fake.openUploads()
				}).toStrictEqual({ error: reason, openUploads: [] });
			}
		);
	});

	it('fails with the cancellation reason when the upload is cancelled during a backoff', async () => {
		const controller = new AbortController();
		const reason = new UploadCancelledError();

		await withFake({}, async (fake) => {
			const nar = pseudoRandomBytes(5.5 * partSize, 24);
			fake.fail({
				operation: 'UploadPart',
				partNumber: 2,
				afterBytes: partSize / 2,
				response: { kind: 'reset' }
			});

			const error = await rejectionOf(
				r2BlobUploader({
					endpoint: fake.endpoint,
					bucket,
					provider: () => Promise.resolve(credential),
					signal: controller.signal,
					compression: identity,
					backoff: (_attempt, signal) => sleepFor(60_000, undefined, { signal })
				}).uploadNar(key, MemoryNarSource.of(nar), nar.byteLength, {
					onRetry: () => {
						controller.abort(reason);
					}
				})
			);

			expect({ error, openUploads: fake.openUploads() }).toStrictEqual({
				error: reason,
				openUploads: []
			});
		});
	});

	it('fails at once when R2 refuses a part before its body ends, without waiting for a stalled source', async () => {
		await withFake({}, async (fake) => {
			const nar = pseudoRandomBytes(5.5 * partSize, 25);
			const stalled = new Gate();
			const source = new MemoryNarSource({
				contents: () => nar,
				beforePiece: (open, offset) =>
					open === 0 && offset === 20 * mebibyte ? stalled.wait() : undefined
			});
			fake.fail({
				operation: 'UploadPart',
				partNumber: 3,
				afterBytes: 2 * mebibyte,
				response: {
					kind: 'error',
					status: StatusCodes.FORBIDDEN,
					code: 'AccessDenied'
				}
			});

			const error = await rejectionOf(
				uploader(fake, { compression: identity }).uploadNar(
					key,
					source,
					nar.byteLength
				)
			);

			expect({
				error:
					error instanceof ObjectStoreRequestError
						? { reason: error.reason, isRetryable: error.isRetryable }
						: error,
				openUploads: fake.openUploads()
			}).toStrictEqual({
				error: { reason: 'AccessDenied', isRetryable: false },
				openUploads: []
			});
		});
	});

	it('reports a part as failed when its recompressed bytes differ', async () => {
		await withFake({}, async (fake) => {
			const nar = pseudoRandomBytes(5.5 * partSize, 26);
			const changed = Buffer.from(nar);
			changed[2 * mebibyte] = (changed[2 * mebibyte] ?? 0) ^ 0xff;
			const observer = new RecordingObserver();
			fake.fail({
				operation: 'UploadPart',
				partNumber: 2,
				afterBytes: partSize / 2,
				response: { kind: 'reset' }
			});

			await rejectionOf(
				uploader(fake, { compression: identity }).uploadNar(
					key,
					new MemoryNarSource({
						contents: (open) => (open === 0 ? nar : changed)
					}),
					nar.byteLength,
					observer
				)
			);

			expect(
				observer.parts.map((part) => ({
					partNumber: part.partNumber,
					attempts: part.attempts,
					outcome: part.outcome
				}))
			).toStrictEqual([
				{ partNumber: 1, attempts: 1, outcome: 'sent' },
				{ partNumber: 2, attempts: 2, outcome: 'failed' }
			]);
		});
	});

	it('retries a small object after a reset', async () => {
		await withFake({}, async (fake) => {
			const bytes = pseudoRandomBytes(1000, 27);
			fake.fail({
				operation: 'PutObject',
				response: { kind: 'reset' }
			});

			await uploader(fake).uploadBytes(
				'attestations/bundle.json',
				byteStream([bytes])
			);

			expect({
				requests: requestLog(fake),
				object: fingerprint(
					fake.objects().get('attestations/bundle.json') ?? new Uint8Array()
				)
			}).toStrictEqual({
				requests: ['PutObject reset 0', 'PutObject ok 1000'],
				object: fingerprint(bytes)
			});
		});
	});

	it.each([
		{
			name: 'an edge server answers with a server error',
			response: {
				kind: 'error-after-effect',
				status: StatusCodes.BAD_GATEWAY,
				code: 'BadGateway'
			} as const,
			outcome: ['error', 'BadGateway']
		},
		{
			name: 'the response never arrives',
			response: { kind: 'no-response' } as const,
			outcome: ['unanswered', undefined]
		}
	])(
		'completes the upload when R2 completed it but $name',
		async ({ response, outcome }) => {
			await withFake({}, async (fake) => {
				const nar = pseudoRandomBytes(2 * partSize, 28);
				fake.fail({ operation: 'CompleteMultipartUpload', response });

				await r2BlobUploader({
					endpoint: fake.endpoint,
					bucket,
					provider: () => Promise.resolve(credential),
					compression: identity,
					backoff: () => Promise.resolve(),
					socketTimeoutMs: 500
				}).uploadNar(key, MemoryNarSource.of(nar), nar.byteLength);

				expect({
					requests: fake.requests
						.filter((request) => request.operation !== 'UploadPart')
						.map((request) => [
							request.operation,
							request.outcome,
							request.code
						]),
					object: storedObject(fake)
				}).toStrictEqual({
					requests: [
						['CreateMultipartUpload', 'ok', undefined],
						['CompleteMultipartUpload', ...outcome],
						['CompleteMultipartUpload', 'error', 'NoSuchUpload'],
						['HeadObject', 'ok', undefined]
					],
					object: fingerprint(nar)
				});
			});
		}
	);

	it('sends the overflow part of a skippable frame again after a reset', async () => {
		await withFake({}, async (fake) => {
			const { nar, compression } = earlyEndingNar(3);
			const expected = await compressed(nar, compression);
			fake.fail({
				operation: 'UploadPart',
				partNumber: 3,
				response: { kind: 'reset' }
			});

			await uploader(fake, { compression }).uploadNar(
				key,
				MemoryNarSource.of(nar),
				nar.byteLength
			);

			expect({
				part3: fake.requests
					.filter((request) => request.partNumber === 3)
					.map((request) => [request.outcome, request.bytes]),
				object: storedObject(fake)
			}).toStrictEqual({
				part3: [
					['reset', 0],
					['ok', 5]
				],
				object: paddedFingerprint(expected, 8)
			});
		});
	});

	it('streams parts after buffered parts once the compression ratio rises', async () => {
		await withFake({}, async (fake) => {
			// 24 MiB that compress to nothing and then 64 MiB that do not
			// compress. After part 1 the ratio is low, so part 2 is buffered;
			// after part 2 the ratio is high enough for part 3 to be streamed.
			const nar = Buffer.concat([
				new Uint8Array(24 * mebibyte),
				Buffer.alloc(64 * mebibyte, 1)
			]);
			const observer = new RecordingObserver();

			await uploader(fake, { compression: droppingZeros }).uploadNar(
				key,
				MemoryNarSource.of(nar),
				nar.byteLength,
				observer
			);

			expect(observer.parts.slice(0, 4).map((part) => part.mode)).toStrictEqual(
				['buffered', 'buffered', 'streamed', 'streamed']
			);
		});
	});

	it('keeps sending a started part while a part of another upload is stalled', async () => {
		const log: string[] = [];
		const stalled = new Gate();
		const blockedKey = 'staging/push-1/blocked.nar.zst';
		const blockedPartStarted = Promise.withResolvers<undefined>();

		await withFake(
			{
				onEvent: (event) => {
					if (
						event.kind === 'start' &&
						event.key === blockedKey &&
						event.partNumber === 2
					) {
						blockedPartStarted.resolve(undefined);
					}

					if (event.kind === 'end') {
						log.push(
							`${event.request.key === blockedKey ? 'blocked' : 'other'} ${event.request.operation} ${String(event.request.partNumber ?? '')}`
						);
					}
				}
			},
			async (fake) => {
				const nar = pseudoRandomBytes(5.5 * partSize, 13);
				// The blocked upload's part 2 is streamed from 8 MiB and stops
				// at NAR offset 12 MiB until the other upload is done.
				const blocked = new MemoryNarSource({
					contents: () => nar,
					beforePiece: (open, offset) =>
						open === 0 && offset === 12 * mebibyte ? stalled.wait() : undefined
				});
				const shared = uploader(fake, { compression: identity });
				const blockedUpload = shared.uploadNar(
					blockedKey,
					blocked,
					nar.byteLength
				);
				await blockedPartStarted.promise;
				await stalled.reached;

				await shared.uploadNar(key, MemoryNarSource.of(nar), nar.byteLength);
				log.push('other done');
				stalled.open();
				await blockedUpload;

				expect(log.indexOf('other done')).toBeLessThan(
					log.indexOf('blocked UploadPart 2')
				);
			}
		);
	});

	it('feeds a started part only from the compressor, even while another upload is stalled', async () => {
		const log: string[] = [];
		const stalled = new Gate();

		await withFake(
			{
				onEvent: (event) => {
					log.push(...fakeEventEntry(event));
				}
			},
			async (fake) => {
				const nar = pseudoRandomBytes(5.5 * partSize, 13);
				const source = new MemoryNarSource({
					contents: () => nar,
					beforePiece: (_open, offset) => {
						log.push(`read ${String(offset / mebibyte)}`);
					}
				});
				const blocked = new MemoryNarSource({
					contents: () => nar,
					beforePiece: () => stalled.wait()
				});
				const shared = uploader(fake, { compression: identity });
				const other = shared.uploadNar(
					'staging/push-1/blocked.nar.zst',
					blocked,
					nar.byteLength
				);

				await shared.uploadNar(key, source, nar.byteLength);
				stalled.open();
				await other;

				expect(partTimelines(log)).toStrictEqual([
					{ part: 1, readsWhileSending: false },
					{ part: 2, readsWhileSending: true },
					{ part: 3, readsWhileSending: true },
					{ part: 4, readsWhileSending: true },
					{ part: 5, readsWhileSending: false },
					{ part: 6, readsWhileSending: false }
				]);
			}
		);
	});
});

class UploadCancelledError extends Error {
	constructor() {
		super('upload cancelled');
		this.name = 'UploadCancelledError';
	}
}

class RecordingObserver implements NarUploadObserver {
	bytes = 0;

	readonly parts: NarPartReport[] = [];

	readonly retries: NarRetryReport[] = [];

	readonly recompressions: NarRecompressionReport[] = [];

	readonly padding: NarPaddingReport[] = [];

	readonly onBytes = (count: number): void => {
		this.bytes += count;
	};

	readonly onPart = (report: NarPartReport): void => {
		this.parts.push(report);
	};

	readonly onRetry = (report: NarRetryReport): void => {
		this.retries.push(report);
		this.afterRetry?.();
	};

	readonly onRecompression = (report: NarRecompressionReport): void => {
		this.recompressions.push(report);
	};

	readonly onPadding = (report: NarPaddingReport): void => {
		this.padding.push(report);
	};

	constructor(private readonly afterRetry?: () => void) {}
}

/**
 * A pause in a NAR source. `reached` resolves when the source arrives at it,
 * and the source waits there until `open` is called.
 */
class Gate {
	private readonly arrived = Promise.withResolvers<undefined>();

	private readonly opened = Promise.withResolvers<undefined>();

	get reached(): Promise<undefined> {
		return this.arrived.promise;
	}

	wait(): Promise<undefined> {
		this.arrived.resolve(undefined);

		return this.opened.promise;
	}

	open(): void {
		this.opened.resolve(undefined);
	}
}

// Runs `run` once the manual clock passes `ms` from now.
function scheduleOn(clock: ManualClock): FakeS3Schedule {
	return (run, ms) => {
		const controller = new AbortController();
		void runAfter(clock, ms, controller.signal, run);

		return () => {
			controller.abort();
		};
	};
}

async function runAfter(
	clock: ManualClock,
	ms: number,
	signal: AbortSignal,
	run: () => void
): Promise<void> {
	try {
		await clock.wait(ms, signal);
	} catch {
		// The fake cancelled the timer.
		return;
	}

	run();
}

interface UploaderOverrides {
	readonly compression?: NarCompressionOptions | undefined;
	readonly now?: () => number;
}

function uploader(
	fake: FakeS3,
	overrides: UploaderOverrides = {}
): BlobUploader {
	return r2BlobUploader({
		endpoint: fake.endpoint,
		bucket,
		provider: () => Promise.resolve(credential),
		backoff: () => Promise.resolve(),
		...(overrides.compression !== undefined && {
			compression: overrides.compression
		}),
		...(overrides.now !== undefined && { now: overrides.now })
	});
}

function cancellableUploader(fake: FakeS3, signal: AbortSignal): BlobUploader {
	return r2BlobUploader({
		endpoint: fake.endpoint,
		bucket,
		provider: () => Promise.resolve(credential),
		signal,
		compression: identity,
		backoff: () => Promise.resolve()
	});
}

function rawClient(fake: FakeS3): S3Client {
	return new S3Client({
		endpoint: fake.endpoint,
		region: 'auto',
		forcePathStyle: true,
		credentials: awsCredentials(credential),
		requestChecksumCalculation: 'WHEN_REQUIRED',
		responseChecksumValidation: 'WHEN_REQUIRED'
	});
}

async function withFake(
	options: FakeS3Options,
	body: (fake: FakeS3) => Promise<void>
): Promise<void> {
	const fake = await FakeS3.start(options);

	try {
		await body(fake);
	} finally {
		await fake.stop();
	}
}

function transferFacts(
	overrides: Partial<{
		isSingleRequest: boolean;
		bufferedParts: number;
		streamedParts: number;
		paddingBytes: number;
	}>
): Record<string, unknown> {
	return {
		isSingleRequest: false,
		bufferedParts: 0,
		streamedParts: 0,
		retries: 0,
		recompressions: 0,
		resentBytes: 0,
		paddingBytes: 0,
		...overrides
	};
}

function requestLog(fake: FakeS3): string[] {
	return fake.requests.map(
		(request) =>
			`${request.operation} ${request.outcome} ${String(request.bytes)}`
	);
}

function partLengths(fake: FakeS3): number[] {
	return fake.requests
		.filter(
			(request) =>
				request.operation === 'UploadPart' && request.outcome === 'ok'
		)
		.map((request) => request.bytes);
}

function storedObject(fake: FakeS3): {
	readonly size: number;
	readonly sha256: string;
} {
	return fingerprint(fake.objects().get(key) ?? new Uint8Array());
}

async function compressed(
	nar: Uint8Array,
	compression?: NarCompressionOptions
): Promise<Buffer> {
	const upload = compressNarToStream(
		MemoryNarSource.of(nar),
		nar.byteLength,
		compression
	);

	return Buffer.from(await new Response(upload.body).arrayBuffer());
}

// A NAR of a 16 MiB frame and a slightly shorter frame, compressed so that
// it is two parts less `gap` bytes long: the first frame keeps all but its
// last `gap` bytes and the second keeps none. When the second part starts,
// the compression ratio so far is 1, so the part is streamed, and its
// compressed bytes end `gap` bytes before the part does.
function earlyEndingNar(gap: number): {
	readonly nar: Uint8Array;
	readonly compression: NarCompressionOptions;
	readonly compressedSize: number;
} {
	const frame = 16 * mebibyte;

	return {
		nar: pseudoRandomBytes(2 * frame - 1, 14),
		compression: keepingPrefixes((length) =>
			length === frame ? frame - gap : 0
		),
		compressedSize: frame - gap
	};
}

function md5Hex(bytes: Uint8Array): string {
	return createHash('md5').update(bytes).digest('hex');
}

function paddedFingerprint(
	bytes: Uint8Array,
	padding: number
): { readonly size: number; readonly sha256: string } {
	return fingerprint(Buffer.concat([bytes, skippableFrame(padding)]));
}

function skippableFrame(size: number): Buffer {
	if (size === 0) {
		return Buffer.alloc(0);
	}

	const frame = Buffer.alloc(size);
	frame.writeUInt32LE(0x18_4d_2a_50, 0);
	frame.writeUInt32LE(size - 8, 4);

	return frame;
}

async function decode(bytes: Uint8Array | undefined): Promise<Uint8Array> {
	const decoded: Uint8Array[] = [];
	const decoder = new ZstdDecoder({
		chunkSize: mebibyte,
		windowLogMax: 23,
		onOutput: (chunk) => {
			decoded.push(Buffer.from(chunk));
		}
	});

	await decoder.write(bytes ?? new Uint8Array());
	await decoder.end();

	return Buffer.concat(decoded);
}

// The start and end of each part of the upload to `key`.
function fakeEventEntry(event: FakeS3Event): string[] {
	if (
		event.kind === 'start' &&
		event.key === key &&
		event.operation === 'UploadPart'
	) {
		return [`start ${String(event.partNumber)}`];
	}

	if (
		event.kind === 'end' &&
		event.request.key === key &&
		event.request.operation === 'UploadPart'
	) {
		return [`end ${String(event.request.partNumber)}`];
	}

	return [];
}

// For each part of the upload, whether the NAR was read between the start of
// the part's request and its end.
function partTimelines(
	log: readonly string[]
): { readonly part: number; readonly readsWhileSending: boolean }[] {
	const timelines: { part: number; readsWhileSending: boolean }[] = [];
	let current: { part: number; readsWhileSending: boolean } | undefined;

	for (const entry of log) {
		const [kind, value] = entry.split(' ', 2);

		if (kind === 'start') {
			current = { part: Number(value), readsWhileSending: false };
			continue;
		}

		if (kind === 'end' && current !== undefined) {
			timelines.push(current);
			current = undefined;
			continue;
		}

		if (kind === 'read' && current !== undefined) {
			current.readsWhileSending = true;
		}
	}

	return timelines;
}

async function rejectionOf(operation: Promise<unknown>): Promise<unknown> {
	try {
		await operation;
	} catch (error) {
		return error;
	}

	return undefined;
}
