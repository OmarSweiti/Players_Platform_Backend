import {
  type INestApplication,
  RequestMethod,
  type Type,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import {
  METHOD_METADATA,
  PATH_METADATA,
  VERSION_METADATA,
} from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import { API_VERSION } from '../../src/app.setup';

export type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface Route {
  method: Method;
  /** The template, where the app serves it: `/api/v1/medical/records/:id`. */
  path: string;
  controller: Type;
  handler: string;
}

/** Every route a controller declares, read from its metadata. */
export function routesOf(controller: Type): Route[] {
  const base = Reflect.getMetadata(PATH_METADATA, controller) as string;
  const prototype = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(prototype).flatMap((handler) => {
    const method = prototype[handler];
    if (handler === 'constructor' || typeof method !== 'function') return [];
    const path = Reflect.getMetadata(PATH_METADATA, method) as
      string | undefined;
    const verb = Reflect.getMetadata(METHOD_METADATA, method) as
      RequestMethod | undefined;
    if (path === undefined || verb === undefined) return [];
    const version = (Reflect.getMetadata(VERSION_METADATA, method) ??
      Reflect.getMetadata(VERSION_METADATA, controller) ??
      API_VERSION) as string | symbol;
    const segment = version === VERSION_NEUTRAL ? '' : `v${String(version)}`;
    return [
      {
        method: RequestMethod[verb].toLowerCase() as Method,
        path: `/api/${segment}/${base}/${path}`
          .replace(/\/+/g, '/')
          .replace(/\/$/, ''),
        controller,
        handler,
      },
    ];
  });
}

/** Every controller the app serves. */
export function controllersOf(app: INestApplication): Type[] {
  return [...app.get(ModulesContainer).values()].flatMap((module) =>
    [...module.controllers.values()]
      .map(({ metatype }) => metatype as Type | null)
      .filter((metatype): metatype is Type => metatype !== null),
  );
}

/** The path with each parameter filled in by a fresh `value()`. */
export function withParams(path: string, value: () => string): string {
  return path.replace(/:\w+/g, () => value());
}
