import { cacheScopeSchema, rootNameSchema } from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { describe, expect, it } from 'vitest';

import { authorizationDetailSchema, isCoveredByToken } from '../grants.ts';
import { publicationManifestLimitErrorDataSchema } from '../publication-manifests.ts';

import { tenantContract } from './tenant.ts';

const namedCachePrefix = '/cache/{cacheName}';
const operationId = '550e8400-e29b-41d4-a716-446655440000';
const version = {
	storePath: `/nix/store/${'0'.repeat(32)}-app`,
	narHash: `sha256:${'1'.repeat(52)}`,
	generation: 0
};
const publication = {
	result: {
		...version,
		cache: { kind: 'named', name: 'source' },
		cacheGeneration: 1
	},
	digest: 'a'.repeat(64),
	memberCount: 1,
	origin: 'build-selection'
};
const declarations = [
	{
		name: 'lookup',
		method: 'POST',
		suffix: '/publication-results/lookup',
		maintenance: false,
		input: {
			source: {
				cache: { kind: 'named', name: 'source' },
				expectedCacheGeneration: 1
			},
			results: [version]
		}
	},
	{
		name: 'captureBegin',
		method: 'POST',
		suffix: '/publication-results/captures',
		maintenance: true,
		input: {
			result: version,
			expectedCacheGeneration: 1,
			requestId: operationId,
			origin: 'build-selection',
			memberCount: 1
		}
	},
	{
		name: 'capturePage',
		method: 'PUT',
		suffix: '/publication-results/captures/{operationId}/pages/{page}',
		maintenance: true,
		input: { operationId, page: 0, members: [version] }
	},
	{
		name: 'captureSeal',
		method: 'POST',
		suffix: '/publication-results/captures/{operationId}/seal',
		maintenance: true,
		input: { operationId }
	},
	{
		name: 'ensure',
		method: 'POST',
		suffix: '/publication-results/ensure',
		maintenance: true,
		input: {
			requestId: operationId,
			source: publication,
			expectedDestinationGeneration: 1,
			runRoot: 'ci'
		}
	},
	{
		name: 'status',
		method: 'GET',
		suffix: '/publication-results/operations/{operationId}',
		maintenance: false,
		input: { operationId }
	}
] as const;

describe('publication manifest contract', () => {
	it.each(declarations)(
		'declares both destination scopes for $name',
		({ name, method, suffix, maintenance, input }) => {
			for (const variant of ['inDefaultCache', 'inNamedCache'] as const) {
				const definition = tenantContract.publication[name][variant]['~orpc'];
				const isNamed = variant === 'inNamedCache';
				expect(definition.route).toStrictEqual({
					method,
					path: isNamed ? `${namedCachePrefix}${suffix}` : suffix
				});
				expect(definition.meta).toStrictEqual({
					requires: 'upload:commit',
					resource: { cache: { fromPath: true } },
					replaySafety: 'replay-safe',
					...(maintenance && { maintenance: true })
				});
				const value = {
					...input,
					...(isNamed && { cacheName: 'destination' })
				};
				expect(definition.inputSchema?.parse(value)).toStrictEqual(value);
				expect(
					definition.inputSchema?.safeParse({ ...value, credentials: 'secret' })
						.success
				).toBe(false);
				expect(
					Object.keys(definition.errorMap).toSorted(byCodeUnit)
				).toStrictEqual(
					[
						'UNAUTHORIZED',
						'FORBIDDEN',
						'BAD_REQUEST',
						'NOT_FOUND',
						'CONFLICT',
						'GONE',
						'PAYLOAD_TOO_LARGE',
						'SERVICE_UNAVAILABLE',
						'PUBLICATION_RESULT_CHANGED',
						'PUBLICATION_SCOPE_CHANGED',
						'PUBLICATION_GENERATION_CONFLICT',
						'PUBLICATION_IDEMPOTENCY_CONFLICT',
						'PUBLICATION_INVALID_PAGE',
						'PUBLICATION_LIMIT_EXCEEDED',
						'PUBLICATION_DIVERGENCE',
						...(maintenance
							? ['CACHE_CLOSED', 'CACHE_RETENTION_MIGRATION_PENDING']
							: [])
					].toSorted(byCodeUnit)
				);
				expect(definition.errorMap.PUBLICATION_RESULT_CHANGED).toStrictEqual({
					status: 409
				});
				expect(definition.errorMap.PUBLICATION_LIMIT_EXCEEDED).toStrictEqual({
					status: 413,
					data: publicationManifestLimitErrorDataSchema
				});
			}
		}
	);

	it('allows bootstrap view lookup and rejects empty sources in both destination scopes', () => {
		for (const variant of ['inDefaultCache', 'inNamedCache'] as const) {
			const scope =
				variant === 'inNamedCache' ? { cacheName: 'destination' } : {};
			const value = {
				...scope,
				source: { selector: { view: 'reuse' } },
				results: [{ storePath: version.storePath }]
			};
			const definition = tenantContract.publication.lookup[variant]['~orpc'];
			expect(definition.inputSchema?.parse(value)).toStrictEqual(value);
			expect(
				definition.inputSchema?.safeParse({ ...value, source: {} }).success
			).toBe(false);
			const output = {
				entries: [
					{ kind: 'missing', result: publication.result },
					{ kind: 'unavailable', storePath: `${version.storePath}-missing` }
				],
				sourceSelector: { view: 'reuse', expectedRevision: 2 }
			};
			expect(definition.outputSchema?.parse(output)).toStrictEqual(output);
		}
	});

	it('keeps bounded capture completion distinct from ensured materialisation in both scopes', () => {
		for (const variant of ['inDefaultCache', 'inNamedCache'] as const) {
			const seal =
				tenantContract.publication.captureSeal[variant]['~orpc'].outputSchema;
			const status =
				tenantContract.publication.status[variant]['~orpc'].outputSchema;
			const ensure =
				tenantContract.publication.ensure[variant]['~orpc'].outputSchema;
			const pending = { kind: 'pending', operationId };
			const captured = {
				kind: 'captured',
				association: 'created',
				publication
			};
			const complete = {
				kind: 'complete',
				association: 'created',
				publication: { ...publication, materialisation: 'complete' }
			};
			for (const output of [pending, captured]) {
				expect(seal?.parse(output)).toStrictEqual(output);
				expect(status?.parse(output)).toStrictEqual(output);
			}
			expect(ensure?.parse(complete)).toStrictEqual(complete);
			expect(status?.parse(complete)).toStrictEqual(complete);
			expect(ensure?.safeParse(captured).success).toBe(false);
			expect(seal?.safeParse(complete).success).toBe(false);
		}
	});

	it('retains nested duplicate refinements in named and default inputs', () => {
		for (const variant of ['inDefaultCache', 'inNamedCache'] as const) {
			const cache =
				variant === 'inNamedCache' ? { cacheName: 'destination' } : {};
			expect(
				tenantContract.publication.lookup[variant][
					'~orpc'
				].inputSchema?.safeParse({
					...cache,
					source: { cache: { kind: 'default' }, expectedCacheGeneration: 1 },
					results: [version, version]
				}).success
			).toBe(false);
			expect(
				tenantContract.publication.capturePage[variant][
					'~orpc'
				].inputSchema?.safeParse({
					...cache,
					operationId,
					page: 0,
					members: [version, version]
				}).success
			).toBe(false);
		}
	});

	it('does not imply private source read or root:set authority from destination commit', () => {
		const destination = cacheScopeSchema.parse({ kind: 'default' });
		const source = cacheScopeSchema.parse({ kind: 'named', name: 'source' });
		const grant = authorizationDetailSchema.parse({
			type: 'cupboard_cache',
			cache: destination,
			actions: ['upload:commit']
		});
		expect(
			isCoveredByToken([grant], 'upload:commit', { cache: destination })
		).toBe(true);
		expect(
			isCoveredByToken([grant], 'cache:content-read', { cache: source })
		).toBe(false);
		expect(
			isCoveredByToken([grant], 'root:set', {
				cache: destination,
				root: rootNameSchema.parse('ci')
			})
		).toBe(false);
	});
});
