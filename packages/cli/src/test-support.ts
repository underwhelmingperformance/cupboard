import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { accessKeySecretSchema } from '@cupboard/protocol/access-keys';
import { test, vi } from 'vitest';

export const accessKeyVariables = [
	'CUPBOARD_ACCESS_KEY',
	'CUPBOARD_VIEW_ACCESS_KEY'
] as const;

/**
An access key for the addressed cache and one for the reuse view or reference
source, in tests that read both.
*/
export const destinationAccessKey = accessKeySecretSchema.parse(
	`cupboard_ak_00000000-0000-4000-8000-00000000000d_${'d'.repeat(64)}`
);
export const sourceAccessKey = accessKeySecretSchema.parse(
	`cupboard_ak_00000000-0000-4000-8000-00000000000e_${'e'.repeat(64)}`
);

/**
Each case supplies one access key in an environment variable, for the
destination or for the reuse view or reference source.
*/
export const environmentAccessKeyCases = [
	{
		variable: 'CUPBOARD_ACCESS_KEY',
		key: destinationAccessKey,
		role: 'destination'
	},
	{
		variable: 'CUPBOARD_VIEW_ACCESS_KEY',
		key: sourceAccessKey,
		role: 'source'
	}
] as const;

/**
The Authorization header that presents an access key to a read route.
*/
export function accessKeyAuthorization(key: string): string {
	return basicAuthorization('cupboard', key);
}

/**
The Authorization header for HTTP Basic authentication with a user name and
password.
*/
export function basicAuthorization(user: string, password: string): string {
	return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

/**
The parts of an HTTP request that a credential test asserts on.
*/
export interface RecordedRequest {
	readonly method: string;
	readonly path: string;
	readonly authorization: string | undefined;
}

export interface RecordedResponse {
	readonly status: number;
	readonly body: string;
}

/**
Runs `body` against an HTTP server on 127.0.0.1. The server records every
request in arrival order and answers it with `respond`. `body` receives the
server's origin and the recorded requests, and its result is returned.
*/
export async function withRecordingServer<T>(
	respond: (request: RecordedRequest) => RecordedResponse,
	body: (origin: string, requests: readonly RecordedRequest[]) => Promise<T>
): Promise<T> {
	const requests: RecordedRequest[] = [];
	const server = createServer((request, response) => {
		const recorded = {
			method: request.method ?? '',
			path: request.url ?? '',
			authorization: request.headers.authorization
		};
		requests.push(recorded);
		request.resume();
		request.on('end', () => {
			const answer = respond(recorded);
			response.writeHead(answer.status);
			response.end(answer.body);
		});
	});

	try {
		await new Promise<void>((resolve) => {
			server.listen(0, '127.0.0.1', resolve);
		});
		const address = server.address();

		if (address === null || typeof address === 'string') {
			throw new TypeError('The recording server has no TCP address');
		}

		return await body(`http://127.0.0.1:${String(address.port)}`, requests);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => {
			server.close((error) => {
				if (error === undefined) {
					resolve();
					return;
				}

				reject(error);
			});
		});
	}
}

interface ConfigHomeFixture {
	readonly configHome: string;
}

/**
Runs a test with `$XDG_CONFIG_HOME` pointed at a fresh temporary directory,
then removes the directory and restores the environment afterwards. Lets the
token-cache tests exercise the real on-disk store without leaking directories.
*/
export const testWithConfigHome = test.extend<ConfigHomeFixture>({
	// `auto` so the temporary config home is set up and torn down for every test,
	// including those that depend on the stubbed environment without reading the
	// directory path.
	// Vitest requires a fixture's first argument to be an object-destructuring
	// pattern, and the linter forbids an empty one; this fixture needs nothing
	// from the context, so it destructures the built-in `task` and ignores it.
	configHome: [
		async ({ task: _task }, use) => {
			const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-config-'));
			vi.stubEnv('XDG_CONFIG_HOME', directory);

			try {
				await use(directory);
			} finally {
				vi.unstubAllEnvs();
				await rm(directory, { recursive: true, force: true });
			}
		},
		{ auto: true }
	]
});
