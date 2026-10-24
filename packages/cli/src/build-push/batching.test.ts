import { createHash } from 'node:crypto';

import {
	NixStorePathNotFoundError,
	type NixValidPathInfo
} from '@cupboard/nix';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import {
	uploadActionDecisionSchema,
	uploadAttachRootSchema,
	type UploadDecisionInput,
	uploadDecisionSchema,
	type UploadNegotiateRequestInput,
	type UploadNegotiateResponse
} from '@cupboard/protocol/upload';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
	CommitSession,
	CommitSessionTarget
} from '../client/commit-socket.ts';
import {
	CliAbortError,
	PublicationUploadRequiredError,
	UploadVerificationFailedError
} from '../errors.ts';
import { byteStream } from '../io/byte-stream.ts';
import { SequentialNarSource } from '../nix/nar-source.ts';
import type { PushClient } from '../push/push.ts';

import {
	type BatchPathFailure,
	type BatchPathOutcome,
	type BatchSession,
	type BatchStore,
	BuildOutputBatcher
} from './batching.ts';

const pathA = storePathSchema.parse(
	'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app'
);
const pathB = storePathSchema.parse(
	'/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib'
);
const narHash = NixSha256Hash.fromDigest(Buffer.alloc(32, 0xaa));
const divergentNarHash = NixSha256Hash.fromDigest(Buffer.alloc(32, 0xbb));
const runRoot = uploadAttachRootSchema.parse({ name: 'github:acme/repo/run' });

function pathInfo(storePath: StorePathString): NixValidPathInfo {
	return {
		storePath,
		narHash,
		narSize: 4,
		references: [],
		signatures: [],
		ultimate: false
	};
}

function decisionFor(
	storePath: StorePathString,
	action: UploadDecisionInput['action']
) {
	const base = {
		storePathHash: StorePath.hash(storePath),
		narHash: narHash.toString()
	};

	if (action === 'skip') {
		return uploadDecisionSchema.parse({ action, ...base });
	}

	if (action === 'commit') {
		return uploadDecisionSchema.parse({
			action,
			...base,
			uploadId: `upload-${StorePath.basename(storePath)}`
		});
	}

	return uploadDecisionSchema.parse({
		action,
		...base,
		uploadId: `upload-${StorePath.basename(storePath)}`,
		r2Key: `staging/${StorePath.basename(storePath)}`,
		expiresAt: '2026-07-31T00:00:00.000Z'
	});
}

type NegotiateBody = Omit<UploadNegotiateRequestInput, 'pushId'>;

interface Harness {
	readonly batcher: BuildOutputBatcher;
	readonly events: string[];
	readonly negotiations: NegotiateBody[];
	readonly outcomes: BatchPathOutcome[];
	readonly failures: BatchPathFailure[];
	readonly expired: string[];
}

function emptyStream(): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.close();
		}
	});
}

interface HarnessOptions {
	readonly publicationFor?: PushClient['publicationFor'];
	readonly actions?: ReadonlyMap<
		StorePathString,
		UploadDecisionInput['action']
	>;
	readonly vanished?: ReadonlySet<StorePathString>;
	readonly failCommitsOnce?: ReadonlySet<StorePathString>;
	readonly failNegotiate?: boolean;
	/**
	Rejects every upload with this error.
	*/
	readonly uploadFailure?: Error;
	readonly decisions?: (
		paths: NegotiateBody['paths']
	) => UploadNegotiateResponse['uploads'];
	readonly maxEntries?: number;
	readonly uploadConcurrency?: number;
	/**
	Advances a fake clock by this many minutes for each upload. Negotiation
	gives each upload 15 minutes, and the harness refuses a commit that
	arrives after that.
	*/
	readonly uploadMinutes?: number;
	/**
	Use this shared session for every flush instead of opening another socket.
	*/
	readonly commitSession?: CommitSession;
	readonly compressedBody?: Uint8Array;
}

function harness(options: HarnessOptions = {}): Harness {
	const events: string[] = [];
	const negotiations: NegotiateBody[] = [];
	const outcomes: BatchPathOutcome[] = [];
	const failures: BatchPathFailure[] = [];
	const expired: string[] = [];
	const commitFailuresLeft = new Set(options.failCommitsOnce);
	const expiresAt = new Map<string, number>();
	let minutes = 0;

	const session: BatchSession = {
		protectPath: (storePath) => {
			events.push(`root:${StorePath.basename(storePath)}`);

			return Promise.resolve();
		},
		queryPathInfo: (storePath) => {
			events.push(`info:${StorePath.basename(storePath)}`);

			if (options.vanished?.has(storePath) === true) {
				return Promise.reject(new NixStorePathNotFoundError(storePath));
			}

			return Promise.resolve(pathInfo(storePath));
		}
	};
	const store: BatchStore = {
		withProtectedPaths: async (use) => {
			events.push('open');
			const result = await use(session);
			events.push('close');

			return result;
		}
	};
	const pathByHash = new Map([
		[StorePath.hash(pathA), pathA],
		[StorePath.hash(pathB), pathB]
	]);
	const client: PushClient = {
		...(options.publicationFor !== undefined && {
			publicationFor: options.publicationFor
		}),
		negotiate: (body) => {
			events.push('negotiate');
			negotiations.push(body);

			for (const path of body.paths) {
				expiresAt.set(path.storePathHash, minutes + 15);
			}

			if (options.failNegotiate === true) {
				return Promise.reject(new Error('negotiate refused'));
			}

			return Promise.resolve({
				uploads:
					options.decisions?.(body.paths) ??
					body.paths.map((path) => {
						const storePath = storePathSchema.parse(path.storePath);

						return decisionFor(
							storePath,
							options.actions?.get(storePath) ?? 'upload'
						);
					})
			});
		},
		preview: () => Promise.resolve({ uploads: [] }),
		uploadNar: async (r2Key, body) => {
			events.push(`upload:${r2Key}`);
			minutes += options.uploadMinutes ?? 0;

			if (options.uploadFailure !== undefined) {
				throw options.uploadFailure;
			}

			if (options.compressedBody !== undefined) {
				await Array.fromAsync(body);
			}
		},
		commit: (target) => {
			const storePath = pathByHash.get(target.storePathHash);
			const basename =
				storePath === undefined ? '?' : StorePath.basename(storePath);
			events.push(`commit:${basename}`);

			if (minutes > (expiresAt.get(target.storePathHash) ?? 0)) {
				expired.push(basename);

				return Promise.reject(new Error('upload expired'));
			}

			if (storePath !== undefined && commitFailuresLeft.has(storePath)) {
				commitFailuresLeft.delete(storePath);

				return Promise.reject(new Error('commit refused'));
			}

			return Promise.resolve({
				storePathHash: target.storePathHash,
				narHash: target.narHash,
				status: 'committed' as const,
				settled: Promise.resolve()
			});
		},
		setRoot: () => {
			throw new Error('setRoot is not part of a flush');
		}
	};

	const batcher = new BuildOutputBatcher({
		store,
		client,
		runRoot,
		createNarArchive: () => new SequentialNarSource(emptyStream),
		compressNar: () => ({
			body:
				options.compressedBody === undefined
					? new ReadableStream<Uint8Array>({
							cancel: (reason) => {
								events.push(
									`cancel:${reason instanceof Error ? reason.message : 'unknown'}`
								);
							}
						})
					: byteStream([options.compressedBody]),
			digest: () => ({ narHash, narSize: 4 })
		}),
		...(options.maxEntries !== undefined && { maxEntries: options.maxEntries }),
		...(options.uploadConcurrency !== undefined && {
			uploadConcurrency: options.uploadConcurrency
		}),
		...(options.commitSession !== undefined && {
			session: options.commitSession
		}),
		onOutcome: (outcome) => {
			outcomes.push(outcome);
		},
		onFailure: (failure) => {
			failures.push(failure);
		}
	});

	return { batcher, events, negotiations, outcomes, failures, expired };
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
	vi.useRealTimers();
});

describe('BuildOutputBatcher', () => {
	it('refuses a divergent committed NAR through the legacy protocol', async () => {
		const { batcher, outcomes, failures } = harness({
			actions: new Map([[pathA, 'commit']]),
			commitSession: {
				commit: (target) =>
					Promise.resolve({
						storePathHash: target.storePathHash,
						narHash: divergentNarHash.value,
						status: 'committed',
						settled: Promise.resolve()
					}),
				close: vi.fn()
			}
		});
		batcher.enqueue(pathA);
		await vi.advanceTimersByTimeAsync(500);
		await batcher.settled();
		expect({
			outcomes,
			candidates: batcher.candidates,
			failures: failures.map((failure) => ({
				storePath: failure.storePath,
				name: failure.reason instanceof Error ? failure.reason.name : undefined
			}))
		}).toStrictEqual({
			outcomes: [],
			candidates: [pathA],
			failures: [{ storePath: pathA, name: 'BuildOutputDivergedError' }]
		});
	});
	it.each([
		{ action: 'skip', refusals: 0, succeeds: true, transfers: 0, attempts: 1 },
		{ action: 'skip', refusals: 1, succeeds: true, transfers: 1, attempts: 2 },
		{
			action: 'commit',
			refusals: 1,
			succeeds: true,
			transfers: 1,
			attempts: 2
		},
		{
			action: 'commit',
			refusals: 2,
			succeeds: false,
			transfers: 1,
			attempts: 2
		},
		{
			action: 'upload',
			refusals: 1,
			succeeds: false,
			transfers: 1,
			attempts: 1
		}
	] as const)(
		'publishes $action with $refusals upload-required responses',
		async ({ action, refusals, succeeds, transfers, attempts }) => {
			const upload = uploadActionDecisionSchema.parse(
				decisionFor(pathA, 'upload')
			);
			const required = new PublicationUploadRequiredError(upload.uploadId);
			const compressedBody = Buffer.from('nar');
			let commitAttempts = 0;
			const commit = vi.fn<CommitSession['commit']>((target) => {
				commitAttempts += 1;
				if (commitAttempts <= refusals) {
					return Promise.reject(required);
				}
				return Promise.resolve({
					storePathHash: target.storePathHash,
					narHash: target.narHash,
					status: transfers === 0 ? 'already-present' : 'committed',
					settled: Promise.resolve()
				});
			});
			const { batcher, outcomes, failures, events } = harness({
				actions: new Map([[pathA, action]]),
				publicationFor: () => upload,
				commitSession: { commit, close: vi.fn() },
				compressedBody
			});
			batcher.enqueue(pathA);
			await vi.advanceTimersByTimeAsync(500);
			await batcher.settled();
			const identity = {
				uploadId: upload.uploadId,
				storePathHash: upload.storePathHash,
				narHash: upload.narHash
			};
			const blob = {
				fileHash: NixSha256Hash.fromDigest(
					createHash('sha256').update(compressedBody).digest()
				).value,
				fileSize: compressedBody.byteLength
			};
			expect({
				commits: commit.mock.calls.flat(),
				uploads: events.filter((event) => event.startsWith('upload:')),
				outcomes,
				failures,
				candidates: batcher.candidates
			}).toStrictEqual({
				commits: Array.from({ length: attempts }, (_, index) => ({
					...identity,
					...((action === 'upload' || index > 0) && { blob })
				})),
				uploads: Array.from(
					{ length: transfers },
					() => `upload:${upload.r2Key}`
				),
				outcomes: succeeds
					? [
							{
								outcome: transfers === 0 ? 'destination-served' : 'published',
								storePath: pathA
							}
						]
					: [],
				failures: succeeds ? [] : [{ storePath: pathA, reason: required }],
				candidates: succeeds ? [] : [pathA]
			});
		}
	);
	it('returns every path to the candidate set when negotiation omits decisions', async () => {
		const { batcher, failures } = harness({ decisions: () => [] });

		batcher.enqueue(pathA);
		batcher.enqueue(pathB);
		await vi.advanceTimersByTimeAsync(500);
		await batcher.settled();

		expect({
			candidates: batcher.candidates,
			failures: failures.map((failure) => ({
				storePath: failure.storePath,
				name: failure.reason instanceof Error ? failure.reason.name : undefined
			}))
		}).toStrictEqual({
			candidates: [pathA, pathB],
			failures: [
				{ storePath: pathA, name: 'UploadNegotiationMismatchError' },
				{ storePath: pathB, name: 'UploadNegotiationMismatchError' }
			]
		});
	});

	it('holds accepted paths until the debounce window lapses', async () => {
		const { batcher, events } = harness();

		batcher.enqueue(pathA);
		batcher.enqueue(pathB);
		await vi.advanceTimersByTimeAsync(499);

		expect({ events, candidates: batcher.candidates }).toStrictEqual({
			events: [],
			candidates: [pathA, pathB]
		});
	});

	it('flushes a debounced batch with the run root bound', async () => {
		const { batcher, events, negotiations, outcomes } = harness({
			actions: new Map([
				[pathA, 'upload'],
				[pathB, 'skip']
			])
		});

		batcher.enqueue(pathA);
		batcher.enqueue(pathB);
		await vi.advanceTimersByTimeAsync(500);
		await batcher.drain();

		expect({
			events,
			negotiations,
			outcomes,
			candidates: batcher.candidates,
			recorded: batcher.outcomes.values().toArray()
		}).toStrictEqual({
			events: [
				'open',
				`root:${StorePath.basename(pathA)}`,
				`root:${StorePath.basename(pathB)}`,
				`info:${StorePath.basename(pathA)}`,
				`info:${StorePath.basename(pathB)}`,
				'negotiate',
				`upload:staging/${StorePath.basename(pathA)}`,
				`commit:${StorePath.basename(pathA)}`,
				'close'
			],
			negotiations: [
				{
					paths: [
						{
							storePathHash: StorePath.hash(pathA),
							storePath: pathA,
							narHash: narHash.toString(),
							narSize: 4,
							references: [],
							deriver: undefined,
							ca: undefined
						},
						{
							storePathHash: StorePath.hash(pathB),
							storePath: pathB,
							narHash: narHash.toString(),
							narSize: 4,
							references: [],
							deriver: undefined,
							ca: undefined
						}
					],
					attachRoot: runRoot
				}
			],
			outcomes: [
				{ outcome: 'destination-served', storePath: pathB },
				{ outcome: 'published', storePath: pathA }
			],
			candidates: [],
			recorded: [
				{ outcome: 'destination-served', storePath: pathB },
				{ outcome: 'published', storePath: pathA }
			]
		});
	});

	it('commits each upload before starting the next with one upload worker', async () => {
		const { batcher, events } = harness({ uploadConcurrency: 1 });

		batcher.enqueue(pathA);
		batcher.enqueue(pathB);
		await vi.advanceTimersByTimeAsync(500);
		await batcher.drain();

		expect(
			events.filter(
				(event) =>
					event !== 'open' &&
					!event.startsWith('root:') &&
					!event.startsWith('info:')
			)
		).toStrictEqual([
			'negotiate',
			`upload:staging/${StorePath.basename(pathA)}`,
			`commit:${StorePath.basename(pathA)}`,
			'negotiate',
			`upload:staging/${StorePath.basename(pathB)}`,
			`commit:${StorePath.basename(pathB)}`,
			'close'
		]);
	});

	it('commits every upload before it expires when each upload takes ten minutes', async () => {
		const { batcher, expired, outcomes } = harness({
			uploadConcurrency: 1,
			uploadMinutes: 10
		});

		batcher.enqueue(pathA);
		batcher.enqueue(pathB);
		await vi.advanceTimersByTimeAsync(500);
		await batcher.drain();

		expect({ expired, outcomes }).toStrictEqual({
			expired: [],
			outcomes: [
				{ outcome: 'published', storePath: pathA },
				{ outcome: 'published', storePath: pathB }
			]
		});
	});

	it('returns a divergent destination skip to the candidate set', async () => {
		const { batcher, failures, outcomes } = harness({
			decisions: (paths) =>
				paths.map((path) =>
					uploadDecisionSchema.parse({
						action: 'skip',
						storePathHash: path.storePathHash,
						narHash: divergentNarHash.toString()
					})
				)
		});

		batcher.enqueue(pathA);
		await vi.advanceTimersByTimeAsync(500);
		await batcher.settled();

		expect({
			candidates: batcher.candidates,
			outcomes,
			failures: failures.map((failure) => ({
				storePath: failure.storePath,
				name: failure.reason instanceof Error ? failure.reason.name : undefined
			}))
		}).toStrictEqual({
			candidates: [pathA],
			outcomes: [],
			failures: [{ storePath: pathA, name: 'BuildOutputDivergedError' }]
		});
	});

	it('flushes at the batch bound without waiting', async () => {
		const { batcher, events } = harness({ maxEntries: 2 });

		batcher.enqueue(pathA);
		batcher.enqueue(pathB);
		await batcher.drain();

		expect({
			negotiateCount: events.filter((event) => event === 'negotiate').length,
			candidates: batcher.candidates
		}).toStrictEqual({ negotiateCount: 1, candidates: [] });
	});

	it('stops without starting a pending flush', async () => {
		const { batcher, events } = harness();

		batcher.enqueue(pathA);
		await batcher.stop();
		await vi.advanceTimersByTimeAsync(500);

		expect({ events, candidates: batcher.candidates }).toStrictEqual({
			events: [],
			candidates: [pathA]
		});
	});

	it('records a vanished path as collected and publishes the rest', async () => {
		const { batcher, outcomes, negotiations } = harness({
			vanished: new Set([pathB])
		});

		batcher.enqueue(pathA);
		batcher.enqueue(pathB);
		await vi.advanceTimersByTimeAsync(500);
		await batcher.drain();

		expect({
			outcomes,
			negotiatedPaths: negotiations.map((body) =>
				body.paths.map((path) => path.storePath)
			),
			candidates: batcher.candidates
		}).toStrictEqual({
			outcomes: [
				{ outcome: 'collected', storePath: pathB },
				{ outcome: 'published', storePath: pathA }
			],
			negotiatedPaths: [[pathA]],
			candidates: []
		});
	});

	it('returns a failed path to the candidate set and retries it on the next flush', async () => {
		const { batcher, outcomes, failures } = harness({
			failCommitsOnce: new Set([pathA])
		});

		batcher.enqueue(pathA);
		await vi.advanceTimersByTimeAsync(500);
		await batcher.settled();

		const afterFailure = {
			candidates: batcher.candidates,
			failureCount: failures.length,
			outcomes: [...outcomes]
		};

		batcher.enqueue(pathA);
		await batcher.drain();

		expect({
			afterFailure,
			outcomes,
			candidates: batcher.candidates
		}).toStrictEqual({
			afterFailure: { candidates: [pathA], failureCount: 1, outcomes: [] },
			outcomes: [{ outcome: 'published', storePath: pathA }],
			candidates: []
		});
	});

	it('cancels the NAR body when its upload fails', async () => {
		const { batcher, events } = harness({
			uploadFailure: new Error('upload refused')
		});

		batcher.enqueue(pathA);
		await vi.advanceTimersByTimeAsync(500);
		await batcher.settled();

		expect(events).toStrictEqual([
			'open',
			`root:${StorePath.basename(pathA)}`,
			`info:${StorePath.basename(pathA)}`,
			'negotiate',
			`upload:staging/${StorePath.basename(pathA)}`,
			'cancel:upload refused',
			'close'
		]);
	});

	it('does not enqueue a path whose outcome is recorded', async () => {
		const { batcher, events } = harness({
			actions: new Map([[pathA, 'skip']])
		});

		batcher.enqueue(pathA);
		await vi.advanceTimersByTimeAsync(500);
		await batcher.drain();
		batcher.enqueue(pathA);
		await batcher.drain();

		expect({
			negotiateCount: events.filter((event) => event === 'negotiate').length,
			candidates: batcher.candidates
		}).toStrictEqual({ negotiateCount: 1, candidates: [] });
	});

	it('returns the whole batch to the candidate set when negotiation fails', async () => {
		const { batcher, failures, outcomes } = harness({ failNegotiate: true });

		batcher.enqueue(pathA);
		batcher.enqueue(pathB);
		await vi.advanceTimersByTimeAsync(500);
		await batcher.settled();

		expect({
			outcomes,
			failedPaths: failures.map((failure) => failure.storePath),
			candidates: batcher.candidates
		}).toStrictEqual({
			outcomes: [],
			failedPaths: [pathA, pathB],
			candidates: [pathA, pathB]
		});
	});
});

// A run shares one commit session across every phase. Calling the client's
// `commit` method from a flush would open a second socket for the same run.
describe('BuildOutputBatcher over a shared commit session', () => {
	it.each(['servable', 'absent'] as const)(
		'keeps upload workers free before awaiting the %s deferred verdict',
		async (verdict) => {
			const deferred = Promise.withResolvers<undefined>();
			void deferred.promise.catch(() => {
				return;
			});
			const acknowledgements: string[] = [];
			const commitSession: CommitSession = {
				commit: (target) => {
					acknowledgements.push(target.uploadId);
					return Promise.resolve({
						storePathHash: target.storePathHash,
						narHash: target.narHash,
						status: 'pending' as const,
						settled:
							target.storePathHash === StorePath.hash(pathA)
								? deferred.promise
								: Promise.resolve()
					});
				},
				close() {
					throw new Error('the caller closes the shared session');
				}
			};
			const { batcher, events, failures } = harness({
				commitSession,
				uploadConcurrency: 1,
				maxEntries: 1
			});
			batcher.enqueue(pathA);
			await batcher.settled();
			batcher.enqueue(pathB);
			await batcher.settled();
			let isJoined = false;
			const joining = (async () => {
				await batcher.settleCommits();
				isJoined = true;
			})();
			await Promise.resolve();
			const beforeVerdict = {
				acknowledgements: [...acknowledgements],
				uploads: events.filter((event) => event.startsWith('upload:')),
				isJoined
			};
			const failure = new UploadVerificationFailedError('first', 'absent');
			if (verdict === 'absent') {
				deferred.reject(failure);
			} else {
				deferred.resolve(undefined);
			}
			await joining;
			expect({
				beforeVerdict,
				isJoined,
				outcomes: batcher.outcomes.values().toArray(),
				candidates: batcher.candidates,
				failures,
				pending: batcher.pendingCommits
			}).toStrictEqual({
				beforeVerdict: {
					acknowledgements: [
						`upload-${StorePath.basename(pathA)}`,
						`upload-${StorePath.basename(pathB)}`
					],
					uploads: [
						`upload:staging/${StorePath.basename(pathA)}`,
						`upload:staging/${StorePath.basename(pathB)}`
					],
					isJoined: false
				},
				isJoined: true,
				outcomes: [
					...(verdict === 'servable'
						? [{ outcome: 'published', storePath: pathA }]
						: []),
					{ outcome: 'published', storePath: pathB }
				],
				candidates: verdict === 'absent' ? [pathA] : [],
				failures:
					verdict === 'absent' ? [{ storePath: pathA, reason: failure }] : [],
				pending: 0
			});
		}
	);

	it('cancels the verdict join and clears pending state without closing the shared session', async () => {
		const deferred = Promise.withResolvers<undefined>();
		const controller = new AbortController();
		let isClosed = false;
		const commitSession: CommitSession = {
			commit: (target) =>
				Promise.resolve({
					...target,
					status: 'pending',
					settled: deferred.promise
				}),
			close: () => {
				isClosed = true;
			}
		};
		const { batcher, failures } = harness({ commitSession, maxEntries: 1 });
		batcher.enqueue(pathA);
		await batcher.settled();
		const joining = batcher.settleCommits(controller.signal);
		const rejection = expect(joining).rejects.toStrictEqual(
			new CliAbortError()
		);
		controller.abort(new CliAbortError());
		await rejection;
		await batcher.stop();
		deferred.reject(new UploadVerificationFailedError('cancelled', 'absent'));
		await Promise.resolve();
		expect({
			pending: batcher.pendingCommits,
			failures,
			isClosed
		}).toStrictEqual({ pending: 0, failures: [], isClosed: false });
	});

	it.each(['upload', 'commit'] as const)(
		'commits %s entries over the session with a declaration only for uploaded bytes',
		async (action) => {
			const bytes = Buffer.from('compressed NAR');
			const fileHash = NixSha256Hash.fromDigest(
				createHash('sha256').update(bytes).digest()
			).toString();
			const sessionCommits: CommitSessionTarget[] = [];
			const commitSession: CommitSession = {
				commit: (target) => {
					sessionCommits.push(target);

					return Promise.resolve({
						storePathHash: target.storePathHash,
						narHash: target.narHash,
						status: 'committed' as const,
						settled: Promise.resolve()
					});
				},
				close: () => {
					throw new Error('the run closes the session, not a flush');
				}
			};
			const { batcher, events, outcomes } = harness({
				commitSession,
				compressedBody: bytes,
				actions: new Map([[pathA, action]])
			});

			batcher.enqueue(pathA);
			await vi.advanceTimersByTimeAsync(500);
			await batcher.settled();

			expect({
				sessionCommits,
				clientCommits: events.filter((event) => event.startsWith('commit:')),
				outcomes
			}).toStrictEqual({
				sessionCommits: [
					{
						uploadId: `upload-${StorePath.basename(pathA)}`,
						storePathHash: StorePath.hash(pathA),
						narHash: narHash.toString(),
						...(action === 'upload' && {
							blob: { fileHash, fileSize: bytes.byteLength }
						})
					}
				],
				clientCommits: [],
				outcomes: [{ outcome: 'published', storePath: pathA }]
			});
		}
	);
});
