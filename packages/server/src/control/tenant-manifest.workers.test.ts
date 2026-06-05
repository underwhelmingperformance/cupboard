import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { readTenantManifest, type TenantManifest } from './tenant-manifest.ts';

function manifest(version: number, tenants: string[]): TenantManifest {
	return {
		version,
		tenants: Object.fromEntries(
			tenants.map((id) => [
				id,
				{
					status: 'active' as const,
					readMode: 'private' as const,
					configVersion: 1
				}
			])
		)
	};
}

describe('readTenantManifest', () => {
	it('returns undefined when nothing is published', async () => {
		expect(await readTenantManifest(env.TENANT_CACHE)).toBeUndefined();
	});

	it('resolves the version named by the current pointer', async () => {
		await env.TENANT_CACHE.put(
			'manifest:2',
			JSON.stringify(manifest(2, ['x', 'y']))
		);
		await env.TENANT_CACHE.put(
			'manifest:1',
			JSON.stringify(manifest(1, ['x']))
		);
		await env.TENANT_CACHE.put('manifest:current', '2');

		const resolved = await readTenantManifest(env.TENANT_CACHE);

		expect(Object.keys(resolved?.tenants ?? {}).toSorted()).toStrictEqual([
			'x',
			'y'
		]);
	});

	it('fails closed when the current pointer body is missing', async () => {
		await env.TENANT_CACHE.put('manifest:current', '3');

		expect(await readTenantManifest(env.TENANT_CACHE)).toBeUndefined();
	});

	it('fails closed when the current pointer is malformed', async () => {
		await env.TENANT_CACHE.put('manifest:current', 'latest');

		expect(await readTenantManifest(env.TENANT_CACHE)).toBeUndefined();
	});

	it('fails closed when the current body is malformed', async () => {
		await env.TENANT_CACHE.put('manifest:2', '{"version":');
		await env.TENANT_CACHE.put('manifest:current', '2');

		expect(await readTenantManifest(env.TENANT_CACHE)).toBeUndefined();
	});
});
