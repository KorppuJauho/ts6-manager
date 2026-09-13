import { describe, it, expect, vi } from 'vitest';
import { requireIntParams } from './validate-params.js';
import type { Request, Response } from 'express';

function run(params: Record<string, unknown>) {
  const status = vi.fn().mockReturnThis();
  const json = vi.fn();
  const next = vi.fn();
  const req = { params } as unknown as Request;
  const res = { status, json } as unknown as Response;
  requireIntParams('configId', 'sid')(req, res, next);
  return { status, json, next };
}

describe('requireIntParams', () => {
  it('passes plain integers through', () => {
    const { next, status } = run({ configId: '12', sid: '1' });
    expect(next).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
  });

  it('ignores params not present on the route', () => {
    const { next } = run({});
    expect(next).toHaveBeenCalledOnce();
  });

  it.each([
    ['NaN-producing string', 'abc'],
    ['parseInt-truncatable string', '12abc'],
    ['negative number', '-1'],
    ['float', '1.5'],
    ['empty string', ''],
  ])('rejects %s with 400', (_label, value) => {
    const { next, status, json } = run({ configId: value });
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ error: 'Invalid configId parameter' });
  });

  it('rejects array params', () => {
    const { next, status } = run({ sid: ['1', '2'] });
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
  });
});
