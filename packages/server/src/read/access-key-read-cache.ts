import { type TenantId } from '@cupboard/nix-store/scalars';
import {
	accessKeyIdOf,
	accessKeySecretSchema
} from '@cupboard/protocol/access-keys';
import { type AuthorizationDetails } from '@cupboard/protocol/grants';

import { isConstantTimeEqual, sha256Hex } from '../crypto/crypto.ts';

/**
The parts of a verified access key that the Worker needs to decide a read:
the hash of its secret, its grants and its expiry in milliseconds since the
epoch, when it has one.
*/
export interface ReadableAccessKey {
	readonly secretHash: string;
	readonly grants: AuthorizationDetails;
	readonly expiresAtMs?: number;
}

interface CachedAccessKey {
	readonly key: ReadableAccessKey;
	readonly cachedAtMs: number;
}

interface PendingVerification {
	readonly secret: string;
	readonly result: Promise<ReadableAccessKey | undefined>;
}

// A SHA-256 digest rendered as lower-case hexadecimal is 64 ASCII bytes.
const secretHashByteLength = 64;

/**
How long the Worker relies on a verification by the tenant object. Deleting
a key, or changing the trust rule that allows it, takes effect on the read
routes within this time.
*/
export const accessKeyReadCacheLifetimeMs = 5 * 60 * 1000;

/**
The most keys that one isolate remembers. The oldest entry is dropped first.
*/
export const accessKeyReadCacheEntries = 1000;

/**
Remembers the access keys that the tenant object has verified for the read
routes, in the memory of one isolate. Only verified keys are stored, keyed
by tenant and key id, and every hit compares the hash of the presented
secret with the stored hash. A refusal is never stored: someone who knows a
key's id but not its secret could otherwise store a refusal under that id
and lock out the key's holder.

Concurrent misses that present the same secret share one verification. A
lookup with a different secret starts its own, so a wrong secret cannot make
a concurrent lookup with the right one fail.
*/
export class AccessKeyReadCache {
	readonly #entries = new Map<string, CachedAccessKey>();
	readonly #pending = new Map<string, PendingVerification>();

	constructor(
		private readonly nowMs: () => number = Date.now,
		private readonly lifetimeMs: number = accessKeyReadCacheLifetimeMs,
		private readonly maxEntries: number = accessKeyReadCacheEntries
	) {}

	private isFresh(cached: CachedAccessKey, now: number): boolean {
		return (
			now - cached.cachedAtMs < this.lifetimeMs &&
			(cached.key.expiresAtMs === undefined || now < cached.key.expiresAtMs)
		);
	}

	private store(entryKey: string, entry: CachedAccessKey): void {
		if (this.#entries.size >= this.maxEntries) {
			const oldest = this.#entries.keys().next();

			if (oldest.done !== true) {
				this.#entries.delete(oldest.value);
			}
		}

		this.#entries.set(entryKey, entry);
	}

	/**
	Returns the grants of the key that `secret` presents, or undefined when
	the secret is not a valid key. `verify` asks the tenant object on a
	miss.
	*/
	async grantsFor(
		tenant: TenantId,
		secret: string,
		verify: (secret: string) => Promise<ReadableAccessKey | undefined>
	): Promise<AuthorizationDetails | undefined> {
		const parsed = accessKeySecretSchema.safeParse(secret);

		if (!parsed.success) {
			return undefined;
		}

		const entryKey = `${tenant}/${accessKeyIdOf(parsed.data)}`;
		const now = this.nowMs();
		const cached = this.#entries.get(entryKey);

		if (cached !== undefined && this.isFresh(cached, now)) {
			const presentedHash = await sha256Hex(parsed.data);

			return (await isConstantTimeEqual(
				cached.key.secretHash,
				presentedHash,
				secretHashByteLength
			))
				? cached.key.grants
				: undefined;
		}

		const pending = this.#pending.get(entryKey);

		if (pending !== undefined && isSameSecret(pending.secret, parsed.data)) {
			const shared = await pending.result;

			return shared?.grants;
		}

		this.#entries.delete(entryKey);
		const verification: PendingVerification = {
			secret: parsed.data,
			result: verify(parsed.data)
		};
		this.#pending.set(entryKey, verification);
		let verified: ReadableAccessKey | undefined;

		try {
			verified = await verification.result;
		} finally {
			if (this.#pending.get(entryKey) === verification) {
				this.#pending.delete(entryKey);
			}
		}

		if (verified === undefined) {
			return undefined;
		}

		this.store(entryKey, { key: verified, cachedAtMs: now });

		return verified.grants;
	}
}

// Compares two secrets in time that depends only on their length. Access key
// secrets have a fixed length, and the comparison runs before any await so
// that a concurrent lookup always finds the pending verification.
function isSameSecret(left: string, right: string): boolean {
	if (left.length !== right.length) {
		return false;
	}

	let difference = 0;

	for (let index = 0; index < left.length; index++) {
		difference |=
			(left.codePointAt(index) ?? 0) ^ (right.codePointAt(index) ?? 0);
	}

	return difference === 0;
}
