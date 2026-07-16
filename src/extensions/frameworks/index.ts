import {
  chi,
  chiFrameworkLoader,
  createChiFrameworkLoader,
  createFiberFrameworkLoader,
  createGinFrameworkLoader,
  fiber,
  fiberFrameworkLoader,
  gin,
  ginFrameworkLoader
} from "./go.js";
import {
  createExpressFrameworkLoader,
  createFastifyFrameworkLoader,
  createNestJsFrameworkLoader,
  createNextJsFrameworkLoader,
  express,
  expressFrameworkLoader,
  fastify,
  fastifyFrameworkLoader,
  nestJsFrameworkLoader,
  nestjs,
  nextJsFrameworkLoader,
  nextjs
} from "./node.js";
import {
  createDjangoFrameworkLoader,
  createFastApiFrameworkLoader,
  createFlaskFrameworkLoader,
  django,
  djangoFrameworkLoader,
  fastApiFrameworkLoader,
  fastapi,
  flask,
  flaskFrameworkLoader
} from "./python.js";
import {
  actix,
  actixFrameworkLoader,
  axum,
  axumFrameworkLoader,
  createActixFrameworkLoader,
  createAxumFrameworkLoader
} from "./rust.js";

export {
  actix,
  actixFrameworkLoader,
  axum,
  axumFrameworkLoader,
  chi,
  chiFrameworkLoader,
  createActixFrameworkLoader,
  createAxumFrameworkLoader,
  createChiFrameworkLoader,
  createDjangoFrameworkLoader,
  createExpressFrameworkLoader,
  createFastApiFrameworkLoader,
  createFastifyFrameworkLoader,
  createFiberFrameworkLoader,
  createFlaskFrameworkLoader,
  createGinFrameworkLoader,
  createNestJsFrameworkLoader,
  createNextJsFrameworkLoader,
  django,
  djangoFrameworkLoader,
  express,
  expressFrameworkLoader,
  fastApiFrameworkLoader,
  fastapi,
  fastify,
  fastifyFrameworkLoader,
  fiber,
  fiberFrameworkLoader,
  flask,
  flaskFrameworkLoader,
  gin,
  ginFrameworkLoader,
  nestJsFrameworkLoader,
  nestjs,
  nextJsFrameworkLoader,
  nextjs
};

export const frameworkLoaders = [
  createFastApiFrameworkLoader(),
  createDjangoFrameworkLoader(),
  createFlaskFrameworkLoader(),
  createNextJsFrameworkLoader(),
  createNestJsFrameworkLoader(),
  createFastifyFrameworkLoader(),
  createExpressFrameworkLoader(),
  createAxumFrameworkLoader(),
  createActixFrameworkLoader(),
  createChiFrameworkLoader(),
  createGinFrameworkLoader(),
  createFiberFrameworkLoader()
] as const;

export const frameworkLoaderFactories = [
  createFastApiFrameworkLoader,
  createDjangoFrameworkLoader,
  createFlaskFrameworkLoader,
  createNextJsFrameworkLoader,
  createNestJsFrameworkLoader,
  createFastifyFrameworkLoader,
  createExpressFrameworkLoader,
  createAxumFrameworkLoader,
  createActixFrameworkLoader,
  createChiFrameworkLoader,
  createGinFrameworkLoader,
  createFiberFrameworkLoader
] as const;
