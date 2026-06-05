import { readdirSync, readFileSync } from 'node:fs';
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse
} from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import {
	subjectTokenTypeIdToken,
	tokenExchangeGrantType
} from '@cupboard/protocol/oidc';
import { Miniflare } from 'miniflare';
import { build, type Plugin } from 'vite';

import { defaultTenant } from '../../packages/server/src/routing/tenant-routing.ts';

import { StubOidcIssuer } from './oidc-issuer.ts';
import { presigningFetcher } from './r2-presign.ts';

const root = path.resolve(import.meta.dirname, '../..');

// The owner identity the stub issuer asserts and the worker is configured to
// trust; the audience stands in for the CLI's registered OAuth client id.
export const ownerSubject = 'e2e-owner';
export const ownerAudience = 'cupboard-owner-client';

// The audience the stub issuer stamps into a control-plane subject token, and the
// deployment's single-use claim secret gating the first-signup global-admin claim.
export const signupAudience = 'cupboard-control-client';
export const signupSecret = 'e2e-signup-secret';

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
		readonly issuer: StubOidcIssuer,
		private readonly worker: Miniflare,
		private readonly bucket: Awaited<ReturnType<Miniflare['getR2Bucket']>>,
		private readonly server: Server
	) {}

	/**
	 * The default tenant's base URL — the `/t/<tenant>/` prefix every tenant route
	 * (token exchange, uploads, narinfo and NAR reads) lives under. The bare
	 * {@link url} is the deployment/control surface.
	 */
	get tenantUrl(): URL {
		return new URL(`/t/${defaultTenant}`, this.url);
	}

	/** Resolves a tenant-relative path (e.g. `/x.narinfo`) under {@link tenantUrl}. */
	tenantPath(path: string): URL {
		const url = this.tenantUrl;
		url.pathname = `${url.pathname}${path}`;

		return url;
	}

	static async start(
		directory: string,
		options: { readonly bindings?: Readonly<Record<string, string>> } = {}
	): Promise<CupboardTestServer> {
		const bundle = await bundleWorker(directory);
		const issuer = await StubOidcIssuer.start();

		// The Durable Object runs in its own `cupboard-tenant` script, so its
		// bindings exclude the control-plane signing key, exactly as in production.
		// The control-plane Worker binds the wrapping secret and reaches the Durable
		// Object across scripts via `scriptName`.
		const tenantBindings = {
			CUPBOARD_OWNER_ISSUER: issuer.issuer,
			CUPBOARD_OWNER_SUBJECT: ownerSubject,
			CUPBOARD_OWNER_AUDIENCE: ownerAudience,
			CUPBOARD_COLD_PATH_TTL_SECONDS: '',
			R2_ACCESS_KEY_ID: r2Credentials.accessKeyId,
			R2_ACCOUNT_ID: r2Credentials.accountId,
			R2_BUCKET_NAME: r2Credentials.bucketName,
			R2_SECRET_ACCESS_KEY: r2Credentials.secretAccessKey,
			...options.bindings
		};
		const controlBindings = {
			...tenantBindings,
			CUPBOARD_CONTROL_AUDIENCE: 'cupboard-control',
			CONTROL_KEY_WRAP_SECRET: 'AAcOFRwjKjE4P0ZNVFtiaXB3foWMk5qhqK+2vcTL0tk=',
			CUPBOARD_SIGNUP_ISSUER: issuer.issuer,
			CUPBOARD_SIGNUP_AUDIENCE: signupAudience,
			CUPBOARD_SIGNUP_SECRET: signupSecret,
			CUPBOARD_READ_USER: '',
			CUPBOARD_READ_PASSWORD: '',
			...options.bindings
		};
		const worker = new Miniflare({
			workers: [
				{
					name: 'cupboard',
					compatibilityDate: '2026-05-15',
					compatibilityFlags: ['nodejs_compat'],
					modules: true,
					modulesRoot: bundle.directory,
					scriptPath: path.join(bundle.directory, bundle.controlEntrypoint),
					bindings: controlBindings,
					durableObjects: {
						CUPBOARD_DO: {
							className: 'CupboardServer',
							scriptName: 'cupboard-tenant',
							useSQLite: true
						}
					},
					d1Databases: { CUPBOARD_DB: 'cupboard-e2e' },
					r2Buckets: { BLOBS: r2Credentials.bucketName },
					kvNamespaces: { TENANT_CACHE: 'tenant-cache' }
				},
				{
					name: 'cupboard-tenant',
					compatibilityDate: '2026-05-15',
					compatibilityFlags: ['nodejs_compat'],
					modules: true,
					modulesRoot: bundle.directory,
					scriptPath: path.join(bundle.directory, bundle.tenantEntrypoint),
					bindings: tenantBindings,
					durableObjects: {
						CUPBOARD_DO: {
							className: 'CupboardServer',
							useSQLite: true
						}
					},
					d1Databases: { CUPBOARD_DB: 'cupboard-e2e' },
					r2Buckets: { BLOBS: r2Credentials.bucketName }
				}
			]
		});
		await applyD1Migrations(
			await worker.getD1Database('CUPBOARD_DB', 'cupboard')
		);
		const bucket = await worker.getR2Bucket('BLOBS', 'cupboard');
		const server = createServer((request, response) => {
			void forwardToWorker(worker, request, response);
		});
		const url = await listen(server);

		return new CupboardTestServer(url, issuer, worker, bucket, server);
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

	/** An owner admin token, obtained the real way: an owner id_token exchanged at `/token`. */
	ownerAdminToken(): Promise<string> {
		return this.exchangeIdToken(
			this.issuer.sign({ aud: ownerAudience, sub: ownerSubject })
		);
	}

	/** Exchanges an issuer-signed id_token for a cupboard access token via `/token`. */
	async exchangeIdToken(idToken: string): Promise<string> {
		const body = new URLSearchParams({
			grant_type: tokenExchangeGrantType,
			subject_token: idToken,
			subject_token_type: subjectTokenTypeIdToken
		});
		const response = await fetch(
			new URL(`/t/${defaultTenant}/token`, this.url),
			{
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: body.toString()
			}
		);

		if (!response.ok) {
			throw new TokenExchangeFailedError(
				response.status,
				await response.text()
			);
		}

		const payload = (await response.json()) as {
			readonly access_token: string;
		};

		return payload.access_token;
	}

	/**
	 * Seeds a control trust rule directly in D1, standing in for the gated
	 * first-signup claim that will seed it. A pinned `sub` goes in `claims`.
	 */
	async seedControlTrust(rule: {
		readonly issuer: string;
		readonly audience: string;
		readonly claims?: Readonly<Record<string, string>>;
	}): Promise<void> {
		const d1 = await this.worker.getD1Database('CUPBOARD_DB', 'cupboard');

		await d1
			.prepare(
				'INSERT INTO control_trust (id, issuer, audience, claims_json, created_at) VALUES (?, ?, ?, ?, ?)'
			)
			.bind(
				crypto.randomUUID(),
				rule.issuer,
				rule.audience,
				JSON.stringify(rule.claims ?? {}),
				new Date().toISOString()
			)
			.run();
	}

	async stop(): Promise<void> {
		await Promise.all([
			closeServer(this.server),
			this.worker.dispose(),
			this.issuer.stop()
		]);
	}
}

export class TokenExchangeFailedError extends Error {
	constructor(
		public readonly status: number,
		public readonly body: string
	) {
		super(`Token exchange failed with ${String(status)}: ${body}`);
		this.name = 'TokenExchangeFailedError';
	}
}

// Applies the D1 migrations the way `wrangler d1 migrations apply` would for a
// deployment, so the e2e worker starts with the shared-blob schema in place.
// drizzle names migrations with a zero-padded numeric prefix, so filename order
// is apply order; statements within a file are split on its breakpoint marker.
async function applyD1Migrations(
	d1: Awaited<ReturnType<Miniflare['getD1Database']>>
): Promise<void> {
	const directory = path.join(root, 'packages/server/drizzle-d1');
	const files = readdirSync(directory)
		.filter((name) => name.endsWith('.sql'))
		.toSorted();

	for (const file of files) {
		const sql = readFileSync(path.join(directory, file), 'utf8');
		const statements = sql
			.split('--> statement-breakpoint')
			.map((statement) => statement.trim())
			.filter((statement) => statement.length > 0);

		for (const statement of statements) {
			await d1.prepare(statement).run();
		}
	}
}

interface WorkerBundle {
	readonly directory: string;
	readonly controlEntrypoint: string;
	readonly tenantEntrypoint: string;
}

// Bundles both Worker scripts into standalone modules: the control-plane Worker
// (`worker.ts`) and the tenant Durable Object Worker (`tenant-worker.ts`). They are
// deployed as two Workers, so the e2e harness runs them as two Miniflare workers
// with a cross-script Durable Object binding, mirroring production.
async function bundleWorker(directory: string): Promise<WorkerBundle> {
	const outputDirectory = path.join(directory, 'worker-bundle');

	await bundleEntry(
		outputDirectory,
		'packages/server/src/worker.ts',
		'worker',
		true
	);
	await bundleEntry(
		outputDirectory,
		'packages/server/src/tenant-worker.ts',
		'tenant',
		false
	);

	return {
		directory: outputDirectory,
		controlEntrypoint: 'worker.mjs',
		tenantEntrypoint: 'tenant.mjs'
	};
}

async function bundleEntry(
	outputDirectory: string,
	entry: string,
	name: string,
	emptyOutDirectory: boolean
): Promise<void> {
	await build({
		build: {
			emptyOutDir: emptyOutDirectory,
			lib: {
				entry: path.join(root, entry),
				fileName: name,
				formats: ['es']
			},
			minify: false,
			outDir: outputDirectory,
			rolldownOptions: {
				// Leave `node:*` to workerd's `nodejs_compat` runtime, as
				// `wrangler deploy` does, rather than bundling a polyfill. The
				// polyfilled `node:zlib` lacks the native zstd the verifier needs.
				external: ['cloudflare:workers', /^node:/],
				output: {
					entryFileNames: `${name}.mjs`
				}
			},
			target: 'es2023'
		},
		configFile: false,
		logLevel: 'silent',
		plugins: [sqlTextPlugin()],
		root
	});
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
