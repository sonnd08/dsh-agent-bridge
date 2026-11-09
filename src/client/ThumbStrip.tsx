/** A short row of image thumbnails. A click on a thumbnail shows the full image. */
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { thumbnailsOf } from './engine-turn-images.ts'
import type { Translate } from './ToolCard.tsx'
import css from './ThumbStrip.module.css'

/**
 * @param props - the image addresses, the translator, an optional extra class and an optional top position in pixels.
 * @returns the row; nothing when there is no image.
 */
export function ThumbStrip({ urls, t, className, top }: { urls: readonly string[]; t: Translate; className?: string | undefined; top?: number | undefined }) {
  const [zoom, setZoom] = useState<string | undefined>(undefined)
  if (urls.length === 0) return null
  const { shown, more } = thumbnailsOf(urls)
  return (
    <div className={className === undefined ? css.strip : `${css.strip} ${className}`} data-testid="ext-thumb-strip" style={top === undefined ? undefined : { top }}>
      {more > 0 && <span className={css.more} data-testid="ext-thumb-more">+{more}</span>}
      {shown.map((src, index) => (
        <button key={index} type="button" className={css.button} aria-label={t('panel.image')} onClick={(event) => { event.stopPropagation(); setZoom(src) }}>
          <img className={css.thumb} data-testid="ext-thumb" src={src} alt="" />
        </button>
      ))}
      {zoom !== undefined && createPortal(
        <div className={css.zoom} data-testid="ext-zoom" role="dialog" onClick={() => { setZoom(undefined) }}>
          <img src={zoom} alt={t('panel.image')} />
        </div>,
        document.body,
      )}
    </div>
  )
}
