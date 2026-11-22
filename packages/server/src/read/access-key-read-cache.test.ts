import { tenantIdSchema } from '@cupboard/nix-store/scalars';
import {
	type AuthorizationDetails,
	authorizationDetailsSchema
} from '@cupboard/protocol/grants';
import { describe, expect, it } from 'vitest';

import { sha256Hex } from '../crypto/crypto.ts';

import {
	AccessKeyReadCache,
	accessKeyReadCacheLifetimeMs,
	type ReadableAccessKey
} from './access-key-read-cache.ts';

const tenant = tenantIdSchema.parse('acme');
const id = '00000000-0000-4000-8000-000000000001';
const secret = `cupboard_ak_${id}_${'a'.repeat(64)}`;
const wrongSecret = `cupboard_ak_${id}_${'b'.repeat(64)}`;
const grants: AuthorizationDetails = authorizationDetailsSchema.parse([
	{
		type: 'cupboard_cache',
		cache: { kind: 'default' },
		actions: ['cache:content-read']
	}
]);

// A tenant object stand-in that verifies `secret` alone and records each
// call.
async function tenantObject(): Promise<{
	readonly calls: string[];
	readonly verify: (
		presented: string
	) => Promise<ReadableAccessKey | undefined>;
}> {
	const secretHash = await sha256Hex(secret);
	const calls: string[] = [];

	return {
		calls,
		verify: (presented) => {
			calls.push(presented);

			return Promise.resolve(
				presented === secret ? { secretHash, grants } : undefined
			);
		}
	};
}

describe('AccessKeyReadCache', () => {
	it('asks the tenant object on a miss and answers a hit from memory', async () => {
		const now = 0;
		const cache = new AccessKeyReadCache(() => now);
		const object = await tenantObject();

		const results = [
			await cache.grantsFor(tenant, secret, object.verify),
			await cache.grantsFor(tenant, secret, object.verify)
		];

		expect({ results, calls: object.calls }).toStrictEqual({
			results: [grants, grants],
			calls: [secret]
		});
	});

	it('asks the tenant object again once an entry is older than its lifetime', async () => {
		let now = 0;
		const cache = new AccessKeyReadCache(() => now);
		const object = await tenantObject();

		await cache.grantsFor(tenant, secret, object.verify);
		now = accessKeyReadCacheLifetimeMs - 1;
		await cache.grantsFor(tenant, secret, object.verify);
		now = accessKeyReadCacheLifetimeMs;
		await cache.grantsFor(tenant, secret, object.verify);

		expect(object.calls).toStrictEqual([secret, secret]);
	});

	it('refuses a wrong secret on a warm entry without asking the tenant object', async () => {
		const cache = new AccessKeyReadCache(() => 0);
		const object = await tenantObject();

		await cache.grantsFor(tenant, secret, object.verify);
		const wrong = await cache.grantsFor(tenant, wrongSecret, object.verify);
		const right = await cache.grantsFor(tenant, secret, object.verify);

		expect({ wrong, right, calls: object.calls }).toStrictEqual({
			wrong: undefined,
			right: grants,
			calls: [secret]
		});
	});

	it('does not remember a refusal', async () => {
		const cache = new AccessKeyReadCache(() => 0);
		const object = await tenantObject();

		const wrong = await cache.grantsFor(tenant, wrongSecret, object.verify);
		const right = await cache.grantsFor(tenant, secret, object.verify);

		expect({ wrong, right, calls: object.calls }).toStrictEqual({
			wrong: undefined,
			right: grants,
			calls: [wrongSecret, secret]
		});
	});

	it('asks the tenant object again once the key has expired', async () => {
		let now = 0;
		const cache = new AccessKeyReadCache(() => now);
		const secretHash = await sha256Hex(secret);
		const calls: string[] = [];
		const verify = (presented: string) => {
			calls.push(presented);

			return Promise.resolve(
				calls.length === 1
					? { secretHash, grants, expiresAtMs: 1000 }
					: undefined
			);
		};

		const before = await cache.grantsFor(tenant, secret, verify);
		now = 1000;
		const after = await cache.grantsFor(tenant, secret, verify);

		expect({ before, after, calls }).toStrictEqual({
			before: grants,
			after: undefined,
			calls: [secret, secret]
		});
	});

	it('sends one verification for concurrent lookups of the same secret', async () => {
		const cache = new AccessKeyReadCache(() => 0);
		const secretHash = await sha256Hex(secret);
		const calls: string[] = [];
		const held = Promise.withResolvers<ReadableAccessKey | undefined>();
		const verify = (presented: string) => {
			calls.push(presented);

			return presented === secret ? held.promise : Promise.resolve(undefined);
		};

		const first = cache.grantsFor(tenant, secret, verify);
		const second = cache.grantsFor(tenant, secret, verify);
		const wrong = cache.grantsFor(tenant, wrongSecret, verify);
		held.resolve({ secretHash, grants });

		expect({
			results: await Promise.all([first, second, wrong]),
			calls
		}).toStrictEqual({
			results: [grants, grants, undefined],
			calls: [secret, wrongSecret]
		});
	});
});
