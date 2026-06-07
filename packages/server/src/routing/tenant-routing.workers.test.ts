import { tokenExchangeGrantType } from '@cupboard/protocol/oidc';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import {
	currentOrigin,
	handlerFetch,
	mintTokenForTenant,
	provisionNamedTenant,
	resetTestServer,
	suspendTenant,
	testServerFor
} from '../test-support.ts';

import { fixtureTenant } from './tenant-routing.test-support.ts';

interface TokenClaims {
	readonly iss?: string;
	readonly aud?: string;
}

function decodeClaims(token: string): TokenClaims {
	const payload = token.split('.')[1] ?? '';
	const json = atob(payload.replaceAll('-', '+').replaceAll('_', '/'));

	return JSON.parse(json) as TokenClaims;
}

function bearer(token: string): RequestInit {
	return { headers: { authorization: `Bearer ${token}` } };
}

function writeRequest(): RequestInit {
	return {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: '{}'
	};
}

describe('tenant routing', () => {
	beforeEach(resetTestServer);

	it('advertises the tenant path-based issuer in its AS metadata', async () => {
		await provisionNamedTenant('acme');

		const response = await handlerFetch(
			'/t/acme/.well-known/oauth-authorization-server'
		);
		const base = `${currentOrigin()}/t/acme`;

		expect({
			status: response.status,
			body: await response.json()
		}).toStrictEqual({
			status: StatusCodes.OK,
			body: {
				issuer: base,
				token_endpoint: `${base}/token`,
				jwks_uri: `${base}/.well-known/jwks.json`,
				grant_types_supported: [tokenExchangeGrantType],
				scopes_supported: ['write', 'admin'],
				token_endpoint_auth_methods_supported: ['none']
			}
		});
	});

	it('mints under its own issuer, and that token verifies at that tenant only', async () => {
		const acmeIssuer = await provisionNamedTenant('acme');
		await provisionNamedTenant('beta');
		const token = await mintTokenForTenant(
			testServerFor('acme'),
			acmeIssuer,
			'admin'
		);
		const claims = decodeClaims(token);

		const atAcme = await handlerFetch('/t/acme/keys/auth', bearer(token));
		const atBeta = await handlerFetch('/t/beta/keys/auth', bearer(token));

		expect({
			iss: claims.iss,
			aud: claims.aud,
			atAcme: atAcme.status,
			atBeta: atBeta.status
		}).toStrictEqual({
			iss: `${currentOrigin()}/t/acme`,
			aud: `${currentOrigin()}/t/acme`,
			atAcme: StatusCodes.OK,
			atBeta: StatusCodes.UNAUTHORIZED
		});
	});

	it('returns 503 for an admitted tenant whose Durable Object is unconfigured', async () => {
		await provisionNamedTenant('gamma', { configure: false });

		const jwks = await handlerFetch('/t/gamma/.well-known/jwks.json');
		const asMetadata = await handlerFetch(
			'/t/gamma/.well-known/oauth-authorization-server'
		);

		// Both the key set and the AS metadata route to the Durable Object, so an
		// unconfigured tenant advertises no identity at all rather than serving
		// edge-built metadata for an issuer it has not been assigned.
		expect({ jwks: jwks.status, asMetadata: asMetadata.status }).toStrictEqual({
			jwks: StatusCodes.SERVICE_UNAVAILABLE,
			asMetadata: StatusCodes.SERVICE_UNAVAILABLE
		});
	});

	it('stops reads to a suspended tenant once the manifest carries the status', async () => {
		// The harness configures and admits the fixture tenant active.
		const active = await handlerFetch(
			`/t/${fixtureTenant}/.well-known/jwks.json`
		);

		await suspendTenant(fixtureTenant);

		const suspended = await handlerFetch(
			`/t/${fixtureTenant}/.well-known/jwks.json`
		);

		expect({
			active: active.status,
			suspended: suspended.status
		}).toStrictEqual({
			active: StatusCodes.OK,
			suspended: StatusCodes.NOT_FOUND
		});
	});

	it('rejects an unprovisioned slug without instantiating a Durable Object', async () => {
		const response = await handlerFetch('/t/ghost/.well-known/jwks.json');

		expect(response.status).toBe(StatusCodes.NOT_FOUND);
	});

	it('dispatches a named tenant write to its Durable Object to authorise', async () => {
		await provisionNamedTenant('acme');

		// No token: the write is dispatched to the tenant's object, which rejects it as
		// unauthorised, rather than the Worker refusing every named write.
		const response = await handlerFetch('/t/acme/uploads', writeRequest());

		expect(response.status).toBe(StatusCodes.UNAUTHORIZED);
	});

	it('stops writes to a suspended fixture tenant on the authoritative D1 status', async () => {
		await suspendTenant(fixtureTenant);

		const response = await handlerFetch(
			`/t/${fixtureTenant}/uploads`,
			writeRequest()
		);

		expect(response.status).toBe(StatusCodes.FORBIDDEN);
	});
});
