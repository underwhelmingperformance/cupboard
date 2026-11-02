import { describe, expect, expectTypeOf, it } from 'vitest';

import type { PublicationLookupTarget } from './publication-manifests.ts';
import {
	initialPublicationCaptureCheckpoint,
	publicationCaptureBindingSchema,
	publicationCaptureCheckpointSchema,
	publicationCaptureCheckpointUpdateSchema,
	publicationCaptureEnvelopeSchema,
	publicationWorkflowCaptureInputSchema,
	publicationWorkflowEnsureInputSchema,
	type PublicationWorkflowRequest,
	publicationWorkflowRequestSchema,
	publicationWorkflowResponseSchema
} from './publication-workflow.ts';

const requestId = '550e8400-e29b-41d4-a716-446655440000';
const target = { storePath: `/nix/store/${'0'.repeat(32)}-app` };
const exact = { ...target, narHash: `sha256:${'1'.repeat(52)}`, generation: 0 };
const publication = {
	result: { ...exact, cache: { kind: 'default' }, cacheGeneration: 1 },
	digest: 'a'.repeat(64),
	memberCount: 1,
	origin: 'build-selection'
};
const lookup = {
	source: { selector: { view: 'reuse' } },
	results: [target, { storePath: `${target.storePath}-missing` }]
};
const capture = {
	result: target,
	members: [target],
	origin: 'build-selection'
};
const ensure = {
	source: publication,
	sourceSelector: { view: 'reuse', expectedRevision: 1 },
	runRoot: 'ci'
};

describe('publication workflow transport', () => {
	it('prepares a run root using the upload attachment shape, never replacement targets', () => {
		for (const retention of [
			{ kind: 'inherit' },
			{ kind: 'permanent' },
			{ kind: 'duration', seconds: 3600 }
		]) {
			const request = {
				operation: 'prepare-run-root',
				input: { name: 'ci', retention }
			};
			expect(publicationWorkflowRequestSchema.parse(request)).toStrictEqual(
				request
			);
		}
		expect(
			publicationWorkflowRequestSchema.parse({
				operation: 'prepare-run-root',
				input: { name: 'ci' }
			})
		).toEqual({
			operation: 'prepare-run-root',
			input: { name: 'ci', retention: { kind: 'inherit' } }
		});
		for (const isSupported of [true, false]) {
			const response = {
				operation: 'prepare-run-root',
				supported: isSupported,
				...(isSupported && { output: { name: 'ci' } })
			};
			expect(publicationWorkflowResponseSchema.parse(response)).toStrictEqual(
				response
			);
		}
		for (const input of [
			{ name: 'ci', targets: [] },
			{ name: 'ci', retention: { kind: 'duration', seconds: -1 } },
			{ name: 'ci', source: { cache: { kind: 'default' } } }
		]) {
			expect(
				publicationWorkflowRequestSchema.safeParse({
					operation: 'prepare-run-root',
					input
				}).success
			).toBe(false);
		}
		expect(
			publicationWorkflowResponseSchema.safeParse({
				operation: 'prepare-run-root',
				supported: true,
				output: { name: 'ci', targets: [] }
			}).success
		).toBe(false);
	});
	it('reuses lookup and preserves optional capture identity constraints exactly', () => {
		for (const input of [
			capture,
			{ ...capture, result: exact, members: [exact], requestId },
			{
				...capture,
				members: [
					{ ...target, generation: 0 },
					{ ...target, narHash: exact.narHash }
				]
			}
		]) {
			const request = { operation: 'capture', input };
			expect(publicationWorkflowRequestSchema.parse(request)).toStrictEqual(
				request
			);
		}
		const request = { operation: 'lookup', input: lookup };
		expect(publicationWorkflowRequestSchema.parse(request)).toStrictEqual(
			request
		);
		expectTypeOf<
			Extract<
				PublicationWorkflowRequest,
				{ operation: 'capture' }
			>['input']['result']
		>().toEqualTypeOf<PublicationLookupTarget>();
	});

	it('lets the adapter obtain the destination generation and optionally supply replay IDs', () => {
		for (const input of [ensure, { ...ensure, requestId }]) {
			const request = { operation: 'ensure', input };
			expect(publicationWorkflowRequestSchema.parse(request)).toStrictEqual(
				request
			);
		}
		expect(
			publicationWorkflowEnsureInputSchema.safeParse({
				...ensure,
				expectedDestinationGeneration: 1
			}).success
		).toBe(false);
		expect(
			publicationWorkflowEnsureInputSchema.safeParse({
				...ensure,
				requestId: 'invalid'
			}).success
		).toBe(false);
	});

	it('bounds internal capture members at 1..100000 rather than HTTP page limits', () => {
		for (const count of [1, 65, 100_000]) {
			expect(
				publicationWorkflowCaptureInputSchema.safeParse({
					...capture,
					members: Array.from({ length: count }, () => target)
				}).success
			).toBe(true);
		}
		for (const count of [0, 100_001]) {
			expect(
				publicationWorkflowCaptureInputSchema.safeParse({
					...capture,
					members: Array.from({ length: count }, () => target)
				}).success
			).toBe(false);
		}
	});

	it('discriminates supported responses by operation without upgrading capture into complete materialisation', () => {
		const outputs = {
			lookup: {
				entries: [
					{ kind: 'unavailable', storePath: target.storePath },
					{ kind: 'missing', result: publication.result },
					{ kind: 'recorded', publication, complete: false }
				]
			},
			capture: publication,
			ensure: { ...publication, materialisation: 'complete' }
		};
		for (const operation of ['lookup', 'capture', 'ensure'] as const) {
			const unsupported = { operation, supported: false };
			expect(
				publicationWorkflowResponseSchema.parse(unsupported)
			).toStrictEqual(unsupported);
			const response = {
				operation,
				supported: true,
				output: outputs[operation]
			};
			expect(publicationWorkflowResponseSchema.parse(response)).toStrictEqual(
				response
			);
			expect(
				publicationWorkflowResponseSchema.safeParse({
					...unsupported,
					output: outputs[operation]
				}).success
			).toBe(false);
		}
		expect(
			publicationWorkflowResponseSchema.safeParse({
				operation: 'ensure',
				supported: true,
				output: publication
			}).success
		).toBe(false);
		expect(
			publicationWorkflowResponseSchema.safeParse({
				operation: 'capture',
				supported: true,
				output: outputs.ensure
			}).success
		).toBe(false);
	});

	it('rejects unknown fields, invalid identities and non-workflow operations', () => {
		for (const request of [
			{
				operation: 'capture',
				input: { ...capture, result: { ...target, generation: -1 } }
			},
			{
				operation: 'capture',
				input: { ...capture, members: [{ ...target, narHash: 'invalid' }] }
			},
			{ operation: 'capture', input: { ...capture, requestId: 'invalid' } },
			{ operation: 'capture', input: { ...capture, force: true } },
			{ operation: 'lookup', input: { ...lookup, results: [] } },
			{
				operation: 'ensure',
				input: { ...ensure, sourceSelector: { view: 'reuse' } }
			},
			{ operation: 'status', input: { operationId: requestId } },
			{ operation: 'lookup', input: lookup, extra: true }
		]) {
			expect(publicationWorkflowRequestSchema.safeParse(request).success).toBe(
				false
			);
		}
	});
});

describe('publication capture checkpoint', () => {
	const member = {
		storePath: '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app',
		narHash: `sha256:${'0'.repeat(52)}`,
		generation: 1
	};
	const cache = { kind: 'named', name: 'destination' };
	const input = {
		result: { storePath: member.storePath, narHash: member.narHash },
		members: [{ storePath: member.storePath, narHash: member.narHash }],
		origin: 'build-selection',
		requestId: '33333333-3333-4333-8333-333333333333'
	};
	const binding = publicationCaptureBindingSchema.parse({
		invocation: 'a'.repeat(64),
		tenantUrl: 'https://cupboard.example.workers.dev/t/acme',
		cache,
		input
	});
	const initial = initialPublicationCaptureCheckpoint(binding);
	const result = { ...member, cache, cacheGeneration: 1 };
	const capture = {
		result,
		begin: {
			result: member,
			expectedCacheGeneration: 1,
			requestId: input.requestId,
			origin: input.origin,
			memberCount: 1
		},
		pages: [[member]]
	};
	const resolved = { ...initial, state: { phase: 'resolved', capture } };
	const begun = {
		...initial,
		state: {
			phase: 'begun',
			capture,
			operationId: '22222222-2222-4222-8222-222222222222'
		}
	};
	const publication = {
		result,
		digest: 'b'.repeat(64),
		memberCount: 2,
		origin: 'legacy-selection'
	};
	const shortcut = { ...initial, state: { phase: 'shortcut', publication } };
	const captured = {
		...initial,
		state: { ...begun.state, phase: 'captured', publication }
	};

	it.each([initial, resolved, begun, shortcut, captured])(
		'round-trips the complete $state.phase state without inventing winner membership',
		(checkpoint) => {
			expect(publicationCaptureCheckpointSchema.parse(checkpoint)).toEqual(
				checkpoint
			);
		}
	);
	it.each([
		'https://token:secret@cupboard.example.workers.dev/t/acme',
		'https://cupboard.example.workers.dev/t/acme?token=secret',
		'https://cupboard.example.workers.dev/t/acme#fragment',
		'https://cupboard.example.workers.dev/t/acme/',
		'https://cupboard.example.workers.dev/t/acme/cache/destination',
		'http://cupboard.example.workers.dev/t/acme',
		'https://CUPBOARD.example.workers.dev/t/acme'
	])(
		'rejects non-canonical or credential-bearing tenant identity %s',
		(tenantUrl) => {
			expect(
				publicationCaptureBindingSchema.safeParse({ ...binding, tenantUrl })
					.success
			).toBe(false);
		}
	);
	it.each([
		{ ...resolved, version: 2 },
		{ ...resolved, extra: 'not ignored' },
		{ ...resolved, binding: { ...binding, invocation: 'not-a-digest' } },
		{
			...resolved,
			binding: { ...binding, input: { ...input, requestId: undefined } }
		},
		{ ...resolved, binding: { ...binding, cache: { kind: 'default' } } },
		{
			...resolved,
			binding: { ...binding, input: { ...input, origin: 'legacy-selection' } }
		},
		{
			...resolved,
			state: {
				phase: 'resolved',
				capture: {
					...capture,
					begin: { ...capture.begin, expectedCacheGeneration: 2 }
				}
			}
		},
		{
			...resolved,
			state: {
				phase: 'resolved',
				capture: { ...capture, begin: { ...capture.begin, memberCount: 2 } }
			}
		},
		{
			...resolved,
			state: {
				phase: 'resolved',
				capture: {
					...capture,
					begin: {
						...capture.begin,
						requestId: '44444444-4444-4444-8444-444444444444'
					}
				}
			}
		},
		{
			...resolved,
			state: {
				phase: 'resolved',
				capture: { ...capture, pages: [[{ ...member, generation: 2 }]] }
			}
		},
		{
			...resolved,
			state: {
				phase: 'resolved',
				capture: { ...capture, pages: [[member], [member]] }
			}
		},
		{
			...resolved,
			state: { phase: 'resolved', capture: { ...capture, pages: [] } }
		},
		{
			...resolved,
			state: {
				phase: 'resolved',
				capture: {
					...capture,
					pages: [
						[
							{
								...member,
								storePath: '/nix/store/1123456789abcdfghijklmnpqrsvwxyz-other'
							}
						]
					]
				}
			}
		},
		{
			...captured,
			state: {
				...captured.state,
				publication: { ...publication, result: { ...result, generation: 2 } }
			}
		},
		{
			...shortcut,
			state: {
				...shortcut.state,
				publication: {
					...publication,
					result: { ...result, narHash: `sha256:${'1'.repeat(52)}` }
				}
			}
		},
		{
			...initial,
			binding: {
				...binding,
				input: {
					...input,
					members: [{ ...member }, { ...member, generation: 2 }]
				}
			}
		}
	])('rejects inconsistent complete state %#', (checkpoint) => {
		expect(
			publicationCaptureCheckpointSchema.safeParse(checkpoint).success
		).toBe(false);
	});
	it('rejects contradictory result-member fences even before shortcut discovery', () => {
		const conflicting = {
			...binding,
			input: {
				...binding.input,
				result: member,
				members: [{ ...member, generation: 2 }]
			}
		};
		expect(
			publicationCaptureCheckpointSchema.safeParse({
				...initial,
				binding: conflicting
			}).success
		).toBe(false);
		expect(
			publicationCaptureCheckpointSchema.safeParse({
				...shortcut,
				binding: {
					...binding,
					input: { ...binding.input, members: [{ ...member, generation: 2 }] }
				}
			}).success
		).toBe(false);
	});

	it('bounds exact raw begin and page requests including the cache route', () => {
		const long = {
			...member,
			storePath: `/${'s'.repeat(65_536)}/store/0123456789abcdfghijklmnpqrsvwxyz-app`
		};
		const longBinding = {
			...binding,
			input: { ...binding.input, result: long, members: [long] }
		};
		const oversized = {
			...resolved,
			binding: longBinding,
			state: {
				phase: 'resolved',
				capture: {
					result: { ...result, ...long },
					begin: { ...capture.begin, result: long },
					pages: [[long]]
				}
			}
		};
		expect(
			publicationCaptureCheckpointSchema.safeParse(oversized).success
		).toBe(false);
		const page = Array.from({ length: 64 }, (_, index) => ({
			...member,
			storePath: `/${'s'.repeat(1100)}/store/0123456789abcdfghijklmnpqrsvwxyz-${String(index)}`
		}));
		const first = page[0];
		if (first === undefined) {
			throw new Error('Missing fixture member');
		}
		expect(
			publicationCaptureCheckpointSchema.safeParse({
				...resolved,
				binding: {
					...binding,
					input: { ...binding.input, result: first, members: page }
				},
				state: {
					phase: 'resolved',
					capture: {
						result: { ...result, ...first },
						begin: { ...capture.begin, result: first, memberCount: 64 },
						pages: [page]
					}
				}
			}).success
		).toBe(false);
	});
	it.each([
		[initial, resolved],
		[initial, shortcut],
		[resolved, begun],
		[
			resolved,
			{ ...captured, state: { ...captured.state, operationId: undefined } }
		],
		[begun, captured]
	])('accepts an exact forward transition %#', (previous, next) => {
		expect(
			publicationCaptureCheckpointUpdateSchema.parse({ previous, next })
		).toEqual({ previous, next });
	});
	it.each([
		[initial, captured],
		[resolved, shortcut],
		[begun, resolved],
		[shortcut, resolved],
		[captured, initial],
		[
			begun,
			{
				...captured,
				state: {
					...captured.state,
					operationId: '44444444-4444-4444-8444-444444444444'
				}
			}
		],
		[
			resolved,
			{ ...begun, binding: { ...binding, invocation: 'c'.repeat(64) } }
		],
		[
			resolved,
			{
				...begun,
				state: {
					...begun.state,
					capture: { ...capture, pages: [[{ ...member, generation: 2 }]] }
				}
			}
		]
	])('rejects rollback, drift or skipped resolution %#', (previous, next) => {
		expect(
			publicationCaptureCheckpointUpdateSchema.safeParse({ previous, next })
				.success
		).toBe(false);
	});
	it('binds the private envelope to its complete original capture input', () => {
		const envelope = {
			version: 1,
			request: { operation: 'capture', input },
			checkpoint: initial
		};
		expect(publicationCaptureEnvelopeSchema.parse(envelope)).toEqual(envelope);
		expect(
			publicationCaptureEnvelopeSchema.safeParse({
				...envelope,
				request: {
					operation: 'capture',
					input: { ...input, origin: 'legacy-selection' }
				}
			}).success
		).toBe(false);
	});
});
