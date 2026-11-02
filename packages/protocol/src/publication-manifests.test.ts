import {
	type CacheGeneration,
	type NarInfoGeneration,
	type NixSha256HashString,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import { publicationRecoveryMs } from './publication.ts';
import {
	compactPublicationSetSchema,
	publicationCaptureBeginRequestSchema,
	publicationCaptureBeginResponseSchema,
	publicationCapturePageRequestSchema,
	publicationCapturePageResponseSchema,
	publicationCaptureSealRequestSchema,
	publicationCaptureSealResponseSchema,
	publicationDigestSchema,
	publicationEnsureRequestSchema,
	publicationEnsureResponseSchema,
	publicationLookupMaxResults,
	publicationLookupRequestSchema,
	publicationLookupResponseSchema,
	publicationLookupSourceSchema,
	publicationLookupSourceSelectorSchema,
	publicationLookupTargetSchema,
	publicationManifestIdentity,
	publicationManifestLeafIdentity,
	publicationManifestLimitErrorDataSchema,
	publicationManifestMaxMembers,
	publicationManifestMaxRequestBytes,
	publicationManifestMembersSchema,
	publicationManifestPageMaxMembers,
	publicationManifestRootIdentity,
	publicationManifestsCapability,
	publicationOperationIdSchema,
	type PublicationPathVersion,
	type PublicationResultIdentity,
	publicationStatusRequestSchema,
	publicationStatusResponseSchema,
	recordedPublicationSchema
} from './publication-manifests.ts';

const path = (index: number) =>
	`/nix/store/${index.toString(2).padStart(32, '0')}-app`;
const version = {
	storePath: path(0),
	narHash: `sha256:${'1'.repeat(52)}`,
	generation: 0
};
const result = { ...version, cache: { kind: 'default' }, cacheGeneration: 1 };
const publication = {
	result,
	digest: 'a'.repeat(64),
	memberCount: 1,
	origin: 'build-selection'
};
const operationId = '550e8400-e29b-41d4-a716-446655440000';
const source = {
	cache: { kind: 'named', name: 'source' },
	expectedCacheGeneration: 1
};
const selector = { view: 'reuse', expectedRevision: 1 };

const lookup = { source, results: [version] };
const begin = {
	result: version,
	expectedCacheGeneration: 1,
	requestId: operationId,
	origin: 'legacy-selection',
	memberCount: 1
};
const page = { operationId, page: 0, members: [version] };
const ensure = {
	requestId: operationId,
	source: publication,
	expectedDestinationGeneration: 1
};

// These tests exercise the pure protocol boundary, not server availability,
// current authority, cross-page replay or first-winner persistence.
describe('publication manifest schemas', () => {
	it('freezes limits and capability without changing the recovery horizon', () => {
		expect({
			capability: publicationManifestsCapability,
			page: publicationManifestPageMaxMembers,
			lookup: publicationLookupMaxResults,
			bytes: publicationManifestMaxRequestBytes,
			total: publicationManifestMaxMembers,
			recovery: publicationRecoveryMs
		}).toStrictEqual({
			capability: 'publication-manifests-v1',
			page: 64,
			lookup: 64,
			bytes: 65_536,
			total: 100_000,
			recovery: 86_400_000
		});
	});

	it('uses exact branded identities', () => {
		expectTypeOf<
			PublicationPathVersion['storePath']
		>().toEqualTypeOf<StorePathString>();
		expectTypeOf<
			PublicationPathVersion['narHash']
		>().toEqualTypeOf<NixSha256HashString>();
		expectTypeOf<
			PublicationPathVersion['generation']
		>().toEqualTypeOf<NarInfoGeneration>();
		expectTypeOf<
			PublicationResultIdentity['cacheGeneration']
		>().toEqualTypeOf<CacheGeneration>();
	});

	it('round-trips explicit source scopes and optional revision selectors', () => {
		expect(publicationLookupRequestSchema.parse(lookup)).toStrictEqual(lookup);
		const withView = { ...lookup, source: { ...source, selector } };
		expect(publicationLookupRequestSchema.parse(withView)).toStrictEqual(
			withView
		);
		const promotion = { ...ensure, sourceSelector: selector, runRoot: 'ci' };
		expect(publicationEnsureRequestSchema.parse(promotion)).toStrictEqual(
			promotion
		);
	});

	it.each([
		{
			source: { cache: { kind: 'default' } },
			results: [{ storePath: path(0) }]
		},
		{
			source: { selector: { view: 'reuse' } },
			results: [{ storePath: path(0) }]
		},
		{
			source: { selector },
			results: [{ storePath: path(0), narHash: version.narHash }]
		},
		{
			source: { ...source, selector: { view: 'reuse' } },
			results: [{ storePath: path(0), generation: 0 }]
		}
	])('bootstraps lookup without inventing identities: %j', (value) => {
		expect(publicationLookupRequestSchema.parse(value)).toStrictEqual(value);
	});

	it('accepts optional lookup expectations but leaves exact capture and output identities mandatory', () => {
		const target = { storePath: path(0) };
		expect(publicationLookupTargetSchema.parse(target)).toStrictEqual(target);
		expect(publicationLookupTargetSchema.parse(version)).toStrictEqual(version);
		expect(
			publicationLookupSourceSelectorSchema.parse({ view: 'reuse' })
		).toStrictEqual({ view: 'reuse' });
		expect(
			publicationCaptureBeginRequestSchema.safeParse({
				...begin,
				result: target
			}).success
		).toBe(false);
		expect(
			publicationCapturePageRequestSchema.safeParse({
				...page,
				members: [target]
			}).success
		).toBe(false);
		expect(
			publicationLookupResponseSchema.safeParse({
				entries: [
					{ kind: 'missing', result: { ...result, generation: undefined } }
				]
			}).success
		).toBe(false);
		expect(
			publicationEnsureRequestSchema.safeParse({
				...ensure,
				sourceSelector: { view: 'reuse' }
			}).success
		).toBe(false);
		expect(
			publicationEnsureRequestSchema.safeParse({
				...ensure,
				expectedDestinationGeneration: undefined
			}).success
		).toBe(false);
	});

	it('returns an authoritative revision selector that can be passed unchanged to ensure', () => {
		const response = {
			entries: [{ kind: 'recorded', publication, complete: true }],
			sourceSelector: selector
		};
		const resolved = publicationLookupResponseSchema.parse(response);
		expect(resolved).toStrictEqual(response);
		const request = { ...ensure, sourceSelector: resolved.sourceSelector };
		expect(publicationEnsureRequestSchema.parse(request)).toStrictEqual(
			request
		);
		expect(
			publicationLookupResponseSchema.safeParse({
				...response,
				sourceSelector: { view: 'reuse' }
			}).success
		).toBe(false);
	});

	it.each([
		{},
		{ expectedCacheGeneration: 1 },
		{ selector: {} },
		{ cache: { kind: 'default' }, expectedCacheGeneration: 0 },
		{ selector: { view: 'reuse', expectedRevision: 0 } },
		{ selector: { view: 'reuse', credential: 'secret' } },
		{ cache: { kind: 'default' }, extra: true }
	])('rejects invalid or authority-free source handles: %j', (value) => {
		expect(publicationLookupSourceSchema.safeParse(value).success).toBe(false);
	});

	it('rejects duplicate bootstrap targets and unknown expectation fields', () => {
		const target = { storePath: path(0) };
		expect(
			publicationLookupRequestSchema.safeParse({
				...lookup,
				results: [target, target]
			}).success
		).toBe(false);
		expect(
			publicationLookupTargetSchema.safeParse({ ...target, narHash: 'invalid' })
				.success
		).toBe(false);
		expect(
			publicationLookupTargetSchema.safeParse({ ...target, generation: -1 })
				.success
		).toBe(false);
		expect(
			publicationLookupTargetSchema.safeParse({ ...target, extra: true })
				.success
		).toBe(false);
	});

	it('preserves mixed bare-target lookup order without inventing identities for unavailable results', () => {
		const request = {
			source,
			results: [path(0), path(2), path(1)].map((storePath) => ({ storePath }))
		};
		expect(publicationLookupRequestSchema.parse(request)).toStrictEqual(
			request
		);
		for (const invalid of [
			{ kind: 'unavailable' },
			{ kind: 'unavailable', storePath: 'invalid' },
			{ kind: 'unavailable', storePath: path(0), narHash: version.narHash },
			{ kind: 'unavailable', storePath: path(0), generation: 0 },
			{ kind: 'unavailable', storePath: path(0), result }
		]) {
			expect(
				publicationLookupResponseSchema.safeParse({ entries: [invalid] })
					.success
			).toBe(false);
		}
	});

	it('distinguishes missing associations from unavailable and recorded but incomplete results in order', () => {
		const value = {
			entries: [
				{ kind: 'missing', result },
				{ kind: 'unavailable', storePath: path(2) },
				{
					kind: 'recorded',
					publication: {
						...publication,
						result: { ...result, storePath: path(1) }
					},
					complete: false
				}
			]
		};
		expect(publicationLookupResponseSchema.parse(value)).toStrictEqual(value);
	});

	it('accepts capture staging, first-complete winners and compact completion', () => {
		expect(publicationCaptureBeginRequestSchema.parse(begin)).toStrictEqual(
			begin
		);
		for (const value of [
			{ kind: 'existing', publication },
			{ kind: 'staging', operationId, expiresAt: '2026-11-02T00:00:00.000Z' }
		]) {
			expect(publicationCaptureBeginResponseSchema.parse(value)).toStrictEqual(
				value
			);
		}
		expect(publicationCapturePageRequestSchema.parse(page)).toStrictEqual(page);
		const accepted = { operationId, page: 0, acceptedCount: 1 };
		expect(publicationCapturePageResponseSchema.parse(accepted)).toStrictEqual(
			accepted
		);
		expect(
			publicationCaptureSealRequestSchema.parse({ operationId })
		).toStrictEqual({ operationId });
		for (const association of ['created', 'existing']) {
			const sealed = { kind: 'captured', association, publication };
			expect(publicationCaptureSealResponseSchema.parse(sealed)).toStrictEqual(
				sealed
			);
			expect(publicationStatusResponseSchema.parse(sealed)).toStrictEqual(
				sealed
			);
			expect(publicationEnsureResponseSchema.safeParse(sealed).success).toBe(
				false
			);
			const complete = {
				kind: 'complete',
				association,
				publication: { ...publication, materialisation: 'complete' }
			};
			expect(publicationEnsureResponseSchema.parse(complete)).toStrictEqual(
				complete
			);
			expect(publicationStatusResponseSchema.parse(complete)).toStrictEqual(
				complete
			);
		}
		const pending = { kind: 'pending', operationId };
		expect(publicationCaptureSealResponseSchema.parse(pending)).toStrictEqual(
			pending
		);
		expect(publicationEnsureResponseSchema.parse(pending)).toStrictEqual(
			pending
		);
		expect(publicationStatusResponseSchema.parse(pending)).toStrictEqual(
			pending
		);
		expect(publicationStatusRequestSchema.parse({ operationId })).toStrictEqual(
			{ operationId }
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
	])('preserves a typed durable failure: %s', (reason) => {
		const value = { kind: 'failed', reason };
		expect(publicationStatusResponseSchema.parse(value)).toStrictEqual(value);
	});

	it('bounds lookup and capture pages independently at 64 distinct paths', () => {
		const members = Array.from({ length: 65 }, (_, index) => ({
			...version,
			storePath: path(index)
		}));
		const atBound = members.slice(0, 64);
		expect(
			publicationLookupRequestSchema.parse({ ...lookup, results: atBound })
		).toStrictEqual({ ...lookup, results: atBound });
		expect(
			publicationCapturePageRequestSchema.parse({ ...page, members: atBound })
		).toStrictEqual({ ...page, members: atBound });
		expect(
			publicationLookupRequestSchema.safeParse({ ...lookup, results: members })
				.success
		).toBe(false);
		expect(
			publicationCapturePageRequestSchema.safeParse({ ...page, members })
				.success
		).toBe(false);
	});

	it('keeps limit failures typed and strict', () => {
		const value = { limit: 'request-bytes', maximum: 65_536 };
		expect(publicationManifestLimitErrorDataSchema.parse(value)).toStrictEqual(
			value
		);
		for (const invalid of [
			{ ...value, maximum: -1 },
			{ ...value, maximum: Number.MAX_SAFE_INTEGER + 1 },
			{ ...value, limit: 'unknown' },
			{ ...value, extra: true }
		]) {
			expect(
				publicationManifestLimitErrorDataSchema.safeParse(invalid).success
			).toBe(false);
		}
	});

	it('bounds declared captures at 100000 members', () => {
		expect(
			publicationCaptureBeginRequestSchema.parse({
				...begin,
				memberCount: 100_000
			})
		).toStrictEqual({ ...begin, memberCount: 100_000 });
		expect(
			publicationCaptureBeginRequestSchema.safeParse({
				...begin,
				memberCount: 100_001
			}).success
		).toBe(false);
	});

	it.each([
		{ ...lookup, source: undefined },
		{ ...lookup, results: [] },
		{ ...lookup, results: [version, version] },
		{ ...lookup, source: { ...source, expectedCacheGeneration: 0 } },
		{ ...lookup, source: { ...source, token: 'secret' } },
		{
			...lookup,
			source: { ...source, selector: { ...selector, expectedRevision: 0 } }
		},
		{
			...lookup,
			source: { ...source, selector: { ...selector, extra: true } }
		},
		{ ...lookup, results: [{ ...version, generation: -1 }] },
		{
			...lookup,
			results: [{ ...version, generation: Number.MAX_SAFE_INTEGER + 1 }]
		},
		{ ...lookup, results: [{ ...version, narHash: 'not-a-hash' }] },
		{ ...lookup, results: [{ ...version, storePath: '/not/a/store/path' }] },
		{ ...lookup, results: [{ ...version, cache: { kind: 'default' } }] }
	])('rejects invalid lookup identity or unknown fields: %j', (value) => {
		expect(publicationLookupRequestSchema.safeParse(value).success).toBe(false);
	});

	it.each([
		{ ...page, page: -1 },
		{ ...page, page: 0.5 },
		{ ...page, members: [] },
		{ ...page, members: [version, version] },
		{ ...page, members: [version, { ...version, generation: 2 }] },
		{ ...page, digest: 'a'.repeat(64) },
		{ ...page, operationId: '../operation' }
	])('rejects invalid pages: %j', (value) => {
		expect(publicationCapturePageRequestSchema.safeParse(value).success).toBe(
			false
		);
	});

	it.each([
		{ ...publication, memberCount: 0 },
		{ ...publication, memberCount: 100_001 },
		{ ...publication, origin: 'historical-build' },
		{ ...publication, digest: 'A'.repeat(64) },
		{ ...publication, result: { ...result, cacheGeneration: 0 } },
		{
			...publication,
			result: { ...result, cache: { kind: 'default', name: 'extra' } }
		},
		{ ...publication, members: [version] }
	])('rejects malformed recorded associations: %j', (value) => {
		expect(recordedPublicationSchema.safeParse(value).success).toBe(false);
	});

	it('refuses stale/malformed outcomes rather than converting them to missing or complete', () => {
		for (const value of [
			{ entries: [{ kind: 'missing', result, complete: false }] },
			{ entries: [{ kind: 'result-changed', result }] }
		]) {
			expect(publicationLookupResponseSchema.safeParse(value).success).toBe(
				false
			);
		}
		expect(
			compactPublicationSetSchema.safeParse({
				...publication,
				materialisation: 'pending'
			}).success
		).toBe(false);
		expect(
			publicationEnsureResponseSchema.safeParse({
				kind: 'complete',
				publication,
				association: 'existing'
			}).success
		).toBe(false);
		expect(
			publicationEnsureRequestSchema.safeParse({
				...ensure,
				expectedDestinationGeneration: 0
			}).success
		).toBe(false);
		expect(
			publicationCaptureBeginRequestSchema.safeParse({
				...begin,
				memberCount: 0
			}).success
		).toBe(false);
		expect(publicationOperationIdSchema.safeParse('../id').success).toBe(false);
		expect(
			publicationDigestSchema.safeParse(`sha256:${'1'.repeat(52)}`).success
		).toBe(false);
	});
});

describe('publicationManifestIdentity', () => {
	const a = { storePath: path(0), narHash: version.narHash };
	const b = { storePath: path(1), narHash: `sha256:${'2'.repeat(52)}` };

	it('uses portable sorted full-path/NAR membership and exact canonical bytes', async () => {
		const leaf = await publicationManifestLeafIdentity([a, b]);
		const canonical = JSON.stringify({
			version: 1,
			memberCount: 2,
			pageDigests: [leaf.digest]
		});
		expect(leaf.digest).toBe(
			'c4c7c948e133ee9c1377662f3fff8cf280fa37c170d9bdf8875ba5eac032075a'
		);
		const value = await publicationManifestIdentity([b, a, b]);
		expect(value).toStrictEqual({
			canonical,
			members: [a, b],
			digest: '4617bbc610a8f7de997400669964087de936e402c6caa0532ffd2b6003e193ca'
		});
		expect(await publicationManifestIdentity([a, b])).toStrictEqual(value);
	});

	it('normalises object key order and sorts full paths by code unit', async () => {
		const upper = { storePath: `${path(0)}-A`, narHash: a.narHash };
		const lower = { storePath: `${path(0)}-a`, narHash: b.narHash };
		const value = await publicationManifestIdentity([
			{ narHash: lower.narHash, storePath: lower.storePath },
			{ narHash: upper.narHash, storePath: upper.storePath }
		]);
		expect(value.members).toStrictEqual([upper, lower]);
		const leaf = await publicationManifestLeafIdentity([upper, lower]);
		expect(value.canonical).toBe(
			JSON.stringify({ version: 1, memberCount: 2, pageDigests: [leaf.digest] })
		);
	});

	it('never mutates caller order or invents generations', async () => {
		const members = Object.freeze([Object.freeze(b), Object.freeze(a)]);
		await publicationManifestIdentity(members);
		expect(members).toStrictEqual([b, a]);
	});

	it('bounds canonicalisation input at 100000 members', () => {
		const members = Array.from({ length: 100_000 }, () => a);
		expect(publicationManifestMembersSchema.safeParse(members).success).toBe(
			true
		);
		expect(
			publicationManifestMembersSchema.safeParse([...members, a]).success
		).toBe(false);
	});

	it('rejects conflicting NARs and empty membership', async () => {
		await expect(
			publicationManifestIdentity([a, { ...a, narHash: b.narHash }])
		).rejects.toThrow();
		await expect(publicationManifestIdentity([])).rejects.toThrow();
	});
});

describe('bounded manifest leaf and root identities', () => {
	const members = Array.from({ length: 129 }, (_, index) => ({
		storePath: path(index),
		narHash: version.narHash
	}));
	it('matches globally sorted fixed 64-member leaves regardless of input boundaries', async () => {
		const leaves = await Promise.all(
			[members.slice(0, 64), members.slice(64, 128), members.slice(128)].map(
				(page) => publicationManifestLeafIdentity(page)
			)
		);
		const root = await publicationManifestRootIdentity({
			memberCount: 129,
			pageDigests: leaves.map((leaf) => leaf.digest)
		});
		const identity = await publicationManifestIdentity([
			...members.toReversed(),
			{ storePath: path(0), narHash: version.narHash }
		]);
		expect(identity).toStrictEqual({ ...root, members });
		expect(leaves[0]?.canonical).toBe(
			JSON.stringify({ version: 1, members: members.slice(0, 64) })
		);
		expect(root.canonical).toBe(
			JSON.stringify({
				version: 1,
				memberCount: 129,
				pageDigests: leaves.map((leaf) => leaf.digest)
			})
		);
	});
	it('normalises bounded leaves and rejects oversize, empty and conflicting leaves', async () => {
		const member = { storePath: path(0), narHash: version.narHash };
		expect(
			await publicationManifestLeafIdentity([member, member])
		).toStrictEqual(await publicationManifestLeafIdentity([member]));
		await expect(publicationManifestLeafIdentity([])).rejects.toThrow();
		await expect(
			publicationManifestLeafIdentity(members.slice(0, 65))
		).rejects.toThrow();
		await expect(
			publicationManifestLeafIdentity([
				member,
				{ ...member, narHash: `sha256:${'2'.repeat(52)}` }
			])
		).rejects.toThrow();
	});
	it('bounds roots and requires the exact number of leaves', async () => {
		const leaf = await publicationManifestLeafIdentity(members.slice(0, 64));
		for (const input of [
			{ memberCount: 0, pageDigests: [] },
			{ memberCount: 65, pageDigests: [leaf.digest] },
			{ memberCount: 1, pageDigests: [leaf.digest, leaf.digest] },
			{
				memberCount: 100_001,
				pageDigests: Array.from({ length: 1563 }, () => leaf.digest)
			},
			{ memberCount: 1, pageDigests: ['invalid'] }
		]) {
			await expect(publicationManifestRootIdentity(input)).rejects.toThrow();
		}
		const root = await publicationManifestRootIdentity({
			memberCount: 100_000,
			pageDigests: Array.from({ length: 1563 }, () => leaf.digest)
		});
		expect(root.digest).toMatch(/^[0-9a-f]{64}$/);
		expect(new TextEncoder().encode(root.canonical).byteLength).toBeLessThan(
			105_000
		);
	});

	it('uses Web Crypto exactly once per leaf and root, never once per member', async () => {
		const digest = vi.spyOn(crypto.subtle, 'digest');
		try {
			const leaf = await publicationManifestLeafIdentity(members.slice(0, 64));
			expect(digest).toHaveBeenCalledTimes(1);
			await publicationManifestRootIdentity({
				memberCount: 64,
				pageDigests: [leaf.digest]
			});
			expect(digest).toHaveBeenCalledTimes(2);
		} finally {
			digest.mockRestore();
		}
	});
});
