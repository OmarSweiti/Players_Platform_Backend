// Breaks modules-meet-through-their-application: another module's repository.
import { betaRepository } from '../beta/infrastructure/beta.repository';
// Allowed: the composition root wires its own module's adapter.
import { alphaRepository } from './infrastructure/alpha.repository';

export const alphaModule = [betaRepository, alphaRepository];
