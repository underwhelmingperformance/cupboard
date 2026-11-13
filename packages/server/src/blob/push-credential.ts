import {
	type TenantId,
	type TtlSeconds,
	ttlSecondsSchema
} from '@cupboard/nix-store/scalars';
import { publicationPushPrefix } from '@cupboard/protocol/publication';
import type { PushCredentialInput, PushId } from '@cupboard/protocol/upload';

import {
	InvalidAccessTokenError,
	InvalidPushIdError,
	PushIdSigningKeyMissingError
} from '../errors.ts';
import { stagingPushPrefix } from '../http/http.ts';

import type { R2PresignerConfiguration } from './presign.ts';
import {
	createPushId,
	hasSecondPushIdExpiry,
	importPushIdKey,
	isPushIdIssuedTo,
	isPushIdValid,
	pushIdExpiresAtMilliseconds,
	type PushIdSigningKey,
	pushIdSigningKeySchema
} from './push-id.ts';
import {
	createR2TemporaryCredentials,
	pushUploadActions,
	r2CredentialTtlSecondsSchema
} from './temporary-credentials.ts';

export const pushCredentialMaxTtlSeconds = 6 * 60 * 60;
// A push ID stays valid for one day, longer than the six-hour credential, so a
// fresh access token can renew the credential for the same staging prefixes.
// R2 removes legacy staged bytes after one day. The seven-day lifecycle rule
// for publication staging relies on this push ID expiry and the 24-hour
// recovery window. A client can stage bytes early in the push and first submit
// the publication just before the push expires, so the recovery window can end
// almost 48 hours after the first staging write. `firstRemovalAfterPushStart`
// subtracts this value from a push ID's expiry to find when the push started.
// Changing it gives every push ID issued under the old value a wrong start
// until the push ID expires.
const pushIdTtlSeconds = 24 * 60 * 60;

/**
The earliest cache removal time that counts as a removal after the push
started. Every push ID expires `pushIdTtlSeconds` after it is issued, and a
replacement credential keeps the push ID. A v3 push ID gives the issue time
in milliseconds, and a removal in the same millisecond counts as a removal
before the push started. A v2 push ID gives whole seconds, so a removal in
its issue second counts as a removal after the push started. Undefined for a
value without a push ID layout.
*/
export function firstRemovalAfterPushStart(pushId: PushId): Date | undefined {
	const expiresAtMilliseconds = pushIdExpiresAtMilliseconds(pushId);
	if (expiresAtMilliseconds === undefined) {
		return undefined;
	}

	const issuedAtMilliseconds = expiresAtMilliseconds - pushIdTtlSeconds * 1000;

	return new Date(
		hasSecondPushIdExpiry(pushId)
			? issuedAtMilliseconds
			: issuedAtMilliseconds + 1
	);
}

/**
Returns the access token's remaining whole seconds, capped at six hours.
Rejects a token that has no remaining lifetime.
*/
export function pushCredentialTtlSeconds(
	tokenExpiresAt: Date,
	now: Date
): TtlSeconds {
	const remaining = Math.floor(
		(tokenExpiresAt.getTime() - now.getTime()) / 1000
	);

	if (remaining <= 0) {
		throw new InvalidAccessTokenError();
	}

	return ttlSecondsSchema.parse(
		Math.min(pushCredentialMaxTtlSeconds, remaining)
	);
}

export interface PushIdSigningEnv {
	readonly PUSH_ID_SIGNING_KEY: string | undefined;
}

export function pushIdSigningKey(env: PushIdSigningEnv): PushIdSigningKey {
	const key = env.PUSH_ID_SIGNING_KEY ?? '';

	if (key === '') {
		throw new PushIdSigningKeyMissingError();
	}

	return pushIdSigningKeySchema.parse(key);
}

/**
Issues R2 credentials that can write only to one push's staging prefix. The
signed push ID lets negotiation verify the tenant, expiry, and prefix without
storing per-push state.
*/
export class PushCredentialIssuer {
	private hmacKey: Promise<CryptoKey> | undefined;

	// Read the R2 configuration only when issuing a credential. Negotiation can
	// then verify a push ID when R2 credentials are not configured.
	constructor(
		private readonly configuration: () => R2PresignerConfiguration,
		private readonly signingKey: PushIdSigningKey,
		private readonly tenant: TenantId
	) {}

	// A renewed credential uses the existing push ID so it retains access to
	// bytes already staged for that push.
	async issueFor(
		pushId: PushId,
		ttlSeconds: TtlSeconds,
		now: Date,
		hasPublication = false
	): Promise<PushCredentialInput> {
		const expiresAtMilliseconds = pushIdExpiresAtMilliseconds(pushId);

		if (
			expiresAtMilliseconds === undefined ||
			!(await this.verify(pushId, now))
		) {
			throw new InvalidPushIdError();
		}

		const remainingSeconds = Math.floor(
			(expiresAtMilliseconds - now.getTime()) / 1000
		);
		if (remainingSeconds < 1) {
			throw new InvalidPushIdError();
		}

		const boundedTtl = ttlSecondsSchema.parse(
			Math.min(ttlSeconds, remainingSeconds)
		);

		// R2 rejects credentials that contain both scope and actions. Use the
		// write-only action set with this push's staging prefix.
		const credential = await createR2TemporaryCredentials(
			this.configuration(),
			{
				actions: pushUploadActions,
				prefixPaths: [
					stagingPushPrefix(pushId),
					...(hasPublication
						? [publicationPushPrefix(this.tenant, pushId)]
						: [])
				],
				ttlSeconds: r2CredentialTtlSecondsSchema.parse(boundedTtl)
			},
			now
		);

		return { pushId, ...credential };
	}

	async issue(
		ttlSeconds: TtlSeconds,
		now: Date,
		hasPublication = false
	): Promise<PushCredentialInput> {
		const expiresAtMilliseconds = now.getTime() + pushIdTtlSeconds * 1000;

		return this.issueFor(
			await createPushId(this.signingKey, this.tenant, expiresAtMilliseconds),
			ttlSeconds,
			now,
			hasPublication
		);
	}

	verify(pushId: PushId, now = new Date()): Promise<boolean> {
		return isPushIdValid(this.signingKey, pushId, this.tenant, now);
	}

	async isIssuedToTenant(pushId: PushId): Promise<boolean> {
		this.hmacKey ??= importPushIdKey(this.signingKey);

		return isPushIdIssuedTo(await this.hmacKey, pushId, this.tenant);
	}
}
