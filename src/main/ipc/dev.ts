import { z } from 'zod'
import { CH } from '@shared/channels'
import { readChangeByUrl } from '../clients/forge'
import { handle } from './guard'

export function registerDevHandlers(): void {
  handle(CH.devReadChange, z.string().max(2000), (url) => readChangeByUrl(url))
}
