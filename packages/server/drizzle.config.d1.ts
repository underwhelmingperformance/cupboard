import { defineConfig } from 'drizzle-kit';

export default defineConfig({
	dialect: 'sqlite',
	out: './drizzle-d1',
	schema: './src/db/d1-schema.ts'
});
