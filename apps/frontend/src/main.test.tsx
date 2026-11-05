import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ analytics: vi.fn(), render: vi.fn() }))
vi.mock('@eldhall/analytics', () => ({ initAnalytics: mocks.analytics }))
vi.mock('react-dom/client', () => ({ createRoot: () => ({ render: mocks.render }) }))
vi.mock('./App', () => ({ default: () => null }))

beforeEach(() => {
  vi.resetModules()
  mocks.analytics.mockReset()
  mocks.render.mockReset()
  document.body.innerHTML = '<div id="root"></div>'
  history.replaceState({}, '', '/operator#key=synthetic%2Blink')
  vi.stubEnv('MODE', 'production')
})

it('scrubs the incoming key before analytics initialization and keeps it out of storage', async () => {
  sessionStorage.clear()
  mocks.analytics.mockImplementation(() => { expect(location.hash).toBe('') })
  await import('./main')
  expect(mocks.analytics).toHaveBeenCalledTimes(1)
  expect(mocks.render).toHaveBeenCalledTimes(1)
  expect(sessionStorage.getItem('support.operator')).toBeNull()
})

it('does not initialize analytics if the secret fragment cannot be scrubbed', async () => {
  vi.spyOn(history, 'replaceState').mockImplementation(() => { throw new Error('blocked') })
  await import('./main')
  expect(mocks.analytics).not.toHaveBeenCalled()
  expect(mocks.render).toHaveBeenCalledTimes(1)
})

it('keeps the explicit local demo free of analytics initialization', async () => {
  vi.stubEnv('MODE', 'local-demo')
  await import('./main')
  expect(location.hash).toBe('')
  expect(mocks.analytics).not.toHaveBeenCalled()
})
