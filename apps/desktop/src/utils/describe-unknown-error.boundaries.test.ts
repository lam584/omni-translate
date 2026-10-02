import { describe, expect, it } from 'vitest';
import { describeUnknownError } from './describe-unknown-error';

describe('service error display rejects invalid diagnostic fields', () => {
  it.each([undefined, 42, '', '   '])('does not append an invalid code %j to a valid service message', (code) => {
    expect(describeUnknownError({ message: 'provider unavailable', code })).toBe('provider unavailable');
  });
  it.each([undefined, 42, '', '   '])('serializes the original diagnostic object when message is invalid %j', (message) => {
    const error = { message, detail: 'keep diagnostic context' };
    expect(describeUnknownError(error)).toBe(JSON.stringify(error));
  });
});
