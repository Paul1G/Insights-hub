// adapter/simulator/sim-error carries an HTTP status out of simulator
// handlers. Bodies follow the spec's `errors` schema:
// {"errors": [{"code", "message", "logref"}]}.

import { randomUUID } from 'node:crypto';

const CODES: Record<number, string> = {
  400: 'assetmanagement.badRequest',
  404: 'assetmanagement.notFound',
  405: 'assetmanagement.methodNotAllowed',
  409: 'assetmanagement.conflict',
  412: 'assetmanagement.preconditionFailed',
  415: 'assetmanagement.unsupportedMediaType',
  500: 'assetmanagement.internalError',
};

export class SimError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'SimError';
    this.status = status;
  }
}

export const badRequest = (m: string): SimError => new SimError(400, m);
export const notFound = (m: string): SimError => new SimError(404, m);
export const preconditionFailed = (m: string): SimError => new SimError(412, m);

export function errorBody(
  status: number,
  message: string,
): {
  errors: { code: string; message: string; logref: string }[];
} {
  return {
    errors: [
      {
        code: CODES[status] ?? `assetmanagement.http${status}`,
        message,
        logref: randomUUID().replace(/-/g, ''),
      },
    ],
  };
}
