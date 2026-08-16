import { describe, expect, it } from 'vitest';

import {
	HookHelperMissingError,
	MissingGrantError,
	PostBuildHookConflictError,
	SocketPathTooLongError,
	UntrustedDaemonError
} from '../errors.ts';

import { selectBuildPushMode } from './mode.ts';
import type { BuildPushPreflight } from './preflight.ts';

const preflight: BuildPushPreflight = {
	outputProtection: { kind: 'daemon-temporary-roots' },
	helperPath: '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-relay',
	runtimePlan: {
		directory: '/tmp/cupboard/invocation-1',
		socketPath: '/tmp/cupboard/invocation-1/hook.sock'
	}
};

describe('selectBuildPushMode', () => {
	it('selects streamed mode when preflight succeeds', async () => {
		await expect(
			selectBuildPushMode(() => Promise.resolve(preflight))
		).resolves.toStrictEqual({ kind: 'streamed', preflight });
	});

	it.each([
		{
			name: 'a daemon that does not trust the current user',
			error: new UntrustedDaemonError('not-trusted')
		},
		{
			name: 'a daemon whose trust is unknown',
			error: new UntrustedDaemonError('unknown')
		}
	])('selects reconciled local mode for $name', async ({ error }) => {
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
