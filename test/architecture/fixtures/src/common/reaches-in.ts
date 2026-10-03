// Breaks shared-code-reaches-modules-through-their-application.
import { betaRepository } from '../modules/beta/infrastructure/beta.repository';
// Allowed: shared code uses a module's application service.
import { betaService } from '../modules/beta/application/beta.service';

export const reachesIn = [betaRepository, betaService];
