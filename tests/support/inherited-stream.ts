import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Socket } from 'node:net';
import path from 'node:path';
import process from 'node:process';
import type { Readable } from 'node:stream';

import { withTemporaryDirectory } from './filesystem.ts';

interface InheritedStream {
	readonly child: ChildProcessByStdio<null, Readable, Readable>;
	readonly arguments: readonly string[];
	readonly releaseAfterParentExit: () => Promise<void>;
}

export function withInheritedStream<T>(
	stream: 'stdout' | 'stderr',
	output: string,
	use: (fixture: InheritedStream) => Promise<T>
): Promise<T> {
	return withTemporaryDirectory('cupboard-stream-', async (directory) => {
		const connected = Promise.withResolvers<Socket>();
		const connections = new Set<Socket>();
		const server = createServer((socket) => {
			connections.add(socket);
			socket.once('close', () => connections.delete(socket));
			connected.resolve(socket);
		});
		const socketPath = path.join(directory, 'control.sock');
		server.listen(socketPath);
		await once(server, 'listening');
		const descendant = [
			"const { connect } = require('node:net');",
			'const socket = connect(process.argv[1]);',
			"socket.once('data', () => {",
			`process.${stream}.write(${JSON.stringify(output)});`,
			'socket.end();',
			'});'
		].join('\n');
		const script = [
			"const { spawn } = require('node:child_process');",
			`const descendant = spawn(${JSON.stringify(process.execPath)},`,
			`${JSON.stringify(['-e', descendant, socketPath])}, {`,
			'detached: true,',
			`stdio: ['ignore', ${stream === 'stdout' ? 'process.stdout' : "'ignore'"}, ${stream === 'stderr' ? 'process.stderr' : "'ignore'"}]`,
			'});',
			'descendant.unref();'
		].join('\n');
		const arguments_ = ['-e', script];
		const child = spawn(process.execPath, arguments_, {
			stdio: ['ignore', 'pipe', 'pipe']
		});
		const exited = once(child, 'exit');
		let control: Socket | undefined;

		try {
			return await use({
				child,
				arguments: arguments_,
				releaseAfterParentExit: async () => {
					await exited;
					control = await connected.promise;
					control.end('release');
				}
			});
		} finally {
			control?.destroy();
			child.kill();
			for (const socket of connections) {
				socket.destroy();
			}
			await new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error !== undefined) {
						reject(error);
						return;
					}
					resolve();
				});
			});
		}
	});
}
