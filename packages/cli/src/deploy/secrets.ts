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
 * The secrets each Worker needs, ready to apply. The control plane holds the
 * signing-key wrapping secret; the tenant Durable Object holds the R2
 * credentials its presigner uses (see `packages/server/src/do/context.ts`).
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

/**
 * Assemble the per-Worker secrets from the environment and the resolved
 * deployment facts. `R2_ACCOUNT_ID` and `R2_BUCKET_NAME` are derived; the
 * sensitive values come from the environment. Names whose required value is
 * absent are returned in `missing` so the caller can warn rather than deploy a
 * cache that cannot run.
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

	return { secrets: { control, tenant }, missing };
}
