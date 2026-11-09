/** Row of a Claude Code or Codex tool call in a DSH chat, with the images that the tool returned. */
import { useEffect, useState } from 'react'
import { engineToolView, type EngineImageRef, type EngineToolNode } from './engine-tool-item.ts'
import { ToolCard, type Translate } from './ToolCard.tsx'

/** Loads one stored image. `peek` gives an address that is already known. */
export type EngineImageLoader = ((attachment: never) => Promise<string>) & { readonly peek?: (attachment: never) => string | undefined }

/** The owner props of the row that the DSH tool slot supplies. */
export interface EngineToolRowProps {
  readonly phase: 'preparing' | 'start' | 'result'
  readonly block: unknown
  readonly callId: string
  readonly loadImage: EngineImageLoader
  readonly t: Translate
}

/** @returns the addresses of the images that have loaded. */
export function useImages(attachments: readonly EngineImageRef[], loadImage: EngineImageLoader): string[] {
  const [loaded, setLoaded] = useState<Readonly<Record<string, string>>>({})
  const ids = attachments.map(attachment => attachment.attachmentId).join(' ')
  useEffect(() => {
    let current = true
    for (const attachment of attachments) {
      if (loadImage.peek?.(attachment as never) !== undefined) continue
      loadImage(attachment as never).then((url) => {
        if (current) setLoaded(known => ({ ...known, [attachment.attachmentId]: url }))
      }).catch((error: unknown) => { console.warn('agent-bridge: an image of a tool call did not load', error) })
    }
    return () => { current = false }
    // The ids name the attachments, and the array is new on each render.
  }, [ids, loadImage])
  return attachments.flatMap((attachment) => {
    const url = loaded[attachment.attachmentId] ?? loadImage.peek?.(attachment as never)
    return url === undefined ? [] : [url]
  })
}

/**
 * @param props - the owner props of the DSH tool slot.
 * @returns the row of the call; nothing until DSH knows the arguments.
 */
export function EngineToolRow({ phase, block, callId, loadImage, t }: EngineToolRowProps) {
  const view = phase === 'preparing' ? undefined : engineToolView({ callId, ...block as EngineToolNode }, t('panel.toolResult'))
  const images = useImages(view?.attachments ?? [], loadImage)
  if (view === undefined) return null
  const result = view.result === undefined ? undefined : { ...view.result, ...images.length === 0 ? {} : { images } }
  return <ToolCard item={{ kind: 'tool', use: view.use, result }} t={t} running={phase !== 'result'} />
}
