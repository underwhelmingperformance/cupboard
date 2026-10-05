import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	type EmbeddedPayload,
	payloadToArtifact
} from '../../packages/cli/src/deploy/artifact.ts';

import {
	createEndToEndArtifactRerun,
	type EndToEndArtifactBuilders,
	type EndToEndArtifactManifest,
	EndToEndArtifactRun,
	registerEndToEndArtifacts,
	sharedStagedDeployment,
	sharedWorkerBundle
} from './e2e-artifacts.ts';

const directories: string[] = [];
const runs: EndToEndArtifactRun[] = [];
const payload: EmbeddedPayload = {
	controlSource: JSON.stringify({
		name: 'cupboard',
		compatibility_date: '2026-05-15'
	}),
	tenantSource: JSON.stringify({
		name: 'cupboard-tenant',
		compatibility_date: '2026-05-15'
	}),
	controlBundle: { mainModule: 'worker.js', code: 'current-control' },
	tenantBundle: { mainModule: 'tenant-worker.js', code: 'current-tenant' },
	d1Migrations: [],
	buildVersion: 'fixture-version'
};

afterEach(async () => {
	registerEndToEndArtifacts(undefined);
	await Promise.all(runs.splice(0).map((run) => run.dispose()));
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true }))
	);
});

async function checkout(): Promise<string> {
	const directory = await mkdtemp(
		path.join(tmpdir(), 'cupboard-artifacts-test-')
	);
	directories.push(directory);
	return realpath(directory);
}

function builders(): EndToEndArtifactBuilders {
	return {
		currentPayload: vi.fn(() => Promise.resolve(payload)),
		workerBundle: vi.fn<EndToEndArtifactBuilders['workerBundle']>(
			(_root, directory) =>
				Promise.resolve({
					directory,
					controlEntrypoint: 'worker.mjs',
					tenantEntrypoint: 'tenant.mjs'
				})
		),
		predecessorBundles: vi.fn(() =>
			Promise.resolve({
				control: 'predecessor-control',
				tenant: 'predecessor-tenant'
			})
		)
	};
}

describe('run-owned e2e artifacts', () => {
	it('prepares the current payload before other bundles and shares concurrent requests', async () => {
		const root = await checkout();
		const ready = Promise.withResolvers<EmbeddedPayload>();
		const build = { ...builders(), currentPayload: vi.fn(() => ready.promise) };
		const run = new EndToEndArtifactRun(root, build);
		runs.push(run);
		const first = run.prepare();
		const second = run.prepare();

		expect(build.workerBundle).not.toHaveBeenCalled();
		expect(build.predecessorBundles).not.toHaveBeenCalled();
		ready.resolve(payload);
		const [manifest, concurrent] = await Promise.all([first, second]);

		expect(concurrent).toBe(manifest);
		expect(build.currentPayload).toHaveBeenCalledTimes(1);
		expect(build.workerBundle).toHaveBeenCalledTimes(1);
		expect(build.predecessorBundles).toHaveBeenCalledTimes(1);
		expect(
			JSON.parse(await readFile(manifest.currentPayloadPath, 'utf8'))
		).toStrictEqual(payload);
	});

	it('uses registered artifacts only for their checkout and restores live-build fallback', async () => {
		const root = await checkout();
		const other = await checkout();
		const run = new EndToEndArtifactRun(root, builders());
		runs.push(run);
		const manifest = await run.prepare();
		registerEndToEndArtifacts(manifest);

		expect(await sharedWorkerBundle(root)).toStrictEqual(manifest.workerBundle);
		expect(await sharedStagedDeployment(root)).toStrictEqual({
			bundles: { control: 'predecessor-control', tenant: 'predecessor-tenant' },
			artifact: payloadToArtifact(payload)
		});
		expect(await sharedWorkerBundle(other)).toBeUndefined();
		expect(await sharedStagedDeployment(other)).toBeUndefined();
		registerEndToEndArtifacts(undefined);
		expect(await sharedWorkerBundle(root)).toBeUndefined();
	});

	it('rebuilds live artifacts for a rerun and keeps old files until teardown', async () => {
		const root = await checkout();
		const current = vi.fn(() =>
			Promise.resolve({
				...payload,
				buildVersion: String(current.mock.calls.length)
			})
		);
		const build = { ...builders(), currentPayload: current };
		const run = new EndToEndArtifactRun(root, build);
		runs.push(run);
		const first = await run.prepare();
		const second = await run.rebuild();

		expect(first.currentPayloadPath).not.toBe(second.currentPayloadPath);
		expect(
			JSON.parse(await readFile(first.currentPayloadPath, 'utf8'))
		).toStrictEqual({ ...payload, buildVersion: '1' });
		expect(
			JSON.parse(await readFile(second.currentPayloadPath, 'utf8'))
		).toStrictEqual({ ...payload, buildVersion: '2' });
		await run.dispose();
		await expect(readFile(first.currentPayloadPath)).rejects.toMatchObject({
			code: 'ENOENT'
		});
		await expect(readFile(second.currentPayloadPath)).rejects.toMatchObject({
			code: 'ENOENT'
		});
	});

	it('does not reuse a failed preparation', async () => {
		const root = await checkout();
		const current = vi
			.fn<EndToEndArtifactBuilders['currentPayload']>()
			.mockRejectedValueOnce(new Error('bundle failed'))
			.mockResolvedValue(payload);
		const build = { ...builders(), currentPayload: current };
		const run = new EndToEndArtifactRun(root, build);
		runs.push(run);

		await expect(run.prepare()).rejects.toThrow('bundle failed');
		const manifest = await run.prepare();
		expect(
			JSON.parse(await readFile(manifest.currentPayloadPath, 'utf8'))
		).toStrictEqual(payload);
		expect(current).toHaveBeenCalledTimes(2);
	});

	it('waits for concurrent preparation and rebuilding before removing their artifacts', async () => {
		const root = await checkout();
		const firstGate = {
			started: Promise.withResolvers<string>(),
			release: Promise.withResolvers<undefined>()
		};
		const secondGate = {
			started: Promise.withResolvers<string>(),
			release: Promise.withResolvers<undefined>()
		};
		const gates = [firstGate, secondGate];
		const build: EndToEndArtifactBuilders = {
			...builders(),
			async workerBundle(_root, directory) {
				const gate = gates.shift();
				if (gate === undefined) {
					throw new Error('An unexpected artifact build started');
				}
				gate.started.resolve(directory);
				await gate.release.promise;
				return {
					directory,
					controlEntrypoint: 'worker.mjs',
					tenantEntrypoint: 'tenant.mjs'
				};
			}
		};
		const run = new EndToEndArtifactRun(root, build);
		runs.push(run);
		const first = run.prepare();
		const firstOutcome = expect(first).rejects.toThrow('disposed');
		const firstDirectory = await firstGate.started.promise;
		const second = run.rebuild();
		const secondOutcome = expect(second).rejects.toThrow('disposed');
		const secondDirectory = await secondGate.started.promise;
		const disposing = run.dispose();
		const repeatedDisposal = run.dispose();
		firstGate.release.resolve(undefined);
		secondGate.release.resolve(undefined);

		await Promise.all([
			firstOutcome,
			secondOutcome,
			disposing,
			repeatedDisposal
		]);
		await expect(stat(firstDirectory)).rejects.toMatchObject({
			code: 'ENOENT'
		});
		await expect(stat(secondDirectory)).rejects.toMatchObject({
			code: 'ENOENT'
		});
		await expect(run.prepare()).rejects.toThrow('disposed');
		await expect(run.rebuild()).rejects.toThrow('disposed');
	});

	it('waits for a preparation that has not created its artifact directory', async () => {
		const root = await checkout();
		const started = Promise.withResolvers<string>();
		const release = Promise.withResolvers<undefined>();
		const build: EndToEndArtifactBuilders = {
			...builders(),
			async workerBundle(_root, directory) {
				started.resolve(directory);
				await release.promise;
				return {
					directory,
					controlEntrypoint: 'worker.mjs',
					tenantEntrypoint: 'tenant.mjs'
				};
			}
		};
		const run = new EndToEndArtifactRun(root, build);
		runs.push(run);
		const preparation = expect(run.prepare()).rejects.toThrow('disposed');
		const disposed = vi.fn();
		async function disposeArtifacts(): Promise<void> {
			await run.dispose();
			disposed();
		}
		const disposal = disposeArtifacts();
		const directory = await started.promise;

		expect(disposed).not.toHaveBeenCalled();
		release.resolve(undefined);
		await Promise.all([preparation, disposal]);
		await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('publishes overlapping watch rebuilds in their request order', async () => {
		const root = await checkout();
		const run = new EndToEndArtifactRun(root, builders());
		runs.push(run);
		const firstManifest = await run.prepare();
		const secondManifest = await run.rebuild();
		const firstGate = Promise.withResolvers<EndToEndArtifactManifest>();
		const secondGate = Promise.withResolvers<EndToEndArtifactManifest>();
		vi.spyOn(run, 'rebuild')
			.mockReturnValueOnce(firstGate.promise)
			.mockReturnValueOnce(secondGate.promise);
		const published: EndToEndArtifactManifest[] = [];
		const rerun = createEndToEndArtifactRerun(run, (manifest) => {
			published.push(manifest);
		});
		const first = rerun();
		const second = rerun();
		secondGate.resolve(secondManifest);
		await Promise.resolve();
		await Promise.resolve();
		firstGate.resolve(firstManifest);
		await Promise.all([first, second]);

		expect(published).toStrictEqual([firstManifest, secondManifest]);
	});

	it('does not publish an active watch rebuild or start a queued rebuild after disposal', async () => {
		const root = await checkout();
		const run = new EndToEndArtifactRun(root, builders());
		runs.push(run);
		const manifest = await run.prepare();
		const started = Promise.withResolvers<undefined>();
		const ready = Promise.withResolvers<EndToEndArtifactManifest>();
		const rebuild = vi.spyOn(run, 'rebuild').mockImplementation(() => {
			started.resolve(undefined);
			return ready.promise;
		});
		const publish = vi.fn();
		const rerun = createEndToEndArtifactRerun(run, publish);
		const first = rerun();
		const second = rerun();
		await started.promise;
		await run.dispose();
		ready.resolve(manifest);
		await Promise.all([first, second]);

		expect(rebuild).toHaveBeenCalledTimes(1);
		expect(publish).not.toHaveBeenCalled();
	});

	it('permits another watch rebuild after an earlier rebuild fails', async () => {
		const root = await checkout();
		const run = new EndToEndArtifactRun(root, builders());
		runs.push(run);
		const manifest = await run.prepare();
		vi.spyOn(run, 'rebuild')
			.mockRejectedValueOnce(new Error('watch bundle failed'))
			.mockResolvedValueOnce(manifest);
		const published: EndToEndArtifactManifest[] = [];
		const rerun = createEndToEndArtifactRerun(run, (current) => {
			published.push(current);
		});
		const failed = expect(rerun()).rejects.toThrow('watch bundle failed');
		const next = rerun();
		await Promise.all([failed, next]);

		expect(published).toStrictEqual([manifest]);
	});
});
