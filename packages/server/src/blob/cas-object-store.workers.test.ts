import { sha256HexDigestSchema } from '@cupboard/nix-store/scalars';
import { env } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/d1';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import { sha256HexBytes } from '../crypto/crypto.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { casObjectKey } from '../http/http.ts';
import {
	clearBlobStorage,
	initialiseViaWorker,
	readFetch,
	resetTestServer,
	tenantCasBlobRows
} from '../test-support.ts';

import { CasObjectStore } from './cas-object-store.ts';

describe('shared CAS objects', () => {
	beforeEach(async () => {
		await resetTestServer();
		await clearBlobStorage();
	});

	it('reuses measured bytes without granting cache read authority or charging a tenant', async () => {
		await initialiseViaWorker();
		const bytes = new TextEncoder().encode('derived metadata');
		const digest = sha256HexDigestSchema.parse(await sha256HexBytes(bytes));
		const store = new CasObjectStore(
			drizzle(env.CUPBOARD_DB, { schema: d1Schema }),
			env.BLOBS
		);
		const measured = { digest, size: bytes.byteLength, bytes };
		const incarnation = await store.promote(measured);
		const reused = await store.promote(measured);
		const object = await env.BLOBS.get(casObjectKey(digest, incarnation));
		const stored =
			object === null ? undefined : new Uint8Array(await object.arrayBuffer());
		const response = await readFetch(`/attestation-bundles/${digest}`);
		expect({
			incarnation,
			reused,
			canReference: await store.reuse(digest, incarnation),
			canReferenceOtherIncarnation: await store.reuse(digest, incarnation + 1),
			stored,
			readStatus: response.status,
			chargedTenants: await tenantCasBlobRows()
		}).toStrictEqual({
			incarnation: 2,
			reused: 2,
			canReference: true,
			canReferenceOtherIncarnation: false,
			stored: bytes,
			readStatus: StatusCodes.NOT_FOUND,
			chargedTenants: []
		});
	});
});
