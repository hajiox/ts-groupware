import { AsyncLocalStorage } from 'node:async_hooks'

export type BusinessUser = Record<string, unknown> & {
  id: string
  role: string
  status: string
  display_name: string
  real_name?: string | null
  picture_url?: string | null
  department?: string | null
}

export type BusinessContext = {
  connectionId: string
  pcName: string
  user: BusinessUser
}

// This context is populated only after the service-only connection check. It is
// request-local; callers cannot supply an identity through headers or cookies.
const context = new AsyncLocalStorage<BusinessContext>()

export function getBusinessContext() { return context.getStore() }

export function runWithBusinessContext<T>(value: BusinessContext, action: () => T): T {
  return context.run(value, action)
}
