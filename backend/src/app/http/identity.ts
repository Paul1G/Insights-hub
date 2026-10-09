// app/http/identity reads the caller identity from the headers set by the
// platform's OAuth proxy. These headers are trusted (the proxy strips any
// client-supplied values); a request without X-Forwarded-User is anonymous.

import type { FastifyRequest } from 'fastify';

import { identityFromHeaders, type Identity } from '../../domain/identity.js';

function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  if (Array.isArray(v)) return v[0];
  return v;
}

export function identityOf(req: FastifyRequest): Identity {
  return identityFromHeaders({
    user: header(req, 'x-forwarded-user'),
    email: header(req, 'x-forwarded-email'),
    username: header(req, 'x-forwarded-preferred-username'),
  });
}
