import {
	cacheGenerationSchema,
	cacheScopeSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import { publicationIdentity, publicationStagingKey } from './publication.ts';
import { pushIdSchema, uploadPathNegotiationSchema } from './upload.ts';

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
