import { z } from 'zod';

import { CliError } from '../errors.ts';

import type { CloudflareApi } from './cloudflare-api.ts';
import type { DeploymentConfig } from './config.ts';
import type { ScriptName } from './identifiers.ts';

/**
 * The deployment's URL: the custom domain, or the script's workers.dev
 * hostname when the account has a workers.dev subdomain. This function only
 * reads the subdomain. Onboarding enables the workers.dev route.
 */
export async function deploymentUrl(
	api: Pick<CloudflareApi, 'getWorkersDevSubdomain'>,
	controlScriptName: ScriptName,
	domain: string | undefined
): Promise<string | undefined> {
	if (domain !== undefined) {
		return `https://${domain}`;
	}

	const subdomain = await api.getWorkersDevSubdomain();

	return subdomain === undefined
		? undefined
		: `https://${controlScriptName}.${subdomain}.workers.dev`;
}

/**
 * The control Worker variable in which each deploy records the deployment's
 * URL. The deploy checks admin tokens against that URL and requests it as the
 * default CI audience. The control Worker does not read the variable.
 */
export const deploymentUrlVariable = 'CUPBOARD_DEPLOYMENT_URL';

/**
 * Records `url` as the deployment's URL on the control Worker. The config is
 * unchanged when the deployment has no URL.
 */
export function withDeploymentUrl(
	config: DeploymentConfig,
	url: string | undefined
): DeploymentConfig {
	if (url === undefined) {
		return config;
	}

	return {
		...config,
		control: {
			...config.control,
			vars: { ...config.control.vars, [deploymentUrlVariable]: url }
		}
	};
}

const recordedUrlBindingSchema = z.looseObject({
	type: z.literal('plain_text'),
	name: z.literal(deploymentUrlVariable),
	text: z.string()
});

const recordedUrlSchema = z.url({ protocol: /^https$/ });

/**
 * The control Worker records a deployment URL that is not an HTTPS URL. The
 * deploy sends admin credentials to that URL, so it refuses the value.
 */
export class RecordedDeploymentUrlInvalidError extends CliError {
	constructor(public readonly value: string) {
		super(
			`The control Worker records ${deploymentUrlVariable} as ` +
				`${JSON.stringify(value)}, which is not an HTTPS URL. Set it to the ` +
				"deployment's URL, or remove it, in the control Worker's settings in " +
				'the Cloudflare dashboard, then re-run `cupboard init`. Nothing was ' +
				'changed.'
		);
		this.name = 'RecordedDeploymentUrlInvalidError';
	}
}

/**
 * The deployment URL that the last deploy recorded in the control Worker's
 * bindings. Undefined for a Worker that an earlier release deployed.
 */
export function recordedDeploymentUrl(
	bindings: readonly unknown[]
): URL | undefined {
	for (const binding of bindings) {
		const parsed = recordedUrlBindingSchema.safeParse(binding);

		if (!parsed.success) {
			continue;
		}

		const url = recordedUrlSchema.safeParse(parsed.data.text);

		if (!url.success) {
			throw new RecordedDeploymentUrlInvalidError(parsed.data.text);
		}

		return new URL(url.data);
	}

	return undefined;
}
