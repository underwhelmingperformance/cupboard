import { describe, expect, it } from 'vitest';

import { wrapDispatchedMethods } from './dispatch-scope.ts';

describe('wrapDispatchedMethods', () => {
	it.each([
		{
			options: {},
			scopes: ['own']
		},
		{
			options: { includeInherited: true },
			scopes: ['own', 'greet']
		}
	])(
		'wraps the methods that $options selects, and leaves the superclass unchanged',
		({ options, scopes }) => {
			class Base {
				greet(): string {
					return 'base';
				}
			}
			class Child extends Base {
				own(): string {
					return 'own';
				}
			}
			const baseDescriptor = Object.getOwnPropertyDescriptor(
				Base.prototype,
				'greet'
			);
			const entered: string[] = [];

			wrapDispatchedMethods(
				Child.prototype,
				(body, _receiver, method) => {
					entered.push(method);

					return body();
				},
				options
			);
			const child = new Child();

			expect({
				results: [child.own(), child.greet()],
				entered,
				baseDescriptor: Object.getOwnPropertyDescriptor(Base.prototype, 'greet')
			}).toStrictEqual({
				results: ['own', 'base'],
				entered: scopes,
				baseDescriptor
			});
		}
	);
});
