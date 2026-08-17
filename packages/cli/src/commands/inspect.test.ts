import { capturingReporter as reporter } from '@cupboard/cli-ui/testing';
import type { PathInspection } from '@cupboard/protocol/paths';
import type { ResultRow } from '@cupboard/reporter';
import { describe, expect, it } from 'vitest';

import { type InspectClient, runInspect } from './inspect.ts';

const hash = '0'.repeat(32);

function inspection(overrides: Partial<PathInspection>): PathInspection {
	return {
		cache: '',
		storePathHash: hash,
		storePath: `/nix/store/${hash}-name`,
		narHash: 'sha256:1bn7c3bf5z6n0a1xg3l6a8m2k4j9p0q7r5s3t1v8w6x4y2z0a9b8',
		narSize: 2048,
		references: [],
		generation: 0,
		createdAt: '2026-01-02T03:04:05.000Z',
		origin: { kind: 'native' },
		...overrides
	};
}

describe('runInspect', () => {
	it('reports the origin of a direct S3 push', async () => {
		const calls: Parameters<InspectClient['inspect']>[0][] = [];
		const results: ResultRow[][] = [];

		await runInspect('_default', hash, reporter(results), {
			inspect(input) {
				calls.push(input);
				return Promise.resolve(
					inspection({
						origin: {
							kind: 's3',
							credentialId: 'cred-1',
							label: 'nixbuild'
						}
					})
				);
			}
		});

		expect({ calls, results }).toStrictEqual({
			calls: [{ cacheName: '_default', hash }],
			results: [
				[
					{ label: 'Store path', value: `/nix/store/${hash}-name` },
					{
						label: 'NAR hash',
						value: 'sha256:1bn7c3bf5z6n0a1xg3l6a8m2k4j9p0q7r5s3t1v8w6x4y2z0a9b8'
					},
					{ label: 'NAR size', value: '2.05 kB' },
					{ label: 'References', value: '0' },
					{ label: 'Generation', value: '0' },
					{ label: 'Created', value: '2026-01-02 03:04 UTC' },
					{ label: 'Origin', value: 'S3 commit with nixbuild (cred-1)' }
				]
			]
		});
	});

	it('labels a native push and shows the deriver when present', async () => {
		const results: ResultRow[][] = [];

		await runInspect('_default', hash, reporter(results), {
			inspect: () =>
				Promise.resolve(
					inspection({
						deriver: `/nix/store/${hash}-name.drv`,
						origin: { kind: 'native' }
					})
				)
		});

		expect(results[0]).toStrictEqual([
			{ label: 'Store path', value: `/nix/store/${hash}-name` },
			{
				label: 'NAR hash',
				value: 'sha256:1bn7c3bf5z6n0a1xg3l6a8m2k4j9p0q7r5s3t1v8w6x4y2z0a9b8'
			},
			{ label: 'NAR size', value: '2.05 kB' },
			{ label: 'References', value: '0' },
			{ label: 'Deriver', value: `/nix/store/${hash}-name.drv` },
			{ label: 'Generation', value: '0' },
			{ label: 'Created', value: '2026-01-02 03:04 UTC' },
			{ label: 'Origin', value: 'native push' }
		]);
	});

	it('reports an S3 commit whose credential details are hidden', async () => {
		const results: ResultRow[][] = [];

		await runInspect('_default', hash, reporter(results), {
			inspect: () =>
				Promise.resolve(inspection({ origin: { kind: 'redacted' } }))
		});

		expect(results[0]?.at(-1)).toStrictEqual({
			label: 'Origin',
			value: 'S3 commit (credential hidden)'
		});
	});
});
