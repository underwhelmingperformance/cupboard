import { createServer, type IncomingMessage } from 'node:http';
import { Writable } from 'node:stream';

import { storePathHashSchema } from '@cupboard/nix-store/scalars';
import {
	acceptCapabilitiesHeader,
	commitCapabilitiesHeader,
	commitCapabilitiesValueWithCredit,
	commitSessionRequestSchema,
	uploadCapabilitiesHeader
} from '@cupboard/protocol/upload';
import { createReporter } from '@cupboard/reporter';
import { readUserSchema } from '@cupboard/shared/http';
import { describe, expect, it } from 'vitest';
import { type RawData, WebSocketServer } from 'ws';

import { PublicationCollection } from './publication.ts';
import { runPush } from './push.ts';
import { pushClientFor } from './push-client.ts';

const storePathHash = storePathHashSchema.parse(
	'0123456789abcdfghijklmnpqrsvwxyz'
);
const storePath = `/nix/store/${storePathHash}-app`;
const narHash = 'sha256:1023456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk';
const operationId = 'a'.repeat(64);

const narInfo = [
	`StorePath: ${storePath}`,
	'URL: nar/app.nar.zst',
	'Compression: zstd',
	'FileHash: sha256:1123456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk',
	'FileSize: 99',
	`NarHash: ${narHash}`,
	'NarSize: 123',
	'References: ',
	''
].join('\n');

type PlannedAction = 'skip' | 'commit';

interface ServedRequest {
	readonly method: string;
	readonly path: string;
	readonly connection: number;
}

interface PushTraffic {
	readonly requests: ServedRequest[];
	readonly commitSockets: number;
	readonly publications: unknown[];
}

function json(body: unknown, headers: Record<string, string> = {}) {
	return {
		body: JSON.stringify(body),
		headers: { 'content-type': 'application/json', ...headers }
	};
}

// Answers the requests of a push of `storePath` to the tenant `acme` as a
// server that echoes the publication and confirmation capabilities.
function answer(request: IncomingMessage, action: PlannedAction) {
	const path = request.url ?? '';

	if (path === `/t/acme/${storePathHash}.narinfo`) {
		return {
			body: narInfo,
			headers: { 'content-type': 'text/x-nix-narinfo' }
		};
	}

	if (path === '/t/acme/uploads/credential') {
		return json(
			{
				pushId: 'push-1',
				accessKeyId: 'access',
				secretAccessKey: 'secret',
				sessionToken: 'session',
				endpoint: 'https://r2.test',
				bucket: 'blobs',
				expiresAt: '2099-01-01T00:00:00.000Z'
			},
			{
				[uploadCapabilitiesHeader]:
					request.headers[acceptCapabilitiesHeader]?.toString() ?? ''
			}
		);
	}

	if (path === '/t/acme/uploads/plan') {
		return json({
			cacheGeneration: 1,
			pushExpiresAt: '2099-01-01T00:00:00.000Z',
			uploads: [
				{
					action,
					storePathHash,
					narHash,
					operationId,
					r2Key: `staging-v2/acme/push-1/${operationId}.nar.zst`
				}
			]
		});
	}

	if (path === '/t/acme/uploads/confirm-present') {
		return json({
			paths: [
				{
					storePathHash,
					status: 'confirmed',
					generation: 3,
					narHash,
					grace: { retainUntil: '2099-01-01T00:00:00.000Z' }
				}
			]
		});
	}

	throw new Error(`Unexpected request: ${request.method ?? ''} ${path}`);
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

// Pushes `storePath` from a reference source on a loopback server, and records
// which connection served each request, the commit sockets opened, and the
// publications sent on them.
async function pushThroughServer(action: PlannedAction): Promise<PushTraffic> {
	const requests: ServedRequest[] = [];
	const publications: unknown[] = [];
	let commitSockets = 0;
	const connections = new WeakMap<object, number>();
	const server = createServer((request, response) => {
		requests.push({
			method: request.method ?? '',
			path: request.url ?? '',
			connection: connections.get(request.socket) ?? 0
		});
		request.resume();
		request.on('end', () => {
			const { body: payload, headers } = answer(request, action);
			response.writeHead(200, headers);
			response.end(payload);
		});
	});
	let connectionCount = 0;
	server.on('connection', (socket) => {
		connectionCount += 1;
		connections.set(socket, connectionCount);
	});
	const sockets = new WebSocketServer({ noServer: true });
	sockets.on('headers', (headers) => {
		headers.push(
			`${commitCapabilitiesHeader}: ${commitCapabilitiesValueWithCredit(1)}`
		);
	});
	server.on('upgrade', (request, socket, head) => {
		commitSockets += 1;
		sockets.handleUpgrade(request, socket, head, (commitSocket) => {
			commitSocket.on('message', (data) => {
				const message = commitSessionRequestSchema.parse(
					JSON.parse(rawDataText(data))
				);
				publications.push(message);
				if (message.op !== 'publish-batch') {
					return;
				}
				for (const entry of message.entries) {
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
		await pushReference(`http://127.0.0.1:${String(address.port)}`);

		return { requests, commitSockets, publications };
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

async function pushReference(origin: string): Promise<void> {
	const tenantUrl = new URL(`${origin}/t/acme`);

	await runPush(
		PublicationCollection.of({ targets: [], referencePaths: [storePath] }),
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
			client: pushClientFor(tenantUrl, 'token', {
				cache: { kind: 'default' }
			})
		}
	);
}

describe('push connections', () => {
	it('publishes an available path over one connection', async () => {
		const traffic = await pushThroughServer('skip');

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
			commitSockets: 1,
			publications: []
		});
	});

	it('opens the commit socket and publishes a path that needs a commit', async () => {
		const traffic = await pushThroughServer('commit');

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
			commitSockets: 2,
			publications: [
				{
					op: 'publish-batch',
					pushId: 'push-1',
					entries: [
						{
							operationId,
							cacheGeneration: 1,
							metadata: {
								storePathHash,
								storePath,
								narHash,
								narSize: 123,
								references: []
							}
						}
					]
				}
			]
		});
	});
});
