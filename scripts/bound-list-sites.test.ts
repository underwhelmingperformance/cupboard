import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Statements in `packages/server` normally bind a list as one JSON parameter,
// so their parameter count does not follow the number of values they read.
// `statement-parameters.test.ts` compares the count at one value and at ten
// thousand, which covers the statements it has a case for. This test covers the
// rest: a statement with no case there is invisible to it. Such a site has no
// distinguishing name to search for, so the scan finds it by the type of the
// argument.
//
// A finding is a call whose parameter count grows with its input: `inArray` or
// `notInArray` over an array rather than a bound list, a multi-row `.values()`,
// or a spread `or`/`and`. Every such site must use a bound-list helper or
// fixed SQL predicates, so the statement cannot grow with a runtime array.
//
// This test reads the server package with the TypeScript API, which needs Node,
// so it lives here: that package's lint rules forbid Node imports, and its
// tests run in the workers pool.
const packageRoot = path.join(import.meta.dirname, '..', 'packages', 'server');

interface BoundListSite {
	/**
	The call that could bind one parameter for each value.
	*/
	readonly kind: 'inArray' | 'notInArray' | 'values' | 'or' | 'and';
	/**
	The package-relative file, with no line, so an entry survives an edit above it.
	*/
	readonly file: string;
	/**
	The argument as written, which identifies the site within its file.
	*/
	readonly argument: string;
}

function isArrayLike(type: ts.Type, checker: ts.TypeChecker): boolean {
	if (checker.isArrayType(type) || checker.isTupleType(type)) {
		return true;
	}

	return (
		type.isUnion() && type.types.some((member) => isArrayLike(member, checker))
	);
}

/**
The argument text on one line, cut to the length an entry records.
*/
function argumentText(node: ts.Node): string {
	return node.getText().replaceAll(/\s+/gu, ' ').slice(0, 50);
}

function scanPackage(): readonly BoundListSite[] {
	const configPath = path.join(packageRoot, 'tsconfig.json');
	const read = ts.readConfigFile(configPath, (file) => ts.sys.readFile(file));
	const parsed = ts.parseJsonConfigFileContent(
		read.config as unknown,
		ts.sys,
		packageRoot
	);
	const program = ts.createProgram(parsed.fileNames, parsed.options);
	const checker = program.getTypeChecker();
	const sites: BoundListSite[] = [];

	for (const file of program.getSourceFiles()) {
		// A test file binds its own fixtures and is not a production statement.
		if (
			file.isDeclarationFile ||
			!file.fileName.startsWith(packageRoot) ||
			file.fileName.endsWith('.test.ts')
		) {
			continue;
		}

		const relative = path.relative(packageRoot, file.fileName);

		const record = (
			kind: BoundListSite['kind'],
			argument: ts.Node | undefined
		): void => {
			if (
				argument === undefined ||
				!isArrayLike(checker.getTypeAtLocation(argument), checker)
			) {
				return;
			}

			sites.push({ kind, file: relative, argument: argumentText(argument) });
		};

		const visit = (node: ts.Node): void => {
			if (ts.isCallExpression(node)) {
				const callee = node.expression.getText();

				if (callee === 'inArray' || callee === 'notInArray') {
					record(callee, node.arguments[1]);
				}

				if (callee.endsWith('.values')) {
					record('values', node.arguments[0]);
				}

				if (
					(callee === 'or' || callee === 'and') &&
					node.arguments.some((argument) => ts.isSpreadElement(argument))
				) {
					sites.push({
						kind: callee,
						file: relative,
						argument: argumentText(node)
					});
				}
			}

			ts.forEachChild(node, visit);
		};

		visit(file);
	}

	return sites;
}

const sites = scanPackage();

describe('statements that could bind one parameter for each value', () => {
	it('use a bound list or fixed SQL predicates', () => {
		expect(sites).toStrictEqual([]);
	});
});
