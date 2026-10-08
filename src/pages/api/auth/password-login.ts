import type { APIRoute } from 'astro'
import { isEmailDomainAllowed } from '../../../lib/config'

export const POST: APIRoute = async ({ request, cookies, redirect }) => {
  const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL || import.meta.env.SUPABASE_URL || process.env.PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const anonKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY || process.env.PUBLIC_SUPABASE_ANON_KEY

  if (!supabaseUrl || !anonKey) {
    console.error('[Password Login] Missing SUPABASE_URL or ANON_KEY.')
    return redirect('/login?error=server_misconfigured', 302)
  }

  let email = ''
  let password = ''

  const contentType = request.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    const body = await request.json().catch(() => ({}))
    email = body.email || ''
    password = body.password || ''
  } else {
    const formData = await request.formData().catch(() => new FormData())
    email = (formData.get('email') as string) || ''
    password = (formData.get('password') as string) || ''
  }

  email = email.toLowerCase().trim()

  if (!email || !password) {
    return redirect('/login?error=missing_fields', 302)
  }

  // 1. Domain restriction check
  if (!isEmailDomainAllowed(email)) {
    return redirect(`/login?error=domain_restricted&email=${encodeURIComponent(email)}`, 302)
  }

  try {
    // 2. Direct Supabase signInWithPassword API call (grant_type=password)
    const tokenEndpoint = `${supabaseUrl}/auth/v1/token?grant_type=password`
    const res = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': anonKey
      },
      body: JSON.stringify({ email, password })
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      console.warn('[Password Login] Authentication failed for', email, err.message || err.error_description)
      return redirect('/login?error=invalid_credentials', 302)
    }

    const session = await res.json()
    const accessToken = session.access_token

    if (!accessToken) {
      return redirect('/login?error=invalid_token_response', 302)
    }

    // 3. Set Session Cookies
    const maxAge = session.expires_in || 3600 * 24 * 7
    cookies.set('sb-access-token', accessToken, {
      path: '/',
      httpOnly: true,
      secure: false, // local dev compatible
      sameSite: 'lax',
      maxAge
    })

    if (session.refresh_token) {
      cookies.set('sb-refresh-token', session.refresh_token, {
        path: '/',
        httpOnly: true,
        secure: false,
        sameSite: 'lax',
        maxAge: 3600 * 24 * 30
      })
    }

    console.log(`[Password Login] User successfully authenticated: ${email}`)
    return redirect('/', 302)
  } catch (error) {
    console.error('[Password Login] Unexpected error:', error)
    return redirect('/login?error=internal_error', 302)
  }
}
