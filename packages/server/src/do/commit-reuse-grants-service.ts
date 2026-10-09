import {
	type AuthorizationDetails,
	authorizationDetailsSchema
} from '@cupboard/protocol/grants';
import { type SessionId } from '@cupboard/protocol/upload';

import { armAlarmNoLaterThan } from './alarm.ts';
import { type CommitSessionAttachment } from './commit-credit-service.ts';
import { reuseGrants } from './reuse-authority.ts';

export const commitReuseGrantsPrefix = 'commit-reuse-grants:';
const cleanupPageSize = 128;

type SessionAuthority = Pick<
	CommitSessionAttachment,
	'sessionId' | 'authenticatedUntil' | 'reuseGrantsStored' | 'reuseGrants'
>;

function expiryPrefix(expiresAt: number): string {
	return `${commitReuseGrantsPrefix}${String(expiresAt).padStart(16, '0')}:`;
}

function sessionKey(sessionId: SessionId, expiresAt: number): string {
	return `${expiryPrefix(expiresAt)}${sessionId}`;
}

/**
 * Persists a commit session's read grants across hibernation without adding
 * them to its size-limited WebSocket attachment. Expiry-sorted keys let a
 * bounded cleanup remove expired records before any live records.
 */
export class CommitReuseGrantsService {
	constructor(private readonly storage: DurableObjectStorage) {}

	async save(
		sessionId: SessionId,
		expiresAt: number,
		grants: AuthorizationDetails
	): Promise<void> {
		await armAlarmNoLaterThan(this.storage, expiresAt);
		await this.storage.put(
			sessionKey(sessionId, expiresAt),
			reuseGrants(grants)
		);
	}

	async read(
		session: SessionAuthority,
		now: number
	): Promise<AuthorizationDetails> {
		if (session.reuseGrantsStored !== true) {
			return session.reuseGrants ?? [];
		}

		if (
			session.authenticatedUntil === undefined ||
			session.authenticatedUntil <= now
		) {
			return [];
		}

		const stored = await this.storage.get(
			sessionKey(session.sessionId, session.authenticatedUntil)
		);
		const parsed = authorizationDetailsSchema.safeParse(stored);

		return parsed.success ? parsed.data : [];
	}

	async clear(session: SessionAuthority): Promise<void> {
		if (
			session.reuseGrantsStored !== true ||
			session.authenticatedUntil === undefined
		) {
			return;
		}

		await this.storage.delete(
			sessionKey(session.sessionId, session.authenticatedUntil)
		);
	}

	async cleanupExpired(now: number): Promise<void> {
		const expired = await this.storage.list({
			prefix: commitReuseGrantsPrefix,
			end: `${expiryPrefix(now)}~`,
			limit: cleanupPageSize
		});

		if (expired.size > 0) {
			await this.storage.delete(expired.keys().toArray());
		}

		const remaining = await this.storage.list({
			prefix: commitReuseGrantsPrefix,
			limit: 1
		});
		const first = remaining.keys().next().value;

		if (first === undefined) {
			return;
		}

		const expiresAt = Number(
			first.slice(commitReuseGrantsPrefix.length).split(':', 1)[0]
		);
		await armAlarmNoLaterThan(this.storage, Math.max(now, expiresAt));
	}
}
