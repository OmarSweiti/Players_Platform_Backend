// Nest's decorators read the Reflect metadata API as their modules load. The
// package roots install it; a test whose first Nest import is another entry
// point (`@nestjs/common/internal`) would load before it, so it comes first.
import 'reflect-metadata';
import { inject } from 'vitest';

// The application validates its environment as AppModule loads
// (src/config/env.schema.ts), so the run's database must be in the
// environment before any test file imports it. Runs before each file.
process.env.DATABASE_URL = inject('databaseUrl');
