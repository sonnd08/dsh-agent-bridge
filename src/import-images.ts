/**
 * Saves the images of a Claude or Codex chat in the DSH attachment store, so that a DSH chat can show them.
 * @module dsh-agent-bridge/import-images
 */

/** Reference to an image in the DSH attachment store. The bridge does not read its fields. */
export type ImageAttachment = Readonly<Record<string, unknown>>

/** Image bytes for the DSH attachment store. */
export interface ImageToSave {
  readonly data: Uint8Array
  readonly mediaType: string
}

/** The image types that the DSH attachment store accepts. */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/**
 * @param src - an image as a `data:` URL.
 * @returns its type and its base64 text; undefined when the store cannot accept it.
 */
export function parseImageData(src: string): { readonly mediaType: string; readonly data: string } | undefined {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(src)
  if (match === null || !IMAGE_TYPES.has(match[1] as string)) return undefined
  return { mediaType: match[1] as string, data: match[2] as string }
}

/**
 * Save images one at a time. An image that the store refuses is left out, and the others stay.
 * @param sources - images as `data:` URLs.
 * @param save - writes one image to the store.
 * @returns the reference of each saved image, by its `data:` URL.
 */
export async function saveImages(sources: Iterable<string>, save: (image: ImageToSave) => Promise<ImageAttachment>): Promise<Map<string, ImageAttachment>> {
  const saved = new Map<string, ImageAttachment>()
  for (const src of sources) {
    if (saved.has(src)) continue
    const parsed = parseImageData(src)
    if (parsed === undefined) continue
    try {
      saved.set(src, await save({ data: Buffer.from(parsed.data, 'base64'), mediaType: parsed.mediaType }))
    } catch (error) {
      console.warn('agent-bridge: an image of a chat was not saved', error)
    }
  }
  return saved
}
