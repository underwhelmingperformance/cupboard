import { WorkerEntrypoint } from 'cloudflare:workers';

import { deploymentRuntimeEvidence } from './deployment-runtime.ts';

/**
 * Returns the control Worker's embedded deployment identity to an explicitly
 * bound service consumer. Production does not bind this entrypoint; the
 * persistent upgrade fixture uses Miniflare's direct test socket.
 */
export class ControlDeploymentRuntime extends WorkerEntrypoint<Env> {
	override async fetch(): Promise<Response> {
		return Response.json(await deploymentRuntimeEvidence(this.env), {
			headers: { 'cache-control': 'no-store' }
		});
	}
}
