import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';

import { CupboardTestServer } from './cupboard-server.ts';
import { sharedWorkerBundle } from './e2e-artifacts.ts';
import { withTemporaryDirectory } from './filesystem.ts';

it('shares only immutable bundles across fresh running servers', async () => {
	const directory = await mkdtemp(
		path.join(tmpdir(), 'cupboard-artifact-isolation-')
	);
	const servers: CupboardTestServer[] = [];
	try {
		const bundle = await sharedWorkerBundle(process.cwd());
		expect(bundle).toBeDefined();
		const first = await CupboardTestServer.start(path.join(directory, 'first'));
		servers.push(first);
		const second = await CupboardTestServer.start(
			path.join(directory, 'second'),
			{ provision: false }
		);
		servers.push(second);
		const firstInfo = await fetch(first.tenantPath('/nix-cache-info'));
		const secondInfo = await fetch(second.tenantPath('/nix-cache-info'));

		expect({
			firstStatus: firstInfo.status,
			secondStatus: secondInfo.status,
			differentIssuer: first.issuer.issuer !== second.issuer.issuer,
			differentPort: first.url.port !== second.url.port,
			sharedBundle: await sharedWorkerBundle(process.cwd())
		}).toStrictEqual({
			firstStatus: 200,
			secondStatus: 404,
			differentIssuer: true,
			differentPort: true,
			sharedBundle: bundle
		});
		await firstInfo.arrayBuffer();
		await secondInfo.arrayBuffer();
		await first.stop();
		servers.shift();
		const third = await CupboardTestServer.start(path.join(directory, 'third'));
		servers.push(third);
		const thirdInfo = await fetch(third.tenantPath('/nix-cache-info'));
		expect(thirdInfo.status).toBe(200);
		await thirdInfo.arrayBuffer();
	} finally {
		await Promise.all(servers.map((server) => server.stop()));
		await rm(directory, { recursive: true, force: true });
	}
});

it('closes the alarm fence after a rejected pass and permits another pass', () =>
	withTemporaryDirectory('cupboard-alarm-rejection-', async (directory) => {
		const server = await CupboardTestServer.start(directory);
		const states: boolean[] = [];
		const failure = new Error('manual alarm callback failed');
		try {
			await expect(
				server.withManualAlarms(async (runAlarmPass) => {
					states.push(await server.isManualAlarmFenceOpen());
					await runAlarmPass();
					throw failure;
				})
			).rejects.toBe(failure);
			states.push(await server.isManualAlarmFenceOpen());
			await server.withManualAlarms(async (runAlarmPass) => {
				states.push(await server.isManualAlarmFenceOpen());
				await runAlarmPass();
			});
			states.push(await server.isManualAlarmFenceOpen());
			expect(states).toStrictEqual([true, false, true, false]);
		} finally {
			await server.stop();
		}
	}));
