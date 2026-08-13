import { existsSync } from 'node:fs';
import process from 'node:process';

import {
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { storeDirectorySchema } from '@cupboard/nix-store/scalars';
import { describe, expect, it, type TestContext } from 'vitest';

import { Nix } from '../../packages/nix/src/nix.ts';
import {
	NixDaemonConnectionError,
	NixDaemonStoreClient
} from '../../packages/nix/src/nix-daemon.ts';
import { NixStorePathNotFoundError } from '../../packages/nix/src/nix-store.ts';
import { runCommand } from '../support/process.ts';

const socketPath =
	process.env.NIX_DAEMON_SOCKET_PATH ?? '/nix/var/nix/daemon-socket/socket';
const absentPath = storePathSchema.parse(
	'/nix/store/00000000000000000000000000000000-cupboard-missing'
);
const executableStorePath = /^\/nix\/store\/[^/]+/u.exec(process.execPath)?.[0];

// Connecting to the daemon socket needs a peer the daemon accepts; outside CI
// a sandboxed process may be refused with EPERM, which is a limitation of the
// environment, never a defect in the client under test.
function isPermissionDenied(error: unknown): boolean {
	if (!(error instanceof NixDaemonConnectionError)) {
		return false;
	}

	const cause = error.cause;

	return cause instanceof Error && 'code' in cause && cause.code === 'EPERM';
}

async function skippingPermissionDenied<T>(
	context: Pick<TestContext, 'skip'>,
	run: () => Promise<T>
): Promise<T> {
	try {
		return await run();
	} catch (error) {
		if (isPermissionDenied(error) && process.env.CI === undefined) {
			context.skip();
		}

		throw error;
	}
}

async function withDaemon<T>(
	context: Pick<TestContext, 'skip'>,
	run: (daemon: NixDaemonStoreClient) => Promise<T>,
	overrides: Readonly<Record<string, string>> = {}
): Promise<T> {
	return skippingPermissionDenied(context, () =>
		run(new NixDaemonStoreClient({ socketPath, overrides }))
	);
}

// The test process itself has to run from the store for its own store path to
// be a known-valid query subject; anywhere else the case skips.
function requireExecutableStorePath(
	context: Pick<TestContext, 'skip'>
): StorePathString {
	if (executableStorePath === undefined) {
		context.skip();
		throw new Error('unreachable: skip does not return');
	}

	return storePathSchema.parse(executableStorePath);
}

// A derivation this Nix writes, with the given attributes folded in. It is
// never built, so the builder need only be a plausible path.
async function instantiate(attributes: string): Promise<string> {
	const { stdout } = await runCommand('nix-instantiate', [
		'--expr',
		`derivation {
			name = "cupboard-substitution-option";
			system = builtins.currentSystem;
			builder = "/bin/sh";
			args = [ "-c" "echo hi > $out" ];
			${attributes}
		}`
	]);

	return stdout.trim();
}

describe.skipIf(!existsSync(socketPath))('nix daemon end to end', () => {
	it('answers empty batched queries with empty sets', async (context) => {
		const answers = await withDaemon(context, async (daemon) => ({
			valid: await daemon.queryValidPaths([]),
			substitutable: await daemon.querySubstitutablePaths([])
		}));

		expect(answers).toStrictEqual({ valid: [], substitutable: [] });
	});

	it('filters an absent path from a valid-path-info batch', async (context) => {
		const executable = requireExecutableStorePath(context);
		const infos = await withDaemon(context, (daemon) =>
			daemon.queryValidPathsInfo([executable, absentPath])
		);

		expect(
			infos.map((info) => ({
				storePath: info.storePath,
				narHashPrefix: info.narHash.toString().slice(0, 'sha256:'.length),
				narSizeAboveZero: info.narSize > 0,
				referencesListed: Array.isArray(info.references)
			}))
		).toStrictEqual([
			{
				storePath: executable,
				narHashPrefix: 'sha256:',
				narSizeAboveZero: true,
				referencesListed: true
			}
		]);
	});

	it('reads a valid path through the per-path fallback', async (context) => {
		const executable = requireExecutableStorePath(context);
		const infos = await withDaemon(context, (daemon) =>
			daemon.queryPathsInfo([executable])
		);

		expect(infos.map((info) => info.storePath)).toStrictEqual([executable]);
	});

	it('rejects a batched info query over an absent path', async (context) => {
		const outcome = await withDaemon(context, async (daemon) => {
			try {
				return { value: await daemon.queryPathsInfo([absentPath]) };
			} catch (error) {
				if (!(error instanceof NixStorePathNotFoundError)) {
					throw error;
				}

				return { error: { name: error.name, storePath: error.storePath } };
			}
		});

		expect(outcome).toStrictEqual({
			error: {
				name: 'NixStorePathNotFoundError',
				storePath: absentPath
			}
		});
	});

	it('classifies an absent path in exactly one partition set', async (context) => {
		const partition = await withDaemon(context, (daemon) =>
			daemon.queryMissing([absentPath])
		);
		const membership = [
			partition.willBuild,
			partition.willSubstitute,
			partition.unknown
		].filter((paths) => paths.includes(absentPath)).length;

		expect({
			membership,
			downloadSizeAtLeastZero: partition.downloadSize >= 0,
			narSizeAtLeastZero: partition.narSize >= 0
		}).toStrictEqual({
			membership: 1,
			downloadSizeAtLeastZero: true,
			narSizeAtLeastZero: true
		});
	});

	it('offers substitutable info only for paths a substituter serves', async (context) => {
		const executable = requireExecutableStorePath(context);
		const infos = await withDaemon(context, (daemon) =>
			daemon.querySubstitutablePathInfos([executable, absentPath])
		);

		expect({
			offeredPathsWereAsked: infos.every(
				(info) => info.storePath === executable
			),
			offeredTheAbsentPath: infos.some((info) => info.storePath === absentPath),
			sizesAtLeastZero: infos.every(
				(info) => info.downloadSize >= 0 && info.narSize >= 0
			),
			referencesListed: infos.every((info) => Array.isArray(info.references))
		}).toStrictEqual({
			offeredPathsWereAsked: true,
			offeredTheAbsentPath: false,
			sizesAtLeastZero: true,
			referencesListed: true
		});
	});

	// The walk that proves a closure is held upstream depends on this: the
	// substituter list a connection sets decides the answer, so a connection
	// that permits none can offer nothing, however much this machine holds.
	it('offers nothing when the connection permits no substituters', async (context) => {
		const executable = requireExecutableStorePath(context);
		const infos = await withDaemon(
			context,
			(daemon) => daemon.querySubstitutablePathInfos([executable]),
			{ substituters: '', 'extra-substituters': '' }
		);

		expect(infos).toStrictEqual([]);
	});

	// A path this machine holds is still not held upstream, and the walk has
	// to say so: with no substituter permitted, even a valid root fails. The
	// daemon answers for what this machine holds while the walk asks the
	// permitted substituters itself, which here are none.
	it('refuses a closure whose root no permitted substituter offers', async (context) => {
		const executable = requireExecutableStorePath(context);
		const nix = Nix.openForAvailability(undefined, {
			overrides: { substituters: '', 'extra-substituters': '' }
		});
		const verdict = await skippingPermissionDenied(context, () =>
			nix.resolveSubstitutableClosure(executable)
		);

		expect(verdict).toStrictEqual({
			kind: 'not-served',
			storePath: executable
		});
	});

	// The substitution option lives in the derivation's environment, which no
	// store operation reports, so the parser is exercised against derivations
	// this Nix wrote rather than against hand-built terms.
	it.each([
		{
			name: 'a derivation that says nothing about substitution',
			attributes: '',
			expected: true
		},
		{
			name: 'a derivation with allowSubstitutes = false',
			attributes: 'allowSubstitutes = false;',
			expected: false
		},
		{
			name: 'structured attributes with allowSubstitutes = false',
			attributes: '__structuredAttrs = true; allowSubstitutes = false;',
			expected: false
		}
	])(
		'reads the substitution option out of $name',
		async ({ attributes, expected }) => {
			const drvPath = await instantiate(attributes);
			const nix = Nix.forStore(new NixDaemonStoreClient({ socketPath }), {
				storeDirectory: storeDirectorySchema.parse('/nix/store')
			});

			await expect(nix.canSubstituteDerivation(drvPath)).resolves.toBe(
				expected
			);
		}
	);

	it('reports one of the three trust levels', async (context) => {
		const trust = await withDaemon(context, (daemon) => daemon.daemonTrust());

		expect(['trusted', 'not-trusted', 'unknown']).toContain(trust);
	});
});
