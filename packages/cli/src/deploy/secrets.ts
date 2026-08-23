import { randomBytes } from 'node:crypto';

import type { WorkerSecret } from './cloudflare-api.ts';

/**
 * Generate a fresh `CONTROL_KEY_WRAP_SECRET`: a base64 AES-256 key. Used on a
 * first deploy when the operator has not supplied one. It must stay stable
 * afterwards, as a different value cannot unwrap the existing control key.
 */
export function generateWrapSecret(): string {
	return randomBytes(32).toString('base64');
}

/**
 * Generate a fresh `PUSH_ID_SIGNING_KEY`: a high-entropy base64 secret. Used on
 * a first deploy when the operator has not supplied one. It must stay stable
 * afterwards, as a different value invalidates in-flight push ids.
 */
export function generatePushIdSigningKey(): string {
	return randomBytes(32).toString('base64');
}

/**
 * The secrets each Worker needs, ready to apply. The control plane holds the
 * signing-key wrapping secret; the tenant Durable Object holds the R2
 * credentials its presigner uses (see `packages/server/src/do/context.ts`).
 * The push id signing key goes to both Workers: the tenant object issues and
 * verifies push ids with it, and the front Worker verifies them to gate its
 * pre-auth negotiate hint reads.
 */
export interface DeploySecrets {
	readonly control: readonly WorkerSecret[];
	readonly tenant: readonly WorkerSecret[];
}

export interface SecretInputs {
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly accountId: string;
	readonly bucketName: string;
}

export interface AssembledSecrets {
	readonly secrets: DeploySecrets;
	readonly missing: readonly string[];
}

const requiredControl = ['CONTROL_KEY_WRAP_SECRET'];
const optionalControl = ['CUPBOARD_SIGNUP_SECRET'];
const requiredTenantR2 = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
const requiredShared = ['PUSH_ID_SIGNING_KEY'];

/**
 * Both Workers must use the same push-ID signing key, but a deployed secret
 * cannot be read back. Keep the existing key when both Workers have one,
 * generate the first key when neither does, and rotate both Workers when only
 * one has a key. Rotation invalidates in-flight push IDs, so those pushes must
 * be run again.
 */
export type PushIdKeySettlement = 'keep' | 'generate' | 'rotate';

export function settlePushIdSigningKey(existing: {
	readonly control: readonly string[];
	readonly tenant: readonly string[];
}): PushIdKeySettlement {
	const isOnControl = existing.control.includes('PUSH_ID_SIGNING_KEY');
	const isOnTenant = existing.tenant.includes('PUSH_ID_SIGNING_KEY');

	if (isOnControl && isOnTenant) {
		return 'keep';
	}

	return isOnControl || isOnTenant ? 'rotate' : 'generate';
}

/**
 * Assemble the per-Worker secrets from the environment and the resolved
 * deployment facts. `R2_ACCOUNT_ID` and `R2_BUCKET_NAME` are derived; the
 * sensitive values come from the environment. Names whose required value is
 * absent are returned in `missing` so the caller can warn before deploying a
 * cache that would fail to start.
 */
export function assembleSecrets(inputs: SecretInputs): AssembledSecrets {
	const missing: string[] = [];

	const fromEnv = (name: string): string | undefined => {
		const value = inputs.env[name];

		return value === undefined || value === '' ? undefined : value;
	};

	const control: WorkerSecret[] = [];

	for (const name of requiredControl) {
		const text = fromEnv(name);

		if (text === undefined) {
			missing.push(name);
		} else {
			control.push({ name, text });
		}
	}

	for (const name of optionalControl) {
		const text = fromEnv(name);

		if (text !== undefined) {
			control.push({ name, text });
		}
	}

	const tenant: WorkerSecret[] = [
		{ name: 'R2_ACCOUNT_ID', text: inputs.accountId },
		{ name: 'R2_BUCKET_NAME', text: inputs.bucketName }
	];

	for (const name of requiredTenantR2) {
		const text = fromEnv(name);

		if (text === undefined) {
			missing.push(name);
		} else {
			tenant.push({ name, text });
		}
	}

	for (const name of requiredShared) {
		const text = fromEnv(name);

		if (text === undefined) {
			missing.push(name);
		} else {
			control.push({ name, text });
			tenant.push({ name, text });
		}
	}

	return { secrets: { control, tenant }, missing };
}
