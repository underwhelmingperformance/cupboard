import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { NixStoreConfig } from '@cupboard/nix';
import {
	cacheSelectorSchema,
	rootNameSchema,
	storeDirectorySchema
} from '@cupboard/nix-store/scalars';
import { invocationIdSchema } from '@cupboard/protocol/build';
import { authorizationDetailsSchema } from '@cupboard/protocol/grants';
import { afterEach, describe, expect, it } from 'vitest';

import {
	DaemonRequiredError,
	HookHelperMissingError,
	MissingGrantError,
	PostBuildHookConflictError,
	SocketPathTooLongError,
	UntrustedDaemonError
} from '../errors.ts';

import {
	type BuildPushPreflightOptions,
	preflightBuildPush
} from './preflight.ts';
import { linuxSunPathBytes } from './runtime-directory.ts';

const invocationId = invocationIdSchema.parse('invocation-1');
const cache = cacheSelectorSchema.parse('ci');
const coveredRoot = rootNameSchema.parse('github:acme/repo/run-1');
const uncoveredRoot = rootNameSchema.parse('github:other/repo/run-1');
const grants = authorizationDetailsSchema.parse([
	{
		type: 'cupboard_cache',
		cache: 'ci',
		actions: ['upload:negotiate', 'upload:commit', 'root:attach', 'root:set'],
		root: 'github:acme/repo/'
	}
]);

const config: NixStoreConfig = {
	storeUri: 'auto',
	storeDirectory: storeDirectorySchema.parse('/nix/store'),
	stateDirectory: '/nix/var/nix',
	daemonSocketPath: '/nix/var/nix/daemon-socket/socket',
	daemonSetOptions: {},
	daemonOverrides: {}
};

const fixtures: string[] = [];

afterEach(async () => {
	const created = [...fixtures];
	fixtures.length = 0;

	await Promise.all(
		created.map((directory) => rm(directory, { recursive: true, force: true }))
	);
});

async function helperFixture(): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), 'cup-pre-'));
	fixtures.push(directory);

	const helperPath = path.join(directory, 'cupboard-hook-relay');
	await writeFile(helperPath, '');

	return helperPath;
}

async function baseOptions(): Promise<BuildPushPreflightOptions> {
	return {
		config,
		socketExists: () => true,
		daemonTrust: () => Promise.resolve('trusted'),
		invocationId,
		grants,
		cache,
		helper: { environment: { CUPBOARD_HOOK_HELPER: await helperFixture() } },
		runtime: { environment: {}, platform: 'linux', temporaryDirectory: '/tmp' }
	};
}

describe('preflightBuildPush', () => {
	it('proves the endpoints of a runnable invocation', async () => {
		const options = await baseOptions();

		await expect(
			preflightBuildPush({
				...options,
				runRoot: coveredRoot,
				targetRoots: [coveredRoot]
			})
		).resolves.toStrictEqual({
			daemonSocketPath: '/nix/var/nix/daemon-socket/socket',
			helperPath: options.helper?.environment?.CUPBOARD_HOOK_HELPER,
			runtimePlan: {
				directory: '/tmp/cupboard/invocation-1',
				socketPath: '/tmp/cupboard/invocation-1/hook.sock'
			}
		});
	});

	it.each([
		{
			name: 'a store with no daemon socket',
			overrides: (): Partial<BuildPushPreflightOptions> => ({
				socketExists: () => false
			}),
			probe: (error: unknown) =>
				error instanceof DaemonRequiredError
					? { name: error.name, socketPath: error.socketPath }
					: undefined,
			expected: {
				name: 'DaemonRequiredError',
				socketPath: '/nix/var/nix/daemon-socket/socket'
			}
		},
		{
			name: 'a daemon that does not trust the client',
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
				helper: {
					environment: { CUPBOARD_HOOK_HELPER: '/missing/relay' }
				}
			}),
			probe: (error: unknown) =>
				error instanceof HookHelperMissingError
					? { name: error.name, candidates: error.candidates }
					: undefined,
			expected: {
				name: 'HookHelperMissingError',
				candidates: ['/missing/relay']
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
