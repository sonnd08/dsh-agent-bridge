/** Sends a turn from outside DSH to its DSH chat, with its images. */

/** One part of a DSH prompt. */
export type ReplayPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly mediaType: string; readonly data: string }

/** The part of a DSH answer that the replay reads. */
export interface ReplaySent { readonly ok: boolean }

/**
 * Send one turn. If DSH refuses the images and the turn has text, the text goes alone, so that the turn stays in the chat.
 * @param send - sends one prompt.
 * @param user - the text of the user.
 * @param images - the images of the user.
 * @returns the answer of the last send.
 */
export async function sendReplay<T extends ReplaySent>(send: (content: readonly ReplayPart[]) => Promise<T>, user: string, images: readonly { readonly mediaType: string; readonly data: string }[] = []): Promise<T> {
  const text: ReplayPart[] = user === '' ? [] : [{ type: 'text', text: user }]
  const sent = await send([...text, ...images.map((image): ReplayPart => ({ type: 'image', mediaType: image.mediaType, data: image.data }))])
  return !sent.ok && images.length > 0 && text.length > 0 ? await send(text) : sent
}
