import { storePathSchema } from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import { FakeDaemonChild } from '../../../tests/support/fake-daemon-child.ts';
import { FakeDaemonTransport } from '../../../tests/support/fake-daemon-transport.ts';

import { NixDaemonStoreClient } from './nix-daemon.ts';
import type { DaemonCommandRunner } from './nix-daemon-process.ts';
import {
	createSshNixDaemonConnector,
	parseSshNgStoreUri
} from './nix-daemon-ssh.ts';

const appPath = storePathSchema.parse(
	'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app'
);

describe('parseSshNgStoreUri', () => {
	it.each([
		{
			name: 'a destination with a user',
			uri: 'ssh-ng://build@example.test',
			expected: { destination: 'build@example.test' }
		},
		{
			name: 'a bare host',
			uri: 'ssh-ng://example.test',
			expected: { destination: 'example.test' }
		},
		{
			name: 'a remote-program parameter',
			uri: 'ssh-ng://example.test?remote-program=/opt/nix/bin/nix-daemon',
			expected: {
				destination: 'example.test',
				remoteProgram: '/opt/nix/bin/nix-daemon'
			}
		},
		{ name: 'an empty destination', uri: 'ssh-ng://', expected: undefined },
		{
			name: 'a different scheme',
			uri: 'ssh://example.test',
			expected: undefined
		}
	])('parses $name', ({ uri, expected }) => {
		expect(parseSshNgStoreUri(uri)).toStrictEqual(expected);
	});
});

describe('createSshNixDaemonConnector', () => {
	it.each([
		{
			name: 'the default remote program',
			spec: { destination: 'build@example.test' },
			expectedArguments: ['build@example.test', 'nix-daemon', '--stdio']
		},
		{
			name: 'a configured remote program',
			spec: {
				destination: 'example.test',
				remoteProgram: '/opt/nix/bin/nix-daemon'
			},
			expectedArguments: ['example.test', '/opt/nix/bin/nix-daemon', '--stdio']
		}
	])('starts ssh with $name', async ({ spec, expectedArguments }) => {
		const commands: {
			command: string;
			commandArguments: readonly string[];
		}[] = [];
		const run: DaemonCommandRunner = (command, commandArguments) => {
			commands.push({ command, commandArguments });

			return new FakeDaemonChild(new FakeDaemonTransport({}));
		};
		const client = new NixDaemonStoreClient({
			connect: createSshNixDaemonConnector(spec, run)
		});

		await expect(client.queryValidPaths([appPath])).resolves.toStrictEqual([]);
		expect(commands).toStrictEqual([
			{ command: 'ssh', commandArguments: expectedArguments }
		]);
	});
});
