import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse
} from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import { Miniflare } from 'miniflare';
import { build, type Plugin } from 'vite';

import { presigningFetcher } from './r2-presign.ts';

const root = path.resolve(import.meta.dirname, '../..');

export const bootstrapToken = 'e2e-bootstrap-token';

export const r2Credentials = {
	accountId: 'test-account-id',
	accessKeyId: 'test-access-key-id',
	secretAccessKey: 'test-secret-access-key',
	bucketName: 'cupboard-blobs'
} as const;

type MiniflareRequestInit = NonNullable<
	Parameters<Miniflare['dispatchFetch']>[1]
>;

/**
 * A running cupboard worker backed by Miniflare, fronted by a local HTTP server
 * so that Nix can reach it over a real socket. Blobs are written straight into
 * the bound R2 bucket because presigned uploads target Cloudflare's endpoint,
 * which Miniflare does not serve.
 */
export class CupboardTestServer {
	private constructor(
		readonly url: URL,
		private readonly worker: Miniflare,
		private readonly bucket: Awaited<ReturnType<Miniflare['getR2Bucket']>>,
		private readonly server: Server
	) {}

	static async start(directory: string): Promise<CupboardTestServer> {
		const bundle = await bundleWorker(directory);
		const worker = new Miniflare({
			bindings: {
				CUPBOARD_BOOTSTRAP_TOKEN: bootstrapToken,
				R2_ACCESS_KEY_ID: r2Credentials.accessKeyId,
				R2_ACCOUNT_ID: r2Credentials.accountId,
				R2_BUCKET_NAME: r2Credentials.bucketName,
				R2_SECRET_ACCESS_KEY: r2Credentials.secretAccessKey
			},
			compatibilityDate: '2026-05-15',
			compatibilityFlags: ['nodejs_compat'],
			durableObjects: {
				CUPBOARD_DO: {
					className: 'CupboardServer',
					useSQLite: true
				}
			},
			modules: true,
			r2Buckets: {
				BLOBS: r2Credentials.bucketName
			},
			modulesRoot: bundle.directory,
			rootPath: bundle.directory,
			scriptPath: bundle.entrypoint
		});
		const bucket = await worker.getR2Bucket('BLOBS');
		const server = createServer((request, response) => {
			void forwardToWorker(worker, request, response);
		});
		const url = await listen(server);

		return new CupboardTestServer(url, worker, bucket, server);
	}

	/**
	 * A `fetch` that accepts the presigned uploads cupboard hands out: it
	 * verifies their SigV4 signature and checksum, then stores the body in this
	 * server's R2 bucket. Other requests fall through to the real `fetch`.
	 */
	uploadFetcher(): typeof fetch {
		return presigningFetcher(this.bucket, {
			accessKeyId: r2Credentials.accessKeyId,
			secretAccessKey: r2Credentials.secretAccessKey
		});
	}

	async stop(): Promise<void> {
		await Promise.all([closeServer(this.server), this.worker.dispose()]);
	}
}

interface WorkerBundle {
	readonly directory: string;
	readonly entrypoint: string;
}

async function bundleWorker(directory: string): Promise<WorkerBundle> {
	const outputDirectory = path.join(directory, 'worker-bundle');
	await build({
		build: {
			emptyOutDir: true,
			lib: {
				entry: path.join(root, 'packages/server/src/worker.ts'),
				fileName: 'worker',
				formats: ['es']
			},
			minify: false,
			outDir: outputDirectory,
			rolldownOptions: {
				external: ['cloudflare:workers'],
				output: {
					entryFileNames: 'worker.mjs'
				}
			},
			target: 'es2023'
		},
		configFile: false,
		logLevel: 'silent',
		plugins: [sqlTextPlugin()],
		root
	});

	return {
		directory: outputDirectory,
		entrypoint: 'worker.mjs'
	};
}

function sqlTextPlugin(): Plugin {
	return {
		name: 'cupboard-sql-text',
		transform(source, id) {
			if (!id.endsWith('.sql')) {
				return;
			}

			return {
				code: `export default ${JSON.stringify(source)};`
			};
		}
	};
}

async function forwardToWorker(
	worker: Miniflare,
	request: IncomingMessage,
	response: ServerResponse
): Promise<void> {
	try {
		const body = await requestBody(request);
		const init: MiniflareRequestInit = {
			headers: requestHeaders(request),
			method: request.method ?? 'GET'
		};

		if (body !== undefined) {
			init.body = body;
		}

		const workerResponse = await worker.dispatchFetch(
			new URL(request.url ?? '/', localOrigin(request)).toString(),
			init
		);
		const bytes = new Uint8Array(await workerResponse.arrayBuffer());

		response.writeHead(
			workerResponse.status,
			Object.fromEntries(workerResponse.headers)
		);
		response.end(bytes);
	} catch (error) {
		response.writeHead(500, {
			'content-type': 'text/plain; charset=utf-8'
		});
		response.end(`${error instanceof Error ? error.message : String(error)}\n`);
	}
}

function listen(server: Server): Promise<URL> {
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();

			if (typeof address === 'object' && address !== null) {
				resolve(localUrl(address));
				return;
			}

			reject(new LocalServerAddressUnavailableError());
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

function localUrl(address: AddressInfo): URL {
	const url = new URL(`http://${address.address}:${String(address.port)}`);

	if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
		return url;
	}

	throw new InvalidLocalUrlError(url);
}

async function requestBody(
	request: IncomingMessage
): Promise<Uint8Array | undefined> {
	if (request.method === 'GET' || request.method === 'HEAD') {
		return undefined;
	}

	return new Promise((resolve, reject) => {
		const chunks: Uint8Array[] = [];

		request.on('data', (chunk: Buffer | string) => {
			chunks.push(requestChunkBytes(chunk));
		});

		request.once('error', reject);
		request.once('end', () => {
			resolve(Buffer.concat(chunks));
		});
	});
}

function requestChunkBytes(chunk: Buffer | string): Uint8Array {
	if (Buffer.isBuffer(chunk)) {
		return chunk;
	}

	return Buffer.from(chunk);
}

function requestHeaders(request: IncomingMessage): [string, string][] {
	const headers: [string, string][] = [];

	for (const [name, value] of Object.entries(request.headers)) {
		if (value === undefined) {
			continue;
		}

		if (Array.isArray(value)) {
			for (const item of value) {
				headers.push([name, item]);
			}
			continue;
		}

		headers.push([name, value]);
	}

	return headers;
}

function localOrigin(request: IncomingMessage): string {
	const host = request.headers.host ?? '127.0.0.1';

	return `http://${host}`;
}

class LocalServerAddressUnavailableError extends Error {
	constructor() {
		super('Could not determine local server address');
		this.name = 'LocalServerAddressUnavailableError';
	}
}

class InvalidLocalUrlError extends Error {
	constructor(public readonly url: URL) {
		super(`Invalid local server URL: ${url.toString()}`);
		this.name = 'InvalidLocalUrlError';
	}
}
