import { screenplayFixture } from '@finaler-draft/screenplay/fixtures';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, AuthApiError, api } from './api.js';

const projectId = '216ec49a-a6c6-49ff-8e2e-5994d5ca91dd';
const screenplayId = '38d8a6db-43f1-4b47-b8fc-c15a96f9ac0e';

function response(body: unknown, ok = true, status = 200): Response {
  return { json: vi.fn().mockResolvedValue(body), ok, status } as unknown as Response;
}

describe('API client', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('sends authenticated JSON requests for every supported operation', async () => {
    fetchMock
      .mockResolvedValueOnce(response({ user: { id: 'writer-1' } }))
      .mockResolvedValueOnce(response({}))
      .mockResolvedValueOnce(response({}))
      .mockResolvedValueOnce(response({}))
      .mockResolvedValueOnce(
        response([{ id: projectId, role: 'owner', title: 'Feature', updatedAt: '2026-01-01' }]),
      )
      .mockResolvedValueOnce(response({ id: projectId, title: 'Feature' }))
      .mockResolvedValueOnce(
        response([{ id: screenplayId, title: 'Draft', updatedAt: '2026-01-01', version: 1 }]),
      )
      .mockResolvedValueOnce(response({ id: screenplayId, version: 1 }))
      .mockResolvedValueOnce(
        response({
          id: screenplayId,
          projectId,
          screenplay: screenplayFixture,
          title: 'Draft',
          version: 1,
        }),
      )
      .mockResolvedValueOnce(response({ version: 2 }));

    await expect(api.session()).resolves.toEqual({ user: { id: 'writer-1' } });
    await api.signIn('writer@example.com', 'a secure passphrase');
    await api.signUp('Writer', 'writer@example.com', 'a secure passphrase');
    await api.signOut();
    await expect(api.projects()).resolves.toHaveLength(1);
    await expect(api.createProject('Feature')).resolves.toEqual({
      id: projectId,
      title: 'Feature',
    });
    await expect(api.screenplays(projectId)).resolves.toHaveLength(1);
    await expect(api.createScreenplay(projectId, 'Draft', screenplayFixture)).resolves.toEqual({
      id: screenplayId,
      version: 1,
    });
    await expect(api.screenplay(screenplayId)).resolves.toMatchObject({
      id: screenplayId,
      projectId,
    });
    await expect(api.saveScreenplay(screenplayId, 1, screenplayFixture)).resolves.toEqual({
      version: 2,
    });

    expect(fetchMock).toHaveBeenCalledTimes(10);
    expect(fetchMock.mock.calls[1]).toEqual([
      '/api/auth/sign-in/email',
      expect.objectContaining({ credentials: 'include', method: 'POST' }),
    ]);
    expect(fetchMock.mock.calls[7]).toEqual([
      `/api/projects/${projectId}/screenplays`,
      expect.objectContaining({ body: expect.any(String), method: 'POST' }),
    ]);
    expect(fetchMock.mock.calls[9]).toEqual([
      `/api/screenplays/${screenplayId}`,
      expect.objectContaining({ method: 'PUT' }),
    ]);
  });

  it('rejects non-success responses with the HTTP status', async () => {
    fetchMock.mockResolvedValue(response({ error: 'nope' }, false, 409));
    await expect(api.projects()).rejects.toEqual(new ApiError(409));
  });

  it('exposes only allowlisted Better Auth validation errors as safe typed errors', async () => {
    fetchMock.mockResolvedValue(
      response({ code: 'INVALID_EMAIL_OR_PASSWORD', message: 'raw server response' }, false, 401),
    );

    await expect(api.signIn('writer@example.com', 'wrong password')).rejects.toMatchObject({
      code: 'INVALID_EMAIL_OR_PASSWORD',
      safeMessage: 'Invalid email or password.',
      status: 401,
    });
    await expect(api.signIn('writer@example.com', 'wrong password')).rejects.toBeInstanceOf(
      AuthApiError,
    );
  });

  it('keeps unknown and malformed authentication errors generic without exposing server messages', async () => {
    fetchMock
      .mockResolvedValueOnce(
        response(
          { code: 'DATABASE_CONNECTION_LEAKED', message: 'sensitive server detail' },
          false,
          500,
        ),
      )
      .mockResolvedValueOnce({
        json: vi.fn().mockRejectedValue(new SyntaxError('Unexpected token')),
        ok: false,
        status: 502,
      } as unknown as Response);

    await expect(api.signUp('Writer', 'writer@example.com', 'a secure passphrase')).rejects.toEqual(
      new ApiError(500),
    );
    await expect(api.signIn('writer@example.com', 'a secure passphrase')).rejects.toEqual(
      new ApiError(502),
    );
  });

  it('rejects malformed successful responses', async () => {
    fetchMock.mockResolvedValue(response({ user: { id: 3 } }));
    await expect(api.session()).rejects.toThrow();
  });

  it('sets a content-type header only on requests that carry a body', async () => {
    fetchMock
      .mockResolvedValueOnce(response({}))
      .mockResolvedValueOnce(response({ id: projectId, title: 'Feature' }));

    await api.signOut();
    await api.createProject('Feature');

    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty('headers');
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      headers: { 'content-type': 'application/json' },
    });
  });
});
