import { type Logger } from '@cupboard/logger';
import {
	accessKeyIdOf,
	accessKeySecretSchema
} from '@cupboard/protocol/access-keys';

import {
	bearerCredential,
	type PresentedCredential
} from '../auth/credential.ts';
import {
	type Principal,
	tokenPrincipal,
	type VerifiedAccessKey
} from '../auth/principal.ts';
import { isConstantTimeEqual, sha256Hex } from '../crypto/crypto.ts';
import { InvalidAccessTokenError, UnauthenticatedError } from '../errors.ts';

import { type AccessKeyStore } from './access-key-store.ts';
import { type AuthKeysService } from './auth-keys-service.ts';
import { type OidcTrustService } from './oidc-trust-service.ts';

// A SHA-256 digest rendered as lower-case hexadecimal is 64 ASCII bytes.
const secretHashByteLength = 64;

/**
Verifies the credential that a request to the tenant object presents and
returns its principal. An access token must have a valid signature. An
access key must have an unexpired record whose secret hash matches, and an
enabled trust rule must still allow the key's root identity its grants.
*/
export class PrincipalAuthenticator {
	constructor(
		private readonly authKeys: AuthKeysService,
		private readonly accessKeys: AccessKeyStore,
		private readonly oidcTrust: OidcTrustService,
		private readonly now: () => Date = () => new Date()
	) {}

	/**
	Authenticates the Bearer credential of an admin, upload or commit
	request.
	*/
	authenticate(logger: Logger, request: Request): Promise<Principal> {
		const credential = bearerCredential(request);

		if (credential === undefined) {
			throw new UnauthenticatedError();
		}

		return this.authenticateCredential(logger, credential);
	}

	async authenticateCredential(
		logger: Logger,
		credential: PresentedCredential
	): Promise<Principal> {
		if (credential.kind === 'access-token') {
			return tokenPrincipal(
				await this.authKeys.authenticateToken(credential.token)
			);
		}

		return {
			kind: 'access-key',
			key: await this.verifyKey(logger, credential.secret)
		};
	}

	async verifyKey(logger: Logger, secret: string): Promise<VerifiedAccessKey> {
		const parsed = accessKeySecretSchema.safeParse(secret);

		if (!parsed.success) {
			throw new InvalidAccessTokenError();
		}

		// Revoking a session or a key deletes every key below it, so a key
		// whose record still exists has no revoked ancestor.
		const record = this.accessKeys.verifiable(
			accessKeyIdOf(parsed.data),
			this.now()
		);
		const presentedHash = await sha256Hex(parsed.data);

		if (
			record === undefined ||
			!(await isConstantTimeEqual(
				record.secretHash,
				presentedHash,
				secretHashByteLength
			))
		) {
			throw new InvalidAccessTokenError();
		}

		const selection = this.oidcTrust.currentSelection(
			logger,
			record.key.rootIdentity,
			record.key.grants
		);

		if (selection.outcome !== 'selected') {
			throw new InvalidAccessTokenError();
		}

		return record.key;
	}
}
