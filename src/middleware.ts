import { defineMiddleware, sequence } from 'astro:middleware';
import { AstroRbacMiddleware } from '@quatrain/auth-rbac';
import { rbacEngine } from './rbac/roles';

const PUBLIC_PATHS = [
  '/login',
  '/api/auth/login',
  '/api/auth/callback',
  '/api/auth/logout',
  '/api/auth/password-login',
  '/favicon.ico',
  '/favicon.svg'
];

import { isEmailDomainAllowed, getAllowedEmailDomains } from './lib/config';

/**
 * Authentication Middleware: Resolves Supabase session, performs silent token refresh,
 * enforces domain restrictions (when configured), and populates context.locals.user.
 */
const authMiddleware = defineMiddleware(async (context, next) => {
  const { pathname } = context.url;

  // 1. Allow public paths and Astro static assets
  if (
    PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`)) ||
    pathname.startsWith('/_astro/') ||
    pathname.startsWith('/@') ||
    pathname.startsWith('/assets/')
  ) {
    return next();
  }

  const supabaseUrl =
    import.meta.env.PUBLIC_SUPABASE_URL ||
    import.meta.env.SUPABASE_URL ||
    process.env.PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL;
  const anonKey =
    import.meta.env.PUBLIC_SUPABASE_ANON_KEY || process.env.PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !anonKey) {
    console.error('[Middleware] Missing SUPABASE_URL or ANON_KEY.');
    return context.redirect('/login?error=server_misconfigured', 302);
  }

  // 2. Extract tokens from cookies or Authorization header
  let accessToken = context.cookies.get('sb-access-token')?.value;
  const refreshToken = context.cookies.get('sb-refresh-token')?.value;

  if (!accessToken) {
    const authHeader = context.request.headers.get('authorization');
    if (authHeader && authHeader.startsWith('Bearer ')) {
      accessToken = authHeader.substring(7).trim();
    }
  }

  let user: any = null;

  // 3. If access_token exists, test validity
  if (accessToken) {
    try {
      const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          apikey: anonKey
        }
      });
      if (res.ok) {
        user = await res.json();
      }
    } catch {
      user = null;
    }
  }

  // 4. 🔄 Silent Refresh: If access token is missing or expired, attempt refresh using refresh_token
  if (!user && refreshToken) {
    try {
      const refreshRes = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: anonKey
        },
        body: JSON.stringify({ refresh_token: refreshToken })
      });

      if (refreshRes.ok) {
        const tokenData = await refreshRes.json();
        accessToken = tokenData.access_token;
        const newRefreshToken = tokenData.refresh_token || refreshToken;

        // Update session cookies
        const maxAge = tokenData.expires_in || 3600 * 24 * 7;
        context.cookies.set('sb-access-token', accessToken!, {
          path: '/',
          httpOnly: true,
          secure: false,
          sameSite: 'lax',
          maxAge
        });
        context.cookies.set('sb-refresh-token', newRefreshToken, {
          path: '/',
          httpOnly: true,
          secure: false,
          sameSite: 'lax',
          maxAge: 3600 * 24 * 30
        });

        // Fetch user with refreshed token
        const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            apikey: anonKey
          }
        });
        if (userRes.ok) {
          user = await userRes.json();
        }
      }
    } catch (refreshErr) {
      console.error('[Middleware] Silent token refresh failed:', refreshErr);
    }
  }

  // 5. If no valid user, clear stale cookies and let RBAC middleware reject anonymous access
  if (!user) {
    context.cookies.delete('sb-access-token', { path: '/' });
    context.cookies.delete('sb-refresh-token', { path: '/' });
    return next();
  }

  const email = (user.email || '').toLowerCase().trim();

  // 6. Email domain check against configured domains
  if (!isEmailDomainAllowed(email)) {
    context.cookies.delete('sb-access-token', { path: '/' });
    context.cookies.delete('sb-refresh-token', { path: '/' });

    if (pathname.startsWith('/api/')) {
      return new Response(
        JSON.stringify({
          error: 'Forbidden',
          message: `Accès réservé aux domaines autorisés (${getAllowedEmailDomains().join(', ')})`
        }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return context.redirect(
      `/login?error=domain_restricted&email=${encodeURIComponent(email)}`,
      302
    );
  }

  // 7. 🛡️ Custom Claims & Roles Extraction
  const extractedRoles: string[] = [];

  if (Array.isArray(user.app_metadata?.roles)) {
    extractedRoles.push(...user.app_metadata.roles);
  } else if (typeof user.app_metadata?.role === 'string') {
    extractedRoles.push(user.app_metadata.role);
  }

  const customClaims = user.app_metadata?.custom_claims || user.user_metadata?.custom_claims;
  if (customClaims) {
    if (Array.isArray(customClaims.roles)) extractedRoles.push(...customClaims.roles);
    if (typeof customClaims.role === 'string') extractedRoles.push(customClaims.role);
  }

  if (typeof user.user_metadata?.role === 'string') {
    extractedRoles.push(user.user_metadata.role);
  }

  // Fallback defaults if no specific role is defined
  const finalRoles =
    extractedRoles.length > 0 ? Array.from(new Set(extractedRoles)) : ['curator'];

  // 8. Inject authenticated user into context.locals
  context.locals.user = {
    id: user.id,
    email: user.email,
    name: user.user_metadata?.full_name || user.user_metadata?.name || email.split('@')[0],
    roles: finalRoles,
    customClaims: customClaims || {},
    subjectType: 'human'
  };

  return next();
});

/**
 * RBAC Route Guard & FLS Middleware from @quatrain/auth-rbac
 */
const rbacMiddleware = new AstroRbacMiddleware(rbacEngine, {
  loginRedirectPath: '/login',
  forbiddenRedirectPath: '/login?error=forbidden',
  enableTarpitSleep: true
});

export const onRequest = sequence(authMiddleware, rbacMiddleware.handler());
