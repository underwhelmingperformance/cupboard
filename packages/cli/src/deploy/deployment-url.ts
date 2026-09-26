import { z } from 'zod';

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
 * URL. The deploy and `cupboard login` use that URL, so the admin's tokens are
 * issued for it. The control Worker does not read the variable.
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
	text: z.url({ protocol: /^https?$/ })
});

/**
 * The deployment URL that the last deploy recorded in the control Worker's
 * bindings. Undefined for a Worker that an earlier release deployed.
 */
export function recordedDeploymentUrl(
	bindings: readonly unknown[]
): URL | undefined {
	for (const binding of bindings) {
		const parsed = recordedUrlBindingSchema.safeParse(binding);

		if (parsed.success) {
			return new URL(parsed.data.text);
		}
	}

	return undefined;
}
