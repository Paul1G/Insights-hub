import { describe, expect, it } from 'vitest';

import { OPERATIONS, matchOperation } from './allowlist.js';

const ID = '0123456789abcdef0123456789abcdef';

describe('operation allowlist', () => {
  it.each([
    ['GET', '/assettypes'],
    ['PUT', '/assettypes/acme.Pump'],
    ['PATCH', '/assettypes/acme.Pump/variables'],
    ['PUT', '/assettypes/acme.Pump/fileAssignments/manual'],
    ['DELETE', '/aspecttypes/acme.Motor'],
    ['PATCH', '/aspecttypes/acme.Motor/variables'],
    ['POST', '/assets'],
    ['GET', '/assets/root'],
    ['POST', `/assets/${ID}/move`],
    ['PUT', `/assets/${ID}/location`],
    ['DELETE', `/assets/${ID}/fileAssignments/doc_1`],
    ['GET', `/assets/${ID.toUpperCase()}/variables`],
    ['GET', '/files'],
    ['DELETE', `/files/${ID}`],
    ['GET', '/model/lock'],
    ['PUT', '/model/lock'],
    ['GET', '/'],
  ])('accepts %s %s', (method, path) => {
    const res = matchOperation(method, path);
    expect(res.ok).toBe(true);
  });

  it.each([
    ['POST', '/files', 'multipart upload'],
    ['PUT', `/files/${ID}`, 'multipart replace'],
    ['GET', `/files/${ID}/file`, 'binary download'],
    ['DELETE', '/assettypes', 'method not in spec'],
    ['POST', '/assettypes/acme.Pump', 'method not in spec'],
    ['GET', '/assets/not-an-id', 'invalid unique id'],
    ['GET', '/assettypes/notatypeid', 'invalid type id'],
    ['GET', '/assettypes/../assets', 'traversal'],
    ['GET', '/assettypes/acme.Pump%2F..', 'encoded slash'],
    ['GET', '/assets?size=10', 'query in path'],
    ['GET', '/tenantmanagement/v4/tenantInfo', 'other service'],
    ['GET', 'assets', 'relative path'],
    ['GET', '/assets/root/extra', 'extra segment'],
  ])('rejects %s %s (%s)', (method, path) => {
    expect(matchOperation(method, path).ok).toBe(false);
  });

  it('rebuilds a canonical path and declares spec query parameters', () => {
    const res = matchOperation('get', '/assets/');
    expect(res.ok && res.match.path).toBe('/assets');
    const listAssets = OPERATIONS.find((o) => o.operationId === 'listAssets');
    expect(listAssets?.query).toEqual([
      'page',
      'size',
      'sort',
      'filter',
      'includeShared',
      'basicFieldsOnly',
    ]);
  });
});
