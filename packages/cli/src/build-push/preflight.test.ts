import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
	defaultFileTransferSettings,
	defaultSignatureSettings,
	type NixStoreConfig
} from '@cupboard/nix';
import {
	cacheNameSchema,
	rootNameSchema,
	storeDirectorySchema
} from '@cupboard/nix-store/scalars';
import { invocationIdSchema } from '@cupboard/protocol/build';
import { authorizationDetailsSchema } from '@cupboard/protocol/grants';
import { afterEach, describe, expect, it } from 'vitest';

import {
	HookHelperMissingError,
	MissingGrantError,
	PostBuildHookConflictError,
	RemoteBuildPushStoreError,
	SocketPathTooLongError,
	UntrustedDaemonError
} from '../errors.ts';

import {
	type BuildPushPreflightOptions,
	preflightBuildPush
} from './preflight.ts';
import { linuxSunPathBytes } from './runtime-directory.ts';

const invocationId = invocationIdSchema.parse('invocation-1');
const cache = { kind: 'named' as const, name: cacheNameSchema.parse('ci') };
const coveredRoot = rootNameSchema.parse('github:acme/repo/run-1');
const uncoveredRoot = rootNameSchema.parse('github:other/repo/run-1');
const grants = authorizationDetailsSchema.parse([
	{
		type: 'cupboard_cache',
		cache: { kind: 'named', name: 'ci' },
		actions: ['upload:negotiate', 'upload:commit', 'root:attach', 'root:set'],
		root: 'github:acme/repo/'
	}
]);

const config: NixStoreConfig = {
	storeUri: 'auto',
	storeDirectory: storeDirectorySchema.parse('/nix/store'),
	stateDirectory: '/nix/var/nix',
	daemonSocketPath: '/nix/var/nix/daemon-socket/socket',
	fileTransfer: defaultFileTransferSettings,
	signatures: defaultSignatureSettings,
	daemonSetOptions: {},
	daemonOverrides: {},
	substitution: {
		substitute: true,
		alwaysAllowSubstitutes: false,
		fallback: false,
		substituters: ['https://cache.nixos.org/']
	},
	building: { systems: ['x86_64-linux'], features: ['big-parallel'] },
	unknownSettings: []
};

const fixtures: string[] = [];

afterEach(async () => {
	const created = [...fixtures];
	fixtures.length = 0;

	await Promise.all(
		created.map((directory) => rm(directory, { recursive: true, force: true }))
	);
});

async function helperFixture(): Promise<{
	readonly executablePath: string;
	readonly helperPath: string;
}> {
	const directory = await mkdtemp(path.join(tmpdir(), 'cup-pre-'));
	fixtures.push(directory);

	const helperPath = path.join(directory, 'cupboard-hook-relay');
	await writeFile(helperPath, '');

	return { executablePath: path.join(directory, 'cupboard'), helperPath };
}

async function baseOptions(): Promise<BuildPushPreflightOptions> {
	const helper = await helperFixture();

	return {
		config,
		storeKind: 'daemon',
		stateDirectory: config.stateDirectory,
		daemonTrust: () => Promise.resolve('trusted'),
		invocationId,
		grants,
		cache,
		helper: { executablePath: helper.executablePath },
		runtime: { environment: {}, platform: 'linux', temporaryDirectory: '/tmp' }
	};
}

describe('preflightBuildPush', () => {
	it('returns daemon-backed resources when preflight succeeds', async () => {
		const options = await baseOptions();

		await expect(
			preflightBuildPush({
				...options,
				runRoot: coveredRoot,
				targetRoots: [coveredRoot]
			})
		).resolves.toStrictEqual({
			outputProtection: { kind: 'daemon-temporary-roots' },
			helperPath: path.join(
				path.dirname(options.helper?.executablePath ?? ''),
				'cupboard-hook-relay'
			),
			runtimePlan: {
				directory: '/tmp/cupboard/invocation-1',
				socketPath: '/tmp/cupboard/invocation-1/hook.sock'
			}
		});
	});

	it('uses direct GC roots when Nix runs without a daemon', async () => {
		const options = await baseOptions();

		await expect(
			preflightBuildPush({
				...options,
				storeKind: 'local-filesystem',
				daemonTrust: () =>
					Promise.reject(new Error('daemon trust must not be queried'))
			})
		).resolves.toStrictEqual({
			outputProtection: {
				kind: 'daemonless-gc-roots',
				rootLinkDirectory: '/nix/var/nix/gcroots/cupboard/invocation-1'
			},
			helperPath: path.join(
				path.dirname(options.helper?.executablePath ?? ''),
				'cupboard-hook-relay'
			),
			runtimePlan: {
				directory: '/tmp/cupboard/invocation-1',
				socketPath: '/tmp/cupboard/invocation-1/hook.sock'
			}
		});
	});

	it('uses the resolved state directory for a rooted local store', async () => {
		const options = await baseOptions();

		const result = await preflightBuildPush({
			...options,
			storeKind: 'local-filesystem',
			stateDirectory: '/tmp/store-root/nix/var/nix',
			daemonTrust: () =>
				Promise.reject(new Error('daemon trust must not be queried'))
		});

		expect(result.outputProtection).toStrictEqual({
			kind: 'daemonless-gc-roots',
			rootLinkDirectory:
				'/tmp/store-root/nix/var/nix/gcroots/cupboard/invocation-1'
		});
	});

	it('rejects a store on another machine', async () => {
		const options = await baseOptions();
		let caught: unknown;

		try {
			await preflightBuildPush({
				...options,
				storeKind: 'ssh-ng',
				daemonTrust: () =>
					Promise.reject(new Error('daemon trust must not be queried'))
			});
		} catch (error) {
			caught = error;
		}

		expect(
			caught instanceof RemoteBuildPushStoreError
				? {
						name: caught.name,
						storeKind: caught.storeKind,
						exitCode: caught.exitCode
					}
				: caught
		).toStrictEqual({
			name: 'RemoteBuildPushStoreError',
			storeKind: 'ssh-ng',
			exitCode: 69
		});
	});

	it.each([
		{
			name: 'a daemon that does not trust the current user',
			overrides: (): Partial<BuildPushPreflightOptions> => ({
				daemonTrust: () => Promise.resolve('not-trusted')
			}),
			probe: (error: unknown) =>
				error instanceof UntrustedDaemonError
					? {
							name: error.name,
							trust: error.trust,
							requiredSetting: error.requiredSetting
						}
					: undefined,
			expected: {
				name: 'UntrustedDaemonError',
				trust: 'not-trusted',
				requiredSetting: 'trusted-users'
			}
		},
		{
			name: 'a daemon whose trust is unknown',
			overrides: (): Partial<BuildPushPreflightOptions> => ({
				daemonTrust: () => Promise.resolve('unknown')
			}),
			probe: (error: unknown) =>
				error instanceof UntrustedDaemonError
					? { name: error.name, trust: error.trust }
					: undefined,
			expected: { name: 'UntrustedDaemonError', trust: 'unknown' }
		},
		{
			name: 'an operator hook already configured',
			overrides: (): Partial<BuildPushPreflightOptions> => ({
				config: { ...config, postBuildHook: '/etc/nix/hook.sh' }
			}),
			probe: (error: unknown) =>
				error instanceof PostBuildHookConflictError
					? { name: error.name, existingHook: error.existingHook }
					: undefined,
			expected: {
				name: 'PostBuildHookConflictError',
				existingHook: '/etc/nix/hook.sh'
			}
		},
		{
			name: 'an installation missing its helper',
			overrides: (): Partial<BuildPushPreflightOptions> => ({
				helper: { executablePath: '/missing/bin/cupboard' }
			}),
			probe: (error: unknown) =>
				error instanceof HookHelperMissingError
					? { name: error.name, candidates: error.candidates }
					: undefined,
			expected: {
				name: 'HookHelperMissingError',
				candidates: [
					'/missing/bin/cupboard-hook-relay',
					'/missing/libexec/cupboard/cupboard-hook-relay'
				]
			}
		},
		{
			name: 'a runtime plan no candidate directory can host',
			overrides: (): Partial<BuildPushPreflightOptions> => ({
				runtime: {
					environment: {},
					platform: 'linux',
					temporaryDirectory: `/${'t'.repeat(linuxSunPathBytes)}`
				}
			}),
			probe: (error: unknown) =>
				error instanceof SocketPathTooLongError
					? { name: error.name, limitBytes: error.limitBytes }
					: undefined,
			expected: { name: 'SocketPathTooLongError', limitBytes: 108 }
		},
		{
			name: 'a run root the token does not cover',
			overrides: (): Partial<BuildPushPreflightOptions> => ({
				runRoot: uncoveredRoot
			}),
			probe: (error: unknown) =>
				error instanceof MissingGrantError
					? { name: error.name, operation: error.operation, root: error.root }
					: undefined,
			expected: {
				name: 'MissingGrantError',
				operation: 'root:attach',
				root: uncoveredRoot
			}
		},
		{
			name: 'a target root the token does not cover',
			overrides: (): Partial<BuildPushPreflightOptions> => ({
				runRoot: coveredRoot,
				targetRoots: [coveredRoot, uncoveredRoot]
			}),
			probe: (error: unknown) =>
				error instanceof MissingGrantError
					? { name: error.name, operation: error.operation, root: error.root }
					: undefined,
			expected: {
				name: 'MissingGrantError',
				operation: 'root:set',
				root: uncoveredRoot
			}
		}
	])('refuses $name', async ({ overrides, probe, expected }) => {
		const options = { ...(await baseOptions()), ...overrides() };
		let caught: unknown;

		try {
			await preflightBuildPush(options);
		} catch (error) {
			caught = error;
		}

		expect(probe(caught)).toStrictEqual(expected);
	});
});
