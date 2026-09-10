import type { CacheAccessMode } from '@cupboard/nix-store/scalars';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import {
	initialiseViaWorker,
	namedCache,
	putWorkerTestCache,
	readFetch,
	resetTestServer
} from '../test-support.ts';

const storePathHash = 'a'.repeat(32);
const digest = 'b'.repeat(64);
const publicName = 'builds';
const privateName = 'private-builds';

async function provisionCaches(): Promise<void> {
	const token = await initialiseViaWorker();

	const caches: (readonly [string, CacheAccessMode])[] = [
		[publicName, 'public'],
		[privateName, 'private']
	];

	for (const [name, access] of caches) {
		await putWorkerTestCache(token, namedCache(name), access);
	}
}

describe('private cache reads', () => {
	beforeEach(resetTestServer);

	it.each([
		{ name: 'nix-cache-info', suffix: '/nix-cache-info' },
		{ name: 'a narinfo', suffix: `/${storePathHash}.narinfo` },
		{
			name: 'a NAR',
			suffix: `/nar/sha256:${'c'.repeat(52)}.nar.zst`
		},
		{ name: 'an attestation list', suffix: `/attestations/${storePathHash}` },
		{
			name: 'an attestation bundle',
			suffix: `/attestation-bundles/${digest}`
		}
	])(
		'requires a credential for $name in a private cache',
		async ({ suffix }) => {
			await provisionCaches();

			const response = await readFetch(`/cache/${privateName}${suffix}`);

			expect({
				status: response.status,
				challenge: response.headers.get('www-authenticate'),
				control: response.headers.get('cache-control')
			}).toStrictEqual({
				status: StatusCodes.UNAUTHORIZED,
				challenge: 'Basic realm="cupboard"',
				control: 'no-store'
			});
		}
	);

	it('requires a credential for private cache information', async () => {
		await provisionCaches();

		const publicResponse = await readFetch(
			`/cache/${publicName}/nix-cache-info`
		);
		const privateResponse = await readFetch(
			`/cache/${privateName}/nix-cache-info`
		);

		expect({
			public: publicResponse.status,
			private: privateResponse.status,
			privateCacheControl: privateResponse.headers.get('cache-control')
		}).toStrictEqual({
			public: StatusCodes.OK,
			private: StatusCodes.UNAUTHORIZED,
			privateCacheControl: 'no-store'
		});
	});

	it.each([
		{
			name: 'an attestation list identifier',
			suffix: '/attestations/not-a-hash'
		},
		{
			name: 'an attestation bundle identifier',
			suffix: '/attestation-bundles/not-a-digest.sigstore.json'
		}
	])('rejects $name before applying cache access', async ({ suffix }) => {
		await provisionCaches();

		const publicResponse = await readFetch(`/cache/${publicName}${suffix}`);
		const privateResponse = await readFetch(`/cache/${privateName}${suffix}`);

		expect({
			public: publicResponse.status,
			private: privateResponse.status
		}).toStrictEqual({
			public: StatusCodes.BAD_REQUEST,
			private: StatusCodes.BAD_REQUEST
		});
	});
});
