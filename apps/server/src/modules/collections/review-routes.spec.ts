import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { CollectionsController } from './collections.controller';
import { ReviewLeavingSoonController } from './review-leaving-soon.controller';

type Controller = abstract new (...args: never[]) => object;

const routes = (controller: Controller): string[] => {
  const prototype = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(prototype)
    .filter((name) => name !== 'constructor')
    .map((name) => prototype[name])
    .filter(
      (handler): handler is object =>
        typeof handler === 'function' &&
        Reflect.getMetadata(PATH_METADATA, handler) !== undefined,
    )
    .map(
      (handler) =>
        `${RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler)]} ${Reflect.getMetadata(PATH_METADATA, handler)}`,
    )
    .sort();
};

describe('Review routes leave the stock API unchanged', () => {
  it('keeps every stock Maintainerr 3.33.0 collections route plus the review routes', () => {
    expect(Reflect.getMetadata(PATH_METADATA, CollectionsController)).toBe(
      'api/collections',
    );
    // From maintainerr v3.33.0 (5d3146ee) collections.controller.ts, then the
    // four review routes of the review-queue fork.
    const stock = [
      'DELETE /:id/poster',
      'DELETE /media',
      'GET /',
      'GET /:id/poster',
      'GET /activate/:id',
      'GET /collection/:id',
      'GET /deactivate/:id',
      'GET /exclusions/:id/content/:page',
      'GET /logs/:id/content/:page',
      'GET /media/',
      'GET /media/:id/content/:page',
      'GET /media/count',
      'GET /overlay-data',
      'POST /',
      'POST /:id/poster',
      'POST /add',
      'POST /handle',
      'POST /media/add',
      'POST /media/bulk',
      'POST /media/handle',
      'POST /media/postpone',
      'POST /remove',
      'POST /removeCollection',
      'PUT /',
      'PUT /schedule/update',
    ];
    const review = [
      'GET /:id/review',
      'POST /:id/review/approve',
      'POST /:id/review/notify',
      'PUT /:id/review',
    ];
    expect(routes(CollectionsController)).toEqual([...stock, ...review].sort());
  });

  it('serves Leaving soon under its own prefix, outside the stock collections routes', () => {
    expect(
      Reflect.getMetadata(PATH_METADATA, ReviewLeavingSoonController),
    ).toBe('api/review/leaving-soon');
    expect(routes(ReviewLeavingSoonController)).toEqual([
      'GET /',
      'POST /:id/cancel',
    ]);
  });
});
