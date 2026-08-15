import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse
} from 'node:http';
import type { AddressInfo } from 'node:net';

import type { StubOidcIssuer } from './oidc-issuer.ts';

export interface RunnerTokenClaims {
	readonly sub: string;
	readonly [claim: string]: unknown;
}

export interface RunnerTokenEnvironment {
	readonly ACTIONS_ID_TOKEN_REQUEST_URL: string;
	readonly ACTIONS_ID_TOKEN_REQUEST_TOKEN: string;
}

/**
 * The token endpoint GitHub Actions exposes to a job that was granted
 * `id-token: write`. The runner sets its address and a request token in
 * `ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN`; a client
 * requests a token for an audience and receives `{"value": "<id_token>"}`.
 *
 * This stub speaks that protocol over loopback and answers with a token signed
 * by {@link StubOidcIssuer}, so `--github-oidc` performs its real request and
 * the tenant verifies the token it presents against the issuer's JWKS.
 */
export class StubRunnerTokenEndpoint {
	static async start(options: {
		readonly issuer: StubOidcIssuer;
		readonly claims: RunnerTokenClaims;
		readonly requestToken?: string;
	}): Promise<StubRunnerTokenEndpoint> {
		const requestToken = options.requestToken ?? 'stub-runner-request-token';
		const audiences: string[] = [];
		const server = createServer((request, response) => {
			route(request, response, {
				issuer: options.issuer,
				claims: options.claims,
				requestToken,
				audiences
			});
		});
		const url = await listen(server);

		return new StubRunnerTokenEndpoint(url, requestToken, audiences, server);
	}

	private constructor(
		private readonly url: string,
		private readonly requestToken: string,
		private readonly requestedAudiences: readonly string[],
		private readonly server: Server
	) {}

	/** The two variables a runner sets for a job holding the OIDC permission. */
	get environment(): RunnerTokenEnvironment {
		return {
			ACTIONS_ID_TOKEN_REQUEST_URL: this.url,
			ACTIONS_ID_TOKEN_REQUEST_TOKEN: this.requestToken
		};
	}

	/** Every audience requested so far, in request order. */
	get audiences(): readonly string[] {
		return [...this.requestedAudiences];
	}

	async stop(): Promise<void> {
		await closeServer(this.server);
	}
}

function route(
	request: IncomingMessage,
	response: ServerResponse,
	state: {
		readonly issuer: StubOidcIssuer;
		readonly claims: RunnerTokenClaims;
		readonly requestToken: string;
		readonly audiences: string[];
	}
): void {
	if (request.headers.authorization !== `Bearer ${state.requestToken}`) {
		response.writeHead(401);
		response.end();

		return;
	}

	const audience = new URL(
		request.url ?? '/',
		'http://127.0.0.1'
	).searchParams.get('audience');

	if (audience === null || audience === '') {
		response.writeHead(400);
		response.end();

		return;
	}

	state.audiences.push(audience);
	response.writeHead(200, { 'content-type': 'application/json' });
	response.end(
		JSON.stringify({
			value: state.issuer.sign({ ...state.claims, aud: audience })
		})
	);
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

			resolve(`http://127.0.0.1:${String(address.port)}/token`);
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
