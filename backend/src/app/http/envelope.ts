// app/http/envelope implements the response envelope of docs/api-contract.md:
//   success  200 {"data": <payload>}
//   failure  4xx/5xx {"error": "<message>"}
// and translates typed errors, Fastify errors and Zod validation errors.

import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, type ZodType, type ZodTypeDef } from 'zod';

import { ValidationError, isAppError } from '../../domain/errors.js';
import type { Logger } from '../../log.js';

export function sendData(reply: FastifyReply, data: unknown): FastifyReply {
  return reply.code(200).send({ data });
}

export function sendError(
  reply: FastifyReply,
  status: number,
  message: string,
): FastifyReply {
  return reply.code(status).send({ error: message });
}

export function formatZodError(err: ZodError): string {
  return err.issues
    .slice(0, 5)
    .map((i) =>
      i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message,
    )
    .join('; ');
}

/** Parses `value` with `schema` or throws ValidationError (400). */
export function parse<T>(
  schema: ZodType<T, ZodTypeDef, unknown>,
  value: unknown,
  what: string,
): T {
  const res = schema.safeParse(value);
  if (!res.success)
    throw new ValidationError(`Invalid ${what}: ${formatZodError(res.error)}`);
  return res.data;
}

export function errorHandler(logger: Logger) {
  return (
    err: FastifyError | Error,
    req: FastifyRequest,
    reply: FastifyReply,
  ): FastifyReply => {
    if (isAppError(err)) return sendError(reply, err.status, err.message);
    if (err instanceof ZodError)
      return sendError(reply, 400, formatZodError(err));
    const fe = err as FastifyError;
    if (fe.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || fe.statusCode === 413) {
      return sendError(reply, 413, 'Request body is too large');
    }
    if (fe.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || fe.statusCode === 415) {
      return sendError(reply, 400, 'Request bodies must be application/json');
    }
    if (
      fe.statusCode !== undefined &&
      fe.statusCode >= 400 &&
      fe.statusCode < 500
    ) {
      return sendError(reply, 400, fe.message);
    }
    logger.error(
      { err, method: req.method, url: req.url, request_id: req.id },
      'unhandled error',
    );
    return sendError(reply, 500, 'Internal server error');
  };
}
