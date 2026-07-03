// The `cupboard-tenant` Worker. It defines the per-tenant Durable Object; the
// control-plane Worker reaches every tenant through the external Durable Object
// binding, so this script has no public surface of its own.
// Keeping the class in its own script is what isolates the control signing key:
// this script never binds the wrapping secret, so the Durable Object cannot reach
// it.
//
// The default handler exists only so the script is built as a module Worker, the
// format Durable Objects require; a direct request to the script itself is not
// part of any flow and is refused.
export { CupboardServer } from './do/server.ts';

export default {
	fetch: (): Response =>
		new Response('Not found\n', {
			status: 404,
			headers: { 'content-type': 'text/plain; charset=utf-8' }
		})
} satisfies ExportedHandler<TenantEnv>;
