import { storePathSchema } from '@cupboard/nix-store/scalars';
import {
	publicationLookupResponseSchema,
	publicationLookupSourceSchema,
	recordedPublicationSchema
} from '@cupboard/protocol/publication-manifests';
import type { PublicationWorkflowRequest } from '@cupboard/protocol/publication-workflow';
import { expect, it } from 'vitest';

import { lookupSelectedPublications } from './publication-sets.ts';

const paths = Array.from({ length: 65 }, (_, index) =>
	storePathSchema.parse(`/nix/store/${'1'.repeat(32)}-app-${String(index)}`)
);
const selected = new Map(
	paths.map((storePath) => [storePath, [{ storePath }]])
);

it('fences later lookup pages with the resolved source generation and view revision', async () => {
	const requests: PublicationWorkflowRequest[] = [];
	const source = publicationLookupSourceSchema.parse({
		cache: { kind: 'default' },
		selector: { view: 'release' }
	});
	const result = await lookupSelectedPublications(selected, [source], {
		execute(request) {
			requests.push(request);
			if (request.operation !== 'lookup') {
				throw new Error('Only lookup');
			}
			return Promise.resolve({
				operation: 'lookup',
				supported: true,
				output: publicationLookupResponseSchema.parse({
					sourceSelector: { view: 'release', expectedRevision: 3 },
					entries: request.input.results.map((target) => ({
						kind: 'missing',
						result: {
							...target,
							narHash: `sha256:${'0'.repeat(52)}`,
							generation: 7,
							cache: { kind: 'default' },
							cacheGeneration: 2
						}
					}))
				})
			});
		}
	});
	expect(result?.size).toBe(0);
	expect(requests).toHaveLength(2);
	expect(requests[1]).toMatchObject({
		input: {
			source: {
				cache: { kind: 'default' },
				expectedCacheGeneration: 2,
				selector: { view: 'release', expectedRevision: 3 }
			},
			results: [{ storePath: paths[64] }]
		}
	});
});

it('does not replace the first available legacy selection with a record from a later foreign source', async () => {
	const requests: PublicationWorkflowRequest[] = [];
	const sources = [
		{ cache: { kind: 'default' } },
		{ cache: { kind: 'named', name: 'foreign' } }
	].map((source) => publicationLookupSourceSchema.parse(source));
	await lookupSelectedPublications(
		new Map([
			[paths[0] ?? '', [{ storePath: storePathSchema.parse(paths[0]) }]]
		]),
		sources,
		{
			execute(request) {
				requests.push(request);
				if (request.operation !== 'lookup') {
					throw new Error('Only lookup');
				}
				return Promise.resolve({
					operation: 'lookup',
					supported: true,
					output: publicationLookupResponseSchema.parse({
						entries: request.input.results.map((target) => ({
							kind: 'missing',
							result: {
								...target,
								narHash: `sha256:${'0'.repeat(52)}`,
								generation: 1,
								cache: { kind: 'default' },
								cacheGeneration: 1
							}
						}))
					})
				});
			}
		}
	);
	expect(requests).toHaveLength(1);
});

it('refuses capability loss after selecting a recorded set instead of rebuilding a larger membership', async () => {
	let page = 0;
	await expect(
		lookupSelectedPublications(selected, [{ cache: { kind: 'default' } }], {
			execute(request) {
				if (request.operation !== 'lookup') {
					throw new Error('Only lookup');
				}
				page += 1;
				if (page === 2) {
					return Promise.resolve({ operation: 'lookup', supported: false });
				}
				return Promise.resolve({
					operation: 'lookup',
					supported: true,
					output: {
						entries: request.input.results.map((target) => ({
							kind: 'recorded',
							complete: true,
							publication: recordedPublicationSchema.parse({
								result: {
									...target,
									narHash: `sha256:${'0'.repeat(52)}`,
									generation: 1,
									cache: { kind: 'default' },
									cacheGeneration: 1
								},
								digest: 'a'.repeat(64),
								memberCount: 1,
								origin: 'build-selection'
							})
						}))
					}
				});
			}
		})
	).rejects.toThrow('Recorded publication support changed during lookup');
	expect(page).toBe(2);
});

it.each(['missing', 'unavailable'] as const)(
	'rejects support loss after a supported %s-only page',
	async (kind) => {
		let page = 0;
		await expect(
			lookupSelectedPublications(selected, [{ cache: { kind: 'default' } }], {
				execute(request) {
					if (request.operation !== 'lookup') {
						throw new Error('Only lookup');
					}
					if (++page === 2) {
						return Promise.resolve({ operation: 'lookup', supported: false });
					}
					return Promise.resolve({
						operation: 'lookup',
						supported: true,
						output: publicationLookupResponseSchema.parse({
							entries: request.input.results.map((target) =>
								kind === 'unavailable'
									? { kind, ...target }
									: {
											kind,
											result: {
												...target,
												narHash: `sha256:${'0'.repeat(52)}`,
												generation: 1,
												cache: { kind: 'default' },
												cacheGeneration: 1
											}
										}
							)
						})
					});
				}
			})
		).rejects.toThrow('Recorded publication support changed during lookup');
		expect(page).toBe(2);
	}
);

it('rejects source-facade support loss after the destination supported lookup found only unavailable results', async () => {
	let calls = 0;
	const targets = new Map([
		[paths[0] ?? '', [{ storePath: storePathSchema.parse(paths[0]) }]]
	]);
	await expect(
		lookupSelectedPublications(
			targets,
			[
				{ cache: { kind: 'default' } },
				publicationLookupSourceSchema.parse({
					cache: { kind: 'named', name: 'source' }
				})
			],
			{
				execute(request) {
					if (request.operation !== 'lookup') {
						throw new Error('Only lookup');
					}
					if (++calls === 2) {
						return Promise.resolve({ operation: 'lookup', supported: false });
					}
					return Promise.resolve({
						operation: 'lookup',
						supported: true,
						output: {
							entries: request.input.results.map((target) => ({
								kind: 'unavailable',
								storePath: target.storePath
							}))
						}
					});
				}
			}
		)
	).rejects.toThrow('Recorded publication support changed during lookup');
	expect(calls).toBe(2);
});
