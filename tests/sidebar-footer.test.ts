import { createRequire } from 'node:module'
import { Children, createElement, type ReactElement, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  apply,
  CONTROL_PANEL_ID,
  CONTROL_STYLES,
  embedControlPanel,
  isEmbeddedControlPanel,
  mobileAccessInSettings,
  setMobileAccessInSettings,
} from '../src/client.js'

class FakeElement extends EventTarget {
  readonly children: FakeElement[] = []
  readonly dataset: Record<string, string> = {}
  readonly attributes = new Map<string, string>()
  parent: FakeElement | undefined
  className = ''
  hidden = false
  id = ''
  lang = ''
  textContent = ''

  constructor(readonly tagName: string) { super() }
  focus(): void {}

  get classList() {
    return {
      toggle: (name: string, enabled: boolean) => {
        const names = new Set(this.className.split(' ').filter(Boolean))
        if (enabled) names.add(name)
        else names.delete(name)
        this.className = [...names].join(' ')
      },
    }
  }

  append(...children: FakeElement[]): void {
    for (const child of children) {
      child.remove()
      child.parent = this
      this.children.push(child)
    }
  }

  remove(): void {
    if (this.parent === undefined) return
    this.parent.children.splice(this.parent.children.indexOf(this), 1)
    this.parent = undefined
  }

  get parentNode(): FakeElement | null { return this.parent ?? null }
  get nextSibling(): FakeElement | null {
    const siblings = this.parent?.children
    if (siblings === undefined) return null
    return siblings[siblings.indexOf(this) + 1] ?? null
  }

  insertBefore(node: FakeElement, reference: FakeElement | null): FakeElement {
    if (reference === null || reference.parent !== this) { this.append(node); return node }
    node.remove()
    node.parent = this
    this.children.splice(this.children.indexOf(reference), 0, node)
    return node
  }

  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null }
  hasAttribute(name: string): boolean { return this.attributes.has(name) }
  removeAttribute(name: string): void { this.attributes.delete(name) }
  contains(target: unknown): boolean { return target === this || this.children.some(child => child.contains(target)) }

  querySelectorAll(selector: string): FakeElement[] {
    return this.children.flatMap(child => [
      ...(child.className.split(' ').includes(selector.slice(1)) ? [child] : []),
      ...child.querySelectorAll(selector),
    ])
  }
}

class FakeDocument extends EventTarget {
  readonly documentElement = { lang: 'en-US' }
  readonly head = new FakeElement('head')
  readonly body = new FakeElement('body')
  readonly activeElement = null
  createElement(tag: string): FakeElement { return new FakeElement(tag) }
  querySelectorAll(selector: string): FakeElement[] { return this.body.querySelectorAll(selector) }
  querySelector(selector: string): FakeElement | null { return this.querySelectorAll(selector)[0] ?? null }
  getElementById(id: string): FakeElement | null {
    const walk = (node: FakeElement): FakeElement | null => {
      if (node.id === id) return node
      for (const child of node.children) {
        const found = walk(child)
        if (found !== null) return found
      }
      return null
    }
    for (const root of [this.head, this.body]) {
      const found = walk(root)
      if (found !== null) return found
    }
    return null
  }
}

interface TriggerProps {
  'aria-expanded': boolean
  'aria-controls': string
  'aria-label': string
  className: string
  lang: string
  title: string
  type: string
  children: ReactNode
  onClick(): void
}

const cleanup: (() => void)[] = []

afterEach(() => {
  for (const remove of cleanup.splice(0).reverse()) remove()
  setMobileAccessInSettings(true)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function installFooter(locale = 'en-US', hostname = 'localhost', inSettings = true) {
  setMobileAccessInSettings(inSettings)
  vi.useFakeTimers()
  const document = new FakeDocument()
  document.documentElement.lang = locale
  const window = Object.assign(new EventTarget(), { setTimeout, clearTimeout, setInterval, clearInterval })
  const disconnect = vi.fn()
  const disposeSlot = vi.fn()
  const disposeSettings = vi.fn()
  const injectSlot = vi.fn((_name: string, install: () => () => void) => install())
  let renderer: ((wide: boolean) => ReactElement<TriggerProps>) | undefined
  let sectionOptions: Record<string, unknown> | undefined
  let sectionRenderer: (() => ReactElement) | undefined

  vi.stubGlobal('document', document)
  vi.stubGlobal('window', window)
  vi.stubGlobal('location', { hostname, search: '' })
  vi.stubGlobal('navigator', { languages: ['en-US'], language: 'en-US' })
  vi.stubGlobal('Node', FakeElement)
  vi.stubGlobal('HTMLElement', FakeElement)
  vi.stubGlobal('MutationObserver', class {
    observe(): void {}
    disconnect = disconnect
  })
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))

  apply({
    effect(install) {
      const remove = install()
      if (remove !== undefined) cleanup.push(remove)
    },
    get: () => ({ isLoopback: true }),
    slots: {
      inject: injectSlot,
      register(options, component) {
        if (options.name === 'settings.general.item') {
          expect(options).toMatchObject({ id: 'dsh-mobile-client-modules', order: 120 })
          const row = component({} as never) as ReactElement<{ scope: string; locale: string }>
          expect(row.props.scope).toBe('computer')
          expect(row.props.locale).toBe(locale.split('-')[0] === 'zh' ? 'zh' : locale.split('-')[0] === 'it' ? 'it' : 'en')
          return disposeSettings
        }
        if (options.name === 'settings.section') {
          sectionOptions = options
          sectionRenderer = component as unknown as () => ReactElement
          return disposeSlot
        }
        expect(options).toMatchObject({ name: 'sidebar.footer.action', id: 'dsh-mobile' })
        renderer = wide => component({ wide } as never) as ReactElement<TriggerProps>
        return disposeSlot
      },
    },
  })

  return {
    document,
    disconnect,
    disposeSlot,
    disposeSettings,
    injectSlot,
    injectedNames: () => injectSlot.mock.calls.map(([name]) => name),
    get sectionOptions() { return sectionOptions },
    get sectionComponent(): () => ReactElement {
      if (sectionRenderer === undefined) throw new Error('Mobile Access settings section was not registered')
      return sectionRenderer
    },
    render(wide: boolean): ReactElement<TriggerProps> {
      if (renderer === undefined) throw new Error('Mobile Access footer was not registered')
      return renderer(wide)
    },
    mount(wide: boolean) {
      const tree = this.render(wide)
      const button = new FakeElement('button')
      button.className = tree.props.className
      button.setAttribute('aria-expanded', String(tree.props['aria-expanded']))
      button.addEventListener('click', tree.props.onClick)
      document.body.append(button)
      return { tree, button }
    },
  }
}

/**
 * Static markup of the registered settings section.
 * The section body calls hooks, so it is rendered instead of being invoked as a
 * plain function; effects do not run during server rendering, which keeps this
 * assertion about the declared element only. react-dom ships no type
 * declarations here, so it is loaded through require instead of adding a
 * dependency for one assertion.
 */
const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server') as {
  renderToStaticMarkup(node: ReactElement): string
}

function renderSectionMarkup(footer: ReturnType<typeof installFooter>): string {
  return renderToStaticMarkup(createElement(footer.sectionComponent))
}

function declarations(selector: string): Record<string, string> {
  const start = CONTROL_STYLES.indexOf(`${selector}{`)
  expect(start, `missing CSS rule ${selector}`).toBeGreaterThanOrEqual(0)
  const body = CONTROL_STYLES.slice(start + selector.length + 1, CONTROL_STYLES.indexOf('}', start))
  return Object.fromEntries(body.split(';').filter(Boolean).map(declaration => {
    const colon = declaration.indexOf(':')
    return [declaration.slice(0, colon), declaration.slice(colon + 1)]
  }))
}

describe('desktop Mobile Access footer (fallback path)', () => {
  it('shares the footer row and preserves the compact rail target', () => {
    expect(declarations('.dsh-mobile-control__trigger')).toMatchObject({
      'box-sizing': 'border-box',
      flex: '1 1 auto',
      gap: '8px',
      width: '100%',
      height: '42px',
      margin: '4px 0',
      padding: '0 10px 0 8px',
      border: '0',
      'border-radius': '12px',
      'font-family': 'inherit',
      'font-size': '14px',
      'line-height': '22px',
      color: 'var(--dsw-alias-label-primary,#16181d)',
    })
    expect(declarations('.dsh-mobile-control__trigger.is-rail')).toMatchObject({
      flex: '0 0 auto',
      width: '36px',
      height: '36px',
      margin: '8px 0 10px',
      padding: '0',
      gap: '0',
      'justify-content': 'center',
      'border-radius': '50%',
    })
  })

  it('uses theme tokens for hover, pressed, expanded, and visible keyboard focus', () => {
    expect(declarations('.dsh-mobile-control__trigger:hover').background).toBe('var(--dsw-alias-interactive-bg-hover,#f1f3f6)')
    expect(declarations('.dsh-mobile-control__trigger:active,.dsh-mobile-control__trigger[aria-expanded="true"]').background).toBe('var(--dsw-alias-interactive-bg-active,#e8ebf0)')
    expect(declarations('.dsh-mobile-control__trigger:focus-visible')).toEqual({
      outline: '2px solid var(--dsw-alias-state-business-primary,currentColor)',
      'outline-offset': '2px',
    })
    expect(CONTROL_STYLES).not.toContain('.dsh-mobile-control__trigger-icon::after')
  })

  it('reserves an icon target when another footer entry shares the row', () => {
    expect(declarations('.dsh-mobile-control__trigger:not(.is-rail):not(:only-child)')).toEqual({
      flex: '0 0 44px',
      width: '44px',
      'min-width': '44px',
      padding: '0',
      'justify-content': 'center',
      gap: '0',
    })
    expect(declarations('.dsh-mobile-control__trigger:not(.is-rail):not(:only-child) .dsh-mobile-control__trigger-label')).toEqual({ display: 'none' })
  })

  it.each([
    ['en-US', 'Mobile access'],
    ['zh-CN', '移动访问'],
    ['it-IT', 'Accesso mobile'],
  ])('keeps a localized accessible name and the same vector icon in both widths for %s', (locale, label) => {
    const footer = installFooter(locale, 'localhost', false)
    expect(footer.injectSlot.mock.calls.map(([name]) => name)).toEqual(['settings.general.item', 'sidebar.footer.action'])
    expect(footer.injectSlot).toHaveBeenNthCalledWith(2, 'sidebar.footer.action', expect.any(Function))
    for (const wide of [true, false]) {
      const tree = footer.render(wide)
      const children = Children.toArray(tree.props.children) as ReactElement<{ children?: ReactNode }>[]
      expect(tree.type).toBe('button')
      expect(tree.props).toMatchObject({ 'aria-label': label, title: label, type: 'button', 'aria-expanded': false })
      expect(tree.props.className.includes('is-rail')).toBe(!wide)
      expect(children[0]?.type).toBe('svg')
      expect(children[0]?.props).toMatchObject({
        'aria-hidden': true,
        focusable: false,
        width: wide ? 16 : 18,
        height: wide ? 16 : 18,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
      })
      expect(children).toHaveLength(wide ? 2 : 1)
      if (wide) expect(children[1]?.props.children).toBe(label)
    }
  })

  it('keeps expanded state in sync when the open panel trigger is remounted as a rail', () => {
    const footer = installFooter('en-US', 'localhost', false)
    const wide = footer.mount(true)
    const panel = footer.document.querySelector('.dsh-mobile-control__panel')
    expect(panel?.id).toBe(wide.tree.props['aria-controls'])
    expect(panel?.hidden).toBe(true)

    wide.button.dispatchEvent(new Event('click'))
    expect(panel?.hidden).toBe(false)
    expect(wide.button.getAttribute('aria-expanded')).toBe('true')
    expect(footer.render(true).props['aria-expanded']).toBe(true)

    wide.button.remove()
    const rail = footer.mount(false)
    expect(rail.tree.props['aria-expanded']).toBe(true)
    expect(rail.button.getAttribute('aria-expanded')).toBe('true')

    footer.document.querySelector('.dsh-mobile-control__close')?.dispatchEvent(new Event('click'))
    expect(panel?.hidden).toBe(true)
    expect(rail.button.getAttribute('aria-expanded')).toBe('false')
    expect(footer.render(false).props['aria-expanded']).toBe(false)

    rail.button.dispatchEvent(new Event('click'))
    expect(panel?.hidden).toBe(false)
    rail.button.dispatchEvent(new Event('click'))
    expect(panel?.hidden).toBe(true)
    expect(rail.button.getAttribute('aria-expanded')).toBe('false')
  })

  it('registers the desktop footer on a private LAN address', () => {
    const footer = installFooter('zh-CN', '192.168.50.23', false)
    expect(footer.injectSlot.mock.calls.map(([name]) => name)).toEqual(['settings.general.item', 'sidebar.footer.action'])
    expect(footer.injectSlot).toHaveBeenNthCalledWith(2, 'sidebar.footer.action', expect.any(Function))
    expect(footer.render(true).props).toMatchObject({ 'aria-label': '移动访问', title: '移动访问' })
  })

  it('reflects outside dismissal and removes its panel, styles, and registration on disposal', () => {
    const footer = installFooter('en-US', 'localhost', false)
    const { button } = footer.mount(true)
    button.dispatchEvent(new Event('click'))
    const outside = new Event('pointerdown')
    Object.defineProperty(outside, 'target', { value: footer.document.body })
    footer.document.dispatchEvent(outside)
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(footer.render(true).props['aria-expanded']).toBe(false)

    const remove = cleanup.pop()
    expect(remove).toBeDefined()
    remove?.()
    expect(footer.document.querySelector('.dsh-mobile-control__panel')).toBeNull()
    expect(footer.document.head.children).toHaveLength(0)
    expect(footer.disposeSlot).toHaveBeenCalledOnce()
    expect(footer.disposeSettings).toHaveBeenCalledOnce()
    expect(footer.disconnect).toHaveBeenCalledOnce()
  })
})

describe('desktop Mobile Access entry placement switch', () => {
  it('defaults to the settings entry and can be flipped to the footer fallback', () => {
    expect(mobileAccessInSettings()).toBe(true)
    setMobileAccessInSettings(false)
    expect(mobileAccessInSettings()).toBe(false)
    setMobileAccessInSettings(true)
    expect(mobileAccessInSettings()).toBe(true)
  })
})

describe('desktop Mobile Access settings entry (default path)', () => {
  it('registers the settings section instead of the sidebar footer slot', () => {
    const footer = installFooter('zh-CN')
    expect(footer.injectedNames()).toEqual(['settings.general.item', 'settings.section'])
    expect(footer.injectSlot).toHaveBeenLastCalledWith('settings.section', expect.any(Function))
    expect(footer.sectionOptions).toMatchObject({
      name: 'settings.section',
      id: 'dsh-mobile-access',
      order: 90,
      label: '移动访问',
    })
  })

  it.each([
    ['en-US', 'Mobile access'],
    ['zh-CN', '移动访问'],
    ['it-IT', 'Accesso mobile'],
  ])('labels the section with the localized entry name for %s', (locale, label) => {
    const footer = installFooter(locale)
    expect(footer.sectionOptions).toMatchObject({ label })
  })

  it('renders the section as a plain host div, never a second trigger', () => {
    const footer = installFooter()
    const markup = renderSectionMarkup(footer)
    expect(markup).toBe('<div></div>')
    expect(markup).not.toContain('<button')
  })

  it('never registers the footer slot while the settings entry is active', () => {
    const footer = installFooter()
    expect(footer.injectedNames()).not.toContain('sidebar.footer.action')
    expect(() => footer.render(true)).toThrow(/footer was not registered/u)
  })

  it('keeps the footer as the only entry when the switch is off', () => {
    const footer = installFooter('en-US', 'localhost', false)
    expect(footer.injectedNames()).toEqual(['settings.general.item', 'sidebar.footer.action'])
    expect(footer.sectionOptions).toBeUndefined()
    expect(() => footer.sectionComponent).toThrow(/settings section was not registered/u)
  })

  it('keeps the embedded panel visible when the pointer goes down elsewhere', () => {
    const footer = installFooter()
    const panel = footer.document.querySelector('.dsh-mobile-control__panel')
    expect(panel).not.toBeNull()
    // Reproduce the state embedControlPanel produces once the section mounts.
    panel?.setAttribute('data-dsh-mobile-embedded', '')
    if (panel !== null) panel.hidden = false
    const dismiss = (): void => {
      const outside = new Event('pointerdown')
      Object.defineProperty(outside, 'target', { value: footer.document.body })
      footer.document.dispatchEvent(outside)
    }

    dismiss()
    expect(panel?.hidden).toBe(false)

    // With the embedded marker gone, the floating shell dismisses as before,
    // which shows the guard is what kept the panel open above.
    panel?.removeAttribute('data-dsh-mobile-embedded')
    dismiss()
    expect(panel?.hidden).toBe(true)
  })

  it('disposes the settings registration on teardown', () => {
    const footer = installFooter()
    expect(footer.disposeSlot).not.toHaveBeenCalled()
    cleanup.pop()?.()
    expect(footer.disposeSlot).toHaveBeenCalledOnce()
    expect(footer.document.querySelector('.dsh-mobile-control__panel')).toBeNull()
    expect(footer.document.getElementById('dsh-mobile-embedded-panel-style')).toBeNull()
    expect(footer.document.head.children).toHaveLength(0)
  })
})

describe('control panel embedded in the settings section', () => {
  function panelFixture() {
    const page = new FakeDocument()
    const root = new FakeElement('div')
    const panel = new FakeElement('section')
    panel.id = CONTROL_PANEL_ID
    panel.hidden = true
    panel.setAttribute('aria-label', 'Mobile access')
    const trailing = new FakeElement('div')
    root.append(panel, trailing)
    page.body.append(root)
    vi.stubGlobal('document', page)
    return { page, root, panel, trailing }
  }

  it('moves the owned panel into the host and neutralizes the floating shell', () => {
    const { page, panel } = panelFixture()
    const host = new FakeElement('div')
    const embedded = embedControlPanel(host as unknown as HTMLElement, page as unknown as Document)

    expect(embedded.attach()).toBe(true)
    expect(host.children).toEqual([panel])
    expect(panel.hidden).toBe(false)
    expect(panel.getAttribute('data-dsh-mobile-embedded')).toBe('')
    const style = page.getElementById('dsh-mobile-embedded-panel-style')
    expect(style).not.toBeNull()
    expect(style?.parentNode).toBe(page.head)
    expect(style?.textContent).toContain('[data-dsh-mobile-embedded].dsh-mobile-control__panel{position:static !important')
    expect(style?.textContent).toContain('[data-dsh-mobile-embedded] .dsh-mobile-control__close{display:none !important;}')
  })

  it('restores the original parent, sibling order, hidden state, and style on disposal', () => {
    const { page, root, panel, trailing } = panelFixture()
    const host = new FakeElement('div')
    const embedded = embedControlPanel(host as unknown as HTMLElement, page as unknown as Document)
    embedded.attach()

    embedded.dispose()
    expect(host.children).toEqual([])
    expect(root.children).toEqual([panel, trailing])
    expect(panel.parentNode).toBe(root)
    expect(panel.hidden).toBe(true)
    expect(panel.getAttribute('data-dsh-mobile-embedded')).toBeNull()
    expect(page.getElementById('dsh-mobile-embedded-panel-style')).toBeNull()
  })

  it('keeps whatever hidden state the panel had when it was embedded', () => {
    const { page, panel } = panelFixture()
    panel.hidden = false
    const host = new FakeElement('div')
    const embedded = embedControlPanel(host as unknown as HTMLElement, page as unknown as Document)
    embedded.attach()
    embedded.dispose()
    expect(panel.hidden).toBe(false)
  })

  it('reports a missing panel instead of attaching twice, and survives disposal before attach', () => {
    const page = new FakeDocument()
    vi.stubGlobal('document', page)
    const host = new FakeElement('div')
    const embedded = embedControlPanel(host as unknown as HTMLElement, page as unknown as Document)
    expect(embedded.attach()).toBe(false)
    embedded.dispose()
    expect(page.head.children).toHaveLength(0)
    expect(host.children).toEqual([])
  })

  it('distinguishes an embedded panel from the floating one', () => {
    const floating = new FakeElement('section')
    expect(isEmbeddedControlPanel(floating)).toBe(false)
    floating.setAttribute('data-dsh-mobile-embedded', '')
    expect(isEmbeddedControlPanel(floating)).toBe(true)
    floating.removeAttribute('data-dsh-mobile-embedded')
    expect(isEmbeddedControlPanel(floating)).toBe(false)
  })

  it('attaches only once even when the retry loop keeps calling it', () => {
    const { page, root, panel, trailing } = panelFixture()
    const host = new FakeElement('div')
    const embedded = embedControlPanel(host as unknown as HTMLElement, page as unknown as Document)
    expect(embedded.attach()).toBe(true)
    const attached = host.children
    const style = page.getElementById('dsh-mobile-embedded-panel-style')
    expect(embedded.attach()).toBe(true)
    expect(host.children).toEqual(attached)
    expect(page.getElementById('dsh-mobile-embedded-panel-style')).toBe(style)
    expect(root.children).toEqual([trailing])
    embedded.dispose()
    expect(root.children).toEqual([panel, trailing])
  })
})
