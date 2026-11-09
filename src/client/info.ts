/** What the engine offers for a working directory (models, commands, MCP servers, account), cached per page. */
import { useCallback, useEffect, useState } from 'react'
import { INFO_PATH, providerEngine, providerInstance, type InfoWire } from '../protocol.ts'

const cache = new Map<string, InfoWire>()
/** Latest info per engine, shown for a folder whose own info is still loading; models and defaults rarely differ between folders. */
const latest = new Map<string, InfoWire>()
const inflight = new Map<string, Promise<InfoWire>>()

/** Fetch (or reuse) the info of one provider and directory. */
export async function loadInfo(provider: string, cwd: string, fresh = false): Promise<InfoWire> {
  const key = `${provider}:${cwd}`
  const known = cache.get(key)
  if (known !== undefined && !fresh) return known
  const pending = inflight.get(key)
  if (pending !== undefined && !fresh) return await pending
  const instance = providerInstance(provider)
  const request = fetch(`${INFO_PATH}?${new URLSearchParams({ engine: providerEngine(provider), cwd, ...instance === undefined ? {} : { instance }, ...fresh ? { fresh: '1' } : {} }).toString()}`, { credentials: 'same-origin' })
    .then(async (response) => {
      const body = await response.json().catch((): null => null) as (InfoWire & { error?: string }) | null
      if (!response.ok || body === null) throw new Error(body?.error ?? `HTTP ${response.status}`)
      cache.set(key, body)
      latest.set(provider, body)
      return body
    })
    .finally(() => { inflight.delete(key) })
  inflight.set(key, request)
  return await request
}

/** Hook over {@link loadInfo}. */
export function useInfo(engine: string, cwd: string | undefined): {
  info: InfoWire | undefined; error: string | undefined; reload: () => void
} {
  // Kept with the engine and folder it was loaded for, so another session never shows this one's models.
  const [info, setInfo] = useState<{ key: string; value: InfoWire } | undefined>(undefined)
  const [error, setError] = useState<{ key: string; text: string } | undefined>(undefined)
  const [version, setVersion] = useState(0)
  const key = `${engine}:${cwd ?? ''}`
  useEffect(() => {
    if (cwd === undefined || cwd === '') return undefined
    let cancelled = false
    void loadInfo(engine, cwd, version > 0).then(
      (value) => { if (!cancelled) { setInfo({ key: `${engine}:${cwd}`, value }); setError(undefined) } },
      (reason: unknown) => { if (!cancelled) setError({ key: `${engine}:${cwd}`, text: reason instanceof Error ? reason.message : String(reason) }) },
    )
    return () => { cancelled = true }
  }, [engine, cwd, version])
  return { info: info?.key === key ? info.value : latest.get(engine), error: error?.key === key ? error.text : undefined, reload: useCallback(() => { setVersion(n => n + 1) }, []) }
}

/** One provider's entry of {@link useInfos}. */
export interface ProviderInfo { readonly info: InfoWire | undefined; readonly error: string | undefined }

/**
 * Hook over {@link loadInfo} for a list of providers that can change between renders.
 * @param providers - provider ids.
 * @param cwd - working directory; empty loads nothing.
 * @returns each provider's info and load error.
 */
export function useInfos(providers: readonly string[], cwd: string | undefined): Readonly<Record<string, ProviderInfo>> {
  const [loaded, setLoaded] = useState<Readonly<Record<string, { key: string; info?: InfoWire; error?: string }>>>({})
  const list = providers.join('|')
  useEffect(() => {
    if (cwd === undefined || cwd === '') return undefined
    let cancelled = false
    for (const provider of providers) {
      const key = `${provider}:${cwd}`
      void loadInfo(provider, cwd).then(
        (info) => { if (!cancelled) setLoaded(current => ({ ...current, [provider]: { key, info } })) },
        (reason: unknown) => { if (!cancelled) setLoaded(current => ({ ...current, [provider]: { key, error: reason instanceof Error ? reason.message : String(reason) } })) },
      )
    }
    return () => { cancelled = true }
  }, [list, cwd])
  return Object.fromEntries(providers.map((provider) => {
    const entry = loaded[provider]
    return [provider, { info: entry?.key === `${provider}:${cwd ?? ''}` && entry.info !== undefined ? entry.info : latest.get(provider), error: entry?.key === `${provider}:${cwd ?? ''}` ? entry.error : undefined }]
  }))
}
