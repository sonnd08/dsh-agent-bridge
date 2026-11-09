/** Reads a recorded engine tool call from its DSH chat node, for the row that shows it. */
import type { BlockWire } from '../protocol.ts'

/** Reference of an image in the DSH attachment store. */
export interface EngineImageRef { readonly attachmentId: string }

/** The fields of a DSH tool node that the row reads. */
export interface EngineToolNode {
  readonly callId?: string
  readonly kind?: string
  readonly name?: string
  readonly argsRaw?: string
  readonly call?: { readonly name: string; readonly argsRaw: string } | null
  readonly content?: readonly { readonly type: string; readonly text?: string; readonly attachment?: EngineImageRef }[]
  readonly isError?: boolean
}

/** What the row shows. */
export interface EngineToolView {
  readonly use: Extract<BlockWire, { type: 'tool_use' }>
  readonly result: Extract<BlockWire, { type: 'tool_result' }> | undefined
  readonly attachments: readonly EngineImageRef[]
}

const SUMMARY_LIMIT = 400

function parseCall(raw: string | undefined): { tool: string | undefined; input: unknown } {
  try {
    const parsed = JSON.parse(raw ?? '{}') as { tool?: unknown; input?: unknown } | null
    return { tool: typeof parsed?.tool === 'string' ? parsed.tool : undefined, input: parsed?.input }
  } catch (error) {
    if (error instanceof SyntaxError) return { tool: undefined, input: undefined }
    throw error
  }
}

/**
 * @param node - the started or settled tool node.
 * @param unnamed - the name to show when the call head is not in the loaded window.
 * @returns the call, its result and the references of its images.
 */
export function engineToolView(node: EngineToolNode, unnamed: string): EngineToolView {
  const { tool, input } = parseCall(node.kind === 'tool-result' ? node.call?.argsRaw : node.argsRaw)
  const summary = input === undefined ? '' : typeof input === 'string' ? input : JSON.stringify(input)
  const id = node.callId
  const use: EngineToolView['use'] = {
    type: 'tool_use',
    name: tool ?? unnamed,
    input: summary.length > SUMMARY_LIMIT ? `${summary.slice(0, SUMMARY_LIMIT)}…` : summary,
    ...id === undefined ? {} : { id },
    ...input !== null && typeof input === 'object' && !Array.isArray(input) ? { args: input as Record<string, unknown> } : {},
  }
  if (node.kind !== 'tool-result') return { use, result: undefined, attachments: [] }
  const content = node.content ?? []
  const text = content.flatMap(block => block.type === 'text' && block.text !== undefined ? [block.text] : []).join('\n')
  return {
    use,
    result: { type: 'tool_result', text, ...id === undefined ? {} : { forId: id }, ...node.isError === true ? { isError: true } : {} },
    attachments: content.flatMap(block => block.type === 'image' && block.attachment !== undefined ? [block.attachment] : []),
  }
}
