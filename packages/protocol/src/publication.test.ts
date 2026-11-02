import {
	cacheGenerationSchema,
	cacheScopeSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { describe, expect, it, vi } from 'vitest';

import {
	publicationCanonical,
	publicationIdentity,
	publicationStagingKey,
	uploadConfirmPresentCanonicalPage,
	uploadConfirmPresentCanonicalPageByteLength,
	uploadConfirmPresentMaxCanonicalBytes
} from './publication.ts';
import {
	pushIdSchema,
	uploadAttachRootSchema,
	uploadPathNegotiationSchema
} from './upload.ts';

const input = {
	tenant: tenantIdSchema.parse('acme'),
	cache: cacheScopeSchema.parse({ kind: 'named', name: 'build' }),
	cacheGeneration: cacheGenerationSchema.parse(1),
	pushId: pushIdSchema.parse('push-1'),
	metadata: uploadPathNegotiationSchema.parse({
		storePathHash: '0'.repeat(32),
		storePath: `/nix/store/${'0'.repeat(32)}-app`,
		narHash: `sha256:${'1'.repeat(52)}`,
		narSize: 123,
		references: [`${'2'.repeat(32)}-b`, `${'1'.repeat(32)}-a`]
	})
};

describe('publication identity', () => {
	it('preserves the versioned canonical encoding', async () => {
		expect(await publicationIdentity(input)).toStrictEqual({
			id: '76bf2db7fae91857f3152fce72217241bf9c8d3eacda5123d2b84f22ad1ca054',
			canonical:
				'["cupboard/publication/v1","acme","named","build",1,"push-1",["00000000000000000000000000000000","/nix/store/00000000000000000000000000000000-app","sha256:1111111111111111111111111111111111111111111111111111",123,["11111111111111111111111111111111-a","22222222222222222222222222222222-b"],null,null],null]'
		});
	});
	it('normalises references without changing the operation', async () => {
		const original = await publicationIdentity(input);
		const reordered = await publicationIdentity({
			...input,
			metadata: uploadPathNegotiationSchema.parse({
				...input.metadata,
				references: [
					...input.metadata.references.toReversed(),
					`${'2'.repeat(32)}-b`
				]
			})
		});

		expect(reordered).toStrictEqual(original);
		expect(publicationStagingKey(input.tenant, input.pushId, original.id)).toBe(
			`staging-v2/acme/push-1/${original.id}.nar.zst`
		);
	});

	it.each([
		{ label: 'push', change: { pushId: pushIdSchema.parse('push-2') } },
		{
			label: 'cache generation',
			change: { cacheGeneration: cacheGenerationSchema.parse(2) }
		},
		{ label: 'tenant', change: { tenant: tenantIdSchema.parse('other') } }
	])('distinguishes another $label', async ({ change }) => {
		const first = await publicationIdentity(input);
		const second = await publicationIdentity({ ...input, ...change });

		expect(second.id).not.toBe(first.id);
	});
});

describe('confirmation canonical page encoding', () => {
	const page = { ...input, paths: [input.metadata] };

	it('preserves the existing publication and ConfirmationStore page domains and hash identity', async () => {
		const publication = await publicationIdentity(input);
		expect(publicationCanonical(input)).toBe(publication.canonical);
		const canonical = uploadConfirmPresentCanonicalPage(page);
		expect(canonical).toBe(
			JSON.stringify(['cupboard/confirmation/v1', [publication.canonical]])
		);
		expect(uploadConfirmPresentCanonicalPageByteLength(page)).toBe(358);
		const digest = await crypto.subtle.digest(
			'SHA-256',
			new TextEncoder().encode(canonical)
		);
		expect(
			Array.from(new Uint8Array(digest), (byte) =>
				byte.toString(16).padStart(2, '0')
			).join('')
		).toBe('d4e785632b3dd0769eec2250a899a3c23d29921c4f96fcb63f385fc4950be3bf');
	});

	it('normalises reference order and duplicates without mutating caller arrays', () => {
		const references = [
			...input.metadata.references.toReversed(),
			...input.metadata.references
		];
		const metadata = uploadPathNegotiationSchema.parse({
			...input.metadata,
			references
		});
		const value = { ...page, paths: [metadata] };
		expect(uploadConfirmPresentCanonicalPage(value)).toBe(
			uploadConfirmPresentCanonicalPage(page)
		);
		expect(uploadConfirmPresentCanonicalPageByteLength(value)).toBe(
			uploadConfirmPresentCanonicalPageByteLength(page)
		);
		expect(metadata.references).toStrictEqual(references);
	});

	it('binds page grouping/order, tenant/cache generation, push and root intent', () => {
		const second = uploadPathNegotiationSchema.parse({
			...input.metadata,
			storePathHash: '1'.repeat(32),
			storePath: `/nix/store/${'1'.repeat(32)}-other`
		});
		const value = { ...page, paths: [input.metadata, second] };
		const canonical = uploadConfirmPresentCanonicalPage(value);
		for (const changed of [
			{ ...value, paths: [second, input.metadata] },
			{ ...value, paths: [input.metadata] },
			{ ...value, tenant: tenantIdSchema.parse('other') },
			{ ...value, cache: cacheScopeSchema.parse({ kind: 'default' }) },
			{ ...value, cacheGeneration: cacheGenerationSchema.parse(2) },
			{ ...value, pushId: pushIdSchema.parse('push-2') },
			{ ...value, attachRoot: uploadAttachRootSchema.parse({ name: 'ci' }) }
		]) {
			expect(uploadConfirmPresentCanonicalPage(changed)).not.toBe(canonical);
		}
	});

	it('counts UTF-8 bytes after both JSON encodings, including escaping and root metadata', async () => {
		const metadata = uploadPathNegotiationSchema.parse({
			...input.metadata,
			ca: String.raw`é"\🚀`
		});
		const attachRoot = uploadAttachRootSchema.parse({
			name: 'réserve:🚀',
			retention: { kind: 'duration', seconds: 60 }
		});
		const value = { ...page, paths: [metadata], attachRoot };
		const identity = await publicationIdentity({
			...input,
			metadata,
			attachRoot
		});
		const expected = JSON.stringify([
			'cupboard/confirmation/v1',
			[identity.canonical]
		]);
		expect(uploadConfirmPresentCanonicalPage(value)).toBe(expected);
		expect(uploadConfirmPresentCanonicalPageByteLength(value)).toBe(
			new TextEncoder().encode(expected).byteLength
		);
		expect(uploadConfirmPresentCanonicalPageByteLength(value)).toBeGreaterThan(
			expected.length
		);
	});

	it('encodes and measures without calculating any crypto digest', () => {
		const digest = vi.spyOn(crypto.subtle, 'digest');
		try {
			expect(publicationCanonical(input)).toBeTypeOf('string');
			expect(uploadConfirmPresentCanonicalPage(page)).toBeTypeOf('string');
			expect(uploadConfirmPresentCanonicalPageByteLength(page)).toBe(358);
			expect(digest).not.toHaveBeenCalled();
		} finally {
			digest.mockRestore();
		}
	});

	it('bounds every valid tenant length using a public 63-character placeholder', () => {
		const tenant = tenantIdSchema.parse('a'.repeat(63));
		const budget = uploadConfirmPresentCanonicalPageByteLength({
			...page,
			tenant
		});
		for (let length = 1; length <= 63; length++) {
			const actualTenant = tenantIdSchema.parse('b'.repeat(length));
			expect(
				uploadConfirmPresentCanonicalPageByteLength({
					...page,
					tenant: actualTenant
				})
			).toBeLessThanOrEqual(budget);
		}
		expect(tenantIdSchema.safeParse('a'.repeat(64)).success).toBe(false);
		expect(tenantIdSchema.safeParse('é'.repeat(63)).success).toBe(false);
	});

	it('distinguishes the exact 2000000-byte budget from the next byte on a valid large-reference page', () => {
		expect(uploadConfirmPresentMaxCanonicalBytes).toBe(2_000_000);
		const references = Array.from(
			{ length: 10_000 },
			(_, index) => `${index.toString(2).padStart(32, '0')}-${'a'.repeat(211)}`
		);
		const candidate = (count: number, ca = '') => ({
			...page,
			tenant: tenantIdSchema.parse('a'.repeat(63)),
			paths: [
				uploadPathNegotiationSchema.parse({
					...input.metadata,
					references: references.slice(0, count),
					ca
				})
			]
		});
		let lower = 0;
		let upper = references.length;
		while (lower < upper) {
			const middle = Math.ceil((lower + upper) / 2);
			if (
				uploadConfirmPresentCanonicalPageByteLength(candidate(middle)) <=
				uploadConfirmPresentMaxCanonicalBytes
			) {
				lower = middle;
			} else {
				upper = middle - 1;
			}
		}
		const padding =
			uploadConfirmPresentMaxCanonicalBytes -
			uploadConfirmPresentCanonicalPageByteLength(candidate(lower));
		expect(padding).toBeLessThan(1024);
		const atBudget = candidate(lower, 'x'.repeat(padding));
		const aboveBudget = candidate(lower, 'x'.repeat(padding + 1));
		expect(uploadConfirmPresentCanonicalPageByteLength(atBudget)).toBe(
			uploadConfirmPresentMaxCanonicalBytes
		);
		expect(uploadConfirmPresentCanonicalPageByteLength(aboveBudget)).toBe(
			uploadConfirmPresentMaxCanonicalBytes + 1
		);
	});
});
