/** Provider selection in the harness composer: the model seat, and the composer that starts a Claude or Codex chat. */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { ComposerBar, AttachmentChips, SlashMenu, toAttachments, useChoice } from './ComposerBar.tsx'
import { DirPicker } from './DirPicker.tsx'
import { useInfo } from './info.ts'
import { engineLabels, visibleEngineModels } from './model-names.ts'
import { useModelPrefs } from './model-prefs-store.ts'
import { toggleFavorite } from '../model-prefs.ts'
import { ProviderPicker, type PickerCurrent, type PickerEngine, type PickerGroup } from './ProviderPicker.tsx'
import type { SendExtras } from './transcript.ts'
import type { Translate } from './ToolCard.tsx'
import type { AttachmentWire, EngineName, InfoWire, ModelPrefsWire, PrefsEngine } from '../protocol.ts'
import css from './ExternalPanel.module.css'
import pickerCss from './ProviderPicker.module.css'

/** Provider a new chat starts with. */
export type NewChatEngine = 'dsh' | 'claude' | 'codex'

/** Observable provider of new chats, kept between chats and page loads. */
export interface EngineStore {
  getSnapshot(): NewChatEngine
  subscribe(listener: () => void): () => void
  set(next: NewChatEngine): void
}

const ENGINE_KEY = 'agent-bridge:new-chat-engine'

function isNewChatEngine(value: unknown): value is NewChatEngine {
  return value === 'dsh' || value === 'claude' || value === 'codex'
}

/** @returns the store, starting from the provider of the last new chat. */
export function createEngineStore(): EngineStore {
  let engine: NewChatEngine = 'dsh'
  try {
    const stored = localStorage.getItem(ENGINE_KEY)
    if (isNewChatEngine(stored)) engine = stored
  } catch { /* the choice lasts for this page */ }
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => engine,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(next) {
      if (next === engine) return
      engine = next
      try {
        localStorage.setItem(ENGINE_KEY, next)
      } catch { /* the choice lasts for this page */ }
      for (const listener of listeners) listener()
    },
  }
}

/** One provider of the harness model catalog. */
interface CatalogGroup {
  readonly id: string
  readonly name: string
  readonly models: readonly { readonly id: string; readonly name: string; readonly reasoning?: { readonly defaultEffort?: string; readonly efforts: readonly { readonly id: string; readonly name: string }[] } }[]
}

/** The harness model selection of one session. */
export interface CatalogState {
  readonly current: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string } | null
  readonly groups: readonly CatalogGroup[]
  readonly status: string
  readonly error: string | null
}

/** Observable model catalog of one session. */
export interface CatalogStore {
  getSnapshot(): CatalogState
  subscribe(listener: () => void): () => void
}

/** What the model seat and the new-chat composer get from the plugin entry. */
export interface SeatServices {
  readonly catalog?: CatalogStore | undefined
  readonly loadCatalog: () => void
  readonly selectModel: (selection: { provider: string; model: string; reasoningEffort?: string }) => void
  readonly engines: EngineStore
  readonly getCwd: () => string
  readonly subscribeSessions: (listener: () => void) => () => void
  readonly isBlank: () => boolean
  readonly codexEnabled: () => boolean
  readonly startChat: (engine: EngineName, text: string, cwd: string, extras: SendExtras) => void
}

const NO_CATALOG: CatalogState = { current: null, groups: [], status: 'idle', error: null }
const noSubscribe = (): (() => void) => () => {}
const noCatalog = (): CatalogState => NO_CATALOG

/** Picker data of one external provider. */
export function engineGroup(engine: PrefsEngine, label: string, info: InfoWire | undefined, error: string | undefined, prefs: ModelPrefsWire, t: Translate): PickerGroup {
  return { engine, label, models: visibleEngineModels(engine, info, prefs), status: error ?? (info === undefined ? t('picker.loading') : undefined) }
}

/** Provider groups, selection and pick callback, shared by the model seat and the new-chat composer. */
function useProviderChoice(services: SeatServices, t: Translate) {
  const { catalog, loadCatalog, selectModel, engines, getCwd, subscribeSessions, isBlank, codexEnabled } = services
  const state = useSyncExternalStore(catalog?.subscribe ?? noSubscribe, catalog?.getSnapshot ?? noCatalog)
  const selected = useSyncExternalStore(engines.subscribe, engines.getSnapshot)
  const blank = useSyncExternalStore(subscribeSessions, isBlank)
  useEffect(() => { loadCatalog() }, [loadCatalog])
  const cwd = getCwd()
  const claude = useInfo('claude', blank ? cwd : undefined)
  const codex = useInfo('codex', blank && codexEnabled() ? cwd : undefined)
  const [claudeChoice, setClaudeChoice] = useChoice('claude')
  const [codexChoice, setCodexChoice] = useChoice('codex')
  const [prefs, savePrefs] = useModelPrefs()

  const dshGroup = useMemo((): PickerGroup => ({
    engine: 'dsh',
    label: t('picker.dsh'),
    models: state.groups.flatMap(group => group.models.map(model => ({
      id: `${group.id}/${model.id}`, name: model.name, description: group.name, efforts: model.reasoning?.efforts ?? [],
    }))),
    status: state.error ?? (state.status === 'loading' ? t('picker.loading') : undefined),
  }), [state, t])
  const groups: readonly PickerGroup[] = blank
    ? [dshGroup, ...codexEnabled() ? [engineGroup('codex', 'Codex', codex.info, codex.error, prefs, t)] : [], engineGroup('claude', 'Claude Code', claude.info, claude.error, prefs, t)]
    : [dshGroup]

  const engine: PickerEngine = blank ? selected : 'dsh'
  let current: PickerCurrent
  let label: string
  let effortLabel: string
  if (engine === 'claude' || engine === 'codex') {
    const labels = engineLabels(engine, engine === 'claude' ? claude.info : codex.info, engine === 'claude' ? claudeChoice : codexChoice)
    current = { engine, modelId: labels.modelId, effort: engine === 'claude' ? claudeChoice.effort : codexChoice.effort }
    label = labels.label
    effortLabel = labels.effort
  } else {
    const model = state.groups.find(group => group.id === state.current?.provider)?.models.find(item => item.id === state.current?.model)
    const effort = state.current?.reasoningEffort ?? model?.reasoning?.defaultEffort ?? ''
    current = { engine: 'dsh', modelId: state.current === null ? '' : `${state.current.provider}/${state.current.model}`, effort }
    label = model?.name ?? state.current?.model ?? t('picker.title')
    effortLabel = model?.reasoning?.efforts.find(level => level.id === effort)?.name ?? ''
  }

  const pick = useCallback((target: PickerEngine, modelId: string, effort: string | undefined): void => {
    if (target === 'claude' || target === 'codex') {
      const choice = target === 'claude' ? claudeChoice : codexChoice
      const set = target === 'claude' ? setClaudeChoice : setCodexChoice
      set({ ...choice, model: modelId, effort: effort ?? '' })
      engines.set(target)
      return
    }
    if (target !== 'dsh') return
    engines.set('dsh')
    for (const group of state.groups) {
      const model = group.models.find(item => `${group.id}/${item.id}` === modelId)
      if (model === undefined) continue
      const level = effort ?? model.reasoning?.defaultEffort
      selectModel({ provider: group.id, model: model.id, ...level === undefined ? {} : { reasoningEffort: level } })
      return
    }
  }, [claudeChoice, codexChoice, setClaudeChoice, setCodexChoice, engines, state.groups, selectModel])

  return { groups, current, label, effortLabel, pick, cwd, engine, favorites: prefs.favorites, starModel: (key: string) => { savePrefs(toggleFavorite(prefs, key)) }, info: engine === 'claude' ? claude.info : engine === 'codex' ? codex.info : undefined, choice: engine === 'codex' ? codexChoice : claudeChoice, setChoice: engine === 'codex' ? setCodexChoice : setClaudeChoice }
}

/**
 * Replaces the harness model seat.
 * @param props - the seat's lock state, plugin services and locale seat.
 * @returns the picker.
 */
export function ProviderSeat({ locked, services, t }: { locked?: boolean; services: SeatServices; t: Translate }) {
  const choice = useProviderChoice(services, t)
  return <ProviderPicker groups={choice.groups} current={choice.current} label={choice.label} effortLabel={choice.effortLabel} locked={locked} favorites={choice.favorites} onToggleFavorite={choice.starModel} onPick={choice.pick} t={t} />
}

/**
 * Takes the place of the harness composer on a blank session while Claude or Codex is selected.
 * @param props - plugin services and locale seat.
 * @returns the composer.
 */
export function NewChatComposer({ services, t }: { services: SeatServices; t: Translate }) {
  const choice = useProviderChoice(services, t)
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<AttachmentWire[]>([])
  const [pickedCwd, setPickedCwd] = useState<string | undefined>(undefined)
  const cwd = pickedCwd ?? choice.cwd
  const engine: EngineName = choice.engine === 'codex' ? 'codex' : 'claude'
  const attach = (files: File[]): void => { void toAttachments(files).then((added) => { setAttachments(current => [...current, ...added]) }) }
  const canSend = (text.trim() !== '' || attachments.length > 0) && cwd !== ''
  const send = (): void => {
    if (!canSend) return
    const { model, effort, permission } = choice.choice
    services.startChat(engine, text.trim() === '' ? t('composer.seeAttached') : text.trim(), cwd, {
      ...model === '' ? {} : { model }, ...effort === '' ? {} : { effort },
      ...permission === undefined || permission === '' ? {} : { permission },
      ...attachments.length === 0 ? {} : { attachments },
    })
    setText('')
    setAttachments([])
  }
  return (
    <div className={css.composerStack} data-testid="ext-new-chat">
      <div className={pickerCss.workspaceRow}>
        <span className={pickerCss.workspaceName} title={cwd}>{cwd.split('/').filter(Boolean).pop() ?? cwd}</span>
        <DirPicker start={cwd} onPick={setPickedCwd} t={t} />
      </div>
      <SlashMenu text={text} commands={choice.info?.commands ?? []} onPick={(name) => { setText(`/${name} `) }} />
      <div className={css.composerCard}>
        <AttachmentChips attachments={attachments} onRemove={(index) => { setAttachments(current => current.filter((_, position) => position !== index)) }} t={t} />
        <textarea
          className={css.text} data-testid="ext-new-chat-input" rows={2} value={text} autoFocus placeholder={t(engine === 'codex' ? 'composer.placeholderCodex' : 'composer.placeholder')}
          onChange={(event) => { setText(event.target.value) }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return
            event.preventDefault()
            send()
          }}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files)
            if (files.length > 0) { event.preventDefault(); attach(files) }
          }}
        />
        <div className={css.toolbar}>
          <div className={css.tools}>
            <ComposerBar part="leading" engine={engine} info={choice.info} choice={choice.choice} onChoice={choice.setChoice} onAttach={attach} onDictated={(spoken) => { setText(current => current === '' ? spoken : `${current} ${spoken}`) }} t={t} />
          </div>
          <div className={css.trailing}>
            <ProviderPicker groups={choice.groups} current={choice.current} label={choice.label} effortLabel={choice.effortLabel} favorites={choice.favorites} onToggleFavorite={choice.starModel} onPick={choice.pick} t={t} />
            <button type="button" className={css.primary} data-testid="ext-new-chat-send" aria-label={t('composer.send')} title={t('composer.send')} disabled={!canSend} onClick={send}>
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden><path d="M8 2.500 8 13.500M3.500 7 8 2.500 12.500 7" fill="none" stroke="currentColor" strokeWidth="1.600" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
