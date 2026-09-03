import { screenplayFixture } from '@finaler-draft/screenplay/fixtures';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PASSWORD_REQUIREMENTS_MESSAGE } from '@finaler-draft/config';
import { ApiError, AuthApiError, MessageApiError, api } from './api.js';

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
      .mockResolvedValueOnce(
        response({ user: { email: 'writer@example.com', id: 'writer-1', name: 'Writer' } }),
      )
      .mockResolvedValueOnce(response({ token: 'session-token' }))
      .mockResolvedValueOnce(response({ token: 'session-token' }))
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
      .mockResolvedValueOnce(response({ version: 2 }))
      .mockResolvedValueOnce(response({ id: projectId }))
      .mockResolvedValueOnce(response({ id: projectId, title: 'Feature' }))
      .mockResolvedValueOnce(response({ id: screenplayId }))
      .mockResolvedValueOnce(response({ id: screenplayId, title: 'Draft' }))
      .mockResolvedValueOnce(response({ projects: [], screenplays: [] }))
      .mockResolvedValueOnce(
        response({
          tier: 'restricted',
          editableScreenplayId: null,
          candidateScreenplayIds: [],
          slotUpdatedAt: null,
          cooldownEndsAt: null,
        }),
      )
      .mockResolvedValueOnce(response({ screenplayId, updatedAt: '2026-09-02T00:00:00.000Z' }))
      .mockResolvedValueOnce(response({ url: 'https://checkout.stripe.test/cs_test_1' }))
      .mockResolvedValueOnce(response({ url: 'https://billing.stripe.test/bps_test_1' }))
      .mockResolvedValueOnce(
        response({
          subscription: {
            plan: 'monthly',
            status: 'active',
            currentPeriodEnd: '2026-10-01T00:00:00.000Z',
            cancelAtPeriodEnd: false,
            canceledAt: null,
          },
        }),
      )
      .mockResolvedValueOnce(
        response({
          monthly: { amount: 500, currency: 'usd', interval: 'month' },
          annual: { amount: 5000, currency: 'usd', interval: 'year' },
        }),
      );

    await expect(api.session()).resolves.toEqual({
      email: 'writer@example.com',
      id: 'writer-1',
      name: 'Writer',
    });
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
    await expect(api.deleteProject(projectId)).resolves.toEqual({ id: projectId });
    await expect(api.restoreProject(projectId)).resolves.toEqual({
      id: projectId,
      title: 'Feature',
    });
    await expect(api.deleteScreenplay(screenplayId)).resolves.toEqual({ id: screenplayId });
    await expect(api.restoreScreenplay(screenplayId)).resolves.toEqual({
      id: screenplayId,
      title: 'Draft',
    });
    await expect(api.deletedItems()).resolves.toEqual({ projects: [], screenplays: [] });
    await expect(api.entitlement()).resolves.toEqual({
      tier: 'restricted',
      editableScreenplayId: null,
      candidateScreenplayIds: [],
      slotUpdatedAt: null,
      cooldownEndsAt: null,
    });
    await expect(api.switchEditableScreenplay(screenplayId)).resolves.toEqual({
      screenplayId,
      updatedAt: '2026-09-02T00:00:00.000Z',
    });
    await expect(api.createCheckoutSession('monthly')).resolves.toEqual({
      url: 'https://checkout.stripe.test/cs_test_1',
    });
    await expect(api.createPortalSession()).resolves.toEqual({
      url: 'https://billing.stripe.test/bps_test_1',
    });
    await expect(api.billingSubscription()).resolves.toEqual({
      subscription: {
        plan: 'monthly',
        status: 'active',
        currentPeriodEnd: '2026-10-01T00:00:00.000Z',
        cancelAtPeriodEnd: false,
        canceledAt: null,
      },
    });
    await expect(api.billingPlans()).resolves.toEqual({
      monthly: { amount: 500, currency: 'usd', interval: 'month' },
      annual: { amount: 5000, currency: 'usd', interval: 'year' },
    });

    expect(fetchMock).toHaveBeenCalledTimes(21);
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
    expect(fetchMock.mock.calls[10]).toEqual([
      `/api/projects/${projectId}`,
      expect.objectContaining({ method: 'DELETE' }),
    ]);
    expect(fetchMock.mock.calls[11]).toEqual([
      `/api/projects/${projectId}/restore`,
      expect.objectContaining({ method: 'POST' }),
    ]);
    expect(fetchMock.mock.calls[12]).toEqual([
      `/api/screenplays/${screenplayId}`,
      expect.objectContaining({ method: 'DELETE' }),
    ]);
    expect(fetchMock.mock.calls[13]).toEqual([
      `/api/screenplays/${screenplayId}/restore`,
      expect.objectContaining({ method: 'POST' }),
    ]);
    expect(fetchMock.mock.calls[14]).toEqual([
      '/api/deleted',
      expect.objectContaining({ credentials: 'include' }),
    ]);
    expect(fetchMock.mock.calls[15]).toEqual([
      '/api/entitlement',
      expect.objectContaining({ credentials: 'include' }),
    ]);
    expect(fetchMock.mock.calls[16]).toEqual([
      '/api/entitlement/editable-screenplay',
      expect.objectContaining({
        body: JSON.stringify({ screenplayId }),
        method: 'PUT',
      }),
    ]);
    expect(fetchMock.mock.calls[17]).toEqual([
      '/api/billing/checkout-session',
      expect.objectContaining({ body: JSON.stringify({ plan: 'monthly' }), method: 'POST' }),
    ]);
    expect(fetchMock.mock.calls[18]).toEqual([
      '/api/billing/portal-session',
      expect.objectContaining({ method: 'POST' }),
    ]);
    expect(fetchMock.mock.calls[19]).toEqual([
      '/api/billing/subscription',
      expect.objectContaining({ credentials: 'include' }),
    ]);
    expect(fetchMock.mock.calls[20]).toEqual([
      '/api/billing/plans',
      expect.objectContaining({ credentials: 'include' }),
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

  it('derives the PASSWORD_TOO_SHORT and PASSWORD_TOO_LONG messages from the shared password policy rather than restating it', async () => {
    fetchMock
      .mockResolvedValueOnce(response({ code: 'PASSWORD_TOO_SHORT' }, false, 400))
      .mockResolvedValueOnce(response({ code: 'PASSWORD_TOO_LONG' }, false, 400));

    await expect(api.signUp('Writer', 'writer@example.com', 'short')).rejects.toMatchObject({
      code: 'PASSWORD_TOO_SHORT',
      safeMessage: PASSWORD_REQUIREMENTS_MESSAGE,
    });
    await expect(api.signUp('Writer', 'writer@example.com', 'x'.repeat(200))).rejects.toMatchObject(
      {
        code: 'PASSWORD_TOO_LONG',
        safeMessage: PASSWORD_REQUIREMENTS_MESSAGE,
      },
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

  describe('api.session', () => {
    it('resolves to the signed-in user for a valid session body', async () => {
      fetchMock.mockResolvedValue(
        response({ user: { email: 'writer@example.com', id: 'writer-1', name: 'Writer' } }),
      );
      await expect(api.session()).resolves.toEqual({
        email: 'writer@example.com',
        id: 'writer-1',
        name: 'Writer',
      });
    });

    it('resolves to null for a literal null body, distinguishing signed-out from a failed request', async () => {
      fetchMock.mockResolvedValue(response(null));
      await expect(api.session()).resolves.toBeNull();
    });

    it('rejects on a non-OK status rather than collapsing it into signed-out', async () => {
      fetchMock.mockResolvedValue(response({ error: 'unavailable' }, false, 500));
      await expect(api.session()).rejects.toEqual(new ApiError(500));
    });

    it('rejects a body that is neither null nor a valid session shape', async () => {
      fetchMock.mockResolvedValue(response({ user: { email: 'writer@example.com' } }));
      await expect(api.session()).rejects.toThrow();
    });
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

  describe('createScreenplay error reporting', () => {
    // The one write a free account can hit the one-screenplay limit on (app.ts maps
    // EntitlementLimitError to 402, deliberately distinct from a plain 403): the server's own
    // explanation of the limit is worth keeping, not collapsing into a generic "Request failed".
    it('keeps the server-provided message from a 402 free-tier-limit response', async () => {
      fetchMock.mockResolvedValue(
        response(
          {
            error:
              'Free tier limit reached: only one editable screenplay is allowed. Choose an existing one to keep editing, or upgrade to create another.',
          },
          false,
          402,
        ),
      );
      await expect(
        api.createScreenplay(projectId, 'Draft', screenplayFixture),
      ).rejects.toMatchObject({
        serverMessage:
          'Free tier limit reached: only one editable screenplay is allowed. Choose an existing one to keep editing, or upgrade to create another.',
        status: 402,
      });
      await expect(
        api.createScreenplay(projectId, 'Draft', screenplayFixture),
      ).rejects.toBeInstanceOf(MessageApiError);
    });

    it('falls back to a generic message when the error response has no usable body', async () => {
      fetchMock.mockResolvedValue({
        json: vi.fn().mockRejectedValue(new SyntaxError('Unexpected end of JSON input')),
        ok: false,
        status: 500,
      } as unknown as Response);
      await expect(
        api.createScreenplay(projectId, 'Draft', screenplayFixture),
      ).rejects.toMatchObject({ serverMessage: 'Request failed (500)', status: 500 });
    });
  });

  describe('switchEditableScreenplay error reporting', () => {
    // 404 ("not-a-candidate"): app.ts deliberately does not distinguish "not a candidate" from
    // "does not exist", the same information-hiding convention the rest of this API already
    // follows -- App.tsx's read-only banner reads `.serverMessage` straight into its own inline
    // error, so it must survive the round trip verbatim.
    it('keeps the server-provided message from a 404 not-a-candidate response', async () => {
      fetchMock.mockResolvedValue(response({ error: 'Screenplay not found' }, false, 404));
      await expect(api.switchEditableScreenplay(screenplayId)).rejects.toMatchObject({
        serverMessage: 'Screenplay not found',
        status: 404,
      });
      await expect(api.switchEditableScreenplay(screenplayId)).rejects.toBeInstanceOf(
        MessageApiError,
      );
    });

    // 409 (the switch-slot cooldown): the one failure a writer using "Make this one editable" a
    // second time within 24 hours will actually see.
    it('keeps the server-provided message from a 409 cooldown response', async () => {
      fetchMock.mockResolvedValue(
        response(
          {
            error: 'The editable screenplay was changed recently; try again once the cooldown ends',
          },
          false,
          409,
        ),
      );
      await expect(api.switchEditableScreenplay(screenplayId)).rejects.toMatchObject({
        serverMessage:
          'The editable screenplay was changed recently; try again once the cooldown ends',
        status: 409,
      });
    });
  });
});
