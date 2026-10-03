// Breaks presentation-skips-infrastructure: a controller reaches a repository.
import { alphaRepository } from '../infrastructure/alpha.repository';
// Allowed: a controller calls a use case.
import { alphaUseCase } from '../application/alpha.usecase';

export const alphaController = [alphaRepository, alphaUseCase];
