import type { SpaceInvaderApi } from '../shared/types'

declare global {
  interface Window {
    spaceInvader: SpaceInvaderApi
  }
}

export {}
