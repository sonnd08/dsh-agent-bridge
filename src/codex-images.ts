/**
 * Reads the images of Codex items: what the user attached, and what a tool returned.
 * @module dsh-agent-bridge/codex-images
 */
import { readFileSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import type { BlockWire } from './protocol.ts'

type Json = Record<string, unknown>

/** A larger image file is left out, so that one file cannot fill the transcript. */
const IMAGE_FILE_LIMIT = 20_000_000

const IMAGE_TYPES: Readonly<Record<string, string>> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }

/**
 * @param path - an image file.
 * @returns the image as a `data:` URL; undefined when the file cannot be read or is not an image.
 */
export function imageFileUrl(path: string): string | undefined {
  const type = IMAGE_TYPES[extname(path).toLowerCase()]
  if (type === undefined) return undefined
  try {
    if (statSync(path).size > IMAGE_FILE_LIMIT) return undefined
    return `data:${type};base64,${readFileSync(path).toString('base64')}`
  } catch (error) {
    // Codex can remove a temporary file after the turn, and the chat must still open.
    console.warn('agent-bridge: an image file of a Codex chat was not read', error)
    return undefined
  }
}

/** @param value - one input item. @returns its image as a `data:` URL; undefined when it holds no image that can load. */
function inputImage(value: Json): string | undefined {
  if (value['type'] === 'localImage' && typeof value['path'] === 'string') return imageFileUrl(value['path'])
  return value['type'] === 'image' && typeof value['url'] === 'string' && value['url'].startsWith('data:image/') ? value['url'] : undefined
}

/**
 * @param content - the content of a Codex user message.
 * @returns the text block and one block for each image. An image that cannot load stays as a short note.
 */
export function userBlocks(content: unknown): BlockWire[] {
  if (!Array.isArray(content)) return [{ type: 'text', text: '' }]
  const notes: string[] = []
  const images: BlockWire[] = []
  for (const part of content as Json[]) {
    if (part['type'] === 'text') {
      notes.push(String(part['text'] ?? ''))
      continue
    }
    const src = inputImage(part)
    if (src !== undefined) images.push({ type: 'image', src })
    else notes.push(`[${String(part['type'])}]`)
  }
  return [...images, { type: 'text', text: notes.join('\n') }]
}

/** The output of a Codex tool. */
export interface CodexToolResult {
  readonly text: string
  readonly images: readonly string[]
  readonly isError: boolean
}

/** @param item - an `mcpToolCall` item. @returns its text and images, with no image bytes in the text. */
export function mcpToolResult(item: Json): CodexToolResult {
  const error = (item['error'] as { message?: unknown } | null | undefined)?.message
  const result = item['result'] as { content?: unknown } | null | undefined
  const content = Array.isArray(result?.content) ? result.content as Json[] : []
  const texts = content.flatMap(part => part['type'] === 'text' ? [String(part['text'] ?? '')] : [])
  const images = content.flatMap(part => part['type'] === 'image' && typeof part['data'] === 'string' ? [`data:${typeof part['mimeType'] === 'string' ? part['mimeType'] : 'image/png'};base64,${part['data']}`] : [])
  // An older Codex can return a result with no content list.
  const other = result !== null && result !== undefined && !Array.isArray(result.content) ? JSON.stringify(result) : undefined
  return { text: typeof error === 'string' ? error : other ?? texts.join('\n'), images, isError: typeof error === 'string' || item['status'] === 'failed' }
}

/** @param item - a `dynamicToolCall` item. @returns its text and images. */
export function dynamicToolResult(item: Json): CodexToolResult {
  const content = Array.isArray(item['contentItems']) ? item['contentItems'] as Json[] : []
  return {
    text: item['error'] !== undefined && item['error'] !== null ? JSON.stringify(item['error']) : content.flatMap(part => part['type'] === 'inputText' ? [String(part['text'] ?? '')] : []).join('\n'),
    images: content.flatMap(part => part['type'] === 'inputImage' && typeof part['imageUrl'] === 'string' && part['imageUrl'].startsWith('data:image/') ? [part['imageUrl']] : []),
    isError: item['success'] === false || item['status'] === 'failed' || (item['error'] !== undefined && item['error'] !== null),
  }
}

/** @param path - the file that Codex viewed or made. @returns the output of the step. */
export function fileImageResult(path: unknown): CodexToolResult {
  const src = typeof path === 'string' ? imageFileUrl(path) : undefined
  return { text: typeof path === 'string' ? path : '', images: src === undefined ? [] : [src], isError: false }
}
