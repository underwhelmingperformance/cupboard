import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
	STATUS_CODES
} from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { Duplex } from 'node:stream';

import {
	subjectTokenTypeIdToken,
	tokenExchangeGrantType,
	tokenResponseSchema
} from '@cupboard/protocol/oidc';
import { Miniflare } from 'miniflare';
import { build, type Plugin } from 'vite';
import { type RawData, type WebSocket, WebSocketServer } from 'ws';

import type { AccessCredential } from '../../packages/cli/src/client/credentials.ts';
import type { PushClient } from '../../packages/cli/src/push/push.ts';
import { pushClientFor } from '../../packages/cli/src/push/push-client.ts';
import { fixtureTenant } from '../../packages/server/src/routing/tenant-routing.test-support.ts';

import { StubOidcIssuer } from './oidc-issuer.ts';

const root = path.resolve(import.meta.dirname, '../..');

// The owner identity the stub issuer asserts and the worker is configured to
// trust; the audience stands in for the CLI's registered OAuth client id.
export const ownerSubject = 'e2e-owner';
export const ownerAudience = 'cupboard-owner-client';

// The audience the stub issuer stamps into a control-plane subject token, and the
// deployment's single-use claim secret gating the first-signup global-admin claim.
export const signupAudience = 'cupboard-control-client';
export const signupSecret = 'e2e-signup-secret';

// The external subject the harness presents to provision the fixture tenant: it
// stands in for the operator who would do this through the control plane.
const harnessAdminSubject = 'harness-admin';

// How the harness provisions the fixture tenant: its read mode and, for a private
// cache, the read credential its reads require.
export interface TenantProvisionSpec {
	readonly readMode: 'public' | 'private';
	readonly read?: { readonly user: string; readonly password: string };
}

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
 * What the commit sessions of a run did, as counted at the socket the worker
 * answered on. A test that needs to prove a publication waited on the socket it
 * already held, rather than re-dialling, reads the upgrade count; one that needs
 * to prove the credit budget was genuinely exhausted reads the queued count.
 */
export interface CommitSessionObservations {
	readonly upgrades: number;
	readonly creditFrames: number;
	readonly queuedFrames: number;
}

interface CommitSessionCounters {
	upgrades: number;
	creditFrames: number;
	queuedFrames: number;
}

// Counts a frame the worker sent. The keepalive answer is not a frame and the
// socket carries nothing else that is not JSON, so anything unparseable is
// simply not a frame worth counting.
function countWorkerFrame(counters: CommitSessionCounters, data: string): void {
	try {
		const frame: unknown = JSON.parse(data);

		if (typeof frame !== 'object' || frame === null || !('ev' in frame)) {
			return;
		}

		if (frame.ev === 'credit') {
			counters.creditFrames += 1;
		} else if (frame.ev === 'queued') {
			counters.queuedFrames += 1;
		}
	} catch {
		// Not a frame: the keepalive answer, or a control message.
	}
}

/**
 * A running cupboard worker backed by Miniflare, fronted by a local HTTP server
 * so that Nix can reach it over a real socket. A push's NAR bytes are written
 * straight into the bound R2 bucket because the real upload signs with a
 * temporary credential against Cloudflare's S3 endpoint, which Miniflare does
 * not serve.
 */
export class CupboardTestServer {
	static async start(
		directory: string,
		options: {
			readonly bindings?: Readonly<Record<string, string>>;
			readonly provision?: false | TenantProvisionSpec;
		} = {}
	): Promise<CupboardTestServer> {
		const bundle = await bundleWorker(directory);
		const issuer = await StubOidcIssuer.start();

		// The Durable Object runs in its own `cupboard-tenant` script, so its
		// bindings exclude the control-plane signing key, exactly as in production.
		// The control-plane Worker binds the wrapping secret and reaches the Durable
		// Object across scripts via `scriptName`.
		const tenantBindings = {
			CUPBOARD_COLD_PATH_TTL_SECONDS: '',
			PUSH_ID_SIGNING_KEY: 'e2e-push-id-signing-key',
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
					kvNamespaces: { TENANT_CACHE: 'tenant-cache' },
					// The maintenance queue, consumed by the control Worker as in
					// production, so a deferred commit's verification request is
					// processed.
					queueProducers: {
						MAINTENANCE_QUEUE: { queueName: 'cupboard-maintenance' }
					},
					queueConsumers: {
						'cupboard-maintenance': { maxBatchSize: 10, maxBatchTimeout: 0 }
					}
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
					r2Buckets: { BLOBS: r2Credentials.bucketName },
					queueProducers: {
						MAINTENANCE_QUEUE: { queueName: 'cupboard-maintenance' }
					}
				}
			]
		});
		await applyD1Migrations(
			await worker.getD1Database('CUPBOARD_DB', 'cupboard')
		);
		const bucket = await worker.getR2Bucket('BLOBS', 'cupboard');
		const httpServer = createServer((request, response) => {
			void forwardToWorker(worker, request, response);
		});
		const upgrades = new WebSocketServer({ noServer: true });
		upgrades.on('headers', forwardWorkerUpgradeHeaders);
		const commitCounters: CommitSessionCounters = {
			upgrades: 0,
			creditFrames: 0,
			queuedFrames: 0
		};
		httpServer.on('upgrade', (request, socket, head) => {
			void forwardUpgradeToWorker(
				worker,
				upgrades,
				request,
				socket,
				head,
				commitCounters
			);
		});
		const url = await listen(httpServer);
		const instance = new CupboardTestServer(
			url,
			issuer,
			worker,
			bucket,
			httpServer,
			commitCounters
		);

		// Mirror a deployment: the fixture tenant is provisioned through the control
		// plane before it can serve. A test that exercises a fresh bootstrap (or only
		// the control surface) opts out with `provision: false`.
		if (options.provision !== false) {
			await instance.provisionFixtureTenant(
				options.provision ?? { readMode: 'public' }
			);
		}

		return instance;
	}

	private constructor(
		readonly url: URL,
		readonly issuer: StubOidcIssuer,
		private readonly worker: Miniflare,
		private readonly bucket: Awaited<ReturnType<Miniflare['getR2Bucket']>>,
		private readonly server: Server,
		private readonly commitCounters: CommitSessionCounters
	) {}

	// Mints a control admin token at the bare-host `/token`, the control issuer,
	// exchanging the harness admin's external subject token.
	private async exchangeControlAdminToken(): Promise<string> {
		const subjectToken = this.issuer.sign({
			aud: signupAudience,
			sub: harnessAdminSubject
		});
		const body = new URLSearchParams({
			grant_type: tokenExchangeGrantType,
			subject_token: subjectToken,
			subject_token_type: subjectTokenTypeIdToken
		});
		const response = await fetch(new URL('/token', this.url), {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: body.toString()
		});

		if (!response.ok) {
			throw new TokenExchangeFailedError(
				response.status,
				await response.text()
			);
		}

		const payload = tokenResponseSchema.parse(await response.json());

		return payload.access_token;
	}

	/**
	 * What the commit sessions have done so far. A test that spans one run reads
	 * this before and after it and compares, since the counts are the server's
	 * and outlive any one run.
	 */
	get commitSessions(): CommitSessionObservations {
		return { ...this.commitCounters };
	}

	/**
	 * The fixture tenant's base URL: the `/t/<tenant>/` prefix every tenant route
	 * (token exchange, uploads, narinfo and NAR reads) lives under. The bare
	 * {@link URL} is the deployment/control surface.
	 */
	get tenantUrl(): URL {
		return new URL(`/t/${fixtureTenant}`, this.url);
	}

	/**
	Resolves a tenant-relative path (e.g. `/x.narinfo`) under {@link tenantUrl}.
	*/
	tenantPath(path: string): URL {
		const url = this.tenantUrl;
		url.pathname = `${url.pathname}${path}`;

		return url;
	}

	/**
	 * Provisions the fixture tenant the way an operator would: it seeds the control
	 * trust policy, mints a control admin token, and creates the tenant through the
	 * control API, which configures its Durable Object and publishes the admission
	 * manifest. After this the fixture tenant serves and accepts writes.
	 */
	async provisionFixtureTenant(spec: TenantProvisionSpec): Promise<void> {
		await this.seedControlTrust({
			issuer: this.issuer.issuer,
			audience: signupAudience,
			claims: { sub: harnessAdminSubject }
		});

		const adminToken = await this.exchangeControlAdminToken();
		const body = {
			id: fixtureTenant,
			readMode: spec.readMode,
			ownerIssuer: this.issuer.issuer,
			ownerSubject,
			ownerAudience,
			...(spec.read !== undefined && { read: spec.read })
		};
		const response = await fetch(new URL('/control/tenants', this.url), {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${adminToken}`
			},
			body: JSON.stringify(body)
		});

		if (!response.ok) {
			throw new TenantProvisionFailedError(
				response.status,
				await response.text()
			);
		}
	}

	/**
	 * Builds the push client an e2e test drives. Negotiation, commit and
	 * retention speak to the running worker; the streamed NAR bytes are written
	 * straight into the bound R2 bucket the worker verifies against, standing in
	 * for the temporary-credential upload to Cloudflare's S3 endpoint that the
	 * SDK cannot reach under Miniflare.
	 */
	pushClient(
		credential: AccessCredential,
		options: { readonly cache?: string } = {}
	): PushClient {
		const base = pushClientFor(this.tenantUrl, credential, {
			cache: options.cache
		});

		return {
			...base,
			uploadNar: async (r2Key, body) =>
				this.stageObject(r2Key, await collectStreamBytes(body))
		};
	}

	/**
	Writes bytes to a staging key, the bucket the worker verifies against.
	*/
	async stageObject(r2Key: string, bytes: Uint8Array): Promise<void> {
		await this.bucket.put(r2Key, bytes, {
			sha256: createHash('sha256').update(bytes).digest()
		});
	}

	/**
	An owner admin token, obtained the real way: an owner id_token exchanged at `/token`.
	*/
	ownerAdminToken(): Promise<string> {
		return this.exchangeIdToken(
			this.issuer.sign({ aud: ownerAudience, sub: ownerSubject })
		);
	}

	/**
	 * Exchanges an issuer-signed id_token for a cupboard access token via
	 * `/token`. A claim-bound (CI) rule must name the `authorizationDetails` it
	 * wants; the interactive owner may omit them and receive its wildcard.
	 */
	async exchangeIdToken(
		idToken: string,
		authorizationDetails?: unknown
	): Promise<string> {
		const body = new URLSearchParams({
			grant_type: tokenExchangeGrantType,
			subject_token: idToken,
			subject_token_type: subjectTokenTypeIdToken,
			...(authorizationDetails !== undefined && {
				authorization_details: JSON.stringify(authorizationDetails)
			})
		});
		const response = await fetch(
			new URL(`/t/${fixtureTenant}/token`, this.url),
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

		const payload = tokenResponseSchema.parse(await response.json());

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
		const now = new Date();

		await d1
			.prepare(
				'INSERT INTO control_trust (id, issuer, audience, claims_json, created_at) VALUES (?, ?, ?, ?, ?)'
			)
			.bind(
				crypto.randomUUID(),
				rule.issuer,
				rule.audience,
				JSON.stringify(rule.claims ?? {}),
				now.toISOString()
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

export class TenantProvisionFailedError extends Error {
	constructor(
		public readonly status: number,
		public readonly body: string
	) {
		super(`Tenant provisioning failed with ${String(status)}: ${body}`);
		this.name = 'TenantProvisionFailedError';
	}
}

async function collectStreamBytes(
	stream: ReadableStream<Uint8Array>
): Promise<Uint8Array> {
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Order filenames by UTF-16 code unit, matching the default `Array#sort` order.
function byCodeUnit(a: string, b: string): number {
	if (a < b) {
		return -1;
	}

	if (a > b) {
		return 1;
	}

	return 0;
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
		.toSorted(byCodeUnit);

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
	shouldEmptyOutDirectory: boolean
): Promise<void> {
	await build({
		build: {
			emptyOutDir: shouldEmptyOutDirectory,
			lib: {
				entry: path.join(root, entry),
				fileName: name,
				formats: ['es']
			},
			minify: false,
			outDir: outputDirectory,
			rolldownOptions: {
				// Leave `node:*` to workerd's `nodejs_compat` runtime, as
				// `wrangler deploy` does. The polyfilled `node:zlib` lacks the
				// native zstd the verifier needs.
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

		const requestUrl = new URL(request.url ?? '/', localOrigin(request));
		const workerResponse = await worker.dispatchFetch(requestUrl.href, init);
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

type MiniflareResponse = Awaited<ReturnType<Miniflare['dispatchFetch']>>;
type WorkerSocket = NonNullable<MiniflareResponse['webSocket']>;

// The worker's 101 carries the capability headers a client reads to learn what
// this connection offers, the commit credit grant among them. ws completes the
// client handshake with headers of its own, so the worker's must be carried
// across the bridge explicitly. Without them the two ends negotiate different
// protocols: the worker reads the client's declaration from the request, which
// crosses the bridge intact, while the client finds no offer in the response
// and falls back.
const upgradeResponseHeaders = new WeakMap<
	IncomingMessage,
	readonly string[]
>();

function forwardWorkerUpgradeHeaders(
	headers: string[],
	request: IncomingMessage
): void {
	const workerHeaders = upgradeResponseHeaders.get(request);

	if (workerHeaders !== undefined) {
		headers.push(...workerHeaders);
	}
}

function capabilityHeaderLines(
	headers: Awaited<ReturnType<Miniflare['dispatchFetch']>>['headers']
): readonly string[] {
	const lines: string[] = [];

	headers.forEach((value, name) => {
		if (name.startsWith('x-cupboard-')) {
			lines.push(`${name}: ${value}`);
		}
	});

	return lines;
}

// Bridges a WebSocket upgrade to the worker: the upgrade request (with its
// Authorization header) dispatches into Miniflare; an accepted socket relays
// frames both ways, and a refusal is written back as the plain HTTP response
// so the client sees the status and body it carries.
async function forwardUpgradeToWorker(
	worker: Miniflare,
	upgrades: WebSocketServer,
	request: IncomingMessage,
	socket: Duplex,
	head: Buffer,
	counters: CommitSessionCounters
): Promise<void> {
	try {
		const requestUrl = new URL(request.url ?? '/', localOrigin(request));
		const response = await worker.dispatchFetch(requestUrl.href, {
			headers: requestHeaders(request),
			method: 'GET'
		});
		const workerSocket = response.webSocket;

		if (workerSocket === null) {
			await refuseUpgrade(socket, response);

			return;
		}

		workerSocket.accept();
		upgradeResponseHeaders.set(
			request,
			capabilityHeaderLines(response.headers)
		);

		if (requestUrl.pathname.endsWith('/commit')) {
			counters.upgrades += 1;
		}

		upgrades.handleUpgrade(request, socket, head, (client) => {
			relaySockets(client, workerSocket, counters);
		});
	} catch (error) {
		socket.destroy(error instanceof Error ? error : new Error(String(error)));
	}
}

function relaySockets(
	client: WebSocket,
	workerSocket: WorkerSocket,
	counters: CommitSessionCounters
): void {
	client.on('message', (data, isBinary) => {
		const bytes = rawDataBytes(data);
		workerSocket.send(
			isBinary ? new Uint8Array(bytes) : bytes.toString('utf8')
		);
	});
	client.on('close', () => {
		workerSocket.close();
	});
	client.on('error', () => {
		workerSocket.close();
	});

	workerSocket.addEventListener('message', (event) => {
		if (typeof event.data === 'string') {
			countWorkerFrame(counters, event.data);
		}

		client.send(event.data);
	});
	workerSocket.addEventListener('close', (event) => {
		// `ws` only accepts codes a close frame may carry; anything else (1005
		// "no status", 1006 "abnormal") closes with the default.
		if (event.code === 1000 || (event.code >= 3000 && event.code <= 4999)) {
			client.close(event.code, event.reason);

			return;
		}

		client.close();
	});
	workerSocket.addEventListener('error', () => {
		client.close();
	});
}

function rawDataBytes(data: RawData): Buffer {
	if (Array.isArray(data)) {
		return Buffer.concat(data);
	}

	if (data instanceof ArrayBuffer) {
		return Buffer.from(data);
	}

	return data;
}

async function refuseUpgrade(
	socket: Duplex,
	response: MiniflareResponse
): Promise<void> {
	const body = Buffer.from(await response.arrayBuffer());
	const lines = [
		`HTTP/1.1 ${String(response.status)} ${STATUS_CODES[response.status] ?? ''}`,
		'connection: close',
		`content-length: ${String(body.byteLength)}`
	];

	for (const [name, value] of response.headers) {
		if (['connection', 'content-length', 'transfer-encoding'].includes(name)) {
			continue;
		}

		lines.push(`${name}: ${value}`);
	}

	socket.write(`${lines.join('\r\n')}\r\n\r\n`);
	socket.write(body);
	socket.end();
}

function listen(server: Server): Promise<URL> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error): void => {
			reject(error);
		};

		server.once('error', onError);
		server.listen(0, '127.0.0.1', () => {
			server.removeListener('error', onError);
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
		super(`Invalid local server URL: ${url.href}`);
		this.name = 'InvalidLocalUrlError';
	}
}
