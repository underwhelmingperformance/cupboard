import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse
} from 'node:http';
import type { AddressInfo } from 'node:net';

const kid = 'stub-issuer-key-1';

/**
 * A minimal OpenID Connect issuer for the e2e suite. It serves real discovery
 * metadata and a JWKS, and signs real RS256 tokens, so cupboard's token
 * exchange runs its genuine discovery and signature verification against it
 * rather than a mock. The worker reaches it over loopback.
 */
export class StubOidcIssuer {
	static async start(): Promise<StubOidcIssuer> {
		const { publicKey, privateKey } = generateKeyPairSync('rsa', {
			modulusLength: 2048
		});
		const publicJwk = {
			...publicKey.export({ format: 'jwk' }),
			kid,
			alg: 'RS256',
			use: 'sig'
		};

		const issuerHolder = { url: '' };
		const server = createServer((request, response) => {
			route(request, response, issuerHolder.url, publicJwk);
		});
		const url = await listen(server);
		issuerHolder.url = url;

		return new StubOidcIssuer(url, server, privateKey);
	}

	private constructor(
		readonly issuer: string,
		private readonly server: Server,
		private readonly privateKey: KeyObject
	) {}

	/** Signs an RS256 JWT from this issuer; `iss` and timestamps are filled in. */
	sign(claims: Readonly<Record<string, unknown>>): string {
		const issuedAt = Math.floor(Date.now() / 1000);
		const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
		const payload = base64url(
			JSON.stringify({
				iss: this.issuer,
				iat: issuedAt,
				exp: issuedAt + 600,
				...claims
			})
		);
		const signingInput = `${header}.${payload}`;
		const signature = createSign('RSA-SHA256')
			.update(signingInput)
			.sign(this.privateKey)
			.toString('base64url');

		return `${signingInput}.${signature}`;
	}

	async stop(): Promise<void> {
		await closeServer(this.server);
	}
}

function route(
	request: IncomingMessage,
	response: ServerResponse,
	issuer: string,
	publicJwk: object
): void {
	const { pathname } = new URL(request.url ?? '/', 'http://127.0.0.1');

	if (pathname === '/.well-known/openid-configuration') {
		sendJson(response, {
			issuer,
			jwks_uri: `${issuer}/jwks`,
			token_endpoint: `${issuer}/token`,
			authorization_endpoint: `${issuer}/authorize`,
			device_authorization_endpoint: `${issuer}/device`,
			id_token_signing_alg_values_supported: ['RS256']
		});
		return;
	}

	if (pathname === '/jwks') {
		sendJson(response, { keys: [publicJwk] });
		return;
	}

	response.writeHead(404);
	response.end();
}

function sendJson(response: ServerResponse, body: unknown): void {
	response.writeHead(200, { 'content-type': 'application/json' });
	response.end(JSON.stringify(body));
}

function base64url(value: string): string {
	return Buffer.from(value).toString('base64url');
}

function listen(server: Server): Promise<string> {
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address() as AddressInfo;

			resolve(`http://127.0.0.1:${String(address.port)}`);
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
