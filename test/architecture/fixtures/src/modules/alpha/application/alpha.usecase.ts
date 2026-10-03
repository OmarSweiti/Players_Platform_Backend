// Breaks adapters-are-wired-by-composition-roots: a use case imports an adapter.
import { alphaRepository } from '../infrastructure/alpha.repository';
// Allowed: its own domain, and another module's application service.
import { alphaLimit } from '../domain/alpha';
import { betaService } from '../../beta/application/beta.service';

export const alphaUseCase = [alphaRepository, alphaLimit, betaService];
