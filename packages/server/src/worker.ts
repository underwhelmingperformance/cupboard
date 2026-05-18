export { CupboardServer } from './do.ts';

export default {
	fetch(_request, _env, _ctx) {
		return new Response('cupboard: not yet implemented', { status: 501 });
	},

	scheduled(_controller, _env, _ctx) {
		// GC pass will hook in here.
	}
} satisfies ExportedHandler<Env>;
