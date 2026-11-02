import { cacheNameSchema, type CacheScope } from '@cupboard/nix-store/scalars';
import { recordedPublicationSchema } from '@cupboard/protocol/publication-manifests';
import {
	initialPublicationCaptureCheckpoint,
	publicationCaptureBindingSchema,
	publicationCaptureCheckpointUpdateSchema,
	type PublicationWorkflowExecutionContext,
	publicationWorkflowRequestSchema
} from '@cupboard/protocol/publication-workflow';
import {
	acceptCapabilitiesHeader,
	uploadCapabilitiesHeader
} from '@cupboard/protocol/upload';
import { describe, expect, it, vi } from 'vitest';

import {
	publicationWorkflowAuthorizationDetails,
	publicationWorkflowFor
} from './publication-client.ts';

const tenantUrl = new URL('https://cupboard.example.workers.dev/t/acme');
const cache: CacheScope = {
	kind: 'named',
	name: cacheNameSchema.parse('destination')
};
const publication = recordedPublicationSchema.parse({
	result: {
		cache: { kind: 'named', name: 'source' },
		cacheGeneration: 2,
		storePath: '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app',
		narHash: `sha256:${'0'.repeat(52)}`,
		generation: 3
	},
	digest: 'a'.repeat(64),
	memberCount: 1,
	origin: 'build-selection'
});
const lookup = publicationWorkflowRequestSchema.parse({
	operation: 'lookup',
	input: {
		source: { cache: publication.result.cache },
		results: [{ storePath: publication.result.storePath }]
	}
});
const credential = {
	pushId: 'push-1',
	accessKeyId: 'access',
	secretAccessKey: 'secret',
	sessionToken: 'session',
	endpoint: 'https://r2.test',
	bucket: 'blobs',
	expiresAt: '2099-01-01T00:00:00.000Z'
};

function fixture(
	options: {
		capabilities?: string;
		credential?: () => Response;
		respond?: (request: Request) => Response | Promise<Response>;
	} = {}
) {
	const calls: Request[] = [];
	const client = publicationWorkflowFor(tenantUrl, 'access-token', {
		cache,
		fetcher: async (input, init) => {
			const request = new Request(input, init);
			calls.push(request.clone());
			if (request.url.endsWith('/uploads/credential')) {
				return (
					options.credential?.() ??
					Response.json(credential, {
						headers: {
							[uploadCapabilitiesHeader]:
								options.capabilities ?? 'publication-manifests-v1'
						}
					})
				);
			}
			return (
				options.respond?.(request) ??
				Response.json({
					entries: [{ kind: 'recorded', publication, complete: true }]
				})
			);
		}
	});
	return { client, calls };
}

describe('publicationWorkflowFor', () => {
	it.each([
		{ kind: 'inherit' },
		{ kind: 'permanent' },
		{ kind: 'duration', seconds: 1_209_600 }
	])(
		'prepares the shared root additively through upload negotiation, preserving %j retention',
		async (retention) => {
			const request = publicationWorkflowRequestSchema.parse({
				operation: 'prepare-run-root',
				input: { name: 'github:acme/app/run-1', retention }
			});
			const { client, calls } = fixture({
				respond: () => Response.json({ uploads: [] })
			});
			await expect(client.execute(request)).resolves.toEqual({
				operation: 'prepare-run-root',
				supported: true,
				output: { name: 'github:acme/app/run-1' }
			});
			await client.execute(request);
			expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
				'/t/acme/cache/destination/uploads/credential',
				'/t/acme/cache/destination/uploads',
				'/t/acme/cache/destination/uploads'
			]);
			for (const call of calls.slice(1)) {
				expect(await call.json()).toEqual({
					pushId: credential.pushId,
					paths: [],
					attachRoot: request.input
				});
			}
		}
	);
	it('returns old-peer non-support for preparation without mutating anything', async () => {
		const { client, calls } = fixture({ capabilities: 'publication-v1' });
		await expect(
			client.execute(
				publicationWorkflowRequestSchema.parse({
					operation: 'prepare-run-root',
					input: { name: 'ci' }
				})
			)
		).resolves.toEqual({ operation: 'prepare-run-root', supported: false });
		expect(calls).toHaveLength(1);
	});
	it.each([403, 404, 409])(
		'does not downgrade preparation refusal %s',
		async (status) => {
			const { client } = fixture({
				respond: () => new Response('refused', { status })
			});
			await expect(
				client.execute(
					publicationWorkflowRequestSchema.parse({
						operation: 'prepare-run-root',
						input: { name: 'ci' }
					})
				)
			).rejects.toBeDefined();
		}
	);
	it.each([
		{},
		{ uploads: [], extra: true },
		{
			uploads: [
				{
					action: 'skip',
					storePathHash: '0123456789abcdfghijklmnpqrsvwxyz',
					narHash: `sha256:${'0'.repeat(52)}`
				}
			]
		}
	])('rejects invalid or non-empty preparation response %j', async (output) => {
		const { client } = fixture({ respond: () => Response.json(output) });
		await expect(
			client.execute(
				publicationWorkflowRequestSchema.parse({
					operation: 'prepare-run-root',
					input: { name: 'ci' }
				})
			)
		).rejects.toBeDefined();
	});
	it('returns genuine old-peer non-support only after a valid credential exchange and no advertisement', async () => {
		const { client, calls } = fixture({ capabilities: 'publication-v1' });
		await expect(client.execute(lookup)).resolves.toEqual({
			operation: 'lookup',
			supported: false
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.headers.get(acceptCapabilitiesHeader)).toBe(
			'publication-manifests-v1'
		);
	});
	it('reuses negotiated support and performs healthy set lookup without NAR requests', async () => {
		const { client, calls } = fixture();
		await expect(client.execute(lookup)).resolves.toEqual({
			operation: 'lookup',
			supported: true,
			output: { entries: [{ kind: 'recorded', publication, complete: true }] }
		});
		await client.execute(lookup);
		expect(calls.map((request) => new URL(request.url).pathname)).toEqual([
			'/t/acme/cache/destination/uploads/credential',
			'/t/acme/cache/destination/publication-results/lookup',
			'/t/acme/cache/destination/publication-results/lookup'
		]);
		expect(
			calls.every(
				(request) =>
					request.headers.get('authorization') === 'Bearer access-token'
			)
		).toBe(true);
	});
	it.each([401, 403, 404, 409])(
		'does not downgrade credential error %s',
		async (status) => {
			const { client, calls } = fixture({
				credential: () => new Response('refused', { status })
			});
			await expect(client.execute(lookup)).rejects.toBeDefined();
			expect(calls).toHaveLength(1);
		}
	);
	it('does not downgrade credential validation or provider failures', async () => {
		const { client } = fixture({ credential: () => Response.json({}) });
		await expect(client.execute(lookup)).rejects.toBeDefined();
		const failure = new Error('credential provider failed');
		const fetcher = vi.fn<typeof fetch>();
		const providerClient = publicationWorkflowFor(
			tenantUrl,
			{
				get: () => Promise.reject(failure),
				refresh: () => Promise.reject(failure)
			},
			{ cache, fetcher }
		);
		await expect(providerClient.execute(lookup)).rejects.toBe(failure);
		expect(fetcher).not.toHaveBeenCalled();
	});
	it.each([403, 404, 409])(
		'does not downgrade supported lookup failure %s',
		async (status) => {
			const { client, calls } = fixture({
				respond: () => new Response('refused', { status })
			});
			await expect(client.execute(lookup)).rejects.toBeDefined();
			expect(calls).toHaveLength(2);
		}
	);
	it('rejects malformed successful results without falling back', async () => {
		const { client, calls } = fixture({
			respond: () => Response.json({ entries: [] })
		});
		await expect(client.execute(lookup)).rejects.toBeDefined();
		expect(calls).toHaveLength(2);
	});
	it('plans and ensures a healthy materialised set without any NAR or upload requests', async () => {
		const ensured = {
			...publication,
			result: { ...publication.result, cache, cacheGeneration: 4 },
			materialisation: 'complete'
		};
		const { client, calls } = fixture({
			respond: (request) =>
				Response.json(
					request.url.endsWith('/uploads/plan')
						? {
								cacheGeneration: 4,
								pushExpiresAt: '2099-01-01T00:00:00.000Z',
								uploads: []
							}
						: {
								kind: 'complete',
								association: 'existing',
								publication: ensured
							}
				)
		});
		const request = publicationWorkflowRequestSchema.parse({
			operation: 'ensure',
			input: { source: publication }
		});
		await expect(client.execute(request)).resolves.toEqual({
			operation: 'ensure',
			supported: true,
			output: ensured
		});
		expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
			'/t/acme/cache/destination/uploads/credential',
			'/t/acme/cache/destination/uploads/plan',
			'/t/acme/cache/destination/publication-results/ensure'
		]);
	});
});

describe('publicationWorkflowAuthorizationDetails', () => {
	it('prepares only with destination upload and the exact root attachment grant', async () => {
		const fetchAccess = vi.fn();
		expect(
			await publicationWorkflowAuthorizationDetails(
				publicationWorkflowRequestSchema.parse({
					operation: 'prepare-run-root',
					input: { name: 'ci' }
				}),
				{ tenantUrl, cache },
				fetchAccess
			)
		).toEqual([
			{
				type: 'cupboard_cache',
				cache,
				actions: ['upload:negotiate', 'upload:status', 'upload:commit']
			},
			{ type: 'cupboard_cache', cache, root: 'ci', actions: ['root:attach'] }
		]);
		expect(fetchAccess).not.toHaveBeenCalled();
	});
	it('requests the concrete private source cache and destination upload resources', async () => {
		const fetchAccess = vi.fn(() => Promise.resolve('private' as const));
		const grants = await publicationWorkflowAuthorizationDetails(
			lookup,
			{ tenantUrl, cache },
			fetchAccess
		);
		expect(fetchAccess).toHaveBeenCalledWith(
			new URL(`${tenantUrl.href}/cache/source`)
		);
		expect(grants).toEqual([
			{
				type: 'cupboard_cache',
				cache,
				actions: ['upload:negotiate', 'upload:status', 'upload:commit']
			},
			{
				type: 'cupboard_cache',
				cache: publication.result.cache,
				actions: ['cache:content-read']
			}
		]);
	});
	it('uses view read authority, preserves the selected run root, and does not request direct source-cache authority', async () => {
		const request = publicationWorkflowRequestSchema.parse({
			operation: 'ensure',
			input: {
				source: publication,
				sourceSelector: { view: 'builds', expectedRevision: 7 },
				runRoot: 'github:acme/app/run-1'
			}
		});
		const fetchAccess = vi.fn(() => Promise.resolve('private' as const));
		const grants = await publicationWorkflowAuthorizationDetails(
			request,
			{ tenantUrl, cache },
			fetchAccess
		);
		expect(fetchAccess).toHaveBeenCalledWith(
			new URL(`${tenantUrl.href}/reuse/builds`)
		);
		expect(grants).toEqual([
			{
				type: 'cupboard_cache',
				cache,
				actions: ['upload:negotiate', 'upload:status', 'upload:commit']
			},
			{
				type: 'cupboard_cache',
				cache,
				root: 'github:acme/app/run-1',
				actions: ['root:attach']
			},
			{ type: 'cupboard_view', view: 'builds', actions: ['view:content-read'] }
		]);
	});
	it('does not request private source grants for the actual destination or a public source', async () => {
		const fetchAccess = vi.fn(() => Promise.resolve('public' as const));
		const request = publicationWorkflowRequestSchema.parse({
			operation: 'lookup',
			input: {
				source: { cache },
				results: [{ storePath: publication.result.storePath }]
			}
		});
		expect(
			await publicationWorkflowAuthorizationDetails(
				request,
				{ tenantUrl, cache },
				fetchAccess
			)
		).toHaveLength(1);
		expect(fetchAccess).not.toHaveBeenCalled();
		expect(
			await publicationWorkflowAuthorizationDetails(
				lookup,
				{ tenantUrl, cache },
				fetchAccess
			)
		).toHaveLength(1);
	});
	it('propagates source access-probe errors rather than treating them as public', async () => {
		const failure = new Error('source provider failed');
		await expect(
			publicationWorkflowAuthorizationDetails(
				lookup,
				{ tenantUrl, cache },
				() => Promise.reject(failure)
			)
		).rejects.toBe(failure);
	});
});

it('forwards distinct per-execution capture stores through a shared facade (modelled HTTP remote)', async () => {
	const request = publicationWorkflowRequestSchema.parse({
		operation: 'capture',
		input: {
			result: {
				storePath: publication.result.storePath,
				narHash: publication.result.narHash
			},
			members: [
				{
					storePath: publication.result.storePath,
					narHash: publication.result.narHash
				}
			],
			origin: 'build-selection',
			requestId: '33333333-3333-4333-8333-333333333333'
		}
	});
	if (request.operation !== 'capture') {
		throw new Error('Missing fixture capture');
	}
	const contexts = ['a', 'b'].map((identity) => {
		const binding = publicationCaptureBindingSchema.parse({
			invocation: identity.repeat(64),
			tenantUrl: tenantUrl.href,
			cache,
			input: request.input
		});
		let checkpoint = initialPublicationCaptureCheckpoint(binding);
		const saves: string[] = [];
		const context: PublicationWorkflowExecutionContext = {
			capture: {
				binding,
				store: {
					load: () => Promise.resolve(structuredClone(checkpoint)),
					save: (expected, next) => {
						expect(checkpoint).toEqual(expected);
						publicationCaptureCheckpointUpdateSchema.parse({
							previous: checkpoint,
							next
						});
						checkpoint = next;
						saves.push(next.state.phase);
						return Promise.resolve();
					}
				}
			}
		};
		return { context, saves };
	});
	const first = contexts[0];
	const second = contexts[1];
	if (first === undefined || second === undefined) {
		throw new Error('Missing contexts');
	}
	let current = recordedPublicationSchema.parse({
		...publication,
		result: { ...publication.result, cache }
	});
	const original = current;
	const { client, calls } = fixture({
		respond: () =>
			Response.json({
				entries: [{ kind: 'recorded', publication: current, complete: true }]
			})
	});
	await expect(client.execute(request, first.context)).resolves.toEqual({
		operation: 'capture',
		supported: true,
		output: original
	});
	current = recordedPublicationSchema.parse({
		...current,
		result: { ...current.result, generation: 4 },
		digest: 'b'.repeat(64)
	});
	await expect(client.execute(request, second.context)).resolves.toEqual({
		operation: 'capture',
		supported: true,
		output: current
	});
	await expect(client.execute(request, first.context)).rejects.toThrow(
		'identity'
	);
	expect(first.saves).toEqual(['shortcut']);
	expect(second.saves).toEqual(['shortcut']);
	expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
		'/t/acme/cache/destination/uploads/credential',
		'/t/acme/cache/destination/publication-results/lookup',
		'/t/acme/cache/destination/publication-results/lookup',
		'/t/acme/cache/destination/publication-results/lookup'
	]);
});

it.each(['tenant', 'cache', 'input', 'operation'] as const)(
	'rejects %s execution-context drift before remote access',
	async (change) => {
		const input = {
			result: { storePath: publication.result.storePath },
			members: [{ storePath: publication.result.storePath }],
			origin: 'build-selection',
			requestId: '33333333-3333-4333-8333-333333333333'
		};
		const binding = publicationCaptureBindingSchema.parse({
			invocation: 'a'.repeat(64),
			tenantUrl: tenantUrl.href,
			cache,
			input
		});
		switch (change) {
			case 'tenant': {
				binding.tenantUrl = 'https://other.example.workers.dev/t/acme';

				break;
			}
			case 'cache': {
				binding.cache = { kind: 'default' };

				break;
			}
			case 'input': {
				binding.input.origin = 'legacy-selection';

				break;
			}
			// No default
		}
		const context = {
			capture: {
				binding,
				store: {
					load: () => Promise.resolve(undefined),
					save: () => Promise.resolve()
				}
			}
		};
		const request = publicationWorkflowRequestSchema.parse({
			operation: 'capture',
			input
		});
		const { client, calls } = fixture();
		await expect(
			client.execute(change === 'operation' ? lookup : request, context)
		).rejects.toThrow('binding');
		expect(calls).toEqual([]);
	}
);

it('never turns a supplied recovery context into old-peer non-support', async () => {
	const input = {
		result: { storePath: publication.result.storePath },
		members: [{ storePath: publication.result.storePath }],
		origin: 'build-selection',
		requestId: '33333333-3333-4333-8333-333333333333'
	};
	const binding = publicationCaptureBindingSchema.parse({
		invocation: 'a'.repeat(64),
		tenantUrl: tenantUrl.href,
		cache,
		input
	});
	const context = {
		capture: {
			binding,
			store: {
				load: () =>
					Promise.resolve(initialPublicationCaptureCheckpoint(binding)),
				save: () => Promise.resolve()
			}
		}
	};
	const { client, calls } = fixture({ capabilities: 'publication-v1' });
	await expect(
		client.execute(
			publicationWorkflowRequestSchema.parse({ operation: 'capture', input }),
			context
		)
	).rejects.toThrow('support changed');
	expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
		'/t/acme/cache/destination/uploads/credential'
	]);
});

it('binds capture recovery to the facade destination snapshot, not a later-mutated URL', async () => {
	const url = new URL(tenantUrl);
	const fetcher = vi.fn<typeof fetch>();
	const client = publicationWorkflowFor(url, 'access-token', {
		cache,
		fetcher
	});
	url.hostname = 'other.example.workers.dev';
	const request = publicationWorkflowRequestSchema.parse({
		operation: 'capture',
		input: {
			result: { storePath: publication.result.storePath },
			members: [{ storePath: publication.result.storePath }],
			origin: 'build-selection',
			requestId: '33333333-3333-4333-8333-333333333333'
		}
	});
	const binding = publicationCaptureBindingSchema.parse({
		invocation: 'a'.repeat(64),
		tenantUrl: url.href,
		cache,
		input: request.input
	});
	await expect(
		client.execute(request, {
			capture: {
				binding,
				store: {
					load: () =>
						Promise.resolve(initialPublicationCaptureCheckpoint(binding)),
					save: () => Promise.resolve()
				}
			}
		})
	).rejects.toThrow('binding');
	expect(fetcher.mock.calls).toEqual([]);
});
