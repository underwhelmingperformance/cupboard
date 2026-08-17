import { env } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import { refreshTenantMembership } from '../control/tenant-membership.ts';
import {
	handlerFetch,
	provisionNamedTenant,
	resetTestServer,
	suspendTenant
} from '../test-support.ts';

// On the configured S3 host the front worker maps the first path segment to a
// tenant, admits and write-gates it, then hands the request to the tenant's S3
// endpoint. Every failure is rendered as an S3 XML error so a client (rclone, the
// AWS CLI) sees a protocol response rather than the plain-text tenant 404.
const s3Host = 's3.test';

function s3Request(path: string, init?: RequestInit): Promise<Response> {
	return handlerFetch(`https://${s3Host}/${path}`, init, { S3_HOST: s3Host });
}

describe('S3 host routing', () => {
	beforeEach(resetTestServer);

	it('refuses plaintext outside local development', async () => {
		const response = await handlerFetch(
			`http://${s3Host}/acme/nix-cache-info`,
			undefined,
			{
				S3_HOST: s3Host
			}
		);

		const body = await response.text();
		expect({
			status: response.status,
			hasAccessDenied: body.includes('<Code>AccessDenied</Code>')
		}).toStrictEqual({
			status: StatusCodes.FORBIDDEN,
			hasAccessDenied: true
		});
	});

	it('allows plaintext when local development is explicitly enabled', async () => {
		await provisionNamedTenant('acme');

		const response = await handlerFetch(
			`http://${s3Host}/acme/nix-cache-info`,
			undefined,
			{ S3_HOST: s3Host, CUPBOARD_LOCAL_DEV: 'true' }
		);

		expect(response.status).toBe(StatusCodes.OK);
		expect(await response.text()).toContain('StoreDir');
	});

	it('dispatches an anonymous read on a public bucket to the S3 endpoint', async () => {
		await provisionNamedTenant('acme');

		const response = await s3Request('acme/nix-cache-info');

		expect(response.status).toBe(StatusCodes.OK);
		expect(await response.text()).toContain('StoreDir');
	});

	it.each([
		{ method: 'HEAD', path: 'acme' },
		{ method: 'GET', path: 'acme?location' }
	])(
		'rejects an anonymous $method bucket probe for a private tenant',
		async ({ method, path }) => {
			await provisionNamedTenant('acme', { readMode: 'private' });

			const response = await s3Request(path, { method });

			const body = await response.text();
			expect({
				status: response.status,
				isEmpty: body === '',
				hasAccessDenied: body.includes('<Code>AccessDenied</Code>')
			}).toStrictEqual({
				status: StatusCodes.FORBIDDEN,
				isEmpty: method === 'HEAD',
				hasAccessDenied: method !== 'HEAD'
			});
		}
	);

	it('renders NoSuchBucket for an unprovisioned bucket', async () => {
		const response = await s3Request('ghost/nix-cache-info');

		expect(response.status).toBe(StatusCodes.NOT_FOUND);
		expect(await response.text()).toContain('<Code>NoSuchBucket</Code>');
	});

	it('renders NoSuchBucket for a malformed bucket name', async () => {
		const response = await s3Request('NOT-A-SLUG/nix-cache-info');

		expect(response.status).toBe(StatusCodes.NOT_FOUND);
		expect(await response.text()).toContain('<Code>NoSuchBucket</Code>');
	});

	it('refuses a write to a non-active tenant with an S3 error', async () => {
		await provisionNamedTenant('acme');
		await suspendTenant('acme');

		const response = await s3Request('acme/abc.narinfo', {
			method: 'PUT',
			body: 'x'
		});

		expect(response.status).toBe(StatusCodes.FORBIDDEN);
		expect(await response.text()).toContain('<Code>AccessDenied</Code>');
	});

	it('rejects an unsigned control request before parsing its body', async () => {
		await provisionNamedTenant('acme');

		const response = await s3Request('acme?delete', {
			method: 'POST',
			body: '<not-well-formed'
		});

		expect(response.status).toBe(StatusCodes.FORBIDDEN);
		expect(await response.text()).toContain('<Code>AccessDenied</Code>');
	});

	it('renders NoSuchBucket for a read on a non-active tenant', async () => {
		await provisionNamedTenant('acme');
		await suspendTenant('acme');
		await refreshTenantMembership(env);

		const response = await s3Request('acme/nix-cache-info');

		expect(response.status).toBe(StatusCodes.NOT_FOUND);
		expect(await response.text()).toContain('<Code>NoSuchBucket</Code>');
	});

	// `x-cupboard-s3` is reserved for requests routed through the configured S3
	// host. Normal tenant dispatch removes any client-supplied value, so clients
	// cannot use it to bypass the native read gate.
	it('ignores a forged S3 marker on the normal tenant host', async () => {
		await provisionNamedTenant('acme', { readMode: 'private' });

		const response = await handlerFetch('/t/acme/acme/nix-cache-info', {
			headers: { 'x-cupboard-s3': '1' }
		});

		expect(response.status).toBe(StatusCodes.NOT_FOUND);
		expect(await response.text()).not.toContain('StoreDir');
	});
});
