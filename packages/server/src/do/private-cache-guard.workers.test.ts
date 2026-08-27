import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import {
	initialiseViaWorker,
	readFetch,
	resetTestServer,
	workerFetch
} from '../test-support.ts';

const storePathHash = 'a'.repeat(32);
const digest = 'b'.repeat(64);

describe('private cache reads', () => {
	beforeEach(resetTestServer);

	it.each([
		{ name: 'nix-cache-info', suffix: '/nix-cache-info' },
		{ name: 'a narinfo', suffix: `/${storePathHash}.narinfo` },
		{ name: 'a NAR', suffix: `/nar/${'c'.repeat(32)}.nar` },
		{ name: 'an attestation list', suffix: `/attestations/${storePathHash}` },
		{
			name: 'an attestation bundle',
			suffix: `/attestation-bundles/${digest}.sigstore.json`
		}
	])(
		'returns 404 for $name under a private selector at the edge',
		async ({ suffix }) => {
			await initialiseViaWorker();

			const response = await readFetch(`/cache/_private-builds${suffix}`);

			expect(response.status).toBe(StatusCodes.NOT_FOUND);
		}
	);

	it('returns an uncached 404 for private cache information', async () => {
		await initialiseViaWorker();

		const publicResponse = await workerFetch('/cache/builds/nix-cache-info');
		const privateResponse = await workerFetch(
			'/cache/_private-builds/nix-cache-info'
		);

		expect({
			public: publicResponse.status,
			private: privateResponse.status,
			privateCacheControl: privateResponse.headers.get('cache-control')
		}).toStrictEqual({
			public: StatusCodes.OK,
			private: StatusCodes.NOT_FOUND,
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
	])(
		'returns 404 before parsing $name for a private cache',
		async ({ suffix }) => {
			await initialiseViaWorker();

			const publicResponse = await workerFetch(`/cache/builds${suffix}`);
			const privateResponse = await workerFetch(
				`/cache/_private-builds${suffix}`
			);

			expect({
				public: publicResponse.status,
				private: privateResponse.status
			}).toStrictEqual({
				public: StatusCodes.BAD_REQUEST,
				private: StatusCodes.NOT_FOUND
			});
		}
	);
});
