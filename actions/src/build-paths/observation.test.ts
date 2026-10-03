import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { discoverNixStoreConfig } from '@cupboard/nix';
import { buildEventSchema } from '@cupboard/protocol/build';
import { afterEach, describe, expect, it } from 'vitest';

import { type BuildObservation, observeBuild } from './observation.ts';

const temporaryDirectories: string[] = [];
const observations: BuildObservation[] = [];
afterEach(async () => {
	await Promise.all(
		observations.splice(0).map((observation) => observation.close())
	);
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true }))
	);
});

async function fixture(
	protect: (paths: readonly string[], signal?: AbortSignal) => Promise<void>,
	helper = ''
) {
	const directory = await mkdtemp(path.join(tmpdir(), 'cup-observe-'));
	temporaryDirectories.push(directory);
	const executable = path.join(directory, 'cupboard');
	await writeFile(path.join(directory, 'cupboard-hook-relay'), helper, {
		mode: 0o700
	});
	const observation = await observeBuild({
		environment: { RUNNER_TEMP: directory },
		config: { ...discoverNixStoreConfig(), postBuildHook: undefined },
		nix: { storeKind: 'daemon', daemonTrust: () => Promise.resolve('trusted') },
		invocationId: 'observation-test',
		cupboardPath: executable,
		protection: { directory, protect }
	});
	observations.push(observation);
	const hookPath = observation.environment.NIX_CONFIG?.split(
		'post-build-hook = ',
		2
	)[1];
	if (hookPath === undefined) {
		throw new Error('The fixture did not configure its hook');
	}
	return {
		observation,
		directory,
		socketPath: path.join(path.dirname(hookPath), 'hook.sock')
	};
}

function send(socket: string, event: unknown): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const connection = createConnection(socket);
		const chunks: Buffer[] = [];
		connection.on('connect', () =>
			connection.end(`${JSON.stringify(event)}\n`)
		);
		connection.on('data', (data: Buffer) => {
			chunks.push(data);
		});
		connection.on('error', reject);
		connection.on('end', () => {
			resolve(Buffer.concat(chunks));
		});
	});
}

const event = buildEventSchema.parse({
	version: 1,
	invocationId: 'observation-test',
	derivation: '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app.drv',
	outputPaths: ['/nix/store/3123456789abcdfghijklmnpqrsvwxyz-app']
});

describe('simple build observation', () => {
	it('protects completed outputs before acknowledging the helper', async () => {
		const protection = Promise.withResolvers<undefined>();
		const protecting = Promise.withResolvers<undefined>();
		const protectedPaths: string[] = [];
		const { observation, socketPath } = await fixture((paths) => {
			protectedPaths.push(...paths);
			protecting.resolve(undefined);
			return protection.promise;
		});
		const acknowledgement = send(socketPath, event);
		await protecting.promise;
		expect(protectedPaths).toStrictEqual(event.outputPaths);
		protection.resolve(undefined);
		expect(await acknowledgement).toStrictEqual(Buffer.from([1]));
		await observation.flush();
		expect(observation.events).toStrictEqual([event]);
	});

	it('rejects incomplete protection during flush and close', async () => {
		const { observation, socketPath } = await fixture(() =>
			Promise.reject(new Error('GC root failed'))
		);
		await send(socketPath, event);
		await expect(observation.flush()).rejects.toThrow(
			'report and protect every completed output'
		);
		await expect(observation.close()).rejects.toThrow(
			'report and protect every completed output'
		);
	});

	it('detects helper delivery failure even when the helper exits zero without connecting', async () => {
		const { observation } = await fixture(
			() => Promise.resolve(),
			'#!/bin/sh\necho "cupboard-hook-relay: delivery failed: connection refused" >&2\nexit 0\n'
		);
		const hookPath = observation.environment.NIX_CONFIG?.split(
			'post-build-hook = ',
			2
		)[1];
		if (hookPath === undefined) {
			throw new Error('The fixture did not configure its hook');
		}
		const child = spawn('/bin/sh', [hookPath], {
			env: {
				DRV_PATH: event.derivation,
				OUT_PATHS: event.outputPaths.join(' ')
			},
			stdio: 'ignore'
		});
		const status = await new Promise((resolve, reject) => {
			child.once('error', reject);
			child.once('exit', resolve);
		});
		expect(status).toBe(0);
		await expect(observation.flush()).rejects.toThrow(
			'report and protect every completed output'
		);
		await expect(observation.close()).rejects.toThrow(
			'report and protect every completed output'
		);
		expect(observation.events).toStrictEqual([]);
	});
});
