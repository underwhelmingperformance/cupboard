import { describe, expect, it } from 'vitest';

import {
	DaemonRequiredError,
	HookHelperMissingError,
	MissingGrantError,
	PostBuildHookConflictError,
	SocketPathTooLongError,
	UntrustedDaemonError
} from '../errors.ts';

import { buildPushModeDescription, selectBuildPushMode } from './mode.ts';
import type { BuildPushPreflight } from './preflight.ts';

const socketPath = '/nix/var/nix/daemon-socket/socket';
const preflight: BuildPushPreflight = {
	daemonSocketPath: socketPath,
	helperPath: '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-relay',
	runtimePlan: {
		directory: '/tmp/cupboard/invocation-1',
		socketPath: '/tmp/cupboard/invocation-1/hook.sock'
	}
};

describe('selectBuildPushMode', () => {
	it('streams behind a preflight that proved its endpoints', async () => {
		await expect(
			selectBuildPushMode(() => Promise.resolve(preflight))
		).resolves.toStrictEqual({ kind: 'streamed', preflight });
	});

	it.each([
		{
			name: 'a store with no daemon socket',
			error: new DaemonRequiredError(socketPath)
		},
		{
			name: 'a daemon that does not trust the client',
			error: new UntrustedDaemonError('not-trusted')
		},
		{
			name: 'a daemon whose trust is unknown',
			error: new UntrustedDaemonError('unknown')
		}
	])('runs locally and reconciles behind $name', async ({ error }) => {
		await expect(
			selectBuildPushMode(() => Promise.reject(error))
		).resolves.toStrictEqual({ kind: 'reconciled-local', reason: error });
	});

	it.each([
		{
			name: 'an operator hook already configured',
			error: new PostBuildHookConflictError('/etc/nix/hook.sh')
		},
		{
			name: 'an installation missing its helper',
			error: new HookHelperMissingError(['/missing/relay'])
		},
		{
			name: 'a socket path no candidate directory can host',
			error: new SocketPathTooLongError('/tmp/cupboard/hook.sock', 108)
		},
		{
			name: 'a root the token does not cover',
			error: new MissingGrantError('root:set', 'github:acme/repo/main')
		},
		{ name: 'a refusal of no known kind', error: new Error('lost') }
	])('fails the run on $name', async ({ error }) => {
		await expect(selectBuildPushMode(() => Promise.reject(error))).rejects.toBe(
			error
		);
	});
});

describe('buildPushModeDescription', () => {
	it.each([
		{
			name: 'the streamed mode',
			mode: { kind: 'streamed', preflight } as const,
			expected:
				'Publication mode: streamed. Each completed output publishes while ' +
				'the build runs.'
		},
		{
			name: 'a reconciled local run behind a missing daemon',
			mode: {
				kind: 'reconciled-local',
				reason: new DaemonRequiredError(socketPath)
			} as const,
			expected:
				`Publication mode: reconciled local. No Nix daemon socket exists at ` +
				`${socketPath}, so the build runs without the post-build hook and ` +
				'one push publishes what it leaves in the store.'
		},
		{
			name: 'a reconciled local run behind an untrusting daemon',
			mode: {
				kind: 'reconciled-local',
				reason: new UntrustedDaemonError('not-trusted')
			} as const,
			expected:
				'Publication mode: reconciled local. The Nix daemon does not trust ' +
				'this client, so the build runs without the post-build hook and one ' +
				'push publishes what it leaves in the store.'
		}
	])('names $name', ({ mode, expected }) => {
		expect(buildPushModeDescription(mode)).toBe(expected);
	});
});
