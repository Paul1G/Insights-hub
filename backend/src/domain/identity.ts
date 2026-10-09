// domain/identity models the caller as asserted by the platform's OAuth proxy
// (X-Forwarded-User / -Email / -Preferred-Username). Connections and audit
// entries are scoped by `scope`: the user id, or "anonymous" when the proxy
// did not set a user (local development).

export const ANONYMOUS_SCOPE = 'anonymous';

export interface Identity {
  /** Storage scope: the user id, or "anonymous". */
  scope: string;
  anonymous: boolean;
  userId: string | null;
  email?: string;
  username?: string;
}

/** Response shape of GET /api/me (matches `Me` in apps/web/src/api/client.ts). */
export interface Me {
  anonymous: boolean;
  userId: string | null;
  email?: string;
  username?: string;
}

export function identityFromHeaders(headers: {
  user?: string;
  email?: string;
  username?: string;
}): Identity {
  const user = headers.user?.trim();
  const email = headers.email?.trim();
  const username = headers.username?.trim();
  const extras = {
    ...(email ? { email } : {}),
    ...(username ? { username } : {}),
  };
  if (!user) {
    return { scope: ANONYMOUS_SCOPE, anonymous: true, userId: null, ...extras };
  }
  return { scope: user, anonymous: false, userId: user, ...extras };
}

export function toMe(identity: Identity): Me {
  return {
    anonymous: identity.anonymous,
    userId: identity.userId,
    ...(identity.email ? { email: identity.email } : {}),
    ...(identity.username ? { username: identity.username } : {}),
  };
}
