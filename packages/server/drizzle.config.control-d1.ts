import { defineConfig } from 'drizzle-kit';

export default defineConfig({
	dialect: 'sqlite',
	out: './drizzle-control-d1',
	schema: './src/db/control-d1-schema.ts'
});
