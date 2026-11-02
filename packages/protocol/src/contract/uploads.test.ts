import { cacheScopeSchema, rootNameSchema } from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import { authorizationDetailSchema, isCoveredByToken } from '../grants.ts';
import { uploadRequestLimitErrorDataSchema } from '../upload.ts';

import { cacheClosedError } from './cache-scoped.ts';
import { tenantContract } from './tenant.ts';

const hash = '0'.repeat(32);
const request = {
	pushId: 'push-1',
	cacheGeneration: 1,
	paths: [
		{
			storePathHash: hash,
			storePath: `/nix/store/${hash}-name`,
			narHash: `sha256:${'1'.repeat(52)}`,
			narSize: 1,
			references: []
		}
	]
};

// Both variants must retain the array refinements when the scoped helper
// rebuilds the input object to add the named cache's path parameter.
describe('uploads.confirmPresent contract', () => {
	it.each([
		{
			variant: 'inDefaultCache' as const,
			path: '/uploads/confirm-present',
			cacheFields: {}
		},
		{
			variant: 'inNamedCache' as const,
			path: '/cache/{cacheName}/uploads/confirm-present',
			cacheFields: { cacheName: 'release' }
		}
	])('declares and validates $variant', ({ variant, path, cacheFields }) => {
		const definition = tenantContract.uploads.confirmPresent[variant]['~orpc'];
		expect(definition.route).toStrictEqual({ method: 'POST', path });
		expect(definition.meta).toStrictEqual({
			requires: 'upload:commit',
			resource: { cache: { fromPath: true } },
			maintenance: true,
			replaySafety: 'replay-safe'
		});
		const input = definition.inputSchema;
		const value = { ...request, ...cacheFields };
		expect(input?.parse(value)).toStrictEqual(value);
		expect(
			input?.safeParse({
				...value,
				paths: [request.paths[0], request.paths[0]]
			}).success
		).toBe(false);
		expect(input?.safeParse({ ...value, extra: true }).success).toBe(false);
		expect(
			input?.safeParse({ ...value, cacheName: '../release' }).success
		).toBe(false);
		const output = {
			paths: [{ storePathHash: hash, status: 'needs-publication' }]
		};
		expect(definition.outputSchema?.parse(output)).toStrictEqual(output);
		expect(definition.errorMap).toStrictEqual({
			UNAUTHORIZED: {},
			FORBIDDEN: {},
			...cacheClosedError,
			CACHE_RETENTION_MIGRATION_PENDING: { status: 409 },
			CONFLICT: { status: 409 },
			NOT_FOUND: { status: 404 },
			SERVICE_UNAVAILABLE: { status: 503 },
			PAYLOAD_TOO_LARGE: { status: 413 },
			UPLOAD_REQUEST_LIMIT_EXCEEDED: {
				status: 413,
				data: uploadRequestLimitErrorDataSchema
			}
		});
		expect(
			definition.errorMap.UPLOAD_REQUEST_LIMIT_EXCEEDED.data.parse({
				maxPaths: 32
			})
		).toStrictEqual({ maxPaths: 32 });
		expect(
			definition.errorMap.CACHE_CLOSED.data.parse({
				cache: { kind: 'default' }
			})
		).toStrictEqual({ cache: { kind: 'default' } });
	});

	it('does not give confirmation-only or commit authority permission to attach a root', () => {
		const cache = cacheScopeSchema.parse({ kind: 'default' });
		const root = rootNameSchema.parse('ci');
		const confirmOnly = authorizationDetailSchema.parse({
			type: 'cupboard_cache',
			actions: ['upload:confirm'],
			cache
		});
		const commitOnly = authorizationDetailSchema.parse({
			type: 'cupboard_cache',
			actions: ['upload:commit'],
			cache
		});
		const operation =
			tenantContract.uploads.confirmPresent.inDefaultCache['~orpc'].meta
				.requires;
		expect(operation).toBe('upload:commit');
		expect(isCoveredByToken([confirmOnly], 'upload:commit', { cache })).toBe(
			false
		);
		expect(isCoveredByToken([commitOnly], 'upload:commit', { cache })).toBe(
			true
		);
		expect(
			isCoveredByToken([confirmOnly], 'root:attach', { cache, root })
		).toBe(false);
		expect(isCoveredByToken([commitOnly], 'root:attach', { cache, root })).toBe(
			false
		);
	});
});
