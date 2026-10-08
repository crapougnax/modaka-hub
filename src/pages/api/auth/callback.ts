import type { APIRoute } from 'astro'
import { isEmailDomainAllowed } from '../../../lib/config'

export const GET: APIRoute = async ({ url, cookies, redirect }) => {
  const code = url.searchParams.get('code')
  const oauthError = url.searchParams.get('error')
  const errorDescription = url.searchParams.get('error_description')
  const redirectUri = `${url.origin}/api/auth/callback`
  const codeVerifier = cookies.get('sb-code-verifier')?.value

  // Cleanup temporary PKCE cookie
  cookies.delete('sb-code-verifier', { path: '/' })

  if (oauthError) {
    console.error('[OAuth Callback] Error from Supabase IdP:', oauthError, errorDescription)
    return redirect(`/login?error=${encodeURIComponent(oauthError)}&desc=${encodeURIComponent(errorDescription || '')}`, 302)
  }

  if (!code) {
    return redirect('/login?error=missing_code', 302)
  }

  const clientId = import.meta.env.OAUTH_CLIENT_ID || process.env.OAUTH_CLIENT_ID
  const clientSecret = import.meta.env.OAUTH_CLIENT_SECRET || process.env.OAUTH_CLIENT_SECRET
  const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL || import.meta.env.SUPABASE_URL || process.env.PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const anonKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY || process.env.PUBLIC_SUPABASE_ANON_KEY

  if (!clientId || !supabaseUrl) {
    console.error('[OAuth Callback] Missing OAuth environment variables (OAUTH_CLIENT_ID, SUPABASE_URL)')
    return redirect('/login?error=server_misconfigured', 302)
  }

  try {
    const tokenEndpoint = `${supabaseUrl}/auth/v1/oauth/token`
    const basicAuth = clientSecret ? Buffer.from(`${clientId}:${clientSecret}`).toString('base64') : undefined

    const bodyParams: Record<string, string> = {
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      redirect_uri: redirectUri
    }

    if (clientSecret) {
      bodyParams.client_secret = clientSecret
    }

    if (codeVerifier) {
      bodyParams.code_verifier = codeVerifier
    }

    // 1. Standard RFC 6749 + RFC 7636 (PKCE) OAuth 2.0 Token Exchange
    const response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        ...(basicAuth ? { 'Authorization': `Basic ${basicAuth}` } : {}),
        ...(anonKey ? { 'apikey': anonKey } : {})
      },
      body: new URLSearchParams(bodyParams)
    })

    if (!response.ok) {
      const errText = await response.text()
      console.error('[OAuth Callback] Token exchange failed with status', response.status, errText)
      return redirect('/login?error=token_exchange_failed', 302)
    }

    const tokenData = await response.json()
    const accessToken = tokenData.access_token

    if (!accessToken) {
      console.error('[OAuth Callback] No access_token in token response:', tokenData)
      return redirect('/login?error=invalid_token_response', 302)
    }

    // 2. Fetch User Profile
    const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        ...(anonKey ? { 'apikey': anonKey } : {})
      }
    })

    if (!userRes.ok) {
      console.error('[OAuth Callback] Failed to fetch user profile from Supabase')
      return redirect('/login?error=user_fetch_failed', 302)
    }

    const user = await userRes.json()
    const email = (user.email || '').toLowerCase().trim()

    // 3. 🛡️ Domain restriction validation
    if (!isEmailDomainAllowed(email)) {
      console.warn(`[Security] Denied access to unauthorized email: ${email}`)

      // Revoke token on Supabase
      await fetch(`${supabaseUrl}/auth/v1/logout`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          ...(anonKey ? { 'apikey': anonKey } : {})
        }
      }).catch(() => {})

      return redirect(`/login?error=domain_restricted&email=${encodeURIComponent(email)}`, 302)
    }

    // 4. Set Session Cookie
    const maxAge = tokenData.expires_in || 3600 * 24 * 7
    cookies.set('sb-access-token', accessToken, {
      path: '/',
      httpOnly: true,
      secure: false, // compatible dev local
      sameSite: 'lax',
      maxAge
    })

    if (tokenData.refresh_token) {
      cookies.set('sb-refresh-token', tokenData.refresh_token, {
        path: '/',
        httpOnly: true,
        secure: false,
        sameSite: 'lax',
        maxAge: 3600 * 24 * 30
      })
    }

    console.log(`[OAuth Callback] User successfully authenticated: ${email} (${user.id})`)
    return redirect('/', 302)
  } catch (err: any) {
    console.error('[OAuth Callback] Exception during authentication flow:', err)
    return redirect('/login?error=auth_exception', 302)
  }
}
