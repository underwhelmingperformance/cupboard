import { bytesToHex } from '@cupboard/nix-store/encoding';
import { isDeepEqual } from '@cupboard/protocol/deep-equal';
import type {
	PlanArchiveIdentity,
	PlanArchiveRecipient
} from '@cupboard/protocol/plan-archive';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import { x25519 } from '@noble/curves/ed25519.js';
import { bech32 } from '@scure/base';
import { eq, inArray, lte } from 'drizzle-orm';

import { type PlanArchiveBinding } from '../auth/plan-archive.ts';
import { planArchiveIdentities } from '../db/schema.ts';
import { InvalidPlanArchiveTicketError } from '../errors.ts';

import { type SchemaWriter } from './context.ts';

const lifetimeMs = 24 * 60 * 60 * 1000;

/**
Stores a separate random age identity for each archive until its ticket expires.
*/
export class PlanArchiveStore {
	private isKnownEmpty = false;

	constructor(
		private readonly database: SchemaWriter,
		private readonly now: () => number = Date.now
	) {}

	earliestExpiry(): IsoTimestamp | undefined {
		if (this.isKnownEmpty) {
			return undefined;
		}
		const expiry = this.database
			.select({ at: planArchiveIdentities.expiresAt })
			.from(planArchiveIdentities)
			.orderBy(planArchiveIdentities.expiresAt)
			.limit(1)
			.get()?.at;
		this.isKnownEmpty = expiry === undefined;
		return expiry;
	}

	deleteExpired(now: IsoTimestamp, limit: number): boolean {
		const earliest = this.earliestExpiry();
		if (earliest === undefined || earliest > now) {
			return false;
		}
		const due = this.database
			.select({ ticket: planArchiveIdentities.ticket })
			.from(planArchiveIdentities)
			.where(lte(planArchiveIdentities.expiresAt, now))
			.orderBy(planArchiveIdentities.expiresAt)
			.limit(limit);
		return (
			this.database
				.delete(planArchiveIdentities)
				.where(inArray(planArchiveIdentities.ticket, due))
				.returning({ ticket: planArchiveIdentities.ticket })
				.all().length === limit
		);
	}

	issue(
		binding: PlanArchiveBinding,
		transaction: SchemaWriter = this.database
	): PlanArchiveRecipient {
		const expiry = this.now() + lifetimeMs;
		const ticket =
			'v1.' + bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
		const secret = x25519.utils.randomSecretKey();
		const identity = bech32
			.encodeFromBytes('age-secret-key-', secret)
			.toUpperCase();
		const recipient = bech32.encodeFromBytes(
			'age',
			x25519.getPublicKey(secret)
		);
		transaction
			.insert(planArchiveIdentities)
			.values({
				ticket,
				identity,
				binding: JSON.stringify(binding),
				expiresAt: isoTimestamp(new Date(expiry))
			})
			.run();
		this.isKnownEmpty = false;
		return { ticket, recipient };
	}

	redeem(binding: PlanArchiveBinding, ticket: string): PlanArchiveIdentity {
		const where = eq(planArchiveIdentities.ticket, ticket);
		const row = this.database
			.select({
				identity: planArchiveIdentities.identity,
				binding: planArchiveIdentities.binding,
				expiresAt: planArchiveIdentities.expiresAt
			})
			.from(planArchiveIdentities)
			.where(where)
			.get();
		if (!row || !isDeepEqual(JSON.parse(row.binding), binding)) {
			throw new InvalidPlanArchiveTicketError();
		}
		if (Date.parse(row.expiresAt) <= this.now()) {
			this.database.delete(planArchiveIdentities).where(where).run();
			throw new InvalidPlanArchiveTicketError();
		}
		return { identity: row.identity };
	}
}
