import { randomBytes } from 'node:crypto';

import type { CloudflareApi } from './cloudflare-api.ts';
import type { ScriptName } from './identifiers.ts';

export const controlDatabaseValidationSecretName =
	'CONTROL_DATABASE_VALIDATION_SECRET';

interface ValidationOptions {
	readonly api: Pick<CloudflareApi, 'putSecret'>;
	readonly cleanupApi: Pick<CloudflareApi, 'deleteSecret'>;
	readonly scriptName: ScriptName;
	readonly validate: (secret: string) => Promise<unknown>;
}

/**
Validates copied keys with a temporary control-only deployment secret.
*/
export async function validateTransferredControlDatabase(
	options: ValidationOptions
): Promise<void> {
	const secret = randomBytes(32).toString('base64url');
	await options.api.putSecret(options.scriptName, {
		name: controlDatabaseValidationSecretName,
		text: secret
	});
	try {
		await options.validate(secret);
	} finally {
		await options.cleanupApi.deleteSecret(
			options.scriptName,
			controlDatabaseValidationSecretName
		);
	}
}
