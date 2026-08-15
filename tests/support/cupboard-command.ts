import { constants } from 'node:fs';
import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises';
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse
} from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { runCommand } from './process.ts';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const cliEntrypoint = path.join(repositoryRoot, 'packages/cli/src/main.ts');
const blobModule = path.join(
	repositoryRoot,
	'packages/cli/src/push/r2-upload.ts'
);
const hookHelperSource = path.join(
	repositoryRoot,
	'packages/cli/hook-helper/cupboard-hook-relay.c'
);
const objectKeyHeader = 'x-cupboard-object-key';

/**
Writes uploaded blob bytes where the worker verifies them.
*/
export type StageObject = (key: string, bytes: Uint8Array) => Promise<void>;

/**
 * The `cupboard` command an action runs, backed by this checkout's CLI sources.
 * It is a real executable: the action spawns it, detects its result protocol,
 * and reads its exit status, exactly as it would the binary that
 * `actions/setup` installs on a runner.
 *
 * One part of it is not the production path. A push signs its blob uploads with
 * a temporary R2 credential and sends them to Cloudflare's S3 endpoint, which
 * Miniflare does not serve, so a module hook replaces the S3 uploader with one
 * that PUTs the same bytes to a loopback bridge. The bridge stages them in the
 * bucket the worker verifies against, which is what
 * `CupboardTestServer.pushClient` does for the suites that drive a push
 * directly. Everything else the command does, including issuing the upload
 * credential it would have signed with, runs unchanged.
 */
export class CupboardCommand {
	static async start(options: {
		/**
		Where this installation's files are written.
		*/
		readonly directory: string;
		readonly stage: StageObject;
	}): Promise<CupboardCommand> {
		const bridge = createServer((request, response) => {
			void receiveObject(request, response, options.stage);
		});
		const bridgeUrl = await listen(bridge);

		await mkdir(options.directory, { recursive: true });
		const uploaderPath = path.join(options.directory, 'blob-uploader.mjs');
		const hooksPath = path.join(options.directory, 'module-hooks.mjs');
		const registerPath = path.join(options.directory, 'register-hooks.mjs');
		const commandPath = path.join(options.directory, 'cupboard');
		const nodePath = path.join(options.directory, 'node');

		// The CLI resolves its post-build hook helper beside the executable that
		// runs the CLI, which for a script is the Node binary itself. Give this
		// installation its own copy of Node so the helper sits beside it, as it
		// does beside the `cupboard` binary in a release tarball.
		await copyFile(process.execPath, nodePath, constants.COPYFILE_FICLONE);
		await runCommand('cc', [
			'-O2',
			'-o',
			path.join(options.directory, 'cupboard-hook-relay'),
			hookHelperSource
		]);
		await Promise.all([
			writeFile(uploaderPath, blobUploaderSource(bridgeUrl)),
			writeFile(hooksPath, moduleHooksSource(uploaderPath)),
			writeFile(registerPath, registerHooksSource(hooksPath)),
			writeFile(commandPath, commandSource(nodePath, registerPath))
		]);
		await Promise.all([chmod(commandPath, 0o755), chmod(nodePath, 0o755)]);

		return new CupboardCommand(commandPath, bridge);
	}

	private constructor(
		/**
		The `cupboard-path` input an action receives.
		*/
		readonly path: string,
		private readonly bridge: Server
	) {}

	async stop(): Promise<void> {
		await closeServer(this.bridge);
	}
}

// The CLI imports `r2BlobUploader` and nothing else from the module this
// replaces, so the replacement exports that one function.
function blobUploaderSource(bridgeUrl: string): string {
	return `export function r2BlobUploader() {
	return async (key, body) => {
		const response = await fetch(${JSON.stringify(bridgeUrl)}, {
			method: 'PUT',
			headers: { ${JSON.stringify(objectKeyHeader)}: key },
			body,
			duplex: 'half'
		});

		if (!response.ok) {
			throw new Error(
				\`The staging bridge refused \${key} with \${String(response.status)}\`
			);
		}
	};
}
`;
}

function moduleHooksSource(uploaderPath: string): string {
	return `const replaced = ${JSON.stringify(pathToFileURL(blobModule).href)};
const replacement = ${JSON.stringify(pathToFileURL(uploaderPath).href)};

export async function resolve(specifier, context, nextResolve) {
	const resolution = await nextResolve(specifier, context);

	if (resolution.url !== replaced) {
		return resolution;
	}

	return { ...resolution, url: replacement, format: 'module', shortCircuit: true };
}
`;
}

function registerHooksSource(hooksPath: string): string {
	return `import { register } from 'node:module';

register(${JSON.stringify(pathToFileURL(hooksPath).href)});
`;
}

function commandSource(nodePath: string, registerPath: string): string {
	const command = [
		JSON.stringify(nodePath),
		'--experimental-transform-types',
		'--disable-warning=ExperimentalWarning',
		`--import ${JSON.stringify(pathToFileURL(registerPath).href)}`,
		JSON.stringify(cliEntrypoint),
		'"$@"'
	].join(' ');

	return `#!/bin/sh\nexec ${command}\n`;
}

async function receiveObject(
	request: IncomingMessage,
	response: ServerResponse,
	stage: StageObject
): Promise<void> {
	const key = request.headers[objectKeyHeader];

	if (typeof key !== 'string' || key === '') {
		response.writeHead(400);
		response.end();

		return;
	}

	try {
		await stage(key, await collectBody(request));
		response.writeHead(200, { etag: '"staged"' });
		response.end();
	} catch (error) {
		response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
		response.end(`${error instanceof Error ? error.message : String(error)}\n`);
	}
}

function collectBody(request: IncomingMessage): Promise<Uint8Array> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];

		request.on('data', (chunk: Buffer) => {
			chunks.push(chunk);
		});
		request.once('error', reject);
		request.once('end', () => {
			resolve(Buffer.concat(chunks));
		});
	});
}

function listen(server: Server): Promise<string> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error): void => {
			reject(error);
		};

		server.once('error', onError);
		server.listen(0, '127.0.0.1', () => {
			server.removeListener('error', onError);
			const address = server.address() as AddressInfo;

			resolve(`http://127.0.0.1:${String(address.port)}/`);
		});
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => {
			if (error !== undefined) {
				reject(error);

				return;
			}

			resolve();
		});
	});
}
