// Shared descriptions for the `<url>` argument, so every command names the URL
// form it actually accepts. Tenant routes live under `/t/<slug>`; the bare host
// is the deployment and its control plane.

export const tenantUrlArgument =
	'tenant URL (e.g. https://cupboard.example.workers.dev/t/<slug>)';

export const deploymentUrlArgument =
	'deployment URL (e.g. https://cupboard.example.workers.dev)';
