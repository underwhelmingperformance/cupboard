import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';

import {
	cacheGenerationSchema,
	cacheNameSchema,
	type CacheScope
} from '@cupboard/nix-store/scalars';
import {
	type PublicationLookupRequest,
	publicationLookupResponseSchema,
	publicationOperationIdSchema,
	publicationPathVersionSchema,
	publicationRequestIdSchema,
	recordedPublicationSchema
} from '@cupboard/protocol/publication-manifests';
import {
	initialPublicationCaptureCheckpoint,
	publicationCaptureBindingSchema,
	publicationCaptureCheckpointSchema,
	publicationCaptureCheckpointUpdateSchema,
	type PublicationWorkflowCaptureInput,
	type PublicationWorkflowExecutionContext
} from '@cupboard/protocol/publication-workflow';
import { pushIdSchema } from '@cupboard/protocol/upload';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { writePublicationFile } from '../build-push/publication-requests.ts';
import { recordingCacheScopedClient } from '../client/cache-scoped.test-support.ts';

import {
	createPublicationWorkflow,
	packPublicationRequests,
	type PublicationWorkflowClient,
	type PublicationWorkflowOptions
} from './publication-workflow.ts';

const cache: CacheScope = {
	kind: 'named',
	name: cacheNameSchema.parse('destination')
};
const generation = cacheGenerationSchema.parse(1);
const operationId = publicationOperationIdSchema.parse(
	'22222222-2222-4222-8222-222222222222'
);
const requestId = publicationRequestIdSchema.parse(
	'33333333-3333-4333-8333-333333333333'
);
const path = publicationPathVersionSchema.parse({
	storePath: '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app',
	narHash: `sha256:${'0'.repeat(52)}`,
	generation: 1
});
const publication = recordedPublicationSchema.parse({
	result: { ...path, cache, cacheGeneration: generation },
	digest: 'a'.repeat(64),
	memberCount: 1,
	origin: 'build-selection'
});
const lookupResponse = publicationLookupResponseSchema.parse({
	entries: [{ kind: 'missing', result: publication.result }]
});

function fixture(
	overrides: Partial<PublicationWorkflowClient['publication']> = {},
	options: Partial<PublicationWorkflowOptions> = {}
) {
	const lookup = recordingCacheScopedClient(() =>
		Promise.resolve(lookupResponse)
	);
	const captureBegin = recordingCacheScopedClient(() =>
		Promise.resolve({
			kind: 'staging',
			operationId,
			expiresAt: '2099-01-01T00:00:00.000Z'
		})
	);
	const capturePage = recordingCacheScopedClient(
		(input: {
			operationId: typeof operationId;
			page: number;
			members: (typeof path)[];
		}) =>
			Promise.resolve({
				operationId,
				page: input.page,
				acceptedCount: input.members.length
			})
	);
	const captureSeal = recordingCacheScopedClient(() =>
		Promise.resolve({ kind: 'captured', association: 'created', publication })
	);
	const ensure = recordingCacheScopedClient(() =>
		Promise.resolve({
			kind: 'complete',
			association: 'existing',
			publication: { ...publication, materialisation: 'complete' }
		})
	);
	const status = recordingCacheScopedClient(() =>
		Promise.resolve({ kind: 'pending', operationId })
	);
	const plan = recordingCacheScopedClient(() =>
		Promise.resolve({
			cacheGeneration: generation,
			pushExpiresAt: '2099-01-01T00:00:00.000Z',
			uploads: []
		})
	);
	const client: PublicationWorkflowClient = {
		publication: {
			lookup,
			captureBegin,
			capturePage,
			captureSeal,
			ensure,
			status,
			...overrides
		},
		plan
	};
	const sleep = vi.fn(() => Promise.resolve());
	const workflow = createPublicationWorkflow(cache, client, {
		pushId: () => Promise.resolve(pushIdSchema.parse('push')),
		sleep,
		...options
	});
	return {
		workflow,
		lookup,
		captureBegin,
		capturePage,
		captureSeal,
		ensure,
		status,
		plan,
		sleep
	};
}

// Exclusive, sequential test owner; reopen the file rather than retaining model state.
async function persistedCapture(input: PublicationWorkflowCaptureInput) {
	const directory = await mkdtemp(
		nodePath.join(tmpdir(), 'cupboard-capture-checkpoint-')
	);
	onTestFinished(() => rm(directory, { recursive: true, force: true }));
	const file = nodePath.join(directory, 'checkpoint.json');
	const binding = publicationCaptureBindingSchema.parse({
		invocation: 'a'.repeat(64),
		tenantUrl: 'https://cupboard.example.workers.dev/t/acme',
		cache,
		input
	});
	await writePublicationFile(
		file,
		JSON.stringify(initialPublicationCaptureCheckpoint(binding))
	);
	const reopen = (): PublicationWorkflowExecutionContext => ({
		capture: {
			binding,
			store: {
				load: async () => JSON.parse(await readFile(file, 'utf8')) as unknown,
				save: async (expected, next) => {
					const actual = publicationCaptureCheckpointSchema.parse(
						JSON.parse(await readFile(file, 'utf8'))
					);
					expect(actual).toEqual(expected);
					publicationCaptureCheckpointUpdateSchema.parse({
						previous: actual,
						next
					});
					await writePublicationFile(file, JSON.stringify(next));
				}
			}
		}
	});
	return {
		file,
		binding,
		reopen,
		read: async () =>
			publicationCaptureCheckpointSchema.parse(
				JSON.parse(await readFile(file, 'utf8'))
			)
	};
}

describe('publication workflow', () => {
	it('looks up exact results in the destination route without treating a missing association as an absent path', async () => {
		const { workflow, lookup } = fixture();
		await expect(
			workflow.lookup({ source: { cache }, results: [path] })
		).resolves.toEqual(lookupResponse);
		expect(lookup.calls[0]?.cache).toEqual(cache);
	});
	it('rejects reordered or differently fenced lookup results', async () => {
		const { workflow } = fixture();
		await expect(
			workflow.lookup({
				source: { cache },
				results: [
					{
						...path,
						generation: publicationPathVersionSchema.parse({
							...path,
							generation: 2
						}).generation
					}
				]
			})
		).rejects.toThrow('identity');
	});
	it('captures exact destination versions with a fixed request ID and no ensure certificate', async () => {
		const { workflow, captureBegin, capturePage, ensure } = fixture();
		await expect(
			workflow.capture({
				result: path,
				members: [path],
				origin: 'build-selection',
				requestId
			})
		).resolves.toEqual(publication);
		expect(captureBegin.calls[0]?.input).toMatchObject({
			result: path,
			expectedCacheGeneration: generation,
			requestId,
			memberCount: 1
		});
		expect(capturePage.calls[0]?.input.members).toEqual([path]);
		expect(ensure.calls).toHaveLength(0);
	});
	it('obtains authoritative destination generation from read-only planning before ensure', async () => {
		const { workflow, plan, ensure } = fixture();
		await workflow.ensure({ source: publication, requestId });
		expect(plan.calls[0]?.input).toMatchObject({ pushId: 'push', paths: [] });
		expect(ensure.calls[0]?.input).toMatchObject({
			source: publication,
			expectedDestinationGeneration: generation,
			requestId
		});
	});
	it('packs by actual UTF-8 bytes and count, rejecting an individually oversized input', () => {
		const maximumBytes = Buffer.byteLength(
			JSON.stringify(membersBody(['é', 'é']))
		);
		expect(
			packPublicationRequests(['é', 'é', 'é'], 64, membersBody, maximumBytes)
		).toEqual([['é', 'é'], ['é']]);
		expect(
			packPublicationRequests(['a', 'b', 'c'], 2, membersBody, 100)
		).toEqual([['a', 'b'], ['c']]);
		expect(() => packPublicationRequests(['éé'], 64, membersBody, 10)).toThrow(
			'bytes'
		);
	});
});

it('continues bounded seal steps with backoff rather than polling observation-only status', async () => {
	let steps = 0;
	const seal = recordingCacheScopedClient(() =>
		Promise.resolve(
			++steps < 3
				? { kind: 'pending', operationId }
				: { kind: 'captured', association: 'created', publication }
		)
	);
	const { workflow, sleep, status } = fixture({ captureSeal: seal });
	await expect(
		workflow.capture({
			result: path,
			members: [path],
			origin: 'build-selection'
		})
	).resolves.toEqual(publication);
	expect(seal.calls).toHaveLength(3);
	expect(sleep.mock.calls).toHaveLength(2);
	expect(status.calls).toHaveLength(0);
});

it('never treats captured status as an ensure certificate', async () => {
	const { workflow } = fixture({
		ensure: recordingCacheScopedClient(() =>
			Promise.resolve({ kind: 'pending', operationId })
		),
		status: recordingCacheScopedClient(() =>
			Promise.resolve({ kind: 'captured', association: 'created', publication })
		)
	});
	await expect(workflow.ensure({ source: publication })).rejects.toThrow(
		'not a complete materialisation'
	);
});

it.each([
	'result-changed',
	'source-unavailable',
	'scope-changed',
	'generation-conflict',
	'divergence',
	'expired',
	'temporary-failure'
])('reports ensure failure %s without a fallback', async (reason) => {
	const { workflow } = fixture({
		ensure: recordingCacheScopedClient(() =>
			Promise.resolve({ kind: 'pending', operationId })
		),
		status: recordingCacheScopedClient(() =>
			Promise.resolve({ kind: 'failed', reason })
		)
	});
	await expect(workflow.ensure({ source: publication })).rejects.toThrow(
		reason
	);
});

it('advances ensure by replaying the exact request while status only observes', async () => {
	const sourceSelector = { view: 'builds', expectedRevision: 7 };
	const { publicationWorkflowEnsureInputSchema } =
		await import('@cupboard/protocol/publication-workflow');
	const input = publicationWorkflowEnsureInputSchema.parse({
		source: publication,
		sourceSelector,
		runRoot: 'github:acme/app/run-1',
		requestId
	});
	let steps = 0;
	const ensure = recordingCacheScopedClient(() =>
		Promise.resolve(
			++steps < 6
				? { kind: 'pending', operationId }
				: {
						kind: 'complete',
						association: 'created',
						publication: { ...publication, materialisation: 'complete' }
					}
		)
	);
	let observations = 0;
	const status = recordingCacheScopedClient(() => {
		if (++observations > 5) {
			throw new Error('Observation-only status cannot advance ensure.');
		}
		return Promise.resolve({ kind: 'pending', operationId });
	});
	const sleep = vi.fn((_ms: number) => Promise.resolve());
	const { workflow, plan } = fixture({ ensure, status }, { sleep });
	await expect(workflow.ensure(input)).resolves.toMatchObject({
		materialisation: 'complete'
	});
	expect(ensure.calls).toHaveLength(6);
	for (const call of ensure.calls) {
		expect(call.input).toEqual({
			...input,
			cacheName: 'destination',
			expectedDestinationGeneration: generation
		});
	}
	expect(plan.calls).toHaveLength(1);
	expect(status.calls).toHaveLength(5);
	for (const call of status.calls) {
		expect(call.input).toMatchObject({ operationId });
	}
	// Pending work has no progress cursor: do not exponentially delay every successful member batch.
	expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([250, 250, 250, 250, 250]);
});

it.each([
	{ digest: 'b'.repeat(64) },
	{ result: { ...publication.result, cacheGeneration: 2 } }
])(
	'rejects a complete ensure for a different destination generation or portable set: %j',
	async (changed) => {
		const { workflow } = fixture({
			ensure: recordingCacheScopedClient(() =>
				Promise.resolve({
					kind: 'complete',
					association: 'created',
					publication: {
						...publication,
						...changed,
						materialisation: 'complete'
					}
				})
			)
		});
		await expect(workflow.ensure({ source: publication })).rejects.toThrow(
			'identity'
		);
	}
);

it('permits unavailable bare lookups but never invents a version for capture or fenced lookup', async () => {
	const lookup = recordingCacheScopedClient(() =>
		Promise.resolve({
			entries: [{ kind: 'unavailable', storePath: path.storePath }]
		})
	);
	const { workflow, captureBegin } = fixture({ lookup });
	await expect(
		workflow.lookup({
			source: { cache },
			results: [{ storePath: path.storePath }]
		})
	).resolves.toMatchObject({ entries: [{ kind: 'unavailable' }] });
	await expect(
		workflow.lookup({ source: { cache }, results: [path] })
	).rejects.toThrow('identity');
	await expect(
		workflow.capture({
			result: { storePath: path.storePath },
			members: [path],
			origin: 'build-selection'
		})
	).rejects.toThrow('unavailable');
	expect(captureBegin.calls).toHaveLength(0);
});

it('preserves supplied fences and rejects inconsistent duplicate members before capture', async () => {
	const { workflow, captureBegin } = fixture();
	const conflictingHash = publicationPathVersionSchema.parse({
		...path,
		narHash: `sha256:${'1'.repeat(52)}`
	}).narHash;
	await expect(
		workflow.capture({
			result: path,
			members: [
				path,
				{
					...path,
					narHash: conflictingHash
				}
			],
			origin: 'build-selection'
		})
	).rejects.toThrow('identity');
	expect(captureBegin.calls).toHaveLength(0);
});

it('packs capture and lookup requests below the raw-byte limit, even for long paths', async () => {
	const members = Array.from({ length: 65 }, (_, index) =>
		publicationPathVersionSchema.parse({
			...path,
			storePath: `/${'s'.repeat(230)}/store/0123456789abcdfghijklmnpqrsvwxyz-${String(index)}-${'x'.repeat(200)}`
		})
	);
	const result = members[0];
	expect(result).toBeDefined();
	if (result === undefined) {
		return;
	}
	const captured = {
		...publication,
		result: { ...publication.result, ...result },
		memberCount: 65
	};
	const lookup = recordingCacheScopedClient((input: PublicationLookupRequest) =>
		Promise.resolve({
			entries: input.results.map((member) => ({
				kind: 'missing',
				result: { ...path, ...member, cache, cacheGeneration: generation }
			}))
		})
	);
	const seal = recordingCacheScopedClient(() =>
		Promise.resolve({
			kind: 'captured',
			association: 'created',
			publication: captured
		})
	);
	const { workflow, capturePage } = fixture({ lookup, captureSeal: seal });
	await workflow.capture({
		result,
		members,
		origin: 'build-selection',
		requestId
	});
	expect(capturePage.calls.length).toBeGreaterThan(1);
	for (const call of [...capturePage.calls, ...lookup.calls]) {
		expect(Buffer.byteLength(JSON.stringify(call.input))).toBeLessThanOrEqual(
			64 * 1024
		);
	}
	expect(capturePage.calls.flatMap((call) => call.input.members)).toEqual(
		members
	);
});

it('retries an immutable page after a bounded request deadline with the same operation and fixed begin ID', async () => {
	vi.useFakeTimers();
	try {
		let attempts = 0;
		const page = recordingCacheScopedClient(
			(input: {
				operationId: typeof operationId;
				page: number;
				members: (typeof path)[];
			}) =>
				++attempts === 1
					? new Promise<never>(() => {
							/*
							This attempt deliberately waits past its deadline.
							*/
						})
					: Promise.resolve({
							operationId,
							page: input.page,
							acceptedCount: input.members.length
						})
		);
		const { workflow, captureBegin } = fixture(
			{ capturePage: page },
			{ requestDeadlineMs: 10 }
		);
		const pending = workflow.capture({
			result: path,
			members: [path],
			origin: 'build-selection',
			requestId
		});
		const assertion = expect(pending).resolves.toEqual(publication);
		await vi.advanceTimersByTimeAsync(2000);
		await assertion;
		expect(page.calls).toHaveLength(2);
		expect(page.calls[0]?.input).toEqual(page.calls[1]?.input);
		expect(captureBegin.calls[0]?.input).toMatchObject({ requestId });
	} finally {
		vi.useRealTimers();
	}
});

it('cancels a pending ensure and bounds seal continuation by an overall deadline', async () => {
	const controller = new AbortController();
	const cancelled = new Error('cancelled');
	const { workflow } = fixture(
		{
			ensure: recordingCacheScopedClient(() =>
				Promise.resolve({ kind: 'pending', operationId })
			)
		},
		{
			signal: controller.signal,
			sleep: () => {
				controller.abort(cancelled);
				return Promise.resolve();
			}
		}
	);
	await expect(workflow.ensure({ source: publication })).rejects.toBe(
		cancelled
	);
	const seal = recordingCacheScopedClient(() =>
		Promise.resolve({ kind: 'pending', operationId })
	);
	const bounded = fixture(
		{ captureSeal: seal },
		{
			timeoutMs: 10,
			sleep: (_ms, signal) =>
				new Promise((_resolve, reject) =>
					signal?.addEventListener(
						'abort',
						() => {
							reject(new Error('deadline aborted'));
						},
						{
							once: true
						}
					)
				)
		}
	);
	await expect(
		bounded.workflow.capture({
			result: path,
			members: [path],
			origin: 'build-selection'
		})
	).rejects.toThrow('deadline');
	expect(seal.calls).toHaveLength(1);
});

it('rejects a replacement generation after reopening a persisted capture whose completed response was lost (modelled RPC remote)', async () => {
	const controller = new AbortController();
	const lostResponse = new Error('capture response lost');
	let accepted: typeof publication | undefined;
	const lookup = recordingCacheScopedClient(() =>
		Promise.resolve({
			entries: [
				accepted === undefined
					? { kind: 'missing', result: publication.result }
					: { kind: 'recorded', publication: accepted, complete: true }
			]
		})
	);
	const seal = recordingCacheScopedClient(() => {
		// Model remote completion before the caller receives its response.
		accepted = publication;
		controller.abort(lostResponse);
		return Promise.resolve({
			kind: 'captured',
			association: 'created',
			publication
		});
	});
	const input = {
		result: { storePath: path.storePath, narHash: path.narHash },
		members: [{ storePath: path.storePath, narHash: path.narHash }],
		origin: 'build-selection' as const,
		requestId
	};
	const persisted = await persistedCapture(input);
	const interrupted = fixture(
		{ lookup, captureSeal: seal },
		{ signal: controller.signal }
	);
	await expect(
		interrupted.workflow.capture(input, persisted.reopen())
	).rejects.toBe(lostResponse);
	expect(interrupted.captureBegin.calls).toEqual([
		{
			cache,
			input: {
				result: path,
				expectedCacheGeneration: generation,
				requestId,
				origin: 'build-selection',
				memberCount: 1,
				cacheName: 'destination'
			}
		}
	]);
	expect(interrupted.capturePage.calls).toEqual([
		{
			cache,
			input: { operationId, page: 0, members: [path], cacheName: 'destination' }
		}
	]);
	expect(accepted).toEqual(publication);
	// The same path and NAR are now accepted under another generation/set.
	accepted = recordedPublicationSchema.parse({
		...publication,
		result: { ...publication.result, generation: 2 },
		digest: 'b'.repeat(64),
		memberCount: 2
	});
	const replayBegin = recordingCacheScopedClient(
		(request: { result: typeof path }) => {
			// Model the server's exact accepted-generation check, not a receipt cache.
			if (request.result.generation !== accepted?.result.generation) {
				throw new Error('identity changed');
			}
			return Promise.resolve({ kind: 'existing', publication: accepted });
		}
	);
	const recovered = fixture({ lookup, captureBegin: replayBegin });
	await expect(
		recovered.workflow.capture(input, persisted.reopen())
	).rejects.toThrow('identity');
	expect(replayBegin.calls).toEqual(interrupted.captureBegin.calls);
	expect(recovered.ensure.calls).toEqual([]);
});

function membersBody(values: readonly string[]) {
	return { members: values };
}

it('validates ordering, not just lookup cardinality', async () => {
	const second = publicationPathVersionSchema.parse({
		...path,
		storePath: '/nix/store/3123456789abcdfghijklmnpqrsvwxyz-runtime'
	});
	const lookup = recordingCacheScopedClient(() =>
		Promise.resolve({
			entries: [
				{ kind: 'missing', result: { ...publication.result, ...second } },
				{ kind: 'missing', result: publication.result }
			]
		})
	);
	const { workflow } = fixture({ lookup });
	await expect(
		workflow.lookup({ source: { cache }, results: [path, second] })
	).rejects.toThrow('identity');
});

it('pins the resolved source-view revision across ordered lookup batches', async () => {
	const results = Array.from({ length: 65 }, (_, index) => ({
		storePath: publicationPathVersionSchema.parse({
			...path,
			storePath: `/nix/store/0123456789abcdfghijklmnpqrsvwxyz-${String(index)}`
		}).storePath
	}));
	const { publicationLookupRequestSchema } =
		await import('@cupboard/protocol/publication-manifests');
	const input = publicationLookupRequestSchema.parse({
		source: { selector: { view: 'builds' } },
		results: results.slice(0, 1)
	});
	const lookup = recordingCacheScopedClient(
		(request: PublicationLookupRequest) =>
			Promise.resolve({
				entries: request.results.map((result) => ({
					kind: 'missing',
					result: { ...publication.result, ...result }
				})),
				sourceSelector: { view: 'builds', expectedRevision: 7 }
			})
	);
	const { workflow } = fixture({ lookup });
	const answer = await workflow.lookup({ ...input, results });
	expect(answer.entries).toHaveLength(65);
	expect(lookup.calls.map((call) => call.input.results.length)).toEqual([
		64, 1
	]);
	expect(lookup.calls[1]?.input.source.selector?.expectedRevision).toBe(7);
});

it('does not accept a capture page receipt for a different page or accepted count', async () => {
	const { workflow, captureSeal } = fixture({
		capturePage: recordingCacheScopedClient(() =>
			Promise.resolve({ operationId, page: 1, acceptedCount: 1 })
		)
	});
	await expect(
		workflow.capture({
			result: path,
			members: [path],
			origin: 'build-selection'
		})
	).rejects.toThrow('identity');
	expect(captureSeal.calls).toHaveLength(0);
});

it('rejects an ensure status that switches durable operation IDs', async () => {
	const { workflow } = fixture({
		ensure: recordingCacheScopedClient(() =>
			Promise.resolve({ kind: 'pending', operationId })
		),
		status: recordingCacheScopedClient(() =>
			Promise.resolve({
				kind: 'pending',
				operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
			})
		)
	});
	await expect(workflow.ensure({ source: publication })).rejects.toThrow(
		'identity'
	);
});

it('accepts observed terminal ensure completion without asking status to advance', async () => {
	const ensure = recordingCacheScopedClient(() =>
		Promise.resolve({ kind: 'pending', operationId })
	);
	const status = recordingCacheScopedClient(() =>
		Promise.resolve({
			kind: 'complete',
			association: 'created',
			publication: { ...publication, materialisation: 'complete' }
		})
	);
	const { workflow, sleep } = fixture({ ensure, status });
	await expect(workflow.ensure({ source: publication })).resolves.toMatchObject(
		{ materialisation: 'complete' }
	);
	expect(ensure.calls).toHaveLength(1);
	expect(status.calls).toHaveLength(1);
	expect(sleep).not.toHaveBeenCalled();
});

it('rejects ensure continuation that switches operation identity', async () => {
	let calls = 0;
	const ensure = recordingCacheScopedClient(() =>
		Promise.resolve({
			kind: 'pending',
			operationId:
				++calls === 1 ? operationId : 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
		})
	);
	const { workflow, status } = fixture({ ensure });
	await expect(workflow.ensure({ source: publication })).rejects.toThrow(
		'identity'
	);
	expect(ensure.calls).toHaveLength(2);
	expect(status.calls).toHaveLength(1);
});

it('keeps the generated ensure UUID and immutable body across request timeout retries and continuation', async () => {
	vi.useFakeTimers();
	try {
		let attempts = 0;
		const ensure = recordingCacheScopedClient(() => {
			attempts += 1;
			if (attempts === 1) {
				return new Promise<never>(() => {
					/*
					The lost response is retried under its original identity.
					*/
				});
			}
			return Promise.resolve(
				attempts === 2
					? { kind: 'pending', operationId }
					: {
							kind: 'complete',
							association: 'existing',
							publication: { ...publication, materialisation: 'complete' }
						}
			);
		});
		const input = { source: structuredClone(publication) };
		const { workflow, plan } = fixture(
			{ ensure },
			{
				requestDeadlineMs: 10,
				sleep: () => {
					input.source.digest = recordedPublicationSchema.parse({
						...publication,
						digest: 'b'.repeat(64)
					}).digest;
					return Promise.resolve();
				}
			}
		);
		const assertion = expect(workflow.ensure(input)).resolves.toMatchObject({
			digest: publication.digest
		});
		await vi.advanceTimersByTimeAsync(2000);
		await assertion;
		expect(ensure.calls).toHaveLength(3);
		const first = ensure.calls[0]?.input;
		expect(first).toMatchObject({
			source: publication,
			expectedDestinationGeneration: generation
		});
		expect(first).toHaveProperty(
			'requestId',
			expect.stringMatching(/^[0-9a-f-]{36}$/)
		);
		for (const call of ensure.calls.slice(1)) {
			expect(call.input).toEqual(first);
		}
		expect(plan.calls).toHaveLength(1);
	} finally {
		vi.useRealTimers();
	}
});

it('keeps the original overall ensure deadline across pending continuation', async () => {
	vi.useFakeTimers();
	try {
		const ensure = recordingCacheScopedClient(() =>
			Promise.resolve({ kind: 'pending', operationId })
		);
		const { workflow, plan } = fixture(
			{ ensure },
			{
				timeoutMs: 1000,
				sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
			}
		);
		const assertion = expect(
			workflow.ensure({ source: publication, requestId })
		).rejects.toThrow('deadline');
		await vi.advanceTimersByTimeAsync(1000);
		await assertion;
		const count = ensure.calls.length;
		expect(count).toBeGreaterThan(1);
		await vi.advanceTimersByTimeAsync(5000);
		expect(ensure.calls).toHaveLength(count);
		expect(plan.calls).toHaveLength(1);
		for (const call of ensure.calls) {
			expect(call.input).toEqual(ensure.calls[0]?.input);
		}
	} finally {
		vi.useRealTimers();
	}
});

it('accepts the authoritative destination winner origin for identical membership', async () => {
	const winner = {
		...publication,
		origin: 'legacy-selection' as const,
		materialisation: 'complete' as const
	};
	const { workflow } = fixture({
		ensure: recordingCacheScopedClient(() =>
			Promise.resolve({
				kind: 'complete',
				association: 'existing',
				publication: winner
			})
		)
	});
	await expect(workflow.ensure({ source: publication })).resolves.toEqual(
		winner
	);
});

it('returns the initial recorded capture winner without resolving a disappearing losing member', async () => {
	const losing = publicationPathVersionSchema.parse({
		...path,
		storePath: '/nix/store/3123456789abcdfghijklmnpqrsvwxyz-losing'
	});
	const lookup = recordingCacheScopedClient((input: PublicationLookupRequest) =>
		Promise.resolve({
			entries: input.results.map((target) =>
				target.storePath === losing.storePath
					? { kind: 'unavailable', storePath: losing.storePath }
					: { kind: 'recorded', publication, complete: true }
			)
		})
	);
	const { workflow, captureBegin, capturePage } = fixture({ lookup });
	await expect(
		workflow.capture({
			result: path,
			members: [path, losing],
			origin: 'legacy-selection'
		})
	).resolves.toEqual(publication);
	expect(lookup.calls).toHaveLength(1);
	expect(captureBegin.calls).toHaveLength(0);
	expect(capturePage.calls).toHaveLength(0);
});

it.each(['begin', 'page', 'seal'] as const)(
	'reopens exact persisted %s requests without resolving changed member versions (modelled RPC remote)',
	async (boundary) => {
		const input = {
			result: path,
			members: [path],
			origin: 'build-selection' as const,
			requestId
		};
		const persisted = await persistedCapture(input);
		const controller = new AbortController();
		const interrupted = new Error(`lost ${boundary}`);
		const begin = recordingCacheScopedClient(async () => {
			const disk = await persisted.read();
			expect(disk).toEqual({
				version: 1,
				binding: persisted.binding,
				state: {
					phase: 'resolved',
					capture: {
						result: publication.result,
						begin: {
							result: path,
							expectedCacheGeneration: generation,
							requestId,
							origin: 'build-selection',
							memberCount: 1
						},
						pages: [[path]]
					}
				}
			});
			if (boundary === 'begin') {
				controller.abort(interrupted);
			}
			return {
				kind: 'staging',
				operationId,
				expiresAt: '2099-01-01T00:00:00.000Z'
			};
		});
		const page = recordingCacheScopedClient(async () => {
			const disk = await persisted.read();
			expect(disk.state).toEqual({
				phase: 'begun',
				operationId,
				capture: {
					result: publication.result,
					begin: {
						result: path,
						expectedCacheGeneration: generation,
						requestId,
						origin: 'build-selection',
						memberCount: 1
					},
					pages: [[path]]
				}
			});
			if (boundary === 'page') {
				controller.abort(interrupted);
			}
			return { operationId, page: 0, acceptedCount: 1 };
		});
		const seal = recordingCacheScopedClient(() => {
			if (boundary === 'seal') {
				controller.abort(interrupted);
			}
			return Promise.resolve({
				kind: 'captured',
				association: 'created',
				publication
			});
		});
		const first = fixture(
			{ captureBegin: begin, capturePage: page, captureSeal: seal },
			{ signal: controller.signal }
		);
		await expect(
			first.workflow.capture(input, persisted.reopen())
		).rejects.toBe(interrupted);
		const lookup = recordingCacheScopedClient(() =>
			Promise.reject(new Error('Fresh member lookup forbidden during recovery'))
		);
		const second = fixture({ lookup });
		await expect(
			second.workflow.capture(input, persisted.reopen())
		).resolves.toEqual(publication);
		expect(lookup.calls).toEqual([]);
		expect(second.captureBegin.calls).toEqual(begin.calls);
		expect(second.capturePage.calls).toEqual([
			{
				cache,
				input: {
					operationId,
					page: 0,
					members: [path],
					cacheName: 'destination'
				}
			}
		]);
		const completedCheckpoint = await persisted.read();
		expect(completedCheckpoint.state).toEqual({
			phase: 'captured',
			operationId,
			publication,
			capture: {
				result: publication.result,
				begin: {
					result: path,
					expectedCacheGeneration: generation,
					requestId,
					origin: 'build-selection',
					memberCount: 1
				},
				pages: [[path]]
			}
		});
	}
);

it('replays completed captures through original begin and current server authority, not cached success', async () => {
	const input = {
		result: path,
		members: [path],
		origin: 'build-selection' as const,
		requestId
	};
	const persisted = await persistedCapture(input);
	const first = fixture();
	await expect(
		first.workflow.capture(input, persisted.reopen())
	).resolves.toEqual(publication);
	const denied = recordingCacheScopedClient(() =>
		Promise.reject(new Error('current authority denied'))
	);
	const replay = fixture({ captureBegin: denied });
	await expect(
		replay.workflow.capture(input, persisted.reopen())
	).rejects.toThrow('current authority denied');
	expect(denied.calls).toEqual(first.captureBegin.calls);
	expect(replay.lookup.calls).toEqual([]);
	expect(replay.capturePage.calls).toEqual([]);
	expect(replay.ensure.calls).toEqual([]);
});

it('persists an initial bounded winner and fences its set on replay without resolving losing members', async () => {
	const losing = publicationPathVersionSchema.parse({
		...path,
		storePath: '/nix/store/3123456789abcdfghijklmnpqrsvwxyz-losing'
	});
	const input = {
		result: path,
		members: [path, losing],
		origin: 'legacy-selection' as const,
		requestId
	};
	const persisted = await persistedCapture(input);
	const lookup = recordingCacheScopedClient(() =>
		Promise.resolve({
			entries: [{ kind: 'recorded', publication, complete: true }]
		})
	);
	const initial = fixture({ lookup });
	await expect(
		initial.workflow.capture(input, persisted.reopen())
	).resolves.toEqual(publication);
	const shortcutCheckpoint = await persisted.read();
	expect(shortcutCheckpoint.state).toEqual({
		phase: 'shortcut',
		publication
	});
	expect(lookup.calls).toEqual([
		{
			cache,
			input: { source: { cache }, results: [path], cacheName: 'destination' }
		}
	]);
	expect(initial.captureBegin.calls).toEqual([]);
	const replacement = { ...publication, digest: 'b'.repeat(64) };
	const changed = recordingCacheScopedClient(() =>
		Promise.resolve({
			entries: [{ kind: 'recorded', publication: replacement, complete: true }]
		})
	);
	const replay = fixture({ lookup: changed });
	await expect(
		replay.workflow.capture(input, persisted.reopen())
	).rejects.toThrow('identity');
	expect(changed.calls).toEqual([
		{
			cache,
			input: {
				source: { cache, expectedCacheGeneration: generation },
				results: [path],
				cacheName: 'destination'
			}
		}
	]);
	expect(replay.captureBegin.calls).toEqual([]);
});

it.each(['resolved', 'begun'] as const)(
	'a failed %s checkpoint write prevents the next remote mutation',
	async (phase) => {
		const input = {
			result: path,
			members: [path],
			origin: 'build-selection' as const,
			requestId
		};
		const persisted = await persistedCapture(input);
		const context = persisted.reopen();
		const recovery = context.capture;
		if (recovery === undefined) {
			throw new Error('Missing test recovery');
		}
		const save = recovery.store.save.bind(recovery.store);
		const writeFailure = new Error('durable write failed');
		const broken: PublicationWorkflowExecutionContext = {
			capture: {
				...recovery,
				store: {
					...recovery.store,
					save: (expected, next) => {
						if (next.state.phase === phase) {
							throw writeFailure;
						}
						return save(expected, next);
					}
				}
			}
		};
		const f = fixture();
		await expect(f.workflow.capture(input, broken)).rejects.toBe(writeFailure);
		if (phase === 'resolved') {
			expect(f.captureBegin.calls).toEqual([]);
		} else {
			expect(f.captureBegin.calls).toEqual([
				{
					cache,
					input: {
						result: path,
						expectedCacheGeneration: generation,
						requestId,
						origin: 'build-selection',
						memberCount: 1,
						cacheName: 'destination'
					}
				}
			]);
		}
		expect(f.capturePage.calls).toEqual([]);
		expect(f.captureSeal.calls).toEqual([]);
	}
);

it.each([
	'missing',
	'corrupt',
	'invocation',
	'request',
	'destination',
	'input'
] as const)(
	'fails closed before remote access for %s expected checkpoint state',
	async (change) => {
		const input = {
			result: path,
			members: [path],
			origin: 'build-selection' as const,
			requestId
		};
		const persisted = await persistedCapture(input);
		const original = persisted.reopen().capture;
		if (original === undefined) {
			throw new Error('Missing test recovery');
		}
		const checkpoint = await persisted.read();
		let loaded: unknown = checkpoint;
		switch (change) {
			case 'missing': {
				loaded = undefined;

				break;
			}
			case 'corrupt': {
				loaded = { version: 1, state: { phase: 'captured' } };

				break;
			}
			case 'invocation': {
				loaded = {
					...checkpoint,
					binding: { ...checkpoint.binding, invocation: 'b'.repeat(64) }
				};

				break;
			}
			case 'request': {
				loaded = {
					...checkpoint,
					binding: {
						...checkpoint.binding,
						input: {
							...checkpoint.binding.input,
							requestId: '44444444-4444-4444-8444-444444444444'
						}
					}
				};

				break;
			}
			case 'destination': {
				loaded = {
					...checkpoint,
					binding: { ...checkpoint.binding, cache: { kind: 'default' } }
				};

				break;
			}
			case 'input': {
				loaded = {
					...checkpoint,
					binding: {
						...checkpoint.binding,
						input: { ...checkpoint.binding.input, origin: 'legacy-selection' }
					}
				};

				break;
			}
			// No default
		}
		const context = {
			capture: {
				...original,
				store: { ...original.store, load: () => Promise.resolve(loaded) }
			}
		};
		const f = fixture();
		await expect(f.workflow.capture(input, context)).rejects.toThrow();
		expect(f.lookup.calls).toEqual([]);
		expect(f.captureBegin.calls).toEqual([]);
		expect(f.capturePage.calls).toEqual([]);
	}
);

it('rejects an operation switch on replay and never downgrades a completed checkpoint', async () => {
	const input = {
		result: path,
		members: [path],
		origin: 'build-selection' as const,
		requestId
	};
	const persisted = await persistedCapture(input);
	await fixture().workflow.capture(input, persisted.reopen());
	const before = await persisted.read();
	const switched = fixture({
		captureBegin: recordingCacheScopedClient(() =>
			Promise.resolve({
				kind: 'staging',
				operationId: '44444444-4444-4444-8444-444444444444',
				expiresAt: '2099-01-01T00:00:00.000Z'
			})
		)
	});
	await expect(
		switched.workflow.capture(input, persisted.reopen())
	).rejects.toThrow('identity');
	expect(switched.capturePage.calls).toEqual([]);
	expect(await persisted.read()).toEqual(before);
});

it('keeps no-context replay instance-local and rejects input drift in the same instance', async () => {
	const input = {
		result: path,
		members: [path],
		origin: 'build-selection' as const,
		requestId
	};
	const f = fixture();
	await f.workflow.capture(input);
	await expect(
		f.workflow.capture({ ...input, origin: 'legacy-selection' })
	).rejects.toThrow('identity');
	await expect(f.workflow.capture(input)).resolves.toEqual(publication);
	expect(f.captureBegin.calls.map((call) => call.input)).toEqual([
		{
			result: path,
			expectedCacheGeneration: generation,
			requestId,
			origin: 'build-selection',
			memberCount: 1,
			cacheName: 'destination'
		},
		{
			result: path,
			expectedCacheGeneration: generation,
			requestId,
			origin: 'build-selection',
			memberCount: 1,
			cacheName: 'destination'
		}
	]);
});

it('pins non-result member versions and page boundaries across reopened recovery', async () => {
	const members = Array.from({ length: 65 }, (_, index) =>
		publicationPathVersionSchema.parse({
			...path,
			storePath: `/nix/store/0123456789abcdfghijklmnpqrsvwxyz-${String(index)}`
		})
	);
	const result = members[0];
	if (result === undefined) {
		throw new Error('Missing fixture result');
	}
	const accepted = recordedPublicationSchema.parse({
		...publication,
		result: { ...publication.result, ...result },
		memberCount: 65
	});
	const input = {
		result: { storePath: result.storePath },
		members: members.map((member) => ({ storePath: member.storePath })),
		origin: 'build-selection' as const,
		requestId
	};
	const persisted = await persistedCapture(input);
	const controller = new AbortController();
	const lost = new Error('lost first page');
	const lookup = recordingCacheScopedClient(
		(request: PublicationLookupRequest) =>
			Promise.resolve({
				entries: request.results.map((target) => ({
					kind: 'missing',
					result: { ...publication.result, storePath: target.storePath }
				}))
			})
	);
	const first = fixture(
		{
			lookup,
			capturePage: recordingCacheScopedClient(() => {
				controller.abort(lost);
				return Promise.resolve({ operationId, page: 0, acceptedCount: 64 });
			})
		},
		{ signal: controller.signal }
	);
	await expect(first.workflow.capture(input, persisted.reopen())).rejects.toBe(
		lost
	);
	const noLookup = recordingCacheScopedClient(() =>
		Promise.reject(new Error('Member generation changed; lookup must not run'))
	);
	const second = fixture({
		lookup: noLookup,
		captureSeal: recordingCacheScopedClient(() =>
			Promise.resolve({
				kind: 'captured',
				association: 'created',
				publication: accepted
			})
		)
	});
	await expect(
		second.workflow.capture(input, persisted.reopen())
	).resolves.toEqual(accepted);
	expect(second.capturePage.calls).toEqual([
		{
			cache,
			input: {
				operationId,
				page: 0,
				members: members.slice(0, 64),
				cacheName: 'destination'
			}
		},
		{
			cache,
			input: {
				operationId,
				page: 1,
				members: members.slice(64),
				cacheName: 'destination'
			}
		}
	]);
	expect(noLookup.calls).toEqual([]);
});

it('does not return an initial winner if persisting its exact shortcut fails', async () => {
	const input = {
		result: path,
		members: [path],
		origin: 'build-selection' as const,
		requestId
	};
	const persisted = await persistedCapture(input);
	const recovery = persisted.reopen().capture;
	if (recovery === undefined) {
		throw new Error('Missing fixture recovery');
	}
	const failure = new Error('shortcut write failed');
	const f = fixture({
		lookup: recordingCacheScopedClient(() =>
			Promise.resolve({
				entries: [{ kind: 'recorded', publication, complete: true }]
			})
		)
	});
	await expect(
		f.workflow.capture(input, {
			capture: {
				...recovery,
				store: { ...recovery.store, save: () => Promise.reject(failure) }
			}
		})
	).rejects.toBe(failure);
	expect(f.captureBegin.calls).toEqual([]);
	expect(await persisted.read()).toEqual(
		initialPublicationCaptureCheckpoint(persisted.binding)
	);
});
