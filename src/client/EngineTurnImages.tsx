/** Thumbnails of the tool images of one turn. They stay visible while the steps of the turn are folded. */
import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useImages, type EngineImageLoader } from './EngineToolRow.tsx'
import type { EngineImageRef } from './engine-tool-item.ts'
import { ENGINE_IMAGES_KEY } from './engine-turn-images.ts'
import { ThumbStrip } from './ThumbStrip.tsx'
import type { Translate } from './ToolCard.tsx'
import css from './ThumbStrip.module.css'

/** Frames to wait for the header of the turn, which DSH can draw after this seat. */
const HEADER_WAIT_FRAMES = 30

/** The owner props of the DSH turn tail seat, and the image loader of the session. */
export interface EngineTurnImagesProps {
  readonly turn: { readonly turn: number; readonly data: { get(key: string): { readonly images: readonly EngineImageRef[] } | undefined } }
  readonly loadImage: EngineImageLoader
  readonly t: Translate
}

/** Height of the thumbnails, in pixels. */
const STRIP_HEIGHT = 30

/** Find the "Completed in" header of a turn in the chat that holds the anchor. */
function findHeader(anchor: HTMLElement | null, turn: number): HTMLElement | null {
  const selector = `[data-turn-process="${String(turn)}"]`
  let root = anchor?.parentElement ?? null
  while (root !== null && root.querySelector(selector) === null) root = root.parentElement
  return root?.querySelector<HTMLElement>(selector) ?? null
}

/** The element that holds the thumbnails, and their top position in it. */
interface HeaderSeat { readonly holder: HTMLElement; readonly top: number }

/** @returns the seat on the header of the turn; null when DSH does not draw a header. */
function useHeaderSeat(anchor: RefObject<HTMLElement | null>, turn: number, wanted: boolean): HeaderSeat | null {
  const [seat, setSeat] = useState<HeaderSeat | null>(null)
  useLayoutEffect(() => {
    if (!wanted) return undefined
    let frames = 0
    let timer: number | undefined
    let holder: HTMLElement | null = null
    const look = (): void => {
      const header = findHeader(anchor.current, turn)
      holder = header?.parentElement ?? null
      if (header !== null && holder !== null) {
        // The holder also contains the reply, so the thumbnails take their height from the header.
        holder.style.position = 'relative'
        setSeat({ holder, top: header.offsetTop + Math.max(0, (header.offsetHeight - STRIP_HEIGHT) / 2) })
      } else if (frames < HEADER_WAIT_FRAMES) {
        frames += 1
        timer = requestAnimationFrame(look)
      }
    }
    look()
    return () => {
      if (timer !== undefined) cancelAnimationFrame(timer)
      if (holder !== null) holder.style.position = ''
    }
  }, [anchor, turn, wanted])
  return seat
}

/**
 * @param props - the turn, the image loader and the translator.
 * @returns the thumbnails on the header of the turn, or below the turn when the turn has no header.
 */
export function EngineTurnImages({ turn, loadImage, t }: EngineTurnImagesProps) {
  const anchor = useRef<HTMLSpanElement>(null)
  const images = turn.data.get(ENGINE_IMAGES_KEY)?.images ?? []
  const urls = useImages(images, loadImage)
  const seat = useHeaderSeat(anchor, turn.turn, images.length > 0)
  if (images.length === 0) return null
  return (
    <>
      <span ref={anchor} hidden />
      {seat === null ? <ThumbStrip urls={urls} t={t} /> : createPortal(<ThumbStrip urls={urls} t={t} className={css.onHeader} top={seat.top} />, seat.holder)}
    </>
  )
}
