import { constants } from 'node:fs';
import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { FakeS3 } from './fake-s3.ts';
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

export type StageObject = (key: string, bytes: Uint8Array) => Promise<void>;

/**
 * The `cupboard` command an action runs, backed by this checkout's CLI sources.
 * It is a real executable: the action spawns it, detects its result protocol,
 * and reads its exit status, exactly as it would the binary that
 * `actions/setup` installs on a runner.
 *
 * One part of it is not the production path. A push signs its blob uploads with
 * a temporary R2 credential and sends them to Cloudflare's S3 endpoint, which
 * Miniflare does not serve. A module hook therefore wraps the CLI's uploader so
 * that it sends the same requests to a loopback S3 endpoint, which writes each
 * completed object into the bucket that the worker verifies against.
 * `CupboardTestServer.pushClient` does the same for the suites that drive a
 * push directly. Everything else the command does, including issuing the upload
 * credential that it signs with, runs unchanged.
 */
export class CupboardCommand {
	static async start(options: {
		readonly directory: string;
		readonly stage: StageObject;
	}): Promise<CupboardCommand> {
		const s3 = await FakeS3.start({ onObject: options.stage });

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
			writeFile(uploaderPath, blobUploaderSource(s3.endpoint)),
			writeFile(hooksPath, moduleHooksSource(uploaderPath)),
			writeFile(registerPath, registerHooksSource(hooksPath)),
			writeFile(commandPath, commandSource(nodePath, registerPath))
		]);
		await Promise.all([chmod(commandPath, 0o755), chmod(nodePath, 0o755)]);

		return new CupboardCommand(commandPath, s3);
	}

	private constructor(
		readonly path: string,
		private readonly s3: FakeS3
	) {}

	async stop(): Promise<void> {
		await this.s3.stop();
	}
}

// Wraps the real module: `r2BlobUploader` builds the real uploader, with the
// loopback S3 endpoint in place of the one in the push credential.
function blobUploaderSource(endpoint: string): string {
	const real = JSON.stringify(pathToFileURL(blobModule).href);

	return `import { r2BlobUploader as realUploader } from ${real};

export * from ${real};

export function r2BlobUploader(options) {
	return realUploader({ ...options, endpoint: ${JSON.stringify(endpoint)} });
}
`;
}

// Resolves the CLI's import of the uploader module to the wrapper. The
// wrapper's own import of that module resolves normally.
function moduleHooksSource(uploaderPath: string): string {
	return `const replaced = ${JSON.stringify(pathToFileURL(blobModule).href)};
const replacement = ${JSON.stringify(pathToFileURL(uploaderPath).href)};

export async function resolve(specifier, context, nextResolve) {
	const resolution = await nextResolve(specifier, context);

	if (resolution.url !== replaced || context.parentURL === replacement) {
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
