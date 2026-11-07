import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  RequestMethod,
  type Type,
} from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { declaredAccess } from './route-access';

/** A route declares no access rule, or more than one: the API does not start. */
export class RouteAccessUndeclared extends Error {
  constructor(readonly routes: readonly string[]) {
    super(
      `Every route declares exactly one of @RequirePermission(…), @SignedIn() or @Public() (0.6.2): ${routes.join('; ')}.`,
    );
    this.name = new.target.name;
  }
}

/**
 * Deny by default (0.6.2; ADR-0005): before any request is served, every
 * route of every controller is read, and the API refuses to start if one
 * declares no access rule, or more than one. A route nobody thought about is
 * never open.
 */
@Injectable()
export class RouteAccessCheck implements OnApplicationBootstrap {
  private readonly logger = new Logger(RouteAccessCheck.name);

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  onApplicationBootstrap(): void {
    const refused: string[] = [];
    for (const { metatype, instance } of this.discovery.getControllers()) {
      if (!metatype || !instance) continue;
      const controller = metatype as Type;
      const prototype = Object.getPrototypeOf(instance) as Record<
        string,
        unknown
      >;
      for (const name of this.scanner.getAllMethodNames(prototype)) {
        const handler = prototype[name] as (...args: never[]) => unknown;
        const verb = Reflect.getMetadata(METHOD_METADATA, handler) as
          RequestMethod | undefined;
        const path = Reflect.getMetadata(PATH_METADATA, handler) as
          string | undefined;
        if (verb === undefined || path === undefined) continue;
        const declared = declaredAccess(this.reflector, handler, controller);
        if (declared.length === 1) continue;
        const route = `${RequestMethod[verb]} ${controller.name}.${name}`;
        refused.push(
          declared.length === 0
            ? `${route} declares none`
            : `${route} declares ${declared.map(({ kind }) => kind).join(' and ')}`,
        );
      }
    }
    if (refused.length === 0) return;
    const undeclared = new RouteAccessUndeclared(refused);
    this.logger.error(undeclared.message);
    throw undeclared;
  }
}
