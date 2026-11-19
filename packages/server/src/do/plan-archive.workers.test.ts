import { tenantIdSchema } from '@cupboard/nix-store/scalars';
import { githubActionsIssuer, oidcIssuerSchema } from '@cupboard/protocol/oidc';
import { runInDurableObject } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';

import { planArchiveIdentities } from '../db/schema.ts';
import { InvalidPlanArchiveTicketError } from '../errors.ts';
import {
	currentServer,
	latestMigrationIndex,
	migrateThrough,
	resetTestServer,
	underOneUnitOfWork
} from '../test-support.ts';

import { phaseStepSize } from './garbage-collection-service.ts';
import { PlanArchiveStore } from './plan-archive-store.ts';
import { gcContinuationKey } from './server.ts';

beforeEach(resetTestServer);

const binding = {
	tenant: tenantIdSchema.parse('acme'),
	tenantIssuer: oidcIssuerSchema.parse('https://cupboard.test/t/acme'),
	issuer: githubActionsIssuer,
	owner: '111',
	repository: '222',
	run: '333',
	workflow: 'acme/publish/.github/workflows/publish.yml@refs/heads/main',
	revision: 'a'.repeat(40),
	cache: 'ci'
};

it.each(['redemption', 'maintenance'] as const)(
	'erases expired identities during %s',
	async (operation) => {
		await runInDurableObject(currentServer(), async (instance, state) => {
			await migrateThrough(state, latestMigrationIndex);
			let now = Date.parse('2001-01-01T00:00:00Z');
			const store = new PlanArchiveStore(instance.context.db, () => now);
			const archive = store.issue(binding);
			const live = instance.context.planArchives.issue(binding);
			expect(live.recipient).not.toBe(archive.recipient);
			const expiry = now + 24 * 60 * 60 * 1000;
			const { cache, ...rest } = binding;
			expect(store.redeem({ cache, ...rest }, archive.ticket)).toStrictEqual(
				store.redeem(binding, archive.ticket)
			);
			expect(() =>
				store.redeem(
					{ ...binding, issuer: githubActionsIssuer + '/other' },
					archive.ticket
				)
			).toThrow(InvalidPlanArchiveTicketError);
			const other = { ...binding, tenant: tenantIdSchema.parse('other') };
			expect(() => store.redeem(other, archive.ticket)).toThrow(
				InvalidPlanArchiveTicketError
			);
			now = expiry - 1;
			expect(store.redeem(binding, archive.ticket).identity).toMatch(
				/^AGE-SECRET-KEY-/u
			);
			now = expiry;
			if (operation === 'maintenance') {
				await underOneUnitOfWork(() => instance.runGarbageCollection());
				await state.storage.deleteAlarm();
			} else {
				expect(() => store.redeem(binding, archive.ticket)).toThrow(
					InvalidPlanArchiveTicketError
				);
			}
			expect(
				instance.context.db
					.select({ ticket: planArchiveIdentities.ticket })
					.from(planArchiveIdentities)
					.all()
			).toStrictEqual([{ ticket: live.ticket }]);
			now = expiry - 1;
			expect(() => store.redeem(binding, archive.ticket)).toThrow(
				InvalidPlanArchiveTicketError
			);
		});
	}
);

it('schedules expiry after an empty lookup and after the object restarts', async () => {
	await runInDurableObject(currentServer(), async (instance, state) => {
		await migrateThrough(state, latestMigrationIndex);
		const now = Date.parse('2001-01-01T00:00:00Z');
		const store = new PlanArchiveStore(instance.context.db, () => now);
		expect(store.earliestExpiry()).toBeUndefined();
		instance.context.db.transaction((tx) => store.issue(binding, tx));
		expect([
			store.earliestExpiry(),
			new PlanArchiveStore(instance.context.db).earliestExpiry()
		]).toStrictEqual(['2001-01-02T00:00:00.000Z', '2001-01-02T00:00:00.000Z']);
	});
});

it('continues collection when a page of expired identities is full', async () => {
	await runInDurableObject(currentServer(), async (instance, state) => {
		await migrateThrough(state, latestMigrationIndex);
		const database = instance.context.db;
		for (let index = 0; index < phaseStepSize; index++) {
			instance.context.planArchives.issue(binding);
		}
		state.storage.sql.exec(
			"UPDATE plan_archive_identity SET expires_at = '2001-01-01T00:00:00.000Z'"
		);
		const last = instance.context.planArchives.issue(binding);
		state.storage.sql.exec(
			"UPDATE plan_archive_identity SET expires_at = '2001-01-02T00:00:00.000Z' WHERE ticket = ?",
			last.ticket
		);
		await underOneUnitOfWork(() => instance.runGarbageCollection());
		const remaining = database
			.select({ ticket: planArchiveIdentities.ticket })
			.from(planArchiveIdentities)
			.all();
		expect({
			remaining,
			continuation: await state.storage.get(gcContinuationKey),
			armed: (await state.storage.getAlarm()) !== null
		}).toStrictEqual({
			remaining: [{ ticket: last.ticket }],
			continuation: [{ scope: 'tenant' }],
			armed: true
		});
		await state.storage.deleteAlarm();
		await underOneUnitOfWork(() => instance.runGarbageCollection());
		expect(database.select().from(planArchiveIdentities).all()).toStrictEqual(
			[]
		);
	});
});
