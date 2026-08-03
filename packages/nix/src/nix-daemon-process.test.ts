import { storePathSchema } from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import {
	DyingDaemonChild,
	FakeDaemonChild,
	UnspawnableDaemonChild
} from '../../../tests/support/fake-daemon-child.ts';
import { FakeDaemonTransport } from '../../../tests/support/fake-daemon-transport.ts';

import { NixDaemonRemoteError, NixDaemonStoreClient } from './nix-daemon.ts';
import {
	createProcessNixDaemonConnector,
	type DaemonCommandRunner
} from './nix-daemon-process.ts';

const appPath = storePathSchema.parse(
	'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app'
);
const appHash = '11'.repeat(32);

describe('createProcessNixDaemonConnector', () => {
	it('starts the command with its arguments for each connection', async () => {
		const commands: {
			command: string;
			commandArguments: readonly string[];
		}[] = [];
		const run: DaemonCommandRunner = (command, commandArguments) => {
			commands.push({ command, commandArguments });

			return new FakeDaemonChild(new FakeDaemonTransport({}));
		};
		const client = new NixDaemonStoreClient({
			connect: createProcessNixDaemonConnector(
				'nix',
				['daemon', '--stdio'],
				run
			)
		});

		await expect(client.queryValidPaths([appPath])).resolves.toStrictEqual([]);
		expect(commands).toStrictEqual([
			{ command: 'nix', commandArguments: ['daemon', '--stdio'] }
		]);
	});

	it('drives the daemon handshake through the bridged stdio', async () => {
		const children: FakeDaemonChild[] = [];
		const run: DaemonCommandRunner = () => {
			const child = new FakeDaemonChild(
				new FakeDaemonTransport({
					[appPath]: {
						hash: appHash,
						narSize: 123,
						references: [],
						signatures: []
					}
				})
			);
			children.push(child);

			return child;
		};
		const client = new NixDaemonStoreClient({
			connect: createProcessNixDaemonConnector('nix', ['daemon'], run)
		});

		const info = await client.queryPathInfo(appPath);

		expect({
			storePath: info.storePath,
			narSize: info.narSize,
			kills: children.map((child) => child.killed)
		}).toStrictEqual({
			storePath: appPath,
			narSize: 123,
			kills: [1]
		});
	});

	it('surfaces a child that exits mid-connection as a typed error', async () => {
		const client = new NixDaemonStoreClient({
			connect: createProcessNixDaemonConnector(
				'nix',
				['daemon'],
				() => new DyingDaemonChild()
			)
		});

		await expect(client.queryPathInfo(appPath)).rejects.toBeInstanceOf(
			NixDaemonRemoteError
		);
	});

	it('settles cleanup and surfaces the spawn error when the child cannot start', async () => {
		const spawnError = new Error('spawn failed');
		const children: UnspawnableDaemonChild[] = [];
		const run: DaemonCommandRunner = () => {
			const child = new UnspawnableDaemonChild(spawnError);
			children.push(child);

			return child;
		};
		const client = new NixDaemonStoreClient({
			connect: createProcessNixDaemonConnector('nix', ['daemon'], run)
		});

		await expect(client.queryPathInfo(appPath)).rejects.toBe(spawnError);
		expect(children.map((child) => child.killed)).toStrictEqual([1]);
	});

	it('kills the child when the connection closes', async () => {
		const children: FakeDaemonChild[] = [];
		const run: DaemonCommandRunner = () => {
			const child = new FakeDaemonChild(new FakeDaemonTransport({}));
			children.push(child);

			return child;
		};
		const client = new NixDaemonStoreClient({
			connect: createProcessNixDaemonConnector('nix', ['daemon'], run)
		});

		await client.queryValidPaths([]);

		expect(children.map((child) => child.killed)).toStrictEqual([1]);
	});
});
