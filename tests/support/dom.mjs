/** A browser page for unit tests of the React components. Import it with `await import` before the component under test. */
import { register } from 'node:module'

register('./hooks.mjs', import.meta.url)

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/', pretendToBeVisual: true })
const { window } = dom
const copied = ['window', 'document', 'Node', 'Element', 'HTMLElement', 'Event', 'MouseEvent', 'KeyboardEvent', 'PointerEvent', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']
for (const name of copied) {
  Object.defineProperty(globalThis, name, { value: name === 'window' ? window : window[name], configurable: true, writable: true })
}
window.PointerEvent ??= window.MouseEvent
globalThis.PointerEvent = window.PointerEvent
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
window.ResizeObserver = globalThis.ResizeObserver
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const React = await import('react')
const { createRoot } = await import('react-dom/client')
// The unit test loader compiles JSX to React.createElement.
globalThis.React = React

/** Translate a key: the tests read the key and its values. */
export const t = (key, values) => values === undefined ? key : `${key} ${JSON.stringify(values)}`

/**
 * Render an element in the page.
 * @param element - the React element.
 * @returns the host element, `update` to render again, and `unmount`.
 */
export async function render(element) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await React.act(async () => { root.render(element) })
  return {
    host,
    update: async (next) => { await React.act(async () => { root.render(next) }) },
    unmount: async () => { await React.act(async () => { root.unmount() }); host.remove() },
  }
}

/** Run an action and let React and pending promises finish. */
export async function act(action) {
  await React.act(async () => { await action() })
}

/** @param element - the target. Press the primary button on it. */
export const click = element => act(() => { element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })

/** @param element - the target. Move the pointer onto it. */
export const hover = element => act(() => {
  element.dispatchEvent(new window.PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
  element.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
})

/** @param testId - the value of `data-testid`. @returns the first element with it, in the whole page. */
export const byTestId = testId => document.querySelector(`[data-testid="${testId}"]`)

/** @param testId - the value of `data-testid`. @returns the elements with it, in the whole page. */
export const allByTestId = testId => [...document.querySelectorAll(`[data-testid="${testId}"]`)]

export { React }
