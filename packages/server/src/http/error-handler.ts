import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { VinaError } from '@vina/shared';

/**
 * Single error envelope per `api-spec.md`: { code, message, details? } with the
 * subclass's static HTTP status. Anything that isn't a VinaError is logged and
 * returned as a generic 500 — never leak internal stack traces over the wire.
 */
export function errorHandler(
  err: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  if (err instanceof VinaError) {
    reply.status(err.status).send(err.toJSON());
    return;
  }

  // Fastify's own validation errors come through with `validation`.
  if (err.validation) {
    reply.status(400).send({
      code: 'validation_error',
      message: err.message,
      details: err.validation,
    });
    return;
  }

  request.log.error({ err }, 'unhandled error');
  reply.status(500).send({ code: 'internal_error', message: 'Internal server error' });
}
