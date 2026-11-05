import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { Writable } from 'node:stream';

import { storePathHashSchema } from '@cupboard/nix-store/scalars';
import {
	commitCapabilitiesHeader,
	commitCapabilitiesValueWithCredit,
	type CommitSessionRequest,
	commitSessionRequestSchema,
	confirmPresentCapability,
	publicationCapability,
	uploadCapabilitiesHeader
} from '@cupboard/protocol/upload';
import { createReporter } from '@cupboard/reporter';
import { readUserSchema } from '@cupboard/shared/http';
import { describe, expect, it } from 'vitest';
import { type RawData, WebSocketServer } from 'ws';
import { z } from 'zod';

import { PushIncompleteError } from '../errors.ts';

import { PublicationCollection } from './publication.ts';
import { defaultUploadConcurrency, type PushClient, runPush } from './push.ts';
import { pushClientFor } from './push-client.ts';

const narHash = 'sha256:1023456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk';
const fileHash = 'sha256:1123456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk';

// The store-path hash of the path at `index`. The prefix keeps every hash
// distinct and in the Nix base-32 alphabet.
function storePathHashAt(index: number): string {
	return storePathHashSchema.parse(
		`${String(index).padStart(2, '0')}23456789abcdfghijklmnpqrsvwxyz`
	);
}

function storePathAt(index: number): string {
	return `/nix/store/${storePathHashAt(index)}-app`;
}

function operationIdFor(storePathHash: string): string {
	return createHash('sha256').update(storePathHash).digest('hex');
}

function narInfoFor(storePathHash: string): string {
	return [
		`StorePath: /nix/store/${storePathHash}-app`,
		'URL: nar/app.nar.zst',
		'Compression: zstd',
		`FileHash: ${fileHash}`,
		'FileSize: 99',
		`NarHash: ${narHash}`,
		'NarSize: 123',
		'References: ',
		''
	].join('\n');
}

// How the loopback server answers a push.
interface ServerScenario {
	readonly paths: number;
	readonly plan: 'skip' | 'commit';
	readonly confirmation?: 'confirmed' | 'missing';
	// Whether the commit handshake advertises `publication-v1`.
	readonly socketPublication?: boolean;
}

interface ServedRequest {
	readonly method: string;
	readonly path: string;
	readonly connection: number;
}

interface PushTraffic {
	readonly requests: ServedRequest[];
	readonly commitSockets: number;
	// The class of each error that a commit rejected with.
	readonly commitErrors: string[];
	readonly frames: CommitSessionRequest[];
	readonly outcome: unknown;
}

const requestedPathSchema = z.object({ storePathHash: z.string() });
const pathListSchema = z.object({ paths: z.array(requestedPathSchema) });

// The server's answers for one scenario. Every response body comes from these
// tables or from constants, never from the request.
interface ScenarioResponses {
	// Narinfo text, keyed by request path.
	readonly narInfos: ReadonlyMap<string, string>;
	// Plan decisions and confirmations, keyed by store-path hash.
	readonly plans: ReadonlyMap<string, object>;
	readonly confirmations: ReadonlyMap<string, object>;
}

type Reply =
	| { readonly kind: 'narinfo'; readonly body: string }
	| { readonly kind: 'json'; readonly body: string }
	| { readonly kind: 'not-found' };

function scenarioResponses(scenario: ServerScenario): ScenarioResponses {
	const hashes = Array.from({ length: scenario.paths }, (_, index) =>
		storePathHashAt(index)
	);

	return {
		narInfos: new Map(
			hashes.map((hash) => [`/t/acme/${hash}.narinfo`, narInfoFor(hash)])
		),
		plans: new Map(
			hashes.map((storePathHash) => {
				const operationId = operationIdFor(storePathHash);

				return [
					storePathHash,
					{
						action: scenario.plan,
						storePathHash,
						narHash,
						operationId,
						r2Key: `staging-v2/acme/push-1/${operationId}.nar.zst`
					}
				];
			})
		),
		confirmations: new Map(
			hashes.map((storePathHash) => [
				storePathHash,
				scenario.confirmation === 'missing'
					? { storePathHash, status: 'missing' }
					: {
							storePathHash,
							status: 'confirmed',
							generation: 3,
							narHash,
							grace: { retainUntil: '2099-01-01T00:00:00.000Z' }
						}
			])
		)
	};
}

// Looks up the answer for each requested path, in request order.
function answersFor(
	table: ReadonlyMap<string, object>,
	body: string
): object[] {
	return pathListSchema
		.parse(JSON.parse(body))
		.paths.map(({ storePathHash }) => {
			const answer = table.get(storePathHash);
			if (answer === undefined) {
				throw new Error(`Unexpected path in a request: ${storePathHash}`);
			}
			return answer;
		});
}

// Answers the requests of a push to the tenant `acme` as a server that echoes
// the publication and confirmation capabilities.
function answer(
	path: string,
	body: string,
	responses: ScenarioResponses
): Reply {
	if (path.endsWith('.narinfo')) {
		const narInfo = responses.narInfos.get(path);

		return narInfo === undefined
			? { kind: 'not-found' }
			: { kind: 'narinfo', body: narInfo };
	}

	if (path === '/t/acme/uploads/credential') {
		return {
			kind: 'json',
			body: JSON.stringify({
				pushId: 'push-1',
				accessKeyId: 'access',
				secretAccessKey: 'secret',
				sessionToken: 'session',
				endpoint: 'https://r2.test',
				bucket: 'blobs',
				expiresAt: '2099-01-01T00:00:00.000Z'
			})
		};
	}

	if (path === '/t/acme/uploads/plan') {
		return {
			kind: 'json',
			body: JSON.stringify({
				cacheGeneration: 1,
				pushExpiresAt: '2099-01-01T00:00:00.000Z',
				uploads: answersFor(responses.plans, body)
			})
		};
	}

	if (path === '/t/acme/uploads/confirm-present') {
		return {
			kind: 'json',
			body: JSON.stringify({
				paths: answersFor(responses.confirmations, body)
			})
		};
	}

	throw new Error(`Unexpected request: ${path}`);
}

function rawDataText(data: RawData): string {
	if (Array.isArray(data)) {
		return Buffer.concat(data).toString('utf8');
	}

	if (data instanceof ArrayBuffer) {
		return Buffer.from(data).toString('utf8');
	}

	return data.toString('utf8');
}

// Pushes reference paths from a loopback server, and records which connection
// served each request, the commit sockets opened, the frames sent on them, and
// how the push ended.
async function pushThroughServer(
	scenario: ServerScenario
): Promise<PushTraffic> {
	const requests: ServedRequest[] = [];
	const frames: CommitSessionRequest[] = [];
	let commitSockets = 0;
	const commitErrors: string[] = [];
	const connections = new WeakMap<object, number>();
	const responses = scenarioResponses(scenario);
	const server = createServer((request, response) => {
		requests.push({
			method: request.method ?? '',
			path: request.url ?? '',
			connection: connections.get(request.socket) ?? 0
		});
		const chunks: Buffer[] = [];
		request.on('data', (chunk: Buffer) => {
			chunks.push(chunk);
		});
		request.on('end', () => {
			const reply = answer(
				request.url ?? '',
				Buffer.concat(chunks).toString('utf8'),
				responses
			);
			if (reply.kind === 'not-found') {
				response.writeHead(404, {
					'content-type': 'text/plain',
					'x-content-type-options': 'nosniff'
				});
				response.end();
				return;
			}
			if (reply.kind === 'narinfo') {
				response.writeHead(200, {
					'content-type': 'text/x-nix-narinfo',
					'x-content-type-options': 'nosniff'
				});
				response.end(reply.body);
				return;
			}
			response.writeHead(200, {
				'content-type': 'application/json',
				'x-content-type-options': 'nosniff',
				[uploadCapabilitiesHeader]: `${publicationCapability},${confirmPresentCapability}`
			});
			response.end(reply.body);
		});
	});
	let connectionCount = 0;
	server.on('connection', (socket) => {
		connectionCount += 1;
		connections.set(socket, connectionCount);
	});
	const capabilities = commitCapabilitiesValueWithCredit(16)
		.split(',')
		.filter(
			(token) =>
				scenario.socketPublication !== false || token !== publicationCapability
		)
		.join(',');
	const sockets = new WebSocketServer({ noServer: true });
	sockets.on('headers', (headers) => {
		headers.push(`${commitCapabilitiesHeader}: ${capabilities}`);
	});
	server.on('upgrade', (request, socket, head) => {
		commitSockets += 1;
		sockets.handleUpgrade(request, socket, head, (commitSocket) => {
			commitSocket.on('message', (data) => {
				const frame = commitSessionRequestSchema.parse(
					JSON.parse(rawDataText(data))
				);
				frames.push(frame);
				if (frame.op !== 'publish-batch') {
					return;
				}
				for (const entry of frame.entries) {
					commitSocket.send(
						JSON.stringify({
							ev: 'settled',
							uploadId: entry.operationId,
							response: {
								storePathHash: entry.metadata.storePathHash,
								narHash: entry.metadata.narHash,
								status: 'committed'
							}
						})
					);
				}
			});
		});
	});

	try {
		await new Promise<void>((resolve) => {
			server.listen(0, '127.0.0.1', resolve);
		});
		const address = server.address();
		if (address === null || typeof address === 'string') {
			throw new TypeError('The push server has no TCP address');
		}
		const outcome = await pushReferences(
			`http://127.0.0.1:${String(address.port)}`,
			scenario.paths,
			commitErrors
		);

		return { requests, commitSockets, commitErrors, frames, outcome };
	} finally {
		sockets.close();
		server.closeAllConnections();
		await new Promise<void>((resolve) => {
			server.close(() => {
				resolve();
			});
		});
	}
}

// Records the class of each error that a commit through `client` rejects
// with.
function recordingCommitErrors(
	client: PushClient,
	commitErrors: string[]
): PushClient {
	const recorded = async <T>(commit: () => Promise<T>): Promise<T> => {
		try {
			return await commit();
		} catch (error) {
			commitErrors.push(error instanceof Error ? error.name : typeof error);
			throw error;
		}
	};

	return {
		...client,
		commit: (target, options) => recorded(() => client.commit(target, options)),
		openCommitSession: async (options) => {
			const session = await client.openCommitSession?.(options);
			if (session === undefined) {
				throw new Error('The push client opens no commit session');
			}

			return {
				...session,
				commit: (target) => recorded(() => session.commit(target))
			};
		}
	};
}

// Returns `published`, or the details of the push's failure.
async function pushReferences(
	origin: string,
	paths: number,
	commitErrors: string[]
): Promise<unknown> {
	const tenantUrl = new URL(`${origin}/t/acme`);

	try {
		await runPush(
			PublicationCollection.of({
				targets: [],
				referencePaths: Array.from({ length: paths }, (_, index) =>
					storePathAt(index)
				)
			}),
			createReporter({
				stream: new Writable({
					write(_chunk, _encoding, callback) {
						callback();
					}
				})
			}),
			{
				command: 'cupboard push',
				credential: 'cupboard-login',
				retain: false,
				referenceSource: {
					url: tenantUrl,
					readUser: readUserSchema.parse('reader'),
					readPassword: 'secret'
				},
				client: recordingCommitErrors(
					pushClientFor(tenantUrl, 'token', {
						cache: { kind: 'default' }
					}),
					commitErrors
				)
			}
		);

		return 'published';
	} catch (error) {
		if (error instanceof PushIncompleteError) {
			return error.push;
		}

		throw error;
	}
}

function publishedIds(frames: readonly CommitSessionRequest[]): string[] {
	return frames
		.flatMap((frame) =>
			frame.op === 'publish-batch'
				? frame.entries.map((entry) => entry.operationId)
				: []
		)
		.toSorted((left, right) => left.localeCompare(right));
}

describe('push connections', () => {
	it('publishes an available path over one connection without a commit socket', async () => {
		const storePathHash = storePathHashAt(0);
		const traffic = await pushThroughServer({
			paths: 1,
			plan: 'skip',
			confirmation: 'confirmed'
		});

		expect(traffic).toStrictEqual({
			requests: [
				{
					method: 'GET',
					path: `/t/acme/${storePathHash}.narinfo`,
					connection: 1
				},
				{ method: 'POST', path: '/t/acme/uploads/credential', connection: 1 },
				{ method: 'POST', path: '/t/acme/uploads/plan', connection: 1 },
				{
					method: 'POST',
					path: '/t/acme/uploads/confirm-present',
					connection: 1
				}
			],
			commitSockets: 0,
			commitErrors: [],
			frames: [],
			outcome: 'published'
		});
	});

	it('opens one commit socket and publishes a path that needs a commit', async () => {
		const storePathHash = storePathHashAt(0);
		const traffic = await pushThroughServer({ paths: 1, plan: 'commit' });

		expect(traffic).toStrictEqual({
			requests: [
				{
					method: 'GET',
					path: `/t/acme/${storePathHash}.narinfo`,
					connection: 1
				},
				{ method: 'POST', path: '/t/acme/uploads/credential', connection: 1 },
				{ method: 'POST', path: '/t/acme/uploads/plan', connection: 1 }
			],
			commitSockets: 1,
			commitErrors: [],
			frames: [
				{
					op: 'publish-batch',
					pushId: 'push-1',
					entries: [
						{
							operationId: operationIdFor(storePathHash),
							cacheGeneration: 1,
							metadata: {
								storePathHash,
								storePath: storePathAt(0),
								narHash,
								narSize: 123,
								references: []
							}
						}
					]
				}
			],
			outcome: 'published'
		});
	});

	it('commits every missing skip when there are more than the upload workers', async () => {
		const paths = defaultUploadConcurrency + 2;
		const traffic = await pushThroughServer({
			paths,
			plan: 'skip',
			confirmation: 'missing'
		});

		expect({
			commitSockets: traffic.commitSockets,
			commitErrors: traffic.commitErrors,
			published: publishedIds(traffic.frames),
			outcome: traffic.outcome
		}).toStrictEqual({
			commitSockets: 1,
			commitErrors: [],
			published: Array.from({ length: paths }, (_, index) =>
				operationIdFor(storePathHashAt(index))
			).toSorted((left, right) => left.localeCompare(right)),
			outcome: 'published'
		});
	});

	it('fails the push when the commit socket lacks the publication capability of the credential', async () => {
		const traffic = await pushThroughServer({
			paths: 1,
			plan: 'skip',
			confirmation: 'missing',
			socketPublication: false
		});

		expect({
			commitSockets: traffic.commitSockets,
			commitErrors: traffic.commitErrors,
			frames: traffic.frames,
			outcome: traffic.outcome
		}).toStrictEqual({
			commitSockets: 1,
			commitErrors: ['CommitSocketCapabilityMismatchError'],
			frames: [],
			outcome: {
				failures: [{ path: `${storePathHashAt(0)}-app`, stage: 'commit' }],
				exitStatus: 1,
				command: 'cupboard push',
				credential: 'cupboard-login',
				recordsRetention: false
			}
		});
	});
});
