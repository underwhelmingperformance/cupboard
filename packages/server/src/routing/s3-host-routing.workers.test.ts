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

	it('dispatches an anonymous read on a public bucket to the S3 endpoint', async () => {
		await provisionNamedTenant('acme');

		const response = await s3Request('acme/nix-cache-info');

		expect(response.status).toBe(StatusCodes.OK);
		expect(await response.text()).toContain('StoreDir');
	});

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

	it('renders NoSuchBucket for a read on a non-active tenant', async () => {
		await provisionNamedTenant('acme');
		await suspendTenant('acme');
		await refreshTenantMembership(env);

		const response = await s3Request('acme/nix-cache-info');

		expect(response.status).toBe(StatusCodes.NOT_FOUND);
		expect(await response.text()).toContain('<Code>NoSuchBucket</Code>');
	});
});
