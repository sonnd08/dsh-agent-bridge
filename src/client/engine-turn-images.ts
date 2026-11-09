/** Collects the images that Claude Code and Codex tools returned in one DSH turn, so that the folded turn can show them. */
import { ENGINE_TOOL } from '../protocol.ts'
import type { EngineImageRef } from './engine-tool-item.ts'

/** Key of the images in the data of a turn. */
export const ENGINE_IMAGES_KEY = 'agent-bridge-images'

/** Most thumbnails in one row. The row shows a count for the others. */
const SHOWN_THUMBNAILS = 3

interface TurnEvent {
  readonly type: string
  readonly surfaceOp?: string
  readonly data: {
    readonly turn?: number
    readonly callId?: unknown
    readonly name?: string
    readonly message?: { readonly source?: { readonly callId?: unknown }; readonly content?: readonly { readonly type: string; readonly attachment?: EngineImageRef }[] }
  }
}

interface TurnState {
  readonly turn: number
  readonly calls: ReadonlySet<string>
  readonly images: readonly EngineImageRef[]
}

interface Match { readonly event: TurnEvent }

interface LocationValue {
  readonly kind: 'turn'
  readonly turn: number
  readonly key: string
  readonly value: { readonly images: readonly EngineImageRef[] }
}

/** The definition of a DSH conversation node. It publishes data on the turn and draws no node. */
export const engineImagesDefinition = {
  kind: ENGINE_IMAGES_KEY,
  match: (event: TurnEvent): { id: string; role: 'start' | 'update' } | null => {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
    if (event.type === 'tool/call' || (event.type === 'tool/result' && event.surfaceOp === 'append')) return { id: String(event.data.turn), role: 'update' }
    return null
  },
  start: (_context: unknown, match: Match): TurnState => ({ turn: match.event.data.turn as number, calls: new Set(), images: [] }),
  update: (context: { readonly state: TurnState }, match: Match): TurnState => {
    const { event } = match
    if (event.type === 'tool/call') return event.data.name === ENGINE_TOOL ? { ...context.state, calls: new Set([...context.state.calls, String(event.data.callId)]) } : context.state
    if (!context.state.calls.has(String(event.data.message?.source?.callId))) return context.state
    const images = (event.data.message?.content ?? []).flatMap(block => block.type === 'image' && block.attachment !== undefined ? [block.attachment] : [])
    return images.length === 0 ? context.state : { ...context.state, images: [...context.state.images, ...images] }
  },
  buildLocationData: (context: { readonly state: TurnState | undefined }, scope: string, previous?: LocationValue): LocationValue | null => {
    if (scope !== 'turn' || context.state === undefined || context.state.images.length === 0) return null
    if (previous?.turn === context.state.turn && previous.value.images === context.state.images) return previous
    return { kind: 'turn', turn: context.state.turn, key: ENGINE_IMAGES_KEY, value: { images: context.state.images } }
  },
}

/**
 * @param items - all images, oldest first.
 * @returns the newest images to show, and the number of the others.
 */
export function thumbnailsOf<T>(items: readonly T[]): { readonly shown: readonly T[]; readonly more: number } {
  const shown = items.slice(-SHOWN_THUMBNAILS)
  return { shown, more: items.length - shown.length }
}

/**
 * @param base - the address of the page.
 * @param value - the destination of a Markdown image.
 * @returns the address of a local image in the DSH file API; undefined when the destination is not a local file.
 */
export function localImageUrl(base: string, value: string): string | undefined {
  let path: string
  try {
    path = decodeURIComponent(value.split(/[?#]/u)[0] ?? '')
  } catch (error) {
    if (error instanceof URIError) return undefined
    throw error
  }
  if (!/^(\/(?![/\\])|[A-Za-z]:[\\/])/u.test(path) || /[\u0000-\u001f\u007f]/u.test(path)) return undefined
  return new URL(`api/file?path=${encodeURIComponent(path)}`, base).href
}
