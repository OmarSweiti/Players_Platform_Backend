import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
  SetMetadata,
  type Type,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Env } from '../../config/env.schema';

/** An unfinished module: off in every environment unless its flag is set. */
export type Feature = 'medical' | 'scouting';

const FLAG_OF = {
  medical: 'FEATURE_MEDICAL',
  scouting: 'FEATURE_SCOUTING',
} as const satisfies Record<Feature, keyof Env>;

const FEATURE_KEY = 'sadara:feature';

/**
 * Puts every controller a module mounts behind one flag. Called in the module
 * file, so a controller added to the module later is gated too.
 */
export function behindFeature<T extends Type[]>(
  feature: Feature,
  controllers: T,
): T {
  for (const controller of controllers) {
    SetMetadata(FEATURE_KEY, feature)(controller);
  }
  return controllers;
}

/**
 * The first global guard, so it runs before authentication: a route of a
 * disabled module answers exactly what an unknown route answers, signed in
 * or not, and nothing behind it — use case, repository, query — runs. A
 * client's navigation flag is never this control. Per-tenant flags replace
 * these in 1.1.4.
 */
@Injectable()
export class FeatureGateGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService<Env, true>,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true; // no gateway sits behind a flag
    const feature = this.reflector.get<Feature | undefined>(
      FEATURE_KEY,
      context.getClass(),
    );
    if (feature === undefined) return true;
    if (this.config.get(FLAG_OF[feature], { infer: true })) return true;

    // Exactly what an unknown route answers: the problem filter turns every
    // NotFoundException into the same NOT_FOUND problem.
    throw new NotFoundException();
  }
}
