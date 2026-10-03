import { inject } from 'vitest';

// The application validates its environment as AppModule loads
// (src/config/env.schema.ts), so the run's database must be in the
// environment before any test file imports it. Runs before each file.
process.env.DATABASE_URL = inject('databaseUrl');
