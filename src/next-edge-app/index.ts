import { CookieSerializeOptions, serialize } from "cookie"
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { NextResponse, type NextRequest } from "next/server"
import parse, { splitCookiesString } from "set-cookie-parser"
import tldjs from "tldjs"

export function processLocationHeader(
  locationHeaderValue: string,
  baseUrl: string,
) {
  if (locationHeaderValue.startsWith(baseUrl)) {
    return locationHeaderValue.replace(baseUrl, "/api/.ory")
  }

  if (
    locationHeaderValue.startsWith("/api/kratos/public/") ||
    locationHeaderValue.startsWith("/self-service/") ||
    locationHeaderValue.startsWith("/ui/")
  ) {
    return "/api/.ory" + locationHeaderValue
  }

  return locationHeaderValue
}

export const defaultForwardedHeaders = [
  "accept",
  "accept-charset",
  "accept-encoding",
  "accept-language",
  "authorization",
  "cache-control",
  "content-type",
  "cookie",
  "host",
  "user-agent",
  "referer",
]

export function getBaseUrl(options: CreateApiHandlerOptions) {
  let baseUrl = options.fallbackToPlayground
    ? "https://playground.projects.oryapis.com/"
    : ""

  if (process.env.ORY_SDK_URL) {
    baseUrl = process.env.ORY_SDK_URL
  }

  if (process.env.ORY_KRATOS_URL) {
    baseUrl = process.env.ORY_KRATOS_URL
  }

  if (process.env.ORY_SDK_URL && process.env.ORY_KRATOS_URL) {
    throw new Error("Only one of ORY_SDK_URL or ORY_KRATOS_URL can be set.")
  }

  if (options.apiBaseUrlOverride) {
    baseUrl = options.apiBaseUrlOverride
  }

  return baseUrl.replace(/\/$/, "")
}

export interface CreateApiHandlerOptions {
  /**
   * If set overrides the API Base URL. Usually, this URL
   * is taken from the ORY_KRATOS_URL environment variable.
   *
   * If you don't have a project you can use the playground project SDK URL:
   *
   *  https://playground.projects.oryapis.com
   */
  apiBaseUrlOverride?: string

  /**
   * Per default, this handler will strip the cookie domain from
   * the Set-Cookie instruction which is recommended for most set ups.
   *
   * If you are running this app on a subdomain and you want the session and CSRF cookies
   * to be valid for the whole TLD, you can use this setting to force a cookie domain.
   *
   * Please be aware that his method disables the `dontUseTldForCookieDomain` option.
   */
  forceCookieDomain?: string

  /**
   * Per default the cookie will be set on the hosts top-level-domain. If the app
   * runs on www.example.org, the cookie domain will be set automatically to example.org.
   *
   * Set this option to true to disable that behaviour.
   */
  dontUseTldForCookieDomain?: boolean

  /**
   * If set to true will set the "Secure" flag for all cookies. This might come in handy when you deploy
   * not on Vercel.
   */
  forceCookieSecure?: boolean

  /**
   * If set to true will fallback to the playground if no other value is set for the Ory SDK URL.
   */
  fallbackToPlayground?: boolean

  /*
   * Per default headers are filtered to forward only a fixed list.
   *
   * If you need to forward additional headers you can use this setting to define them.
   */
  forwardAdditionalHeaders?: string[]
}

export function guessCookieDomain(
  url: string | undefined,
  options: CreateApiHandlerOptions,
) {
  if (!url || options.forceCookieDomain) {
    return options.forceCookieDomain
  }

  if (options.dontUseTldForCookieDomain) {
    return undefined
  }

  const parsed = tldjs.parse(url || "")

  if (!parsed.isValid || parsed.isIp) {
    return undefined
  }

  if (!parsed.domain) {
    return parsed.hostname
  }

  return parsed.domain
}

export async  function filterRequestHeaders(
  forwardAdditionalHeaders?: string[],
) {
  const filteredHeaders = new Headers()
  const h = await headers();
  h.forEach((value, key) => {
    const isValid =
      defaultForwardedHeaders.includes(key) ||
      (forwardAdditionalHeaders ?? []).includes(key)
    if (isValid) filteredHeaders.set(key, value)
  })

  return filteredHeaders
}

async function processSetCookieHeader(
  protocol: string,
  fetchResponse: Response,
  options: CreateApiHandlerOptions,
) {
  const requestHeaders = await headers()
  const isTls =
    protocol === "https:" || requestHeaders.get("x-forwarded-proto") === "https"

  const secure =
    options.forceCookieSecure === undefined ? isTls : options.forceCookieSecure

  const forwarded = requestHeaders.get("x-forwarded-host")
  const host = forwarded ? forwarded : requestHeaders.get("host")
  const domain = guessCookieDomain(host, options)

  return parse(
    splitCookiesString(fetchResponse.headers.get("set-cookie") || ""),
  )
    .map((cookie) => ({
      ...cookie,
      domain,
      secure,
      encode: (v: string) => v,
    }))
    .map(({ value, name, ...options }) =>
      serialize(name, value, options as CookieSerializeOptions),
    )
}

export function createApiHandler(options: CreateApiHandlerOptions) {
  const baseUrl = getBaseUrl(options)

  const handler = async (
    request: NextRequest,
    { params }: { params: { path: string[] } },
  ) => {
    const path = request.nextUrl.pathname.replace("/api/.ory", "")
    const url = new URL(path, baseUrl)
    url.search = request.nextUrl.search

    if (path === "ui/welcome") {
      // A special for redirecting to the home page
      // if we were being redirected to the hosted UI
      // welcome page.
      redirect("../../../")
    }

    const requestHeaders = await filterRequestHeaders(
      options.forwardAdditionalHeaders,
    )

    requestHeaders.set("X-Ory-Base-URL-Rewrite", "false")
    requestHeaders.set("Ory-Base-URL-Rewrite", "false")
    requestHeaders.set("Ory-No-Custom-Domain-Redirect", "true")

    try {
      const response = await fetch(url, {
        method: request.method,
        headers: requestHeaders,
        body:
          request.method !== "GET" && request.method !== "HEAD"
            ? await request.arrayBuffer()
            : null,
        redirect: "manual",
      })

      const responseHeaders = new Headers()
      for (const [key, value] of response.headers) {
        responseHeaders.append(key, value)
      }

      responseHeaders.delete("location")
      responseHeaders.delete("set-cookie")
      if (response.headers.get("set-cookie")) {
        const cookies = await processSetCookieHeader(
          request.nextUrl.protocol,
          response,
          options,
        )
        cookies.forEach((cookie) => {
          responseHeaders.append("Set-Cookie", cookie)
        })
      }

      if (response.headers.get("location")) {
        const location = processLocationHeader(
          response.headers.get("location"),
          baseUrl,
        )
        responseHeaders.set("location", location)
      }

      responseHeaders.delete("transfer-encoding")
      responseHeaders.delete("content-encoding")
      responseHeaders.delete("content-length")

      const buf = Buffer.from(await response.arrayBuffer())

      try {
        return new NextResponse(
          buf.toString("utf-8").replace(new RegExp(baseUrl, "g"), "/api/.ory"),
          {
            status: response.status,
            headers: responseHeaders,
          },
        )
      } catch (err) {
        return new NextResponse(response.body, {
          status: response.status,
          headers: responseHeaders,
        })
      }
    } catch (error) {
      console.error(error, {
        path,
        url,
        method: request.method,
        headers: requestHeaders,
      })
      throw error
    }
  }

  return {
    GET: handler,
    POST: handler,
  }
}
