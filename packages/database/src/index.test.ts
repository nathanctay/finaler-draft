import { beforeEach, describe, expect, it, vi } from 'vitest';

const Pool = vi.fn();
const drizzle = vi.fn();

vi.mock('pg', () => ({ Pool }));
vi.mock('drizzle-orm/node-postgres', () => ({ drizzle }));

const { createDatabase } = await import('./index.js');

describe('createDatabase', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    Pool.mockReturnValue({ marker: 'pool' });
    drizzle.mockReturnValue({ marker: 'database' });
  });

  it('configures the pool with bounded connection, statement, and idle-transaction timeouts', () => {
    const result = createDatabase('postgresql://localhost/finaler');

    expect(Pool).toHaveBeenCalledWith({
      connectionString: 'postgresql://localhost/finaler',
      max: 10,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 30_000,
      idle_in_transaction_session_timeout: 30_000,
    });
    expect(result).toEqual({ pool: { marker: 'pool' }, database: { marker: 'database' } });
  });
});
